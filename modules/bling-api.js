// modules/bling-api.js
// Interface com Bling AMBTotal: busca pedido por numeroLoja e baixa XML autorizado

const fetch = require('node-fetch');
const { getValidBlingToken } = require('./token-manager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';

async function blingFetch(url, options = {}) {
  let token = await getValidBlingToken();
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
    console.log('[bling-api] 401 recebido, forcando refresh token');
    const { refreshBlingToken } = require('./token-manager');
    const newTokens = await refreshBlingToken();
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

async function buscarPedidoPorNumeroLoja(orderSn) {
  const url = `${BLING_BASE}/pedidos/vendas?numeroLoja=${encodeURIComponent(orderSn)}&limite=10`;
  const response = await blingFetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Bling buscarPedidoPorNumeroLoja erro: ${JSON.stringify(data)}`);
  }

  const pedidos = data.data || [];
  if (pedidos.length === 0) return null;
  return pedidos[0];
}

async function buscarPedidoDetalhes(pedidoId) {
  const url = `${BLING_BASE}/pedidos/vendas/${pedidoId}`;
  const response = await blingFetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Bling buscarPedidoDetalhes erro: ${JSON.stringify(data)}`);
  }

  return data.data;
}

async function buscarNfPorPedido(pedidoId) {
  const pedido = await buscarPedidoDetalhes(pedidoId);
  if (pedido && pedido.notaFiscal && pedido.notaFiscal.id) {
    return pedido.notaFiscal.id;
  }
  return null;
}

async function buscarNfPorId(nfeId) {
  const url = `${BLING_BASE}/nfe/${nfeId}`;
  const response = await blingFetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Bling buscarNfPorId erro: ${JSON.stringify(data)}`);
  }

  return data.data;
}

async function baixarXmlAutorizado(nfeId) {
  const nf = await buscarNfPorId(nfeId);

  if (!nf) throw new Error(`NF ${nfeId} nao encontrada`);

  const situacao = nf.situacao;
  if (situacao !== 5 && situacao !== 6) {
    throw new Error(`NF ${nfeId} nao esta autorizada (situacao=${situacao})`);
  }

  if (!nf.xml) {
    throw new Error(`NF ${nfeId} autorizada mas sem campo xml. Resposta: ${JSON.stringify(nf).slice(0, 500)}`);
  }

  // O Bling retorna no campo "xml" uma URL pra baixar o XML, nao o conteudo.
  // Detecta se e URL e baixa o conteudo real.
  let xmlConteudo;
  const campoXml = String(nf.xml).trim();
  if (campoXml.startsWith('http://') || campoXml.startsWith('https://')) {
    console.log(`[baixarXmlAutorizado] campo xml e URL, baixando conteudo: ${campoXml}`);
    const resp = await fetch(campoXml);
    if (!resp.ok) {
      throw new Error(`Falha ao baixar XML da URL Bling (HTTP ${resp.status}): ${campoXml}`);
    }
    xmlConteudo = await resp.text();
  } else {
    // fallback: campo ja contem o XML (texto puro)
    xmlConteudo = campoXml;
  }

  // Garante que e um XML valido (deve comecar com <?xml ou <)
  const inicioXml = xmlConteudo.trimStart().slice(0, 60);
  console.log(`[baixarXmlAutorizado] XML real (primeiros 60 chars): ${inicioXml}`);
  console.log(`[baixarXmlAutorizado] tamanho XML real: ${xmlConteudo.length} chars`);
  if (!inicioXml.includes('<?xml') && !inicioXml.includes('<')) {
    throw new Error(`Conteudo baixado nao parece XML: ${inicioXml}`);
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
