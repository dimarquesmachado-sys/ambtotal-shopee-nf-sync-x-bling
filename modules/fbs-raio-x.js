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

   Interpretação dos dois desfechos completos (SÓ o que o dado sustenta):
   - todas as pendentes JÁ estão no Bling  → nada falta importar; sobre o PORQUÊ
     de seguirem pendentes há duas leituras (dupla contagem na extensão OU
     importação por fora sem marcar) e este raio-x não separa as duas sozinho.
   - alguma pendente NÃO está no Bling     → está faltando mesmo; se por falha
     de importação ou por ainda não ter sido tentada (ZIP recém-gerado), a idade
     do arquivo × marcadas_em ajuda a ler.
   ════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
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
  if (!arquivo) return { arquivo: null, arquivo_gerado_em: null, total_no_zip: 0, ja_marcadas: 0, pendentes: [], quando_marcou: null };
  const chaves = fbsNf.chavesDoZip(arquivo).filter(Boolean);
  const imp = fbsNf.lerImportadas(loja.key);
  const ja = new Set(imp[tipo] || []);
  let geradoEm = null;
  try { geradoEm = fs.statSync(path.join(fbsNf.NF_DIR, arquivo)).mtime.toISOString(); } catch (e) {}
  return {
    arquivo,
    arquivo_gerado_em: geradoEm,
    total_no_zip: chaves.length,
    ja_marcadas: chaves.filter(c => ja.has(c)).length,
    pendentes: chaves.filter(c => !ja.has(c)),
    quando_marcou: imp.quando || null,
  };
}

/* Uma chave no Bling. Devolve sempre um objeto com `verificada`; nunca lança.
   Codex #7 (P1): a LISTA do /nfe é representação resumida e pode vir SEM
   chaveAcesso — comparar contra ela classificaria nota existente como ausente.
   Então: o filtro só APONTA candidatos; a confirmação é sempre pelo DETALHE
   (/nfe/{id}), que traz a chave. E se o detalhe do candidato trouxer OUTRA
   chave, o filtro foi ignorado pelo Bling (a armadilha do ?numeroLoja de
   06/09) — isso vira `verificada:false`, nunca "ausente".
   Codex #7 (P2): cada chamada tem teto de 20s — lookup pendurado vira erro,
   não trava o raio-x inteiro. */
