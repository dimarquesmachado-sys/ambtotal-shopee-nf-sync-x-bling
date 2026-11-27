'use strict';

/* ═══ SONDA DOS TIPOS DE DOCUMENTO DO FULL — o que a Shopee tem ALÉM da venda ═════
   Contexto (27/11/2026, AMB): venda do Full (NF de venda série 5) devolvida pelo
   cliente. No painel de Devoluções o card diz "a NF de devolução é da Shopee —
   importe o XML dela no Bling"; no Bling não há nota de entrada dessa venda (o dono
   conferiu à mão: só notas de saída). "Era pra Toolbox puxar todas as NFs."

   O que o código diz: a rotina (fbs-nf.js) pede à Shopee só os tipos de
   FBS_DOC_TYPES, e o padrão é '4' (VENDA). A API tem outros tipos — a lista está
   no cabeçalho do fbs-nf.js, com os nomes do SDK, e NUNCA foi medida aqui:
   1 Remessa · 2 Return · 3 Retorno simbólico · 5 Entrada · 6 Remessa simbólica.

   O que NÃO se sabe, e esta sonda mede em vez de alguém deduzir:
     - em qual tipo a Shopee entrega a NF de devolução do cliente;
     - o que mais vem junto nesses tipos (nota simbólica não é devolução);
     - se a janela pedida é aceita pela Shopee.

   Só leitura: pede os documentos à Shopee, abre os XMLs EM MEMÓRIA e devolve um
   resumo. Não grava ZIP, não marca nada como importado, não toca no Bling — a
   extensão não enxerga nada disto.

   Sem dado pessoal: nome e documento do destinatário não saem no relatório. A
   ligação com a venda vai pelo que identifica a NOTA: o pedido do item (xPed) e a
   chave da NF referenciada (refNFe), de onde saem a série e o número dela.

   "Não sei" ≠ "não tem": tipo com tarefa ainda processando, com download que
   falhou ou com a geração recusada sai como INCOMPLETO, nunca como "sem documento".

   v2 (27/11, depois da 1ª rodada em produção — AMB, 119 dias): os tipos 2 e 5
   voltaram "FAILED" e os tipos 3 e 6 seguiam processando depois de 2 minutos. A
   resposta dizia só "FAILED" (o motivo, se a Shopee manda, estava num campo que
   ninguém lia) e a única saída pra tarefa lenta era pedir tudo de novo. Agora:
     - toda tarefa que não ficou pronta sai com o que a Shopee disse dela, CRU
       (só campos simples; link nenhum) — pra ler o motivo em vez de supor;
     - a resposta traz `continuar`: as tarefas ainda processando, prontas pra
       colar na URL (&tarefas=tipo:numero,...). A chamada seguinte NÃO pede nada
       de novo à Shopee: só confere e baixa o que ficou pronto.
   ═════════════════════════════════════════════════════════════════════════════ */

const AdmZip = require('adm-zip');
const fbsNf = require('./fbs-nf');
const shopee = require('./shopee-api');

// nomes do SDK (cabeçalho do fbs-nf.js) — rótulo de leitura, não medição
const NOME_NO_SDK = { 1: 'Remessa', 2: 'Return', 3: 'Retorno simbolico', 4: 'Venda', 5: 'Entrada', 6: 'Remessa simbolica' };
const TIPOS_PADRAO = [2, 3, 5, 6];          // tudo o que a rotina NÃO pede hoje, fora a remessa
const MAX_DIAS = 124;                        // ~4 meses por chamada
const LIMITE_PADRAO = 200;                   // notas listadas na resposta (o resumo conta todas)
const LIMITE_MAX = 1000;
const MAX_TAREFAS = 24;                      // tarefas retomadas por chamada (&tarefas=)

const EM_ANDAMENTO = new Set();              // uma sonda por loja de cada vez (F5 no meio não dobra as tarefas na Shopee)

function invalido(erro) { return { ok: false, pedido_invalido: true, erro }; }

