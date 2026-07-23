// ============================================================
// GOOD Devolucoes - Marketplaces - NFs
// Fase 3.6: Triagem (estoquista), area admin, email, fotos
// ============================================================

const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// === ML / Bling / Render (Fase 1+2) ===
// Movidos para modulos em lib/ na v3.15.3
const blingClient = require('./lib/bling');
const mlClient = require('./lib/ml');

// v3.16.0 - Dashboard de relatorios
const registrarRotasRelatorios = require('./lib/rotas-relatorios');

// Re-exports pra manter mesma sintaxe nas chamadas existentes
const chamarBling = blingClient.chamarBling;
const renovarTokenBling = blingClient.renovarTokenBling;
const buscarPedidoBlingPorNumeroLoja = blingClient.buscarPedidoBlingPorNumeroLoja;
const buscarPedidoBlingPorId = blingClient.buscarPedidoBlingPorId;
const buscarNFePorId = blingClient.buscarNFePorId;
const buscarNFnoBlingPorNumero = blingClient.buscarNFnoBlingPorNumero;
const buscarNFnoBlingPorOrderId = blingClient.buscarNFnoBlingPorOrderId;
const buscarNFBlindada = blingClient.buscarNFBlindada;

// v3.30 - itens da NF no formato salvo em devolucoes.nf_itens (jsonb)
// v3.43 - helpers NF/pessoa/municipio movidos p/ lib/nf-pessoa.js
// (instanciados abaixo, apos chamarBling e sleep existirem)
const buscarProdutoBlingPorSku = blingClient.buscarProdutoBlingPorSku;
const trocarCodePorTokenBling = blingClient.trocarCodePorTokenBling;
const chamarML = mlClient.chamarML;
const renovarTokenML = mlClient.renovarTokenML;
const buscarNFnoML = mlClient.buscarNFnoML;

const ML_USER_ID = process.env.ML_USER_ID;

// === FASE 3: Supabase + Email + Auth ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

// ============================================================
// v3.41 - SHOPEE extraida para lib/shopee-proxy.js (enxugamento)
const shopee = require('./lib/shopee-proxy');

// v3.52 - MAGALU: devolucao la e um TICKET de pos-venda com "remessa reversa".
// OAuth 2.0 via ID Magalu; tokens persistidos nas env vars do Render.
const { atualizarTokensNoRender: _attRender } = require('./lib/render-tokens');
const magalu = require('./lib/magalu')({ atualizarTokensNoRender: _attRender });

// v3.65 - CORREIOS REVERSO: devolucoes ML "por agencia" chegam com etiqueta
// dos Correios (AD/AP...BR). O indice claims->returns mapeia esse rastreio
// de volta pra venda. ~95% das devolucoes Correios do GOOD sao ML.
const mlReturns = require('./lib/ml-returns')({ chamarML });

// v3.71 - busca de NF pelo NOME do remetente (etiquetas Correios da Amazon
// etc). O nome vem COLADO na etiqueta (RENATONEVES) - o indice colapsa os
// nomes do Bling tambem e compara colapsado com colapsado.
const nfNomes = require('./lib/nf-nomes')({ chamarBling });

// v3.76 - devolucoes ESPERADAS do portal Magalu Entregas (indice 'a espreita')
const espreita = require('./lib/magalu-espreita')({ chamarMagalu: magalu.chamarMagalu });

// ── Chave p/ rotas de diagnóstico/admin/setup (acessadas com ?k=CHAVE na URL) ──
// Sem a env ADMIN_KEY configurada no Render, essas rotas ficam DESLIGADAS (404).
const ADMIN_KEY = process.env.ADMIN_KEY || '';
function adminOk(req) { return ADMIN_KEY && req.query.k === ADMIN_KEY; }

shopee.iniciarPreAquecimento();

const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '465', 10);
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = process.env.EMAIL_TO;
const mailer = (EMAIL_HOST && EMAIL_USER && EMAIL_PASS) ? nodemailer.createTransport({
  host: EMAIL_HOST,
  port: EMAIL_PORT,
  secure: EMAIL_PORT === 465,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
}) : null;

// USERS=Diego:senha,Lucas:senha,Ygor:senha,Adriano:senha
function parseUsers(envStr) {
  if (!envStr) return {};
  const out = {};
  envStr.split(',').forEach(p => {
    const [u, s] = p.split(':');
    if (u && s) out[u.trim()] = s.trim();
  });
  return out;
}
const USERS = parseUsers(process.env.USERS || '');
const ADMIN_USER = process.env.ADMIN_USER || null; // nome do usuario admin (deve estar no USERS tb)

// Sessoes em memoria (token -> {usuario, criado, tipo})
const sessoes = new Map();
function novaSessao(usuario, tipo = 'estoquista') {
  const token = crypto.randomBytes(24).toString('hex');
  sessoes.set(token, { usuario, tipo, criado: Date.now() });
  return token;
}
function validarSessao(token, tipoEsperado = null) {
  if (!token) return null;
  const s = sessoes.get(token);
  if (!s) return null;
  // Sessao expira em 12h
  if (Date.now() - s.criado > 12 * 60 * 60 * 1000) {
    sessoes.delete(token);
    return null;
  }
  if (tipoEsperado && s.tipo !== tipoEsperado) return null;
  return s;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// v3.43 - modulo nf-pessoa (deps ja existem acima)
const nfp = require('./lib/nf-pessoa')({ chamarBling, sleep });
const {
  mapItensNF,
  resolverIdNFPorChave,
  buscarNFsPorNumero,
  formatarCpfCnpj,
  detectarTipoPessoa,
  buscarIdMunicipioIBGE,
  buscarIdMunicipioPorCep,
} = nfp;

// Multer pra receber uploads de fotos (em memoria, 6 MB max por foto)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
});

