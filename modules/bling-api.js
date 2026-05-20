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

  // ---- LOG DIAGNOSTICO ----
  console.log(`[baixarXmlAutorizado] nfeId=${nfeId} chave=${nf.chaveAcesso} numero=${nf.numero}`);
  console.log(`[baixarXmlAutorizado] campo xml (primeiros 80 chars): ${String(nf.xml).slice(0, 80)}`);
  console.log(`[baixarXmlAutorizado] tamanho campo xml: ${String(nf.xml).length}`);
  // --------------------------

  return {
    chave: nf.chaveAcesso,
    numero: nf.numero,
    serie: nf.serie,
    xmlBase64: nf.xml,
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