// 'AAAA-MM-DD' → { n: AAAAMMDD, t: ms UTC da meia-noite } | null (data que não existe também é null)
function lerData(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return { n: Number(m[1] + m[2] + m[3]), t };
}
function dataDoNumero(n) { const s = String(n); return lerData(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8)); }
function rotulo(n) { const s = String(n); return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8); }
function numeroDoTempo(t) { return Number(new Date(t).toISOString().slice(0, 10).replace(/-/g, '')); }

/* A janela: `de`/`ate` (AAAA-MM-DD) ou `dias` contados pra trás a partir de hoje (calendário de
   São Paulo, o mesmo da rotina). Nada é ajustado em silêncio: pedido fora do aceito é recusado
   dizendo por quê. */
function janela(opts, hojeN) {
  const hoje = dataDoNumero(hojeN);
  if (!hoje) return invalido('nao consegui ler a data de hoje');
  const temDe = opts.de != null && String(opts.de).trim() !== '';
  const temAte = opts.ate != null && String(opts.ate).trim() !== '';
  let de, ate;
  if (temDe || temAte) {
    if (!temDe) return invalido('informe tambem o inicio: &de=AAAA-MM-DD');
    de = lerData(opts.de);
    if (!de) return invalido('data inicial invalida (use &de=AAAA-MM-DD)');
    ate = temAte ? lerData(opts.ate) : hoje;
    if (!ate) return invalido('data final invalida (use &ate=AAAA-MM-DD)');
  } else {
    const temDias = opts.dias != null && String(opts.dias).trim() !== '';
    const dias = temDias ? Number(opts.dias) : 30;
    if (!Number.isInteger(dias) || dias < 1) return invalido('dias invalido (use um numero inteiro, a partir de 1)');
    ate = hoje;
    de = dataDoNumero(numeroDoTempo(hoje.t - (dias - 1) * 864e5));
  }
  if (de.t > ate.t) return invalido('a data inicial e depois da final');
  if (ate.t > hoje.t) return invalido('a data final e depois de hoje');
  const dias = Math.round((ate.t - de.t) / 864e5) + 1;
  if (dias > MAX_DIAS) return invalido('janela de ' + dias + ' dias: o teto por chamada e ' + MAX_DIAS + ' — divida o periodo em duas chamadas');
  return { ok: true, start: de.n, end: ate.n, dias };
}

function lerTipos(bruto) {
  if (bruto == null || String(bruto).trim() === '') return { ok: true, tipos: TIPOS_PADRAO.slice() };
  const partes = String(bruto).split(',').map((s) => s.trim()).filter((s) => s !== '');
  const tipos = [];
  for (const p of partes) {
    if (!/^[1-6]$/.test(p)) return invalido('tipo de documento invalido: "' + p.slice(0, 20) + '" (use de 1 a 6, separados por virgula; o 7 = "todos" nao serve aqui porque mistura os tipos)');
    if (!tipos.includes(Number(p))) tipos.push(Number(p));
  }
  if (!tipos.length) return invalido('nenhum tipo de documento informado');
  return { ok: true, tipos };
}

/* &tarefas=3:111,6:222 — as tarefas de uma sonda anterior que ficaram processando (o campo `continuar`
   da resposta traz isto pronto). Numero de ate 15 digitos: acima disso o JavaScript ja nao guarda inteiro exato. */
function lerTarefas(bruto) {
  const partes = String(bruto).split(',').map((x) => x.trim()).filter((x) => x !== '');
  if (!partes.length) return invalido('nenhuma tarefa informada em &tarefas=');
  if (partes.length > MAX_TAREFAS) return invalido('tarefas demais em &tarefas= (o teto e ' + MAX_TAREFAS + ' por chamada)');
  const porTipo = new Map(); const vistos = new Set();
  for (const p of partes) {
    const m = /^([1-6]):(\d{1,15})$/.exec(p);
    if (!m) return invalido('tarefa invalida em &tarefas=: "' + p.slice(0, 30) + '" (o formato e tipo:numero, como vem no campo "continuar" da resposta anterior)');
    const tipo = Number(m[1]); const id = Number(m[2]);
    if (vistos.has(id)) return invalido('tarefa repetida em &tarefas=: ' + id);
    vistos.add(id);
    if (!porTipo.has(tipo)) porTipo.set(tipo, []);
    porTipo.get(tipo).push(id);
  }
  return { ok: true, porTipo };
}

