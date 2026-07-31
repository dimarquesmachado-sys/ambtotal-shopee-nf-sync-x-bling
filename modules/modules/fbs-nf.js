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
async function fbsGerar(loja, start, end, documentType, fileType = 1, documentStatus = 1) {
  const body = { batch_download: { start, end, document_type: documentType, file_type: fileType, document_status: documentStatus } };
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
      alvo.push({ nome, dados, chave });
    }
  }
  return { saida, entrada, indefinido };
}

function montarZip(itens) {
  const out = new AdmZip();
  itens.forEach(it => out.addFile(it.nome, it.dados));
  return out.toBuffer();
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
async function rotina(loja, opts = {}) {
  ensureDir(NF_DIR);
  const end = ymdSP();
  const dias = Math.max(1, Number(opts.dias || NF_DIAS));
  const start = ymdSP(new Date(Date.now() - (dias - 1) * 864e5));
  const fileType = 1; // XML
  const docStatus = 1; // autorizadas

  // etapa 1: gera tarefas de cada tipo de documento pedido
  let requestIds = [];
  for (const dt of tiposDoc()) {
    try { const ids = await fbsGerar(loja, start, end, dt, fileType, docStatus); requestIds.push(...ids); }
    catch (e) { console.error(`[fbs-nf][${loja.key}] gerar tipo ${dt}: ${e.message}`); }
    await sleep(400);
  }
  requestIds = Array.from(new Set(requestIds.map(Number)));
  if (!requestIds.length) return { ok: false, motivo: 'nenhuma tarefa gerada (sem notas no período?)', periodo: { de: ymdRotulo(start), ate: ymdRotulo(end) } };

  // etapa 2: espera ficar pronto
  const st = await fbsAguardar(loja, requestIds);
  // etapa 3: baixa os prontos
  const bufs = await fbsBaixar(loja, st.prontos);
  if (!bufs.length) return { ok: false, motivo: 'nada baixado', status: st, periodo: { de: ymdRotulo(start), ate: ymdRotulo(end) } };

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

  // grava os ZIPs em disco (saída e entrada separados — importam em lotes
  // diferentes no Bling: o campo Tipo muda)
  const carimbo = ymdRotulo(end) + '-' + new Date().toTimeString().slice(0, 5).replace(':', '');
  const escrito = {};
  if (novasSaida.length) {
    const nome = loja.key + '-saida-' + carimbo + '.zip';
    fs.writeFileSync(path.join(NF_DIR, nome), montarZip(novasSaida));
    escrito.saida = { nome, qtd: novasSaida.length };
  }
  if (novasEntrada.length) {
    const nome = loja.key + '-entrada-' + carimbo + '.zip';
    fs.writeFileSync(path.join(NF_DIR, nome), montarZip(novasEntrada));
    escrito.entrada = { nome, qtd: novasEntrada.length };
  }

  return {
    ok: true,
    periodo: { de: ymdRotulo(start), ate: ymdRotulo(end) },
    status: st,
    emitente,
    total: { saida: sep.saida.length, entrada: sep.entrada.length, indefinido: sep.indefinido.length },
    novas: { saida: novasSaida.length, entrada: novasEntrada.length },
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

// ── Limpeza: mantém os NF_MANTER mais novos por loja ──
function limpar(lojaKey) {
  let nomes = [];
  try { nomes = fs.readdirSync(NF_DIR); } catch (e) { return; }
  const meus = nomes.filter(n => n.startsWith(lojaKey + '-') && /\.zip$/.test(n))
    .map(n => ({ n, t: (() => { try { return fs.statSync(path.join(NF_DIR, n)).mtimeMs; } catch (e) { return 0; } })() }))
    .sort((a, b) => b.t - a.t);
  meus.slice(NF_MANTER).forEach(x => { try { fs.unlinkSync(path.join(NF_DIR, x.n)); } catch (e) {} });
}

module.exports = {
  NF_DIR, rotina, marcarImportadas, chavesDoZip, caminhoZip, limpar,
  lerImportadas, nfEmitente, nfChave, ymdSP,
  // expostos p/ teste
  separarXmls, fbsGerar, fbsAguardar, fbsBaixar
};
