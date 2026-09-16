// modules/fbs-nf.js
// =============================================================================
// Importação dos XMLs das NF-e do Shopee Full (FBS) — mesmo desenho do Magalu.
//
// A Shopee, no Full, EMITE as NF-e (a mercadoria sai do CD dela). Este módulo
// PUXA esses XMLs pela API oficial (fluxo de 3 etapas), junta num ZIP, separa
// por chave de acesso e deduplica pelas que já foram importadas. Quem sobe no
// Bling é a extensão do navegador (a API do Bling não importa XML) — este
// módulo só entrega o ZIP de XMLs NOVOS pronto pra ela.
//
// Fluxo FBS (confirmado 31/07, todos POST /api/v2/order/...):
//   1) generate_fbs_invoices  { batch_download: { start, end, document_type, file_type, document_status } }
//        → result_list[].request_id (número). start/end = AAAAMMDD numérico.
//        document_type: 1=Remessa 2=Return 3=RetSimbólico 4=VENDA 5=Entrada 6=RemSimb 7=Todos
//        file_type: 1=XML 2=PDF 3=ambos | document_status: 1=autorizadas
//   2) get_fbs_invoices_result { request_id_list: { request_id: [...] } }
//        → result_list[].status = PROCESSING | AVAILABLE | DOWNLOADED | ERROR
//   3) download_fbs_invoices   { request_id_list: { request_id: [...] } }
//        → response[].file_link (ZIP no CDN, EXPIRA em 30min → baixar na hora)
// =============================================================================

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const shopee = require('./shopee-api');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const NF_DIR = path.join(DATA_DIR, 'fbs-nf');

// Quantos dias pra trás cada rodada cobre (o Bling deduplica por chave, então
// cobrir demais não faz mal; a extensão só importa o que é novo).
const NF_DIAS = Number(process.env.FBS_NF_DIAS || 30);
// Quantos ZIPs guardar em disco por loja (limpeza).
const NF_MANTER = Number(process.env.FBS_NF_MANTER || 20);
// Espera entre tentativas de status (a tarefa leva alguns segundos pra ficar pronta).
const STATUS_ESPERA_MS = Number(process.env.FBS_STATUS_ESPERA_MS || 6000);
const STATUS_MAX_TENT = Number(process.env.FBS_STATUS_MAX_TENT || 20);

