// modules/bling-api.js
// Interface com Bling AMBTotal: busca pedido por numeroLoja (order_sn Shopee) e baixa XML autorizado da NF

const fetch = require('node-fetch');
const { getValidBlingToken } = require('./token-manager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';

// Wrapper que renova token automaticamente em caso de 401
async function blingFetch(url, options = {}) {
  let token = await getValidBlingToken();
  let response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    }
  });

  // Se 401, forca refresh e tenta de novo
  if (response.status === 401) {
    console.log('[bling-api] 401 recebido, forcando refresh token');
    const { refreshBlingToken } = require('./token-manager');
    const newTokens = await refreshBlingToken();
    response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${newTokens.access_token}`,
        'Accept': 'application/json'
      }
    });
  }

  return response;
}

/**
 * Busca pedido de venda no Bling pelo numero do pedido na loja (order_sn Shopee)
 * Retorna o pedido com seus dados, incluindo se tem NF emitida
 *
 * NOTA: Bling /pedidos/vendas aceita filtro por numero, mas precisa paginacao.
 * Em ambiente Shopee AMBTotal, o numeroLoja sempre eh o order_sn (ex: 260516JKM2JTB0).
 */
async function buscarPedidoPorNumeroLoja(orderSn) {
  // Bling permite filtrar por numeroLoja na listagem
  const url = `${BLING_BASE}/pedidos/vendas?numeroLoja=${encodeURIComponent(orderSn)}&limite=10`;

  const response = await blingFetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Bling buscarPedidoPorNumeroLoja erro: ${JSON.stringify(data)}`);
  }

  const pedidos = data.data || [];
  if (pedidos.length === 0) {
    return null;
  }

  // Se mais de 1, pega o mais recente (numeroLoja deveria ser unico mas seguranca)
  return pedidos[0];
}

/**
 * Busca detalhes completos do pedido (inclui dados da NF se houver)
 */
async function buscarPedidoDetalhes(pedidoId) {
  const url = `${BLING_BASE}/pedidos/vendas/${pedidoId}`;
  const response = await blingFetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Bling buscarPedidoDetalhes erro: ${JSON.stringify(data)}`);
  }

  return data.data;
}

/**
 * Lista NF-e por filtros (usado pra achar a NF associada ao pedido)
 * Padrao Bling: a NF tem o mesmo numeroLoja do pedido ou referencia ao pedido
 */
async function buscarNfPorPedido(pedidoId) {
  // Estrategia herdada do good-devolucoes:
  // NF tem ID sequencial proximo ao pedido. Pagina /nfe e procura.
  // Como atalho mais robusto: usar GET /pedidos/vendas/{id} que ja vem com a NF vinculada
  const pedido = await buscarPedidoDetalhes(pedidoId);
  if (pedido && pedido.notaFiscal && pedido.notaFiscal.id) {
    return pedido.notaFiscal.id;
  }
  return null;
}

/**
 * Busca dados da NF-e por ID
 */
async function buscarNfPorId(nfeId) {
  const url = `${BLING_BASE}/nfe/${nfeId}`;
  const response = await blingFetch(url);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Bling buscarNfPorId erro: ${JSON.stringify(data)}`);
  }

  return data.data;
}

/**
 * Baixa o XML autorizado da NF-e em base64
 * Bling v3: GET /nfe/{id}/post-envio retorna XML, ou GET /nfe/{id} ja traz xml em base64 quando autorizada
 */
async function baixarXmlAutorizado(nfeId) {
  // Primeiro: buscar a NF pra ver se esta autorizada
  const nf = await buscarNfPorId(nfeId);

  // Validacoes
  if (!nf) {
    throw new Error(`NF ${nfeId} nao encontrada`);
  }

  // Situacao Bling: 5 = Autorizada, 7 = Cancelada, 11 = Denegada, etc
  const situacao = nf.situacao;
  if (situacao !== 5 && situacao !== 6) {
    // 5 = autorizada, 6 = emitida em contingencia (tb tem XML)
    throw new Error(`NF ${nfeId} nao esta autorizada (situacao=${situacao})`);
  }

  // XML em base64 vem no campo 'xml' quando NF eh autorizada
  if (!nf.xml) {
    throw new Error(`NF ${nfeId} autorizada mas sem campo xml. Resposta: ${JSON.stringify(nf).slice(0, 500)}`);
  }

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
