// modules/shopee-api.js
// Interface com Shopee Open Platform
// SHOPEE_BASE_URL via env var: sandbox=https://partner.test-stable.shopeemobile.com, prod=https://partner.shopeemobile.com

const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHOPEE_BASE = process.env.AMB_SHOPEE_BASE_URL || 'https://partner.shopeemobile.com';
// Dominio especifico pro upload de NF-e (Brazil local seller). Auth/listagem continuam no dominio global.
const SHOPEE_BASE_BR = process.env.AMB_SHOPEE_BASE_URL_BR || 'https://openplatform.shopee.com.br';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens-shopee.json');

// =============================================================================
// TOKEN MANAGEMENT
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

function generateSign(apiPath, timestamp, accessToken = null, shopId = null) {
  const partnerId = process.env.AMB_SHOPEE_PARTNER_ID;
  const partnerKey = process.env.AMB_SHOPEE_PARTNER_KEY;

  let baseString = `${partnerId}${apiPath}${timestamp}`;
  if (accessToken && shopId) {
    baseString += `${accessToken}${shopId}`;
  }

  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

async function refreshShopeeToken() {
  const tokens = loadShopeeTokens();
  if (!tokens.refresh_token || !tokens.shop_id) {
    throw new Error('Shopee tokens ausentes. Faca OAuth inicial via /setup-shopee.');
  }

  const apiPath = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.AMB_SHOPEE_PARTNER_ID);
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
  if (data.error) throw new Error(`Shopee refresh falhou: ${JSON.stringify(data)}`);

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
// HELPER autenticado
// =============================================================================

async function shopeeApiCall(apiPath, method = 'GET', body = null) {
  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.AMB_SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp, tokens.access_token, tokens.shop_id);

  const queryParams = [
    `partner_id=${partnerId}`,
    `timestamp=${timestamp}`,
    `access_token=${tokens.access_token}`,
    `shop_id=${tokens.shop_id}`,
    `sign=${sign}`
  ].join('&');

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);
  const data = await response.json();
  return { ok: response.ok && !data.error, data };
}

// =============================================================================
// ORDER LISTING
// =============================================================================

async function listarPedidosToShip(diasAtras = 3) {
  const agora = Math.floor(Date.now() / 1000);
  const inicio = agora - (diasAtras * 24 * 60 * 60);

  const apiPath = `/api/v2/order/get_order_list`;
  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.AMB_SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp, tokens.access_token, tokens.shop_id);

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

  if (data.error) throw new Error(`Shopee get_order_list erro: ${JSON.stringify(data)}`);
  return data.response?.order_list || [];
}

async function buscarDetalhesPedidos(orderSnList) {
  if (orderSnList.length === 0) return [];
  if (orderSnList.length > 50) orderSnList = orderSnList.slice(0, 50);

  const apiPath = `/api/v2/order/get_order_detail`;
  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.AMB_SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp, tokens.access_token, tokens.shop_id);

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

  if (data.error) throw new Error(`Shopee get_order_detail erro: ${JSON.stringify(data)}`);
  return data.response?.order_list || [];
}

// =============================================================================
// UPLOAD INVOICE (NF-e)
// =============================================================================

/**
 * Upload da NF-e pra Shopee (PH/BR local seller).
 * Endpoint oficial: POST /api/v2/order/upload_invoice_doc
 * file_type: 1=pdf, 2=jpeg, 3=png, 4=xml. Usamos 4 (XML).
 * O arquivo vai como multipart/form-data (binario), limite 1MB.
 * A assinatura/auth vai na query string (igual aos outros endpoints).
 */
async function uploadInvoice(orderSn, xmlBase64, chaveAcesso, numeroNf) {
  const FormData = require('form-data');
  const apiPath = `/api/v2/order/upload_invoice_doc`;

  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.AMB_SHOPEE_PARTNER_ID);
  const sign = generateSign(apiPath, timestamp, tokens.access_token, tokens.shop_id);

  const queryParams = [
    `partner_id=${partnerId}`,
    `timestamp=${timestamp}`,
    `access_token=${tokens.access_token}`,
    `shop_id=${tokens.shop_id}`,
    `sign=${sign}`
  ].join('&');

  // XML vem em base64 do Bling -> converte pra buffer binario
  const xmlBuffer = Buffer.from(xmlBase64, 'base64');
  if (xmlBuffer.length > 1024 * 1024) {
    throw new Error(`XML da NF excede 1MB (${xmlBuffer.length} bytes) - limite Shopee`);
  }

  const form = new FormData();
  form.append('order_sn', orderSn);
  form.append('file_type', '4'); // 4 = xml
  form.append('file', xmlBuffer, {
    filename: `NFe${chaveAcesso || numeroNf || orderSn}.xml`,
    contentType: 'application/xml'
  });

  const url = `${SHOPEE_BASE_BR}${apiPath}?${queryParams}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: form.getHeaders(),
    body: form
  });

  const data = await response.json();
  if (data.error) throw new Error(`Shopee uploadInvoice erro: ${JSON.stringify(data)}`);
  return data;
}

// =============================================================================
// SHIP ORDER (Organizar Envio)
// =============================================================================

async function getShippingParameter(orderSn) {
  const apiPath = `/api/v2/logistics/get_shipping_parameter`;
  const tokens = await getValidShopeeToken();
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(process.env.AMB_SHOPEE_PARTNER_ID);
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

  if (data.error) throw new Error(`Shopee get_shipping_parameter erro: ${JSON.stringify(data)}`);
  return data.response;
}

async function shipOrder(orderSn) {
  const shippingParams = await getShippingParameter(orderSn);

  const apiPath = `/api/v2/logistics/ship_order`;
  const body = { order_sn: orderSn };

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
  if (!ok) throw new Error(`Shopee ship_order erro: ${JSON.stringify(data)}`);
  return data;
}

module.exports = {
  SHOPEE_BASE,
  refreshShopeeToken,
  getValidShopeeToken,
  loadShopeeTokens,
  saveShopeeTokens,
  generateSign,
  listarPedidosToShip,
  buscarDetalhesPedidos,
  uploadInvoice,
  getShippingParameter,
  shipOrder
};