// Quais tipos de documento buscar. Por padrão VENDA (4). A operação de Full
// gera também Remessa (1) e às vezes Entrada/Retorno; o dono pode ampliar por
// env (ex.: "4,1,5"). Cada tipo vira uma tarefa separada na etapa 1.
function tiposDoc() {
  return String(process.env.FBS_DOC_TYPES || '4')
    .split(',').map(s => Number(s.trim())).filter(n => n >= 1 && n <= 7);
}

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// AAAAMMDD numérico no fuso de São Paulo (o serviço roda TZ=America/Sao_Paulo,
// mas forçamos o timeZone pra não depender da env).
function ymdSP(d) {
  const s = (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD
  return Number(s.replace(/-/g, ''));
}
function ymdRotulo(n) { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; }

// ── ETAPA 1: gera as tarefas de um tipo de documento, devolve os request_id ──
/* 16/09 — AVISO DA SHOPEE (e-mail de 16/09, válido a partir de 30/10/2026): o CNPJ passa a
   ser OBRIGATÓRIO no generate_fbs_invoices, um por requisição, e precisa ser de filial
   registrada do seller. Sem isso, a importação das NF-e do Full para de funcionar naquela
   data — em silêncio do nosso lado, porque hoje a chamada simplesmente não manda o campo.

   Por que atrás de uma chave (FBS_ENVIAR_CNPJ=1) e não ligado direto: não dá pra testar a API
   da Shopee daqui, e mandar um campo novo ANTES de a mudança valer pode ser aceito ou pode
   dar erro — e errar aqui derruba a importação de NF hoje, pra consertar um problema de
   outubro. Com a chave, o dono liga, confere numa rodada e deixa ligado.

   O que NÃO nos afeta, conferido: o `file_name` novo ({CNPJ}FULLInvoiceXML{n}.zip), porque
   nós mesmos nomeamos os zips que salvamos; e os document_type novos, porque só pedimos os
   que já usamos. */
/* 16/09 — o dono confirmou que NÃO há CNPJ separado de filial: é o mesmo da empresa. Então
   dá pra descobrir sozinho, sem ele digitar nada: a CHAVE DE ACESSO de toda NF-e que já
   importamos carrega o CNPJ do emitente nas posições 7 a 20, e nós já guardamos essas chaves
   por loja pra deduplicar. O dado estava em casa.
   A env continua existindo e GANHA do descoberto — se um dia a Shopee exigir um CNPJ de
   filial diferente, é só defini-la, sem mexer em código. */
// ⚠️ O LEMBRETE DE 30/10 MORA NO CODIGO, NAO NA MEMORIA DE NINGUEM.
//
// [stated 16/09] "eu nao vou lembrar. vc consegue lembrar?" — nao de forma
// confiavel: eu leio minhas anotacoes quando ele fala comigo, mas nada me
// cutuca numa data.
//
// 📌 O que funciona e o que ele mesmo descobriu hoje: principio depende de
// alguem lembrar; CODIGO AVISA SOZINHO. A data fica aqui, e o aviso aparece
// justamente quando ele abre o painel pra trabalhar.
//
// O QUE ACONTECE, POR FASE:
//   ate 24/10   silencio (nada a fazer, a Shopee recusa o campo hoje)
//   25→29/10    AVISO: ligue a env, a virada esta chegando
//   30/10 em diante, SEM a env:  ALERTA — a busca vai falhar
//
// ⚠️ A janela de 5 dias existe pra ele ligar e CONFERIR com calma, em vez de
// descobrir no dia com o galpao operando.
const CNPJ_OBRIGATORIO_EM = Date.UTC(2026, 9, 30);   // 30/10/2026 (mes 9 = outubro)

function avisoPrazoCnpj(loja) {
  const ligado = String(process.env.FBS_ENVIAR_CNPJ || '') === '1';
  if (ligado) return null;   // ja resolvido, nao enche

  const agora = Date.now();
  const diasPra = Math.ceil((CNPJ_OBRIGATORIO_EM - agora) / 864e5);

  if (diasPra > 5) return null;   // ainda cedo

  const env = 'FBS_ENVIAR_CNPJ=1';
  if (diasPra > 0) {
    return `⚠️ FALTAM ${diasPra} DIA(S) pra a Shopee exigir o CNPJ no Full `
      + `(30/10/2026). Ligue ${env} no Render e rode uma busca pra conferir — `
      + `depois da data, sem isso a importacao de XML PARA.`;
  }
  return `🚨 A SHOPEE JA EXIGE O CNPJ (desde 30/10/2026) e ${env} NAO esta `
    + `ligado. A busca de XML do Shopee Full vai FALHAR ate ligar. `
    + `Render > Shopee-Sync-Organizar-Envio-Coleta > Environment.`;
}

function cnpjDaChave(chave) {
  const c = String(chave || '').replace(/\D/g, '');
  return c.length === 44 ? c.slice(6, 20) : null;
}

function cnpjDaLoja(loja) {
  const env = 'FBS_CNPJ_' + String(loja.key || '').toUpperCase();
  const v = String(process.env[env] || '').replace(/\D/g, '');
  if (v.length === 14) return v;

  /* descoberto: o CNPJ mais frequente entre as notas de SAÍDA já importadas. Frequência e não
     "a primeira" porque uma nota de outro emitente no meio do pacote (já aconteceu com pedido
     que o token alcança e não é da empresa) não pode decidir sozinha. */
  try {
    const reg = lerImportadas(loja.key);
    const cont = new Map();
    for (const ch of (reg.saida || [])) {
      const c = cnpjDaChave(ch);
      if (c) cont.set(c, (cont.get(c) || 0) + 1);
    }
    if (!cont.size) return null;
    return [...cont.entries()].sort((a2, b2) => b2[1] - a2[1])[0][0];
  } catch (e) { return null; }
}

async function fbsGerar(loja, start, end, documentType, fileType = 1, documentStatus = 1) {
  const bd = { start, end, document_type: documentType, file_type: fileType, document_status: documentStatus };
  if (String(process.env.FBS_ENVIAR_CNPJ || '') === '1') {
    const cnpj = cnpjDaLoja(loja);
    if (cnpj) bd.cnpj = cnpj;
    else {
      /* 16/09 — NÃO derruba. A pergunta do dono ("e se uma empresa passar a ter Full?")
         expôs que meu `throw` aqui quebrava o desenho de 13/09: sem CNPJ descoberto, a
         empresa passava a FALHAR onde antes saía calma dizendo que não havia documento.
         E o caso mais comum disso é justamente quem não tem Full — Girassol e GOOD hoje.
         Avisar e seguir sem o campo é melhor nos dois tempos: até 30/10 a Shopee ainda
         aceita sem CNPJ, então nada muda; depois de 30/10 ela recusa, e recusar é o MESMO
         resultado que a empresa sem Full já tinha. Quem tem Full não cai aqui: basta uma
         nota importada pra o CNPJ sair da chave de acesso.
         O ovo-e-galinha real — empresa COM Full, nenhuma nota ainda, depois de 30/10 — é
         pra isso que a env existe. */
      console.warn('[' + loja.key + ' FBS] sem CNPJ pra mandar: nenhuma NF-e importada ainda. ' +
        'Se esta empresa TEM Shopee Full, a primeira importação já resolve (o CNPJ sai da chave de ' +
        'acesso) ou defina FBS_CNPJ_' + String(loja.key || '').toUpperCase() + '. Se ela NÃO tem Full, ' +
        'declare ' + (loja.prefixo || '<PREFIXO>') + '_FBS=0 e a rotina sai limpa. Seguindo sem o campo — ' +
        'a partir de 30/10/2026 a Shopee recusa a requisição sem CNPJ.');
    }
  }
  const body = { batch_download: bd };
  const { ok, data } = await shopee.shopeeApiCall(loja, '/api/v2/order/generate_fbs_invoices', 'POST', body, null);
  if (!ok || (data && data.error)) throw new Error(`generate_fbs_invoices erro: ${JSON.stringify(data && (data.error || data))}`);
  const lista = (data && data.result_list) || [];
  return lista.map(r => r.request_id).filter(x => x != null);
}

// ── ETAPA 2: checa status até todos saírem de PROCESSING ──
async function fbsAguardar(loja, requestIds) {
  const pendentes = new Set(requestIds.map(Number));
  const prontos = new Set();
  const erros = [];
  for (let t = 0; t < STATUS_MAX_TENT && pendentes.size; t++) {
    const body = { request_id_list: { request_id: Array.from(pendentes) } };
    const { data } = await shopee.shopeeApiCall(loja, '/api/v2/order/get_fbs_invoices_result', 'POST', body, null);
    const lista = (data && data.result_list) || [];
    for (const r of lista) {
      const st = String(r.status || '').toUpperCase();
      if (st === 'AVAILABLE' || st === 'DOWNLOADED' || st === 'READY') { prontos.add(Number(r.request_id)); pendentes.delete(Number(r.request_id)); }
      else if (st === 'ERROR' || st === 'FAILED') { erros.push({ request_id: r.request_id, msg: r.error_message || st }); pendentes.delete(Number(r.request_id)); }
      // PROCESSING → continua esperando
    }
    if (pendentes.size) await sleep(STATUS_ESPERA_MS);
  }
  return { prontos: Array.from(prontos), erros, aindaProcessando: Array.from(pendentes) };
}

// ── ETAPA 3: pega os links e BAIXA o conteúdo (link expira em 30min) ──
async function fbsBaixar(loja, requestIds) {
  if (!requestIds.length) return [];
  const body = { request_id_list: { request_id: requestIds.map(Number) } };
  const { data } = await shopee.shopeeApiCall(loja, '/api/v2/order/download_fbs_invoices', 'POST', body, null);
  const resp = (data && data.response) || [];
  const bufs = [];
  for (const item of resp) {
    const link = item.file_link;
    if (!link) continue;
    try {
      const r = await fetch(link, { timeout: 60000 });
      if (!r.ok) { console.error(`[fbs-nf] download HTTP ${r.status} req ${item.request_id}`); continue; }
      const ab = await r.arrayBuffer();
      bufs.push({ request_id: item.request_id, buf: Buffer.from(ab) });
    } catch (e) { console.error(`[fbs-nf] download falhou req ${item.request_id}: ${e.message}`); }
  }
  return bufs;
}

// ── Extrai a chave de acesso (44 díg) de um XML de NF-e ──
function nfChave(dados, nome) {
  const txt = dados.toString('utf8', 0, Math.min(dados.length, 4000));
  let m = /Id="NFe(\d{44})"/.exec(txt) || /<chNFe>(\d{44})<\/chNFe>/.exec(txt);
  if (m) return m[1];
  m = /(\d{44})/.exec(String(nome || ''));
  return m ? m[1] : null;
}

// ── Extrai o CNPJ do emitente (pra sabermos de quem é a nota) ──
/* 13/09 — O NÚMERO DO PEDIDO DA SHOPEE ESTÁ NA NOTA, no campo xPed do ITEM (o DANFE o
   imprime colado na descrição, e por isso parecia parte do título do produto). Sem ler
   isso, a NF do Full entrava no Bling sem nenhuma ligação com o pedido: o dono só achou a
   757/série 5 garimpando pelo nome do cliente, e o robô de envio dava a nota por ausente.
   É campo próprio da NF-e, então a leitura é exata — não quebra quando a Shopee mudar o
   nome do produto. */
function nfPedidoLoja(dados) {
  try {
    const txt = dados.toString('utf8');
    const m = /<xPed>\s*([^<\s]+)\s*<\/xPed>/.exec(txt);
    if (m && m[1]) return m[1].trim();
    /* emissor que não usa xPed às vezes joga o pedido na descrição — só como reserva,
       e exigindo o formato de order_sn da Shopee pra não capturar lixo. */
    const d = /<xProd>([^<]*)<\/xProd>/.exec(txt);
    if (d) { const p = /\b(\d{6}[A-Z0-9]{8,10})\b/.exec(d[1]); if (p) return p[1]; }
    return null;
  } catch (e) { return null; }
}

function nfEmitente(dados) {
  const txt = dados.toString('utf8');
  // pega o primeiro <emit>...</emit> e dentro dele o CNPJ e o Nome
  const bloco = /<emit>([\s\S]*?)<\/emit>/.exec(txt);
  const alvo = bloco ? bloco[1] : txt;
  const cnpj = /<CNPJ>(\d{14})<\/CNPJ>/.exec(alvo);
  const nome = /<xNome>([^<]+)<\/xNome>/.exec(alvo);
  return { cnpj: cnpj ? cnpj[1] : null, nome: nome ? nome[1].trim() : null };
}

// ── Junta vários ZIPs baixados num só conjunto de XMLs, separando por tpNF ──
// tpNF=1 → saída (venda/remessa); tpNF=0 → entrada (retorno simbólico).
function separarXmls(bufsZip) {
  const saida = [], entrada = [], indefinido = [];
  const vistos = new Set(); // dedup dentro do próprio pacote (mesma chave em ZIPs diferentes)
  for (const { buf } of bufsZip) {
    let zip; try { zip = new AdmZip(buf); } catch (e) { continue; }
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const nome = e.entryName.split('/').pop();
      if (!/\.xml$/i.test(nome)) continue;
      let dados; try { dados = e.getData(); } catch (err) { continue; }
      const chave = nfChave(dados, nome);
      if (chave && vistos.has(chave)) continue;
      if (chave) vistos.add(chave);
      const m = /<tpNF>\s*([01])\s*<\/tpNF>/.exec(dados.toString('utf8'));
      const alvo = !m ? indefinido : (m[1] === '1' ? saida : entrada);
      alvo.push({ nome, dados, chave, pedido_loja: nfPedidoLoja(dados) });
    }
  }
  return { saida, entrada, indefinido };
}

