'use strict';

/* ═══ RAIO-X DAS PENDENTES — o dado dos DOIS lados do "31/31/31" ═════════════════
   Contexto (06/09, AMB): a extensão mostrou "31 de saída enviadas — 31 já estavam
   lá — 31 NÃO importadas (vão re-tentar)". Os dois contadores são contagens de
   frase sobre a MESMA resposta do Bling (ct-nf.js na toolbox), então podem ser a
   mesma nota contada duas vezes — mas o corpo da resposta é descartado e não há
   log pra ler. Este raio-x busca o dado que falta pelo outro lado: pega as chaves
   que o servidor considera PENDENTES (ZIP atual − _importado.json) e pergunta ao
   Bling, chave a chave, se a nota ESTÁ lá (GET /nfe?chaveAcesso=).

   Lições da tarde de 06/09 embutidas de propósito:
   - veredito NUNCA é categórico sobre varredura incompleta: qualquer chave não
     verificada (erro/limite) ⇒ INDETERMINADO, dizendo quantas olhou;
   - falha de consulta ≠ nota ausente: vira `verificada:false` com o erro, nunca
     conta como "fora do Bling";
   - só leitura: nada é marcado, nada é buscado na Shopee, nada muda de estado.

   Interpretação dos dois desfechos completos:
   - todas as pendentes JÁ estão no Bling  → o Bling deduplicou; o furo é só a
     contabilidade da extensão (duplicada contada como falha ⇒ nunca marca ⇒
     re-tenta pra sempre). Conserto vai na toolbox, em PR próprio.
   - alguma pendente NÃO está no Bling     → falha real de importação, com chave,
     série e número na mão pra caçar (inclui conferir se as vendas sem margem do
     dashboard estão entre elas).
   ════════════════════════════════════════════════════════════════════════════════ */

const fbsNf = require('./fbs-nf');

/* Campos embutidos na chave de acesso (layout NF-e):
   cUF 0-2 · AAMM 2-6 · CNPJ 6-20 · mod 20-22 · série 22-25 · nNF 25-34 · ... */
function decodificarChave(chave) {
  const c = String(chave || '');
  if (!/^\d{44}$/.test(c)) return { serie: null, numero: null };
  return {
    serie: String(Number(c.slice(22, 25))),
    numero: String(Number(c.slice(25, 34))),
  };
}

/* O que o servidor considera pendente HOJE para a loja: chaves do ZIP -atual do
   tipo pedido, menos as já marcadas em _importado-<loja>.json. É EXATAMENTE o
   conjunto que a extensão re-envia a cada abertura do Bling. */
function listarPendentes(loja, tipo) {
  const st = fbsNf.estadoAtual(loja);
  const arquivo = tipo === 'entrada' ? st.arquivo_entrada : st.arquivo_saida;
  if (!arquivo) return { arquivo: null, total_no_zip: 0, ja_marcadas: 0, pendentes: [], quando_marcou: null };
  const chaves = fbsNf.chavesDoZip(arquivo).filter(Boolean);
  const imp = fbsNf.lerImportadas(loja.key);
  const ja = new Set(imp[tipo] || []);
  return {
    arquivo,
    total_no_zip: chaves.length,
    ja_marcadas: chaves.filter(c => ja.has(c)).length,
    pendentes: chaves.filter(c => !ja.has(c)),
    quando_marcou: imp.quando || null,
  };
}

/* Uma chave no Bling. Devolve sempre um objeto com `verificada`; nunca lança. */
async function conferirNoBling(loja, chave, blingFetchFn, BLING_BASE) {
  const url = `${BLING_BASE}/nfe?chaveAcesso=${chave}`;
  try {
    const r = await blingFetchFn(loja, url);
    if (!r.ok) return { verificada: false, erro: 'HTTP ' + r.status };
    let corpo = null;
    try { corpo = await r.json(); } catch (e) {
      return { verificada: false, erro: 'corpo não-JSON do Bling' };
    }
    const arr = (corpo && Array.isArray(corpo.data)) ? corpo.data : [];
    const nota = arr.find(n => n && String(n.chaveAcesso || '') === chave) || null;
    if (!nota) return { verificada: true, esta_no_bling: false };
    return {
      verificada: true, esta_no_bling: true,
      id: nota.id != null ? nota.id : null,
      numero_bling: nota.numero != null ? String(nota.numero) : null,
      serie_bling: nota.serie != null ? String(nota.serie) : null,
      situacao: nota.situacao != null ? nota.situacao : null,
    };
  } catch (e) {
    return { verificada: false, erro: String(e.message || e).slice(0, 160) };
  }
}

