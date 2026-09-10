#!/usr/bin/env node
'use strict';
/* Bateria pré-push do shopee-nf-sync — nasceu em 10/09/2026, no dia em que um patch
   declarou `opts` numa função e o usou em outra: o node --check passa (sintaxe ok),
   os 2 testes unitários passam (não exercitam o fluxo), e produção quebrou no cron.
   O que teria pego: análise de VARIÁVEL NÃO DECLARADA (no-undef) + boot real.
   Rode SEMPRE antes de push: node scripts/verifica.js  →  ✅ PODE SUBIR | ❌ NAO SUBIR */
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
let problemas = 0;
const ok = (m) => console.log('  ✓ ' + m);
const ruim = (m) => { problemas++; console.log('  ✗ ' + m); };

console.log('═ 1. Sintaxe (node --check) ═');
const js = [];
for (const dir of ['', 'modules', 'scripts', 'test']) {
  const d = path.join(RAIZ, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) if (f.endsWith('.js')) js.push(path.join(d, f));
}
for (const f of js) {
  try { execSync('node --check ' + JSON.stringify(f), { stdio: 'pipe' }); }
  catch (e) { ruim('sintaxe: ' + f + ' — ' + String(e.stderr).slice(0, 160)); }
}
if (!problemas) ok(js.length + ' arquivos .js com sintaxe válida');

console.log('═ 2. Variáveis não declaradas (a classe do bug do opts) ═');
try {
  /* Codex #12: config em TMPDIR sempre regravada (não suja o checkout nem congela
     versão velha via existsSync). */
  const os = require('os');
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verifica-lint-')), 'no-undef.mjs');
  fs.writeFileSync(cfg, "export default [{ files: ['**/*.js'], ignores: ['node_modules/**'], languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { require: 'readonly', module: 'readonly', process: 'readonly', console: 'readonly', __dirname: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', URLSearchParams: 'readonly', URL: 'readonly', fetch: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly', setImmediate: 'readonly', exports: 'writable' } }, rules: { 'no-undef': 'error' } }];\n");
  /* Codex #12: cobertura de TODOS os .js que o --check viu (scripts e raiz inclusos). */
  const saida = execSync('npx --yes eslint --no-config-lookup -c ' + JSON.stringify(cfg) + ' ' + js.map(f => JSON.stringify(f)).join(' ') + ' 2>&1 || true', { cwd: RAIZ, encoding: 'utf8', timeout: 120000 });
  if (/no-undef/.test(saida)) ruim('variável não declarada:\n' + saida.split('\n').filter(l => /no-undef|\.js$/.test(l)).slice(0, 10).join('\n'));
  else if (/Error|error while|Oops/.test(saida) && !/problems/.test(saida)) ruim('eslint NÃO RODOU (' + (saida.split('\n').find(l => l.trim()) || '').slice(0, 100) + ') — etapa MANDATÓRIA (fail closed); instale: npm install --no-save eslint');
  else ok('nenhuma variável usada sem declarar (' + js.length + ' arquivos)');
} catch (e) { ruim('eslint não rodou (' + String(e.message).slice(0, 80) + ') — etapa mandatória, fail closed'); }

console.log('═ 3. Boot real do servidor ═');
(async () => {
try {
  /* Codex #12: porta LIVRE (3891 fixa colidia e culpava o server pela falha do
     harness) e PULAR_CRON=1 — o filho de teste não agenda ciclos de produção. */
  const net = require('net');
  const porta = await new Promise((res) => { const sv = net.createServer(); sv.listen(0, () => { const p = sv.address().port; sv.close(() => res(p)); }); });
  const env = Object.assign({}, process.env, { PORT: String(porta), NODE_ENV: 'test', PULAR_CRON: '1' });
  const filho = spawn('node', ['server.js'], { cwd: RAIZ, env, stdio: 'pipe' });
  let saiu = false; let logBoot = '';
  filho.stdout.on('data', d => logBoot += d);
  filho.stderr.on('data', d => logBoot += d);
  filho.on('exit', () => { saiu = true; });
  const fim = Date.now() + 9000;
  const espera = () => new Promise(r => setTimeout(r, 400));
  (async () => {
    let subiu = false;
    while (Date.now() < fim) {
      await espera();
      if (saiu) break;
      try {
        const r = await fetch('http://localhost:' + porta + '/');
        if (r.ok) { subiu = true; break; } /* Codex #12: 500 na raiz passava como saudável */
        if (r.status >= 400) { logBoot += '\n[probe] raiz respondeu HTTP ' + r.status; break; }
      } catch (e) { /* ainda subindo */ }
    }
    if (subiu) ok('server.js sobe e responde na raiz (boot real)');
    else ruim('server.js NÃO subiu em 9s — ' + logBoot.slice(-300));
    try { filho.kill('SIGKILL'); } catch (e) {}

    console.log('═ 4. Testes ═');
    const testes = fs.existsSync(path.join(RAIZ, 'test')) ? fs.readdirSync(path.join(RAIZ, 'test')).filter(f => f.endsWith('.test.js')) : [];
    for (const t of testes) {
      try { execSync('node ' + JSON.stringify(path.join('test', t)), { cwd: RAIZ, stdio: 'pipe', timeout: 60000 }); ok('test/' + t); }
      catch (e) { ruim('test/' + t + ' — ' + String(e.stdout || e.stderr).slice(-200)); }
    }
    console.log(problemas ? '\n❌ NAO SUBIR — ' + problemas + ' problema(s)' : '\n✅ PODE SUBIR');
    process.exit(problemas ? 1 : 0);
  })();
} catch (e) { ruim('boot: ' + e.message); console.log('\n❌ NAO SUBIR'); process.exit(1); }
})();