function montarZip(itens) {
  const out = new AdmZip();
  itens.forEach(it => out.addFile(it.nome, it.dados));
  return out.toBuffer();
}

/* ── DE-PARA NF ↔ PEDIDO DA SHOPEE (13/09) ────────────────────────────────────
   A NF do Full entra no Bling sem vínculo com o pedido, e a nota autorizada não
   pode mais ser editada — então o vínculo vive AQUI, em disco, e é consultável
   pelas duas pontas: "de que pedido é a NF X" e "qual a NF do pedido Y". É o que
   faltava quando o dono precisou garimpar a 757/série 5 pelo nome do cliente. */
function arqDePara(lojaKey) { return path.join(NF_DIR, '_depara-pedido-' + lojaKey + '.json'); }
function lerDePara(lojaKey) {
  try { return JSON.parse(fs.readFileSync(arqDePara(lojaKey), 'utf8')) || {}; } catch (e) { return {}; }
}
function gravarDePara(lojaKey, itens) {
  const novos = (itens || []).filter(it => it && it.chave && it.pedido_loja);
  if (!novos.length) return 0;
  ensureDir(NF_DIR);
  const mapa = lerDePara(lojaKey);
  let add = 0;
  for (const it of novos) {
    const antigo = mapa[it.chave];
    if (!antigo) add++;
    /* Codex #17: reconstrução re-escrevia TODOS os vínculos com a data de agora, apagando
       quando cada um foi visto pela primeira vez — e esse carimbo é justamente o que diz
       se um vínculo é antigo ou acabou de entrar. Só muda quando o valor muda. */
    mapa[it.chave] = (antigo && antigo.pedido_loja === it.pedido_loja)
      ? antigo
      : { pedido_loja: it.pedido_loja, em: new Date().toISOString() };
  }
  /* Codex #17: disco cheio ou somente-leitura fazia o write falhar em silêncio e a
     resposta anunciava sucesso — quem chamou precisa saber que NADA foi gravado. */
  /* Codex #17 r2 (P1): escrever direto no mapa vivo significa que disco cheio no meio da
     escrita deixa o arquivo TRUNCADO — perdendo vínculos que já existiam. Grava no tmp e
     renomeia (o rename é atômico): ou o mapa novo entra inteiro, ou o antigo continua. */
  const arq = arqDePara(lojaKey);
  try {
    fs.writeFileSync(arq + '.tmp', JSON.stringify(mapa));
    fs.renameSync(arq + '.tmp', arq);
  } catch (e) {
    try { fs.unlinkSync(arq + '.tmp'); } catch (e2) {}
    const err = new Error('nao consegui gravar o de-para: ' + String(e.message || e).slice(0, 160));
    err.naoGravou = true; throw err;
  }
  return add;
}
/* 13/09 — PREENCHER O PASSADO. O de-para só nasce quando a importação roda, então as
   notas do Full já baixadas ficariam de fora. Esta varredura abre os ZIPs que estão em
   disco, lê o xPed de cada XML e completa o mapa — sem falar com a Shopee, sem baixar
   nada de novo e sem tocar no Bling. Idempotente: chave já registrada é reescrita com o
   mesmo valor. */