app.use(express.json({ limit: '12mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), {
  // v3.64 - HTML sempre revalida (celular segurava js velho em cache; agora
  // o HTML fresco traz os ?v= novos e os scripts recarregam sozinhos).
  setHeaders: (res, caminho) => {
    if (caminho.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Middleware de log basico
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ============================================================
// HELPERS ML claims/orders
// ============================================================
// v3.42 - helpers de busca ML extraidos para lib/ml-buscas.js
const mlBuscas = require('./lib/ml-buscas')(chamarML);
const {
  extrairClaimsDaResposta,
  buscarClaimsPorShipment,
  buscarOrderViaShipmentReturn,
  buscarClaimDetalhada,
  buscarReturnPorClaim,
  buscarOrdersPorComprador,
} = mlBuscas;

// ============================================================
// ROTAS
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'good-devolucoes-marketplaces-nfsbling',
    version: '3.76 (indice a espreita - devolucoes esperadas Magalu)',
    integrations: {
      ml: mlClient.hasToken(),
      bling: blingClient.hasToken(),
      render_persist: !!((process.env.RENDER_API_KEY || process.env.RENDER_API_KEY_v2) && (process.env.RENDER_SERVICE_ID || process.env.RENDER_SERVICE_ID_v2)),
      supabase: !!supabase,
      email: !!mailer,
      auth: Object.keys(USERS).length > 0,
      admin: !!(ADMIN_USER && USERS[ADMIN_USER]),
    },
    usuarios_cadastrados: Object.keys(USERS),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// v3.18.1 - KEEPALIVE: rota publica que toca no Supabase
// Pra evitar que o projeto free-tier pause apos 7 dias de inatividade.
// Configurar cron-job.org pra bater nessa URL a cada 3-5 dias.
// Faz um SELECT minimo (count) na tabela devolucoes - rapido e barato.
// ============================================================
app.get('/api/keepalive', async (req, res) => {
  const inicio = Date.now();
  if (!supabase) {
    return res.status(500).json({ ok: false, erro: 'Supabase nao configurado' });
  }
  try {
    // Query minima que toca no banco (count nao baixa dados, so contagem)
    const { count, error } = await supabase
      .from('devolucoes')
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error('[KEEPALIVE] erro:', error.message);
      return res.status(500).json({ ok: false, erro: error.message });
    }

    const tempoMs = Date.now() - inicio;
    console.log(`[KEEPALIVE] OK - ${count} devolucoes no banco - ${tempoMs}ms`);
    return res.json({
      ok: true,
      total_devolucoes: count,
      tempo_ms: tempoMs,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[KEEPALIVE] erro:', err.message);
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// ROTA PRINCIPAL - SO ML (rapido!)
// ============================================================
app.get('/api/devolucao/identificar/:codigo', requerLogin, async (req, res) => {
  const codigoOriginal = String(req.params.codigo || '').trim();

  if (!codigoOriginal) {
    return res.status(400).json({ ok: false, erro: 'Codigo nao informado' });
  }

  console.log(`\n========== NOVA BUSCA: ${codigoOriginal} ==========`);

  // v3.62 - QR da etiqueta MAGALU: um JSON com external_grouper_code (= o
  // PROTOCOLO do ticket, que o indice Magalu ja resolve na hora), alem de
  // external_code e tag_code (o codigo de barras 196634440-01). Formato
  // decodificado de etiqueta real. Detecta e extrai o protocolo ANTES de
  // qualquer outra coisa - o bipe do QR vira busca instantanea.
  let origemQrMagalu = false;
  let codigoLimpo = codigoOriginal.replace(/[^0-9]/g, '');
  if (/external_grouper_code|tag_code|logistical_flow/i.test(codigoOriginal)) {
    let proto = null;
    try {
      const j = JSON.parse(codigoOriginal);
      proto = String(j.external_grouper_code || '').replace(/\D/g, '');
    } catch (e) {
      // leitor USB pode mutilar o JSON (layout de teclado): o protocolo e o
      // unico numerao de 16 digitos comecando com o ano (20...)
      const m = codigoOriginal.match(/20\d{14}/);
      if (m) proto = m[0];
    }
    if (proto) {
      codigoLimpo = proto;
      origemQrMagalu = true;
      console.log(`[BUSCA] QR MAGALU detectado → protocolo ${proto}`);
    }
  }

  // v3.39 - QR das etiquetas ML vem como {"id":"47416667668","t":"lm"}
  // (leitor USB cospe o JSON cru no campo). Extrai o id e ja sabemos
  // que e ML - se o shipment nao existir, falha RAPIDO com orientacao
  // (padrao de devolucao FULL) em vez de vagar pela cascata.
  let origemQrML = false;
  let mQrML = origemQrMagalu ? null : codigoOriginal.match(/["']?[ïi]d["']?\s*[:=]\s*["']?(\d{8,20})/i);
  if (!origemQrMagalu && !mQrML && /^\{|"?t"?\s*[:=]\s*"?lm/i.test(codigoOriginal)) {
    // leitor mutilou o "id" (layout de teclado): pesca o unico numerao
    const runs = codigoOriginal.match(/\d{8,20}/g) || [];
    if (runs.length === 1) mQrML = [null, runs[0]];
  }
  if (mQrML) {
    codigoLimpo = mQrML[1];
    origemQrML = true;
    console.log(`[BUSCA] QR do ML detectado → shipment ${codigoLimpo}`);
  }

  const resultado = {
    codigo_buscado: codigoOriginal,
    codigo_limpo: codigoLimpo,
    tentativas: [],
    encontrado: false,
    avisos: [],
  };

  let shipment = null;
  let order = null;
  let pack = null;
  let claim = null;
  let returnData = null;
  let metodoUsado = null;

  // v3.47.2 - PISTA SPX (nao atalho destrutivo!): codigo BR + 12+ digitos +
  // 1 letra final e o padrao da etiqueta Shopee SPX. Correios tb comeca com
  // BR mas TERMINA em "BR" (2 letras) - e ML usa Correios. Entao aqui a
  // regra e CONSERVADORA: se parece SPX, a Shopee e tentada PRIMEIRO (mais
  // abaixo). Mas o ML NUNCA e eliminado - se a Shopee nao achar, a cascata
  // ML roda igual. Nenhum caminho e perdido (insucesso ML existe!).
  const pistaSPX = /^BR\d{11,}[A-Z]$/i.test(codigoOriginal.trim());

  // v3.47.2 - Quando o codigo tem PISTA de SPX (BR+12dig+1letra), tenta a
  // Shopee JA AQUI (antes da cascata ML), pra o bipe de insucesso Shopee
  // responder rapido sem os 404 de shipment/pack. MAS se a Shopee nao achar,
  // NAO retorna - deixa a cascata ML rodar normal logo abaixo (insucesso ML
  // usa etiqueta Correios, que tb comeca com BR). Nenhum caminho e perdido.
  if (pistaSPX && shopee.cfg.ativo) {
    try {
      const infoSPX = await shopee.acharDevolucao(codigoOriginal);
      if (infoSPX && infoSPX.hit) {
        resultado.tentativas.push({ tipo: 'shopee_return', v: 'spx-first', codigo: codigoOriginal, ok: true, status: 200, lista_qtd: infoSPX.qtd });
        const dev = infoSPX.hit;
        // reaproveita o MESMO tratamento shopee da cascata (montagem + NF)
        returnData = dev;
        metodoUsado = 'shopee_return';
        resultado._shopeeDev = dev; // sinaliza pro bloco shopee abaixo pular a re-busca
      } else {
        resultado.tentativas.push({ tipo: 'shopee_return', v: 'spx-first', codigo: codigoOriginal, ok: false, status: 404, lista_qtd: infoSPX ? infoSPX.qtd : null, nota: 'nao achou na Shopee - seguindo cascata ML (pode ser insucesso ML/Correios)' });
      }
    } catch (e) {
      resultado.tentativas.push({ tipo: 'shopee_return', v: 'spx-first', codigo: codigoOriginal, ok: false, status: 500, erro: e.message || String(e) });
    }
  }

  // MAGALU-FIRST (v3.63): QR da etiqueta ou protocolo digitado (16 digitos
  // comecando com o ano) vao DIRETO pro Magalu - sem gastar tempo na
  // cascata ML (16 digitos caia como "pack ML" e esperava 404s a toa).
  const pistaMagalu = origemQrMagalu || /^20\d{14}$/.test(codigoLimpo);
  if (pistaMagalu) {
    if (await tentarDevolucaoMagalu()) return;
  }

  // CORREIOS REVERSO (v3.65): AD/AP...BR = devolucao por agencia. O codigo
  // e o rastreio da VOLTA (nao e shipment ML). O indice claims->returns
  // resolve tracking -> order -> preenche o shipment de IDA e o fluxo ML
  // existente faz o resto (buyer, NF, triagem, duplicata por shipment).
  const mCorreios = String(codigoOriginal || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{2}\d{9}BR)$/);
  if (!shipment && !pack && mCorreios) {
    const trk = mCorreios[1];
    let devML = null;
    try { devML = await mlReturns.acharPorTracking(trk); } catch (e) { devML = null; }
    resultado.tentativas.push({ tipo: 'correios_reverso_ml', codigo: trk, ok: !!(devML && devML.order_id), status: devML ? 200 : 404 });

    if (devML && devML.order_id) {
      console.log(`[BUSCA] CORREIOS ${trk} -> claim ${devML.claim_id} -> order ${devML.order_id}`);
      const rO = await chamarML(`https://api.mercadolibre.com/orders/${devML.order_id}`);
      const shipIdIda = rO.ok ? rO.data?.shipping?.id : null;
      // v3.70 - o order do claim JA veio completo (comprador, itens): entrega
      // ao fluxo em vez de deixar o downstream refazer a busca (e falhar).
      if (rO.ok && rO.data?.id) order = rO.data;
      if (shipIdIda) {
        const rS = await chamarML(`https://api.mercadolibre.com/shipments/${shipIdIda}`, { 'x-format-new': 'true' });
        if (rS.ok && rS.data?.id) { shipment = rS.data; metodoUsado = 'correios_reverso_ml'; }
      }
      resultado.ml_return = {
        tracking: trk, claim_id: devML.claim_id,
        shipment_devolucao: devML.shipment_devolucao, status_devolucao: devML.status_devolucao,
      };
      resultado.eh_devolucao = true;
      resultado.avisos.push({ tipo: 'correios_ml', mensagem: `Devolucao ML via CORREIOS (${trk}) - claim ${devML.claim_id}${devML.status_devolucao ? ' (' + devML.status_devolucao + ')' : ''}` });
      if (!shipment) {
        resultado.erro = `Rastreio ${trk} achou a devolucao ML (claim ${devML.claim_id}, pedido ${devML.order_id}) mas falhou ao carregar o pedido. Tente digitar o pedido, ou identifique pela NF.`;
        return res.status(404).json(resultado);
      }
    } else {
      // Sem match: orientacao clara (nao vaga pela cascata - 9 digitos
      // limpos cairiam na bissecao de NF e perderiam tempo a toa).
      resultado.erro = `Rastreio CORREIOS ${trk} nao encontrado nas devolucoes ML recentes${devML && devML.claim_id ? ` (claim ${devML.claim_id} sem pedido vinculado)` : ''}. Pode ser devolucao de OUTRO marketplace orientada pelos Correios (Shopee, TikTok...) - confira o REMETENTE na etiqueta, ou bipe a chave da DANFE se a nota vier na caixa.`;
      return res.status(404).json(resultado);
    }
  }

  // ML T1: shipment_id
  if (!returnData && codigoLimpo.length >= 10 && codigoLimpo.length <= 13) {
    const r = await chamarML(
      `https://api.mercadolibre.com/shipments/${codigoLimpo}`,
      { 'x-format-new': 'true' }
    );
    resultado.tentativas.push({
      tipo: 'shipment_id', codigo: codigoLimpo,
      ok: r.ok, status: r.status, erro: r.ok ? null : r.error,
    });
    if (r.ok && r.data?.id) {
      shipment = r.data;
      metodoUsado = 'shipment_id';
    }
  }

  // ML T2: pack_id
  if (!returnData && !shipment) {
    const possiveis = [];
    if (codigoLimpo.length >= 15) possiveis.push(codigoLimpo);
    if (codigoLimpo.length === 11) possiveis.push('20000' + codigoLimpo);

    for (const packId of possiveis) {
      const r = await chamarML(`https://api.mercadolibre.com/packs/${packId}`);
      resultado.tentativas.push({
        tipo: 'pack_id', codigo: packId,
        ok: r.ok, status: r.status, erro: r.ok ? null : r.error,
      });
      if (r.ok && r.data?.id) {
        pack = r.data;
        metodoUsado = 'pack_id';
        if (pack.shipment?.id) {
          const rShip = await chamarML(
            `https://api.mercadolibre.com/shipments/${pack.shipment.id}`,
            { 'x-format-new': 'true' }
          );
          if (rShip.ok) shipment = rShip.data;
        }
        break;
      }
    }
  }

  // ===== QR-ML sem shipment (v3.39): falha RAPIDA com orientacao =====
  // Etiqueta era do ML (QR) mas a API nao achou o envio por esse id.
  // Nao adianta vagar por chave/Shopee: responde em segundos com os
  // caminhos certos (a etiqueta fisica tem barras E Pack ID impressos).
  if (!shipment && !pack && origemQrML) {
    const stShip = (resultado.tentativas.find(t => t.tipo === 'shipment_id') || {}).status;
    if (stShip === 403) {
      resultado.erro = `QR do ML lido (shipment ${codigoLimpo}) mas a API RECUSOU o acesso (403). Duas causas possíveis: token do ML expirado (teste com um shipment antigo — se também der 403, avise o Diego) OU devolução recém-criada que o ML ainda não liberou (tente de novo em algumas horas). Enquanto isso: digite o Pack ID impresso na etiqueta (2000...).`;
    } else {
      resultado.erro = `QR do ML lido (shipment ${codigoLimpo}) mas a API não achou esse envio. Na MESMA etiqueta: (1) bipe o CÓDIGO DE BARRAS grande, ou (2) digite o Pack ID impresso (2000...). Se for devolução FULL (endereçada ao CD do ML), use a chave da DANFE ou ➕ Lançar por NF.`;
    }
    resultado.qr_ml_sem_shipment = true;
    return res.status(404).json(resultado);
  }

  // ===== CHAVE NF-e (v3.34): bipou a chave de 44 digitos da DANFE =====
  // Cobre devolucao com a embalagem original (qualquer marketplace) e o
  // caso Shopee "recusa/insucesso" que volta com a etiqueta de IDA.
  // v3.50 - NF por CHAVE (44 digitos) OU por NUMERO (4-9 digitos, ex: 75053).
  // O numero da NF cai num vao livre da cascata: ML shipment usa 10-13,
  // pack usa 15+, chave usa 44. Aceita tambem "75053/2" ou "75053-2" pra
  // escolher a serie (default: serie 1, o padrao da casa).
  const ehChaveNFe = codigoLimpo.length === 44;
  const mNumSerie = String(codigoOriginal || '').trim().match(/^(\d{4,9})\s*[\/\-]\s*(\d{1,3})$/);
  const ehNumeroNF = !ehChaveNFe && (mNumSerie || /^\d{4,9}$/.test(codigoLimpo));

  if (!shipment && !pack && (ehChaveNFe || ehNumeroNF)) {
    let numeroDaChave, serieDaChave, idNF = null, tipoTentativa;

    if (ehChaveNFe) {
      const modelo = codigoLimpo.substr(20, 2);
      if (modelo !== '55') {
        // DACE/DC-e do transporte (modelo 99) e afins: nao e a NF do produto
        resultado.erro = `Isso e uma chave de documento de TRANSPORTE (modelo ${modelo}), nao a NF do produto. Bipe a chave da DANFE do produto ou o codigo de rastreio.`;
        resultado.tentativas.push({ tipo: 'chave_danfe', codigo: codigoLimpo, ok: false, status: 422 });
        return res.status(404).json(resultado);
      }
      numeroDaChave = String(parseInt(codigoLimpo.substr(25, 9), 10));
      serieDaChave = String(parseInt(codigoLimpo.substr(22, 3), 10));
      tipoTentativa = 'chave_danfe';
      console.log(`[BUSCA] CHAVE DANFE: serie=${serieDaChave} numero=${numeroDaChave}`);
      try { idNF = await resolverIdNFPorChave(numeroDaChave, codigoLimpo); } catch (e) { idNF = null; }
    } else {
      // Numero da NF digitado. MULTI-SERIE: a casa emite em varias series
      // (1=normal, 2=ML FULL, outras p/ Magalu/Amazon FULL) e o MESMO numero
      // pode existir em mais de uma. Nunca escolhemos sozinhos: se der
      // ambiguidade, devolvemos as opcoes pro estoquista decidir.
      numeroDaChave = mNumSerie ? mNumSerie[1] : codigoLimpo;
      serieDaChave = mNumSerie ? String(parseInt(mNumSerie[2], 10)) : null;
      tipoTentativa = 'numero_nf';
      console.log(`[BUSCA] NUMERO NF: numero=${numeroDaChave} serie=${serieDaChave || '(todas)'}`);
      let achadas = [];
      try { achadas = await buscarNFsPorNumero(numeroDaChave, serieDaChave); } catch (e) { achadas = []; }

      if (achadas.length > 1) {
        // AMBIGUIDADE: mesma numeracao em series diferentes. Carrega o basico
        // de cada uma (data, valor, produto) pro estoquista bater com a caixa.
        const opcoes = [];
        for (const a of achadas) {
          const rr = await buscarNFePorId(a.id);
          const n = (rr.ok && rr.data?.data) ? rr.data.data : null;
          if (!n) continue;
          const it0 = Array.isArray(n.itens) && n.itens.length ? n.itens[0] : null;
          opcoes.push({
            idBling: String(n.id),
            numero: n.numero,
            serie: n.serie,
            chave: n.chaveAcesso || null,
            dataEmissao: n.dataEmissao,
            valor: n.valorNota,
            cliente: (n.contato && n.contato.nome) ? n.contato.nome : null,
            produto: it0 ? (it0.descricao || null) : null,
            sku: it0 ? (it0.codigo || null) : null,
            numeroPedidoLoja: n.numeroPedidoLoja || null,
          });
        }
        resultado.tentativas.push({ tipo: 'numero_nf', codigo: String(codigoOriginal || '').trim(), ok: false, status: 300, erro: 'ambiguo (varias series)' });
        resultado.ambiguidade_nf = { numero: numeroDaChave, opcoes };
        resultado.erro = `Existem ${opcoes.length} NFs com o numero ${numeroDaChave}, em series diferentes. Escolha a que bate com o pacote (ou bipe a chave da DANFE).`;
        console.log(`[BUSCA] NUMERO NF ${numeroDaChave}: AMBIGUO em ${opcoes.length} series`);
        return res.status(409).json(resultado);
      }
      idNF = achadas.length === 1 ? achadas[0].id : null;
      if (achadas.length === 1) serieDaChave = achadas[0].serie;
    }

    resultado.tentativas.push({
      tipo: tipoTentativa,
      codigo: ehChaveNFe ? codigoLimpo : String(codigoOriginal || '').trim(),
      ok: !!idNF, status: idNF ? 200 : 404,
    });
    if (!idNF) {
      resultado.erro = ehChaveNFe
        ? `Chave lida, mas a NF ${numeroDaChave} (serie ${serieDaChave}) nao foi localizada no Bling.`
        : `NF ${numeroDaChave} nao localizada no Bling (procurei em todas as series, ultimos 18 meses). Confira o numero, ou bipe a chave da DANFE.`;
      return res.status(404).json(resultado);
    }
    const rFullNF = await buscarNFePorId(idNF);
    const nfCh = (rFullNF.ok && rFullNF.data?.data) ? rFullNF.data.data : null;
    if (!nfCh) {
      resultado.erro = `NF ${numeroDaChave} achada (id ${idNF}) mas falhou ao carregar do Bling.`;
      return res.status(404).json(resultado);
    }
    const itensCh = Array.isArray(nfCh.itens) ? nfCh.itens.map(it => ({
      titulo: it.descricao || null,
      sku: it.codigo || null,
      ean: it.gtin || null,
      quantidade: it.quantidade || null,
      valor: it.valor || null,
      unidade: it.unidade || null,
    })) : [];
    resultado.nf = {
      fonte: 'bling',
      numero: nfCh.numero,
      serie: nfCh.serie,
      chaveAcesso: nfCh.chaveAcesso || (ehChaveNFe ? codigoLimpo : null),
      valor: nfCh.valorNota,
      dataEmissao: nfCh.dataEmissao,
      linkDanfe: nfCh.linkDanfe,
      linkPdf: nfCh.linkPDF,
      linkXml: nfCh.xml,
      idBling: nfCh.id,
      numeroPedidoLoja: nfCh.numeroPedidoLoja,
      situacao: nfCh.situacao,
      itens: itensCh,
    };
    const nomeClienteCh = (nfCh.contato && nfCh.contato.nome) ? nfCh.contato.nome : null;
    const primeiroCh = itensCh.length ? itensCh[0] : null;
    resultado.order = {
      id: nfCh.numeroPedidoLoja || null,
      pack_id: null,
      buyer: { id: null, first_name: nomeClienteCh, last_name: '', nickname: null },
      order_items: primeiroCh
        ? [{ unit_price: Number(primeiroCh.valor) || null, quantity: null, item: { id: null, title: null, seller_sku: null } }]
        : [],
    };
    resultado.shipment = { id: null };
    resultado.encontrado = true;
    resultado.metodo = ehChaveNFe ? 'chave_danfe' : 'numero_nf';
    resultado.eh_devolucao = true;
    resultado.avisos.push({
      tipo: ehChaveNFe ? 'nf_via_chave' : 'nf_via_numero',
      mensagem: ehChaveNFe
        ? `NF ${nfCh.numero} localizada pela chave da DANFE (bissecao)`
        : `NF ${nfCh.numero} (serie ${nfCh.serie}) localizada pelo numero digitado`,
    });
    console.log(`[BUSCA] OK (${ehChaveNFe ? 'CHAVE' : 'NUMERO'}) | NF=${nfCh.numero} pedido=${nfCh.numeroPedidoLoja || '-'}`);
    return res.json(resultado);
  }

  // ===== MAGALU: protocolo da etiqueta, reverse_code ou pedido =====
  // A etiqueta Magalu imprime "Protocolo: 2026062600477033" - e ele bate
  // exatamente com o ticket.protocol da API (confirmado com dado real).
  // Do ticket sai o PEDIDO, e do pedido sai a NF no Bling (numeroLoja).
  // v3.63 - extraido em funcao pra rodar em DOIS pontos: magalu-first
  // (antes do ML, quando o codigo tem cara de protocolo/QR Magalu) e
  // fallback tardio (depois do ML, pra reverse_code/pedido).
  async function tentarDevolucaoMagalu() {
    if (!magalu.cfg.ativo || !magalu.cfg.autorizado) return false;
    let devMag = null;
    try { devMag = await magalu.acharDevolucao(codigoLimpo); } catch (e) { devMag = null; }
    resultado.tentativas.push({
      tipo: 'magalu_devolucao', codigo: codigoLimpo,
      ok: !!devMag, status: devMag ? 200 : 404,
    });

    if (devMag) {
      console.log(`[BUSCA] MAGALU: protocolo=${devMag.protocolo} pedido=${devMag.pedido} status=${devMag.status}`);
      // v3.63.1 - A NF vinha VAZIA (e o CONFIRMAR barrava sem nf_chave):
      // a janela usava a data do TICKET, que abre semanas DEPOIS da venda -
      // a NF, emitida NA venda, ficava fora da janela (pra tras).
      // Cura definitiva: a propria API Magalu entrega a CHAVE da NF no
      // pedido (invoices[].key - confirmado em JSON real). Pegamos a chave
      // la e resolvemos no Bling pela chave (caminho ja provado). Fallbacks:
      // janela pela data da COMPRA (purchased_at) e, no pior caso, a chave
      // da Magalu sozinha ja destrava a triagem (nf_chave no payload).
      let nfMag = null;
      let chaveMagalu = null;
      let compradoEm = null;
      if (devMag.pedido) {
        try {
          const rPed = await magalu.chamarMagalu(`/seller/v1/orders/${encodeURIComponent(devMag.pedido)}`);
          if (rPed.ok && rPed.data) {
            // v3.64 - CONFIRMADO em JSON real: no /orders/{code} os invoices
            // vem DENTRO de deliveries[] (nao na raiz). Varre raiz + entregas.
            const colecoesInv = [rPed.data.invoices, ...((rPed.data.deliveries || []).map(d => d && d.invoices))];
            for (const arr of colecoesInv) {
              const k = (arr || []).map(i => i && i.key).find(kk => /^\d{44}$/.test(String(kk || '')));
              if (k) { chaveMagalu = String(k); break; }
            }
            compradoEm = rPed.data.purchased_at || null;
          }
        } catch (e) { /* segue pros fallbacks */ }
        if (chaveMagalu) {
          try {
            const numeroDaChaveMag = String(parseInt(chaveMagalu.substr(25, 9), 10));
            const idNFMag = await resolverIdNFPorChave(numeroDaChaveMag, chaveMagalu);
            if (idNFMag) {
              const rFullMag = await buscarNFePorId(idNFMag);
              nfMag = (rFullMag.ok && rFullMag.data?.data) ? rFullMag.data.data : null;
            }
          } catch (e) { nfMag = null; }
        }
        if (!nfMag) {
          try {
            const rB = await buscarNFBlindada({ orderId: devMag.pedido, dataReferencia: compradoEm || null, janelaDias: 45 });
            if (rB.ok && rB.nf) nfMag = rB.nf;
          } catch (e) { /* segue sem NF do Bling */ }
        }
      }

      const itensMag = (devMag.itens || []).map(it => ({
        titulo: it.titulo, sku: it.sku, ean: null,
        quantidade: it.quantidade, valor: null, unidade: null,
      }));

      if (nfMag) {
        resultado.nf = {
          fonte: 'bling',
          numero: nfMag.numero,
          serie: nfMag.serie,
          chaveAcesso: nfMag.chaveAcesso || chaveMagalu || null,
          valor: nfMag.valorNota,
          dataEmissao: nfMag.dataEmissao,
          linkDanfe: nfMag.linkDanfe,
          linkPdf: nfMag.linkPDF,
          linkXml: nfMag.xml,
          idBling: nfMag.id,
          numeroPedidoLoja: nfMag.numeroPedidoLoja,
          situacao: nfMag.situacao,
          itens: mapItensNF(nfMag),
        };
      } else if (chaveMagalu) {
        // Bling nao achou, mas a Magalu deu a chave: NF minima ja permite
        // triar (nf_chave vai no payload) e o card mostra numero/serie.
        resultado.nf = {
          fonte: 'magalu',
          numero: String(parseInt(chaveMagalu.substr(25, 9), 10)),
          serie: String(parseInt(chaveMagalu.substr(22, 3), 10)),
          chaveAcesso: chaveMagalu,
          valor: null, dataEmissao: compradoEm || null,
          linkDanfe: null, linkPdf: null, linkXml: null,
          idBling: null, numeroPedidoLoja: devMag.pedido || null,
          situacao: null, itens: [],
        };
      }

      const prim = itensMag.length ? itensMag[0] : null;
      resultado.order = {
        id: devMag.pedido || null,
        pack_id: null,
        buyer: {
          id: null,
          first_name: (nfMag && nfMag.contato && nfMag.contato.nome) ? nfMag.contato.nome : null,
          last_name: '', nickname: null,
        },
        order_items: prim
          ? [{ unit_price: null, quantity: prim.quantidade, item: { id: null, title: prim.titulo, seller_sku: prim.sku } }]
          : [],
      };
      resultado.shipment = { id: null };
      resultado.itens_devolucao = itensMag;
      resultado.encontrado = true;
      resultado.metodo = 'magalu_devolucao';
      resultado.eh_devolucao = true;
      const esp = espreita.porPedido(devolucao.pedido_id || devolucao.order_id);
      if (esp) {
        resultado.avisos.push({ tipo: 'espreita', mensagem: `📮 Devolucao REGISTRADA no portal Magalu Entregas (${esp.categoria}${esp.status ? ' - ' + esp.status : ''}${esp.entregue_em ? ' - entregue ' + String(esp.entregue_em).slice(0, 10) : ''})` });
      }
      resultado.magalu = {
        protocolo: devMag.protocolo,
        reverse_code: devMag.reverse_code,
        tipo: devMag.tipo,
        motivo: devMag.motivo,
        status: devMag.status,
        fechado: devMag.fechado,
      };
      resultado.avisos.push({
        tipo: 'magalu',
        mensagem: `Devolucao MAGALU - protocolo ${devMag.protocolo}${devMag.status ? ' (' + devMag.status + ')' : ''}${nfMag ? ' - NF ' + nfMag.numero : ' - NF nao localizada no Bling'}`,
      });
      console.log(`[BUSCA] OK (MAGALU) | protocolo=${devMag.protocolo} pedido=${devMag.pedido} NF=${nfMag ? nfMag.numero : '-'}`);
      res.json(resultado);
      return true;
    }
    return false;
  }

  // MAGALU fallback tardio: reverse_code (10 dig) ou pedido (16 dig sem cara
  // de protocolo) - so tenta se nada acima resolveu e nao tentou ainda.
  if (!shipment && !pack && !pistaMagalu) {
    if (await tentarDevolucaoMagalu()) return;
  }

  // ===== SHOPEE (v3.33): tenta casar como etiqueta de devolucao Shopee =====
  if (!shipment && !pack) {
    let devShopee = resultado._shopeeDev || null; // v3.47.2: reusa o spx-first
    delete resultado._shopeeDev; // campo interno - nao vaza no JSON
    let infoShopee = null;
    if (!devShopee && shopee.cfg.ativo) {
      try {
        infoShopee = await shopee.acharDevolucao(codigoOriginal);
        devShopee = infoShopee.hit;
        resultado.tentativas.push({
          tipo: 'shopee_return', v: '3.34.3', codigo: codigoOriginal,
          ok: !!devShopee, status: devShopee ? 200 : 404,
          lista_qtd: infoShopee.qtd, exemplo_tracking: infoShopee.exemplo,
        });
      } catch (e) {
        resultado.tentativas.push({ tipo: 'shopee_return', v: '3.34.3', codigo: codigoOriginal, ok: false, status: 500, erro: e.message || String(e) });
        console.error('[BUSCA][shopee] proxy falhou:', e.message || e);
      }
    } else {
      // v3.34.3: mesmo desligada, a tentativa aparece e se explica
      resultado.tentativas.push({ tipo: 'shopee_return', v: '3.34.3', codigo: codigoOriginal, ok: false, status: 0, erro: 'SHOPEE_PROXY_URL/SHOPEE_PROXY_KEY ausentes no Render deste servico' });
    }
    if (!devShopee) {
      // v3.71 - ULTIMO RECURSO: o texto tem cara de NOME? (>=5 letras apos
      // colapsar). Casos: remetente da etiqueta Correios digitado/colado
      // ("RENATONEVES", "Renato Neves"). Devolve CANDIDATOS - o estoquista
      // confere com a caixa e escolhe (nada de casamento automatico).
      const alvoNome = nfNomes.colapsar(codigoOriginal);
      if (alvoNome.length >= 5 && !/^\d+$/.test(String(codigoOriginal).trim())) {
        try {
          const rN = await nfNomes.buscarPorNome(codigoOriginal);
          resultado.tentativas.push({ tipo: 'nf_por_nome', codigo: alvoNome, ok: rN.candidatos.length > 0, status: rN.candidatos.length ? 200 : 404, qtd: rN.candidatos.length });
          if (rN.candidatos.length > 0) {
            resultado.candidatos_nome = rN.candidatos;
            resultado.erro = `Achei ${rN.candidatos.length} NF(s) recente(s) com esse nome. Confere com a CAIXA e escolhe abaixo:`;
            return res.status(300).json(resultado); // 300 Multiple Choices
          }
        } catch (e) { resultado.tentativas.push({ tipo: 'nf_por_nome', codigo: alvoNome, ok: false, status: 500, erro: e.message }); }
      }
      const pareceSPX = /^BR[A-Z0-9]{8,}$/i.test(String(codigoOriginal).trim());
      const houve403 = resultado.tentativas.some(t => t.status === 403);
      const diag = infoShopee
        ? ` [diag: lista com ${infoShopee.qtd} devolucoes; exemplo de tracking: ${infoShopee.exemplo || '-'}]`
        : (shopee.cfg.ativo ? '' : ' [diag: integracao Shopee SEM as variaveis no Render!]');
      const nota403 = houve403 ? ' ⚠️ O ML respondeu 403 (acesso recusado): token expirado ou devolução recém-criada ainda embargada — tente o Pack ID impresso ou aguarde algumas horas.' : '';
      resultado.erro = (pareceSPX
        ? 'Etiqueta Shopee (SPX) nao casou com as devolucoes. Se ela diz "SPX INSUCESSO": o QR/barras so contem o rastreio (a Shopee nao indexa esse codigo) — DIGITE o "Pedido" impresso na etiqueta (ex: 260623TX31XFMT) que o sistema busca o pedido cancelado. Devolucao normal: tente o "Pedido" ou a chave da DANFE.'
        : 'Codigo nao encontrado em shipments/packs do ML nem nas devolucoes Shopee.') + diag + nota403;
      return res.status(404).json(resultado);
    }

    console.log(`[BUSCA] SHOPEE: return_sn=${devShopee.return_sn} order_sn=${devShopee.order_sn} tracking=${devShopee.tracking_number}`);

    // NF pela blindada: order_sn da Shopee = numeroLoja da NF serie 1 (Fase 0 direto)
    let nfData = null;
    let nomeCliente = null;
    const rBlind = await buscarNFBlindada({
      orderIds: [devShopee.order_sn],
      dataReferencia: devShopee.create_time
        ? new Date(devShopee.create_time * 1000).toISOString().slice(0, 10)
        : null,
      janelaDias: 60,
    });
    if (rBlind.ok && rBlind.nf) {
      const nf = rBlind.nf;
      const itensBling = Array.isArray(nf.itens) ? nf.itens.map(it => ({
        titulo: it.descricao || null,
        sku: it.codigo || null,
        ean: it.gtin || null,
        quantidade: it.quantidade || null,
        valor: it.valor || null,
        unidade: it.unidade || null,
      })) : [];
      nfData = {
        fonte: 'bling',
        numero: nf.numero,
        serie: nf.serie,
        chaveAcesso: nf.chaveAcesso,
        valor: nf.valorNota,
        dataEmissao: nf.dataEmissao,
        linkDanfe: nf.linkDanfe,
        linkPdf: nf.linkPDF,
        linkXml: nf.xml,
        idBling: nf.id,
        numeroPedidoLoja: nf.numeroPedidoLoja,
        situacao: nf.situacao,
        itens: itensBling,
      };
      nomeCliente = (nf.contato && nf.contato.nome) ? nf.contato.nome : null;
      resultado.avisos.push({
        tipo: 'nf_via_blindada',
        mensagem: `NF ${nf.numero} achada via busca blindada (${rBlind.via})`,
      });
      console.log(`[BUSCA][shopee] BLINDADA SUCESSO: NF=${nf.numero} via=${rBlind.via}`);
    } else {
      resultado.avisos.push({
        tipo: 'sem_nf',
        mensagem: `Devolucao Shopee ${devShopee.return_sn} localizada, mas a NF do pedido ${devShopee.order_sn} nao foi achada no Bling`,
      });
    }

    // order/shipment "minimos" no formato que o frontend ja entende
    // (NF-first cobre titulo/SKU/EAN/qtd; aqui vai cliente + valor + ids)
    const primeiroItem = nfData && nfData.itens.length ? nfData.itens[0] : null;
    resultado.order = {
      id: devShopee.order_sn,
      pack_id: null,
      buyer: { id: null, first_name: nomeCliente, last_name: '', nickname: 'SHOPEE' },
      order_items: primeiroItem
        ? [{ unit_price: Number(primeiroItem.valor) || null, quantity: null, item: { id: null, title: null, seller_sku: null } }]
        : [],
    };
    resultado.shipment = { id: devShopee.tracking_number || devShopee.return_sn || null };
    resultado.encontrado = true;
    resultado.metodo = 'shopee_return';
    resultado.marketplace = 'shopee';
    resultado.eh_devolucao = true;
    resultado.shopee = devShopee;
    resultado.nf = nfData;
    console.log(`[BUSCA] OK (SHOPEE) | NF=${nfData ? nfData.numero : 'nao'}`);
    return res.json(resultado);
  }

  // ML: ORDER (3 caminhos)
  let orderId = shipment?.order_id || pack?.orders?.[0]?.id;
  if (orderId) {
    const r = await chamarML(`https://api.mercadolibre.com/orders/${orderId}`);
    resultado.tentativas.push({
      tipo: 'order_direto', codigo: orderId,
      ok: r.ok, status: r.status, erro: r.ok ? null : r.error,
    });
    if (r.ok) order = r.data;
  }

  const ehDevolucao = shipment?.type === 'return' || shipment?.tags?.includes('claims_return');

  // NOVO v3.13: pra shipment de devolucao SEM order_id direto
  // Tenta buscar order via /shipments/{id}/orders ou /items
  if (!order && ehDevolucao && shipment?.id) {
    const rRetOrder = await buscarOrderViaShipmentReturn(shipment.id);
    resultado.tentativas.push({
      tipo: 'shipment_orders_return',
      codigo: shipment.id,
      ok: rRetOrder.ok, status: rRetOrder.ok ? 200 : 404,
      url_que_funcionou: rRetOrder.url || null,
    });
    if (rRetOrder.ok && rRetOrder.orderId) {
      const rOrder = await chamarML(`https://api.mercadolibre.com/orders/${rRetOrder.orderId}`);
      if (rOrder.ok) {
        order = rOrder.data;
        resultado.avisos.push({
          tipo: 'order_via_shipment_return',
          mensagem: `Order ${rRetOrder.orderId} achada via shipment de devolucao`,
        });
      }
    }
  }

  if (!order && ehDevolucao && shipment?.id) {
    const rClaims = await buscarClaimsPorShipment(shipment.id);
    resultado.tentativas.push({
      tipo: 'claims_search', codigo: shipment.id,
      ok: rClaims.ok, status: rClaims.ok ? 200 : 404,
      claims_encontradas: rClaims.claims?.length || 0,
    });

    if (rClaims.ok && rClaims.claims.length > 0) {
      const claimResumo = rClaims.claims[0];
      const rDetalhada = await buscarClaimDetalhada(claimResumo.id);
      claim = rDetalhada.ok ? rDetalhada.data : claimResumo;

      const rRet = await buscarReturnPorClaim(claimResumo.id);
      if (rRet.ok) returnData = rRet.data;

      const possibleOrderId = claim.resource_id || claimResumo.resource_id;
      if (possibleOrderId) {
        const rOrder = await chamarML(`https://api.mercadolibre.com/orders/${possibleOrderId}`);
        if (rOrder.ok) order = rOrder.data;
      }
    }
  }

  if (!order && shipment) {
    const buyerId = shipment.origin?.sender_id || shipment.sender_id;
    const sellerId = shipment.destination?.receiver_id || shipment.receiver_id || ML_USER_ID;

    if (buyerId && sellerId) {
      const rSearch = await buscarOrdersPorComprador(buyerId, sellerId);
      resultado.tentativas.push({
        tipo: 'orders_por_comprador',
        codigo: `buyer=${buyerId}, seller=${sellerId}`,
        ok: rSearch.ok, status: rSearch.status, erro: rSearch.ok ? null : rSearch.error,
        encontradas: rSearch.data?.results?.length || 0,
      });

      if (rSearch.ok && rSearch.data?.results?.length > 0) {
        const orders = rSearch.data.results;
        let bestMatch = null;

        // 1) Match exato por shipment.id (se a venda tem o mesmo shipment ASSOCIADO)
        if (shipment?.id) {
          bestMatch = orders.find(o => String(o.shipping?.id) === String(shipment.id));
        }

        // 2) NOVO v3.13: Match por valor declarado E que tenha mediação/devolução em curso
        // (devoluções aparecem com mediations não vazio)
        if (!bestMatch && shipment?.declared_value) {
          bestMatch = orders.find(o =>
            Math.abs((o.total_amount || 0) - shipment.declared_value) < 0.01 &&
            (o.mediations?.length > 0 || o.tags?.includes('claims_with_resolution'))
          );
        }

        // 3) Match por valor declarado simples
        if (!bestMatch && shipment?.declared_value) {
          bestMatch = orders.find(o => Math.abs((o.total_amount || 0) - shipment.declared_value) < 0.01);
        }

        // 4) Order com mediação/cancelamento (sinal de devolução)
        if (!bestMatch) {
          bestMatch = orders.find(o => o.status === 'cancelled' || o.tags?.includes('not_paid') || o.mediations?.length > 0);
        }

        // 5) Ultima opção - primeira venda do array (mais recente)
        if (!bestMatch) bestMatch = orders[0];

        if (bestMatch?.id) {
          const rFull = await chamarML(`https://api.mercadolibre.com/orders/${bestMatch.id}`);
          if (rFull.ok) {
            order = rFull.data;
            resultado.avisos.push({
              tipo: 'order_via_fallback',
              mensagem: `Order encontrada via busca por comprador (${orders.length} candidatos, valor=${shipment?.declared_value || '?'})`,
            });
          }
        }
      }
    }
  }

  if (!pack && order?.pack_id) {
    const r = await chamarML(`https://api.mercadolibre.com/packs/${order.pack_id}`);
    if (r.ok) pack = r.data;
  }

  // ============================================================
  // NF: APENAS via ML (rapido, ~1seg)
  // Se falhar, frontend mostra botao "Buscar links Bling" sob demanda
  // ============================================================
  let nfData = null;
  let mlInvoice = null; // v3.19: guarda numero/serie do ML mesmo sem fiscal_key

  const shipmentOriginalId = order?.shipping?.id || (!ehDevolucao ? shipment?.id : null);

  if (shipmentOriginalId) {
    const rNFML = await buscarNFnoML(shipmentOriginalId);
    if (rNFML.ok && rNFML.data) mlInvoice = rNFML.data;
    resultado.tentativas.push({
      tipo: 'ml_invoice_data',
      codigo: shipmentOriginalId,
      ok: rNFML.ok,
      status: rNFML.status,
      erro: rNFML.ok ? null : rNFML.error,
      tem_fiscal_key: !!rNFML.data?.fiscal_key,
    });

    if (rNFML.ok && rNFML.data?.fiscal_key) {
      nfData = {
        fonte: 'ml',
        numero: rNFML.data.invoice_number,
        serie: rNFML.data.invoice_serie,
        chaveAcesso: rNFML.data.fiscal_key,
        valor: rNFML.data.invoice_amount,
        dataEmissao: rNFML.data.invoice_date,
        peso: rNFML.data.weight,
        linkConsulta: `https://meudanfe.com.br/consulta/${rNFML.data.fiscal_key}`,
        idMLInvoice: rNFML.data.id,
      };

      // v3.14.8: enriquecer com itens do Bling (titulo limpo + EAN) quando ML achou NF
      // Adiciona ~1s a busca mas evita clique manual em "Buscar links Bling" e da EAN no card
      if (order?.id && rNFML.data.invoice_number) {
        try {
          const rEnriq = await buscarNFnoBlingPorNumero(rNFML.data.invoice_number, order.date_created, { maxPaginas: 30 });
          if (rEnriq.ok && rEnriq.match?.id) {
            await sleep(400);
            const rCompleta = await buscarNFePorId(rEnriq.match.id);
            if (rCompleta.ok && rCompleta.data?.data) {
              const nfBling = rCompleta.data.data;
              const itensBling = Array.isArray(nfBling.itens) ? nfBling.itens.map(it => ({
                titulo: it.descricao || null,
                sku: it.codigo || null,
                ean: it.gtin || null,
                quantidade: it.quantidade || null,
                valor: it.valor || null,
                unidade: it.unidade || null,
              })) : [];
              nfData.itens = itensBling;
              nfData.idBling = nfBling.id;
              nfData.linkDanfe = nfBling.linkDanfe || nfData.linkConsulta;
              nfData.linkPdf = nfBling.linkPDF;
              nfData.linkXml = nfBling.xml;
              resultado.avisos.push({
                tipo: 'enriquecido_bling',
                mensagem: `Itens e links Bling carregados automaticamente`,
              });
            }
          }
        } catch (e) {
          console.warn('[ENRIQ] Erro ao enriquecer NF ML com itens Bling:', e.message);
        }
      }
    }
  }

  if (!nfData) {
    // v3.19 BLINDADA: busca por JANELA DE DATAS da venda (rapida e a prova
    // de serie 1/2). Substitui a varredura antiga de 50 paginas sem filtro.
    if (order?.id) {
      console.log(`[BUSCA] ML sem NF, acionando busca BLINDADA pra order=${order.id}`);
      const rBlind = await buscarNFBlindada({
        orderIds: [order.id, order.pack_id || pack?.id || null],
        numeroNF: mlInvoice?.invoice_number || null,
        serieNF: mlInvoice?.invoice_serie || null,
        dataReferencia: order.date_created || null,
      });

      resultado.tentativas.push({
        tipo: 'bling_blindada',
        codigo: order.id,
        ok: rBlind.ok,
        via: rBlind.via || null,
        tentado: rBlind.tentado || null,
      });

      if (rBlind.ok && rBlind.nf) {
        const nf = rBlind.nf;
        const itensBling = Array.isArray(nf.itens) ? nf.itens.map(it => ({
          titulo: it.descricao || null,
          sku: it.codigo || null,
          ean: it.gtin || null,
          quantidade: it.quantidade || null,
          valor: it.valor || null,
          unidade: it.unidade || null,
        })) : [];

        nfData = {
          fonte: 'bling',
          numero: nf.numero,
          serie: nf.serie,
          chaveAcesso: nf.chaveAcesso,
          valor: nf.valorNota,
          dataEmissao: nf.dataEmissao,
          linkDanfe: nf.linkDanfe,
          linkPdf: nf.linkPDF,
          linkXml: nf.xml,
          idBling: nf.id,
          numeroPedidoLoja: nf.numeroPedidoLoja,
          situacao: nf.situacao,
          itens: itensBling,
        };

        resultado.avisos.push({
          tipo: 'nf_via_blindada',
          mensagem: `NF ${nf.numero} achada via busca blindada (${rBlind.via})`,
        });
        console.log(`[BUSCA] BLINDADA SUCESSO: NF=${nf.numero} via=${rBlind.via}`);
      } else {
        resultado.avisos.push({
          tipo: 'sem_nf',
          mensagem: `NF-e nao localizada nem pela busca blindada (${(rBlind.tentado || []).join(' | ')})`,
        });
      }
    } else {
      resultado.avisos.push({
        tipo: 'sem_nf_ml',
        mensagem: 'NF-e nao localizada via ML. Use o botao "Buscar links Bling" pra tentar via Bling.',
      });
    }
  }

  if (!order) {
    resultado.avisos.push({
      tipo: 'sem_order',
      mensagem: 'Nao foi possivel obter detalhes da venda no ML',
    });
  }

  resultado.encontrado = true;
  resultado.metodo = metodoUsado;
  resultado.eh_devolucao = ehDevolucao;
  resultado.shipment = shipment;
  resultado.order = order;
  resultado.pack = pack;
  resultado.claim = claim;
  resultado.return = returnData;
  resultado.nf = nfData;

  console.log(`[BUSCA] OK | Order=${!!order} | NF=${nfData ? 'sim' : 'nao'}`);
  return res.json(resultado);
});

// ============================================================
// NOVO v3.5: Buscar links Bling sob demanda - PAGINANDO NFs
// Estrategia rapida: usa invoice_number do ML (que vem rapido) e busca por NUMERO da NF.
// Fallback: se nao tem numero, busca por numeroPedidoLoja (mais lento).
// Funciona pra TUDO (canceladas, ativas, etc) - NFs nunca somem do Bling.
// ============================================================
app.get('/api/nf/buscar-links-bling/:orderId', requerLogin, async (req, res) => {
  const orderId = String(req.params.orderId || '').trim();
  const dataRef = req.query.data || null;
  const numeroNF = req.query.numeroNF || null;

  if (!orderId && !numeroNF) {
    return res.status(400).json({ ok: false, erro: 'orderId ou numeroNF necessario' });
  }

  console.log(`[BLING-DEMANDA v3.5] orderId=${orderId} numeroNF=${numeroNF} dataRef=${dataRef}`);

  let rBusca;
  let estrategia;

  // Se passou o numero da NF (do ML), busca rapida por numero
  if (numeroNF) {
    estrategia = 'por_numero_nf';
    rBusca = await buscarNFnoBlingPorNumero(numeroNF, dataRef, { maxPaginas: 50 });
  } else {
    // Fallback: busca por numeroPedidoLoja (cada NF precisa GET individual, lento)
    estrategia = 'por_numero_pedido_loja';
    rBusca = await buscarNFnoBlingPorOrderId(orderId, dataRef, { maxPaginas: 50 });
  }

  if (!rBusca.ok) {
    return res.json({
      ok: false,
      estrategia,
      erro: 'Erro ao buscar NF no Bling',
      detalhes: rBusca,
    });
  }

  if (!rBusca.match) {
    return res.json({
      ok: false,
      estrategia,
      erro: `NF nao encontrada em ${rBusca.totalScanned} NFs verificadas (de ${rBusca.primeiraDataVista || '?'} a ${rBusca.ultimaDataVista || '?'})`,
      detalhes: rBusca,
    });
  }

  // Buscar NF completa pra ter linkDanfe e ITENS
  await sleep(400);
  const rCompleta = await buscarNFePorId(rBusca.match.id);
  const nf = (rCompleta.ok && rCompleta.data?.data) ? rCompleta.data.data : rBusca.match;

  // Extrai itens (com titulo, SKU, EAN do Bling)
  const itensBling = Array.isArray(nf.itens) ? nf.itens.map(it => ({
    titulo: it.descricao || null,
    sku: it.codigo || null,
    ean: it.gtin || null,
    quantidade: it.quantidade || null,
    valor: it.valor || null,
    unidade: it.unidade || null,
  })) : [];

  return res.json({
    ok: true,
    estrategia,
    paginas_verificadas: rBusca.pagina,
    total_scanned: rBusca.totalScanned,
    nf: {
      fonte: 'bling',
      numero: nf.numero,
      serie: nf.serie,
      chaveAcesso: nf.chaveAcesso,
      valor: nf.valorNota,
      dataEmissao: nf.dataEmissao,
      linkDanfe: nf.linkDanfe,
      linkPdf: nf.linkPDF,
      linkXml: nf.xml,
      idBling: nf.id,
      numeroPedidoLoja: nf.numeroPedidoLoja,
      itens: itensBling,
    },
  });
});

// ============================================================
// ADMIN
// ============================================================
app.post('/api/admin/renovar-token-ml', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const ok = await renovarTokenML();
  res.json({ ok, timestamp: new Date().toISOString() });
});

app.post('/api/admin/renovar-token-bling', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const ok = await renovarTokenBling();
  res.json({ ok, timestamp: new Date().toISOString() });
});

// ============================================================
// DEBUG
// ============================================================
app.get('/api/debug/shipment/:id', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const r = await chamarML(`https://api.mercadolibre.com/shipments/${req.params.id}`, { 'x-format-new': 'true' });
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

app.get('/api/debug/order/:id', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const r = await chamarML(`https://api.mercadolibre.com/orders/${req.params.id}`);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

app.get('/api/debug/ml-invoice/:shipmentId', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const r = await buscarNFnoML(req.params.shipmentId);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

app.get('/api/debug/bling-busca/:numeroLoja', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const dataRef = req.query.data || null;
  const r = await buscarPedidoBlingPorNumeroLoja(req.params.numeroLoja, dataRef, { maxPaginas: 50 });
  res.json(r);
});

// NOVO v3.14.4: rota pra buscar EAN do produto pelo SKU
// Usado quando a NF nao foi achada automaticamente e o frontend precisa do EAN pra bipagem
app.get('/api/produto/ean-por-sku/:sku', requerLogin, async (req, res) => {
  const sku = String(req.params.sku || '').trim();
  if (!sku) return res.status(400).json({ ok: false, erro: 'sku obrigatorio' });

  const r = await buscarProdutoBlingPorSku(sku);
  if (!r.ok) return res.status(500).json(r);
  if (!r.produto) return res.json({ ok: true, encontrado: false, sku });

  // EAN pode estar em VARIOS campos no Bling - licao do projeto Localizacao Estoque
  const p = r.produto;
  const ean = p.gtin
           || p.gtinEmbalagem
           || p.gtinTributario
           || p.gtinEan
           || p.ean
           || p.codigoBarras
           || p.tributacao?.gtin
           || p.tributacao?.ean
           || null;

  return res.json({
    ok: true,
    encontrado: true,
    sku,
    produto: {
      id: p.id,
      nome: p.nome,
      codigo: p.codigo,
      gtin: ean, // campo unificado
      // Debug - todos os campos possiveis
      _debug: {
        gtin: p.gtin,
        gtinEmbalagem: p.gtinEmbalagem,
        gtinTributario: p.gtinTributario,
        gtinEan: p.gtinEan,
        ean: p.ean,
        codigoBarras: p.codigoBarras,
        tributacao_gtin: p.tributacao?.gtin,
        tributacao_ean: p.tributacao?.ean,
      },
    },
  });
});

app.get('/api/debug/bling-pedido/:id', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const r = await buscarPedidoBlingPorId(req.params.id);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

app.get('/api/debug/bling-nfe-cru/:idNFe', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const r = await buscarNFePorId(req.params.idNFe);
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

// v3.4: ver primeira pagina de NFs (pra debug)
app.get('/api/debug/bling-nfe-primeira-pagina', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const limite = req.query.limite || 20;
  const r = await chamarBling(`https://api.bling.com.br/Api/v3/nfe?limite=${limite}&pagina=1&tipo=1`);
  if (r.ok && r.data?.data) {
    const resumo = r.data.data.map(nf => ({
      id: nf.id,
      numero: nf.numero,
      serie: nf.serie,
      numeroPedidoLoja: nf.numeroPedidoLoja,
      dataEmissao: nf.dataEmissao,
      situacao: nf.situacao,
      valorNota: nf.valorNota,
      contato: nf.contato?.nome,
    }));
    return res.json({ ok: true, total_na_pagina: r.data.data.length, primeiros: resumo });
  }
  res.status(r.ok ? 200 : r.status || 500).json(r);
});

// v3.4: busca NF por order_id ML (manual, pra debug)
app.get('/api/debug/bling-busca-nf/:orderId', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const dataRef = req.query.data || null;
  const r = await buscarNFnoBlingPorOrderId(req.params.orderId, dataRef, { maxPaginas: 50 });
  res.json(r);
});

// v3.19 DEBUG: testa se obter-dados-devolucao funciona na API oficial
// (api.bling.com.br + Bearer). Decide se dá pra o BACKEND buscar os dados
// da devolucao (com os IDs reais dos itens) em vez da extensao.
app.get('/api/debug/dados-devolucao-numero/:numero', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const numero = String(req.params.numero || '').trim();
  try {
    const rBusca = await buscarNFnoBlingPorNumero(numero, null, { maxPaginas: 50 });
    if (!rBusca.ok || !rBusca.match) {
      return res.json({ ok: false, etapa: 'buscar-numero', achou_nf: false });
    }
    const idNF = rBusca.match.id;

    // Descobre o idLoja pela API v3 (a NF individual traz "loja").
    // Esse e o valor que vai no ULTIMO segmento do obter-dados-devolucao.
    const rNFind = await buscarNFePorId(idNF);
    const lojaId = rNFind.ok ? (rNFind.data?.data?.loja?.id ?? null) : null;

    // Testa o obter-dados-devolucao via API oficial (Bearer) COM o idLoja real.
    // Esperado: 403 - esse endpoint e INTERNO (so cookie/sessao no www), nao e
    // exposto a apps de API. Serve so pra confirmar (a extensao e quem chama de verdade).
    const seg = lojaId != null ? String(lojaId) : '0';
    const url = `https://api.bling.com.br/Api/v3/nfe/${idNF}/obter-dados-devolucao/${seg}`;
    const r = await chamarBling(url);
    return res.json({
      ok: r.ok,
      status: r.status,
      idNF: String(idNF),
      idLoja_apiV3: lojaId != null ? String(lojaId) : null,
      url_testada: url,
      tem_data: !!r.data?.data,
      tem_itens: !!(r.data?.data?.itens),
      qtd_itens: r.data?.data?.itens ? Object.keys(r.data.data.itens).length : 0,
      ids_itens: r.data?.data?.itens ? Object.keys(r.data.data.itens) : [],
      dadosNota_id: r.data?.data?.dadosNota?.id || null,
      idDeposito: r.data?.data?.dadosNota?.idDeposito || null,
      devolucaoExistente: r.data?.data?.devolucaoExistente,
      error: r.error || null,
    });
  } catch (e) {
    return res.json({ ok: false, erro: e.message });
  }
});

// ============================================================
// CALLBACKS OAuth
// ============================================================
app.get('/callback', (req, res) => {
  res.send(`<h2>Callback ML recebido</h2><p>code: ${req.query.code || '(nenhum)'}</p>`);
});

app.get('/bling/callback', (req, res) => {
  res.send(`<h2>Callback Bling recebido</h2><p>code: ${req.query.code || '(nenhum)'}</p>`);
});

// v3.19 - Reconexao do app Bling (troca o code por token com os escopos novos)
// Uso: /bling/setup?code=SEU_CODE  (o code expira em 1 minuto!)
app.get('/bling/setup', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const code = String(req.query.code || '').trim();
  if (!code) {
    return res.send('<h2>Falta o code</h2><p>Abra assim: <code>/bling/setup?code=SEU_CODE</code></p>');
  }
  try {
    const data = await trocarCodePorTokenBling(code);
    res.send(`
      <h2 style="color:#2e7d32;">✅ Bling reconectado com sucesso!</h2>
      <p><strong>Escopos ativos agora:</strong></p>
      <pre style="background:#f5f5f5;padding:12px;border-radius:8px;white-space:pre-wrap;">${(data.scope || '(nao informado)')}</pre>
      <p>Token salvo. Pode fechar esta aba.</p>
    `);
  } catch (e) {
    const detalhe = e.response?.data ? JSON.stringify(e.response.data, null, 2) : (e.message || String(e));
    res.send(`
      <h2 style="color:#c62828;">❌ Erro ao reconectar</h2>
      <pre style="background:#fff0f0;padding:12px;border-radius:8px;white-space:pre-wrap;">${detalhe}</pre>
      <p><strong>Dica:</strong> o code expira em <strong>1 minuto</strong>. Se demorou, gere um novo (cole o link de convite de novo) e refaça rapidinho.</p>
    `);
  }
});

// ============================================================
// v3.40 - EXAME DE SANGUE do token ML: chama /users/me (dispara o
// auto-refresh se preciso) e conta a verdade em 1 clique.
app.get('/api/debug/ml-token', requerAdmin, async (req, res) => {
  const r = await mlClient.chamarML('https://api.mercadolibre.com/users/me');
  if (r.ok) {
    return res.json({
      ok: true,
      veredito: '✅ TOKEN VIVO (renovou sozinho se precisou)',
      user_id: r.data?.id,
      nickname: r.data?.nickname,
    });
  }
  return res.status(502).json({
    ok: false,
    veredito: '💀 TOKEN MORTO - o refresh falhou. Use o /ml/setup (instrucoes na resposta)',
    status_ml: r.status,
    erro_ml: r.error,
    como_ressuscitar: [
      '1) Logado na conta ML da GOOD, abra: https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=SEU_ML_CLIENT_ID&redirect_uri=' + 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com/callback',
      '2) Autorize - a pagina /callback mostra o CODE',
      '3) EM ATE 1 MINUTO abra: /ml/setup?code=SEU_CODE',
    ],
  });
});

// v3.40 - Reconexao do app ML (espelho do /bling/setup)
// Uso: /ml/setup?code=SEU_CODE  (o code expira em ~1 minuto!)
app.get('/ml/setup', async (req, res) => {
  if (!adminOk(req)) return res.status(404).send('Not found'); // protegido: exige ?k=ADMIN_KEY
  const code = String(req.query.code || '').trim();
  if (!code) {
    return res.send('<h2>Falta o code</h2><p>Abra assim: <code>/ml/setup?code=SEU_CODE</code></p>');
  }
  try {
    const { clientId, clientSecret } = mlClient.getClientML();
    const r = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com/callback',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) {
      throw new Error(JSON.stringify(data, null, 2) || ('HTTP ' + r.status));
    }
    const persist = await mlClient.definirTokensML(data.access_token, data.refresh_token);
    res.send(`
      <h2 style="color:#2e7d32;">✅ Mercado Livre reconectado!</h2>
      <p><strong>User ID:</strong> ${data.user_id || '?'} · <strong>Escopo:</strong> ${data.scope || '?'}</p>
      <p><strong>Cofre (Render):</strong> ${persist.persistiu
        ? 'tokens salvos ✅ (sobrevivem a redeploy)'
        : '⚠️ NÃO persistiu (' + (persist.erro || 'RENDER_API_KEY/RENDER_SERVICE_ID ausentes?') + ') — tokens ativos só na memória: funcionam AGORA, mas o próximo deploy apaga. Reponha as 2 vars e refaça o setup.'}</p>
      <p>Teste bipando uma etiqueta ML.</p>
    `);
  } catch (e) {
    const detalhe = e.message || String(e);
    res.send(`
      <h2 style="color:#c62828;">❌ Erro ao reconectar o ML</h2>
      <pre style="background:#fff0f0;padding:12px;border-radius:8px;white-space:pre-wrap;">${detalhe}</pre>
      <p><strong>Dica:</strong> o code expira em ~1 minuto. Gere um novo (link de autorização) e refaça rapidinho.</p>
    `);
  }
});

// ============================================================
// FASE 3: AUTH (LOGIN ESTOQUISTA)
// ============================================================

// Login unificado (estoquista + admin)
// Se usuario == ADMIN_USER, recebe sessao com tipo='admin'
app.post('/api/auth/login', (req, res) => {
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) {
    return res.status(400).json({ ok: false, erro: 'Usuario ou senha faltando' });
  }
  const senhaCorreta = USERS[usuario];
  if (!senhaCorreta || senhaCorreta !== senha) {
    return res.status(401).json({ ok: false, erro: 'Usuario ou senha invalidos' });
  }

  // Define o tipo: admin se usuario == ADMIN_USER, senao estoquista
  const tipo = (ADMIN_USER && usuario === ADMIN_USER) ? 'admin' : 'estoquista';

  const token = novaSessao(usuario, tipo);
  res.cookie('sessao', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000, // 12h
  });
  console.log(`[LOGIN] ${usuario} (${tipo})`);
  return res.json({ ok: true, usuario, tipo });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const t = req.cookies?.sessao;
  if (t) sessoes.delete(t);
  res.clearCookie('sessao');
  return res.json({ ok: true });
});

// Quem sou eu (frontend usa pra validar sessao + saber se admin)
app.get('/api/auth/me', (req, res) => {
  const t = req.cookies?.sessao;
  const s = validarSessao(t);
  if (s) return res.json({ ok: true, usuario: s.usuario, tipo: s.tipo });
  return res.json({ ok: false });
});

// Middleware: requer sessao (qualquer tipo)
function requerLogin(req, res, next) {
  const token = req.cookies?.sessao;
  const sessao = validarSessao(token);
  if (!sessao) {
    return res.status(401).json({ ok: false, erro: 'Sessao invalida ou expirada' });
  }
  req.usuario = sessao.usuario;
  req.tipoUsuario = sessao.tipo;
  next();
}

// Middleware: requer sessao admin
function requerAdmin(req, res, next) {
  const token = req.cookies?.sessao;
  const sessao = validarSessao(token, 'admin');
  if (!sessao) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, erro: 'Acesso restrito a admin' });
    }
    // Redireciona pro login (tela principal)
    return res.redirect('/');
  }
  req.usuario = sessao.usuario;
  next();
}