/* O que a Shopee diz de uma TAREFA, cru: so campos simples (texto cortado), e link nenhum — o link de
   download e assinado e vale por meia hora; esta resposta e colada em conversa. E metadado da tarefa, nao da nota. */
function soCamposSimples(item) {
  const o = {};
  for (const k of Object.keys(item || {})) {
    const v = item[k];
    if (typeof v === 'string') o[k] = /^\s*https?:\/\//i.test(v) ? '(link omitido)' : v.slice(0, 300);
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) o[k] = v;
  }
  return o;
}

// a situacao das tarefas, como a Shopee devolve (o fbsAguardar do motor so guarda pronto/erro/processando)
async function situacaoCrua(loja, ids) {
  const { data } = await shopee.shopeeApiCall(loja, '/api/v2/order/get_fbs_invoices_result', 'POST', { request_id_list: { request_id: ids.map(Number) } }, null);
  return (data && data.result_list) || [];
}

function lerLimite(bruto) {
  if (bruto == null || String(bruto).trim() === '') return { ok: true, limite: LIMITE_PADRAO };
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < 0 || n > LIMITE_MAX) return invalido('limite invalido (de 0 a ' + LIMITE_MAX + ')');
  return { ok: true, limite: n };
}

const um = (re, txt) => { const m = re.exec(txt); return m ? m[1].trim() : null; };
const serieDaChave = (c) => String(Number(c.slice(22, 25)));
const numeroDaChave = (c) => String(Number(c.slice(25, 34)));

/* O que a NOTA diz de si mesma. Tudo sai do bloco <ide> (identificação) e dos totais — nada do
   bloco do destinatário. */
function lerNota(dados, nome) {
  const txt = dados.toString('utf8');
  const blocoIde = /<ide>([\s\S]*?)<\/ide>/.exec(txt);
  const ide = blocoIde ? blocoIde[1] : '';
  const chave = fbsNf.nfChave(dados, nome);
  const referencia = [];
  ide.replace(/<refNFe>\s*(\d{44})\s*<\/refNFe>/g, (_, c) => { if (!referencia.some((r) => r.chave === c)) referencia.push({ chave: c, serie: serieDaChave(c), numero: numeroDaChave(c) }); return ''; });
  const cfops = [];
  txt.replace(/<CFOP>\s*(\d{4})\s*<\/CFOP>/g, (_, c) => { if (!cfops.includes(c)) cfops.push(c); return ''; });
  const serie = um(/<serie>\s*(\d+)\s*<\/serie>/, ide);
  const numero = um(/<nNF>\s*(\d+)\s*<\/nNF>/, ide);
  return {
    chave,
    serie: serie != null ? String(Number(serie)) : (chave ? serieDaChave(chave) : null),
    numero: numero != null ? String(Number(numero)) : (chave ? numeroDaChave(chave) : null),
    tpNF: um(/<tpNF>\s*([01])\s*<\/tpNF>/, ide),          // 1 = saida, 0 = entrada
    finNFe: um(/<finNFe>\s*(\d)\s*<\/finNFe>/, ide),      // 4 = devolucao de mercadoria
    natureza: um(/<natOp>([^<]*)<\/natOp>/, ide),
    emissao: (um(/<dhEmi>([^<]*)<\/dhEmi>/, ide) || '').slice(0, 10) || null,
    cfops,
    valor: um(/<vNF>\s*([\d.]+)\s*<\/vNF>/, txt),
    pedido_loja: fbsNf.nfPedidoLoja(dados),
    referencia,
  };
}

