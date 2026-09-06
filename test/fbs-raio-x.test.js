// Roda com: node test/fbs-raio-x.test.js
//
// Guarda as regras do raio-x das pendentes (06/09/2026, caso "31/31/31" da AMB)
// e os 4 apontamentos do Codex no PR #7:
// - a LISTA do /nfe e resumida e pode vir SEM chaveAcesso ⇒ a confirmacao e
//   sempre pelo DETALHE (/nfe/{id}); candidato cujo detalhe traz OUTRA chave
//   significa filtro ignorado (armadilha do ?numeroLoja) ⇒ verificada:false,
//   nunca "ausente";
// - veredito NUNCA categorico sobre varredura incompleta (limite/pular/erro);
// - falha de consulta NAO conta como "fora do Bling";
// - pendentes=0 e estado EM DIA (SEM_PENDENTES), nao evidencia contra a extensao;
// - &pular= varre alem do teto em fatias (fatia sozinha nunca fecha veredito).
//
// Exercita a funcao DE PRODUCAO (raioX) com IO injetado — nunca copia da logica.

'use strict';
const { raioX, decodificarChave } = require('../modules/fbs-raio-x');

let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok    ' : 'FALHA ') + o); };

const LOJA = { key: 'amb' };
const CH = (n) => '3526096428909100010055002' + String(n).padStart(9, '0') + '1234567890'; // 44 dig, serie 002
const idDe = (chave) => Number(chave.slice(25, 34)); // nNF como id sintetico

function lista(pendentes) {
  return () => ({ arquivo: 'amb-saida-atual.zip', total_no_zip: pendentes.length + 2, ja_marcadas: 2, pendentes, quando_marcou: '2026-09-06' });
}
/* Bling falso REALISTA (P1): a lista NAO traz chaveAcesso — so o detalhe traz. */
function blingQueTem(chavesQueTem) {
  return async (loja, url) => {
    const mL = url.match(/\/nfe\?chaveAcesso=(\d{44})/);
    if (mL) {
      const tem = chavesQueTem.includes(mL[1]);
      return { ok: true, json: async () => ({ data: tem ? [{ id: idDe(mL[1]), situacao: 5 }] : [] }) };
    }
    const mD = url.match(/\/nfe\/(\d+)$/);
    if (mD) {
      const chave = chavesQueTem.find(c => idDe(c) === Number(mD[1]));
      return { ok: true, json: async () => ({ data: { id: Number(mD[1]), numero: Number(mD[1]), serie: 2, situacao: 5, chaveAcesso: chave || CH(999) } }) };
    }
    throw new Error('teste nao previu URL: ' + url);
  };
}