// Alias antigo pra compatibilidade
const requerEstoquista = requerLogin;

// ============================================================
// FASE 3: TRIAGEM - INCLUIR ESTOQUE / REPORTAR PROBLEMA
// ============================================================

// Verificar se shipment_id ja foi triado
app.get('/api/triagem/status/:shipmentId', requerEstoquista, async (req, res) => {
  if (!supabase) {
    return res.json({ ok: false, erro: 'Supabase nao configurado' });
  }
  const ident = String(req.params.shipmentId || '').trim();
  if (!ident) {
    return res.status(400).json({ ok: false, erro: 'identificador obrigatorio' });
  }
  // v3.49 - vendas de outros marketplaces (Magalu, Amazon...) chegam pela
  // chave da DANFE e NAO tem shipment_id. Se o identificador for uma chave
  // de 44 digitos, procura por nf_chave; senao, por shipment_id (ML/Shopee).
  // v3.64 - a MESMA devolucao pode ter sido gravada por identificadores
  // diferentes (chave da NF num bipe, protocolo Magalu noutro). A checagem
  // aceita um segundo id via ?tambem= e busca por OR nas duas colunas.
  const ids = [ident];
  const tambem = String(req.query.tambem || '').trim();
  if (tambem && tambem !== ident) ids.push(tambem);
  const ors = [];
  for (const idv of ids) {
    const seguro = idv.replace(/[",()]/g, '');
    ors.push(`shipment_id.eq.${seguro}`);
    if (/^\d{44}$/.test(seguro)) ors.push(`nf_chave.eq.${seguro}`);
  }
  try {
    const { data, error } = await supabase
      .from('devolucoes')
      .select('id, created_at, tipo, status, problema_descricao, problema_fotos, data_concluido, nf_numero, produto_qtd')
      .or(ors.join(','))
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ ok: false, erro: error.message });
    }
    return res.json({ ok: true, registros: data || [], ids_buscados: ids });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// Caminho APROVAR (INCLUIR ESTOQUE)
app.post('/api/triagem/aprovar', requerEstoquista, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ ok: false, erro: 'Supabase nao configurado' });
  }
  const dados = req.body || {};

  // v3.62.1 - vendas sem shipment (Magalu, chave DANFE, numero da NF) sao
  // identificadas pela nf_chave. A validacao aceita qualquer um dos dois -
  // era so o insert que aceitava (v3.49), a validacao ficou pra tras e
  // barrava o CONFIRMAR com "shipment_id obrigatorio".
  if (!dados.shipment_id && !dados.nf_chave && !dados.magalu_protocolo) {
    return res.status(400).json({ ok: false, erro: 'shipment_id, nf_chave ou magalu_protocolo obrigatorio' });
  }

  // v3.17.0 - Validacoes especificas pra devolucao parcial
  const ehParcial = !!dados.eh_parcial;
  const fotosParcial = Array.isArray(dados.fotos_parcial) ? dados.fotos_parcial : [];
  if (ehParcial) {
    if (fotosParcial.length < 6) {
      return res.status(400).json({
        ok: false,
        erro: `Devolucao parcial requer no minimo 6 fotos (recebido: ${fotosParcial.length})`,
      });
    }
  }

  // Bloqueia duplicata - exceto se cliente passar forcar=true (re-triagem proposital)
  if (!dados.forcar) {
    const { data: existentes, error: errBusca } = await supabase
      .from('devolucoes')
      .select('id, created_at, tipo, status, problema_descricao')
      .eq('shipment_id', String(dados.shipment_id || dados.nf_chave || dados.magalu_protocolo || '')) // v3.64: mesmo identificador que o insert grava
      .limit(1);
    if (errBusca) {
      console.error('[TRIAGEM] Erro busca duplicata:', errBusca);
    } else if (existentes && existentes.length > 0) {
      return res.status(409).json({
        ok: false,
        erro: 'duplicata',
        mensagem: 'Esta devolucao ja foi triada antes',
        registro_existente: existentes[0],
      });
    }
  }

  try {
    // v3.15.2 - Antes de gravar, busca numero do pedido Bling pelo order_id
    // v3.37 - teto de 20s: passou disso, salva SEM o numero (campo cosmetico)
    // e responde - nunca mais "salvando infinito" pro estoquista.
    let pedidoBlingNumero = null;
    if (dados.order_id) {
      const dataRef = dados.nf_data_emissao || null;
      const r = await Promise.race([
        buscarPedidoBlingPorNumeroLoja(String(dados.order_id), dataRef, { maxPaginas: 12 }),
        new Promise(resolve => setTimeout(() => resolve({ ok: false, timeout: true }), 20000)),
      ]);
      if (r?.timeout) console.warn(`[TRIAGEM] busca do pedido ${dados.order_id} estourou 20s - seguindo sem`);
      if (r?.ok && r.match?.numero) {
        pedidoBlingNumero = String(r.match.numero);
      }
    }

    // v3.30: guarda os itens da NF pro card das Aprovadas ja abrir com
    // produtos e quantidades (1 busca no Bling na hora da aprovacao).
    // v3.31: se nao veio o id Bling mas ha chave, descobre pela janela.
    let nfItens = null;
    let idBlingAprovar = dados.nf_id_bling || null;
    if (!idBlingAprovar && dados.nf_chave && dados.nf_numero) {
      try { idBlingAprovar = await resolverIdNFPorChave(dados.nf_numero, dados.nf_chave); } catch (e) { idBlingAprovar = null; }
    }
    if (idBlingAprovar) {
      try {
        const rIt = await buscarNFePorId(String(idBlingAprovar));
        nfItens = (rIt.ok && rIt.data?.data) ? mapItensNF(rIt.data.data) : null;
      } catch (e) { nfItens = null; }
    }

    // v3.17.0 - monta descricao do registro
    let descricaoRegistro;
    if (ehParcial) {
      const obs = (dados.observacao_parcial || '').trim();
      descricaoRegistro = `[DEVOLUCAO PARCIAL por ${req.usuario}] Recebido: ${dados.produto_qtd} de ${dados.produto_qtd_original || '?'} unidades.${obs ? ' OBS: ' + obs : ''}`;
    } else if (dados.bipagem_forcada) {
      descricaoRegistro = `Aprovado por ${req.usuario} [BIPAGEM FORCADA] OBS: ${dados.bipagem_observacao}`;
    } else {
      descricaoRegistro = `Aprovado por ${req.usuario} [bipagem OK]`;
    }

    const { data, error } = await supabase
      .from('devolucoes')
      .insert([{
        shipment_id: String(dados.shipment_id || dados.nf_chave || dados.magalu_protocolo || ''), // v3.64: identificador em cascata (shipment > chave NF > protocolo Magalu)
        order_id: dados.order_id ? String(dados.order_id) : null,
        pack_id: dados.pack_id ? String(dados.pack_id) : null,
        buyer_id: dados.buyer_id ? String(dados.buyer_id) : null,
        buyer_nome: dados.buyer_nome || null,
        buyer_nickname: dados.buyer_nickname || null,
        pedido_bling_numero: pedidoBlingNumero,
        produto_titulo: dados.produto_titulo || null,
        produto_mlb: dados.produto_mlb || null,
        produto_sku: dados.produto_sku || null,
        produto_qtd: dados.produto_qtd || null,
        produto_valor_unit: dados.produto_valor_unit || null,
        nf_numero: dados.nf_numero || null,
        nf_serie: dados.nf_serie || null,
        nf_chave: dados.nf_chave || null,
        nf_valor: dados.nf_valor || null,
        nf_data_emissao: dados.nf_data_emissao || null,
        nf_id_bling: idBlingAprovar || null,
        nf_link_danfe: dados.nf_link_danfe || null,
        nf_itens: nfItens,
        tipo: 'aprovado',
        status: 'pendente',
        funcionario: req.usuario,
        problema_descricao: (dados.forcar ? '[RE-BIPE] ' : '') + descricaoRegistro,
        // v3.17.0 - se for parcial, salva as fotos no mesmo campo das fotos de problema
        problema_fotos: ehParcial ? fotosParcial : null,
      }])
      .select()
      .single();

    if (error) {
      console.error('[TRIAGEM] Erro Supabase:', error);
      return res.status(500).json({ ok: false, erro: error.message });
    }

    // v3.17.0 - Aplica tag automatica "Devolucao Parcial"
    if (ehParcial) {
      try {
        // Busca tag (cria se nao existir)
        let tagId = null;
        const { data: tagsExistentes } = await supabase
          .from('tags')
          .select('id, nome')
          .eq('nome', 'Devolucao Parcial')
          .limit(1);
        if (tagsExistentes && tagsExistentes.length > 0) {
          tagId = tagsExistentes[0].id;
        } else {
          const { data: novaTag } = await supabase
            .from('tags')
            .insert([{ nome: 'Devolucao Parcial', cor: '#f57c00' }])
            .select()
            .single();
          tagId = novaTag?.id;
        }
        // Vincula a tag a essa devolucao
        if (tagId) {
          await supabase
            .from('devolucao_tags')
            .insert([{ devolucao_id: data.id, tag_id: tagId }]);
        }
      } catch (e) {
        console.warn('[TRIAGEM] Erro ao aplicar tag Parcial (nao critico):', e.message);
      }
    }

    const flagLog = ehParcial ? '[PARCIAL]' : (dados.bipagem_forcada ? '[FORCADO]' : '');
    console.log(`[TRIAGEM] APROVADO por ${req.usuario}: shipment=${dados.shipment_id} NF=${dados.nf_numero} ${flagLog}`);
    // v3.17.0 - NAO dispara email pra parcial (Diego pediu)
    return res.json({ ok: true, id: data.id, registro: data, eh_parcial: ehParcial });
  } catch (err) {
    console.error('[TRIAGEM] Erro:', err);
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// Upload de uma foto pro Supabase Storage
// Retorna URL publica pra frontend acumular ate ter as 6+ fotos
app.post('/api/triagem/upload-foto', requerEstoquista, upload.single('foto'), async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ ok: false, erro: 'Supabase nao configurado' });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, erro: 'Foto nao enviada' });
  }

  const ext = (req.file.originalname || 'foto.jpg').split('.').pop().toLowerCase();
  const ts = Date.now();
  const random = crypto.randomBytes(4).toString('hex');
  const filename = `${req.usuario}/${ts}-${random}.${ext}`;

  try {
    const { error } = await supabase.storage
      .from('fotos-problema')
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype || 'image/jpeg',
        upsert: false,
      });

    if (error) {
      console.error('[UPLOAD] Erro:', error);
      return res.status(500).json({ ok: false, erro: error.message });
    }

    const { data: pub } = supabase.storage
      .from('fotos-problema')
      .getPublicUrl(filename);

    console.log(`[UPLOAD] ${req.usuario}: ${filename} (${(req.file.size / 1024).toFixed(0)}KB)`);
    return res.json({ ok: true, url: pub.publicUrl, filename });
  } catch (err) {
    console.error('[UPLOAD] Erro:', err);
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// Caminho PROBLEMA - registra com fotos ja uploadadas + manda email
app.post('/api/triagem/problema', requerEstoquista, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ ok: false, erro: 'Supabase nao configurado' });
  }
  const dados = req.body || {};

  // v3.62.1 - vendas sem shipment (Magalu, chave DANFE, numero da NF) sao
  // identificadas pela nf_chave. A validacao aceita qualquer um dos dois -
  // era so o insert que aceitava (v3.49), a validacao ficou pra tras e
  // barrava o CONFIRMAR com "shipment_id obrigatorio".
  if (!dados.shipment_id && !dados.nf_chave && !dados.magalu_protocolo) {
    return res.status(400).json({ ok: false, erro: 'shipment_id, nf_chave ou magalu_protocolo obrigatorio' });
  }
  const fotos = Array.isArray(dados.fotos) ? dados.fotos : [];
  if (fotos.length < 6) {
    return res.status(400).json({ ok: false, erro: `Minimo 6 fotos obrigatorias (recebido: ${fotos.length})` });
  }

  // Bloqueia duplicata
  if (!dados.forcar) {
    const { data: existentes, error: errBusca } = await supabase
      .from('devolucoes')
      .select('id, created_at, tipo, status, problema_descricao')
      .eq('shipment_id', String(dados.shipment_id || dados.nf_chave || dados.magalu_protocolo || '')) // v3.64: mesmo identificador que o insert grava
      .limit(1);
    if (errBusca) {
      console.error('[TRIAGEM] Erro busca duplicata:', errBusca);
    } else if (existentes && existentes.length > 0) {
      return res.status(409).json({
        ok: false,
        erro: 'duplicata',
        mensagem: 'Esta devolucao ja foi triada antes',
        registro_existente: existentes[0],
      });
    }
  }

  try {
    // v3.15.2 - Antes de gravar, busca numero do pedido Bling pelo order_id
    let pedidoBlingNumero = null;
    if (dados.order_id) {
      // Usa data da NF como referencia pra otimizar busca paginada
      const dataRef = dados.nf_data_emissao || null;
      const r = await buscarPedidoBlingPorNumeroLoja(String(dados.order_id), dataRef, { maxPaginas: 50 });
      if (r?.ok && r.match?.numero) {
        pedidoBlingNumero = String(r.match.numero);
        console.log(`[TRIAGEM] Pedido Bling achado: ${pedidoBlingNumero} (order_id ML=${dados.order_id})`);
      }
    }

    const { data, error } = await supabase
      .from('devolucoes')
      .insert([{
        shipment_id: String(dados.shipment_id || dados.nf_chave || dados.magalu_protocolo || ''), // v3.64: identificador em cascata (shipment > chave NF > protocolo Magalu)
        order_id: dados.order_id ? String(dados.order_id) : null,
        pack_id: dados.pack_id ? String(dados.pack_id) : null,
        buyer_id: dados.buyer_id ? String(dados.buyer_id) : null,
        buyer_nome: dados.buyer_nome || null,
        buyer_nickname: dados.buyer_nickname || null,
        pedido_bling_numero: pedidoBlingNumero,
        produto_titulo: dados.produto_titulo || null,
        produto_mlb: dados.produto_mlb || null,
        produto_sku: dados.produto_sku || null,
        produto_qtd: dados.produto_qtd || null,
        produto_valor_unit: dados.produto_valor_unit || null,
        nf_numero: dados.nf_numero || null,
        nf_serie: dados.nf_serie || null,
        nf_chave: dados.nf_chave || null,
        nf_valor: dados.nf_valor || null,
        nf_data_emissao: dados.nf_data_emissao || null,
        nf_id_bling: dados.nf_id_bling || null,
        nf_link_danfe: dados.nf_link_danfe || null,
        tipo: 'problema',
        status: 'pendente',
        funcionario: req.usuario,
        problema_descricao: ((dados.forcar ? '[RE-BIPE] ' : '') + `[Reportado por ${req.usuario}] ${dados.descricao || ''}`).trim(),
        problema_fotos: fotos,
      }])
      .select()
      .single();

    if (error) {
      console.error('[TRIAGEM] Erro Supabase:', error);
      return res.status(500).json({ ok: false, erro: error.message });
    }

    console.log(`[TRIAGEM] PROBLEMA por ${req.usuario}: shipment=${dados.shipment_id} fotos=${fotos.length}`);

    // Enviar email (nao bloqueia a resposta)
    if (mailer && EMAIL_TO) {
      enviarEmailProblema(data, fotos, req.usuario)
        .then(() => console.log(`[EMAIL] enviado pra ${EMAIL_TO}`))
        .catch(err => console.error('[EMAIL] Erro:', err.message));
    } else {
      console.warn('[EMAIL] Mailer nao configurado, pulando envio');
    }

    return res.json({ ok: true, id: data.id, registro: data });
  } catch (err) {
    console.error('[TRIAGEM] Erro:', err);
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// v3.18.0 - PRODUTO DIVERGENTE (envio errado do estoque)
// Quando estoquista bipa devolucao mas o produto que voltou
// nao e o que estava na NF (ex: cliente comprou A, voltou B).
// Diferenca pro PROBLEMA: nao tem defeito, foi erro do estoque.
// Diferenca pro APROVADO: SKU eh diferente, precisa de bipagem
// do EAN do produto que voltou (B), nao do esperado (A).
// ============================================================
app.post('/api/triagem/divergente', requerEstoquista, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ ok: false, erro: 'Supabase nao configurado' });
  }
  const dados = req.body || {};

  // v3.62.1 - vendas sem shipment (Magalu, chave DANFE, numero da NF) sao
  // identificadas pela nf_chave. A validacao aceita qualquer um dos dois -
  // era so o insert que aceitava (v3.49), a validacao ficou pra tras e
  // barrava o CONFIRMAR com "shipment_id obrigatorio".
  if (!dados.shipment_id && !dados.nf_chave && !dados.magalu_protocolo) {
    return res.status(400).json({ ok: false, erro: 'shipment_id, nf_chave ou magalu_protocolo obrigatorio' });
  }
  // Validacoes especificas: produto correto bipado + minimo 3 fotos
  if (!dados.produto_correto_sku) {
    return res.status(400).json({ ok: false, erro: 'produto_correto_sku obrigatorio (SKU do que voltou)' });
  }
  const fotos = Array.isArray(dados.fotos) ? dados.fotos : [];
  if (fotos.length < 3) {
    return res.status(400).json({ ok: false, erro: `Minimo 3 fotos obrigatorias (recebido: ${fotos.length})` });
  }

  // Bloqueia duplicata
  if (!dados.forcar) {
    const { data: existentes, error: errBusca } = await supabase
      .from('devolucoes')
      .select('id, created_at, tipo, status, problema_descricao')
      .eq('shipment_id', String(dados.shipment_id || dados.nf_chave || dados.magalu_protocolo || '')) // v3.64: mesmo identificador que o insert grava
      .limit(1);
    if (errBusca) {
      console.error('[TRIAGEM] Erro busca duplicata:', errBusca);
    } else if (existentes && existentes.length > 0) {
      return res.status(409).json({
        ok: false,
        erro: 'duplicata',
        mensagem: 'Esta devolucao ja foi triada antes',
        registro_existente: existentes[0],
      });
    }
  }

  try {
    // Busca pedido Bling
    let pedidoBlingNumero = null;
    if (dados.order_id) {
      const dataRef = dados.nf_data_emissao || null;
      const r = await buscarPedidoBlingPorNumeroLoja(String(dados.order_id), dataRef, { maxPaginas: 50 });
      if (r?.ok && r.match?.numero) {
        pedidoBlingNumero = String(r.match.numero);
      }
    }

    const obs = (dados.observacao || '').trim();
    const skuEsperado = dados.produto_sku_esperado || '?';
    const skuVoltou = dados.produto_correto_sku;
    const descricao = `[DIVERGENTE por ${req.usuario}] NF tinha SKU ${skuEsperado}, mas voltou SKU ${skuVoltou} (${dados.produto_correto_titulo || '?'})${obs ? '. OBS: ' + obs : ''}`;

    const { data, error } = await supabase
      .from('devolucoes')
      .insert([{
        shipment_id: String(dados.shipment_id || dados.nf_chave || dados.magalu_protocolo || ''), // v3.64: identificador em cascata (shipment > chave NF > protocolo Magalu)
        order_id: dados.order_id ? String(dados.order_id) : null,
        pack_id: dados.pack_id ? String(dados.pack_id) : null,
        buyer_id: dados.buyer_id ? String(dados.buyer_id) : null,
        buyer_nome: dados.buyer_nome || null,
        buyer_nickname: dados.buyer_nickname || null,
        pedido_bling_numero: pedidoBlingNumero,
        // SKU e titulo agora sao do produto que VOLTOU (nao do que estava na NF)
        produto_titulo: dados.produto_correto_titulo || null,
        produto_mlb: dados.produto_mlb || null,
        produto_sku: skuVoltou,
        produto_qtd: dados.produto_qtd || 1,
        produto_valor_unit: dados.produto_valor_unit || null,
        // NF original mantida pra rastrear o pedido que originou
        nf_numero: dados.nf_numero || null,
        nf_serie: dados.nf_serie || null,
        nf_chave: dados.nf_chave || null,
        nf_valor: dados.nf_valor || null,
        nf_data_emissao: dados.nf_data_emissao || null,
        nf_id_bling: dados.nf_id_bling || null,
        nf_link_danfe: dados.nf_link_danfe || null,
        tipo: 'divergente',
        status: 'pendente',
        funcionario: req.usuario,
        problema_descricao: (dados.forcar ? '[RE-BIPE] ' : '') + descricao,
        problema_fotos: fotos,
      }])
      .select()
      .single();

    if (error) {
      console.error('[TRIAGEM] Erro Supabase divergente:', error);
      return res.status(500).json({ ok: false, erro: error.message });
    }

    console.log(`[TRIAGEM] DIVERGENTE por ${req.usuario}: shipment=${dados.shipment_id} esperado=${skuEsperado} voltou=${skuVoltou} fotos=${fotos.length}`);
    // v3.18.0 - NAO dispara email (Diego pediu)
    return res.json({ ok: true, id: data.id, registro: data });
  } catch (err) {
    console.error('[TRIAGEM] Erro divergente:', err);
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

async function enviarEmailProblema(devolucao, fotos, usuario) {
  if (!mailer) return;

  const baseUrl = (process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
  const linkAdmin = baseUrl ? `${baseUrl}/admin.html` : '/admin.html';

  const fotosHtml = fotos.map((url, i) =>
    `<a href="${url}" target="_blank" style="display:inline-block;margin:4px;text-decoration:none;">
      <img src="${url}" alt="Foto ${i+1}" style="max-width:200px;max-height:200px;border:2px solid #ddd;border-radius:8px;"/>
    </a>`
  ).join('');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;margin:auto;padding:20px;">
      <h2 style="color:#b00020;">⚠️ Devolucao com PROBLEMA reportada</h2>
      <p><strong>Reportado por:</strong> ${usuario}<br>
         <strong>Quando:</strong> ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>

      <h3 style="border-bottom:1px solid #eee;padding-bottom:5px;">Produto</h3>
      <p><strong>${devolucao.produto_titulo || '-'}</strong><br>
         SKU: ${devolucao.produto_sku || '-'} | MLB: ${devolucao.produto_mlb || '-'}<br>
         Quantidade: ${devolucao.produto_qtd || '-'} un | Valor: R$ ${(devolucao.produto_valor_unit || 0).toFixed(2)}</p>

      <h3 style="border-bottom:1px solid #eee;padding-bottom:5px;">Comprador</h3>
      <p>${devolucao.buyer_nome || '-'} | ID: ${devolucao.buyer_id || '-'}</p>

      <h3 style="border-bottom:1px solid #eee;padding-bottom:5px;">Origem da Venda</h3>
      <p>
        <strong>Pedido ML:</strong> ${devolucao.order_id ? `#${devolucao.order_id}` : '—'}${devolucao.pack_id ? ` (pack #${devolucao.pack_id})` : ''}<br>
        <strong>Apelido ML:</strong> ${devolucao.buyer_nickname || '—'}<br>
        <strong>Pedido Bling:</strong> ${devolucao.pedido_bling_numero ? `#${devolucao.pedido_bling_numero}` : '—'}
      </p>

      <h3 style="border-bottom:1px solid #eee;padding-bottom:5px;">NF-e</h3>
      <p>Numero: <strong>${devolucao.nf_numero || '-'}</strong> | Valor: R$ ${(devolucao.nf_valor || 0).toFixed(2)}<br>
         ${devolucao.nf_link_danfe ? `<a href="${devolucao.nf_link_danfe}">Abrir DANFE</a>` : ''}</p>

      <h3 style="border-bottom:1px solid #eee;padding-bottom:5px;">Descricao do problema</h3>
      <p style="background:#fff8e1;padding:12px;border-radius:8px;border-left:4px solid #f57c00;">
        ${(devolucao.problema_descricao || '').replace(/\n/g, '<br>')}
      </p>

      <h3 style="border-bottom:1px solid #eee;padding-bottom:5px;">Fotos (${fotos.length})</h3>
      ${fotosHtml}

      <p style="margin-top:30px;text-align:center;">
        <a href="${linkAdmin}" style="background:#007AFF;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
          🔗 Abrir area admin
        </a>
      </p>

      <p style="margin-top:20px;font-size:11px;color:#888;text-align:center;">
        ID interno: ${devolucao.id}<br>
        Sistema GOOD Devolucoes v3.18.0
      </p>
    </div>
  `;

  await mailer.sendMail({
    from: `"GOOD Estoque" <${EMAIL_USER}>`,
    to: EMAIL_TO,
    subject: `⚠️ PROBLEMA na devolucao - NF ${devolucao.nf_numero || '?'} - ${devolucao.produto_titulo?.substring(0, 50) || '?'}`,
    html,
  });
}

// ============================================================
// FASE 3: AREA ADMIN
// ============================================================

// Pagina admin (requer auth)
app.get('/admin.html', requerAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// v3.16.0: Pagina de relatorios (requer auth)
app.get('/admin/relatorios.html', requerAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'relatorios.html'));
});

// API: lista devolucoes pendentes (aprovadas + problemas)
app.get('/api/admin/devolucoes', requerAdmin, async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ ok: false, erro: 'Supabase nao configurado' });
  }
  try {
    const { data, error } = await supabase
      .from('devolucoes')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) {
      return res.status(500).json({ ok: false, erro: error.message });
    }

    // Separa por tipo
    const aprovadas = data.filter(d => d.tipo === 'aprovado');
    const problemas = data.filter(d => d.tipo === 'problema');
    const divergentes = data.filter(d => d.tipo === 'divergente'); // v3.18.0

    return res.json({
      ok: true,
      aprovadas,
      problemas,
      divergentes, // v3.18.0
      total: data.length,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
});

// ============================================================
// v3.15.0 (Fase 3B) - Helpers pra montar payload de devolucao
// ============================================================

// Formata CPF/CNPJ no padrao Bling (com pontos e hifen)
// v3.43 - formatarCpfCnpj/detectarTipoPessoa/municipios -> lib/nf-pessoa.js

// ============================================================
// v3.19 (Fase 3B) - Resolve o ID interno do Bling pelo numero da NF
// ============================================================
// v3.33 - DEBUG: lista as devolucoes Shopee que o proxy enxerga
// (v3.34.1: passthrough FIEL do proxy - inclui debug_amostra_crua
//  quando a lista vier vazia, pra diagnostico em 1 clique)
// v3.45.2 - PONTES de debug pro shopee-sync: usam o login admin (cookie)
// e repassam a chave por HEADER (o caminho que comprovadamente funciona).
// Zero chave na URL - fim do 401 por caractere quebrado.
// Uso (logado como admin):
//   /api/debug/shopee-procurar?q=260623TX31XFMT&dias=180
//   /api/debug/shopee-pedido?q=260623TX31XFMT
// ============================================================
// MAGALU (v3.52) - OAuth + exploracao da API de devolucoes
// ------------------------------------------------------------
// PAGINAS PUBLICAS: a Magalu EXIGE URLs de Termos de Uso e Politica de
// Privacidade na criacao do client (parametros --terms-of-use e
// --privacy-term do IDM CLI). Servimos aqui pra nao depender de site externo.
// ============================================================
const _paginaLegal = (titulo, corpo) => `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${titulo} - GOOD Import</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}
h1{font-size:24px;border-bottom:2px solid #eee;padding-bottom:10px}h2{font-size:17px;margin-top:26px}
p,li{font-size:15px}footer{margin-top:40px;padding-top:16px;border-top:1px solid #eee;color:#888;font-size:13px}</style>
</head><body><h1>${titulo}</h1>${corpo}
<footer>GOOD Import — sistema interno de gestao de devolucoes.<br>Contato: pelo Portal do Seller Magalu.</footer></body></html>`;

app.get('/termos-de-uso', (req, res) => {
  res.type('html').send(_paginaLegal('Termos de Uso', `
    <p>Esta aplicacao e de uso <b>interno e exclusivo</b> da GOOD Import, destinada a
    organizar o recebimento e a triagem de produtos devolvidos pelos marketplaces
    em que a empresa vende.</p>
    <h2>1. Finalidade</h2>
    <p>O sistema identifica a venda de origem de um pacote devolvido, localiza a nota
    fiscal correspondente e registra a conferencia feita pela equipe do galpao.</p>
    <h2>2. Uso das integracoes</h2>
    <p>A aplicacao se conecta a APIs de marketplaces (incluindo o Grupo Magalu) apenas
    para <b>leitura</b> das informacoes das proprias vendas e devolucoes da GOOD Import,
    com autorizacao expressa do titular da conta de vendedor.</p>
    <h2>3. Acesso</h2>
    <p>O acesso e restrito a colaboradores autorizados, mediante login. Nao ha cadastro
    publico nem oferta do servico a terceiros.</p>
    <h2>4. Responsabilidade</h2>
    <p>A aplicacao e fornecida para uso operacional proprio, sem garantias comerciais,
    e pode ser alterada ou descontinuada a qualquer momento pela GOOD Import.</p>
  `));
});

app.get('/politica-de-privacidade', (req, res) => {
  res.type('html').send(_paginaLegal('Politica de Privacidade', `
    <p>Esta aplicacao e um sistema interno da GOOD Import. Nao coletamos dados de
    visitantes nem comercializamos qualquer informacao.</p>
    <h2>1. Dados acessados</h2>
    <p>Com a autorizacao do titular da conta de vendedor, acessamos, <b>somente para
    leitura</b>, dados das proprias vendas e devolucoes da GOOD Import nos marketplaces:
    identificadores de pedido, itens, notas fiscais e dados de remessa reversa.</p>
    <h2>2. Finalidade do tratamento</h2>
    <p>Os dados sao usados exclusivamente para identificar a qual venda pertence um
    pacote devolvido e registrar a conferencia interna do produto.</p>
    <h2>3. Compartilhamento</h2>
    <p>Nao compartilhamos dados com terceiros. As informacoes ficam restritas ao
    ambiente da propria empresa e aos colaboradores autorizados.</p>
    <h2>4. Armazenamento e seguranca</h2>
    <p>Os registros ficam em banco de dados de acesso restrito. As credenciais de
    integracao sao guardadas de forma segura no ambiente do servidor e usadas apenas
    para as chamadas autorizadas pelos escopos consentidos.</p>
    <h2>5. Revogacao</h2>
    <p>O titular da conta de vendedor pode revogar a autorizacao a qualquer momento
    pelo ID Magalu, encerrando imediatamente o acesso desta aplicacao.</p>
    <h2>6. Titular</h2>
    <p>Encarregado/contato: responsavel pela conta de vendedor da GOOD Import,
    acessivel pelo Portal do Seller Magalu.</p>
  `));
});

// Passo 1 do OAuth: manda o Diego (seller) pra tela de consentimento
app.get('/magalu/autorizar', requerAdmin, (req, res) => {
  if (!magalu.cfg.ativo) {
    return res.status(400).type('html').send(_paginaLegal('Magalu - falta configurar', `
      <p>Defina no Render as envs <b>MAGALU_CLIENT_ID</b>, <b>MAGALU_CLIENT_SECRET</b>
      e <b>MAGALU_REDIRECT_URI</b> antes de autorizar.</p>`));
  }
  return res.redirect(magalu.urlConsentimento('good'));
});

// Passo 2 do OAuth: a Magalu devolve o ?code= aqui. Trocamos por tokens.
// ATENCAO: esta rota e PUBLICA de proposito (o ID Magalu redireciona pra ca
// sem cookie da nossa sessao). Ela so aceita um code valido de 10 min e de
// uso unico - sem code valido, nao faz nada.
app.get('/magalu/callback', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) {
    return res.status(400).type('html').send(_paginaLegal('Magalu', '<p>Callback sem <b>code</b>. Refaca a autorizacao.</p>'));
  }
  try {
    const r = await magalu.trocarCodePorTokens(code);
    return res.type('html').send(_paginaLegal('Magalu conectada ✅', `
      <p><b>Autorizacao concluida.</b> Os tokens foram salvos.</p>
      <p>Escopos concedidos:<br><code>${(r.scope || '-').replace(/</g, '&lt;')}</code></p>
      <p>Pode fechar esta aba e voltar ao sistema.</p>`));
  } catch (e) {
    const det = e.response?.data ? JSON.stringify(e.response.data) : (e.message || String(e));
    return res.status(500).type('html').send(_paginaLegal('Magalu - erro', `
      <p>Falha ao trocar o code por tokens:</p><pre>${det.replace(/</g, '&lt;')}</pre>
      <p>O code vale 10 minutos e e de uso unico - tente autorizar de novo.</p>`));
  }
});

// Diagnostico: estado da conexao
app.get('/api/debug/magalu-status', requerAdmin, (req, res) => {
  return res.json({
    ok: true,
    configurado: magalu.cfg.ativo,
    autorizado: magalu.cfg.autorizado,
    client_id: magalu.cfg.clientId ? magalu.cfg.clientId.slice(0, 8) + '...' : null,
    redirect_uri: magalu.cfg.redirectUri || null,
    api_base: magalu.cfg.apiBase,
    escopos: magalu.cfg.scopes,
  });
});

// EXPLORACAO 1: lista tickets (as devolucoes vivem como ticket de pos-venda)
app.get('/api/debug/magalu-tickets', requerAdmin, async (req, res) => {
  const r = await magalu.listarTickets({
    _limit: req.query.limit || 20,
    _offset: req.query.offset || 0,
    status: req.query.status || undefined,
  });
  return res.status(r.ok ? 200 : (r.status || 502)).json({ ok: r.ok, status: r.status, data: r.data });
});

// EXPLORACAO 2: remessas reversas de um ticket (AQUI mora o rastreio?)
app.get('/api/debug/magalu-return', requerAdmin, async (req, res) => {
  const t = String(req.query.ticket || '').trim();
  if (!t) return res.status(400).json({ ok: false, erro: 'informe ?ticket=ID' });
  const r = await magalu.remessasReversasDoTicket(t);
  return res.status(r.ok ? 200 : (r.status || 502)).json({ ok: r.ok, status: r.status, data: r.data });
});

// v3.57 - CACADOR: onde mora o codigo de barras da etiqueta (196634440-01)?
// Varre os endpoints que temos escopo e diz em QUAL deles o numero aparece.
// Uso: /api/debug/magalu-caca?q=196634440&ticket=<id>&pedido=<uuid>
app.get('/api/debug/magalu-caca', requerAdmin, async (req, res) => {
  if (!magalu.cfg.autorizado) return res.status(400).json({ ok: false, erro: 'Magalu nao autorizada' });
  const alvo = String(req.query.q || '').replace(/\D/g, '');
  const ticket = String(req.query.ticket || '').trim();
  const pedido = String(req.query.pedido || '').trim();   // uuid do order
  const entrega = String(req.query.entrega || '').trim(); // uuid do delivery

  // procura o numero em qualquer lugar do JSON (recursivo)
  const contem = (obj) => {
    if (!alvo) return false;
    const txt = JSON.stringify(obj || {}).replace(/\D/g, '');
    return txt.includes(alvo);
  };

  const alvos = [];
  // v3.61 - A LISTA DE ESCOPOS do Diego revelou a "Shipping Open Api" de
  // SELLER: open:logistic-seller-shippings:read ("Leitura de remessas para
  // sellers") e open:logistic-seller-trackings:read. O padrao de URL da API
  // de carrier e /logistic-carrier/v1/shippings/{id} - entao a de seller
  // deve ser /logistic-seller/v1/... A LISTAGEM revela o formato dos IDs.
  const cod = alvo || '196634440';
  alvos.push(['SELLER-SHIP: lista', `/logistic-seller/v1/shippings?_limit=5`]);
  alvos.push(['SELLER-SHIP: por id', `/logistic-seller/v1/shippings/${cod}`]);
  alvos.push(['SELLER-SHIP: id -01', `/logistic-seller/v1/shippings/${cod}-01`]);
  alvos.push(['SELLER-TRACK: lista', `/logistic-seller/v1/trackings?_limit=5`]);
  alvos.push(['SELLER-SHIP v0: lista', `/logistic-seller/v0/shippings?_limit=5`]);
  alvos.push(['LOG/SELLER: lista', `/logistic/v1/seller/shippings?_limit=5`]);
  alvos.push(['SHIPPING: lista', `/shipping/v1/shippings?_limit=5`]);
  if (entrega) {
    alvos.push(['ORDER-LOG: da entrega', `/seller/v1/deliveries/${entrega}/logistics`]);
  }
  // carrier (provavel 403 pra seller, mas registra o comportamento)
  alvos.push(['CARRIER: por id', `/logistic-carrier/v1/shippings/${cod}`]);

  const achados = [];
  for (const [nome, caminho] of alvos) {
    await sleep(200);
    const r = await magalu.chamarMagalu(caminho);
    const bateu = r.ok && contem(r.data);
    achados.push({
      onde: nome,
      caminho,
      status: r.status,
      ok: r.ok,
      CONTEM_O_CODIGO: bateu || undefined,
      // se achou, mostra o JSON inteiro pra eu ver o campo exato
      resposta: bateu ? r.data : (r.ok ? '(ok, mas sem o codigo)' : r.data),
    });
  }
  return res.json({ ok: true, procurando: alvo || '(nada)', achados });
});

// EXPLORACAO livre ML (v3.65.1): tatear qualquer endpoint sem novo deploy
// Uso: /api/debug/ml-get?path=/post-purchase/v1/claims/search
app.get('/api/debug/ml-get', requerAdmin, async (req, res) => {
  const p = String(req.query.path || '').trim();
  if (!p.startsWith('/')) return res.status(400).json({ ok: false, erro: 'informe ?path=/...' });
  const r = await chamarML(`https://api.mercadolibre.com${p}`);
  return res.status(r.ok ? 200 : (r.status || 502)).json({ ok: r.ok, status: r.status, data: r.ok ? r.data : r.error });
});

// v3.76 - painel 'a espreita': devolucoes esperadas (em transito/atrasadas)
app.get('/api/admin/espreita', requerAdmin, async (req, res) => {
  return res.json({ ok: true, ...espreita.resumo() });
});
app.get('/api/debug/espreita-indice', requerAdmin, async (req, res) => {
  if (req.query.rebuild === '1') {
    try { await espreita.construirIndice(); } catch (e) { return res.status(500).json({ ok: false, erro: e.message }); }
  }
  return res.json({ ok: true, ...espreita.resumo() });
});

// v3.75 - TESTE DO BFF de devolucoes do portal Magalu Entregas: sera que o
// NOSSO token OAuth (escopo logistic-seller-shippings ja concedido) e aceito
// pela API interna do portal (seller-devolution-bff.mglu.io)?
// Endpoints vistos no DevTools: /v1/fulfillment/{tenant}?limit&offset (lista),
// /v1/fulfillment/totalizers/{tenant}. Abas Correios/Agencias por analogia.
// Uso: /api/debug/magalu-bff?path=/v1/fulfillment/goodimport-magazine%3Flimit=5
app.get('/api/debug/magalu-bff', requerAdmin, async (req, res) => {
  if (!magalu.cfg.autorizado) return res.status(400).json({ ok: false, erro: 'Magalu nao autorizada' });
  const p = String(req.query.path || '').trim();
  if (!p.startsWith('/')) return res.status(400).json({ ok: false, erro: 'informe ?path=/v1/...' });
  const tenant = String(req.query.tenant || 'goodimport-magazine').trim();
  const r = await magalu.chamarMagalu(`https://seller-devolution-bff.mglu.io${p}`, {
    headers: { 'x-tenant-id': tenant, Origin: 'https://seller.magaluentregas.com.br', Referer: 'https://seller.magaluentregas.com.br/' },
  });
  return res.status(200).json({ ok: r.ok, status: r.status, data: r.data });
});

// Indice de NFs por nome (?rebuild=1 | ?q=nome testa a busca)
app.get('/api/debug/nf-nomes-indice', requerAdmin, async (req, res) => {
  if (req.query.rebuild === '1') {
    try { await nfNomes.construirIndice(); } catch (e) { return res.status(500).json({ ok: false, erro: e.message }); }
  }
  const out = { ok: true, ...nfNomes.statusIndice() };
  if (req.query.q) out.busca = await nfNomes.buscarPorNome(String(req.query.q));
  return res.json(out);
});

// Indice de devolucoes ML por rastreio Correios (?rebuild=1 reconstroi)
app.get('/api/debug/ml-returns-indice', requerAdmin, async (req, res) => {
  if (req.query.rebuild === '1') {
    try { await mlReturns.construirIndice(); } catch (e) { return res.status(500).json({ ok: false, erro: e.message }); }
  }
  return res.json({ ok: true, ...mlReturns.statusIndice() });
});

// Exploracao crua: returns de um claim especifico (validar campos reais)
app.get('/api/debug/ml-returns', requerAdmin, async (req, res) => {
  const claim = String(req.query.claim || '').trim();
  if (!claim) return res.status(400).json({ ok: false, erro: 'informe ?claim=ID' });
  const r = await chamarML(`https://api.mercadolibre.com/post-purchase/v2/claims/${encodeURIComponent(claim)}/returns`);
  return res.status(r.ok ? 200 : (r.status || 502)).json({ ok: r.ok, status: r.status, data: r.ok ? r.data : r.error });
});

// Status do indice de devolucoes Magalu (?rebuild=1 reconstroi na hora)
app.get('/api/debug/magalu-indice', requerAdmin, async (req, res) => {
  if (!magalu.cfg.autorizado) return res.status(400).json({ ok: false, erro: 'Magalu nao autorizada' });
  if (req.query.rebuild === '1') {
    try { await magalu.construirIndiceDevolucoes(); } catch (e) { return res.status(500).json({ ok: false, erro: e.message }); }
  }
  return res.json({ ok: true, ...magalu.statusIndice() });
});

// EXPLORACAO 3: rota livre (pra tatear qualquer endpoint sem novo deploy)
app.get('/api/debug/magalu-get', requerAdmin, async (req, res) => {
  const p = String(req.query.path || '').trim();
  if (!p.startsWith('/')) return res.status(400).json({ ok: false, erro: 'informe ?path=/seller/v0/...' });
  const r = await magalu.chamarMagalu(p);
  return res.status(r.ok ? 200 : (r.status || 502)).json({ ok: r.ok, status: r.status, data: r.data });
});

// v3.54 - TESTE DO FILTRO DE DATA: descobrir por que 1 dia retorna vazio.
// Hipotese: o Bling trata as datas como datetime (00:00), entao
// inicial==final vira um intervalo vazio. Prova comparando variantes.
app.get('/api/debug/nf-filtro', requerAdmin, async (req, res) => {
  const dia = String(req.query.dia || '2026-06-20').trim();
  const d = new Date(dia + 'T00:00:00Z');
  const mais = (n) => new Date(d.getTime() + n * 864e5).toISOString().slice(0, 10);
  const variantes = [
    { nome: 'A) mesmo dia (o que eu usava)', ini: dia, fim: dia },
    { nome: 'B) dia ate dia+1', ini: dia, fim: mais(1) },
    { nome: 'C) dia-1 ate dia+1', ini: mais(-1), fim: mais(1) },
    { nome: 'D) janela de 7 dias', ini: mais(-3), fim: mais(3) },
    { nome: 'E) sem filtro de data', ini: null, fim: null },
  ];
  const out = [];
  for (const v of variantes) {
    await sleep(400);
    let url = `https://api.bling.com.br/Api/v3/nfe?limite=100&pagina=1&tipo=1`;
    if (v.ini) url += `&dataEmissaoInicial=${v.ini}&dataEmissaoFinal=${v.fim}`;
    const r = await chamarBling(url);
    const lista = (r.ok && r.data?.data) ? r.data.data : [];
    out.push({
      variante: v.nome,
      intervalo: v.ini ? `${v.ini} .. ${v.fim}` : '(nenhum)',
      status: r.status || null,
      qtd: lista.length,
      // amostra: primeiro e ultimo, pra ver a ORDEM e as datas reais
      primeira: lista[0] ? { numero: lista[0].numero, serie: lista[0].serie, data: lista[0].dataEmissao } : null,
      ultima: lista.length > 1 ? { numero: lista[lista.length - 1].numero, serie: lista[lista.length - 1].serie, data: lista[lista.length - 1].dataEmissao } : null,
      tem_a_75053: lista.some(nf => String(nf.numero || '').replace(/^0+/, '') === '75053') || undefined,
    });
  }
  return res.json({ ok: true, dia_testado: dia, variantes: out });
});

// v3.53 - RAIO-X da busca por numero da NF (mostra cada passo)
app.get('/api/debug/nf-numero', requerAdmin, async (req, res) => {
  const n = String(req.query.n || '').trim();
  if (!n) return res.status(400).json({ ok: false, erro: 'informe ?n=75053' });
  const serie = req.query.serie ? String(req.query.serie) : null;
  const trace = [];
  let achadas = [];
  let erro = null;
  try {
    achadas = await buscarNFsPorNumero(n, serie, { trace });
  } catch (e) { erro = e.message || String(e); }
  return res.json({ ok: true, alvo: n, serie_pedida: serie, achadas, erro, trace });
});

// v3.53 - o Bling devolve MESMO as NFs de um dia? (checa a suposicao base)
app.get('/api/debug/nf-dia', requerAdmin, async (req, res) => {
  const dia = String(req.query.dia || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return res.status(400).json({ ok: false, erro: 'informe ?dia=2026-06-20' });
  const url = `https://api.bling.com.br/Api/v3/nfe?limite=100&pagina=1&tipo=1&dataEmissaoInicial=${dia}&dataEmissaoFinal=${dia}`;
  const r = await chamarBling(url);
  const lista = (r.ok && r.data?.data) ? r.data.data : [];
  return res.json({
    ok: r.ok,
    status: r.status || null,
    url_chamada: url,
    qtd: lista.length,
    // so o essencial de cada NF: e aqui que vejo se numero/serie vem mesmo
    nfs: lista.slice(0, 100).map(nf => ({ id: nf.id, numero: nf.numero, serie: nf.serie, dataEmissao: nf.dataEmissao })),
    resposta_crua_se_vazio: lista.length === 0 ? r.data : undefined,
  });
});

app.get('/api/debug/shopee-indice-status', requerAdmin, async (req, res) => {
  try {
    if (!shopee.cfg.ativo) return res.status(400).json({ ok: false, erro: 'Shopee proxy sem envs' });
    const extra = (req.query.rebuild === '1' ? '?rebuild=1' : (req.query.amostra === '1' ? '?amostra=1' : ''));
    const url = `${shopee.cfg.url}/${shopee.cfg.loja}/interno/indice-status${extra}`;
    const r = await fetch(url, { headers: { 'x-internal-key': shopee.cfg.key } });
    const d = await r.json().catch(() => null);
    return res.status(r.ok ? 200 : 502).json(d || { ok: false, erro: 'resposta invalida (HTTP ' + r.status + ')' });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message || String(e) });
  }
});

app.get('/api/debug/shopee-procurar', requerAdmin, async (req, res) => {
  try {
    if (!shopee.cfg.ativo) return res.status(400).json({ ok: false, erro: 'Shopee proxy sem envs' });
    const q = encodeURIComponent(String(req.query.q || '').trim());
    if (!q) return res.status(400).json({ ok: false, erro: 'informe ?q=CODIGO' });
    const dias = Math.min(180, parseInt(req.query.dias, 10) || 150);
    const url = `${shopee.cfg.url}/${shopee.cfg.loja}/interno/devolucoes?procurar=${q}&dias=${dias}`;
    const r = await fetch(url, { headers: { 'x-internal-key': shopee.cfg.key } });
    const d = await r.json().catch(() => null);
    return res.status(r.ok ? 200 : 502).json(d || { ok: false, erro: 'resposta invalida (HTTP ' + r.status + ')' });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message || String(e) });
  }
});

