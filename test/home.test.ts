import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { commands } from '../src/commands.ts';
import {
  type HomeContext,
  type HomeState,
  badgeText,
  groupOrder,
  homeEntries,
  homeHints,
  homeState,
  homeStep,
  loadHomeContext,
  renderHome,
} from '../src/home.ts';
import type { Key } from '../src/menu.ts';
import { UNIVERSAL_KEYS, plainStyle } from '../src/screens.ts';
import { guidedProblems, setupProject } from './helpers.ts';

const NOW = new Date('2026-10-31T12:00:00Z');
const FIVE_HOUR = { window: 'five_hour', utilization: 0.4, resetsAt: new Date('2026-10-31T14:00:00Z'), observedAt: NOW };
const PENDING: HomeContext = { project: 'loja-api', path: '~/Pessoal/loja-api', instance: true, ready: 2, pending: 2, units: 1, readings: [FIVE_HOUR], now: NOW };
const READY: HomeContext = { ...PENDING, pending: 0, ready: 3, units: 0 };
const QUIET: HomeContext = { ...PENDING, pending: 0, ready: 0, units: 0 };
const FRESH: HomeContext = { project: 'site-padaria', path: '~/Pessoal/site-padaria', instance: false, ready: 0, pending: 0, units: 0, readings: [], now: NOW };

const titles = (context: HomeContext, filter = '') =>
  homeEntries(context, filter).map((entry) => ('head' in entry ? entry.head.toUpperCase() : entry.command.menu?.title));

function press(context: HomeContext, keys: Key[], state: HomeState = homeState(context)) {
  for (const key of keys) {
    const step = homeStep(context, state, key);
    if (!('state' in step)) return step;
    state = step.state;
  }
  return { state };
}

const text = (sequence: string): Key[] => [...sequence].map((char) => ({ sequence: char, name: char === ' ' ? 'space' : char }));

test('menu: só os nomes novos, um verbo igual ao do título, e fora dele só o que fica no shell', () => {
  for (const command of commands) {
    if (!command.menu) continue;
    const verb = command.menu.title.split(' ')[0]?.toLowerCase();
    assert.equal(verb, command.name, `${command.name}: o título começa com o nome no shell`);
  }
  const shellOnly = commands.filter((command) => !command.menu).map((command) => command.name);
  assert.deepEqual(shellOnly.sort(), ['aprovar', 'comandos', 'completion', 'eventos', 'responder', 'saldo', 'supervisor']);
});

test('grupos: Decidir sobe com pendência, Rodar com itens prontos, Começar só sem Mabel', () => {
  assert.deepEqual(groupOrder(PENDING), ['decidir', 'rodar', 'planejar', 'entregar', 'acompanhar', 'avulso']);
  assert.deepEqual(groupOrder(READY), ['rodar', 'planejar', 'decidir', 'entregar', 'acompanhar', 'avulso']);
  assert.deepEqual(groupOrder(QUIET), ['planejar', 'rodar', 'decidir', 'entregar', 'acompanhar', 'avulso']);
  assert.deepEqual(titles(FRESH), [
    'COMECAR',
    'Preparar este projeto',
    'Criar um projeto novo',
    'ACOMPANHAR',
    'Listar os projetos',
    'Auditar um projeto',
    'AVULSO',
    'Pedir algo avulso',
  ]);
  assert.ok(!titles(PENDING).includes('Preparar este projeto'));
});

test('digitar filtra pelo título e pelo nome no shell, sem acento; esc limpa e, vazio, sai', () => {
  assert.deepEqual(titles(PENDING, 'pendencias'), ['DECIDIR', 'Decidir as pendências']);
  assert.deepEqual(titles(PENDING, 'consultar'), ['ACOMPANHAR', 'Consultar as runs']);
  const typed = press(PENDING, text('fila'));
  assert.ok('state' in typed);
  assert.equal(typed.state.filter, 'fila');
  const cleared = press(PENDING, [{ name: 'escape' }], typed.state);
  assert.ok('state' in cleared);
  assert.equal(cleared.state.filter, '');
  assert.deepEqual(press(PENDING, [{ name: 'escape' }], cleared.state), { exit: true });
  const opened = press(PENDING, [...text('rodar'), { name: 'return' }]);
  assert.ok('open' in opened);
  assert.equal(opened.open.name, 'rodar');
});

test('↑ ↓ passam pelos comandos, pulando os cabeçalhos; o último aberto volta selecionado', () => {
  const down = press(PENDING, [{ name: 'down' }, { name: 'return' }]);
  assert.ok('open' in down);
  assert.equal(down.open.name, 'retomar');
  const up = press(PENDING, [{ name: 'up' }, { name: 'return' }]);
  assert.ok('open' in up);
  assert.equal(up.open.name, 'pedir');
  const back = press(PENDING, [{ name: 'return' }], homeState(PENDING, 'conferir'));
  assert.ok('open' in back);
  assert.equal(back.open.name, 'conferir');
});

