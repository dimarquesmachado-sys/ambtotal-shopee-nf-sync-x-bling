// modules/supabase-log.js
// Registro de cada tentativa de sync, por loja.
// Funciona sem Supabase configurado (apenas pula o log).

const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function getClient() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return null;
  }
  supabase = createClient(url, key);
  return supabase;
}

/* 11/09 — LOG EM DISCO, porque o do Supabase está mudo: as envs SUPABASE_URL e
   SUPABASE_SERVICE_KEY nunca foram preenchidas neste serviço, então getClient()
   devolvia null, logSync não gravava nada e /logs respondia [] — foi o que me deixou
   cego na caça dos 2 pedidos "Retirada pelo Comprador" (10/09): sem registro, não dava
   pra saber o que a Shopee tinha recusado. Agora todo evento cai também num arquivo
   local (anel de 400 linhas, em /data quando existe disco). Não substitui o Supabase
   — se as envs forem preenchidas, os dois passam a valer. */
const _fsL = require('fs');
const _pathL = require('path');
const LOG_ARQ = (() => {
  try { return _fsL.existsSync('/data') ? '/data/shopee-sync-log.json' : _pathL.join(__dirname, '..', 'shopee-sync-log.json'); }
  catch (e) { return _pathL.join(__dirname, '..', 'shopee-sync-log.json'); }
})();
const LOG_TETO = 400;
function logEmDisco(reg) {
  try {
    let arr = [];
    try { arr = JSON.parse(_fsL.readFileSync(LOG_ARQ, 'utf8')); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.unshift(Object.assign({ criado_em: new Date().toISOString() }, reg));
    if (arr.length > LOG_TETO) arr = arr.slice(0, LOG_TETO);
    _fsL.writeFileSync(LOG_ARQ + '.tmp', JSON.stringify(arr));
    _fsL.renameSync(LOG_ARQ + '.tmp', LOG_ARQ);
  } catch (e) { /* melhor-esforço: log nunca derruba o fluxo */ }
}
function lerLogDoDisco(limit) {
  try {
    const arr = JSON.parse(_fsL.readFileSync(LOG_ARQ, 'utf8'));
    return Array.isArray(arr) ? arr.slice(0, limit || 50) : [];
  } catch (e) { return []; }
}

async function logSync({ order_sn, loja, pedido_bling_id, nfe_id, chave_acesso, status, erro, etapa }) {
  logEmDisco({ order_sn, loja, pedido_bling_id, nfe_id, chave_acesso, status, erro, etapa });
  const client = getClient();
  if (!client) return;

  try {
    const { error } = await client.from('shopee_nf_sync').insert({
      loja: loja || 'desconhecida',
      order_sn,
      pedido_bling_id,
      nfe_id,
      chave_acesso,
      status,
      etapa,
      erro,
      criado_em: new Date().toISOString()
    });
    if (error) console.warn('[supabase-log] insert err:', error.message);
  } catch (e) {
    console.warn('[supabase-log] exception:', e.message);
  }
}

// Idempotencia: ja foi sincronizado com sucesso (ship_order) recentemente?
// Sem Supabase, retorna false (sempre processa) - seguro pois a Shopee rejeita NF duplicada.
async function jaSincronizado(orderSn, horasAtras = 6) {
  const client = getClient();
  if (!client) return false;

  const desde = new Date(Date.now() - horasAtras * 60 * 60 * 1000).toISOString();

  const { data, error } = await client
    .from('shopee_nf_sync')
    .select('id, status, etapa')
    .eq('order_sn', orderSn)
    .eq('status', 'sucesso')
    .eq('etapa', 'ship_order')
    .gte('criado_em', desde)
    .limit(1);

  if (error) {
    console.warn('[supabase-log] jaSincronizado err:', error.message);
    return false;
  }
  return (data || []).length > 0;
}

async function ultimasExecucoes(limit = 50) {
  const client = getClient();
  if (!client) return [];

  const { data, error } = await client
    .from('shopee_nf_sync')
    .select('*')
    .order('criado_em', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[supabase-log] ultimasExecucoes err:', error.message);
    return [];
  }
  return data || [];
}

module.exports = { logSync, jaSincronizado, ultimasExecucoes, lerLogDoDisco, LOG_ARQ };