app.get('/api/debug/shopee-pedido', requerAdmin, async (req, res) => {
  try {
    if (!shopee.cfg.ativo) return res.status(400).json({ ok: false, erro: 'Shopee proxy sem envs' });
    const q = encodeURIComponent(String(req.query.q || '').trim());
    if (!q) return res.status(400).json({ ok: false, erro: 'informe ?q=ORDER_SN' });
    const bruto = req.query.bruto === '1' ? '&bruto=1' : '';
    const url = `${shopee.cfg.url}/${shopee.cfg.loja}/interno/devolucoes?pedido=${q}${bruto}`;
    const r = await fetch(url, { headers: { 'x-internal-key': shopee.cfg.key } });
    const d = await r.json().catch(() => null);
    return res.status(r.ok ? 200 : 502).json(d || { ok: false, erro: 'resposta invalida (HTTP ' + r.status + ')' });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message || String(e) });
  }
});

app.get('/api/debug/shopee-devolucoes', requerAdmin, async (req, res) => {
  try {
    if (!shopee.cfg.ativo) {
      return res.status(400).json({ ok: false, erro: 'Configure SHOPEE_PROXY_URL e SHOPEE_PROXY_KEY no Render deste servico' });
    }
    const dados = await shopee.buscarDevolucoesProxy(req.query.refresh === '1');
    return res.json({ ok: true, qtd: (dados || []).length, devolucoes: dados });
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message || String(e) });
  }
});

