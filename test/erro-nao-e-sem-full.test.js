'use strict';
// ⚠️ ERRO DA API NÃO É "EMPRESA SEM FULL".
//
// [stated 16/09] o dono ligou `FBS_ENVIAR_CNPJ=1` e a Shopee recusou com
// `ERROR_SP_SERVICE_UNEXPECTED_V2` — ela ainda **não aceita** o campo antes
// de 30/10. Mas a mensagem daqui disse:
//
//   "a Shopee não gerou documento de Full — se esta empresa não usa Full,
//    declare AMB_SYNC_FBS=0 pra sair do ciclo"
//
// ⚠️ Seguir esse conselho **desligaria o Full da AMB por engano**. A empresa
// usa Full e tem 330 notas importadas — o problema era o campo novo.
//
// 📌 Sem tarefa gerada tem DUAS causas, e a conduta é OPOSTA:
//    nenhum erro  → período sem nota, ou empresa sem Full   (calmo)
//    erro da API  → algo quebrou e precisa de ação          (alto)

const fs = require('fs');
const path = require('path');

let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const src = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'fbs-nf.js'), 'utf8');

// ── a mensagem distingue os dois casos ──────────────────────────────
{
  ok(/const houveErro = errosGerar\.length > 0;/.test(src),
     'o codigo separa "houve erro" de "nao houve"');
  ok(/erro_api: houveErro \? errosGerar\[0\]/.test(src),
     '  e expoe o erro da API num campo proprio');
  ok(/ISTO NAO E "empresa sem Full"/.test(src),
     '⚠️ e a mensagem de erro DIZ que nao e "sem Full"');
  ok(/NAO declare/.test(src),
     '  desaconselhando explicitamente o `_FBS=0`');
}

// ── ⚠️ e reconhece o caso do CNPJ ligado ────────────────────────────
{
  ok(/const cnpjLigado = String\(process\.env\.FBS_ENVIAR_CNPJ \|\| ''\) === '1';/.test(src),
     'detecta que o envio de CNPJ esta ligado');
  ok(/DESLIGUE a env e a busca volta/.test(src),
     '⚠️ e diz o que fazer (era o caso real do dono)');
  ok(/30\/10\/2026/.test(src),
     '  com a data a partir da qual a Shopee aceita');
}

// ── ⚠️ e NÃO muda a semântica de `sem_documento` ────────────────────
//
// A extensão do navegador consome esse campo (server.js repassa em
// /fbs/ext/estado), e o código dela não está neste repo. Mudar contrato que
// outro lado consome, sem poder ler esse outro lado, é como a fila de
// impressão quebrou hoje.
{
  const i = src.indexOf('const houveErro = errosGerar.length > 0;');
  const bloco = src.slice(i, src.indexOf('periodo: { de: ymdRotulo(start)', i));
  ok(/sem_documento: true,/.test(bloco),
     '⚠️ `sem_documento` continua `true` (contrato preservado)');
  ok(!/sem_documento: !houveErro/.test(src),
     '  e NAO virou condicional');
}

// ── as três mensagens, exercitadas ──────────────────────────────────
{
  const montar = (erros, cnpjLigado) => {
    const houveErro = erros.length > 0;
    return !houveErro
      ? 'nenhuma nota de Full no periodo'
      : ('a Shopee RECUSOU: ' + erros[0]
        + (cnpjLigado ? ' — FBS_ENVIAR_CNPJ esta LIGADO' : ' — ISTO NAO E "empresa sem Full"'));
  };

  ok(!/RECUSOU/.test(montar([], false)),
     'sem erro: mensagem calma, sem alarme');
  ok(/FBS_ENVIAR_CNPJ esta LIGADO/.test(montar(['ERROR_SP_SERVICE_UNEXPECTED_V2'], true)),
     '⚠️ CNPJ ligado: aponta a env (o caso real de 16/09)');
  ok(/NAO E "empresa sem Full"/.test(montar(['HTTP 500'], false)),
     '  outro erro: avisa que nao e ausencia de Full');
}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
