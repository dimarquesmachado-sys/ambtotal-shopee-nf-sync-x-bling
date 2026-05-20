// server.js
// Shopee NF Sync - Multi-loja (AMBTotal, Girassol, GOOD Import)
// Detecta pedidos Shopee em INVOICE_PENDING e sobe a NF-e autorizada do Bling.

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const crypto = require('crypto');
const fetch = require('node-fetch');

const tokenManager = require('./modules/token-manager');
const shopee = require('./modules/shopee-api');
const engine = require('./modules/sync-engine');
const log = require('./modules/supabase-log');
const { getConfigLoja, lojasValidas, lojasConfiguradas, SHOPEE_BASE } = require('./modules/lojas');

const app = express();
app.use(express.json({ limit: '5mb' }));
const PORT = process.env.PORT || 3000;

// Middleware: resolve :loja em req.loja (valida contra lojas conhecidas)
function resolverLoja(req, res, next) {
  const key = req.params.loja;
  if (!lojasValidas().includes(key)) {
    return res.status(404).json({ erro: `Loja desconhecida: ${key}. Validas: ${lojasValidas().join(', ')}` });
  }
  req.loja = getConfigLoja(key);
  next();
}

// =============================================================================
// ROTAS INFORMATIVAS
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'shopee-nf-sync',
    version: '2.0.0-multiloja',
    status: 'rodando',
    shopee_base_url: SHOPEE_BASE,
    timezone: process.env.TZ || 'America/Sao_Paulo',
    lojas_configuradas: lojasConfiguradas().map(l => l.key),
    lojas_disponiveis: lojasValidas(),
    endpoints: {
      status: 'GET /status',
      pendentes: 'GET /pendentes',
      setup_bling: 'POST /:loja/setup-bling  body:{code}',
      callback_shopee: 'GET /:loja/oauth/callback-shopee?code=...&shop_id=...',
      sincronizar_um: 'POST /:loja/sincronizar/:orderSn',
      sincronizar_ciclo: 'POST /sincronizar-ciclo  body:{dryRun?}',
      logs: 'GET /logs?limit=50'
    }
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Status agregado de todas as lojas
app.get('/status', async (req, res) => {
  try {
    const out = { shopee_base_url: SHOPEE_BASE, lojas: {} };
    for (const key of lojasValidas()) {
      const loja = getConfigLoja(key);
      const configurada = !!(loja.bling.clientId && loja.shopee.partnerId);
      let bling = { configurada }, shp = { configurada };
      if (configurada) {
        const bt = tokenManager.loadTokens(loja);
        const st = shopee.loadShopeeTokens(loja);
        bling = {
          configurada: true,
          tem_access_token: !!bt.access_token,
          tem_refresh_token: !!bt.refresh_token,
          expira_em: bt.expires_at ? new Date(bt.expires_at).toISOString() : null,
          expirou: bt.expires_at < Date.now()
        };
        shp = {
          configurada: true,
          tem_access_token: !!st.access_token,
          tem_refresh_token: !!st.refresh_token,
          shop_id: st.shop_id || null,
          expira_em: st.expires_at ? new Date(st.expires_at).toISOString() : null,
          expirou: st.expires_at < Date.now()
        };
      }
      out.lojas[key] = { nome: loja.nome, bling, shopee: shp };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// =============================================================================
// SETUP / OAUTH (por loja)
// =============================================================================

app.post('/:loja/setup-bling', resolverLoja, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ erro: 'code obrigatorio no body' });
    const tokens = await tokenManager.setupBlingWithCode(req.loja, code);
    res.json({ ok: true, loja: req.loja.key, message: 'Tokens Bling salvos', expira_em: new Date(tokens.expires_at).toISOString() });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

async function exchangeShopeeCode(loja, code, shopId) {
  const partnerId = parseInt(loja.shopee.partnerId);
  const partnerKey = loja.shopee.partnerKey;
  const apiPath = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHmac('sha256', partnerKey)
    .update(`${partnerId}${apiPath}${timestamp}`).digest('hex');

  const url = `${SHOPEE_BASE}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, shop_id: parseInt(shopId), partner_id: partnerId })
  });
  const data = await r.json();
  if (data.error) throw new Error(JSON.stringify(data));

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    shop_id: String(shopId),
    expires_at: Date.now() + (data.expire_in * 1000) - 60000
  };
  shopee.saveShopeeTokens(loja, tokens);
  return tokens;
}

app.post('/:loja/setup-shopee', resolverLoja, async (req, res) => {
  try {
    const { code, shop_id } = req.body;
    if (!code || !shop_id) return res.status(400).json({ erro: 'code e shop_id obrigatorios' });
    const tokens = await exchangeShopeeCode(req.loja, code, shop_id);
    res.json({ ok: true, loja: req.loja.key, shop_id, expira_em: new Date(tokens.expires_at).toISOString() });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/:loja/oauth/callback-shopee', resolverLoja, async (req, res) => {
  try {
    const { code, shop_id } = req.query;
    if (!code || !shop_id) {
      return res.status(400).send('<h2>Erro</h2><p>code e shop_id obrigatorios na URL</p>');
    }
    const tokens = await exchangeShopeeCode(req.loja, code, shop_id);
    res.send(`
      <h2>✅ Shopee autorizada com sucesso! (${req.loja.nome})</h2>
      <p><b>Loja:</b> ${req.loja.key}</p>
      <p><b>Shop ID:</b> ${shop_id}</p>
      <p><b>Token expira em:</b> ${new Date(tokens.expires_at).toISOString()}</p>
      <p>Voce pode fechar esta janela.</p>
    `);
  } catch (e) {
    res.status(500).send(`<h2>Erro na autorizacao</h2><pre>${e.message}</pre>`);
  }
});

// =============================================================================
// OPERACAO
// =============================================================================

// Pendentes de todas as lojas (dry run)
app.get('/pendentes', async (req, res) => {
  try {
    const r = await engine.cicloTodasLojas({ dryRun: true });
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Sincroniza um pedido especifico de uma loja
app.post('/:loja/sincronizar/:orderSn', resolverLoja, async (req, res) => {
  try {
    const r = await engine.sincronizarPedido(req.loja.key, req.params.orderSn);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Roda ciclo completo de todas as lojas
app.post('/sincronizar-ciclo', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const r = await engine.cicloTodasLojas({ dryRun });
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const r = await log.ultimasExecucoes(limit);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// =============================================================================
// CRON
// =============================================================================

const CRON_EXPR = '*/10 6-22 * * *';
cron.schedule(CRON_EXPR, async () => {
  console.log('[cron] Disparando ciclo de todas as lojas');
  try {
    await engine.cicloTodasLojas({ dryRun: false });
  } catch (e) {
    console.error('[cron] Erro no ciclo:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });
console.log(`[cron] Agendado: ${CRON_EXPR} (America/Sao_Paulo)`);

app.listen(PORT, () => {
  console.log(`[server] shopee-nf-sync multi-loja rodando na porta ${PORT}`);
  console.log(`[server] SHOPEE_SYNC_BASE_URL: ${SHOPEE_BASE}`);
  console.log(`[server] Lojas configuradas: ${lojasConfiguradas().map(l => l.key).join(', ') || 'NENHUMA'}`);
});
