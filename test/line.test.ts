import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type LineContext,
  type LineState,
  type LineStep,
  LIST_SIZE,
  initialLine,
  lineStep,
  renderBelow,
  splitArgs,
  suggestionsFor,
} from '../src/line.ts';
import type { Key } from '../src/menu.ts';

const plain = { dim: (t: string) => t, bold: (t: string) => t, accent: (t: string) => t };

const context: LineContext = {
  suggestions: [
    { name: 'init', description: 'Prepara' },
    { name: 'item', description: 'Detalhe' },
    { name: 'run', description: 'Fila' },
    { name: 'inbox', description: 'Decisões', plannedStep: 5 },
  ],
  history: ['/status', '/run --uma'],
};

function stateOf(step: LineStep): LineState {
  assert.ok('state' in step, `esperava estado, veio ${JSON.stringify(step)}`);
  return step.state;
}

/** Aplica as teclas em sequência; texto puro vira uma tecla por caractere. */
function type(keys: (Key | string)[], start: LineState = initialLine(context)): LineState {
  let state = start;
  for (const key of keys) {
    const list = typeof key === 'string' ? [...key].map((sequence) => ({ sequence })) : [key];
    for (const k of list) state = stateOf(lineStep(state, k, context));
  }
  return state;
}

test('digitação insere no cursor e as setas o movem', () => {
  const state = type(['abc', { name: 'left' }, { name: 'left' }, 'X']);
  assert.equal(state.text, 'aXbc');
  assert.equal(state.cursor, 2);
});

test('colagem chega como uma sequência só e é inserida inteira', () => {
  const state = stateOf(lineStep(initialLine(context), { sequence: '/exec "oi"' }, context));
  assert.equal(state.text, '/exec "oi"');
  assert.equal(state.cursor, 10);
});

test('backspace, delete, ctrl+u e ctrl+w', () => {
  assert.equal(type(['abc', { name: 'backspace' }]).text, 'ab');
  assert.equal(type(['abc', { name: 'home' }, { name: 'delete' }]).text, 'bc');
  assert.equal(type(['abc def', { name: 'left' }, { name: 'u', ctrl: true }]).text, 'f');
  assert.equal(type(['/run --uma ', { name: 'w', ctrl: true }]).text, '/run ');
  assert.equal(type(['abc', { name: 'a', ctrl: true }]).cursor, 0);
  assert.equal(type(['abc', { name: 'home' }, { name: 'e', ctrl: true }]).cursor, 3);
});

test('/ abre a lista com todos os comandos e o texto filtra', () => {
  assert.equal(suggestionsFor(type(['/']), context)?.length, 4);
  assert.deepEqual(
    suggestionsFor(type(['/i']), context)?.map((s) => s.name),
    ['init', 'item', 'inbox'],
  );
  assert.equal(suggestionsFor(type(['/run ']), context), undefined);
  assert.equal(suggestionsFor(type(['run']), context), undefined);
});

test('setas movem a seleção da lista e dão a volta', () => {
  assert.equal(type(['/i', { name: 'down' }]).selected, 1);
  assert.equal(type(['/i', { name: 'up' }]).selected, 2);
  assert.equal(type(['/i', { name: 'down' }, 'n']).selected, 0, 'editar a linha volta ao topo');
});

test('tab completa o comando selecionado com espaço', () => {
  const state = type(['/i', { name: 'down' }, { name: 'tab' }]);
  assert.equal(state.text, '/item ');
  assert.equal(state.cursor, 6);
  assert.equal(suggestionsFor(state, context), undefined);
});

test('enter com a lista aberta executa o comando selecionado', () => {
  assert.deepEqual(lineStep(type(['/ru']), { name: 'return' }, context), { submit: '/run' });
  assert.deepEqual(lineStep(type(['/run --uma']), { name: 'return' }, context), { submit: '/run --uma' });
  assert.deepEqual(lineStep(type(['/xyz']), { name: 'return' }, context), { submit: '/xyz' });
});

test('esc fecha a lista até a próxima edição', () => {
  const closed = type(['/i', { name: 'escape' }]);
  assert.equal(suggestionsFor(closed, context), undefined);
  assert.deepEqual(lineStep(closed, { name: 'return' }, context), { submit: '/i' });
  assert.equal(suggestionsFor(type(['t'], closed), context)?.length, 1);
});

test('com a lista fechada, as setas percorrem o histórico e guardam a linha nova', () => {
  const up = type(['rascunho', { name: 'up' }]);
  assert.equal(up.text, '/run --uma');
  assert.equal(type([{ name: 'up' }], up).text, '/status');
  assert.equal(type([{ name: 'up' }, { name: 'up' }], up).text, '/status', 'para no mais antigo');
  assert.equal(type([{ name: 'down' }], up).text, 'rascunho');
  assert.equal(suggestionsFor(type([{ name: 'up' }], up), context), undefined, 'linha do histórico não abre a lista');
});

test('ctrl+c limpa a linha; com a linha vazia avisa como sair', () => {
  assert.equal(type(['abc', { name: 'c', ctrl: true }]).text, '');
  assert.equal(type([{ name: 'c', ctrl: true }]).message, 'use exit para sair');
  assert.equal(type([{ name: 'c', ctrl: true }, 'a']).message, undefined);
});

test('ctrl+d sai com a linha vazia e apaga sob o cursor com texto', () => {
  assert.deepEqual(lineStep(initialLine(context), { name: 'd', ctrl: true }, context), { exit: true });
  assert.equal(type(['ab', { name: 'home' }, { name: 'd', ctrl: true }]).text, 'b');
});

test('lista renderizada marca a seleção e apaga os planejados', () => {
  const lines = renderBelow(type(['/i', { name: 'down' }]), context, plain);
  assert.deepEqual(lines, ['  /init   Prepara', '❯ /item   Detalhe', '  /inbox  Decisões  (passo 5)']);
  assert.deepEqual(renderBelow(type(['/z']), context, plain), ['  nenhum comando']);
});

test('lista longa rola com a seleção e corta na largura', () => {
  const many: LineContext = {
    suggestions: Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, description: 'descrição longa demais' })),
    history: [],
  };
  let state = initialLine(many);
  for (const key of [{ sequence: '/' }, ...Array.from({ length: 9 }, () => ({ name: 'down' }))]) {
    state = stateOf(lineStep(state, key, many));
  }
  const lines = renderBelow(state, many, plain, 20);
  assert.equal(lines.length, LIST_SIZE);
  assert.ok(lines.at(-1)?.startsWith('❯ /c9'));
  assert.ok(lines.every((line) => line.length <= 19));
});

test('splitArgs separa como o shell', () => {
  assert.deepEqual(splitArgs('run --uma'), ['run', '--uma']);
  assert.deepEqual(splitArgs('exec "explique o runner"'), ['exec', 'explique o runner']);
  assert.deepEqual(splitArgs("responder 3 'use \"aspas\"'"), ['responder', '3', 'use "aspas"']);
  assert.deepEqual(splitArgs('a\\ b "x\\"y" ""'), ['a b', 'x"y', '']);
  assert.deepEqual(splitArgs('  '), []);
  assert.throws(() => splitArgs('exec "aberto'), /sem fechamento/);
});
