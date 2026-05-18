// modules/token-manager.js
// Gerencia rotacao automatica de access_token Bling AMBTotal NF-Shopee

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '..', 'data', 'tokens-bling.json');

function ensureDataDir() {
  const dir = path.dirname(TOKEN_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTokens() {
  ensureDataDir();
  if (!fs.existsSync(TOKEN_FILE)) {
    const initial = {
      access_token: process.env.BLING_ACCESS_TOKEN || '',
      refresh_token: process.env.BLING_REFRESH_TOKEN || '',
      expires_at: 0
    };
    saveTokens(initial);
    return initial;
  }
  return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

function saveTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

async function refreshBlingToken() {
  const tokens = loadTokens();
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;

  if (!tokens.refresh_token) {
    throw new Error('BLING refresh_token ausente. Faca OAuth inicial via /setup-bling com {code}');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '1.0',
      'enable-jwt': '1'
    },
    body: `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Refresh Bling falhou: ${JSON.stringify(data)}`);
  }

  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000) - 60000
  };

  saveTokens(newTokens);
  console.log('[token-manager] Bling token renovado');
  return newTokens;
}

async function getValidBlingToken() {
  let tokens = loadTokens();
  if (!tokens.access_token || Date.now() >= tokens.expires_at) {
    tokens = await refreshBlingToken();
  }
  return tokens.access_token;
}

async function setupBlingWithCode(authCode) {
  const clientId = process.env.BLING_CLIENT_ID;
  const clientSecret = process.env.BLING_CLIENT_SECRET;
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch('https://api.bling.com.br/Api/v3/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '1.0',
      'enable-jwt': '1'
    },
    body: `grant_type=authorization_code&code=${authCode}`
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Setup Bling falhou: ${JSON.stringify(data)}`);
  }

  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000) - 60000
  };

  saveTokens(newTokens);
  return newTokens;
}

module.exports = {
  getValidBlingToken,
  refreshBlingToken,
  setupBlingWithCode,
  loadTokens
};
