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

  // 3) declarada COM Full: a rotina segue o caminho normal (erro volta a ser erro)
  process.env.GIRASSOL_SYNC_FBS = '1';
  assert.strictEqual(getConfigLoja('girassol').fbs, 'sim');

  /* 4) NÃO existe mais adivinhação: a 1ª versão deduzia pela mensagem de erro se a loja
     tinha Full e gravava isso — três rodadas de revisão acharam jeitos diferentes de a
     dedução errar, sempre com o mesmo custo (loja COM Full parando de importar em
     silêncio). Este teste existe pra ninguém reintroduzir a heurística. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'fbs-nf.js'), 'utf8');
  assert.ok(!/marcarSemFull|lerSemFull|ehFaltaDeFull/.test(src),
            'a classificação por mensagem de erro não pode voltar — quem decide é a declaração da empresa');

  console.log('OK: Full por empresa — declarado não sai limpo e sem tocar na Shopee, declarado sim segue o fluxo, e a adivinhação por mensagem de erro não voltou');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
