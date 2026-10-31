import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function mabel(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('sem argumentos e sem terminal mostra a versão e a lista de comandos, sem banner', () => {
  const result = mabel();
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /██/);
  assert.match(result.stdout, /harness para frotas de agentes/);
  assert.match(result.stdout, /Comandos\n {2}preparar /);
});

test('nomes antigos dos comandos não existem mais', () => {
  for (const name of ['init', 'nascer', 'add', 'referencia', 'credencial', 'run', 'anexar', 'inbox', 'status', 'item', 'runs', 'projetos', 'projeto', 'exec', 'integracao']) {
    const result = mabel(name);
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, new RegExp(`Comando desconhecido: ${name}`));
  }
});

test('--version imprime a versão do package.json', () => {
  assert.match(mabel('--version').stdout, /^\d+\.\d+\.\d+\n$/);
});

test('comando desconhecido falha com o menu', () => {
  const result = mabel('voar');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Comando desconhecido: voar/);
});

test('decidir fora de um projeto Mabel falha com mensagem', () => {
  const root = makeRepo();
  const result = spawnSync(process.execPath, [CLI, 'decidir'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, MABEL_HOME: mkdtempSync(join(tmpdir(), 'mabel-home-')) },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não é um projeto Mabel/);
});

test('completion zsh gera script com compdef e todos os comandos', () => {
  const result = mabel('completion', 'zsh');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /compdef _mabel mabel/);
  for (const name of ['preparar', 'adicionar', 'pedir', 'rodar', 'conferir', 'decidir', 'completion']) {
    assert.match(result.stdout, new RegExp(`'${name}:`));
  }
});

test('comandos implementados aparecem sem aviso de passo no autocompletar', () => {
  const { stdout } = mabel('completion', 'zsh');
  for (const name of ['preparar', 'adicionar', 'pedir', 'conferir', 'rodar', 'detalhar', 'aprovar', 'responder', 'cancelar']) {
    assert.match(stdout, new RegExp(`'${name}:[^']*'`));
    assert.doesNotMatch(stdout, new RegExp(`'${name}:[^']*\\(passo`));
  }
});