const TIMEOUT_MS = 20000;
function _opTimeout() {
  const opts = { timeout: TIMEOUT_MS };
  try { if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(TIMEOUT_MS); } catch (e) {}
  return opts;
}
async function conferirNoBling(loja, chave, blingFetchFn, BLING_BASE) {
  try {
    const r = await blingFetchFn(loja, `${BLING_BASE}/nfe?chaveAcesso=${chave}`, _opTimeout());
    if (!r.ok) return { verificada: false, erro: 'HTTP ' + r.status };
    let corpo = null;
    try { corpo = await r.json(); } catch (e) {
      return { verificada: false, erro: 'corpo não-JSON do Bling (lista)' };
    }
    const arr = (corpo && Array.isArray(corpo.data)) ? corpo.data : [];
    if (!arr.length) return { verificada: true, esta_no_bling: false };

    // confirma pelo DETALHE — no máximo 3 candidatos (o filtro por chave deveria devolver 1)
    for (const cand of arr.slice(0, 3)) {
      if (!cand || cand.id == null) continue;
      const rd = await blingFetchFn(loja, `${BLING_BASE}/nfe/${cand.id}`, _opTimeout());
      if (!rd.ok) return { verificada: false, erro: 'detalhe ' + cand.id + ' HTTP ' + rd.status };
      let det = null;
      try { const j = await rd.json(); det = j && j.data; } catch (e) {
        return { verificada: false, erro: 'corpo não-JSON do Bling (detalhe)' };
      }
      if (det && String(det.chaveAcesso || '') === chave) {
        return {
          verificada: true, esta_no_bling: true,
          id: det.id != null ? det.id : cand.id,
          numero_bling: det.numero != null ? String(det.numero) : null,
          serie_bling: det.serie != null ? String(det.serie) : null,
          situacao: det.situacao != null ? det.situacao : null,
        };
      }
    }
    return { verificada: false, erro: 'filtro chaveAcesso ignorado pelo Bling (candidato com outra chave) — sem como verificar por aqui' };
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

  const tudo = opts.tudo === true || opts.tudo === 1 || opts.tudo === '1';
  const pular = tudo ? 0 : Math.max(0, Number(opts.pular) || 0);

  const p = listarFn(loja, tipo);
  if (!p.arquivo) {
    return { ok: true, loja: loja.key, tipo, veredito: 'SEM_ZIP', detalhe: 'nenhum arquivo baixado ainda — rode /fbs/rodar ou espere o cron', varredura_completa: true, linhas: [] };
  }
  /* Codex #7 r2: ZIP presente mas SEM chave legível não é "tudo em dia" — o
     chavesDoZip engole falha de leitura e devolve []; sem esta guarda, um ZIP
     corrompido/truncado viraria SEM_PENDENTES afirmando o que ninguém leu. */
  if (!p.total_no_zip) {
    return { ok: true, loja: loja.key, tipo, arquivo: p.arquivo, arquivo_gerado_em: p.arquivo_gerado_em, total_no_zip: 0, veredito: 'ZIP_SEM_CHAVES_LEGIVEIS', detalhe: 'o arquivo existe mas nenhuma chave foi lida dele — ZIP corrompido, truncado ou sem XMLs; rode /fbs/rodar pra gerar outro e repita o raio-x', varredura_completa: false, linhas: [] };
  }

  /* Codex #7 (P2): tudo já marcado NÃO é evidência de nada — é o estado em dia.
     Sem pendentes não há o que a extensão re-tente, então nenhum veredito causal. */
  if (!p.pendentes.length) {
    return { ok: true, loja: loja.key, tipo, arquivo: p.arquivo, total_no_zip: p.total_no_zip, ja_marcadas: p.ja_marcadas, marcadas_em: p.quando_marcou, arquivo_gerado_em: p.arquivo_gerado_em, pendentes: 0, veredito: 'SEM_PENDENTES', detalhe: 'todas as chaves do ZIP já estão marcadas como importadas — nada a re-tentar', varredura_completa: true, linhas: [] };
  }

  /* Codex #7 r2: fatia (&pular=) serve pra OLHAR linhas; quem FECHA veredito é
     &tudo=1, que varre todas as pendentes numa tacada só (com o throttle da
     casa). Teto de sanidade de 1000 protege a cota — um ZIP do Full não chega
     perto disso; se chegar, o problema é outro e merece olho antes de gastar. */
  if (tudo && p.pendentes.length > 1000) {
    return { ok: true, loja: loja.key, tipo, arquivo: p.arquivo, arquivo_gerado_em: p.arquivo_gerado_em, total_no_zip: p.total_no_zip, ja_marcadas: p.ja_marcadas, marcadas_em: p.quando_marcou, pendentes: p.pendentes.length, veredito: 'INDETERMINADO', detalhe: 'tudo=1 recusado: ' + p.pendentes.length + ' pendentes passam do teto de sanidade (1000) — antes de gastar cota, vale entender por que o ZIP está desse tamanho', varredura_completa: false, linhas: [] };
  }
  const olhar = tudo ? p.pendentes.slice(0) : p.pendentes.slice(pular, pular + limite);
  const cortadas = p.pendentes.length - pular - olhar.length;

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

  const varreduraCompleta = cortadas <= 0 && pular === 0 && comErro === 0;
  let veredito, detalhe, leiturasPossiveis;
  if (!varreduraCompleta) {
    veredito = 'INDETERMINADO';
    detalhe = 'verifiquei ' + (noBling + fora) + ' de ' + p.pendentes.length + ' pendentes'
      + (comErro ? ' (' + comErro + ' consultas falharam)' : '')
      + (cortadas ? ' (' + cortadas + ' além do limite=' + limite + ')' : '')
      + ' — sem veredito sobre varredura incompleta; rode de novo'
      + (cortadas > 0 ? '. Pra fechar veredito numa tacada: &tudo=1 (' + p.pendentes.length + ' consultas ao Bling). Pra só OLHAR a próxima fatia: &pular=' + (pular + olhar.length) + '&limite=' + limite : '');
  } else if (fora === 0) {
    veredito = 'TODAS_AS_PENDENTES_JA_ESTAO_NO_BLING';
    detalhe = 'as ' + noBling + ' notas que este servidor considera pendentes JÁ existem no Bling — nada falta importar. '
      + 'Por que seguem pendentes, o dado daqui não separa: pode ser a extensão contando duplicada como falha '
      + '(e por isso nunca marcando), ou importação feita por fora (painel/manual) sem marcar. '
      + 'O corpo da resposta do Bling na próxima abertura separa as duas; nas duas, marcar estas chaves (/fbs/confirmar) encerra o re-envio.';
    leiturasPossiveis = ['extensao_contou_duplicada_como_falha_e_nao_marcou', 'importacao_por_fora_sem_marcar_no_servidor'];
  } else {
    veredito = 'HA_NOTAS_REALMENTE_FORA_DO_BLING';
    detalhe = fora + ' de ' + (noBling + fora) + ' pendentes NÃO estão no Bling — importação que FALHOU ou que AINDA NÃO FOI TENTADA '
      + '(o _importado só marca sucesso confirmado; ZIP recém-gerado pelo cron fica assim até alguém abrir o Bling). '
      + 'Compare arquivo_gerado_em com marcadas_em pra ler o caso; as linhas com esta_no_bling=false trazem chave, série e número.';
  }

  return {
    ok: true,
    loja: loja.key,
    tipo,
    arquivo: p.arquivo,
    arquivo_gerado_em: p.arquivo_gerado_em,
    total_no_zip: p.total_no_zip,
    ja_marcadas: p.ja_marcadas,
    marcadas_em: p.quando_marcou,
    pendentes: p.pendentes.length,
    tudo: tudo || undefined,
    pulei: pular || undefined,
    leituras_possiveis: leiturasPossiveis,
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