async function raioX(loja, opts = {}) {
  const tipo = opts.tipo === 'entrada' ? 'entrada' : 'saida';
  const limite = Math.max(1, Math.min(200, Number(opts.limite) || 60));
  const listarFn = opts.listarPendentesFn || listarPendentes;
  const blingApi = opts.blingFetchFn ? null : require('./bling-api');
  const blingFetchFn = opts.blingFetchFn || blingApi.blingFetch;
  const BLING_BASE = opts.BLING_BASE || (blingApi && blingApi.BLING_BASE) || 'https://api.bling.com.br/Api/v3';

  const p = listarFn(loja, tipo);
  if (!p.arquivo) {
    return { ok: true, loja: loja.key, tipo, veredito: 'SEM_ZIP', detalhe: 'nenhum arquivo baixado ainda — rode /fbs/rodar ou espere o cron', varredura_completa: true, linhas: [] };
  }

  const olhar = p.pendentes.slice(0, limite);
  const cortadas = p.pendentes.length - olhar.length;

  const linhas = [];
  let noBling = 0, fora = 0, comErro = 0;
  for (const chave of olhar) {
    const dec = decodificarChave(chave);
    const r = await conferirNoBling(loja, chave, blingFetchFn, BLING_BASE);
    if (!r.verificada) comErro++;
    else if (r.esta_no_bling) noBling++;
    else fora++;
    linhas.push(Object.assign({ chave, serie: dec.serie, numero: dec.numero }, r));
  }

  const varreduraCompleta = cortadas === 0 && comErro === 0;
  let veredito, detalhe;
  if (!varreduraCompleta) {
    veredito = 'INDETERMINADO';
    detalhe = 'verifiquei ' + (noBling + fora) + ' de ' + p.pendentes.length + ' pendentes'
      + (comErro ? ' (' + comErro + ' consultas falharam)' : '')
      + (cortadas ? ' (' + cortadas + ' além do limite=' + limite + ')' : '')
      + ' — sem veredito sobre varredura incompleta; rode de novo'
      + (cortadas ? ' com &limite=' + p.pendentes.length : '');
  } else if (fora === 0) {
    veredito = 'TODAS_AS_PENDENTES_JA_ESTAO_NO_BLING';
    detalhe = 'as ' + noBling + ' notas que a extensão re-tenta JÁ existem no Bling — o Bling deduplicou; '
      + 'o furo é a contabilidade da extensão (duplicada contada como não-importada nunca é marcada). '
      + 'Conserto vai na toolbox (ct-nf.js), não aqui.';
  } else {
    veredito = 'HA_NOTAS_REALMENTE_FORA_DO_BLING';
    detalhe = fora + ' de ' + (noBling + fora) + ' pendentes NÃO estão no Bling — falha real de importação; '
      + 'as linhas com esta_no_bling=false trazem chave, série e número pra caçar.';
  }

  return {
    ok: true,
    loja: loja.key,
    tipo,
    arquivo: p.arquivo,
    total_no_zip: p.total_no_zip,
    ja_marcadas: p.ja_marcadas,
    marcadas_em: p.quando_marcou,
    pendentes: p.pendentes.length,
    verificadas: noBling + fora,
    ja_estao_no_bling: noBling,
    fora_do_bling: fora,
    consultas_com_erro: comErro,
    varredura_completa: varreduraCompleta,
    veredito,
    detalhe,
    linhas,
  };
}

module.exports = { raioX, listarPendentes, conferirNoBling, decodificarChave };