// abre os ZIPs de UM tipo e devolve as notas (sem repetir chave). ZIP que não abre conta como falha de leitura.
function notasDosZips(bufs) {
  const notas = []; const vistas = new Set(); let zipsRuins = 0; let xmlsRuins = 0;
  for (const { buf } of bufs) {
    let zip; try { zip = new AdmZip(buf); } catch (e) { zipsRuins++; continue; }
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const nome = e.entryName.split('/').pop();
      if (!/\.xml$/i.test(nome)) continue;
      let dados; try { dados = e.getData(); } catch (err) { xmlsRuins++; continue; }
      const n = lerNota(dados, nome);
      if (n.chave && vistas.has(n.chave)) continue;
      if (n.chave) vistas.add(n.chave);
      notas.push(n);
    }
  }
  return { notas, zipsRuins, xmlsRuins };
}

function bateComABusca(n, busca) {
  if (!busca) return false;
  const b = String(busca).trim().toUpperCase();
  if (!b) return false;
  if (n.pedido_loja && String(n.pedido_loja).toUpperCase() === b) return true;
  if (/^\d{44}$/.test(b)) return n.chave === b || n.referencia.some((r) => r.chave === b);
  if (/^\d{1,9}$/.test(b)) { const num = String(Number(b)); return n.numero === num || n.referencia.some((r) => r.numero === num); }
  return false;
}

function resumir(notas) {
  const grupos = new Map();
  for (const n of notas) {
    const chaveGrupo = [n.tpNF, n.finNFe, n.natureza, n.serie, n.cfops.slice().sort().join('+')].join('|');
    let g = grupos.get(chaveGrupo);
    if (!g) { g = { tpNF: n.tpNF, sentido: n.tpNF === '0' ? 'entrada' : (n.tpNF === '1' ? 'saida' : 'indefinido'), finNFe: n.finNFe, natureza: n.natureza, serie: n.serie, cfops: n.cfops.slice().sort(), qtd: 0, com_nf_referenciada: 0 }; grupos.set(chaveGrupo, g); }
    g.qtd++;
    if (n.referencia.length) g.com_nf_referenciada++;
  }
  return Array.from(grupos.values()).sort((a, b) => b.qtd - a.qtd);
}

