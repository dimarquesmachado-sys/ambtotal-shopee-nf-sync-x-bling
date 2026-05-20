// modules/token-manager.js
// Gerencia rotacao automatica de access_token Bling, por loja.
// Cada funcao recebe o objeto "loja" (config de modules/lojas.js).

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

function ensureDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadTokens(loja) {
  const file = loja.bling.tokenFile;
  ensureDir(file);
  if (!fs.existsSync(file)) {
    const initial = { access_token: '', refresh_token: '', expires_at: 0 };
    saveTokens(loja, initial);
    return initial;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveTokens(loja, tokens) {
  const file = loja.bling.tokenFile;
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2));
}

async function refreshBlingToken(loja) {
  const tokens = loadTokens(loja);
  const clientId = loja.bling.clientId;
  const clientSecret = loja.bling.clientSecret;

  if (!tokens.refresh_token) {
    throw new Error(`[${loja.key}] Bling refresh_token ausente. Faca OAuth inicial via /${loja.key}/setup-bling com {code}`);
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
    throw new Error(`[${loja.key}] Refresh Bling falhou: ${JSON.stringify(data)}`);
  }

  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000) - 60000
  };

  saveTokens(loja, newTokens);
  console.log(`[token-manager][${loja.key}] Bling token renovado`);
  return newTokens;
}

async function getValidBlingToken(loja) {
  let tokens = loadTokens(loja);
  if (!tokens.access_token || Date.now() >= tokens.expires_at) {
    tokens = await refreshBlingToken(loja);
  }
  return tokens.access_token;
}

async function setupBlingWithCode(loja, authCode) {
  const clientId = loja.bling.clientId;
  const clientSecret = loja.bling.clientSecret;
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
    throw new Error(`[${loja.key}] Setup Bling falhou: ${JSON.stringify(data)}`);
  }

  const newTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in * 1000) - 60000
  };

  saveTokens(loja, newTokens);
  return newTokens;
}

module.exports = {
  getValidBlingToken,
  refreshBlingToken,
  setupBlingWithCode,
  loadTokens
};