function reconstruirDePara(lojaKey) {
  let nomes = [];
  try { nomes = fs.readdirSync(NF_DIR); } catch (e) { return { ok: false, erro: 'pasta de NFs não existe ainda' }; }
  const zips = nomes.filter(n => n.startsWith(lojaKey + '-') && /\.zip$/i.test(n));
  let xmls = 0, comPedido = 0, semPedido = 0, ruins = 0, zipsRuins = 0, semChave = 0;
  /* Codex #17 r2 (P1): a rotina APAGA os ZIPs antigos (limpar()), então esta varredura só
     alcança o que ainda está em disco — prometer 'preencher o passado' sem dizer até onde
     seria mentira. A resposta declara a janela coberta; nota mais velha que isso só volta
     se a Shopee for consultada de novo. */
  let maisVelho = null, maisNovo = null;
  for (const n of zips) {
    try {
      const st = fs.statSync(path.join(NF_DIR, n));
      const t = st.mtime.toISOString();
      if (!maisVelho || t < maisVelho) maisVelho = t;
      if (!maisNovo || t > maisNovo) maisNovo = t;
    } catch (e) {}
  }
  const itens = [];
  for (const n of zips) {
    try {
      const zip = new AdmZip(path.join(NF_DIR, n));
      for (const e of zip.getEntries()) {
        if (!/\.xml$/i.test(e.entryName)) continue;
        /* Codex #17: um XML danificado estourava pro catch do ZIP inteiro e todos os
           seguintes eram perdidos em silêncio — um arquivo ruim escondia dezenas de bons. */
        let dados;
        try { dados = e.getData(); } catch (err) { ruins++; continue; }
        const chave = nfChave(dados, e.entryName);
        if (!chave) { semChave++; continue; }   /* Codex #17 r2: XML sem chave legível também conta */
        xmls++;
        const ped = nfPedidoLoja(dados);
        if (ped) { comPedido++; itens.push({ chave, pedido_loja: ped }); } else semPedido++;
      }
    } catch (err) { zipsRuins++; /* Codex #17 r2: ZIP ilegível agora é CONTADO, não some em silêncio */ }
  }
  let add = 0;
  try { add = gravarDePara(lojaKey, itens); }
  catch (e) {
    return { ok: false, loja: lojaKey, zips: zips.length, zip_ilegivel: zipsRuins, xmls, com_pedido: comPedido,
             sem_pedido: semPedido, sem_chave: semChave, xml_ilegivel: ruins,
             janela_em_disco: { mais_velho: maisVelho, mais_novo: maisNovo },
             erro: e.message, aviso: 'NADA foi gravado — o mapa segue como estava' };
  }
  return { ok: true, loja: lojaKey, zips: zips.length, zip_ilegivel: zipsRuins, xmls, com_pedido: comPedido,
           sem_pedido: semPedido, sem_chave: semChave, xml_ilegivel: ruins,
           janela_em_disco: { mais_velho: maisVelho, mais_novo: maisNovo },
           aviso: 'a rotina apaga ZIPs antigos — nota anterior à janela acima só volta consultando a Shopee de novo',
           novos_no_mapa: add, total_no_mapa: Object.keys(lerDePara(lojaKey)).length };
}

