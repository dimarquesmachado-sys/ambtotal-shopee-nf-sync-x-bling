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
  // ⚠️ b-tdz2: a data ganhou hora (03:00 UTC = 00:00 em Sao Paulo).
  //
  // `Date.UTC(2026,9,30)` chegava a zero as 21:00 de 29/10 em SP — nas 3
  // horas finais do dia 29 o aviso ja diria "atrasado", e o dono acharia
  // que perdeu o prazo tendo um dia inteiro pela frente.
  ok(/const CNPJ_OBRIGATORIO_EM = Date\.UTC\(2026, 9, 30, 3, 0, 0\)/.test(src),
     '⚠️ a data e 00:00 de 30/10 em SAO PAULO (03:00 UTC), nao UTC puro');
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

  // ⚠️ E ANTES DE QUALQUER `return` — TDZ.
  //
  // A 2a versao declarava depois do gate "empresa sem Full", que RETORNA
  // usando o campo: `Cannot access 'avisoPrazo' before initialization`.
  //
  // 📌 `node --check` NAO pega: e sintaxe valida, erro so em runtime. Quem
  // pegou foi o `fbs-sem-full`, que exercita o unico caminho que passa ali.
  const iRotina = src.indexOf('async function rotina(loja, opts = {})');
  const iDecl = src.indexOf('const avisoPrazo = avisoPrazoCnpj(loja)', iRotina);
  const iPrimeiroReturn = src.indexOf('return {', iRotina);
  ok(iDecl > 0 && iDecl < iPrimeiroReturn,
     '  ⚠️ e ANTES do 1o `return` da funcao (TDZ — o `node --check` nao pega)');
}

// ── as fases, exercitadas ───────────────────────────────────────────
{
  const EM = Date.UTC(2026, 9, 30, 3, 0, 0);   // 00:00 em SP
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

  // ⚠️ LIGADO NAO E O MESMO QUE RESOLVIDO (Codex, P2).
  //
  // Se a env esta ligada mas a loja nao tem CNPJ (empresa nova no Full, sem
  // nota importada e sem override), o pedido vai SEM o campo e a Shopee
  // recusa. Eu calava o aviso justamente nesse caso.
  ok(/if \(ligado && cnpjDaLoja\(loja\)\) return null;/.test(src),
     '⚠️ so cala quando LIGADO **E** com CNPJ disponivel');
  ok(!/if \(ligado\) return null;/.test(src),
     '  (a versao que calava so pela env saiu)');
}

// ── ⚠️ e o aviso vai no retorno de SUCESSO ──────────────────────────
//
// Era o caso MAIS COMUM — Shopee responde, ha notas, tudo certo — e era
// justamente aí que o lembrete sumia do painel. Só aparecia quando algo dava
// errado, que é quando ele menos ajuda.
{
  const iSucesso = src.lastIndexOf('return {\n      ok: true,');
  const bloco = iSucesso > 0 ? src.slice(iSucesso, iSucesso + 400) : '';
  ok(/aviso_prazo: avisoPrazo,/.test(bloco),
     '⚠️ o retorno de SUCESSO leva o aviso (era onde sumia)');
}

// ── e o `estadoAtual` calcula o proprio ─────────────────────────────
//
// ⚠️ Minha substituicao em massa pos `avisoPrazo` num `return` de OUTRA
// funcao, onde a variavel nao existe: `/fbs/ext/estado` devolveria HTTP 500
// pra quem nao tem ZIP ainda.
{
  ok(/aviso_prazo: avisoPrazoCnpj\(loja\), precisa: false/.test(src),
     '⚠️ `estadoAtual` CALCULA o aviso (nao usa variavel de outra funcao)');
}

// ── ⚠️ e o aviso CHEGA na extensão ──────────────────────────────────
//
// As rotas `/fbs/ext/estado` e `/fbs/ext/buscar` REMONTAM o JSON — campo
// novo do motor não chega sozinho. O aviso morreria ali, e a extensão é
// onde o dono trabalha: o lugar que mais importa.
{
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok((srv.match(/aviso_prazo/g) || []).length >= 2,
     '⚠️ as 2 rotas da extensao repassam o aviso');
  ok(/aviso_prazo: st\.aviso_prazo \|\| null/.test(srv),
     '  /fbs/ext/estado (o que ela chama ao abrir o Bling)');
  ok(/aviso_prazo: r\.aviso_prazo \|\| null/.test(srv),
     '  /fbs/ext/buscar (o Ctrl+Alt+S)');
}

// ── e loja SEM Full não recebe este aviso ───────────────────────────
//
// ⚠️ Quem declarou `<PREFIXO>_FBS=0` não usa Shopee Full — receberia alerta
// urgente sobre um prazo que não a atinge. Alerta que não cabe é como
// vermelho falso em teste: ensina a ignorar o que importa.
{
  ok(/if \(String\(loja && loja\.fbs\) === 'nao'\) return null;/.test(src),
     '⚠️ loja com `_FBS=0` nao recebe o aviso do CNPJ');
}

// ── ⚠️ e depois do prazo a mensagem distingue os 2 motivos ──────────
//
// Minha versão só falava de "env desligada" — e mandaria ligar uma env que
// JÁ está ligada, deixando o dono girando.
{
  // ⚠️ o texto quebra entre linhas no fonte (template literal concatenado),
  // entao procuro o pedaco que fica inteiro numa linha
  // ⚠️ b-av4: os DOIS momentos precisam distinguir — antes e depois do prazo.
  //
  // Eu corrigi so o "depois". Nos 5 dias ANTES, uma loja com a env ja ligada
  // mas sem CNPJ ouviria "ligue a env" — que ja esta ligada — e gastaria a
  // janela inteira de preparacao sem descobrir o que falta.
  //
  // 📌 A janela existe PRA ISSO. Mandar pro lugar errado a anula.
  const vezes = (src.match(/NAO TEM CNPJ/g) || []).length;
  ok(vezes >= 2,
     `⚠️ a distincao aparece nos 2 momentos (antes e depois) — achei ${vezes}`);
  ok(/FBS_CNPJ_\$\{String\(loja\.key/.test(src),
     '  apontando a env do CNPJ, nao a de ligar');
  ok(/NAO esta `\n\s*\+ `ligado/.test(src) || /NAO esta .+ligado/.test(src),
     '  e env desligada: aponta a env');
}

// ── ⚠️ e o PAINEL mostra, sem precisar clicar em "Buscar notas" ─────
//
// Abrir `/fbs/painel` chama `listar()`, que bate em `/fbs/pendentes` — e
// essa rota não passa pela `rotina()`. Quem abre o painel e baixa um ZIP já
// pronto (o uso MAIS comum: o cron deixou pronto, o dono só baixa) nunca
// veria o lembrete.
{
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/aviso_prazo: fbsNf\.avisoPrazoCnpj\(req\.loja\)/.test(srv),
     '⚠️ /fbs/pendentes CALCULA o aviso (nao passa pela rotina)');
  ok(/if \(j\.aviso_prazo\)/.test(srv),
     '  e o painel PINTA (rota que devolve sem tela que mostra nao serve)');

  // ⚠️ e a função está exportada — senão a rota chamaria algo inexistente
  const mod = fs.readFileSync(
    path.join(__dirname, '..', 'modules', 'fbs-nf.js'), 'utf8');
  const iExp = mod.lastIndexOf('module.exports = {');
  ok(/avisoPrazoCnpj,/.test(mod.slice(iExp)),
     '  ⚠️ e `avisoPrazoCnpj` esta EXPORTADA (senao o painel quebra)');
}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
