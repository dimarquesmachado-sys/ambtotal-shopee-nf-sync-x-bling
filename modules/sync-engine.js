// modules/sync-engine.js
// Motor de sincronizacao multi-loja: detecta pedidos sem NF e sincroniza.
// Processa cada loja com suas proprias credenciais.

const shopee = require('./shopee-api');
const bling = require('./bling-api');
const log = require('./supabase-log');
const { lojasConfiguradas, getConfigLoja } = require('./lojas');

// Processa o fluxo completo de UM pedido pra uma loja.
async function processarPedido(loja, orderSn) {
  const pedidoBling = await bling.buscarPedidoPorNumeroLoja(loja, orderSn);
  if (!pedidoBling) {
    return { order_sn: orderSn, loja: loja.key, status: 'pedido_bling_nao_encontrado' };
  }

  const nfeId = await bling.buscarNfPorPedido(loja, pedidoBling.id);
  if (!nfeId) {
    return { order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, status: 'sem_nf_bling' };
  }

  const nfData = await bling.baixarXmlAutorizado(loja, nfeId);

  await shopee.uploadInvoice(loja, orderSn, nfData.xmlConteudo, nfData.chave, nfData.numero);
  await log.logSync({
    order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, nfe_id: nfeId,
    chave_acesso: nfData.chave, status: 'sucesso', etapa: 'upload_invoice'
  });

  // Aguarda processar e dispara organizar envio
  await new Promise(r => setTimeout(r, 30000));
  await shopee.shipOrder(loja, orderSn);
  await log.logSync({
    order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, nfe_id: nfeId,
    chave_acesso: nfData.chave, status: 'sucesso', etapa: 'ship_order'
  });

  return { order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, nfe_id: nfeId, chave: nfData.chave, status: 'sucesso' };
}

// Ciclo de UMA loja.
async function cicloLoja(loja, { dryRun = false } = {}) {
  const resultado = {
    loja: loja.key,
    detectados: 0, processados: 0, sucessos: 0, erros: 0, detalhes: []
  };

  console.log(`[sync-engine][${loja.key}] === Iniciando ciclo ===`);

  let listaPedidos;
  try {
    listaPedidos = await shopee.listarPedidosPendentesNf(loja, 7);
  } catch (e) {
    console.error(`[sync-engine][${loja.key}] Erro listando Shopee:`, e.message);
    resultado.erro_geral = e.message;
    return resultado;
  }

  if (listaPedidos.length === 0) {
    console.log(`[sync-engine][${loja.key}] Nenhum pedido INVOICE_PENDING`);
    return resultado;
  }

  resultado.detectados = listaPedidos.length;
  console.log(`[sync-engine][${loja.key}] Detectados ${listaPedidos.length} pendente(s) de NF`);

  if (dryRun) {
    resultado.detalhes = listaPedidos.map(p => ({ order_sn: p.order_sn, status: 'dry_run' }));
    return resultado;
  }

  for (const ped of listaPedidos) {
    const orderSn = ped.order_sn;
    resultado.processados++;
    try {
      if (await log.jaSincronizado(orderSn, 6)) {
        resultado.detalhes.push({ order_sn: orderSn, status: 'ja_sincronizado_recente' });
        continue;
      }
      const r = await processarPedido(loja, orderSn);
      if (r.status === 'sucesso') {
        resultado.sucessos++;
      } else {
        await log.logSync({ order_sn: orderSn, loja: loja.key, status: r.status, etapa: 'detect', erro: r.status });
      }
      resultado.detalhes.push(r);
    } catch (e) {
      console.error(`[sync-engine][${loja.key}] Erro processando ${orderSn}:`, e.message);
      resultado.erros++;
      resultado.detalhes.push({ order_sn: orderSn, status: 'erro', erro: e.message });
      await log.logSync({ order_sn: orderSn, loja: loja.key, status: 'erro', etapa: 'sync', erro: e.message });
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`[sync-engine][${loja.key}] === Fim: ${resultado.sucessos} sucesso, ${resultado.erros} erros ===`);
  return resultado;
}

// Ciclo de TODAS as lojas configuradas (usado pelo cron).
async function cicloTodasLojas({ dryRun = false } = {}) {
  const lojas = lojasConfiguradas();
  const resultado = { inicio: new Date().toISOString(), lojas: {} };

  for (const loja of lojas) {
    resultado.lojas[loja.key] = await cicloLoja(loja, { dryRun });
  }

  resultado.fim = new Date().toISOString();
  return resultado;
}

// Sincroniza UM pedido especifico de UMA loja (pra testes manuais).
async function sincronizarPedido(lojaKey, orderSn) {
  const loja = getConfigLoja(lojaKey);
  console.log(`[sync-engine][${loja.key}] Sincronizando pedido especifico: ${orderSn}`);
  const r = await processarPedido(loja, orderSn);
  if (r.status !== 'sucesso') {
    throw new Error(`Falha ao sincronizar ${orderSn}: ${r.status}`);
  }
  await log.logSync({
    order_sn: orderSn, loja: loja.key, pedido_bling_id: r.pedido_bling_id,
    nfe_id: r.nfe_id, chave_acesso: r.chave, status: 'sucesso', etapa: 'manual_sync'
  });
  return r;
}

module.exports = { cicloLoja, cicloTodasLojas, sincronizarPedido, processarPedido };
