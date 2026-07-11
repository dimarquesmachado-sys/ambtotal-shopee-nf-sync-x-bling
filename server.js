// server.js
// Shopee NF Sync - Multi-loja (AMBTotal, Girassol, GOOD Import)
// Detecta pedidos Shopee em INVOICE_PENDING e sobe a NF-e autorizada do Bling.

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const crypto = require('crypto');
const fetch = require('node-fetch');

const tokenManager = require('./modules/token-manager');
const shopee = require('./modules/shopee-api');
const engine = require('./modules/sync-engine');
const log = require('./modules/supabase-log');
const { getConfigLoja, lojasValidas, lojasConfiguradas, SHOPEE_BASE } = require('./modules/lojas');

const app = express();

// ── Chave p/ rotas sensíveis (acessadas com ?k=CHAVE na URL) ─────────────────
// Sem a env ADMIN_KEY configurada no Render, essas rotas ficam DESLIGADAS (404).
const ADMIN_KEY = process.env.ADMIN_KEY || '';
function adminOk(req) { return ADMIN_KEY && req.query.k === ADMIN_KEY; }
app.use(express.json({ limit: '5mb' }));
const PORT = process.env.PORT || 3000;

// Middleware: resolve :loja em req.loja (valida contra lojas conhecidas)
function resolverLoja(req, res, next) {
  const key = req.params.loja;
  if (!lojasValidas().includes(key)) {
    return res.status(404).json({ erro: `Loja desconhecida: ${key}. Validas: ${lojasValidas().join(', ')}` });
  }
  req.loja = getConfigLoja(key);
  next();
}

// =============================================================================
// ROTAS INFORMATIVAS
// =============================================================================

