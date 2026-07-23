// modules/shopee-api.js
// Interface com Shopee Open Platform, por loja.
// Cada funcao recebe o objeto "loja" (config de modules/lojas.js).

const fetch = require('node-fetch');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { SHOPEE_BASE } = require('./lojas');

// Agent HTTPS que NAO reusa conexoes (keepAlive:false). O reuso de socket e a
// causa comum do erro "Premature close" no node-fetch em alguns ambientes (Render).
// Forcamos IPv4 tambem (alguns hosts tem egress IPv6 instavel).
const httpsAgent = new https.Agent({ keepAlive: false, family: 4 });

// fetch com retry para chamadas a Shopee. Resiliente a "Premature close",
// ECONNRESET, socket hang up e timeouts. Tenta ate maxTentativas vezes.
async function fetchShopeeComRetry(url, opcoes = {}, maxTentativas = 4) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      const resp = await fetch(url, {
        agent: httpsAgent,
        timeout: 30000,
        headers: { 'Connection': 'close', ...(opcoes.headers || {}) },
        ...opcoes
      });
      const texto = await resp.text();
      if (!texto || texto.length < 2) {
        throw new Error(`resposta vazia (${texto ? texto.length : 0} bytes)`);
      }
      let json;
      try {
        json = JSON.parse(texto);
      } catch (e) {
        throw new Error(`resposta nao-JSON: ${texto.slice(0, 120)}`);
      }
      if (tentativa > 1) console.log(`[fetchShopeeComRetry] sucesso na tentativa ${tentativa}`);
      return json;
    } catch (e) {
      ultimoErro = e;
      const msg = String(e.message || '');
      const ehErroRede = msg.includes('Premature close') || msg.includes('ECONNRESET') ||
                         msg.includes('socket hang up') || msg.includes('network') ||
                         msg.includes('timeout') || msg.includes('ETIMEDOUT') ||
                         msg.includes('resposta vazia') || msg.includes('EAI_AGAIN');
      console.log(`[fetchShopeeComRetry] tentativa ${tentativa}/${maxTentativas} falhou: ${msg}`);
      if (!ehErroRede || tentativa === maxTentativas) {
        if (tentativa === maxTentativas) break;
        throw e; // erro nao-recuperavel: nao adianta repetir
      }
      await new Promise(r => setTimeout(r, 1200 * tentativa)); // 1.2s, 2.4s, 3.6s
    }
  }
  throw new Error(`falha apos ${maxTentativas} tentativas: ${ultimoErro && ultimoErro.message}`);
}

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

async function shopeeApiCall(loja, apiPath, method = 'GET', body = null, extraQuery = null) {
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

  // extraQuery: parametros de negocio (page_no, create_time_from etc).
  // NAO entram na assinatura (base = partner+path+ts+token+shop) - seguro.
  const url = `${SHOPEE_BASE}${apiPath}?${queryParams}` + (extraQuery ? `&${extraQuery}` : '');
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);

  const data = await fetchShopeeComRetry(url, options);
  return { ok: !data.error, data };
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
  const data = await fetchShopeeComRetry(url);

  if (data.error) throw new Error(`[${loja.key}] Shopee get_shipping_parameter erro: ${JSON.stringify(data)}`);
  console.log(`[getShippingParameter][${loja.key}] order=${orderSn} retorno: ${JSON.stringify(data.response)}`);
  return data.response;
}

