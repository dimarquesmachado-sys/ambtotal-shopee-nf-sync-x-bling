// modules/supabase-log.js
// Registro de cada tentativa de sincronizacao
// Tabela esperada no Supabase: shopee_nf_sync (criar SQL no README)

const { createClient } = require('@supabase/supabase-js');

let supabase = null;

function getClient() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('[supabase-log] SUPABASE_URL ou SUPABASE_SERVICE_KEY ausentes; log desativado');
    return null;
  }
  supabase = createClient(url, key);
  return supabase;
}

/**
 * Loga uma tentativa de sync.
 * status: 'pendente' | 'sucesso' | 'erro' | 'ja_enviado' | 'sem_nf_bling'
 */
async function logSync({ order_sn, pedido_bling_id, nfe_id, chave_acesso, status, erro, etapa }) {
  const client = getClient();
  if (!client) return;

  try {
    const { error } = await client.from('shopee_nf_sync').insert({
      loja: 'AMBTotal',
      order_sn,
      pedido_bling_id,
      nfe_id,
      chave_acesso,
      status,
      etapa,        // 'upload_invoice' | 'ship_order' | 'detect'
      erro,
      criado_em: new Date().toISOString()
    });
    if (error) console.warn('[supabase-log] insert err:', error.message);
  } catch (e) {
    console.warn('[supabase-log] exception:', e.message);
  }
}

/**
 * Verifica se um order_sn ja foi sincronizado com sucesso nas ultimas N horas
 * (evita reprocessamento desnecessario)
 */
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

/**
 * Busca ultimas N execucoes pra mostrar no endpoint /logs
 */
async function ultimasExecucoes(limit = 50) {
  const client = getClient();
  if (!client) return [];

  const { data, error } = await client
    .from('shopee_nf_sync')
    .select('*')
    .eq('loja', 'AMBTotal')
    .order('criado_em', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[supabase-log] ultimasExecucoes err:', error.message);
    return [];
  }

  return data || [];
}

module.exports = { logSync, jaSincronizado, ultimasExecucoes };