function acharPorPedido(lojaKey, pedidoLoja) {
  const alvo = String(pedidoLoja || '').trim().toUpperCase();
  const mapa = lerDePara(lojaKey);
  for (const [chave, v] of Object.entries(mapa)) {
    if (String(v.pedido_loja || '').toUpperCase() === alvo) return { chave, ...v };
  }
  return null;
}

// ── Dedup por chave já importada (arquivo por loja) ──
function arqImportadas(lojaKey) { return path.join(NF_DIR, '_importado-' + lojaKey + '.json'); }
function lerImportadas(lojaKey) {
  try {
    const j = JSON.parse(fs.readFileSync(arqImportadas(lojaKey), 'utf8'));
    return { quando: j.quando || null, saida: Array.isArray(j.saida) ? j.saida : [], entrada: Array.isArray(j.entrada) ? j.entrada : [] };
  } catch (e) { return { quando: null, saida: [], entrada: [] }; }
}
function gravarImportadas(lojaKey, reg) {
  
  ensureDir(NF_DIR);
  if (reg.saida.length > 5000) reg.saida = reg.saida.slice(-5000);
  if (reg.entrada.length > 5000) reg.entrada = reg.entrada.slice(-5000);
  try { fs.writeFileSync(arqImportadas(lojaKey), JSON.stringify(reg)); } catch (e) {}
}

