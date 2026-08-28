// Roda com: node test/rota-devolucoes-nao-duplica.test.js
//
// Guarda o bug medido em 28/08/2026 na GOOD.
//
// Em 06/08 um "Update server.js" acrescentou uma SEGUNDA rota
// /:loja/interno/devolucoes ACIMA da que ja existia. No Express a
// primeira declarada vence, entao ela passou a atender tudo e a rota
// principal virou codigo morto.
//
// Como a rota de cima devolve a resposta CRUA da Shopee ({ok, loja, de,
// ate, resposta}) e NAO tem o campo `devolucoes`, o painel de Devolucoes
// — que le d.devolucoes — recebia undefined e caia pra lista vazia SEM
// ERRO. A tela dizia "lista com 0 devolucoes" e nenhuma etiqueta Shopee
// casava, nas TRES empresas.

const express = require('express');
const http = require('http');

let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

// Reproduz as DUAS rotas na mesma ordem do server.js, com o conserto.
const app = express();

// (1) diagnostico, declarada primeiro — so responde com ?cru=1
app.get('/:loja/interno/devolucoes', (req, res, next) => {
  if (req.query.cru !== '1') return next();
  res.json({ ok: true, loja: req.params.loja, de: 1, ate: 2, resposta: { cru: true } });
});

// (2) principal, declarada depois — a que o painel consome
app.get('/:loja/interno/devolucoes', (req, res) => {
  if (req.query.procurar) return res.json({ ok: true, alvo: req.query.procurar, achados: [], encontrado: false });
  if (req.query.tracking) return res.json({ ok: true, encontrado: false, motivo: 'via tracking' });
  if (req.query.pedido)   return res.json({ ok: true, encontrado: false, motivo: 'via pedido' });
  res.json({ ok: true, qtd: 2, devolucoes: [{ return_sn: 'A' }, { return_sn: 'B' }] });
});

const srv = http.createServer(app);

function pegar(caminho) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path: caminho }, (r) => {
      let b = ''; r.on('data', (d) => (b += d));
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

srv.listen(0, '127.0.0.1', async () => {
  // ── o caso que quebrou o galpao ────────────────────────────────────
  const lista = await pegar('/good/interno/devolucoes');
  ok(Array.isArray(lista.devolucoes),
     'chamada normal responde com o campo `devolucoes` (era undefined -> lista vazia silenciosa)');
  ok(lista.devolucoes && lista.devolucoes.length === 2, '  e com as devolucoes de verdade');
  ok(lista.resposta === undefined, '  e NAO com a resposta crua da rota de diagnostico');

  // ── o painel le exatamente assim ───────────────────────────────────
  const comoOPainelLe = (d) => (d.devolucoes || []);
  ok(comoOPainelLe(lista).length === 2,
     'o painel (d.devolucoes || []) enxerga 2 — antes enxergava 0 e dizia "lista com 0 devolucoes"');

  // ── os diagnosticos, que tambem eram engolidos ─────────────────────
  const proc = await pegar('/good/interno/devolucoes?procurar=260807PBTHEWQG&dias=180');
  ok(proc.alvo === '260807PBTHEWQG', '?procurar= chega na rota certa (era engolido)');
  const trk = await pegar('/good/interno/devolucoes?tracking=BR260514290476K');
  ok(trk.motivo === 'via tracking', '?tracking= idem');
  const ped = await pegar('/good/interno/devolucoes?pedido=260807PBTHEWQG');
  ok(ped.motivo === 'via pedido', '?pedido= idem');

  // ── e o modo cru continua existindo pra quem usa ───────────────────
  const cru = await pegar('/good/interno/devolucoes?cru=1');
  ok(cru.resposta && cru.resposta.cru === true, '?cru=1 ainda entrega a resposta crua da Shopee');
  ok(cru.devolucoes === undefined, '  (esse e o formato que NAO serve pro painel)');

  // ── vale pras tres empresas, nao so a GOOD ─────────────────────────
  for (const loja of ['good', 'amb', 'girassol']) {
    const r = await pegar('/' + loja + '/interno/devolucoes');
    ok(Array.isArray(r.devolucoes), 'loja ' + loja + ': campo `devolucoes` presente');
  }

  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  srv.close();
  process.exit(falhas ? 1 : 0);
});
