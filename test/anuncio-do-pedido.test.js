'use strict';
// Rota interna /:loja/interno/anuncio-do-pedido — roda o handler DE PRODUCAO (tirado do server.js) com a Shopee falsa.
const fs = require('fs'); const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const s = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ini = s.indexOf("app.get('/:loja/interno/anuncio-do-pedido', resolverLoja, ");
const corpoIni = ini + "app.get('/:loja/interno/anuncio-do-pedido', resolverLoja, ".length;
const fim = s.indexOf('\n});', corpoIni);
const fonte = s.slice(corpoIni, fim + 2);
const montar = new Function('shopee', '_shopeeAuthOk', 'return (' + fonte + ');');
const shopee = { buscarDetalhesPedidos: async (loja, sns) => (sns[0] === 'BRINDE000000Z1' ? [{ order_sn: 'BRINDE000000Z1', item_list: [{ item_name: 'Brinde', model_discounted_price: 0, model_original_price: 10 }] }] : sns[0] === '260910KKS30YAK' ? [{ order_sn: '260910KKS30YAK', item_list: [{ item_name: 'Politriz Dupla Acao 1050W + Cabo + Kit Boinas', model_name: '110V', item_sku: 'KIT-POLI', model_sku: 'KIT-POLI-110', model_discounted_price: 547.9, model_quantity_purchased: 1 }] }] : []) };
const chamar = (auth, query) => new Promise((res) => montar(shopee, () => auth)({ query, loja: { nome: 'girassol' } }, { _s: 200, status(x) { this._s = x; return this; }, json(o) { res({ s: this._s, o }); } }));
(async () => {
  const r = await chamar(true, { sn: '260910KKS30YAK' });
  ok(r.o.ok && r.o.itens[0].titulo === 'Politriz Dupla Acao 1050W + Cabo + Kit Boinas' && r.o.itens[0].sku === 'KIT-POLI-110' && r.o.itens[0].preco === 547.9 && r.o.itens[0].variacao === '110V', '⚠️ devolve titulo, variacao, SKU (da variacao) e preco do anuncio');
  shopee._zero = true;
  ok((await chamar(false, { sn: 'x' })).s === 401, '  sem a chave interna: 401');
  ok((await chamar(true, { sn: 'BRINDE000000Z1' })).o.itens[0].preco === 0, '  preco 0 (brinde) continua 0, nao vira "sem preco" (Codex #27)');
  ok((await chamar(true, {})).s === 400, '  sem ?sn=: 400');
  ok((await chamar(true, { sn: 'NAOEXISTE' })).s === 404, '  pedido que a Shopee nao devolve: 404');
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