// ============================================================
// v3.45 - rotas de impressao (QZ + fila) movidas p/ lib/rotas-impressao.js

// ============================================================
// v3.35 - FOTOS via servidor: baixa do bucket com a chave do
// servico (funciona com bucket publico OU privado) e entrega
// protegida pelo login do admin. Cura o "foto" quebrado quando
// o bucket deixa de ser publico no Supabase.
// ============================================================
// v3.35.1 - FOTOS via servidor, agora INDESTRUTIVEL:
//   1) tenta o download autenticado (cobre bucket PRIVADO)
//   2) se a chave/politica negar, busca a URL PUBLICA por dentro
//      do servidor e repassa (cobre bucket publico)
// Funciona em qualquer combinacao de bucket/chave. Erro vira
// texto explicativo (abrir a imagem numa aba mostra o motivo).
// v3.44 - rotas admin-NF movidas p/ lib/rotas-admin-nf.js
// (registradas junto do rotas-relatorios, apos as deps existirem)

// ============================================================
// v3.16.0: REGISTRA ROTAS DO DASHBOARD DE RELATORIOS
// (deve vir DEPOIS das declaracoes de supabase, requerAdmin, etc)
// ============================================================
registrarRotasRelatorios(app, { supabase, requerAdmin });

// v3.44 - rotas admin-NF (mesmo ponto: todas as deps ja declaradas acima)
const registrarRotasAdminNF = require('./lib/rotas-admin-nf');
registrarRotasAdminNF(app, {
  supabase, requerAdmin, adminOk, sleep,
  chamarBling, chamarML, buscarNFnoML,
  buscarNFePorId, buscarNFBlindada,
  resolverIdNFPorChave, mapItensNF,
});

