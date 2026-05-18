// server.js
// Shopee NF Sync - AMBTotal
// Detecta pedidos Shopee sem NF e sincroniza com NF autorizada no Bling

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const tokenManager = require('./modules/token-manager');
const shopee = require('./modules/shopee-api');
const bling = require('./modules/bling-api');
const engine = require('./modules/sync-engine');
const log = require('./modules/supabase-log');

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const SHOPEE_BASE = process.env.SHOPEE_BASE_URL || 'https://partner.shopeemobile.com';

// =============================================================================
// ROTAS INFORMATIVAS
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'shopee-nf-sync',
    loja: 'AMBTotal',
    version: '1.0.0',
    status: 'rodando',
    shopee_base_url: SHOPEE_BASE,
    timezone: process.env.TZ || 'America/Sao_Paulo',
    endpoints: {
      health: 'GET /health',
      status_tokens: 'GET /status',
      setup_bling: 'POST /setup-bling  body:{code}',
      setup_shopee: 'POST /setup-shopee  body:{code, shop_id}',
      oauth_callback_shopee: 'GET /oauth/callback-shopee?code=...&shop_id=...',
      pendentes: 'GET /pendentes',
      sincronizar_um: 'POST /sincronizar/:orderSn',
      sincronizar_ciclo: 'POST /sincronizar-ciclo  body:{dryRun?}',
      logs: 'GET /logs?limit=50'
    }
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/status', async (req, res) => {
  try {
    const blingTokens = tokenManager.loadTokens();
    const shopeeTokens = shopee.loadShopeeTokens();
    res.json({
      shopee_base_url: SHOPEE_BASE,
      bling: {
        tem_access_token: !!blingTokens.access_token,
        tem_refresh_token: !!blingTokens.refresh_token,
        expira_em: blingTokens.expires_at ? new Date(blingTokens.expires_at).toISOString() : null,
        expirou: blingTokens.expires_at < Date.now()
      },
      shopee: {
        tem_access_token: !!shopeeTokens.access_token,
        tem_refresh_token: !!shopeeTokens.refresh_token,
        shop_id: shopeeTokens.shop_id || null,
        expira_em: shopeeTokens.expires_at ? new Date(shopeeTokens.expires_at).toISOString() : null,
        expirou: shopeeTokens.expires_at < Date.now()
      }
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// --- Setup OAuth ---

app.post('/setup-bling', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ erro: 'code obrigatorio no body' });
    const tokens = await tokenManager.setupBlingWithCode(code);
    res.json({
      ok: true,
      message: 'Tokens Bling salvos',
      expira_em: new Date(tokens.expires_at).toISOString()
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

async function exchangeShopeeCode(code, shopId) {
  const crypto = require('crypto');
  const fetch = require('node-fetch');
  const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;
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
  shopee.saveShopeeTokens(tokens);
  return tokens;
}

app.post('/setup-shopee', async (req, res) => {
  try {
    const { code, shop_id } = req.body;
    if (!code || !shop_id) return res.status(400).json({ erro: 'code e shop_id obrigatorios' });
    const tokens = await exchangeShopeeCode(code, shop_id);
    res.json({ ok: true, shop_id, expira_em: new Date(tokens.expires_at).toISOString() });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Callback OAuth Shopee - troca code por tokens automaticamente
app.get('/oauth/callback-shopee', async (req, res) => {
  try {
    const { code, shop_id } = req.query;
    if (!code || !shop_id) {
      return res.status(400).send('<h2>Erro</h2><p>code e shop_id obrigatorios na URL</p>');
    }
    const tokens = await exchangeShopeeCode(code, shop_id);
    res.send(`
      <h2>✅ Shopee autorizada com sucesso!</h2>
      <p><b>Shop ID:</b> ${shop_id}</p>
      <p><b>Token expira em:</b> ${new Date(tokens.expires_at).toISOString()}</p>
      <p>Voce pode fechar esta janela.</p>
    `);
  } catch (e) {
    res.status(500).send(`<h2>Erro na autorizacao</h2><pre>${e.message}</pre>`);
  }
});

// --- Operacao ---

app.get('/pendentes', async (req, res) => {
  try {
    const resultado = await engine.ciclo({ dryRun: true });
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/sincronizar/:orderSn', async (req, res) => {
  try {
    const { orderSn } = req.params;
    const r = await engine.sincronizarPedido(orderSn);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/sincronizar-ciclo', async (req, res) => {
  try {
    const dryRun = req.body?.dryRun === true;
    const r = await engine.ciclo({ dryRun });
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
  console.log('[cron] Disparando ciclo automatico');
  try {
    await engine.ciclo({ dryRun: false });
  } catch (e) {
    console.error('[cron] Erro no ciclo:', e.message);
  }
}, { timezone: 'America/Sao_Paulo' });

console.log(`[cron] Agendado: ${CRON_EXPR} (America/Sao_Paulo)`);

app.listen(PORT, () => {
  console.log(`[server] Rodando na porta ${PORT}`);
  console.log(`[server] SHOPEE_BASE_URL: ${SHOPEE_BASE}`);
});