app.get('/', (req, res) => {
  res.json({
    service: 'shopee-nf-sync',
    version: '2.2.0-multiloja (indice tracking->pedido)',
    status: 'rodando',
    shopee_base_url: SHOPEE_BASE,
    timezone: process.env.TZ || 'America/Sao_Paulo',
    lojas_configuradas: lojasConfiguradas().map(l => l.key),
    lojas_disponiveis: lojasValidas(),
    endpoints: {
      status: 'GET /status',
      pendentes: 'GET /pendentes',
      setup_bling: 'POST /:loja/setup-bling  body:{code}',
      callback_shopee: 'GET /:loja/oauth/callback-shopee?code=...&shop_id=...',
      sincronizar_um: 'POST /:loja/sincronizar/:orderSn',
      sincronizar_ciclo: 'POST /sincronizar-ciclo  body:{dryRun?}',
      logs: 'GET /logs?limit=50'
    }
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// DEBUG TEMPORARIO: mostra quais env vars o sistema esta lendo (sem expor valores).
app.get('/debug-env', (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const prefixos = ['AMB_SYNC', 'GIRASSOL_SYNC', 'GOOD_SYNC'];
  const sufixos = ['_BLING_CLIENT_ID', '_BLING_CLIENT_SECRET', '_SHOPEE_PARTNER_ID', '_SHOPEE_PARTNER_KEY'];
  const out = {};
  for (const p of prefixos) {
    out[p] = {};
    for (const s of sufixos) {
      const nome = p + s;
      const val = process.env[nome];
      out[p][s] = val ? `OK (len=${val.length})` : 'AUSENTE/VAZIO';
    }
  }
  // Lista todas as chaves de env que contem SYNC, pra pegar nomes com erro de digitacao
  const todasSync = Object.keys(process.env).filter(k => k.includes('SYNC')).sort();
  res.json({ esperadas: out, todas_env_com_SYNC: todasSync });
});

// Status agregado de todas as lojas
app.get('/status', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  try {
    const out = { shopee_base_url: SHOPEE_BASE, lojas: {} };
    for (const key of lojasValidas()) {
      const loja = getConfigLoja(key);
      const configurada = !!(loja.bling.clientId && loja.shopee.partnerId);
      let bling = { configurada }, shp = { configurada };
      if (configurada) {
        const bt = tokenManager.loadTokens(loja);
        const st = shopee.loadShopeeTokens(loja);
        bling = {
          configurada: true,
          tem_access_token: !!bt.access_token,
          tem_refresh_token: !!bt.refresh_token,
          expira_em: bt.expires_at ? new Date(bt.expires_at).toISOString() : null,
          expirou: bt.expires_at < Date.now()
        };
        shp = {
          configurada: true,
          tem_access_token: !!st.access_token,
          tem_refresh_token: !!st.refresh_token,
          shop_id: st.shop_id || null,
          expira_em: st.expires_at ? new Date(st.expires_at).toISOString() : null,
          expirou: st.expires_at < Date.now()
        };
      }
      out.lojas[key] = { nome: loja.nome, bling, shopee: shp };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// =============================================================================
// SETUP / OAUTH (por loja)
// =============================================================================

app.post('/:loja/setup-bling', resolverLoja, async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ erro: 'code obrigatorio no body' });
    const tokens = await tokenManager.setupBlingWithCode(req.loja, code);
    res.json({ ok: true, loja: req.loja.key, message: 'Tokens Bling salvos', expira_em: new Date(tokens.expires_at).toISOString() });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

async function exchangeShopeeCode(loja, code, shopId) {
  const partnerId = parseInt(loja.shopee.partnerId);
  const partnerKey = loja.shopee.partnerKey;
  const apiPath = '/api/v2/auth/token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHmac('sha256', partnerKey)
    .update(`${partnerId}${apiPath}${timestamp}`).digest('hex');

  const url = `${SHOPEE_BASE}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, shop_id: parseInt(shopId), partner_id: partnerId })
  });
  const data = await r.json();
  if (data.error) throw new Error(JSON.stringify(data));

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    shop_id: String(shopId),
    expires_at: Date.now() + (data.expire_in * 1000) - 60000
  };
  shopee.saveShopeeTokens(loja, tokens);
  return tokens;
}

app.post('/:loja/setup-shopee', resolverLoja, async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  try {
    const { code, shop_id } = req.body;
    if (!code || !shop_id) return res.status(400).json({ erro: 'code e shop_id obrigatorios' });
    const tokens = await exchangeShopeeCode(req.loja, code, shop_id);
    res.json({ ok: true, loja: req.loja.key, shop_id, expira_em: new Date(tokens.expires_at).toISOString() });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Gera o link de autorizacao Shopee (com sign) e redireciona o usuario pra la.
// Basta acessar /amb/autorizar-shopee no navegador.
app.get('/:loja/autorizar-shopee', resolverLoja, (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  try {
    const loja = req.loja;
    const partnerId = parseInt(loja.shopee.partnerId);
    const partnerKey = loja.shopee.partnerKey;
    const apiPath = '/api/v2/shop/auth_partner';
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = crypto.createHmac('sha256', partnerKey)
      .update(`${partnerId}${apiPath}${timestamp}`).digest('hex');

    const host = `${req.protocol}://${req.get('host')}`;
    const redirect = `${host}/${loja.key}/oauth/callback-shopee`;

    const authUrl = `${SHOPEE_BASE}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirect)}`;
    res.redirect(authUrl);
  } catch (e) {
    res.status(500).send(`<h2>Erro ao gerar link</h2><pre>${e.message}</pre>`);
  }
});

app.get('/:loja/oauth/callback-shopee', resolverLoja, async (req, res) => {
  try {
    const { code, shop_id } = req.query;
    if (!code || !shop_id) {
      return res.status(400).send('<h2>Erro</h2><p>code e shop_id obrigatorios na URL</p>');
    }
    const tokens = await exchangeShopeeCode(req.loja, code, shop_id);
    res.send(`
      <h2>✅ Shopee autorizada com sucesso! (${req.loja.nome})</h2>
      <p><b>Loja:</b> ${req.loja.key}</p>
      <p><b>Shop ID:</b> ${shop_id}</p>
      <p><b>Token expira em:</b> ${new Date(tokens.expires_at).toISOString()}</p>
      <p>Voce pode fechar esta janela.</p>
    `);
  } catch (e) {
    res.status(500).send(`<h2>Erro na autorizacao</h2><pre>${e.message}</pre>`);
  }
});

// =============================================================================
// OPERACAO
// =============================================================================

// =============================================================================
// INTERNO (v1.6): lista as DEVOLUCOES/RETURNS da loja pro sistema
// GOOD Devolucoes casar a etiqueta bipada (tracking/return_sn/order_sn).
// Protegida por header x-internal-key (= env INTERNAL_KEY).
// Cache em memoria 10 min por loja. ?refresh=1 forca. ?bruto=1 devolve a
// resposta crua da Shopee (1a pagina) pra depurar nomes de campos.
// =============================================================================
const _cacheDevolucoesLoja = {};

app.get('/:loja/interno/devolucoes', resolverLoja, async (req, res) => {
  // v1.6.5 - esta rota e chamada MAQUINA-A-MAQUINA pelo GOOD-Devolucoes,
  // que nao conhece o ADMIN_KEY deste servico. A protecao aqui e o
  // INTERNAL_KEY (header x-internal-key) - forte e suficiente. O gate
  // adminOk foi removido (estava barrando a comunicacao com 404/403).
  const chaveRecebida = req.headers['x-internal-key'] || req.query.k || '';
  if (!process.env.INTERNAL_KEY || chaveRecebida !== process.env.INTERNAL_KEY) {
    return res.status(401).json({ ok: false, erro: 'chave interna invalida ou INTERNAL_KEY nao configurada' });
  }
  const loja = req.loja;
  try {
    // Regra da Shopee: janela maxima de 15 dias por consulta -> fatiamos
    const dias = Math.min(180, parseInt(req.query.dias, 10) || 120); // padrao 120d (devolucao atrasada existe!)
    const ate = Math.floor(Date.now() / 1000);
    const de = ate - dias * 86400;
    const FATIA = 14 * 86400; // 14d com folga (limite deles e 15)

    // Modo debug: resposta crua da 1a pagina (ground truth dos campos)
    if (req.query.bruto === '1') {
      const rb = await shopee.shopeeApiCall(loja, '/api/v2/returns/get_return_list', 'GET', null,
        `page_no=1&page_size=20&create_time_from=${ate - FATIA}&create_time_to=${ate}`);
      return res.json({ ok: rb.ok, bruto: rb.data });
    }

    // Modo debug: get_return_detail CRU de uma solicitacao especifica
    // (ex: ?detalhe=26060201CAKXTNK) - revela onde mora o tracking
    if (req.query.detalhe) {
      const rd = await shopee.shopeeApiCall(loja, '/api/v2/returns/get_return_detail', 'GET', null,
        `return_sn=${encodeURIComponent(String(req.query.detalhe).trim())}`);
      return res.json({ ok: rd.ok, detalhe_bruto: rd.data });
    }

    // v1.7.0 - Busca por PEDIDO (ex: ?pedido=260623TX31XFMT). Cobre o
    // "SPX Insucesso": entrega falha -> Shopee CANCELA o pedido e reembolsa
    // SEM criar return (comprovado: get_return_list nao traz; get_order_detail
    // traz como CANCELLED). Se o pedido existe e esta cancelado (ou com
    // itens cancelados/devolvidos), devolve no MESMO formato da lista de
    // devolucoes - o Devoluces trata igual.
    const montarDevolucaoDePedido = (ped) => {
      const cancelados = (ped.item_list || []).filter(i => (i.cancelled_qty || 0) > 0 || (i.returned_qty || 0) > 0);
      const ehRetorno = ped.order_status === 'CANCELLED' || cancelados.length > 0;
      if (!ehRetorno) return null;
      const itensBase = cancelados.length > 0 ? cancelados : (ped.item_list || []);
      return {
        return_sn: null,
        order_sn: ped.order_sn,
        status: 'CANCELLED',
        reason: 'insucesso_entrega_ou_cancelamento',
        tracking_number: ped._tracking || null,
        create_time: ped.create_time || null,
        update_time: ped.update_time || null,
        itens: itensBase.map(i => ({
          nome: i.item_name || null,
          sku: i.item_sku || i.model_sku || null,
          qtd: i.cancelled_qty || i.returned_qty || i.model_quantity_purchased || 1,
        })),
      };
    };

    if (req.query.pedido) {
      const osn = String(req.query.pedido).trim();
      const ro = await shopee.shopeeApiCall(loja, '/api/v2/order/get_order_detail', 'GET', null,
        `order_sn_list=${encodeURIComponent(osn)}&response_optional_fields=item_list,total_amount,order_status`);
      if (req.query.bruto === '1') return res.json({ ok: ro.ok, pedido_bruto: ro.data });
      const ped = ro.ok ? (ro.data?.response?.order_list || [])[0] : null;
      if (!ped) return res.json({ ok: true, encontrado: false, motivo: 'pedido nao existe nesta loja' });
      const dev = montarDevolucaoDePedido(ped);
      if (!dev) {
        return res.json({ ok: true, encontrado: false, motivo: `pedido existe mas status=${ped.order_status} sem itens cancelados/devolvidos - nao parece retorno` });
      }
      return res.json({ ok: true, encontrado: true, tipo: 'pedido_cancelado', devolucao: dev });
    }

    // v2.2.0 - Busca por TRACKING (ex: ?tracking=BR264193185445G). O BR
    // impresso na etiqueta de INSUCESSO e o rastreio do pedido original -
    // a Shopee nao tem busca reversa, entao construimos um INDICE dos
    // pedidos CANCELADOS recentes (tracking -> order_sn), cacheado 30min.
    // Extracao do tracking: package_list do detail + fallback
    // logistics/get_tracking_number (1 call so pra quem faltar).
    if (req.query.tracking) {
      const alvoTrk = String(req.query.tracking).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!alvoTrk || alvoTrk.length < 8) {
        return res.json({ ok: true, encontrado: false, motivo: 'tracking invalido' });
      }
      const diasIdx = Math.min(90, parseInt(req.query.dias, 10) || 60);
      if (!global._idxTrackingCancelados) global._idxTrackingCancelados = {};
      let idx = global._idxTrackingCancelados[loja.key];
      const idxVelho = !idx || (Date.now() - idx.ts) > 30 * 60 * 1000;

      if (idxVelho || req.query.refresh === '1') {
        const agora = Math.floor(Date.now() / 1000);
        const FATIA_T = 14 * 86400;
        const detalhesPorSn = {};
        let fimT = agora;
        // 1) lista pedidos CANCELLED em fatias de 14d
        while (fimT > agora - diasIdx * 86400) {
          const iniT = Math.max(agora - diasIdx * 86400, fimT - FATIA_T);
          let cursor = '';
          for (let pg = 0; pg < 6; pg++) {
            await new Promise(s => setTimeout(s, 250));
            const rl = await shopee.shopeeApiCall(loja, '/api/v2/order/get_order_list', 'GET', null,
              `time_range_field=create_time&time_from=${iniT}&time_to=${fimT}&page_size=100&order_status=CANCELLED${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
            if (!rl.ok) break;
            for (const o of (rl.data?.response?.order_list || [])) detalhesPorSn[o.order_sn] = null;
            if (!rl.data?.response?.more) break;
            cursor = rl.data?.response?.next_cursor || '';
            if (!cursor) break;
          }
          fimT = iniT - 1;
        }
        // 2) detail em lotes de 50 (item_list + package_list p/ tracking)
        const sns = Object.keys(detalhesPorSn);
        for (let i = 0; i < sns.length; i += 50) {
          await new Promise(s => setTimeout(s, 300));
          const lote = sns.slice(i, i + 50);
          const rd = await shopee.shopeeApiCall(loja, '/api/v2/order/get_order_detail', 'GET', null,
            `order_sn_list=${encodeURIComponent(lote.join(','))}&response_optional_fields=item_list,order_status,package_list`);
          for (const ped of (rd.ok ? (rd.data?.response?.order_list || []) : [])) {
            // caca o tracking em todos os ninhos conhecidos
            const cand = [];
            for (const p of (ped.package_list || [])) {
              if (p.logistics_tracking_number) cand.push(p.logistics_tracking_number);
              if (p.tracking_number) cand.push(p.tracking_number);
            }
            if (ped.tracking_number) cand.push(ped.tracking_number);
            ped._tracking = cand.find(Boolean) || null;
            detalhesPorSn[ped.order_sn] = ped;
          }
        }
        // 3) fallback get_tracking_number pra quem ficou sem
        const semTrk = Object.values(detalhesPorSn).filter(p => p && !p._tracking).slice(0, 40);
        for (const ped of semTrk) {
          await new Promise(s => setTimeout(s, 250));
          const rt = await shopee.shopeeApiCall(loja, '/api/v2/logistics/get_tracking_number', 'GET', null,
            `order_sn=${encodeURIComponent(ped.order_sn)}`);
          const tn = rt.ok ? rt.data?.response?.tracking_number : null;
          if (tn) ped._tracking = tn;
        }
        // 4) monta o mapa tracking -> pedido
        const mapa = {};
        for (const ped of Object.values(detalhesPorSn)) {
          if (ped && ped._tracking) {
            mapa[String(ped._tracking).toUpperCase().replace(/[^A-Z0-9]/g, '')] = ped;
          }
        }
        idx = { ts: Date.now(), mapa, total: sns.length, comTracking: Object.keys(mapa).length };
        global._idxTrackingCancelados[loja.key] = idx;
        console.log(`[interno/devolucoes][${loja.key}] indice tracking: ${idx.comTracking}/${idx.total} cancelados com rastreio (${diasIdx}d)`);
      }

      const ped = idx.mapa[alvoTrk];
      if (!ped) {
        return res.json({ ok: true, encontrado: false, indice: { cancelados: idx.total, com_tracking: idx.comTracking, dias: diasIdx }, motivo: 'tracking nao esta entre os pedidos cancelados recentes' });
      }
      const dev = montarDevolucaoDePedido(ped);
      return res.json({ ok: true, encontrado: !!dev, tipo: 'pedido_cancelado_via_tracking', devolucao: dev });
    }

    // v1.6.6 - Modo debug: procura um codigo (order_sn/tracking) em TODA a
    // lista crua de devolucoes, varrendo N dias com refresh, e diz se achou
    // + em qual fatia. (ex: ?procurar=260623TX31XFMT&dias=180)
    if (req.query.procurar) {
      const alvo = String(req.query.procurar).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      const diasP = Math.min(180, parseInt(req.query.dias, 10) || 150);
      const ateP = Math.floor(Date.now() / 1000);
      const FATIA_P = 14 * 86400;
      const achados = [];
      let total = 0;
      let fim = ateP;
      let base = 0;
      const norm = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      while (fim > ateP - diasP * 86400) {
        const ini = Math.max(ateP - diasP * 86400, fim - FATIA_P);
        for (let idx = 0; idx <= 6; idx++) {
          await new Promise(s => setTimeout(s, 250));
          const r = await shopee.shopeeApiCall(loja, '/api/v2/returns/get_return_list', 'GET', null,
            `page_no=${base + idx}&page_size=100&create_time_from=${ini}&create_time_to=${fim}`);
          if (!r.ok) {
            if (idx === 0 && base === 0 && /page/i.test(JSON.stringify(r.data || {}))) { base = 1; idx = -1; continue; }
            break;
          }
          const lista = r.data?.response?.return || [];
          total += lista.length;
          for (const d of lista) {
            if ([d.return_sn, d.order_sn, d.tracking_number].some(v => norm(v) === alvo || norm(v).includes(alvo))) {
              achados.push({ return_sn: d.return_sn, order_sn: d.order_sn, tracking_number: d.tracking_number, status: d.status, fatia: new Date(ini * 1000).toISOString().slice(0, 10) + '..' + new Date(fim * 1000).toISOString().slice(0, 10) });
            }
          }
          if (!r.data?.response?.more || lista.length === 0) break;
        }
        fim = ini - 1;
      }
      return res.json({ ok: true, alvo, dias: diasP, total_devolucoes_varridas: total, achados, encontrado: achados.length > 0 });
    }

    const cache = _cacheDevolucoesLoja[loja.key];
    if (req.query.refresh !== '1' && cache && (Date.now() - cache.ts) < 10 * 60 * 1000) {
      return res.json({ ok: true, cache: true, qtd: cache.dados.length, devolucoes: cache.dados });
    }

    const todos = [];
    let fimFatia = ate;
    let basePagina = 0; // v1.6.4: get_return_list pagina do 0 em varias contas; detecta sozinho
    let primeiraCrua = null; // amostra pro auto-diagnostico quando vier vazio
    while (fimFatia > de) {
      const iniFatia = Math.max(de, fimFatia - FATIA);
      for (let idx = 0; idx <= 6; idx++) {
        const pagina = basePagina + idx;
        await new Promise(s => setTimeout(s, 250));
        const r = await shopee.shopeeApiCall(loja, '/api/v2/returns/get_return_list', 'GET', null,
          `page_no=${pagina}&page_size=100&create_time_from=${iniFatia}&create_time_to=${fimFatia}`);
        if (!r.ok) {
          const msg = JSON.stringify(r.data || {});
          if (idx === 0 && basePagina === 0 && /page/i.test(msg)) {
            // API desta conta e 1-based: ajusta e repete a fatia
            basePagina = 1;
            idx = -1;
            continue;
          }
          return res.status(502).json({ ok: false, erro: 'Shopee get_return_list: ' + msg.slice(0, 400) });
        }
        if (!primeiraCrua) primeiraCrua = r.data;
        const lista = r.data?.response?.return || [];
        todos.push(...lista);
        if (!r.data?.response?.more || lista.length === 0) break;
      }
      fimFatia = iniFatia - 1; // proxima fatia (mais antiga), sem sobrepor
    }

    // dedup de fronteira (garantia)
    const _vistos = new Set();
    const unicos = todos.filter(d => {
      const k = d.return_sn || d.order_sn || JSON.stringify(d).slice(0, 60);
      if (_vistos.has(k)) return false;
      _vistos.add(k);
      return true;
    });

    const dados = unicos.map(d => ({
      return_sn: d.return_sn || null,
      order_sn: d.order_sn || null,
      status: d.status || null,
      reason: d.reason || null,
      tracking_number: d.tracking_number || null,
      create_time: d.create_time || null,
      update_time: d.update_time || null,
      itens: Array.isArray(d.item) ? d.item.map(i => ({
        nome: i.name || null,
        sku: i.item_sku || i.variation_sku || null,
        qtd: i.amount || null,
      })) : [],
    }));

    // Hidrata tracking faltante pelo get_return_detail (poucos casos).
    // Caca o tracking em campos alternativos - a Shopee varia o ninho.
    const semTracking = dados.filter(x => !x.tracking_number && x.return_sn).slice(0, 60);
    for (const item of semTracking) {
      await new Promise(s => setTimeout(s, 250));
      const rd = await shopee.shopeeApiCall(loja, '/api/v2/returns/get_return_detail', 'GET', null,
        `return_sn=${encodeURIComponent(item.return_sn)}`);
      const det = rd.ok ? rd.data?.response : null;
      if (!det) continue;
      const candidato = det.tracking_number
        || (det.return_pickup && det.return_pickup.tracking_number)
        || (det.logistics && det.logistics.tracking_number)
        || (Array.isArray(det.return_tracking_info) && det.return_tracking_info[0] && det.return_tracking_info[0].tracking_number)
        || null;
      if (candidato) {
        item.tracking_number = candidato;
      } else {
        console.log(`[interno/devolucoes][${loja.key}] ${item.return_sn}: detail sem tracking. Campos: ${Object.keys(det).join(',').slice(0, 300)}`);
      }
    }

    _cacheDevolucoesLoja[loja.key] = { ts: Date.now(), dados };
    console.log(`[interno/devolucoes][${loja.key}] ${dados.length} devolucoes (${dias}d, base pag ${basePagina})`);
    const resposta = { ok: true, cache: false, qtd: dados.length, devolucoes: dados };
    if (dados.length === 0 && primeiraCrua) {
      // Auto-diagnostico: mostra a resposta CRUA da Shopee pra revelar
      // nomes de campos diferentes do esperado
      resposta.debug_amostra_crua = primeiraCrua;
    }
    res.json(resposta);
  } catch (e) {
    console.error(`[interno/devolucoes][${loja.key}] erro:`, e.message);
    res.status(500).json({ ok: false, erro: e.message || String(e) });
  }
});

// Pendentes de todas as lojas (dry run)
app.get('/pendentes', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  try {
    const r = await engine.cicloTodasLojas({ dryRun: true });
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Sincroniza um pedido especifico de uma loja
app.post('/:loja/sincronizar/:orderSn', resolverLoja, async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  try {
    const r = await engine.sincronizarPedido(req.loja.key, req.params.orderSn);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Roda ciclo completo de todas as lojas
app.post('/sincronizar-ciclo', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  try {
    const dryRun = req.body?.dryRun === true;
    const r = await engine.cicloTodasLojas({ dryRun });
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/logs', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  try {
    const limit = parseInt(req.query.limit) || 50;
    const r = await log.ultimasExecucoes(limit);
    res.json(r);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// =============================================================================
// CRON
// =============================================================================

// Trava simples: evita que dois disparos rodem o ciclo ao mesmo tempo
// (importante porque os dois agendamentos se sobrepoem em alguns minutos).
let cicloRodando = false;

async function dispararCiclo(origem) {
  if (cicloRodando) {
    console.log(`[cron][${origem}] Ciclo anterior ainda rodando, pulando este disparo`);
    return;
  }
  cicloRodando = true;
  console.log(`[cron][${origem}] Disparando ciclo de todas as lojas`);
  try {
    await engine.cicloTodasLojas({ dryRun: false });
  } catch (e) {
    console.error(`[cron][${origem}] Erro no ciclo:`, e.message);
  } finally {
    cicloRodando = false;
  }
}

// Janela CRITICA do motoboy: 11h-13h, a cada 5 min (cobre 12:00, 12:05, 12:10, 12:15)
const CRON_CRITICO = '*/5 11-12 * * *';
cron.schedule(CRON_CRITICO, () => dispararCiclo('critico-5min'), { timezone: 'America/Sao_Paulo' });

// Resto do dia: 24h, a cada 10 min.
// (Nos minutos multiplos de 10 dentro da janela critica, a trava evita execucao dupla.)
const CRON_NORMAL = '*/10 * * * *';
cron.schedule(CRON_NORMAL, () => dispararCiclo('normal-10min'), { timezone: 'America/Sao_Paulo' });

console.log(`[cron] Agendado CRITICO: ${CRON_CRITICO} | NORMAL: ${CRON_NORMAL} (America/Sao_Paulo)`);

app.listen(PORT, () => {
  console.log(`[server] shopee-nf-sync multi-loja rodando na porta ${PORT}`);
  console.log(`[server] SHOPEE_SYNC_BASE_URL: ${SHOPEE_BASE}`);
  console.log(`[server] Lojas configuradas: ${lojasConfiguradas().map(l => l.key).join(', ') || 'NENHUMA'}`);
});
