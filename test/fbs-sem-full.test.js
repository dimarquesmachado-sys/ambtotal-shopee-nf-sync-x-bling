'use strict';
/* 13/09 — EMPRESA SEM SHOPEE FULL NÃO PODE VIRAR ERRO. Hoje só a AMB usa Full; GOOD e
   Girassol devolviam FAILED na geração do documento, o que parecia falha do serviço e era
   ausência de Full. Com CNPJ novo a caminho, quem embarcar a empresa herdaria esse alarme.
   Três caminhos travados aqui: declarado não, declarado sim, e o modo auto que aprende. */
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fbs-teste-'));
const { getConfigLoja } = require('../modules/lojas');
const fbs = require('../modules/fbs-nf');

(async () => {
  // 1) declarada SEM Full: sai limpa e nem fala com a Shopee
  process.env.GOOD_SYNC_FBS = '0';
  const good = getConfigLoja('good');
  assert.strictEqual(good.fbs, 'nao');
  const r1 = await fbs.rotina(good, {});
  assert.strictEqual(r1.ok, true, 'ausência de Full não é falha');
  assert.strictEqual(r1.sem_full, true);
  assert.ok(/GOOD_SYNC_FBS=0/.test(r1.motivo), 'a resposta diz de onde veio a decisão');

  // 2) sem declaração: modo auto (tenta uma vez e aprende)
  delete process.env.GIRASSOL_SYNC_FBS;
  assert.strictEqual(getConfigLoja('girassol').fbs, 'auto');

  // 3) auto que JÁ aprendeu: sai limpo, sem gastar chamada, e ensina como reverter
  const gir = getConfigLoja('girassol');
  fs.mkdirSync(path.join(process.env.DATA_DIR, 'fbs-nf'), { recursive: true });
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'fbs-nf', '_sem-full-girassol.json'),
                   JSON.stringify({ em: '2026-09-13T10:00:00.000Z', motivo: 'FAILED' }));
  const r3 = await fbs.rotina(gir, {});
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.sem_full, true);
  assert.ok(/forcar=1|_FBS=1/.test(r3.motivo), 'tem que dizer como voltar atrás quando a loja passar a usar Full');

  // 4) declarada COM Full: a memória do 'sem full' não segura mais
  process.env.GIRASSOL_SYNC_FBS = '1';
  assert.strictEqual(getConfigLoja('girassol').fbs, 'sim');

  console.log('OK: Full por empresa — declarado não sai limpo, auto aprende e explica como reverter, declarado sim ignora a memória');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
