// modules/shopee-api.js
// Interface com Shopee Open Platform, por loja.
// Cada funcao recebe o objeto "loja" (config de modules/lojas.js).

const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SHOPEE_BASE } = require('./lojas');

// =============================================================================
// TOKEN MANAGEMENT (por loja)
// =============================================================================

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadShopeeTokens(loja) {
  const file = loja.shopee.tokenFile;
  ensureDir(file);
  if (!fs.existsSync(file)) {
    const initial = { access_token: '', refresh_token: '', shop_id: '', expires_at: 0 };
    saveShopeeTokens(loja, initial);
    return initial;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveShopeeTokens(loja, tokens) {
  const file = loja.shopee.tokenFile;
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2));
}

function generateSign(loja, apiPath, timestamp, accessToken = null, shopId = null) {
  const partnerId = loja.shopee.partnerId;
  const partnerKey = loja.shopee.partnerKey;

  let baseString = `${partnerId}${apiPath}${timestamp}`;
  if (accessToken && shopId) {
    baseString += `${accessToken}${shopId}`;
  }
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

async function refreshShopeeToken(loja) {
  const tokens = loadShopeeTokens(loja);
  if (!tokens.refresh_token || !tokens.shop_id) {
    throw new Error(`[${loja.key}] Shopee tokens ausentes. Faca OAuth inicial via /${loja.key}/setup-shopee.`);
  }

  const apiPath = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp);

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
  if (data.error) throw new Error(`[${loja.key}] Shopee refresh falhou: ${JSON.stringify(data)}`);

  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    shop_id: tokens.shop_id,
    expires_at: Date.now() + (data.expire_in * 1000) - 60000
  };

  saveShopeeTokens(loja, newTokens);
  console.log(`[shopee-api][${loja.key}] Access token renovado`);
  return newTokens;
}

async function getValidShopeeToken(loja) {
  let tokens = loadShopeeTokens(loja);
  if (!tokens.access_token || Date.now() >= tokens.expires_at) {
    tokens = await refreshShopeeToken(loja);
  }
  return tokens;
}

// =============================================================================
// HELPER autenticado (JSON)
// =============================================================================

async function shopeeApiCall(loja, apiPath, method = 'GET', body = null) {
  const tokens = await getValidShopeeToken(loja);
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp, tokens.access_token, tokens.shop_id);

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

async function listarPedidosPendentesNf(loja, diasAtras = 7) {
  const agora = Math.floor(Date.now() / 1000);
  const inicio = agora - (diasAtras * 24 * 60 * 60);

  const apiPath = `/api/v2/order/get_order_list`;
  const tokens = await getValidShopeeToken(loja);
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp, tokens.access_token, tokens.shop_id);

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
    `order_status=INVOICE_PENDING`
  ].join('&');

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) throw new Error(`[${loja.key}] Shopee get_order_list erro: ${JSON.stringify(data)}`);
  return data.response?.order_list || [];
}

async function buscarDetalhesPedidos(loja, orderSnList) {
  if (orderSnList.length === 0) return [];
  if (orderSnList.length > 50) orderSnList = orderSnList.slice(0, 50);

  const apiPath = `/api/v2/order/get_order_detail`;
  const tokens = await getValidShopeeToken(loja);
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp, tokens.access_token, tokens.shop_id);

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

  if (data.error) throw new Error(`[${loja.key}] Shopee get_order_detail erro: ${JSON.stringify(data)}`);
  return data.response?.order_list || [];
}

// =============================================================================
// UPLOAD INVOICE (NF-e)  -- endpoint /api/v2/order/upload_invoice_doc, file_type 4 (xml)
// =============================================================================

async function uploadInvoice(loja, orderSn, xmlConteudo, chaveAcesso, numeroNf) {
  const FormData = require('form-data');
  const apiPath = `/api/v2/order/upload_invoice_doc`;

  const tokens = await getValidShopeeToken(loja);
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp, tokens.access_token, tokens.shop_id);

  const queryParams = [
    `partner_id=${partnerId}`,
    `timestamp=${timestamp}`,
    `access_token=${tokens.access_token}`,
    `shop_id=${tokens.shop_id}`,
    `sign=${sign}`
  ].join('&');

  const xmlBuffer = Buffer.from(xmlConteudo, 'utf8');
  if (xmlBuffer.length > 1024 * 1024) {
    throw new Error(`[${loja.key}] XML da NF excede 1MB (${xmlBuffer.length} bytes)`);
  }

  const xmlInicio = xmlBuffer.toString('utf8', 0, 120);
  console.log(`[uploadInvoice][${loja.key}] order_sn=${orderSn} chave=${chaveAcesso} bytes=${xmlBuffer.length} header=${xmlInicio.includes('<?xml')}`);

  const form = new FormData();
  form.append('order_sn', orderSn);
  form.append('file_type', '4');
  form.append('file', xmlBuffer, {
    filename: `NFe${chaveAcesso || numeroNf || orderSn}.xml`,
    contentType: 'application/xml'
  });

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: form.getHeaders(),
    body: form
  });

  const data = await response.json();
  console.log(`[uploadInvoice][${loja.key}] resposta: HTTP ${response.status} | ${JSON.stringify(data)}`);
  if (data.error) throw new Error(`[${loja.key}] Shopee uploadInvoice erro: ${JSON.stringify(data)}`);
  return data;
}

// =============================================================================
// SHIP ORDER (Organizar Envio / Coleta)
// =============================================================================

async function getShippingParameter(loja, orderSn) {
  const apiPath = `/api/v2/logistics/get_shipping_parameter`;
  const tokens = await getValidShopeeToken(loja);
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp, tokens.access_token, tokens.shop_id);

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

  if (data.error) throw new Error(`[${loja.key}] Shopee get_shipping_parameter erro: ${JSON.stringify(data)}`);
  return data.response;
}

async function shipOrder(loja, orderSn) {
  const shippingParams = await getShippingParameter(loja, orderSn);

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

  const { ok, data } = await shopeeApiCall(loja, apiPath, 'POST', body);
  if (!ok) throw new Error(`[${loja.key}] Shopee ship_order erro: ${JSON.stringify(data)}`);
  return data;
}

module.exports = {
  refreshShopeeToken,
  getValidShopeeToken,
  loadShopeeTokens,
  saveShopeeTokens,
  generateSign,
  listarPedidosPendentesNf,
  buscarDetalhesPedidos,
  uploadInvoice,
  getShippingParameter,
  shipOrder
};