// Verifica se o pedido esta PRONTO pra organizar envio, seguindo a recomendacao
// oficial da Shopee (FAQ 727). Retorna { pronto, jaArranjado, status, motivo }.
// - pronto=true  -> pode chamar ship_order
// - jaArranjado=true -> envio ja foi organizado (nao precisa chamar)
// - pronto=false e jaArranjado=false -> ainda nao esta pronto (tentar no proximo ciclo)
// Checa prontidao de envio. Tenta o metodo de PACOTE (fulfillment_status +
// is_shipment_arranged, recomendado pela FAQ 727) e, se nao der, cai pro
// order_status. Robusto a erros: nunca lanca excecao - sempre retorna um objeto.
async function checarProntidaoEnvio(loja, orderSn) {
  let data;
  try {
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
      `order_sn_list=${orderSn}`,
      `response_optional_fields=order_status,package_list`
    ].join('&');

    const url = `${SHOPEE_BASE}${apiPath}?${queryParams}`;
    data = await fetchShopeeComRetry(url);
  } catch (e) {
    // Erro de rede/parse: NAO bloqueia o envio. Marca como pronto pelo fallback
    // (o proprio ship_order tem tratamento gracioso se nao estiver pronto).
    console.log(`[checarProntidao][${loja.key}] erro de rede ao checar (${e.message}), seguindo p/ ship_order`);
    return { pronto: true, jaArranjado: false, status: 'check_rede_falhou' };
  }

  if (data.error) {
    // A API respondeu com erro (ex: campo nao suportado). Loga e SEGUE pro envio
    // pelo fallback - melhor tentar enviar do que travar o pedido.
    console.log(`[checarProntidao][${loja.key}] API retornou erro (${JSON.stringify(data).slice(0,200)}), seguindo p/ ship_order`);
    return { pronto: true, jaArranjado: false, status: 'check_api_erro' };
  }

  const pedido = data.response?.order_list?.[0];
  const orderStatus = pedido?.order_status;
  const pkg = pedido?.package_list?.[0] || {};
  const fulfillment = pkg.fulfillment_status;
  const arranjado = pkg.is_shipment_arranged;

  console.log(`[checarProntidao][${loja.key}] order=${orderSn} order_status=${orderStatus} fulfillment_status=${fulfillment} is_shipment_arranged=${arranjado}`);

  // 1) Metodo preciso (pacote), se a API trouxe os campos
  if (typeof fulfillment === 'string' || typeof arranjado === 'boolean') {
    if (arranjado === true || fulfillment === 'LOGISTICS_REQUEST_CREATED') {
      return { pronto: false, jaArranjado: true, status: fulfillment || orderStatus };
    }
    if (fulfillment === 'LOGISTICS_READY' && arranjado === false) {
      return { pronto: true, jaArranjado: false, status: fulfillment };
    }
    // fulfillment veio mas nao é READY nem arranjado.
    // Se o order_status diz READY_TO_SHIP, confia nele e tenta enviar (evita travar).
    if (orderStatus === 'READY_TO_SHIP') {
      return { pronto: true, jaArranjado: false, status: orderStatus };
    }
    return { pronto: false, jaArranjado: false, status: fulfillment || orderStatus };
  }

  // 2) Fallback por order_status (metodo antigo, comprovado)
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

// =============================================================================
// ETIQUETA (waybill) DIRETO DA SHOPEE -- v2.5.0
// Existe pra um caso real: quando o Bling importa o pedido DEPOIS do envio ja
// organizado na Shopee (ou a NF trava a edicao antes da logistica entrar), o pedido
// fica sem logistica no Bling e /logisticas/etiquetas da 404 PRA SEMPRE. Ai o checkout
// pede a etiqueta aqui. Fluxo oficial: parameter -> create -> result(READY) -> download.
// =============================================================================

// helper: nº do(s) pacote(s) do pedido — a Shopee exige package_number em varios
// fluxos de documento; sem ele o batch falha com erro generico.
async function _pacotes(loja, orderSn) {
  try {
    const r = await shopeeApiCall(loja, '/api/v2/order/get_order_detail', 'GET', null,
      `order_sn_list=${encodeURIComponent(orderSn)}&response_optional_fields=package_list`);
    const ol = (((r.data && r.data.response) || {}).order_list || [])[0] || {};
    return (ol.package_list || []).map(p => p.package_number || p.packageNumber).filter(Boolean);
  } catch (e) { return []; }
}

const _corta = o => { try { return JSON.stringify(o).slice(0, 420); } catch (e) { return String(o).slice(0, 200); } };

