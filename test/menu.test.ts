import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MenuOption, type MenuStep, menuStep, renderMenu } from '../src/menu.ts';

const options: MenuOption[] = [
  { label: 'init', hint: 'Prepara', disabledReason: 'passo 3' },
  { label: 'completion', hint: 'Gera' },
  { label: 'sair', hint: 'Fecha' },
];

function cursorOf(step: MenuStep): number {
  assert.ok('state' in step);
  return step.state.cursor;
}

test('setas movem o cursor e dão a volta nas pontas', () => {
  assert.equal(cursorOf(menuStep(options, { cursor: 0 }, { name: 'down' })), 1);
  assert.equal(cursorOf(menuStep(options, { cursor: 2 }, { name: 'down' })), 0);
  assert.equal(cursorOf(menuStep(options, { cursor: 0 }, { name: 'up' })), 2);
  assert.equal(cursorOf(menuStep(options, { cursor: 0 }, { name: 'j' })), 1);
});

test('enter escolhe a opção disponível sob o cursor', () => {
  assert.deepEqual(menuStep(options, { cursor: 1 }, { name: 'return' }), { chosen: 1 });
});

test('opção indisponível não é escolhida e mostra o motivo', () => {
  assert.deepEqual(menuStep(options, { cursor: 0 }, { name: 'return' }), {
    state: { cursor: 0, message: 'passo 3' },
  });
});

test('número escolhe a opção diretamente', () => {
  assert.deepEqual(menuStep(options, { cursor: 0 }, { name: '2', sequence: '2' }), { chosen: 1 });
});

test('q, esc e ctrl+c saem sem escolha', () => {
  for (const key of [{ name: 'q' }, { name: 'escape' }, { name: 'c', ctrl: true }]) {
    assert.deepEqual(menuStep(options, { cursor: 1 }, key), { chosen: null });
  }
});

test('renderMenu marca o cursor e mostra a mensagem no rodapé', () => {
  const plain = { dim: (t: string) => t, bold: (t: string) => t, accent: (t: string) => t };
  const lines = renderMenu(options, { cursor: 1, message: 'aviso' }, plain);
  assert.match(lines[1] ?? '', /^❯ 2  completion/);
  assert.equal(lines.at(-1), 'aviso');
});
