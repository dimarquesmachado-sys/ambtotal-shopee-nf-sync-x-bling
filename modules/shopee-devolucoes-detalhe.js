'use strict';
// =====================================================================================================
// modules/shopee-devolucoes-detalhe.js — o que a lista de devolucoes entrega ao Devolucoes (3 lojas)
//
// 29/10 (dono, espreita da Girassol: 60 devolucoes "ACCEPTED" de julho a setembro, nenhuma com transporte, nenhuma
// bipada). Conferido na API: (1) 2607040QR2JAYU9 tem return_solution 1 = SO REEMBOLSO, o comprador fica com o produto,
// nada volta; (2) 2608180NVV0BBKA e 2609250VD88150N tem logistics_status LOGISTICS_DELIVERY_DONE = ENTREGUES. A
// rota /:loja/interno/devolucoes guardava so 8 campos (numero, pedido, status, motivo, rastreio, datas, itens) — o
// Devolucoes foi feito pra ler o transporte, mas o campo nunca chegava. E a LISTA da Shopee (get_return_list) nao traz
// o transporte (conferido 29/10): so o DETALHE (get_return_detail) traz.
// Agora: a lista passa adiante return_solution, needs_logistics e os prazos; e as devolucoes ABERTAS (nao finais, nao
// so-reembolso) ganham o transporte pelo detalhe — guardado por devolucao e so buscado de novo quando a Shopee muda
// a devolucao (update_time). Teto por atualizacao (o resto vem na proxima, a lista e refeita a cada 10 min).
// =====================================================================================================

const FINAL = /CANCELLED|CLOSED|REFUND_PAID|SELLER_COMPENSAT|DONE/i;

function normalizarDaLista(d) {
  return {
    return_sn: d.return_sn || null,
    order_sn: d.order_sn || null,
    status: d.status || null,
    reason: d.reason || null,
    tracking_number: d.tracking_number || null,
    create_time: d.create_time || null,
    update_time: d.update_time || null,
    itens: Array.isArray(d.item) ? d.item.map((i) => ({
      nome: i.name || null,
      sku: i.item_sku || i.variation_sku || null,
      qtd: i.amount || null,
    })) : [],
    // 29/10 — vem na LISTA: 1 = so reembolso (nada volta), 0 = devolucao com retorno
    return_solution: (d.return_solution === 0 || d.return_solution === 1) ? d.return_solution : null,
    needs_logistics: typeof d.needs_logistics === 'boolean' ? d.needs_logistics : null,
    return_ship_due_date: d.return_ship_due_date || null,      // ate quando o comprador tinha pra postar
    return_seller_due_date: d.return_seller_due_date || null,  // ate quando o vendedor tinha pra conferir
    // 29/10 — so vem no DETALHE (hidratado abaixo); null = nao consultado ainda
    logistics_status: null,
    reverse_logistics_status: null,
  };
}

// A devolucao precisa do detalhe? Sem rastreio: sim (a cacada de rastreio que ja existia). Final ou so-reembolso:
// nao — nao vai andar. Aberta com retorno: sim — e o transporte que diz se chegou.
function precisaDetalhe(item) {
  if (!item || !item.return_sn) return false;
  if (!item.tracking_number) return true;
  if (FINAL.test(String(item.status || ''))) return false;
  if (item.return_solution === 1) return false;
  return true;
}

function trackingDoDetalhe(det) {
  return det.tracking_number
    || (det.return_pickup && det.return_pickup.tracking_number)
    || (det.logistics && det.logistics.tracking_number)
    || (Array.isArray(det.return_tracking_info) && det.return_tracking_info[0] && det.return_tracking_info[0].tracking_number)
    || null;
}

function aplicar(item, reg) {
  item.logistics_status = reg.logistics_status || null;
  item.reverse_logistics_status = reg.reverse_logistics_status || null;
  if (!item.tracking_number && reg.tracking) item.tracking_number = reg.tracking;
}

// o: { buscarDetalhe(return_sn) -> detalhe | null, cache: Map, max, pausaMs, dorme }
// devolve { chamadas, do_cache, sem_resposta, adiadas }
async function hidratar(dados, o) {
  const cache = o.cache;
  const max = Number.isFinite(o.max) ? o.max : 40;
  const dorme = o.dorme || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let chamadas = 0, doCache = 0, semResposta = 0, adiadas = 0;
  for (const item of dados) {
    if (!precisaDetalhe(item)) continue;
    const c = cache.get(item.return_sn);
    if (c && item.update_time && c.upd === item.update_time) { aplicar(item, c); doCache++; continue; }
    if (chamadas >= max) { adiadas++; if (c) aplicar(item, c); continue; }   // o resto vem na proxima atualizacao
    if (chamadas > 0) await dorme(o.pausaMs == null ? 250 : o.pausaMs);
    chamadas++;
    let det = null;
    try { det = await o.buscarDetalhe(item.return_sn); } catch (e) { det = null; }
    if (!det) { semResposta++; if (c) aplicar(item, c); continue; }          // falhou: mantem o que ja sabia
    const reg = {
      upd: item.update_time || null,
      logistics_status: det.logistics_status || null,
      reverse_logistics_status: det.reverse_logistics_status || null,
      tracking: trackingDoDetalhe(det),
    };
    cache.set(item.return_sn, reg);
    aplicar(item, reg);
  }
  // so guarda o que ainda esta na lista (o cache nao cresce sem fim)
  const vivos = new Set(dados.map((x) => x.return_sn).filter(Boolean));
  for (const k of [...cache.keys()]) if (!vivos.has(k)) cache.delete(k);
  return { chamadas, do_cache: doCache, sem_resposta: semResposta, adiadas };
}

module.exports = { normalizarDaLista, precisaDetalhe, hidratar };