test('contagens à direita: só quando há o que contar', () => {
  assert.equal(badgeText('pending', PENDING), '2 esperando');
  assert.equal(badgeText('ready', PENDING), '2 prontos');
  assert.equal(badgeText('units', PENDING), '1 pronta');
  assert.equal(badgeText('units', { ...PENDING, units: 2 }), '2 prontas');
  assert.equal(badgeText('ready', { ...PENDING, ready: 1 }), '1 pronto');
  assert.equal(badgeText('pending', QUIET), '');
});

test('tela: topo, filtro, lista, descrição e rodapé com as teclas e o saldo, na altura do terminal', () => {
  const { lines } = renderHome(PENDING, homeState(PENDING), plainStyle, 100, 40);
  assert.equal(lines.length, 40);
  assert.match(lines[1] ?? '', /^ {2}mabel {2}loja-api · ~\/Pessoal\/loja-api$/);
  assert.equal(lines[2], '  2 prontos · 2 esperando você · 1 unidade pronta');
  assert.equal(lines[4], '  › ▏o que você quer fazer?');
  assert.equal(lines[7], '  DECIDIR');
  assert.match(lines[8] ?? '', /^ {2}› Decidir as pendências +2 esperando {3}mabel decidir {2}$/);
  assert.equal(lines[8]?.length, 100);
  assert.match(lines.join('\n'), /Rodar a fila +2 prontos {3}mabel rodar/);
  assert.match(lines.join('\n'), /Entregar uma unidade +1 pronta {3}mabel entregar/);
  assert.equal(lines.at(-5), '  Responde perguntas e aprova critérios: uma pendência ou todas, uma por vez.');
  assert.equal(lines.at(-2), ' ↑↓ navegar  enter abrir  digite filtra  esc sai ');
  assert.match(lines.at(-1) ?? '', /^ 5h ██████░░░░ 60% · .+ │ 7d \? │ /);
  assert.match(renderHome(FRESH, homeState(FRESH), plainStyle, 100, 40).lines[2] ?? '', /sem Mabel neste diretório/);
});

test('terminal estreito: abaixo de 88 some o nome no shell; abaixo de 60, as contagens; títulos inteiros', () => {
  const at = (width: number) => renderHome(PENDING, homeState(PENDING), plainStyle, width, 40).lines.join('\n');
  assert.match(at(88), /mabel decidir/);
  assert.doesNotMatch(at(87), /mabel decidir/);
  assert.match(at(87), /Decidir as pendências +2 esperando {2}\n/);
  const decide = (width: number) => at(width).split('\n').find((line) => line.includes('Decidir as pendências')) ?? '';
  assert.match(decide(60), /2 esperando/);
  assert.doesNotMatch(decide(59), /esperando/);
  assert.match(at(40), /Especificar uma funcionalidade/);
});

test('terminal baixo: a lista rola com o cursor e mostra quantos ficaram de fora', () => {
  let state = homeState(PENDING);
  for (let i = 0; i < 15; i++) {
    const step = homeStep(PENDING, state, { name: 'down' });
    assert.ok('state' in step);
    state = step.state;
    state.scroll = renderHome(PENDING, state, plainStyle, 100, 20).scroll;
  }
  const { lines } = renderHome(PENDING, state, plainStyle, 100, 20);
  assert.equal(lines.length, 20);
  assert.match(lines[6] ?? '', /↑ mais \d+/);
  assert.match(lines.join('\n'), /› Consultar as runs/);
  assert.match(lines.at(-7) ?? '', /↓ mais \d+/);
});

test('filtro sem resultado avisa; telas e rodapé sem padrões proibidos e só com teclas universais', () => {
  const state = { filter: 'xyz', cursor: 0, scroll: 0 };
  const { lines } = renderHome(PENDING, state, plainStyle, 100, 30);
  assert.match(lines.join('\n'), /Nenhum comando com esse nome\. esc limpa o filtro\./);
  for (const hints of [homeHints(state), homeHints(homeState(PENDING))]) {
    for (const [key] of hints) assert.ok((UNIVERSAL_KEYS as readonly string[]).includes(key), key);
  }
  for (const context of [PENDING, READY, FRESH]) {
    assert.deepEqual(renderHome(context, homeState(context), plainStyle, 100, 40).lines.flatMap(guidedProblems), []);
  }
});

test('contexto: fora do git, sem Mabel; num projeto, o nome registrado e as contagens', () => {
  const previous = process.env.MABEL_HOME;
  try {
    process.env.MABEL_HOME = mkdtempSync(join(tmpdir(), 'mabel-home-'));
    const outside = loadHomeContext(mkdtempSync(join(tmpdir(), 'mabel-nogit-')));
    assert.equal(outside.instance, false);
    assert.equal(outside.notice, undefined);
    assert.deepEqual(outside.readings, []);
    assert.match(renderHome(outside, homeState(outside), plainStyle, 100, 30).lines.at(-1) ?? '', /saldo desconhecido · mabel conferir --atualizar/);

    const p = setupProject('\n## A\nprimeiro\n');
    process.env.MABEL_HOME = p.home;
    const context = loadHomeContext(p.root);
    assert.equal(context.instance, true);
    assert.equal(context.project, p.project.name);
    assert.equal(context.pending, 0);
    assert.equal(context.units, 0);
  } finally {
    if (previous === undefined) delete process.env.MABEL_HOME;
    else process.env.MABEL_HOME = previous;
  }
});
