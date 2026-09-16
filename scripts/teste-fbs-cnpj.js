'use strict';
/* 16/09 — a Shopee passa a exigir o CNPJ no generate_fbs_invoices em 30/10/2026. O dono
   confirmou que NÃO há CNPJ separado de filial: é o mesmo da empresa. Com isso, dá pra
   descobrir sozinho em vez de ele digitar — a CHAVE DE ACESSO de toda NF-e que já importamos
   carrega o CNPJ do emitente nas posições 7 a 20, e nós já guardamos essas chaves por loja
   para deduplicar. O dado estava em casa. */
const assert = require('assert');
const m = require('../modules/fbs-nf');

/* extração da chave: UF(2) + AAMM(4) + CNPJ(14) + resto */
const chave = '35' + '2609' + '12345678000195' + '55' + '001' + '000000123' + '1' + '00000001' + '7';
assert.strictEqual(chave.length, 44, 'a chave de exemplo precisa ter 44 dígitos');
assert.strictEqual(m.cnpjDaChave(chave), '12345678000195');

/* o que não é chave não vira CNPJ: melhor null do que um número errado indo pra Shopee */
assert.strictEqual(m.cnpjDaChave('123'), null);
assert.strictEqual(m.cnpjDaChave(''), null);
assert.strictEqual(m.cnpjDaChave(null), null);
assert.strictEqual(m.cnpjDaChave('x'.repeat(44)), null, 'letras não formam chave');

/* a env GANHA do descoberto: se um dia a Shopee exigir um CNPJ diferente, é só defini-la */
const antes = process.env.FBS_CNPJ_TESTE;
process.env.FBS_CNPJ_TESTE = '98.765.432/0001-10';
assert.strictEqual(m.cnpjDaLoja({ key: 'teste' }), '98765432000110',
  'a env tem precedência e aceita pontuação');
delete process.env.FBS_CNPJ_TESTE;
assert.strictEqual(m.cnpjDaLoja({ key: 'teste' }), null,
  'sem env e sem nota importada, devolve null — e o chamador falha ALTO em vez de mandar requisição incompleta');
if (antes !== undefined) process.env.FBS_CNPJ_TESTE = antes;

/* 16/09 — a falta de CNPJ NÃO pode derrubar a rotina. A pergunta do dono ("e se uma empresa
   passar a ter Full?") expôs que o `throw` que eu tinha posto quebrava o desenho de 13/09:
   sem CNPJ, a empresa passava a FALHAR onde antes saía calma dizendo que não havia documento
   — e o caso mais comum disso é justamente quem NÃO tem Full (Girassol e GOOD hoje).
   Avisar e seguir sem o campo é melhor nos dois tempos: até 30/10 a Shopee ainda aceita sem
   CNPJ, então nada muda; depois, ela recusa — que é o mesmo resultado que a empresa sem Full
   já tinha. */
{
  const fonte = require('fs').readFileSync(require('path').join(__dirname, '..', 'modules', 'fbs-nf.js'), 'utf8');
  const bloco = /FBS_ENVIAR_CNPJ \|\| ''\) === '1'\) \{[\s\S]*?\n  \}/.exec(fonte);
  assert.ok(bloco, 'não achei o bloco do CNPJ');
  assert.ok(!/throw new Error/.test(bloco[0]),
    'a falta de CNPJ não pode derrubar a rotina — quem não tem Full cairia aqui toda rodada');
  assert.ok(/console\.warn/.test(bloco[0]), 'mas tem que AVISAR, senão some em silêncio');
  assert.ok(/TEM Shopee Full/.test(bloco[0]) && /_FBS=0/.test(bloco[0]),
    'o aviso tem que separar quem tem Full de quem não tem — são caminhos diferentes');
  assert.ok(/30\/10/.test(bloco[0]), 'e lembrar a data em que a Shopee passa a recusar');
}

console.log('OK: CNPJ do FBS — descoberto pela chave de acesso das notas já importadas, com a env mandando quando existir');