async function sondarTipos(loja, opts = {}) {
  const io = Object.assign({
    gerar: fbsNf.fbsGerar, aguardar: fbsNf.fbsAguardar, baixar: fbsNf.fbsBaixar,
    importadas: fbsNf.lerImportadas, hoje: () => fbsNf.ymdSP(), situacao: situacaoCrua,
  }, opts.io || {});

  const rotinaHoje = { tipos_pedidos: fbsNf.tiposDoc(), env_FBS_DOC_TYPES: String(process.env.FBS_DOC_TYPES || '').trim() ? 'definida' : 'ausente — vale o padrao (so o tipo 4, venda)' };
  if (String(loja.fbs || 'auto') === 'nao') {
    return { ok: true, versao: 'sonda-tipos v2', loja: loja.key, sem_full: true, motivo: 'esta empresa não usa Shopee Full (declarado em ' + (loja.prefixo || '') + '_FBS=0)', rotina_hoje: rotinaHoje };
  }
  // retomada: confere tarefas ja pedidas (sem pedir de novo) — os tipos e a janela sao os do pedido original
  const retomada = opts.tarefas != null && String(opts.tarefas).trim() !== '';
  let t = null, jan = null, tar = null;
  if (retomada) { tar = lerTarefas(opts.tarefas); if (!tar.ok) return tar; }
  else { t = lerTipos(opts.tipos); if (!t.ok) return t; }
  const lim = lerLimite(opts.limite); if (!lim.ok) return lim;
  if (!retomada) { jan = janela(opts, io.hoje()); if (!jan.ok) return jan; }

  if (EM_ANDAMENTO.has(loja.key)) return { ok: false, ja_em_andamento: true, erro: 'ja ha uma sonda desta loja em andamento — espere ela terminar (leva de 30 s a 2 min)' };
  EM_ANDAMENTO.add(loja.key);
  try {
    // etapa 1: uma tarefa por tipo; recusa de um tipo não derruba os outros
    const porTipo = new Map();
    if (retomada) {
      for (const [tipo, ids] of tar.porTipo) porTipo.set(tipo, { tipo, nome_no_sdk: NOME_NO_SDK[tipo] || null, ids: ids.slice(), recusa: null });
    } else {
      for (const tipo of t.tipos) {
        const reg = { tipo, nome_no_sdk: NOME_NO_SDK[tipo] || null, ids: [], recusa: null };
        try { reg.ids = Array.from(new Set((await io.gerar(loja, jan.start, jan.end, tipo, 1, 1)).map(Number))); }
        catch (e) { reg.recusa = String(e.message || e).slice(0, 300); }
        porTipo.set(tipo, reg);
      }
    }
    const todos = []; for (const reg of porTipo.values()) for (const id of reg.ids) if (!todos.includes(id)) todos.push(id);

    // etapas 2 e 3: uma espera só pra todas as tarefas, e baixa o que ficou pronto
    let st = { prontos: [], erros: [], aindaProcessando: [] };
    let bufs = [];
    if (todos.length) {
      st = await io.aguardar(loja, todos);
      bufs = await io.baixar(loja, st.prontos || []);
    }
    const prontos = new Set((st.prontos || []).map(Number));
    const processando = new Set((st.aindaProcessando || []).map(Number));
    const baixados = new Map(); for (const b of bufs) baixados.set(Number(b.request_id), b);

    // v2: de toda tarefa que nao terminou baixada, o que a Shopee diz dela (cru). Falhar aqui nao derruba a sonda.
    const semArquivo = todos.filter((id) => !baixados.has(id));
    const cruPorId = new Map(); let cruIndisponivel = null;
    if (semArquivo.length) {
      try { for (const item of (await io.situacao(loja, semArquivo)) || []) if (item && item.request_id != null) cruPorId.set(Number(item.request_id), soCamposSimples(item)); }
      catch (e) { cruIndisponivel = String(e.message || e).slice(0, 200); }
    }

    let imp = { saida: [], entrada: [] };
    try { const lido = io.importadas(loja.key); imp = { saida: lido.saida || [], entrada: lido.entrada || [] }; } catch (e) { /* sem registro de importadas: a coluna sai como desconhecida */ imp = null; }
    const jaSaida = imp ? new Set(imp.saida) : null, jaEntrada = imp ? new Set(imp.entrada) : null;

    const out = {
      ok: true, versao: 'sonda-tipos v2', loja: loja.key, so_leitura: true,
      retomada,                                // true = so conferiu tarefas de um pedido anterior (nada novo foi pedido a Shopee)
      periodo: jan ? { de: rotulo(jan.start), ate: rotulo(jan.end), dias: jan.dias } : null,   // na retomada vale o do pedido original
      rotina_hoje: rotinaHoje,
      completo: true,
      continuar: null,
      situacao_crua_indisponivel: cruIndisponivel,
      tipos: [],
      busca: null,
      como_ler: 'Cada tipo traz o RESUMO do que veio (sentido, finalidade, natureza, serie, CFOP). Devolucao de cliente e nota de ENTRADA (tpNF 0) com finNFe 4 e uma NF de venda referenciada. Tipo com completo:false nao foi lido ate o fim — isso nao quer dizer que nao ha documento.',
    };
    let restam = lim.limite; let omitidas = 0;
    const achados = [];
    for (const reg of porTipo.values()) {
      const meusProntos = reg.ids.filter((id) => prontos.has(id));
      const meusBufs = meusProntos.map((id) => baixados.get(id)).filter(Boolean);
      const lidas = notasDosZips(meusBufs);
      const errosShopee = (st.erros || []).filter((e) => reg.ids.includes(Number(e.request_id))).map((e) => String(e.msg || '').slice(0, 200));
      const aindaProcessando = reg.ids.filter((id) => processando.has(id)).length;
      const semResposta = reg.ids.filter((id) => !prontos.has(id) && !processando.has(id) && !(st.erros || []).some((e) => Number(e.request_id) === id)).length;
      const naoBaixados = meusProntos.length - meusBufs.length;
      const motivos = [];
      if (reg.recusa) motivos.push('a Shopee recusou gerar: ' + reg.recusa);
      if (errosShopee.length) motivos.push(errosShopee.length + ' tarefa(s) com erro na Shopee: ' + errosShopee[0]);
      if (aindaProcessando) motivos.push(aindaProcessando + ' tarefa(s) ainda processando na Shopee');
      if (semResposta) motivos.push(semResposta + ' tarefa(s) sem resposta de situacao');
      if (naoBaixados) motivos.push(naoBaixados + ' arquivo(s) pronto(s) que nao consegui baixar');
      if (lidas.zipsRuins) motivos.push(lidas.zipsRuins + ' arquivo(s) que nao abriram');
      if (lidas.xmlsRuins) motivos.push(lidas.xmlsRuins + ' XML(s) que nao abriram');
      const completo = motivos.length === 0;
      if (!completo) out.completo = false;

      const lista = [];
      for (const n of lidas.notas) {
        const linha = Object.assign({}, n, { ja_importada: !imp || !n.chave ? null : (jaEntrada.has(n.chave) || jaSaida.has(n.chave)) });
        if (bateComABusca(n, opts.busca)) achados.push(Object.assign({ tipo: reg.tipo }, linha));
        if (restam > 0) { lista.push(linha); restam--; } else omitidas++;
      }
      out.tipos.push({
        tipo: reg.tipo, nome_no_sdk: reg.nome_no_sdk,
        completo, incompleto_por: completo ? null : motivos,
        tarefas: reg.ids.length,
        tarefas_sem_arquivo: reg.ids.filter((id) => !baixados.has(id)).map((id) => ({
          request_id: id,
          situacao: processando.has(id) ? 'processando' : (prontos.has(id) ? 'pronta_mas_nao_baixou' : ((st.erros || []).some((e) => Number(e.request_id) === id) ? 'erro' : 'sem_resposta')),
          o_que_a_shopee_diz: cruPorId.has(id) ? cruPorId.get(id) : null,
        })),
        sem_tarefa: reg.ids.length === 0 && !reg.recusa,     // a Shopee não gerou nada: período sem documento desse tipo (ou tipo que a conta não tem)
        notas: lidas.notas.length,
        entrada_de_devolucao_com_nf_referenciada: lidas.notas.filter((n) => n.tpNF === '0' && n.finNFe === '4' && n.referencia.length > 0).length,
        resumo: resumir(lidas.notas),
        lista,
      });
    }
    const pendentes = [];
    for (const reg of porTipo.values()) for (const id of reg.ids) if (processando.has(id)) pendentes.push(reg.tipo + ':' + id);
    if (pendentes.length) out.continuar = { tarefas_processando: pendentes.length, acrescente_na_url: '&tarefas=' + pendentes.join(','), como: 'espere um minuto e abra a MESMA URL com isto no fim: a sonda nao pede nada de novo a Shopee, so confere e baixa o que ficou pronto' };
    out.notas_fora_da_lista = omitidas;      // o resumo e a busca contam todas; só a `lista` tem teto (&limite=)
    const b = opts.busca == null ? '' : String(opts.busca).trim();
    if (b) out.busca = { procurei: b.slice(0, 60), como: 'pedido do item (xPed), numero da nota ou numero/chave da NF referenciada', achei: achados.length, notas: achados, atencao: out.completo ? null : 'leitura incompleta: nao achar aqui NAO prova que a nota nao existe' };
    return out;
  } finally {
    EM_ANDAMENTO.delete(loja.key);
  }
}

module.exports = { sondarTipos, lerNota, janela, lerTipos, lerTarefas, soCamposSimples, bateComABusca, MAX_DIAS, TIPOS_PADRAO, MAX_TAREFAS };
