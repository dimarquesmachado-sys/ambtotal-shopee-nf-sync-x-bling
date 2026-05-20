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

async function logSync({ order_sn, loja, pedido_bling_id, nfe_id, chave_acesso, status, erro, etapa }) {
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

module.exports = { logSync, jaSincronizado, ultimasExecucoes };
