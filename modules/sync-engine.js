// modules/sync-engine.js
// Motor de sincronizacao: detecta pedidos sem NF e sincroniza

const shopee = require('./shopee-api');
const bling = require('./bling-api');
const log = require('./supabase-log');

function pedidoEstaPendenteDeNf(orderDetail) {
  if (!orderDetail) return false;
  if (!orderDetail.invoice_data) return true;

  const inv = orderDetail.invoice_data;
  if (!inv.access_key && !inv.number) return true;

  return false;
}

async function ciclo({ dryRun = false } = {}) {
  const resultado = {
    inicio: new Date().toISOString(),
    detectados: 0,
    processados: 0,
    sucessos: 0,
    erros: 0,
    detalhes: []
  };

  console.log('[sync-engine] === Iniciando ciclo ===');

  let listaPedidos;
  try {
    listaPedidos = await shopee.listarPedidosPendentesNf(7);
  } catch (e) {
    console.error('[sync-engine] Erro listando pedidos Shopee:', e.message);
    resultado.erro_geral = e.message;
    return resultado;
  }

  if (listaPedidos.length === 0) {
    console.log('[sync-engine] Nenhum pedido INVOICE_PENDING encontrado');
    return resultado;
  }

  // Pedidos com status INVOICE_PENDING ja sao, por definicao da Shopee, os que
  // precisam de NF-e. Nao precisa filtrar de novo pelo invoice_data.
  const pendentes = listaPedidos;
  resultado.detectados = pendentes.length;
  console.log(`[sync-engine] Detectados ${pendentes.length} pedido(s) pendente(s) de NF (INVOICE_PENDING)`);

  if (dryRun) {
    resultado.detalhes = pendentes.map(p => ({ order_sn: p.order_sn, status: 'dry_run' }));
    return resultado;
  }

  for (const ped of pendentes) {
    const orderSn = ped.order_sn;
    const item = { order_sn: orderSn };
    resultado.processados++;

    try {
      if (await log.jaSincronizado(orderSn, 6)) {
        item.status = 'ja_sincronizado_recente';
        resultado.detalhes.push(item);
        continue;
      }

      const pedidoBling = await bling.buscarPedidoPorNumeroLoja(orderSn);
      if (!pedidoBling) {
        item.status = 'pedido_bling_nao_encontrado';
        await log.logSync({ order_sn: orderSn, status: 'erro', etapa: 'detect', erro: 'pedido nao achado no Bling' });
        resultado.detalhes.push(item);
        continue;
      }
      item.pedido_bling_id = pedidoBling.id;

      const nfeId = await bling.buscarNfPorPedido(pedidoBling.id);
      if (!nfeId) {
        item.status = 'sem_nf_bling';
        await log.logSync({ order_sn: orderSn, pedido_bling_id: pedidoBling.id, status: 'sem_nf_bling', etapa: 'detect', erro: 'sem NF vinculada' });
        resultado.detalhes.push(item);
        continue;
      }
      item.nfe_id = nfeId;

      const nfData = await bling.baixarXmlAutorizado(nfeId);
      item.chave = nfData.chave;

      await shopee.uploadInvoice(orderSn, nfData.xmlConteudo, nfData.chave, nfData.numero);
      await log.logSync({
        order_sn: orderSn, pedido_bling_id: pedidoBling.id, nfe_id: nfeId,
        chave_acesso: nfData.chave, status: 'sucesso', etapa: 'upload_invoice'
      });

      await new Promise(r => setTimeout(r, 30000));
      await shopee.shipOrder(orderSn);

      await log.logSync({
        order_sn: orderSn, pedido_bling_id: pedidoBling.id, nfe_id: nfeId,
        chave_acesso: nfData.chave, status: 'sucesso', etapa: 'ship_order'
      });

      item.status = 'sucesso';
      resultado.sucessos++;

    } catch (e) {
      console.error(`[sync-engine] Erro processando ${orderSn}:`, e.message);
      item.status = 'erro';
      item.erro = e.message;
      resultado.erros++;
      await log.logSync({ order_sn: orderSn, status: 'erro', etapa: item.nfe_id ? 'upload_invoice' : 'detect', erro: e.message });
    }

    resultado.detalhes.push(item);
    await new Promise(r => setTimeout(r, 2000));
  }

  resultado.fim = new Date().toISOString();
  console.log(`[sync-engine] === Fim do ciclo: ${resultado.sucessos} sucesso, ${resultado.erros} erros ===`);
  return resultado;
}

async function sincronizarPedido(orderSn) {
  console.log(`[sync-engine] Sincronizando pedido especifico: ${orderSn}`);

  const detalhes = await shopee.buscarDetalhesPedidos([orderSn]);
  if (detalhes.length === 0) throw new Error('Pedido nao encontrado na Shopee');

  const pedidoBling = await bling.buscarPedidoPorNumeroLoja(orderSn);
  if (!pedidoBling) throw new Error('Pedido nao encontrado no Bling');

  const nfeId = await bling.buscarNfPorPedido(pedidoBling.id);
  if (!nfeId) throw new Error('Pedido Bling sem NF vinculada');

  const nfData = await bling.baixarXmlAutorizado(nfeId);

  await shopee.uploadInvoice(orderSn, nfData.xmlConteudo, nfData.chave, nfData.numero);
  await new Promise(r => setTimeout(r, 30000));
  await shopee.shipOrder(orderSn);

  await log.logSync({
    order_sn: orderSn,
    pedido_bling_id: pedidoBling.id,
    nfe_id: nfeId,
    chave_acesso: nfData.chave,
    status: 'sucesso',
    etapa: 'manual_sync'
  });

  return { order_sn: orderSn, chave: nfData.chave, numero: nfData.numero, status: 'sucesso' };
}

module.exports = { ciclo, sincronizarPedido, pedidoEstaPendenteDeNf };
