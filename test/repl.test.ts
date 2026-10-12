import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HISTORY_LIMIT, loadHistory, locate, parseLine, pushHistory, replSuggestions } from '../src/repl.ts';
import { makeRepo } from './helpers.ts';

test('comandos com / viram chamadas com argumentos', () => {
  const parsed = parseLine('/exec "explique o runner"');
  assert.equal(parsed.kind, 'command');
  assert.ok(parsed.kind === 'command');
  assert.equal(parsed.command.name, 'exec');
  assert.deepEqual(parsed.args, ['explique o runner']);
});

test('exit, /sair e linha vazia', () => {
  assert.deepEqual(parseLine('exit'), { kind: 'exit' });
  assert.deepEqual(parseLine('  /sair '), { kind: 'exit' });
  assert.deepEqual(parseLine('   '), { kind: 'empty' });
});

test('texto sem /, comando desconhecido, planejado e aspas abertas viram mensagem', () => {
  const text = (line: string) => {
    const parsed = parseLine(line);
    assert.equal(parsed.kind, 'message');
    return parsed.kind === 'message' ? parsed.text : '';
  };
  assert.match(text('init'), /Comandos começam com \//);
  assert.match(text('/voar'), /Comando desconhecido: \/voar/);
  assert.match(text('/inbox'), /passo 5/);
  assert.match(text('/exec "aberto'), /sem fechamento/);
  assert.match(text('/completion zsh'), /desconhecido/, 'completion só existe no shell');
});

test('sugestões incluem /sair e omitem completion', () => {
  const names = replSuggestions().map((s) => s.name);
  assert.ok(names.includes('sair'));
  assert.ok(names.includes('run'));
  assert.ok(!names.includes('completion'));
});

test('histórico não repete a linha anterior e guarda as últimas', () => {
  assert.deepEqual(pushHistory(['/a'], '/a'), ['/a']);
  assert.deepEqual(pushHistory(['/a'], ''), ['/a']);
  const full = Array.from({ length: HISTORY_LIMIT }, (_, i) => `/c${i}`);
  const next = pushHistory(full, '/novo');
  assert.equal(next.length, HISTORY_LIMIT);
  assert.equal(next[0], '/c1');

  const dir = mkdtempSync(join(tmpdir(), 'mabel-hist-'));
  assert.deepEqual(loadHistory(join(dir, 'nada')), []);
  writeFileSync(join(dir, 'historico'), '/a\n\n/b\n');
  assert.deepEqual(loadHistory(join(dir, 'historico')), ['/a', '/b']);
});

test('locate distingue projeto, repositório sem .mabel e fora do git', () => {
  assert.match(locate(mkdtempSync(join(tmpdir(), 'mabel-nogit-'))).notice ?? '', /Fora de um repositório git/);
  const root = makeRepo();
  assert.match(locate(root).notice ?? '', /Digite \/init/);
  mkdirSync(join(root, '.mabel'));
  writeFileSync(join(root, '.mabel', 'config.json'), JSON.stringify({ projectId: 'p1' }));
  const location = locate(root);
  assert.equal(location.notice, undefined);
  assert.match(location.project ?? '', /^mabel-repo-/);
});
