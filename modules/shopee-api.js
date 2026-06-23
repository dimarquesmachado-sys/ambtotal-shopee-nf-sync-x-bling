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

async function listarPedidosPorStatus(loja, orderStatus, diasAtras = 7) {
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
    `order_status=${orderStatus}`
  ].join('&');

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) throw new Error(`[${loja.key}] Shopee get_order_list (${orderStatus}) erro: ${JSON.stringify(data)}`);
  return data.response?.order_list || [];
}

// Pedidos aguardando NF (precisam ter a NF enviada)
async function listarPedidosPendentesNf(loja, diasAtras = 7) {
  return listarPedidosPorStatus(loja, 'INVOICE_PENDING', diasAtras);
}

// Pedidos prontos pra enviar (ja tem NF, podem precisar organizar envio/coleta)
async function listarPedidosReadyToShip(loja, diasAtras = 7) {
  return listarPedidosPorStatus(loja, 'READY_TO_SHIP', diasAtras);
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
  console.log(`[getShippingParameter][${loja.key}] order=${orderSn} retorno: ${JSON.stringify(data.response)}`);
  return data.response;
}

// Verifica se o pedido esta PRONTO pra organizar envio, seguindo a recomendacao
// oficial da Shopee (FAQ 727). Retorna { pronto, jaArranjado, status, motivo }.
// - pronto=true  -> pode chamar ship_order
// - jaArranjado=true -> envio ja foi organizado (nao precisa chamar)
// - pronto=false e jaArranjado=false -> ainda nao esta pronto (tentar no proximo ciclo)
// Checa prontidao de envio usando a API a NIVEL DE PACOTE (recomendacao oficial
// Shopee FAQ 727). Olha fulfillment_status e is_shipment_arranged, que sao mais
// precisos que o order_status. Retorna { pronto, jaArranjado, status, motivo }.
//   pronto=true      -> fulfillment_status=LOGISTICS_READY e is_shipment_arranged=false
//   jaArranjado=true -> is_shipment_arranged=true ou fulfillment_status=LOGISTICS_REQUEST_CREATED
//   senao            -> ainda nao pronto (NF validando, alocando, etc) -> tentar proximo ciclo
async function checarProntidaoEnvio(loja, orderSn) {
  const apiPath = `/api/v2/order/get_order_detail`;
  const tokens = await getValidShopeeToken(loja);
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp, tokens.access_token, tokens.shop_id);

  // Pede tambem os campos de pacote/fulfillment (mais precisos que order_status)
  const queryParams = [
    `partner_id=${partnerId}`,
    `timestamp=${timestamp}`,
    `access_token=${tokens.access_token}`,
    `shop_id=${tokens.shop_id}`,
    `sign=${sign}`,
    `order_sn_list=${orderSn}`,
    `response_optional_fields=order_status,package_list`
  ].join('&');

  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    // Se nao conseguiu checar, NAO chama ship_order (evita falha as cegas que conta na metrica).
    console.log(`[checarProntidao][${loja.key}] nao foi possivel checar (${JSON.stringify(data)}), aguardando proximo ciclo`);
    return { pronto: false, jaArranjado: false, status: 'check_falhou', motivo: 'check_falhou' };
  }

  const pedido = data.response?.order_list?.[0];
  const orderStatus = pedido?.order_status;
  const pkg = pedido?.package_list?.[0] || {};
  const fulfillment = pkg.fulfillment_status;
  const arranjado = pkg.is_shipment_arranged;

  console.log(`[checarProntidao][${loja.key}] order=${orderSn} order_status=${orderStatus} fulfillment_status=${fulfillment} is_shipment_arranged=${arranjado}`);

  // 1) Se a API retornou os campos de pacote, usamos eles (metodo preciso da doc)
  if (typeof fulfillment === 'string' || typeof arranjado === 'boolean') {
    if (arranjado === true || fulfillment === 'LOGISTICS_REQUEST_CREATED') {
      return { pronto: false, jaArranjado: true, status: fulfillment || orderStatus };
    }
    if (fulfillment === 'LOGISTICS_READY' && arranjado === false) {
      return { pronto: true, jaArranjado: false, status: fulfillment };
    }
    // Qualquer outro fulfillment_status (allocating, pending, etc) -> ainda nao pronto
    return { pronto: false, jaArranjado: false, status: fulfillment || orderStatus };
  }

  // 2) Fallback: se a API nao trouxe package_list, usa order_status (menos preciso)
  if (orderStatus === 'READY_TO_SHIP') {
    return { pronto: true, jaArranjado: false, status: orderStatus };
  }
  if (['PROCESSED', 'SHIPPED', 'TO_CONFIRM_RECEIVE', 'COMPLETED', 'IN_CANCEL', 'CANCELLED'].includes(orderStatus)) {
    return { pronto: false, jaArranjado: true, status: orderStatus };
  }
  return { pronto: false, jaArranjado: false, status: orderStatus };
}

async function shipOrder(loja, orderSn) {
  const sp = await getShippingParameter(loja, orderSn);

  const apiPath = `/api/v2/logistics/ship_order`;
  const body = { order_sn: orderSn };

  // A Shopee informa em "info_needed" quais campos sao obrigatorios pra ESTE pedido.
  // Se info_needed.pickup existir -> e coleta (pickup). Se .dropoff -> e dropoff/postagem.
  const infoNeeded = sp.info_needed || {};
  const temPickup = Array.isArray(infoNeeded.pickup);
  const temDropoff = Array.isArray(infoNeeded.dropoff);

  if (temPickup) {
    // COLETA (Entrega Direta): pega o primeiro endereco e o primeiro horario disponivel
    const addr = sp.pickup?.address_list?.[0];
    const pickup = {};
    if (addr) {
      pickup.address_id = addr.address_id;
      const slot = addr.time_slot_list?.[0];
      if (slot?.pickup_time_id) pickup.pickup_time_id = slot.pickup_time_id;
    }
    body.pickup = pickup;
    console.log(`[shipOrder][${loja.key}] modo PICKUP (coleta) body.pickup=${JSON.stringify(pickup)}`);
  } else if (temDropoff) {
    // POSTAGEM (Xpress/dropoff)
    const dropoff = {};
    const branch = sp.dropoff?.branch_list?.[0];
    if (branch?.branch_id) dropoff.branch_id = branch.branch_id;
    body.dropoff = dropoff;
    console.log(`[shipOrder][${loja.key}] modo DROPOFF (postagem) body.dropoff=${JSON.stringify(dropoff)}`);
  } else {
    // Alguns canais (ex: Shopee Xpress ja roteirizado) nao precisam de pickup/dropoff:
    // basta chamar ship_order so com order_sn. Mandamos dropoff vazio como padrao seguro.
    body.dropoff = {};
    console.log(`[shipOrder][${loja.key}] sem info_needed pickup/dropoff, enviando dropoff vazio`);
  }

  const { ok, data } = await shopeeApiCall(loja, apiPath, 'POST', body);
  console.log(`[shipOrder][${loja.key}] resposta: ${JSON.stringify(data)}`);
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
  listarPedidosReadyToShip,
  listarPedidosPorStatus,
  buscarDetalhesPedidos,
  uploadInvoice,
  getShippingParameter,
  checarProntidaoEnvio,
  shipOrder
};
