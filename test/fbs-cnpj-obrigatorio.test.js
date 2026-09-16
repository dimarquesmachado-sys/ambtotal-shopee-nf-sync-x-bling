'use strict';
// ⚠️ A SHOPEE VAI EXIGIR CNPJ EM 30/10/2026.
//
// [stated 16/09] e-mail da Shopee Open Platform: a
// `v2.order.generate_fbs_invoices` passa a EXIGIR o parâmetro CNPJ, de uma
// filial registrada, **um por request**.
//
// ⚠️ Sem ele, a partir daquela data o pedido FALHA e os XMLs do Shopee Full
// param de entrar no Bling — sem erro visível para o galpão, só as notas
// sumindo e o estoque do Full sem lançamento.
//
// 📌 O dono confirmou (16/09): **não há filial** — mesmo no Full é o CNPJ da
// matriz. Se um dia houver, cada filial vira um request próprio.

const fs = require('fs');
const path = require('path');

let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const RAIZ = path.join(__dirname, '..');

// ── o CNPJ vem de env, não cravado no código ────────────────────────
{
  const lojas = fs.readFileSync(path.join(RAIZ, 'modules', 'lojas.js'), 'utf8');
  ok(/base\.prefixo \+ '_FBS_CNPJ'/.test(lojas),
     'o CNPJ vem de `<PREFIXO>_FBS_CNPJ` (empresa nova entra so com config)');
  ok(!/64289091000100/.test(lojas),
     '⚠️ e NAO esta cravado no codigo');

  // normaliza e valida
  delete require.cache[require.resolve(path.join(RAIZ, 'modules', 'lojas.js'))];
  process.env.AMB_SYNC_FBS_CNPJ = '64.289.091/0001-00';
  const { getConfigLoja } = require(path.join(RAIZ, 'modules', 'lojas.js'));
  ok(getConfigLoja('amb').fbsCnpj === '64289091000100',
     '  aceita com pontuacao e guarda so digitos');

  delete require.cache[require.resolve(path.join(RAIZ, 'modules', 'lojas.js'))];
  process.env.AMB_SYNC_FBS_CNPJ = '123';
  const { getConfigLoja: g2 } = require(path.join(RAIZ, 'modules', 'lojas.js'));
  ok(g2('amb').fbsCnpj === null,
     '  ⚠️ e recusa valor invalido (melhor null e aviso que CNPJ torto)');
}

// ── ⚠️ e ele SAI no corpo do request ────────────────────────────────
//
// Este é o ponto: ler a env não basta — o que importa é o que chega na
// Shopee. Intercepto a chamada e confiro o corpo real.
{
  const shopee = require(path.join(RAIZ, 'modules', 'shopee-api.js'));
  const original = shopee.shopeeApiCall;
  let capturado = null;
  shopee.shopeeApiCall = async (loja, p, m, body) => {
    if (!capturado) capturado = { path: p, body };
    return { ok: true, data: { result_list: [] } };
  };

  delete require.cache[require.resolve(path.join(RAIZ, 'modules', 'lojas.js'))];
  process.env.AMB_SYNC_FBS_CNPJ = '64289091000100';
  const { getConfigLoja } = require(path.join(RAIZ, 'modules', 'lojas.js'));
  const fbs = require(path.join(RAIZ, 'modules', 'fbs-nf.js'));

  return fbs.rotina(getConfigLoja('amb'), { forcar: true })
    .catch(() => {})
    .then(() => {
      shopee.shopeeApiCall = original;
      ok(!!capturado, 'a rotina chega a chamar a Shopee');
      if (capturado) {
        ok(/generate_fbs_invoices/.test(capturado.path),
           '  na rota que vai exigir o CNPJ');
        ok(capturado.body.batch_download.cnpj === '64289091000100',
           '⚠️ e o CNPJ VAI NO CORPO (nao so lido da env)');

        // os campos que já existiam continuam
        const b = capturado.body.batch_download;
        ok(b.document_type === 4 && b.file_type === 1 && b.document_status === 1,
           '  e os campos antigos continuam (tipo 4=venda segue valido)');
      }
      console.log('');
      console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
      process.exit(falhas ? 1 : 0);
    });
}