// v3.45 - rotas de impressao (QZ assinado + fila remota)
const registrarRotasImpressao = require('./lib/rotas-impressao');
registrarRotasImpressao(app, { requerEstoquista, crypto, sleep });

// ============================================================
// FASE 3: LIMPEZA AUTOMATICA - DESABILITADA (Diego pediu)
// Registros sao mantidos para sempre. Quando atingir limite do plano free
// Supabase, migrar pro Pro ($25/mes) com 100GB Storage.
// ============================================================
// (codigo de limpeza removido em v3.10)

// ============================================================
// INICIAR
// ============================================================
// v3.56 - MAGALU: indice pre-aquecido (o pacote chega e o sistema JA sabe).
// 20s apos o boot e a cada 25 min. Silencioso e a prova de falha.
setTimeout(() => magalu.preAquecer(), 20 * 1000);
setTimeout(() => mlReturns.preAquecer(), 30 * 1000);
setTimeout(() => nfNomes.preAquecer(), 40 * 1000);
setTimeout(() => { if (magalu.cfg.autorizado) espreita.preAquecer(); }, 50 * 1000);
setInterval(() => magalu.preAquecer(), 25 * 60 * 1000);
setInterval(() => mlReturns.preAquecer(), 25 * 60 * 1000);
setInterval(() => nfNomes.preAquecer(), 25 * 60 * 1000);
setInterval(() => { if (magalu.cfg.autorizado) espreita.preAquecer(); }, 25 * 60 * 1000);

