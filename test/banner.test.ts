import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeBanner, loadGrid, parseGrid, renderGrid } from '../src/banner.ts';

test('parseGrid lê # como aceso e ignora linhas vazias no fim', () => {
  assert.deepEqual(parseGrid('#.\n.#\n\n'), [
    [true, false],
    [false, true],
  ]);
});

test('renderGrid completa linhas curtas até a largura do grid', () => {
  assert.deepEqual(renderGrid(parseGrid('##\n#'), '██'), ['████', '██  ']);
});

test('composeBanner põe o título ao lado quando cabe', () => {
  const lines = composeBanner(['AAAA', 'AAAA', 'AAAA', 'AAAA'], ['T'], 20);
  assert.equal(lines.length, 4);
  assert.equal(lines[1], 'AAAA    T');
});

test('composeBanner põe o título abaixo em terminal estreito', () => {
  assert.deepEqual(composeBanner(['AAAA'], ['TTTTTT'], 8), ['AAAA', '', 'TTTTTT']);
});

test('composeBanner mostra só o título quando o gatinho não cabe', () => {
  assert.deepEqual(composeBanner(['AAAAAAAA'], ['TT'], 4), ['TT']);
});

test('os grids de assets/ existem e não estão vazios', () => {
  for (const name of ['logo.txt', 'titulo.txt']) {
    const grid = loadGrid(name);
    assert.ok(grid.length > 0 && grid.some((row) => row.includes(true)), name);
  }
});
