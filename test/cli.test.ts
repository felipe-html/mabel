import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function mabel(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('sem argumentos mostra o banner e o menu', () => {
  const result = mabel();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /██/);
  assert.match(result.stdout, /Comandos/);
});

test('--version imprime a versão do package.json', () => {
  assert.match(mabel('--version').stdout, /^\d+\.\d+\.\d+\n$/);
});

test('comando desconhecido falha com o menu', () => {
  const result = mabel('voar');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Comando desconhecido: voar/);
});

test('comando planejado avisa o passo em que será implementado', () => {
  const result = mabel('inbox');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /passo 5/);
});

test('completion zsh gera script com compdef e todos os comandos', () => {
  const result = mabel('completion', 'zsh');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /compdef _mabel mabel/);
  for (const name of ['init', 'add', 'exec', 'run', 'status', 'inbox', 'completion']) {
    assert.match(result.stdout, new RegExp(`'${name}:`));
  }
});

test('comandos implementados aparecem sem aviso de passo no autocompletar', () => {
  const { stdout } = mabel('completion', 'zsh');
  for (const name of ['init', 'add', 'exec', 'status', 'run', 'item', 'aprovar', 'responder', 'cancelar']) {
    assert.match(stdout, new RegExp(`'${name}:[^']*'`));
    assert.doesNotMatch(stdout, new RegExp(`'${name}:[^']*\\(passo`));
  }
});
