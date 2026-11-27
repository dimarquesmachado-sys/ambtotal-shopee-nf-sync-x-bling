// Roda com: node test/fbs-sonda-tipos.test.js
//
// A SONDA DOS TIPOS DE DOCUMENTO DO FULL (27/11/2026). Caso (AMB): venda do Full devolvida pelo
// cliente, o painel de Devolucoes manda "importar o XML da NF de devolucao da Shopee" e essa nota
// nao existe no Bling. A rotina so pede a Shopee os tipos de FBS_DOC_TYPES (padrao: 4, venda).
// A sonda mede o que ha nos OUTROS tipos, sem mexer em nada.
//
// O que fica travado aqui (a funcao DE PRODUCAO, com a Shopee e o disco injetados):
//  - cada tipo e pedido separado e as notas voltam atribuidas ao tipo que as trouxe;
//  - a nota e descrita pelo que ELA diz (sentido, finalidade, natureza, serie, CFOP, NF referenciada);
//  - a busca acha a devolucao pelo pedido do item, pelo numero da NF de venda ou pela chave dela;
//  - SO LEITURA: nenhum arquivo nasce em disco e nada e marcado como importado;
//  - sem dado pessoal: nome, CPF e endereco do destinatario nao saem na resposta;
//  - "nao sei" != "nao tem": recusa, tarefa processando, download que falhou e ZIP ruim = INCOMPLETO;
//  - pedido fora do aceito (data, janela, tipo, limite) e recusado dizendo por que, sem falar com a Shopee;
//  - mostra o que a rotina pede hoje (o valor em vigor de FBS_DOC_TYPES);
//  - uma sonda por loja de cada vez; empresa sem Full sai limpa sem tocar na Shopee.

'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-sonda-tipos-'));
delete process.env.FBS_DOC_TYPES;
const AdmZip = require('adm-zip');
const fbsNf = require('../modules/fbs-nf');
const { sondarTipos, lerNota, MAX_DIAS, TIPOS_PADRAO } = require('../modules/fbs-sonda-tipos');

let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok    ' : 'FALHA ') + o); };

const LOJA = { key: 'amb', prefixo: 'AMB_SYNC', fbs: 'sim' };
const HOJE = 20261127;
// chave de mentira: cUF+AAMM (6) · CNPJ (14) · modelo (2) · serie (3) · numero (9) · resto (10)
const chave = (serie, n) => '352611' + '64289091000100' + '55' + String(serie).padStart(3, '0') + String(n).padStart(9, '0') + '1234567890';
const CH_VENDA = chave(5, 108);
const NOME_CLIENTE = 'FULANA DE TAL DA SILVA'; const CPF_CLIENTE = '12345678909'; const RUA_CLIENTE = 'RUA DAS FLORES 99';
function xml({ serie, numero, tpNF, finNFe, natOp, cfops, valor, ref, xPed }) {
  const ch = chave(serie, numero);
  return Buffer.from('<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe' + ch + '"><ide><cUF>35</cUF><natOp>' + natOp + '</natOp><mod>55</mod><serie>' + serie + '</serie><nNF>' + numero + '</nNF>' +
    '<dhEmi>2026-09-03T10:11:12-03:00</dhEmi><tpNF>' + tpNF + '</tpNF><finNFe>' + finNFe + '</finNFe>' + (ref ? '<NFref><refNFe>' + ref + '</refNFe></NFref>' : '') + '</ide>' +
    '<emit><CNPJ>64289091000100</CNPJ><xNome>EMPRESA DE TESTE LTDA</xNome></emit>' +
    '<dest><CPF>' + CPF_CLIENTE + '</CPF><xNome>' + NOME_CLIENTE + '</xNome><enderDest><xLgr>' + RUA_CLIENTE + '</xLgr></enderDest></dest>' +
    cfops.map((c, i) => '<det nItem="' + (i + 1) + '"><prod><xProd>Produto ' + i + '</xProd><CFOP>' + c + '</CFOP>' + (xPed ? '<xPed>' + xPed + '</xPed>' : '') + '</prod></det>').join('') +
    '<total><ICMSTot><vNF>' + valor + '</vNF></ICMSTot></total></infNFe></NFe></nfeProc>', 'utf8');
}
function zip(xmls) { const z = new AdmZip(); xmls.forEach((x, i) => z.addFile('pasta/nota-' + i + '.xml', x)); z.addFile('leia.txt', Buffer.from('nao e xml')); return z.toBuffer(); }

