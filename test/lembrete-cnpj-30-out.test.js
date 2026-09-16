'use strict';
// ⚠️ O LEMBRETE DE 30/10 MORA NO CÓDIGO, NÃO NA MEMÓRIA DE NINGUÉM.
//
// [stated 16/09] "eu nao vou lembrar. vc consegue lembrar?" — não de forma
// confiável: eu leio minhas anotações quando ele fala comigo, mas **nada me
// cutuca numa data**.
//
// 📌 O que funciona é o que ele mesmo descobriu: princípio depende de alguém
// lembrar; **código avisa sozinho**. A data fica aqui, e o aviso aparece
// justamente quando ele abre o painel para trabalhar.
//
// ⚠️ Se passar de 30/10 sem ligar a env, a importação de XML do Shopee Full
// PARA — e o sintoma é nota sumindo sem erro visível.

const fs = require('fs');
const path = require('path');

let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const src = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'fbs-nf.js'), 'utf8');

// ── a data está no código ───────────────────────────────────────────
{
  ok(/const CNPJ_OBRIGATORIO_EM = Date\.UTC\(2026, 9, 30\)/.test(src),
     '⚠️ a data 30/10/2026 esta no codigo (mes 9 = outubro em JS)');
  ok(/function avisoPrazoCnpj\(loja\)/.test(src),
     'ha uma funcao que decide o aviso');
}

// ── ⚠️ e o aviso APARECE (log + campo da resposta) ──────────────────
//
// Aviso que ninguém vê não serve. Vai nos dois: o log pega o cron (4x/dia),
// o campo pega o painel (que ele abre para trabalhar).
{
  ok(/const avisoPrazo = avisoPrazoCnpj\(loja\);/.test(src),
     'a rotina calcula o aviso');
  ok(/console\.warn\(`\[\$\{loja\.key\} FBS\] \$\{avisoPrazo\}`\)/.test(src),
     '  e grita no LOG (pega o cron)');
  ok((src.match(/aviso_prazo: avisoPrazo/g) || []).length >= 4,
     '  ⚠️ e vai em TODAS as saidas da rotina (pega o painel)');

  // ⚠️ e está dentro de `rotina`, não de outra função — errei isso na 1ª vez
  const i = src.indexOf('const avisoPrazo = avisoPrazoCnpj(loja)');
  const j = src.lastIndexOf('async function ', i);
  ok(/async function rotina/.test(src.slice(j, j + 30)),
     '  ⚠️ dentro de `rotina()` (a 1a versao caiu em `fbsBaixar`)');
}

// ── as fases, exercitadas ───────────────────────────────────────────
{
  const EM = Date.UTC(2026, 9, 30);
  const aviso = (quando, ligado) => {
    if (ligado) return null;
    const d = Math.ceil((EM - Date.parse(quando)) / 864e5);
    if (d > 5) return null;
    return d > 0 ? `faltam ${d}` : 'atrasado';
  };

  ok(aviso('2026-09-16T12:00:00Z', false) === null,
     'hoje: silencio (a Shopee ainda recusa o campo)');
  ok(aviso('2026-10-24T12:00:00Z', false) === null,
     '  24/10: ainda silencio');
  ok(/^faltam/.test(aviso('2026-10-27T12:00:00Z', false) || ''),
     '⚠️ 27/10: AVISA, com 5 dias de folga pra ligar e conferir');
  ok(aviso('2026-10-31T12:00:00Z', false) === 'atrasado',
     '⚠️ 31/10 sem a env: ALERTA de atrasado (a busca ja falha)');
  ok(aviso('2026-11-15T12:00:00Z', false) === 'atrasado',
     '  e continua alertando enquanto nao ligar');

  // ⚠️ e para de encher quando resolvido
  ok(aviso('2026-11-15T12:00:00Z', true) === null,
     '  ⚠️ com a env ligada: silencio (nao vira ruido de fundo)');
}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