// ── ROTINA COMPLETA: busca na Shopee → devolve o que há de novo ──
// Não importa no Bling (isso é a extensão). Grava o ZIP em disco e devolve
// contagem. A extensão baixa o ZIP de "novas" e sobe no Bling.
/* 13/09, 2ª versão — SEM ADIVINHAÇÃO. A 1ª tentava deduzir, pela MENSAGEM de erro, se a
   loja tem Full, e gravava isso. Cada rodada de revisão achou um jeito novo de a dedução
   errar (pane temporária, um tipo de documento recusado entre vários, mensagem genérica de
   autorização) — e o erro caro é sempre o mesmo: marcar uma loja que TEM Full e ela parar
   de importar em silêncio. Heurística que precisa de exceção atrás de exceção é desenho
   ruim. Ficou o que é verdadeiro e barato: a empresa DECLARA, e sem documento no período a
   rotina sai calma dizendo o que viu — sem memória, sem classificar mensagem, sem risco. */

async function rotina(loja, opts = {}) {
  /* 13/09 — EMPRESA SEM SHOPEE FULL NÃO É ERRO. Só a AMB tem Full hoje; GOOD e Girassol
     devolviam FAILED na geração do documento, o que parecia falha e era ausência. Com a
     empresa declarando (<PREFIXO>_FBS=0) ou com o serviço aprendendo sozinho no modo auto,
     a rotina sai limpa em vez de gritar — e a próxima empresa entra sem herdar alarme. */
  const decl = String(loja.fbs || 'auto');
  if (decl === 'nao') {
    return { ok: true, aviso_prazo: avisoPrazo, sem_full: true, motivo: 'esta empresa não usa Shopee Full (declarado em ' + (loja.prefixo || '') + '_FBS=0)' };
  }
// ⚠️ o lembrete de 30/10 aparece AQUI — na rotina que roda no cron e no
  // painel. E o unico lugar que o dono olha de verdade.
  //
  // 📌 Vai no LOG e no CAMPO da resposta: o log pega o cron (que roda
  // sozinho 4x por dia), o campo pega o painel (que ele abre pra trabalhar).
  const avisoPrazo = avisoPrazoCnpj(loja);
  if (avisoPrazo) console.warn(`[${loja.key} FBS] ${avisoPrazo}`);

  ensureDir(NF_DIR);
  try { limpar(loja.key); } catch (e) {}   // remove ZIPs antigos com timestamp
  const end = ymdSP();
  const dias = Math.max(1, Number(opts.dias || NF_DIAS));
  const start = ymdSP(new Date(Date.now() - (dias - 1) * 864e5));
  const fileType = 1; // XML
  const docStatus = 1; // autorizadas

  // etapa 1: gera tarefas de cada tipo de documento pedido
  let requestIds = [];
  const errosGerar = [];   /* Codex #18 r2: recusa na geração também ensina */
  for (const dt of tiposDoc()) {
    /* Codex #18 r2 (P2): loja sem Full costuma ser recusada JÁ NA GERAÇÃO da tarefa — o
       erro caía neste catch, virava 'nenhuma tarefa gerada (sem notas no período?)' e o
       aprendizado nunca acontecia, deixando a rotina tentar pra sempre. As mensagens são
       guardadas pra a mesma regra de permissão decidir logo abaixo. */
    try { const ids = await fbsGerar(loja, start, end, dt, fileType, docStatus); requestIds.push(...ids); }
    catch (e) { errosGerar.push(String(e.message || e)); console.error(`[fbs-nf][${loja.key}] gerar tipo ${dt}: ${e.message}`); }
    await sleep(400);
  }
  requestIds = Array.from(new Set(requestIds.map(Number)));
  if (!requestIds.length) {
    /* sem tarefa gerada: pode ser loja sem Full ou período sem nota — em ambos não há o que
       fazer, e nenhum deles é falha nossa. Sai calmo, com a mensagem da Shopee junto. */
    // ⚠️ b-erro-cnpj - ERRO DA API NAO E "NAO TEM FULL".
    //
    // [stated 16/09] o dono ligou `FBS_ENVIAR_CNPJ=1` e a Shopee recusou com
    // `ERROR_SP_SERVICE_UNEXPECTED_V2` — ela ainda NAO aceita o campo antes
    // de 30/10. Mas a mensagem daqui disse:
    //
    //   "a Shopee não gerou documento de Full — se esta empresa não usa
    //    Full, declare AMB_SYNC_FBS=0 pra sair do ciclo"
    //
    // ⚠️ SEGUIR ESSE CONSELHO DESLIGARIA O FULL DA AMB POR ENGANO. A empresa
    // usa Full, tem 330 notas importadas — o problema era o campo novo.
    //
    // 📌 Sem tarefa gerada tem DUAS causas, e a conduta e OPOSTA:
    //   nenhum erro    -> periodo sem nota, ou empresa sem Full   (calmo)
    //   erro da API    -> ALGO QUEBROU e precisa de acao          (alto)
    const houveErro = errosGerar.length > 0;
    const cnpjLigado = String(process.env.FBS_ENVIAR_CNPJ || '') === '1';
    return {
      ok: true,
      aviso_prazo: avisoPrazo,
      // ⚠️ MANTENHO `sem_documento: true` — NAO mudo a semantica do campo.
      //
      // Minha 1a versao punha `!houveErro` aqui. Mas a EXTENSAO do navegador
      // consome este campo (server.js repassa em /fbs/ext/estado), e eu nao
      // tenho o codigo dela neste repo pra conferir o que ela faz quando ele
      // vira false.
      //
      // 📌 Mudar contrato que outro lado consome, sem poder ler esse outro
      // lado, e como eu quebrei a fila de impressao hoje. O valor que o dono
      // precisa esta na MENSAGEM — e essa eu posso corrigir sem risco.
      sem_documento: true,
      erro_api: houveErro ? errosGerar[0].slice(0, 220) : null,
      motivo: !houveErro
        ? 'nenhuma nota de Full no periodo (ou esta empresa nao usa Full — '
          + 'se for o caso, declare ' + loja.prefixo + '_FBS=0 pra sair do ciclo)'
        : ('⚠️ a Shopee RECUSOU o pedido: ' + errosGerar[0].slice(0, 200)
          + (cnpjLigado
            ? ' — FBS_ENVIAR_CNPJ esta LIGADO. A Shopee so aceita o campo CNPJ '
              + 'a partir de 30/10/2026; DESLIGUE a env e a busca volta.'
            : ' — ISTO NAO E "empresa sem Full": e erro da API. NAO declare '
              + loja.prefixo + '_FBS=0 por causa disto.')),
      periodo: { de: ymdRotulo(start), ate: ymdRotulo(end) } };
  }

  // etapa 2: espera ficar pronto
  const st = await fbsAguardar(loja, requestIds);
  // etapa 3: baixa os prontos
  const bufs = await fbsBaixar(loja, st.prontos);
  if (!bufs.length) {
    const msgs = (st.erros || []).map(e => e && e.msg).filter(Boolean);
    return { ok: true, aviso_prazo: avisoPrazo, sem_documento: true, status: st,
             motivo: msgs.length
               ? ('a Shopee recusou os documentos (' + String(msgs[0]).slice(0, 200) + ') — se esta empresa não usa Full, declare ' + (loja.prefixo || '') + '_FBS=0 pra sair do ciclo')
               : 'nada baixado no período',
             periodo: { de: ymdRotulo(start), ate: ymdRotulo(end) } };
  }

  // separa e deduplica contra o histórico
  const sep = separarXmls(bufs);
  const imp = lerImportadas(loja.key);
  const jaSaida = new Set(imp.saida), jaEntrada = new Set(imp.entrada);
  const novasSaida = sep.saida.filter(it => it.chave && !jaSaida.has(it.chave));
  const novasEntrada = sep.entrada.filter(it => it.chave && !jaEntrada.has(it.chave));

  // amostra do emitente (pra sabermos de quem é a nota) — primeiro XML de saída
  let emitente = null;
  const amostra = sep.saida[0] || sep.entrada[0] || sep.indefinido[0];
  if (amostra) emitente = nfEmitente(amostra.dados);

  // grava os ZIPs em disco (saída e entrada separados). NOME FIXO por tipo
  // (sem timestamp): cada busca SOBRESCREVE o anterior em vez de acumular
  // dezenas de ZIPs. A extensão lê sempre o mais recente por estadoAtual().
  const escrito = {};
  if (novasSaida.length) {
    const nome = loja.key + '-saida-atual.zip';
    fs.writeFileSync(path.join(NF_DIR, nome), montarZip(novasSaida));
    escrito.saida = { nome, qtd: novasSaida.length };
  }
  if (novasEntrada.length) {
    const nome = loja.key + '-entrada-atual.zip';
    fs.writeFileSync(path.join(NF_DIR, nome), montarZip(novasEntrada));
    escrito.entrada = { nome, qtd: novasEntrada.length };
  }

  const deparaAdd = gravarDePara(loja.key, sep.saida.concat(sep.entrada));
  return {
    ok: true,
    periodo: { de: ymdRotulo(start), ate: ymdRotulo(end) },
    status: st,
    emitente,
    total: { saida: sep.saida.length, entrada: sep.entrada.length, indefinido: sep.indefinido.length },
    novas: { saida: novasSaida.length, entrada: novasEntrada.length },
    depara_novos: deparaAdd,
    arquivos: escrito
  };
}