const DEVOLUCAO = xml({ serie: 5, numero: 9001, tpNF: 0, finNFe: 4, natOp: 'Devolucao de venda', cfops: ['1202'], valor: '142.41', ref: CH_VENDA, xPed: '260805TESTE0001' });
const DEVOLUCAO2 = xml({ serie: 5, numero: 9002, tpNF: 0, finNFe: 4, natOp: 'Devolucao de venda', cfops: ['1202', '2202'], valor: '50.00', ref: chave(5, 333), xPed: '260901TESTE0002' });
const SIMBOLICA = xml({ serie: 5, numero: 7001, tpNF: 0, finNFe: 1, natOp: 'Retorno simbolico de deposito', cfops: ['1907'], valor: '10.00' });
// tres notas que PARECEM devolucao de cliente e nao sao (falta um dos tres sinais: entrada, finalidade 4, NF referenciada)
const DEV_SEM_REF = xml({ serie: 5, numero: 7002, tpNF: 0, finNFe: 4, natOp: 'Devolucao sem referencia', cfops: ['1202'], valor: '20.00' });
const ENTRADA_COM_REF = xml({ serie: 5, numero: 7003, tpNF: 0, finNFe: 1, natOp: 'Entrada que cita outra nota', cfops: ['1949'], valor: '30.00', ref: chave(5, 444) });
const SAIDA_DEV_COM_REF = xml({ serie: 5, numero: 7004, tpNF: 1, finNFe: 4, natOp: 'Devolucao de compra', cfops: ['5202'], valor: '40.00', ref: chave(1, 555) });

/* Shopee de mentira: por tipo, diz o que acontece. Guarda as chamadas pra conferir o que foi pedido. */
function shopee(porTipo, extra) {
  const cham = { gerar: [], aguardar: [], baixar: [] };
  const idsDoTipo = (t) => (porTipo[t] && porTipo[t].zips ? porTipo[t].zips.map((_, i) => t * 100 + i) : []);
  const zipDoId = (id) => { const t = Math.floor(id / 100); return porTipo[t].zips[id % 100]; };
  const io = {
    hoje: () => HOJE,
    importadas: () => (extra && extra.importadas) || { quando: null, saida: [], entrada: [] },
    gerar: async (loja, start, end, tipo, fileType, docStatus) => {
      cham.gerar.push({ loja: loja.key, start, end, tipo, fileType, docStatus });
      const p = porTipo[tipo] || {};
      if (p.recusa) throw new Error('generate_fbs_invoices erro: "' + p.recusa + '"');
      return idsDoTipo(tipo);
    },
    aguardar: async (loja, ids) => {
      cham.aguardar.push(ids.slice());
      const processando = ids.filter((id) => (porTipo[Math.floor(id / 100)] || {}).processando);
      const erros = ids.filter((id) => (porTipo[Math.floor(id / 100)] || {}).erroTarefa).map((id) => ({ request_id: id, msg: 'FAILED' }));
      return { prontos: ids.filter((id) => !processando.includes(id) && !erros.some((e) => e.request_id === id)), erros, aindaProcessando: processando };
    },
    baixar: async (loja, ids) => {
      cham.baixar.push(ids.slice());
      return ids.filter((id) => !(porTipo[Math.floor(id / 100)] || {}).downloadFalha).map((id) => ({ request_id: id, buf: zipDoId(id) }));
    },
  };
  return { io, cham };
}
const doTipo = (r, t) => r.tipos.find((x) => x.tipo === t);
const arquivosEmDisco = () => { try { return fs.readdirSync(process.env.DATA_DIR, { recursive: true }).sort().join('|'); } catch (e) { return '(sem pasta)'; } };
const DISCO_ANTES = arquivosEmDisco();   // o que os modulos criam ao carregar nao e da sonda: compara antes e depois