(async () => {
  const d = decodificarChave('3526096428909100010055002' + '000012345' + '1234567890');
  ok(d.serie === '2', 'serie decodificada da chave = 2');
  ok(d.numero === '12345', 'numero decodificado da chave = 12345');

  // 1) todas as pendentes JA estao no Bling (lista aponta, DETALHE confirma)
  let r = await raioX(LOJA, { listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingQueTem([CH(1), CH(2), CH(3)]), BLING_BASE: 'x' });
  ok(r.veredito === 'TODAS_AS_PENDENTES_JA_ESTAO_NO_BLING', 'cenario 1: veredito TODAS_JA_ESTAO');
  ok(r.varredura_completa === true && r.fora_do_bling === 0 && r.ja_estao_no_bling === 3, 'cenario 1: contagens');
  ok(r.linhas[0].numero_bling === String(idDe(CH(1))), 'cenario 1: numero veio do DETALHE');

  // 2) duas realmente fora (lista vazia pra elas) → falha real
  r = await raioX(LOJA, { listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingQueTem([CH(2)]), BLING_BASE: 'x' });
  ok(r.veredito === 'HA_NOTAS_REALMENTE_FORA_DO_BLING', 'cenario 2: veredito FORA_DO_BLING');
  ok(r.fora_do_bling === 2 && r.linhas.filter(l => l.esta_no_bling === false).length === 2, 'cenario 2: 2 linhas fora');

  // 3) consulta que estoura → INDETERMINADO; falha nao vira "fora"
  const blingComErro = async (loja, url) => {
    if (url.includes(CH(2))) throw new Error('ETIMEDOUT');
    return blingQueTem([CH(1), CH(3)])(loja, url);
  };
  r = await raioX(LOJA, { listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingComErro, BLING_BASE: 'x' });
  ok(r.veredito === 'INDETERMINADO', 'cenario 3: erro de consulta ⇒ INDETERMINADO');
  ok(r.fora_do_bling === 0 && r.consultas_com_erro === 1 && r.varredura_completa === false, 'cenario 3: erro nao conta como fora');

  // 4) corte pelo limite → INDETERMINADO apontando a PROXIMA FATIA (&pular=)
  r = await raioX(LOJA, { limite: 2, listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingQueTem([CH(1), CH(2), CH(3)]), BLING_BASE: 'x' });
  ok(r.veredito === 'INDETERMINADO' && /pular=2/.test(r.detalhe), 'cenario 4: corte ⇒ INDETERMINADO com &pular=2');

  // 5) HTTP nao-ok na lista → erro de consulta com o status
  const bling429 = async () => ({ ok: false, status: 429, json: async () => ({}) });
  r = await raioX(LOJA, { listarPendentesFn: lista([CH(1)]), blingFetchFn: bling429, BLING_BASE: 'x' });
  ok(r.consultas_com_erro === 1 && r.fora_do_bling === 0 && r.veredito === 'INDETERMINADO', 'cenario 5: 429 vira erro de consulta');
  ok(/HTTP 429/.test(r.linhas[0].erro || ''), 'cenario 5: erro carrega o status');

  // 6) sem ZIP ainda → SEM_ZIP orientando
  r = await raioX(LOJA, { listarPendentesFn: () => ({ arquivo: null, total_no_zip: 0, ja_marcadas: 0, pendentes: [], quando_marcou: null }), blingFetchFn: blingQueTem([]), BLING_BASE: 'x' });
  ok(r.veredito === 'SEM_ZIP', 'cenario 6: sem arquivo baixado');

  // 7) (Codex) ZIP existe e TUDO ja marcado → SEM_PENDENTES neutro, zero chamadas
  let chamadas = 0;
  const blingContando = async (...a) => { chamadas++; return blingQueTem([])(...a); };
  r = await raioX(LOJA, { listarPendentesFn: lista([]), blingFetchFn: blingContando, BLING_BASE: 'x' });
  ok(r.veredito === 'SEM_PENDENTES' && chamadas === 0, 'cenario 7: em dia ⇒ SEM_PENDENTES sem tocar o Bling');

  // 8) (Codex) filtro ignorado: lista devolve candidato, DETALHE traz OUTRA chave
  const blingFiltroIgnorado = async (loja, url) => {
    if (url.includes('chaveAcesso=')) return { ok: true, json: async () => ({ data: [{ id: 42 }] }) };
    return { ok: true, json: async () => ({ data: { id: 42, chaveAcesso: CH(777) } }) };
  };
  r = await raioX(LOJA, { listarPendentesFn: lista([CH(1)]), blingFetchFn: blingFiltroIgnorado, BLING_BASE: 'x' });
  ok(r.veredito === 'INDETERMINADO' && r.fora_do_bling === 0, 'cenario 8: filtro ignorado NAO vira ausente');
  ok(/ignorado/.test(r.linhas[0].erro || ''), 'cenario 8: erro explica o filtro ignorado');

  // 9) (Codex) fatia com &pular=1: olha CH(2..3); fatia sozinha nunca e categorica
  r = await raioX(LOJA, { pular: 1, limite: 2, listarPendentesFn: lista([CH(1), CH(2), CH(3)]), blingFetchFn: blingQueTem([CH(1), CH(2), CH(3)]), BLING_BASE: 'x' });
  ok(r.verificadas === 2 && r.pulei === 1 && r.linhas[0].chave === CH(2), 'cenario 9: pular avanca a fatia');
  ok(r.veredito === 'INDETERMINADO' && r.varredura_completa === false, 'cenario 9: fatia ⇒ INDETERMINADO');

  console.log(falhas ? ('\nFALHOU: ' + falhas + ' verificacao(oes)') : '\nTUDO OK — raio-x honesto nos 9 cenarios');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('ERRO NO TESTE:', e.message); process.exit(1); });