// ── Marca chaves como importadas (a extensão chama isto após subir no Bling) ──
function marcarImportadas(lojaKey, tipo, chaves) {
  const imp = lerImportadas(lojaKey);
  const alvo = (tipo === 'E' || tipo === 'entrada') ? imp.entrada : imp.saida;
  const set = new Set(alvo);
  let add = 0;
  for (const c of chaves) { if (c && !set.has(c)) { set.add(c); add++; } }
  if (tipo === 'E' || tipo === 'entrada') imp.entrada = Array.from(set); else imp.saida = Array.from(set);
  imp.quando = new Date().toISOString();
  gravarImportadas(lojaKey, imp);
  return { adicionadas: add, total: (tipo === 'E' || tipo === 'entrada') ? imp.entrada.length : imp.saida.length };
}

// ── Lê um ZIP salvo e devolve as chaves que ele contém (pra marcar depois) ──
function chavesDoZip(nomeArquivo) {
  try {
    const buf = fs.readFileSync(path.join(NF_DIR, nomeArquivo));
    const zip = new AdmZip(buf);
    const chaves = [];
    for (const e of zip.getEntries()) {
      if (e.isDirectory || !/\.xml$/i.test(e.entryName)) continue;
      const c = nfChave(e.getData(), e.entryName);
      if (c) chaves.push(c);
    }
    return chaves;
  } catch (e) { return []; }
}

