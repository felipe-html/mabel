import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createInitialCommit } from '../src/init.ts';
import { makeRepo } from './helpers.ts';
import { detectCommands, hasCommits, isEmptyProject, parseCriticalRules } from '../src/project.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function mabel(cwd: string, ...args: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MABEL_HOME: home, NO_COLOR: '1' },
  });
}

function snapshot(dir: string): Record<string, [string, number]> {
  const files: Record<string, [string, number]> = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    files[name] = [readFileSync(path, 'utf8'), statSync(path).mtimeMs];
  }
  return files;
}

const PKG = (scripts: Record<string, string>) => JSON.stringify({ name: 'x', scripts });

test('detecção: package.json com lockfile', () => {
  const root = makeRepo({
    'package.json': PKG({ build: 'tsc', lint: 'eslint .', test: 'node --test', dev: 'vite' }),
    'package-lock.json': '{}',
  });
  assert.deepEqual(detectCommands(root), {
    setup: 'npm ci',
    verify: [
      { name: 'build', command: 'npm run build' },
      { name: 'lint', command: 'npm run lint' },
      { name: 'test', command: 'npm test' },
    ],
  });
});

test('detecção: package.json sem lockfile e com o test padrão do npm init', () => {
  const root = makeRepo({
    'package.json': PKG({ typecheck: 'tsc', test: 'echo "Error: no test specified" && exit 1' }),
  });
  assert.deepEqual(detectCommands(root), {
    setup: 'npm install',
    verify: [{ name: 'typecheck', command: 'npm run typecheck' }],
  });
  const pnpm = makeRepo({ 'package.json': PKG({}), 'pnpm-lock.yaml': '' });
  assert.equal(detectCommands(pnpm).setup, 'pnpm install --frozen-lockfile');
  const yarn = makeRepo({ 'package.json': PKG({}), 'yarn.lock': '' });
  assert.equal(detectCommands(yarn).setup, 'yarn install --frozen-lockfile');
});

test('detecção: pyproject.toml, Cargo.toml, go.mod, Makefile e projeto vazio', () => {
  assert.deepEqual(detectCommands(makeRepo({ 'pyproject.toml': '' })), {
    setup: null,
    verify: [{ name: 'test', command: 'pytest' }],
  });
  assert.deepEqual(detectCommands(makeRepo({ 'Cargo.toml': '' })).verify, [
    { name: 'build', command: 'cargo build' },
    { name: 'test', command: 'cargo test' },
  ]);
  assert.deepEqual(detectCommands(makeRepo({ 'go.mod': '' })).verify, [
    { name: 'build', command: 'go build ./...' },
    { name: 'test', command: 'go test ./...' },
  ]);
  assert.deepEqual(detectCommands(makeRepo({ Makefile: 'build:\n\tcc x.c\n\ntest: build\n\t./t\n' })).verify, [
    { name: 'test', command: 'make test' },
  ]);
  assert.deepEqual(detectCommands(makeRepo({ Makefile: 'build:\n\tcc x.c\n' })).verify, []);
  assert.deepEqual(detectCommands(makeRepo()), { setup: null, verify: [] });
});

test('projeto vazio: só configuração e documentação', () => {
  assert.equal(isEmptyProject(makeRepo({ 'package.json': '{}', '.mabel/x.ts': '' })), true);
  assert.equal(isEmptyProject(makeRepo({ 'src/index.ts': '' })), false);
});

test('init fora de repositório git falha com dica', () => {
  const result = mabel(mkdtempSync(join(tmpdir(), 'mabel-nogit-')), 'init');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git init/);
});

test('init em repositório sem commits avisa e explica como criar o commit inicial', () => {
  const root = makeRepo({ 'src/app.py': '' }, { commit: false });
  const result = mabel(root, 'init');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /não tem commits/);
  assert.match(result.stdout, /git add \.mabel && git commit/);
  assert.equal(hasCommits(root), false);

  createInitialCommit(root);
  assert.equal(hasCommits(root), true);
  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepEqual(tracked.sort(), ['.mabel/.gitignore', '.mabel/backlog.md', '.mabel/config.json', '.mabel/regras-criticas.md']);
});

test('init cria os arquivos, ignora o quadro e não altera nada quando repetido', () => {
  const root = makeRepo({ 'package.json': PKG({ test: 'node --test' }), 'package-lock.json': '{}' });
  const first = mabel(root, 'init');
  assert.equal(first.status, 0, first.stderr);

  const dir = join(root, '.mabel');
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.match(config.projectId, /^[0-9a-f-]{36}$/);
  assert.equal(config.baseBranch, 'main');
  assert.equal(config.setup, 'npm ci');
  assert.deepEqual(config.verify, [{ name: 'test', command: 'npm test' }]);
  assert.deepEqual(config.models, { plan: 'opus', execute: 'sonnet', review: 'opus' });
  assert.equal(config.limits.execute.maxTurns, 120);
  assert.doesNotMatch(readFileSync(join(dir, 'backlog.md'), 'utf8'), /Estabelecer base de testes/);
  assert.match(readFileSync(join(dir, 'quadro.md'), 'utf8'), /^# Quadro · /m);

  const ignored = spawnSync('git', ['check-ignore', '.mabel/quadro.md'], { cwd: root });
  assert.equal(ignored.status, 0);

  const before = snapshot(dir);
  const second = mabel(root, 'init');
  assert.equal(second.status, 0);
  assert.match(second.stdout, /já é um projeto Mabel/);
  assert.deepEqual(snapshot(dir), before);
});

test('projeto sem testes recebe "Estabelecer base de testes" como primeiro item', () => {
  const withCode = makeRepo({ 'src/index.js': '' });
  assert.equal(mabel(withCode, 'init').status, 0);
  const backlog = readFileSync(join(withCode, '.mabel', 'backlog.md'), 'utf8');
  assert.match(backlog, /-->\n\n## Estabelecer base de testes\nid: 1\n/);
  assert.doesNotMatch(backlog, /Stack:/);

  const empty = makeRepo();
  const result = mabel(empty, 'init');
  assert.match(result.stdout, /Aviso: nenhum comando em `verify`/);
  assert.match(readFileSync(join(empty, '.mabel', 'backlog.md'), 'utf8'), /\nStack: a definir\n/);
});

test('regras críticas: itens de lista por seção, sem comentários', () => {
  const rules = parseCriticalRules(`# Regras críticas

## Caminhos

<!-- Um glob por linha. Ex.: - src/billing/** -->
- src/billing/**
- \`migrations/*.sql\`

## Conceitos

- Desconto nunca passa de 30%
`);
  assert.deepEqual(rules, {
    paths: ['src/billing/**', 'migrations/*.sql'],
    concepts: ['Desconto nunca passa de 30%'],
  });
  assert.deepEqual(parseCriticalRules('## Caminhos\n<!-- - x -->\n'), { paths: [], concepts: [] });
});
