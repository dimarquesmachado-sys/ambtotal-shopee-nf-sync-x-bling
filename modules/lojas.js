// modules/lojas.js
// Configuracao central das lojas. Cada loja le suas env vars pelo prefixo EMPRESA_SYNC_.
// Pra adicionar uma loja nova, basta incluir aqui e criar as env vars correspondentes.

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SHOPEE_BASE = process.env.SHOPEE_SYNC_BASE_URL || 'https://partner.shopeemobile.com';

// Definicao das lojas. A "key" e usada nas rotas (/amb, /girassol, /good) e nas pastas de token.
const LOJAS = {
  amb: {
    key: 'amb',
    nome: 'AMBTotal',
    prefixo: 'AMB_SYNC',
  },
  girassol: {
    key: 'girassol',
    nome: 'Magazine Girassol',
    prefixo: 'GIRASSOL_SYNC',
  },
  good: {
    key: 'good',
    nome: 'GOOD Import',
    prefixo: 'GOOD_SYNC',
  },
};

/* 13/09 — SHOPEE FULL É POR EMPRESA. Hoje só a AMB tem; GOOD e Girassol respondiam FAILED
   na geração do documento, o que PARECIA erro e era só ausência de Full. Com CNPJ novo a
   caminho, isso viraria alarme recorrente pra quem embarcar a empresa. A resposta é
   declarada — `<PREFIXO>_FBS=1|0` — e o padrão é `auto`: sem declarar, o serviço tenta uma
   vez, e se a Shopee disser que não há documento, ele mesmo anota e para de insistir. */
function fbsDaLoja(base) {
  const v = String(process.env[base.prefixo + '_FBS'] || '').trim().toLowerCase();
  if (['1', 'sim', 'true'].includes(v)) return 'sim';
  if (['0', 'nao', 'não', 'false'].includes(v)) return 'nao';
  return 'auto';
}

// Monta a config completa de uma loja, lendo as env vars pelo prefixo.
function getConfigLoja(key) {
  const base = LOJAS[key];
  if (!base) throw new Error(`Loja desconhecida: ${key}`);
  const fbs = fbsDaLoja(base);
  const p = base.prefixo;

  return {
    key: base.key,
    fbs,          /* 'sim' | 'nao' | 'auto' — se esta empresa usa Shopee Full */
    nome: base.nome,
    prefixo: p,
    shopeeBase: SHOPEE_BASE,
    bling: {
      clientId: process.env[`${p}_BLING_CLIENT_ID`] || '',
      clientSecret: process.env[`${p}_BLING_CLIENT_SECRET`] || '',
      tokenFile: path.join(DATA_DIR, base.key, 'tokens-bling.json'),
    },
    shopee: {
      partnerId: process.env[`${p}_SHOPEE_PARTNER_ID`] || '',
      partnerKey: process.env[`${p}_SHOPEE_PARTNER_KEY`] || '',
      tokenFile: path.join(DATA_DIR, base.key, 'tokens-shopee.json'),
    },
  };
}

// Retorna a lista de lojas que estao CONFIGURADAS (com credenciais Bling+Shopee preenchidas).
// Lojas sem env vars sao ignoradas - permite ativar Girassol/GOOD so quando tiverem credenciais.
function lojasConfiguradas() {
  return Object.keys(LOJAS)
    .map(getConfigLoja)
    .filter(l => l.bling.clientId && l.shopee.partnerId);
}

// Retorna todas as keys validas (pra validar rotas)
function lojasValidas() {
  return Object.keys(LOJAS);
}

module.exports = { getConfigLoja, lojasConfiguradas, lojasValidas, LOJAS, DATA_DIR, SHOPEE_BASE };