// helper: status do documento. Devolve tambem a resposta CRUA (o motivo real de um
// batch_api_all_failed vem por item, dentro de result_list, nao no erro do topo).
async function _docStatus(loja, orderSn, tipo, pkg) {
  const item = { order_sn: orderSn, shipping_document_type: tipo };
  if (pkg) item.package_number = pkg;
  try {
    const rs = await shopeeApiCall(loja, '/api/v2/logistics/get_shipping_document_result', 'POST', { order_list: [item] });
    const it = (((rs.data && rs.data.response) || {}).result_list || [])[0] || {};
    return { status: it.status || null, erro: (rs.data && rs.data.error) || null, cru: _corta(rs.data) };
  } catch (e) { return { status: null, erro: String(e.message || e).slice(0, 140), cru: null }; }
}

// helper: baixa o PDF (resposta BINARIA -> fetch cru; o helper de retry parseia JSON)
async function _docDownload(loja, orderSn, tipo, pkg) {
  const apiPath = '/api/v2/logistics/download_shipping_document';
  const tokens = await getValidShopeeToken(loja);
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp, tokens.access_token, tokens.shop_id);
  const url = `${SHOPEE_BASE}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&access_token=${tokens.access_token}&shop_id=${tokens.shop_id}&sign=${sign}`;
  const item = { order_sn: orderSn };
  if (pkg) item.package_number = pkg;
  const resp = await fetch(url, {
    method: 'POST', agent: httpsAgent, timeout: 60000,
    headers: { 'Content-Type': 'application/json', 'Connection': 'close' },
    body: JSON.stringify({ shipping_document_type: tipo, order_list: [item] })
  });
  const buf = await resp.buffer();
  const ehPdf = !!(buf && buf.length > 500 && buf.slice(0, 4).toString('utf8') === '%PDF');
  return { pdf: ehPdf ? buf : null, http: resp.status, bytes: buf ? buf.length : 0, amostra: ehPdf ? null : (buf ? buf.toString('utf8').slice(0, 200) : 'vazio') };
}

// helper: manda gerar. Guarda a resposta CRUA — em batch_api_all_failed o motivo
// real do pedido vem em result_list[].fail_error / fail_message.
async function _docCreate(loja, orderSn, tipo, pkg) {
  const item = { order_sn: orderSn, shipping_document_type: tipo };
  if (pkg) item.package_number = pkg;
  try {
    const cr = await shopeeApiCall(loja, '/api/v2/logistics/create_shipping_document', 'POST', { order_list: [item] });
    const lst = (((cr.data && cr.data.response) || {}).result_list || []);
    const fail = (((cr.data && cr.data.response) || {}).fail_list || cr.data && cr.data.fail_list) || [];
    return { erro: (cr.data && cr.data.error) || null, itens: _corta(lst.length ? lst : fail), cru: _corta(cr.data) };
  } catch (e) { return { erro: String(e.message || e).slice(0, 140), cru: null }; }
}