function caminhoZip(nomeArquivo) { return path.join(NF_DIR, nomeArquivo); }

// ── Limpeza: agora os ZIPs têm nome fixo (-saida-atual, -entrada-atual).
// Remove qualquer ZIP ANTIGO com timestamp no nome (padrão -saida-DATA-HORA)
// que tenha sobrado da versão anterior, pra o estadoAtual não lê-los.
function limpar(lojaKey) {
  let nomes = [];
  try { nomes = fs.readdirSync(NF_DIR); } catch (e) { return; }
  // apaga os do padrão antigo com data: lojaKey-(saida|entrada)-AAAA-MM-DD-HHMM.zip
  const padraoAntigo = new RegExp('^' + lojaKey + '-(saida|entrada)-\\d{4}-\\d{2}-\\d{2}-\\d{3,4}\\.zip$');
  nomes.filter(n => padraoAntigo.test(n)).forEach(n => { try { fs.unlinkSync(path.join(NF_DIR, n)); } catch (e) {} });
}

// ── Lê o ZIP mais recente em disco e conta as NOVAS (sem buscar na Shopee) ──
// É isto que a extensão consome: não gera nada, só olha o que o cron/painel
// já baixou e diz quantas notas ali dentro ainda não foram importadas.
function estadoAtual(loja) {
  let nomes = [];
  try { nomes = fs.readdirSync(NF_DIR); } catch (e) {}
  const meus = nomes.filter(n => n.startsWith(loja.key + '-') && /\.zip$/.test(n))
    .map(n => ({ n, t: (() => { try { return fs.statSync(path.join(NF_DIR, n)).mtimeMs; } catch (e) { return 0; } })() }))
    .sort((a, b) => b.t - a.t);
  if (!meus.length) return { ok: true, aviso_prazo: avisoPrazo, precisa: false, motivo: 'nenhum arquivo baixado ainda', novas_saida: 0, novas_entrada: 0 };

  const imp = lerImportadas(loja.key);
  const jaSaida = new Set(imp.saida), jaEntrada = new Set(imp.entrada);

  // pega o ZIP de saída mais recente e o de entrada mais recente
  const maisRecente = (tipo) => meus.find(x => x.n.includes('-' + tipo + '-'));
  const zSaida = maisRecente('saida');
  const zEntrada = maisRecente('entrada');

  function novasDoZip(nome, jaSet) {
    if (!nome) return { arquivo: null, novas: 0 };
    const chaves = chavesDoZip(nome);
    const novas = chaves.filter(c => c && !jaSet.has(c)).length;
    return { arquivo: nome, novas };
  }
  const s = novasDoZip(zSaida && zSaida.n, jaSaida);
  const e = novasDoZip(zEntrada && zEntrada.n, jaEntrada);

  return {
    ok: true,
    precisa: (s.novas + e.novas) > 0,
    novas_saida: s.novas,
    novas_entrada: e.novas,
    arquivo_saida: s.arquivo,
    arquivo_entrada: e.arquivo,
    importadas: { saida: imp.saida.length, entrada: imp.entrada.length, quando: imp.quando }
  };
}

module.exports = {
  cnpjDaLoja, cnpjDaChave,
  lerDePara, acharPorPedido, nfPedidoLoja, reconstruirDePara,
  NF_DIR, rotina, estadoAtual, marcarImportadas, chavesDoZip, caminhoZip, limpar,
  lerImportadas, nfEmitente, nfChave, ymdSP,
  // expostos p/ teste
  separarXmls, fbsGerar, fbsAguardar, fbsBaixar
};
