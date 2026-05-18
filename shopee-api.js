// modules/shopee-api.js
// Interface com Shopee Open Platform AMBTotal
// Auth: HMAC-SHA256 com partner_id + api_path + timestamp + access_token + shop_id

const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHOPEE_BASE = 'https://partner.shopeemobile.com'; // PRODUCAO
// Sandbox seria: 'https://partner.test-stable.shopeemobile.com'

const TOKEN_FILE = path.join(__dirname, '..', 'data', 'tokens-shopee.json');

// =============================================================================
// AUTH / TOKEN MANAGEMENT
// =============================================================================

function ensureDataDir() {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadShopeeTokens() {
  ensureDataDir();
  if (!fs.existsSync(TOKEN_FILE)) {
    const initial = {
      access_token: process.env.SHOPEE_ACCESS_TOKEN || '',
      refresh_token: process.env.SHOPEE_REFRESH_TOKEN || '',
      shop_id: process.env.SHOPEE_SHOP_ID || '',
      expires_at: 0
    };
    saveShopeeTokens(initial);
    return initial;
  }
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

function saveShopeeTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

/**
 * Gera assinatura HMAC-SHA256 padrao Shopee Open Platform v2
 * Base string formula varia por tipo de endpoint:
 *  - Shop API (com shop_id e access_token): partner_id + api_path + timestamp + access_token + shop_id
 *  - Public API (sem auth): partner_id + api_path + timestamp
 */
function generateSign(apiPath, timestamp, accessToken = null, shopId = null) {
  const partnerId = process.env.SHOPEE_PARTNER_ID;
  const partnerKey = process.env.SHOPEE_PARTNER_KEY;

  let baseString = `${partnerId}${apiPath}${timestamp}`;
  if (accessToken && shopId) {
    baseString += `${accessToken}${shopId}`;
  }

  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

/**
 * Renova access_token Shopee via refresh_token
 * Refresh tokens Shopee tem validade de ~30 dias e sao rotativos (geram novo a cada refresh)
 */
async function refreshShopeeToken() {
  const tokens = loadShopeeTokens();
  if (!tokens.refresh_token || !tokens.shop_id) {
    throw new Error('Shopee tokens ausentes. Faca OAuth inicial.');
  }

  const apiPath = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp);

  const url = `${SHOPEE_BASE}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;

  const body = {
    refresh_token: tokens.refresh_token,
    partner_id: partnerId,
    shop_id: parseInt(tokens.shop_id)
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`Shopee refresh falhou: ${JSON.stringify(data)}`);
  }

  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    shop_id: tokens.shop_id,
    expires_at: Date.now() + (data.expire_in * 1000) - 60000
  };

  saveShopeeTokens(newTokens);
  console.log('[shopee-api] Access token renovado');
  return newTokens;
}

async function getValidShopeeToken() {
  let tokens = loadShopeeTokens();
  if (!tokens.access_token || Date.now() >= tokens.expires_at) {
    tokens = await refreshShopeeToken();
  }
  return tokens;
}

// =============================================================================
// HELPER: chamada autenticada generica
// =============================================================================

async function shopeeApiCall(apiPath, method = 'GET', body = null) {
  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp, tokens.access_token, tokens.shop_id);

  const queryParams = [
    `partner_id=${partnerId}`,
    `timestamp=${timestamp}`,
    `access_token=${tokens.access_token}`,
    `shop_id=${tokens.shop_id}`,
    `sign=${sign}`
  ].join('&');

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;

  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const data = await response.json();

  return { ok: response.ok && !data.error, data };
}

// =============================================================================
// ORDER LISTING
// =============================================================================

/**
 * Lista pedidos com status to_ship dos ultimos N dias
 * Endpoint: /api/v2/order/get_order_list
 */
async function listarPedidosToShip(diasAtras = 3) {
  const agora = Math.floor(Date.now() / 1000);
  const inicio = agora - (diasAtras * 24 * 60 * 60);

  const apiPath = `/api/v2/order/get_order_list`;
  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp, tokens.access_token, tokens.shop_id);

  // GET com query params especificos do endpoint
  const queryParams = [
    `partner_id=${partnerId}`,
    `timestamp=${timestamp}`,
    `access_token=${tokens.access_token}`,
    `shop_id=${tokens.shop_id}`,
    `sign=${sign}`,
    `time_range_field=create_time`,
    `time_from=${inicio}`,
    `time_to=${agora}`,
    `page_size=100`,
    `order_status=READY_TO_SHIP`
  ].join('&');

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    throw new Error(`Shopee get_order_list erro: ${JSON.stringify(data)}`);
  }

  return data.response?.order_list || [];
}

/**
 * Busca detalhes completos de pedidos (lote de ate 50)
 * Inclui campos de invoice/NF
 * Endpoint: /api/v2/order/get_order_detail
 */
async function buscarDetalhesPedidos(orderSnList) {
  if (orderSnList.length === 0) return [];
  if (orderSnList.length > 50) orderSnList = orderSnList.slice(0, 50);

  const apiPath = `/api/v2/order/get_order_detail`;
  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp, tokens.access_token, tokens.shop_id);

  // Campos extras pedidos: invoice_data ja vem por default na maioria dos casos
  const queryParams = [
    `partner_id=${partnerId}`,
    `timestamp=${timestamp}`,
    `access_token=${tokens.access_token}`,
    `shop_id=${tokens.shop_id}`,
    `sign=${sign}`,
    `order_sn_list=${orderSnList.join(',')}`,
    `response_optional_fields=invoice_data,item_list,shipping_carrier,recipient_address`
  ].join('&');

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    throw new Error(`Shopee get_order_detail erro: ${JSON.stringify(data)}`);
  }

  return data.response?.order_list || [];
}

// =============================================================================
// UPLOAD INVOICE (NF-e)
// =============================================================================

/**
 * Envia XML da NF-e pra Shopee
 *
 * ====================================================================
 * TODO_DOC: CONFIRMAR ESTE ENDPOINT NA DOC OFICIAL SHOPEE
 * ====================================================================
 * Pelo padrao da Shopee BR e pelo botao "Upload de NF-e em Massa" visivel
 * no Seller Center, o endpoint mais provavel eh:
 *
 *   POST /api/v2/order/upload_invoice_document
 *
 * Payload provavel (precisa confirmar):
 *   {
 *     "order_sn": "260516GU8E75MH",
 *     "file_name": "NFe35260512345.xml",
 *     "file": "<base64 do XML>"
 *   }
 *
 * OU pode ser:
 *   POST /api/v2/invoice/upload_invoice_link  (Brasil-especifico)
 *   { "order_sn", "invoice_link", "access_key" }
 *
 * Diego: acesse https://open.shopee.com e busque "invoice" na API Reference
 * do app AMBTotal pra confirmar.
 * ====================================================================
 */
async function uploadInvoice(orderSn, xmlBase64, chaveAcesso, numeroNf) {
  // ENDPOINT PROVISORIO - aguardando confirmacao da doc
  const apiPath = `/api/v2/order/upload_invoice_document`;

  const body = {
    order_sn: orderSn,
    file_name: `NFe${chaveAcesso || numeroNf}.xml`,
    file: xmlBase64
  };

  const { ok, data } = await shopeeApiCall(apiPath, 'POST', body);

  if (!ok) {
    throw new Error(`Shopee uploadInvoice erro: ${JSON.stringify(data)}`);
  }

  return data;
}

// =============================================================================
// SHIP ORDER (Organizar Envio)
// =============================================================================

/**
 * Dispara "Organizar Envio" na Shopee
 * Endpoint: /api/v2/logistics/ship_order
 *
 * Precisa primeiro consultar /api/v2/logistics/get_shipping_parameter
 * pra saber se eh dropoff, pickup ou nada (depende do canal)
 */
async function getShippingParameter(orderSn) {
  const apiPath = `/api/v2/logistics/get_shipping_parameter`;
  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp, tokens.access_token, tokens.shop_id);

  const queryParams = [
    `partner_id=${partnerId}`,
    `timestamp=${timestamp}`,
    `access_token=${tokens.access_token}`,
    `shop_id=${tokens.shop_id}`,
    `sign=${sign}`,
    `order_sn=${orderSn}`
  ].join('&');

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    throw new Error(`Shopee get_shipping_parameter erro: ${JSON.stringify(data)}`);
  }

  return data.response;
}

async function shipOrder(orderSn) {
  // 1. Descobre se eh dropoff, pickup ou nao precisa de parametro
  const shippingParams = await getShippingParameter(orderSn);

  const apiPath = `/api/v2/logistics/ship_order`;
  const body = { order_sn: orderSn };

  // Algumas modalidades exigem pickup ou dropoff
  if (shippingParams.pickup) {
    body.pickup = {
      address_id: shippingParams.pickup.address_list?.[0]?.address_id,
      pickup_time_id: shippingParams.pickup.address_list?.[0]?.time_slot_list?.[0]?.pickup_time_id
    };
  } else if (shippingParams.dropoff) {
    body.dropoff = {
      branch_id: shippingParams.dropoff.branch_list?.[0]?.branch_id || 0
    };
  }

  const { ok, data } = await shopeeApiCall(apiPath, 'POST', body);

  if (!ok) {
    throw new Error(`Shopee ship_order erro: ${JSON.stringify(data)}`);
  }

  return data;
}

module.exports = {
  refreshShopeeToken,
  getValidShopeeToken,
  loadShopeeTokens,
  saveShopeeTokens,
  listarPedidosToShip,
  buscarDetalhesPedidos,
  uploadInvoice,
  getShippingParameter,
  shipOrder
};