async function etiquetaPedido(loja, orderSn, tipoForcado = null) {
  const passos = [];

  // 1) tipos aceitos por ESTE pedido
  let sugerido = null, selec = [];
  try {
    const par = await shopeeApiCall(loja, '/api/v2/logistics/get_shipping_document_parameter', 'POST', { order_list: [{ order_sn: orderSn }] });
    const info = ((par.data && par.data.response && par.data.response.result_list) || [])[0] || {};
    sugerido = info.suggest_shipping_document_type || null;
    selec = (info.selectable_shipping_document_type || []).map(x => (typeof x === 'string' ? x : x.shipping_document_type)).filter(Boolean);
    passos.push({ passo: 'parameter', sugerido, selecionaveis: selec, cru: _corta(par.data) });
  } catch (e) { passos.push({ passo: 'parameter', erro: String(e.message || e).slice(0, 160) }); }

  // 2) nº do pacote — varios fluxos de documento exigem, e sem ele a Shopee erra de forma generica
  const pkgs = await _pacotes(loja, orderSn);
  passos.push({ passo: 'pacotes', encontrados: pkgs });
  const pkg = pkgs[0] || null;

  const tipos = [...new Set([tipoForcado, sugerido, ...selec, 'THERMAL_AIR_WAYBILL', 'NORMAL_AIR_WAYBILL'].filter(Boolean))];

  // 3) tenta o ciclo completo por tipo, COM e SEM package_number (a exigencia varia por canal logistico)
  for (const t of tipos) {
    for (const usarPkg of (pkg ? [pkg, null] : [null])) {
      const rotulo = t + (usarPkg ? ' +pkg' : '');

      // 3a) o documento ja existe? tenta baixar direto
      const dl0 = await _docDownload(loja, orderSn, t, usarPkg);
      passos.push({ passo: 'download-direto', tipo: rotulo, http: dl0.http, bytes: dl0.bytes, amostra: dl0.amostra });
      if (dl0.pdf) return { pdf: dl0.pdf, tipo: t, pkg: usarPkg, passos, origem: 'ja_existia' };

      // 3b) manda gerar e espera
      const cr = await _docCreate(loja, orderSn, t, usarPkg);
      passos.push({ passo: 'create', tipo: rotulo, erro: cr.erro, itens: cr.itens, cru: cr.cru });

      let pronto = false, ultimo = null;
      for (let i = 0; i < 8 && !pronto; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const st = await _docStatus(loja, orderSn, t, usarPkg);
        ultimo = st.status || st.erro;
        const su = String(st.status || '').toUpperCase();
        if (su === 'READY') pronto = true;
        else if (su === 'FAILED') { passos.push({ passo: 'result', tipo: rotulo, status: su, cru: st.cru }); break; }
      }
      passos.push({ passo: 'result', tipo: rotulo, pronto, ultimo_status: ultimo });
      if (pronto) {
        const dl = await _docDownload(loja, orderSn, t, usarPkg);
        passos.push({ passo: 'download', tipo: rotulo, http: dl.http, bytes: dl.bytes, amostra: dl.amostra });
        if (dl.pdf) return { pdf: dl.pdf, tipo: t, pkg: usarPkg, passos, origem: 'gerada_agora' };
      }
    }
  }

  const err = new Error('nao consegui a etiqueta na Shopee (veja os passos)');
  err.passos = passos;
  throw err;
}

// =============================================================================
// ESCROW (tarifas REAIS por pedido) -- /api/v2/payment/get_escrow_detail
// v2.4.0 - alimenta o dashboard de margem da Girassol (comissao + taxas de verdade)
// =============================================================================

async function escrowPedido(loja, orderSn) {
  const apiPath = `/api/v2/payment/get_escrow_detail`;
  const tokens = await getValidShopeeToken(loja);
  const timestamp = Math.floor(Date.now() / 1000);
  const partnerId = parseInt(loja.shopee.partnerId);
  const sign = generateSign(loja, apiPath, timestamp, tokens.access_token, tokens.shop_id);
  const url = `${SHOPEE_BASE}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&access_token=${tokens.access_token}&shop_id=${tokens.shop_id}&sign=${sign}&order_sn=${encodeURIComponent(orderSn)}`;
  const data = await fetchShopeeComRetry(url);   // v2.4.3: o helper JA devolve o JSON parseado (nao e um Response)
  if (data.error) throw new Error(`get_escrow_detail erro: ${data.error} ${data.message || ''}`);
  return (data.response) || null;
}

module.exports = {
  etiquetaPedido,
  escrowPedido,
  refreshShopeeToken,
  getValidShopeeToken,
  loadShopeeTokens,
  saveShopeeTokens,
  generateSign,
  shopeeApiCall,
  listarPedidosPendentesNf,
  listarPedidosReadyToShip,
  listarPedidosPorStatus,
  buscarDetalhesPedidos,
  uploadInvoice,
  getShippingParameter,
  checarProntidaoEnvio,
  shipOrder
};
