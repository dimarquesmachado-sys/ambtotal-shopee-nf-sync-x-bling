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

  // Tenta subir a NF. Se ja existe na Shopee (erro de duplicada/ja enviada),
  // nao aborta - segue pro organizar envio, que pode ser o que falta.
  let nfJaEstava = false;
  try {
    await shopee.uploadInvoice(loja, orderSn, nfData.xmlConteudo, nfData.chave, nfData.numero);
    await log.logSync({
      order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, nfe_id: nfeId,
      chave_acesso: nfData.chave, status: 'sucesso', etapa: 'upload_invoice'
    });
  } catch (e) {
    const msg = String(e.message || '');
    // Erros que significam "a NF ja esta la" - nao sao falha real
    if (msg.includes('arranged') || msg.includes('duplicat') || msg.includes('already')) {
      nfJaEstava = true;
      console.log(`[sync-engine][${loja.key}] NF ja estava na Shopee p/ ${orderSn}, seguindo pro envio`);
    } else {
      throw e; // erro real no upload, aborta
    }
  }

  // Aguarda a Shopee processar a NF antes de checar prontidao (validacao SERPRO)
  if (!nfJaEstava) await new Promise(r => setTimeout(r, 30000));

  // Antes de organizar envio, CHECA se o pedido esta pronto (recomendacao oficial
  // Shopee FAQ 727: so chamar ship_order quando READY_TO_SHIP e nao arranjado).
  // Isso evita chamadas que falhariam e derrubariam a taxa de sucesso do app.
  let prontidao;
  try {
    prontidao = await shopee.checarProntidaoEnvio(loja, orderSn);
  } catch (e) {
    console.log(`[sync-engine][${loja.key}] erro ao checar prontidao ${orderSn}: ${e.message}`);
    prontidao = { pronto: true, jaArranjado: false, status: 'check_erro' };
  }

  if (prontidao.jaArranjado) {
    console.log(`[sync-engine][${loja.key}] ${orderSn} envio ja organizado (status=${prontidao.status}), nada a fazer`);
    return { order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, nfe_id: nfeId, chave: nfData.chave, status: 'sucesso', detalhe: 'ja_arranjado' };
  }

  if (!prontidao.pronto) {
    // Ainda nao esta READY_TO_SHIP (NF em validacao, alocando, etc).
    // NAO chama ship_order agora - sera tentado no proximo ciclo do cron.
    console.log(`[sync-engine][${loja.key}] ${orderSn} ainda nao pronto p/ envio (status=${prontidao.status}), tentar proximo ciclo`);
    return { order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, nfe_id: nfeId, chave: nfData.chave, status: 'aguardando_prontidao', order_status: prontidao.status };
  }

  // Pedido READY_TO_SHIP -> organiza envio/coleta. Se falhar por estado, nao e erro real.
  try {
    await shopee.shipOrder(loja, orderSn);
    await log.logSync({
      order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, nfe_id: nfeId,
      chave_acesso: nfData.chave, status: 'sucesso', etapa: 'ship_order'
    });
  } catch (e) {
    const msg = String(e.message || '');
    if (msg.includes('arranged') || msg.includes('already') || msg.includes('has been') || msg.includes('not ready')) {
      console.log(`[sync-engine][${loja.key}] Envio ja estava organizado/nao pronto p/ ${orderSn}`);
    } else {
      throw e;
    }
  }

  return { order_sn: orderSn, loja: loja.key, pedido_bling_id: pedidoBling.id, nfe_id: nfeId, chave: nfData.chave, status: 'sucesso' };
}

// Ciclo de UMA loja.
async function cicloLoja(loja, { dryRun = false } = {}) {
  const resultado = {
    loja: loja.key,
    detectados: 0, processados: 0, sucessos: 0, erros: 0, detalhes: []
  };

  console.log(`[sync-engine][${loja.key}] === Iniciando ciclo ===`);

  // Busca 2 grupos:
  // 1) INVOICE_PENDING: pedidos que precisam ter a NF enviada (+ organizar envio depois)
  // 2) READY_TO_SHIP: pedidos que ja tem NF mas podem ter envio nao organizado
  let pendentesNf = [];
  let readyToShip = [];
  try {
    pendentesNf = await shopee.listarPedidosPendentesNf(loja, 7);
  } catch (e) {
    console.error(`[sync-engine][${loja.key}] Erro listando INVOICE_PENDING:`, e.message);
    resultado.erro_geral = e.message;
    return resultado;
  }
  try {
    readyToShip = await shopee.listarPedidosReadyToShip(loja, 7);
  } catch (e) {
    console.error(`[sync-engine][${loja.key}] Erro listando READY_TO_SHIP:`, e.message);
    // nao aborta - segue com os INVOICE_PENDING ao menos
  }

  // Junta as duas listas sem duplicar order_sn
  const mapa = new Map();
  for (const p of pendentesNf) mapa.set(p.order_sn, p);
  for (const p of readyToShip) if (!mapa.has(p.order_sn)) mapa.set(p.order_sn, p);
  const listaPedidos = Array.from(mapa.values());

  if (listaPedidos.length === 0) {
    console.log(`[sync-engine][${loja.key}] Nenhum pedido pendente (NF ou envio)`);
    return resultado;
  }

  resultado.detectados = listaPedidos.length;
  console.log(`[sync-engine][${loja.key}] Detectados ${listaPedidos.length} (INVOICE_PENDING=${pendentesNf.length}, READY_TO_SHIP=${readyToShip.length})`);

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