app.listen(PORT, () => {
  console.log('============================================');
  console.log('GOOD Devolucoes v3.56 - MAGALU integrada');
  console.log(`Porta: ${PORT}`);
  console.log(`ML: ${mlClient.hasToken() ? 'OK' : 'FALTA'}`);
  console.log(`Bling: ${blingClient.hasToken() ? 'OK' : 'FALTA'}`);
  console.log(`Render persist: ${((process.env.RENDER_API_KEY || process.env.RENDER_API_KEY_v2) && (process.env.RENDER_SERVICE_ID || process.env.RENDER_SERVICE_ID_v2)) ? 'OK' : 'FALTA'}`);
  console.log(`Supabase: ${supabase ? 'OK' : 'FALTA'}`);
  console.log(`Shopee proxy: ${shopee.cfg.ativo ? 'OK (loja ' + shopee.cfg.loja + ' via ' + shopee.cfg.url + ')' : 'AUSENTE - configure SHOPEE_PROXY_URL e SHOPEE_PROXY_KEY'}`);
  console.log(`QZ assinatura: ${((process.env.GOODBKP_QZ_CERT || process.env.QZ_CERT) && (process.env.GOODBKP_QZ_PRIVKEY || process.env.QZ_PRIVKEY)) ? 'OK (impressao sem popup)' : 'sem certificado (modo Allow) - configure GOODBKP_QZ_CERT e GOODBKP_QZ_PRIVKEY'}`);
  console.log(`Email: ${mailer ? 'OK (' + EMAIL_USER + ' -> ' + EMAIL_TO + ')' : 'FALTA'}`);
  console.log(`Usuarios: ${Object.keys(USERS).length > 0 ? Object.keys(USERS).join(', ') : 'FALTA'}`);
  console.log(`Admin: ${(ADMIN_USER && USERS[ADMIN_USER]) ? `OK (${ADMIN_USER})` : 'FALTA - defina ADMIN_USER e inclua no USERS'}`);
  console.log('============================================');
});
