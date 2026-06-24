// modules/bling-api.js
// Interface com Bling, por loja. Cada funcao recebe o objeto "loja" (config de lojas.js).

const fetch = require('node-fetch');
const https = require('https');
const { getValidBlingToken, refreshBlingToken } = require('./token-manager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';

// Agent HTTPS sem reuso de conexao (evita "Premature close" por socket quebrado)
// e forcando IPv4 (egress IPv6 instavel em alguns ambientes).
const blingAgent = new https.Agent({ keepAlive: false, family: 4 });

// Throttle: o Bling permite no maximo 3 req/seg. Garantimos um intervalo
// minimo entre chamadas (fila simples) pra nunca estourar o limite.
const MIN_INTERVALO_MS = 400; // ~2.5 req/seg, com folga
let ultimaChamada = 0;

async function aguardarThrottle() {
  const agora = Date.now();
  const desde = agora - ultimaChamada;
  if (desde < MIN_INTERVALO_MS) {
    await new Promise(r => setTimeout(r, MIN_INTERVALO_MS - desde));
  }
  ultimaChamada = Date.now();
}

async function blingFetch(loja, url, options = {}, tentativa = 1) {
  await aguardarThrottle();

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
    await aguardarThrottle();
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

  // 429 = rate limit. Espera 1.2s e tenta de novo (ate 3 vezes).
  if (response.status === 429 && tentativa <= 3) {
    console.log(`[bling-api][${loja.key}] 429 rate limit, tentativa ${tentativa}, aguardando 1.2s`);
    await new Promise(r => setTimeout(r, 1200));
    return blingFetch(loja, url, options, tentativa + 1);
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

// Baixa o XML da URL do Bling com retry. O Bling as vezes derruba a conexao
// no meio do download ("Premature close" / ECONNRESET / socket hang up).
// Tentamos ate 4 vezes com espera crescente antes de desistir.
async function baixarXmlComRetry(loja, url, maxTentativas = 4) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    try {
      const resp = await fetch(url, {
        agent: blingAgent,
        headers: { 'Connection': 'close', 'Accept': 'application/xml, text/xml, */*' },
        timeout: 30000
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const texto = await resp.text();
      // Valida que veio conteudo de verdade (nao vazio/cortado)
      if (!texto || texto.length < 100) {
        throw new Error(`XML vazio ou muito curto (${texto ? texto.length : 0} chars)`);
      }
      if (tentativa > 1) {
        console.log(`[baixarXmlComRetry][${loja.key}] sucesso na tentativa ${tentativa}`);
      }
      return texto;
    } catch (e) {
      ultimoErro = e;
      const msg = String(e.message || '');
      console.log(`[baixarXmlComRetry][${loja.key}] tentativa ${tentativa}/${maxTentativas} falhou: ${msg}`);
      if (tentativa < maxTentativas) {
        // Espera crescente: 1.5s, 3s, 4.5s
        await new Promise(r => setTimeout(r, 1500 * tentativa));
      }
    }
  }
  throw new Error(`[${loja.key}] Falha ao baixar XML do Bling apos ${maxTentativas} tentativas: ${ultimoErro && ultimoErro.message}`);
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
    xmlConteudo = await baixarXmlComRetry(loja, campoXml);
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
