// Roda com: node test/fbs-raio-x.test.js
//
// Guarda as regras do raio-x das pendentes (06/09/2026, caso "31/31/31" da AMB):
// - veredito NUNCA e categorico sobre varredura incompleta (limite cortou OU
//   consulta falhou ⇒ INDETERMINADO dizendo quantas olhou) — mesma licao do
//   raio-x de vendas do Mover-Pedidos, que deu veredito sobre 14% da janela;
// - falha de consulta NAO conta como "fora do Bling";
// - os dois desfechos completos saem com o nome certo;
// - a serie e o numero decodificados da chave batem com o layout da NF-e.
//
// Exercita a funcao DE PRODUCAO (raioX) com o IO injetado (lista de pendentes
// e blingFetch falsos) — nunca uma copia da logica.

'use strict';
const { raioX, decodificarChave } = require('../modules/fbs-raio-x');

let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok    ' : 'FALHA ') + o); };

const LOJA = { key: 'amb' };
const CH = (n) => '3526096428909100010055002' + String(n).padStart(9, '0') + '1234567890'; // 44 dig, serie 002

function lista(pendentes) {
  return () => ({ arquivo: 'amb-saida-atual.zip', total_no_zip: pendentes.length + 2, ja_marcadas: 2, pendentes, quando_marcou: '2026-09-06' });
}
function blingQueTem(chavesQueTem) {
  return async (loja, url) => {
    const chave = (url.match(/chaveAcesso=(\d{44})/) || [])[1];
    const tem = chavesQueTem.includes(chave);
    return { ok: true, json: async () => ({ data: tem ? [{ id: 1, numero: 123, serie: 2, situacao: 5, chaveAcesso: chave }] : [] }) };
  };
}

(async () => {
  // decodificacao da chave: serie 002 → "2"; numero embutido nas posicoes 25-34
  const d = decodificarChave('3526096428909100010055002' + '000012345' + '1234567890');
  ok(d.serie === '2', 'serie decodificada da chave = 2');
  ok(d.numero === '12345', 'numero decodificado da chave = 12345');

  // 1) todas as pendentes JA estao no Bling → veredito de contabilidade
  let r = await raioX(LOJA, { listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingQueTem([CH(1), CH(2), CH(3)]), BLING_BASE: 'x' });
  ok(r.veredito === 'TODAS_AS_PENDENTES_JA_ESTAO_NO_BLING', 'cenario 1: veredito TODAS_JA_ESTAO');
  ok(r.varredura_completa === true && r.fora_do_bling === 0 && r.ja_estao_no_bling === 3, 'cenario 1: contagens');

  // 2) duas realmente fora → falha real, com as linhas apontando quais
  r = await raioX(LOJA, { listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingQueTem([CH(2)]), BLING_BASE: 'x' });
  ok(r.veredito === 'HA_NOTAS_REALMENTE_FORA_DO_BLING', 'cenario 2: veredito FORA_DO_BLING');
  ok(r.fora_do_bling === 2 && r.linhas.filter(l => l.esta_no_bling === false).length === 2, 'cenario 2: 2 linhas fora');

  // 3) uma consulta falha → INDETERMINADO, e a falha NAO vira "fora do Bling"
  const blingComErro = async (loja, url) => {
    const chave = (url.match(/chaveAcesso=(\d{44})/) || [])[1];
    if (chave === CH(2)) throw new Error('ETIMEDOUT');
    return blingQueTem([CH(1), CH(3)])(loja, url);
  };
  r = await raioX(LOJA, { listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingComErro, BLING_BASE: 'x' });
  ok(r.veredito === 'INDETERMINADO', 'cenario 3: erro de consulta ⇒ INDETERMINADO');
  ok(r.fora_do_bling === 0 && r.consultas_com_erro === 1 && r.varredura_completa === false, 'cenario 3: erro nao conta como fora');

  // 4) pendentes alem do limite → INDETERMINADO explicando o corte
  r = await raioX(LOJA, { limite: 2, listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingQueTem([CH(1), CH(2), CH(3)]), BLING_BASE: 'x' });
  ok(r.veredito === 'INDETERMINADO' && /limite=2/.test(r.detalhe), 'cenario 4: corte pelo limite ⇒ INDETERMINADO');

  // 5) HTTP nao-ok do Bling → verificada:false com o status, nunca "fora"
  const bling429 = async () => ({ ok: false, status: 429, json: async () => ({}) });
  r = await raioX(LOJA, { listarPendentesFn: lista([CH(1)]), blingFetchFn: bling429, BLING_BASE: 'x' });
  ok(r.consultas_com_erro === 1 && r.fora_do_bling === 0 && r.veredito === 'INDETERMINADO', 'cenario 5: 429 vira erro de consulta');
  ok(/HTTP 429/.test(r.linhas[0].erro || ''), 'cenario 5: erro carrega o status');

  // 6) sem ZIP ainda → SEM_ZIP orientando, sem explodir
  r = await raioX(LOJA, { listarPendentesFn: () => ({ arquivo: null, total_no_zip: 0, ja_marcadas: 0, pendentes: [], quando_marcou: null }), blingFetchFn: blingQueTem([]), BLING_BASE: 'x' });
  ok(r.veredito === 'SEM_ZIP', 'cenario 6: sem arquivo baixado');

  console.log(falhas ? ('\nFALHOU: ' + falhas + ' verificacao(oes)') : '\nTUDO OK — raio-x honesto nos 6 cenarios');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE:', e.message); process.exit(1); });