(async () => {
  // ── 1) o caso: devolucao no tipo 2, simbolica no 3, o 5 recusado e o 6 sem tarefa ──
  let s = shopee({ 2: { zips: [zip([DEVOLUCAO, DEVOLUCAO2])] }, 3: { zips: [zip([SIMBOLICA, DEV_SEM_REF, ENTRADA_COM_REF, SAIDA_DEV_COM_REF])] }, 5: { recusa: 'error_param' }, 6: {} });
  let r = await sondarTipos(LOJA, { de: '2026-08-01', ate: '2026-11-27', busca: '108', io: s.io });
  ok(r.ok === true && r.so_leitura === true && r.periodo.de === '2026-08-01' && r.periodo.ate === '2026-11-27' && r.periodo.dias === 119, '⚠️ responde com o periodo pedido (119 dias) e se declara so leitura');
  ok(s.cham.gerar.map((g) => g.tipo).join() === '2,3,5,6' && TIPOS_PADRAO.join() === '2,3,5,6' && s.cham.gerar.every((g) => g.start === 20260801 && g.end === 20261127 && g.fileType === 1 && g.docStatus === 1 && g.loja === 'amb'), '⚠️ sem &tipos= pede os que a rotina NAO pede (2,3,5,6 — a venda, tipo 4, fica de fora), um por vez, com a janela inteira, XML e autorizadas');
  ok(s.cham.aguardar.length === 1 && s.cham.aguardar[0].join() === '200,300' && s.cham.baixar[0].join() === '200,300', '  uma espera so pras tarefas de todos os tipos, e baixa as prontas');
  const t2 = doTipo(r, 2), t3 = doTipo(r, 3), t5 = doTipo(r, 5), t6 = doTipo(r, 6);
  ok(t2.notas === 2 && t3.notas === 4 && t2.lista.every((n) => n.serie === '5' && n.tpNF === '0') && t3.lista.map((n) => n.numero).join() === '7001,7002,7003,7004', '⚠️ as notas voltam ATRIBUIDAS ao tipo que as trouxe (2 no tipo 2, 4 no tipo 3)');
  const n1 = t2.lista.find((n) => n.numero === '9001');
  ok(n1 && n1.chave === chave(5, 9001) && n1.finNFe === '4' && n1.natureza === 'Devolucao de venda' && n1.cfops.join() === '1202' && n1.valor === '142.41' && n1.emissao === '2026-09-03' && n1.pedido_loja === '260805TESTE0001', '⚠️ a nota e descrita pelo que ela diz: finalidade 4, natureza, CFOP, valor, data e o pedido do item');
  ok(n1 && n1.referencia.length === 1 && n1.referencia[0].chave === CH_VENDA && n1.referencia[0].serie === '5' && n1.referencia[0].numero === '108', '⚠️ a NF de VENDA referenciada sai com serie e numero (5 / 108) — e por ela que se casa com o card');
  ok(t2.entrada_de_devolucao_com_nf_referenciada === 2 && t3.entrada_de_devolucao_com_nf_referenciada === 0, '⚠️ conta as entradas de devolucao com NF referenciada: 2 no tipo 2; no tipo 3, ZERO (simbolica, devolucao sem referencia, entrada comum com referencia e devolucao de SAIDA nao contam)');
  ok(t2.resumo.length === 2 && t2.resumo.every((g) => g.sentido === 'entrada' && g.finNFe === '4' && g.com_nf_referenciada === 1) && t3.resumo[0].natureza === 'Retorno simbolico de deposito' && t3.resumo[0].cfops.join() === '1907' && t3.resumo[0].com_nf_referenciada === 0, '  o resumo agrupa por sentido, finalidade, natureza, serie e CFOP');
  ok(t2.completo === true && t3.completo === true && t5.completo === false && /recusou gerar/.test((t5.incompleto_por || []).join()) && /error_param/.test((t5.incompleto_por || []).join()) && r.completo === false, '⚠️ tipo recusado pela Shopee = INCOMPLETO, com a mensagem dela — e nao derruba os outros tipos');
  ok(t6.completo === true && t6.sem_tarefa === true && t6.notas === 0 && t5.sem_tarefa === false, '  tipo em que a Shopee nao abriu tarefa: sem_tarefa (diferente de recusado)');
  ok(r.busca && r.busca.achei === 1 && r.busca.notas[0].numero === '9001' && r.busca.notas[0].tipo === 2 && /incompleta/.test(r.busca.atencao), '⚠️ &busca=108 (numero da NF de venda) acha a devolucao dela, diz em que tipo veio e avisa que a leitura foi incompleta');
  const cru = JSON.stringify(r);
  ok(!cru.includes(NOME_CLIENTE) && !cru.includes(CPF_CLIENTE) && !cru.includes(RUA_CLIENTE) && !/FULANA/i.test(cru), '⚠️ sem dado pessoal: nome, CPF e endereco do destinatario nao saem na resposta');
  ok(arquivosEmDisco() === DISCO_ANTES, '⚠️ SO LEITURA: nenhum arquivo nasceu em disco (antes: "' + DISCO_ANTES + '" · depois: "' + arquivosEmDisco() + '")');
  ok(r.rotina_hoje.tipos_pedidos.join() === '4' && /ausente/.test(r.rotina_hoje.env_FBS_DOC_TYPES), '⚠️ mostra o que a rotina pede hoje: so o tipo 4, env ausente');

  // ── 2) a busca pelas outras duas chaves; e o que ja foi importado ──
  s = shopee({ 2: { zips: [zip([DEVOLUCAO, DEVOLUCAO2])] } }, { importadas: { saida: [], entrada: [chave(5, 9002)] } });
  r = await sondarTipos(LOJA, { tipos: '2', dias: '30', busca: '260805teste0001', io: s.io });
  ok(r.completo === true && r.busca.achei === 1 && r.busca.notas[0].numero === '9001' && r.busca.atencao === null, '  busca pelo PEDIDO do item (sem diferenciar maiuscula): acha, e leitura completa nao leva aviso');
  ok(s.cham.gerar.length === 1 && s.cham.gerar[0].tipo === 2 && s.cham.gerar[0].end === HOJE && s.cham.gerar[0].start === 20261029 && r.periodo.dias === 30, '⚠️ &tipos=2&dias=30: so o tipo pedido, 30 dias contando hoje (29/10 a 27/11)');
  const l2 = doTipo(r, 2).lista;
  ok(l2.find((n) => n.numero === '9002').ja_importada === true && l2.find((n) => n.numero === '9001').ja_importada === false, '  diz se a nota ja consta como importada pela extensao');
  r = await sondarTipos(LOJA, { tipos: '2', busca: CH_VENDA, io: shopee({ 2: { zips: [zip([DEVOLUCAO, DEVOLUCAO2])] } }).io });
  ok(r.busca.achei === 1 && r.busca.notas[0].numero === '9001', '  busca pela CHAVE da NF de venda: acha');
  r = await sondarTipos(LOJA, { tipos: '2', busca: '9002', limite: '1', io: shopee({ 2: { zips: [zip([DEVOLUCAO, DEVOLUCAO2])] } }).io });
  ok(doTipo(r, 2).lista.length === 1 && r.notas_fora_da_lista === 1 && doTipo(r, 2).notas === 2 && r.busca.achei === 1 && r.busca.notas[0].numero === '9002', '⚠️ &limite= corta so a LISTA: o resumo conta todas e a busca acha a que ficou de fora');
  r = await sondarTipos(LOJA, { tipos: '2', busca: '555', io: shopee({ 2: { zips: [zip([DEVOLUCAO])] } }).io });
  ok(r.busca.achei === 0 && r.busca.notas.length === 0, '  busca que nao bate: zero (e nao a primeira nota)');
  r = await sondarTipos(LOJA, { tipos: '2', io: shopee({ 2: { zips: [zip([DEVOLUCAO]), zip([DEVOLUCAO, DEVOLUCAO2])] } }).io });
  ok(doTipo(r, 2).notas === 2 && doTipo(r, 2).tarefas === 2 && r.busca === null, '  a mesma nota em dois arquivos conta uma vez; sem &busca= o campo vem nulo');

  // ── 3) "nao sei" != "nao tem" ──
  for (const [nome, cfg, re] of [
    ['tarefa ainda processando', { 2: { zips: [zip([DEVOLUCAO])], processando: true } }, /ainda processando/],
    ['tarefa com erro na Shopee', { 2: { zips: [zip([DEVOLUCAO])], erroTarefa: true } }, /com erro na Shopee: FAILED/],
    ['arquivo pronto que nao baixou', { 2: { zips: [zip([DEVOLUCAO])], downloadFalha: true } }, /nao consegui baixar/],
    ['arquivo que nao abre', { 2: { zips: [Buffer.from('isto nao e um zip')] } }, /nao abriram/],
  ]) {
    r = await sondarTipos(LOJA, { tipos: '2', busca: '108', io: shopee(cfg).io });
    const t = doTipo(r, 2);
    const por = t.incompleto_por || [];
    ok(r.ok === true && r.completo === false && t.completo === false && re.test(por.join()) && t.notas === 0 && t.sem_tarefa === false && /NAO prova/.test(String(r.busca.atencao)), '⚠️ ' + nome + ': INCOMPLETO (' + String(por[0] || 'saiu como completo').slice(0, 60) + '), nunca "sem documento"');
  }

  // ── 4) pedido fora do aceito: recusa dizendo por que, sem falar com a Shopee ──
  for (const [nome, opts, re] of [
    ['data que nao existe', { de: '2026-02-30', ate: '2026-03-01' }, /data inicial invalida/],
    ['formato de data errado', { de: '01/08/2026' }, /data inicial invalida/],
    ['so o fim', { ate: '2026-11-01' }, /informe tambem o inicio/],
    ['fim invalido', { de: '2026-11-01', ate: 'ontem' }, /data final invalida/],
    ['inicio depois do fim', { de: '2026-11-10', ate: '2026-11-01' }, /depois da final/],
    ['fim no futuro', { de: '2026-11-01', ate: '2026-12-01' }, /depois de hoje/],
    ['janela acima do teto', { de: '2026-07-01', ate: '2026-11-27' }, new RegExp('teto por chamada e ' + MAX_DIAS)],
    ['dias zero', { dias: '0' }, /dias invalido/],
    ['dias quebrado', { dias: '2.5' }, /dias invalido/],
    ['dias texto', { dias: 'muitos' }, /dias invalido/],
    ['tipo 7 (todos)', { tipos: '2,7' }, /tipo de documento invalido/],
    ['tipo 0', { tipos: '0' }, /tipo de documento invalido/],
    ['tipo texto', { tipos: 'devolucao' }, /tipo de documento invalido/],
    ['so virgulas', { tipos: ',,' }, /nenhum tipo/],
    ['limite negativo', { limite: '-1' }, /limite invalido/],
    ['limite texto', { limite: 'tudo' }, /limite invalido/],
  ]) {
    s = shopee({ 2: { zips: [zip([DEVOLUCAO])] } });
    r = await sondarTipos(LOJA, Object.assign({ io: s.io }, opts));
    ok(r.ok === false && r.pedido_invalido === true && re.test(r.erro) && s.cham.gerar.length === 0, '  ' + nome + ': recusado ("' + String(r.erro).slice(0, 50) + '") sem chamar a Shopee');
  }
  s = shopee({ 2: { zips: [zip([DEVOLUCAO])] } });
  r = await sondarTipos(LOJA, { de: '2026-07-27', ate: '2026-11-27', tipos: '2,2, 3', io: s.io });
  ok(r.ok === true && r.periodo.dias === MAX_DIAS && s.cham.gerar.map((g) => g.tipo).join() === '2,3', '  janela exatamente no teto (' + MAX_DIAS + ' dias) passa; tipo repetido e pedido uma vez');
  r = await sondarTipos(LOJA, { de: '2026-11-27', io: shopee({ 2: { zips: [zip([DEVOLUCAO])] } }).io });
  ok(r.ok === true && r.periodo.de === '2026-11-27' && r.periodo.ate === '2026-11-27' && r.periodo.dias === 1, '  so &de=: vai ate hoje');

  // ── 5) o que a rotina pede hoje acompanha a env ──
  process.env.FBS_DOC_TYPES = '4,2';
  r = await sondarTipos(LOJA, { tipos: '2', io: shopee({ 2: { zips: [zip([DEVOLUCAO])] } }).io });
  ok(r.rotina_hoje.tipos_pedidos.join() === '4,2' && r.rotina_hoje.env_FBS_DOC_TYPES === 'definida' && r.rotina_hoje.tipos_pedidos.join() === fbsNf.tiposDoc().join(), '⚠️ com FBS_DOC_TYPES=4,2 a sonda mostra 4,2 — a MESMA leitura da rotina');
  delete process.env.FBS_DOC_TYPES;

  // ── 6) empresa sem Full sai limpa; e uma sonda por loja de cada vez ──
  s = shopee({ 2: { zips: [zip([DEVOLUCAO])] } });
  r = await sondarTipos({ key: 'good', prefixo: 'GOOD_SYNC', fbs: 'nao' }, { io: s.io });
  ok(r.ok === true && r.sem_full === true && /GOOD_SYNC_FBS=0/.test(r.motivo) && s.cham.gerar.length === 0, '⚠️ empresa declarada sem Full: sai limpa e nem fala com a Shopee');
  let soltar; const presa = new Promise((res) => { soltar = res; });
  s = shopee({ 2: { zips: [zip([DEVOLUCAO])] } });
  const gerarOriginal = s.io.gerar; s.io.gerar = async (...a) => { await presa; return gerarOriginal(...a); };
  const primeira = sondarTipos(LOJA, { tipos: '2', io: s.io });
  const segunda = await sondarTipos(LOJA, { tipos: '2', io: shopee({ 2: { zips: [zip([DEVOLUCAO])] } }).io });
  const outraLoja = await sondarTipos({ key: 'girassol', prefixo: 'GIRASSOL_SYNC', fbs: 'sim' }, { tipos: '2', io: shopee({ 2: { zips: [zip([DEVOLUCAO])] } }).io });
  ok(segunda.ok === false && segunda.ja_em_andamento === true && outraLoja.ok === true, '⚠️ segunda sonda da MESMA loja enquanto a primeira roda: recusada; a de outra loja passa');
  soltar(); const r1 = await primeira;
  const depois = await sondarTipos(LOJA, { tipos: '2', io: shopee({ 2: { zips: [zip([DEVOLUCAO])] } }).io });
  ok(r1.ok === true && doTipo(r1, 2).notas === 1 && depois.ok === true, '  terminou: a primeira responde e a loja fica livre de novo');
  const quebra = shopee({ 2: { zips: [zip([DEVOLUCAO])] } }); quebra.io.aguardar = async () => { throw new Error('rede caiu'); };
  let estourou = null; try { await sondarTipos(LOJA, { tipos: '2', io: quebra.io }); } catch (e) { estourou = e.message; }
  const aposErro = await sondarTipos(LOJA, { tipos: '2', io: shopee({ 2: { zips: [zip([DEVOLUCAO])] } }).io });
  ok(estourou === 'rede caiu' && aposErro.ok === true, '⚠️ erro no meio (a espera estourou) sobe como erro — e NAO deixa a loja travada pra proxima');

  ok(arquivosEmDisco() === DISCO_ANTES, '⚠️ SO LEITURA, depois de todas as sondas (inclusive as incompletas e a que estourou): o disco segue igual');

  // ── 7) a leitura da nota, sozinha ──
  const semIde = lerNota(Buffer.from('<nfeProc><NFe><infNFe Id="NFe' + chave(3, 42) + '"></infNFe></NFe></nfeProc>'), 'x.xml');
  ok(semIde.chave === chave(3, 42) && semIde.serie === '3' && semIde.numero === '42' && semIde.tpNF === null && semIde.finNFe === null && semIde.referencia.length === 0 && semIde.cfops.length === 0, '  XML sem identificacao: serie e numero saem da chave, e o que nao ha fica nulo (nao inventa)');

  // ── 8) a rota existe, pede a chave e nao grava nada ──
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ini = srv.indexOf("app.get('/:loja/fbs/sonda-tipos'"); const fim = srv.indexOf("app.get('/:loja/fbs/painel'", ini);
  ok(ini >= 0 && fim > ini, '  a rota /:loja/fbs/sonda-tipos existe (antes do painel)');
  const rota = ini >= 0 && fim > ini ? srv.slice(ini, fim) : '';
  ok(/resolverLoja/.test(rota) && /if \(!fbsAuthOk\(req\)\) return res\.status\(401\)/.test(rota) && /fbsSondaTipos\.sondarTipos\(req\.loja,/.test(rota), '⚠️ a rota exige a chave do servico (401 sem ela) e chama a sonda da loja da URL');
  const cors = srv.indexOf("app.use('/:loja/fbs', (req, res, next) => {");
  ok(cors >= 0 && cors < ini, '  a rota fica depois do CORS das rotas /fbs/');
  const mod = fs.readFileSync(path.join(__dirname, '..', 'modules', 'fbs-sonda-tipos.js'), 'utf8');
  ok(!/writeFile|appendFile|mkdirSync|marcarImportadas|gravarDePara|montarZip|unlinkSync/.test(mod), '⚠️ o modulo da sonda nao tem nenhuma escrita em disco nem marca importada');

  // ── 9) a rota DE VERDADE, com o server.js no ar (nenhum destes caminhos fala com a Shopee) ──
  {
    const { spawn } = require('child_process'); const net = require('net');
    const porta = await new Promise((res) => { const sv = net.createServer(); sv.listen(0, () => { const p = sv.address().port; sv.close(() => res(p)); }); });
    const CHAVE = 'chave-so-deste-teste';
    const env = Object.assign({}, process.env, { PORT: String(porta), NODE_ENV: 'test', PULAR_CRON: '1', ADMIN_KEY: CHAVE, INTERNAL_KEY: '', GOOD_SYNC_FBS: '0', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-sonda-rota-')) });
    const filho = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'pipe' });
    let log = ''; filho.stdout.on('data', (d) => { log += d; }); filho.stderr.on('data', (d) => { log += d; });
    const base = 'http://127.0.0.1:' + porta;
    let subiu = false;
    for (let i = 0; i < 40 && !subiu; i++) { await new Promise((r) => setTimeout(r, 300)); try { subiu = (await fetch(base + '/')).ok; } catch (e) { /* ainda subindo */ } }
    ok(subiu, '⚠️ o server.js subiu' + (subiu ? '' : ' — ' + log.slice(-300)));
    if (subiu) {
      const pede = async (caminho) => { const r = await fetch(base + caminho); let j = null; try { j = await r.json(); } catch (e) { /* corpo nao e JSON */ } return { status: r.status, j }; };
      let x = await pede('/amb/fbs/sonda-tipos');
      ok(x.status === 401 && x.j && x.j.ok === false, '⚠️ rota no ar, sem chave: 401');
      x = await pede('/amb/fbs/sonda-tipos?k=chave-errada&tipos=2');
      ok(x.status === 401, '  chave errada: 401');
      x = await pede('/amb/fbs/sonda-tipos?k=' + CHAVE + '&de=2026-02-30');
      ok(x.status === 400 && x.j && x.j.pedido_invalido === true && /data inicial invalida/.test(x.j.erro), '⚠️ rota no ar, data que nao existe: 400 com o motivo (status ' + x.status + ')');
      x = await pede('/amb/fbs/sonda-tipos?k=' + CHAVE + '&tipos=2&tipos=9');
      ok(x.status === 400 && /tipo de documento invalido/.test((x.j && x.j.erro) || ''), '  parametro repetido na URL (&tipos=2&tipos=9): 400, nao erro interno');
      x = await pede('/amb/fbs/sonda-tipos?k=' + CHAVE + '&de=2026-11-01&de=2026-11-02');
      ok(x.status === 400 && /data inicial invalida/.test((x.j && x.j.erro) || ''), '  data repetida na URL: 400, nao erro interno');
      x = await pede('/good/fbs/sonda-tipos?k=' + CHAVE);
      ok(x.status === 200 && x.j && x.j.ok === true && x.j.sem_full === true && x.j.versao === 'sonda-tipos v1' && Array.isArray(x.j.rotina_hoje.tipos_pedidos), '⚠️ rota no ar, empresa sem Full: 200 "sem_full" e o que a rotina pede hoje (status ' + x.status + ')');
      x = await pede('/lojaquenaoexiste/fbs/sonda-tipos?k=' + CHAVE);
      ok(x.status === 404, '  loja desconhecida: 404');
    }
    try { filho.kill('SIGKILL'); } catch (e) { /* ja saiu */ }
  }

  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
