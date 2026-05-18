// modules/sync-engine.js
// Motor de sincronizacao: ciclo principal que detecta pedidos sem NF e sincroniza

const shopee = require('./shopee-api');
const bling = require('./bling-api');
const log = require('./supabase-log');

/**
 * Heuristica pra detectar pedido sem NF na Shopee.
 *
 * Pela tela do Diego, os pedidos travados sao aqueles em status to_ship (READY_TO_SHIP)
 * que ainda nao tiveram NF-e enviada. O campo Shopee invoice_data deve estar vazio,
 * inexistente, ou ter algum flag de pendencia.
 *
 * Confirmacao depois da doc: campo provavel em get_order_detail.invoice_data:
 *   - se invoice_data == null -> sem NF
 *   - se invoice_data.invoice_pending == true -> sem NF
 *   - se invoice_data.number / invoice_data.access_key estiver presente -> NF ja enviada
 */
function pedidoEstaPendenteDeNf(orderDetail) {
  if (!orderDetail) return false;

  // Sem campo invoice_data ou vazio
  if (!orderDetail.invoice_data) return true;

  const inv = orderDetail.invoice_data;

  // Sem chave de acesso ou numero -> nao tem NF enviada
  if (!inv.access_key && !inv.number) return true;

  return false;
}

/**
 * Ciclo completo: detecta pendentes, busca NF no Bling, envia pra Shopee, dispara ship_order
 */
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

  // 1. Lista pedidos to_ship dos ultimos 3 dias
  let listaPedidos;
  try {
    listaPedidos = await shopee.listarPedidosToShip(3);
  } catch (e) {
    console.error('[sync-engine] Erro listando pedidos Shopee:', e.message);
    resultado.erro_geral = e.message;
    return resultado;
  }

  if (listaPedidos.length === 0) {
    console.log('[sync-engine] Nenhum pedido to_ship encontrado');
    return resultado;
  }

  // 2. Pega detalhes (em lotes de 50) pra ver invoice_data
  const orderSns = listaPedidos.map(p => p.order_sn);
  const detalhes = [];
  for (let i = 0; i < orderSns.length; i += 50) {
    const lote = orderSns.slice(i, i + 50);
    try {
      const det = await shopee.buscarDetalhesPedidos(lote);
      detalhes.push(...det);
    } catch (e) {
      console.error('[sync-engine] Erro detalhes Shopee lote:', e.message);
    }
  }

  // 3. Filtra os pendentes de NF
  const pendentes = detalhes.filter(pedidoEstaPendenteDeNf);
  resultado.detectados = pendentes.length;
  console.log(`[sync-engine] Detectados ${pendentes.length} pedido(s) pendente(s) de NF`);

  if (dryRun) {
    resultado.detalhes = pendentes.map(p => ({ order_sn: p.order_sn, status: 'dry_run' }));
    return resultado;
  }

  // 4. Pra cada pendente: sincroniza
  for (const ped of pendentes) {
    const orderSn = ped.order_sn;
    const item = { order_sn: orderSn };
    resultado.processados++;

    try {
      // 4a. Verifica se ja sincronizou recentemente (idempotencia)
      if (await log.jaSincronizado(orderSn, 6)) {
        item.status = 'ja_sincronizado_recente';
        resultado.detalhes.push(item);
        continue;
      }

      // 4b. Busca pedido no Bling pelo numeroLoja
      const pedidoBling = await bling.buscarPedidoPorNumeroLoja(orderSn);
      if (!pedidoBling) {
        item.status = 'pedido_bling_nao_encontrado';
        await log.logSync({ order_sn: orderSn, status: 'erro', etapa: 'detect', erro: 'pedido nao achado no Bling' });
        resultado.detalhes.push(item);
        continue;
      }
      item.pedido_bling_id = pedidoBling.id;

      // 4c. Pega NF vinculada
      const nfeId = await bling.buscarNfPorPedido(pedidoBling.id);
      if (!nfeId) {
        item.status = 'sem_nf_bling';
        await log.logSync({ order_sn: orderSn, pedido_bling_id: pedidoBling.id, status: 'sem_nf_bling', etapa: 'detect', erro: 'sem NF vinculada' });
        resultado.detalhes.push(item);
        continue;
      }
      item.nfe_id = nfeId;

      // 4d. Baixa XML autorizado
      const nfData = await bling.baixarXmlAutorizado(nfeId);
      item.chave = nfData.chave;

      // 4e. Envia pra Shopee
      await shopee.uploadInvoice(orderSn, nfData.xmlBase64, nfData.chave, nfData.numero);
      await log.logSync({
        order_sn: orderSn, pedido_bling_id: pedidoBling.id, nfe_id: nfeId,
        chave_acesso: nfData.chave, status: 'sucesso', etapa: 'upload_invoice'
      });

      // 4f. Aguarda processar (30s) e chama ship_order
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

    // Rate limit: pausa 2s entre pedidos
    await new Promise(r => setTimeout(r, 2000));
  }

  resultado.fim = new Date().toISOString();
  console.log(`[sync-engine] === Fim do ciclo: ${resultado.sucessos} sucesso, ${resultado.erros} erros ===`);
  return resultado;
}

/**
 * Sincroniza um pedido especifico (pra testes manuais)
 */
async function sincronizarPedido(orderSn) {
  console.log(`[sync-engine] Sincronizando pedido especifico: ${orderSn}`);

  // Pega detalhes desse pedido
  const detalhes = await shopee.buscarDetalhesPedidos([orderSn]);
  if (detalhes.length === 0) throw new Error('Pedido nao encontrado na Shopee');

  const ped = detalhes[0];
  const pendente = pedidoEstaPendenteDeNf(ped);

  // Reusa logica do ciclo mas forca processar mesmo se ja sincronizou
  const pedidoBling = await bling.buscarPedidoPorNumeroLoja(orderSn);
  if (!pedidoBling) throw new Error('Pedido nao encontrado no Bling');

  const nfeId = await bling.buscarNfPorPedido(pedidoBling.id);
  if (!nfeId) throw new Error('Pedido Bling sem NF vinculada');

  const nfData = await bling.baixarXmlAutorizado(nfeId);

  await shopee.uploadInvoice(orderSn, nfData.xmlBase64, nfData.chave, nfData.numero);
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
