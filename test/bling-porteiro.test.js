'use strict';
// 13/10 — o servico da Shopee pede a vez ao porteiro da cota (conta da loja, servico=shopee-nf-sync) e avisa ok/429.
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const chamadas = [];
let respBling = 200;
require.cache[require.resolve('node-fetch')] = { id: 'nf', filename: 'nf', loaded: true, exports: async (url, op) => {
  chamadas.push(String(url));
  if (/bling-ritmo\/permissao/.test(url)) return { ok: true, json: async () => ({ ok: true, ficha: 'F1' }) };
  if (/bling-ritmo\//.test(url)) return { ok: true, json: async () => ({ ok: true }) };
  return { ok: respBling === 200, status: respBling, headers: { get: () => '7' }, json: async () => ({ data: [] }), text: async () => '{}' };
} };
const tm = path.join(__dirname, '..', 'modules', 'token-manager.js');
require.cache[require.resolve(tm)] = { id: tm, filename: tm, loaded: true, exports: { getValidBlingToken: async () => 'tk', refreshBlingToken: async () => ({ access_token: 'tk2' }) } };
(async () => {
  process.env.BLING_RITMO_URL = 'https://mp'; process.env.BLING_RITMO_KEY = 'k';
  const api = require(path.join(__dirname, '..', 'modules', 'bling-api.js'));
  const loja = { key: 'girassol' };
  const fn = api.blingFetch || (api._interno && api._interno.blingFetch);
  if (typeof fn !== 'function') { console.log('FALHA blingFetch nao exportado'); process.exit(1); }
  await fn(loja, 'https://api.bling.com.br/Api/v3/nfe?pagina=1');
  await new Promise((r) => setTimeout(r, 20));
  const perm = chamadas.find((u) => /bling-ritmo\/permissao/.test(u));
  ok(perm && /conta=girassol/.test(perm) && /servico=shopee-nf-sync/.test(perm) && /prioridade=operacao/.test(perm), '⚠️ pede a vez ao porteiro na conta da loja, como shopee-nf-sync (operacao)');
  ok(chamadas.some((u) => /bling-ritmo\/aviso-ok/.test(u) && /ficha=F1/.test(u)), '  sucesso avisado com a ficha (o porteiro zera o degrau)');
  chamadas.length = 0; respBling = 429;
  await fn(loja, 'https://api.bling.com.br/Api/v3/nfe?pagina=2', {}, 4);   // tentativa 4: nao repete
  await new Promise((r) => setTimeout(r, 20));
  ok(chamadas.some((u) => /bling-ritmo\/aviso-429/.test(u) && /conta=girassol/.test(u) && /servico=shopee-nf-sync/.test(u)), '⚠️ o 429 vai pro porteiro com o nome do servico');
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
