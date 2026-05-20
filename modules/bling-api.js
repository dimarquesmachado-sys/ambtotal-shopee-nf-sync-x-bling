// modules/bling-api.js
// Interface com Bling, por loja. Cada funcao recebe o objeto "loja" (config de lojas.js).

const fetch = require('node-fetch');
const { getValidBlingToken, refreshBlingToken } = require('./token-manager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';

async function blingFetch(loja, url, options = {}) {
  let token = await getValidBlingToken(loja);
  let response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'enable-jwt': '1'
    }
  });

  if (response.status === 401) {
    console.log(`[bling-api][${loja.key}] 401 recebido, forcando refresh token`);
    const newTokens = await refreshBlingToken(loja);
    response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${newTokens.access_token}`,
        'Accept': 'application/json',
        'enable-jwt': '1'
      }
    });
  }

  return response;
}

async function buscarPedidoPorNumeroLoja(loja, orderSn) {
  const url = `${BLING_BASE}/pedidos/vendas?numeroLoja=${encodeURIComponent(orderSn)}&limite=10`;
  const response = await blingFetch(loja, url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`[${loja.key}] Bling buscarPedidoPorNumeroLoja erro: ${JSON.stringify(data)}`);
  }

  const pedidos = data.data || [];
  if (pedidos.length === 0) return null;
  return pedidos[0];
}

async function buscarPedidoDetalhes(loja, pedidoId) {
  const url = `${BLING_BASE}/pedidos/vendas/${pedidoId}`;
  const response = await blingFetch(loja, url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`[${loja.key}] Bling buscarPedidoDetalhes erro: ${JSON.stringify(data)}`);
  }

  return data.data;
}

async function buscarNfPorPedido(loja, pedidoId) {
  const pedido = await buscarPedidoDetalhes(loja, pedidoId);
  if (pedido && pedido.notaFiscal && pedido.notaFiscal.id) {
    return pedido.notaFiscal.id;
  }
  return null;
}

async function buscarNfPorId(loja, nfeId) {
  const url = `${BLING_BASE}/nfe/${nfeId}`;
  const response = await blingFetch(loja, url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`[${loja.key}] Bling buscarNfPorId erro: ${JSON.stringify(data)}`);
  }

  return data.data;
}

async function baixarXmlAutorizado(loja, nfeId) {
  const nf = await buscarNfPorId(loja, nfeId);

  if (!nf) throw new Error(`[${loja.key}] NF ${nfeId} nao encontrada`);

  const situacao = nf.situacao;
  if (situacao !== 5 && situacao !== 6) {
    throw new Error(`[${loja.key}] NF ${nfeId} nao esta autorizada (situacao=${situacao})`);
  }

  if (!nf.xml) {
    throw new Error(`[${loja.key}] NF ${nfeId} autorizada mas sem campo xml. Resposta: ${JSON.stringify(nf).slice(0, 500)}`);
  }

  // O Bling retorna no campo "xml" uma URL pra baixar o XML, nao o conteudo.
  let xmlConteudo;
  const campoXml = String(nf.xml).trim();
  if (campoXml.startsWith('http://') || campoXml.startsWith('https://')) {
    console.log(`[baixarXmlAutorizado][${loja.key}] campo xml e URL, baixando: ${campoXml}`);
    const resp = await fetch(campoXml);
    if (!resp.ok) {
      throw new Error(`[${loja.key}] Falha ao baixar XML da URL Bling (HTTP ${resp.status})`);
    }
    xmlConteudo = await resp.text();
  } else {
    xmlConteudo = campoXml;
  }

  const inicioXml = xmlConteudo.trimStart().slice(0, 60);
  console.log(`[baixarXmlAutorizado][${loja.key}] XML inicio: ${inicioXml}`);
  console.log(`[baixarXmlAutorizado][${loja.key}] tamanho: ${xmlConteudo.length} chars`);
  if (!inicioXml.includes('<?xml') && !inicioXml.includes('<')) {
    throw new Error(`[${loja.key}] Conteudo baixado nao parece XML: ${inicioXml}`);
  }

  return {
    chave: nf.chaveAcesso,
    numero: nf.numero,
    serie: nf.serie,
    xmlConteudo: xmlConteudo,
    situacao: nf.situacao,
    dataEmissao: nf.dataEmissao
  };
}

module.exports = {
  buscarPedidoPorNumeroLoja,
  buscarPedidoDetalhes,
  buscarNfPorPedido,
  buscarNfPorId,
  baixarXmlAutorizado,
  blingFetch
};
