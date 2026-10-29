'use strict';
// 29/10 — a lista de devolucoes que vai pro Devolucoes passa a levar a SOLUCAO, os PRAZOS e o TRANSPORTE.
// Dados reais da Girassol (consultados pelo dono em 29/10 com /interno/shopee-raw). Roda o modulo de producao.
const det = require('../modules/shopee-devolucoes-detalhe');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
// itens como vem da get_return_list (sem transporte — conferido 29/10)
const LISTA = [
  { return_sn: '2607040QR2JAYU9', order_sn: '260703NCR4719V', status: 'ACCEPTED', reason: 'ITEM_MISSING', tracking_number: '',
    create_time: 1783116930, update_time: 1783444126, return_solution: 1, needs_logistics: true, return_ship_due_date: 0, item: [] },
  { return_sn: '2608180NVV0BBKA', order_sn: '260813898DFEWW', status: 'ACCEPTED', reason: 'CHANGE_MIND', tracking_number: 'BR260236192139R',
    create_time: 1787053360, update_time: 1788032419, return_solution: 0, needs_logistics: true, return_ship_due_date: 1787658325,
    return_seller_due_date: 1788030954, item: [{ name: '20 X Lixas', item_sku: '20-AE-8F-180mm-PAI', amount: 1 }] },
  { return_sn: '2608180NVT0CJRA', order_sn: '260813898DFEWW', status: 'CANCELLED', reason: 'CHANGE_MIND', tracking_number: '',
    create_time: 1787053293, update_time: 1787058748, return_solution: 0, needs_logistics: true, item: [] },
];
// o que o get_return_detail respondeu
const DETALHE = {
  '2607040QR2JAYU9': { logistics_status: '', reverse_logistics_status: 'LOGISTICS_NOT_STARTED', tracking_number: '' },
  '2608180NVV0BBKA': { logistics_status: 'LOGISTICS_DELIVERY_DONE', reverse_logistics_status: 'LOGISTICS_DELIVERY_DONE', tracking_number: 'BR260236192139R' },
  '2608180NVT0CJRA': { logistics_status: '', reverse_logistics_status: '', tracking_number: '' },
};
(async () => {
  const dados = LISTA.map(det.normalizarDaLista);
  ok(dados[0].return_solution === 1 && dados[1].return_solution === 0, '⚠️ a solucao vai adiante (1 = so reembolso, 0 = com retorno)');
  ok(dados[1].return_ship_due_date === 1787658325 && dados[1].return_seller_due_date === 1788030954, '  os prazos vao adiante');
  ok(dados[1].itens[0].sku === '20-AE-8F-180mm-PAI' && dados[1].status === 'ACCEPTED' && dados[1].tracking_number === 'BR260236192139R',
    '  os 8 campos de antes continuam iguais (itens, status, rastreio)');
  const consultas = []; const cache = new Map();
  const buscarDetalhe = async (sn) => { consultas.push(sn); return DETALHE[sn] || null; };
  let r = await det.hidratar(dados, { cache, buscarDetalhe, dorme: async () => {} });
  ok(dados[1].logistics_status === 'LOGISTICS_DELIVERY_DONE', '⚠️ a devolucao aberta com retorno ganha o transporte do detalhe: ENTREGUE');
  ok(!consultas.includes('2607040QR2JAYU9') || dados[0].tracking_number === null, '  so-reembolso sem rastreio: consulta so pela cacada de rastreio');
  ok(dados[2].logistics_status === null && dados[2].status === 'CANCELLED', '  devolucao cancelada (final) nao e tratada como aberta');
  // segunda atualizacao, nada mudou na Shopee (update_time igual): zero consulta, transporte vem do cache
  const dados2 = LISTA.map(det.normalizarDaLista); consultas.length = 0;
  r = await det.hidratar(dados2, { cache, buscarDetalhe, dorme: async () => {} });
  ok(r.chamadas === 0 && dados2[1].logistics_status === 'LOGISTICS_DELIVERY_DONE', '⚠️ sem mudanca na Shopee: nenhuma consulta nova, transporte do cache');
  // a Shopee mudou a devolucao (update_time novo): consulta de novo
  const lista3 = LISTA.map((x) => (x.return_sn === '2608180NVV0BBKA' ? Object.assign({}, x, { update_time: 1789000000 }) : x));
  const dados3 = lista3.map(det.normalizarDaLista); consultas.length = 0;
  await det.hidratar(dados3, { cache, buscarDetalhe, dorme: async () => {} });
  ok(consultas.includes('2608180NVV0BBKA'), '  a Shopee mudou a devolucao (update_time novo): consulta o detalhe de novo');
  // detalhe falhou: mantem o que ja sabia, nunca apaga
  const lista4 = LISTA.map((x) => (x.return_sn === '2608180NVV0BBKA' ? Object.assign({}, x, { update_time: 1790000000 }) : x));
  const dados4 = lista4.map(det.normalizarDaLista);
  await det.hidratar(dados4, { cache, buscarDetalhe: async () => null, dorme: async () => {} });
  ok(dados4[1].logistics_status === 'LOGISTICS_DELIVERY_DONE', '⚠️ o detalhe falhou: mantem o transporte que ja sabia (nao vira "sem transporte")');
  // teto por atualizacao: o resto fica pra proxima
  const muitas = Array.from({ length: 50 }, (_, i) => det.normalizarDaLista({ return_sn: 'R' + i, status: 'ACCEPTED', tracking_number: 'T' + i, update_time: 1, return_solution: 0 }));
  const r5 = await det.hidratar(muitas, { cache: new Map(), max: 40, buscarDetalhe: async () => ({ logistics_status: 'LOGISTICS_PICKUP_DONE' }), dorme: async () => {} });
  ok(r5.chamadas === 40 && r5.adiadas === 10, '  teto de 40 consultas por atualizacao; as outras 10 vem na proxima');
  // a rota usa o modulo
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  ok(/const dados = unicos\.map\(_detDev\.normalizarDaLista\);/.test(src) && /await _detDev\.hidratar\(dados,/.test(src), '⚠️ a rota /:loja/interno/devolucoes usa o modulo');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
