import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitMabelDir, createProjectFiles, testBaseItem } from '../src/init.ts';
import { makeRepo } from './helpers.ts';
import { hasCommits, isEmptyProject, parseCriticalRules } from '../src/project.ts';
import { STACKS, detectCommands as detect, findStack } from '../src/stacks.ts';
import { renderItemBlock } from '../src/backlog.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function mabel(cwd: string, ...args: string[]) {
  return mabelIn(mkdtempSync(join(tmpdir(), 'mabel-home-')), cwd, ...args);
}

function mabelIn(home: string, cwd: string, ...args: string[]) {
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

/** Só `setup` e `verify`, como a detecção devolvia antes do catálogo. */
function detectCommands(root: string) {
  const { setup, verify } = detect(root);
  return { setup, verify };
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

test('catálogo reconhece cada stack e junta mais de uma', () => {
  const ids = (files: Record<string, string>) => detect(makeRepo(files)).stacks.map((stack) => stack.id);
  assert.deepEqual(ids({ 'package.json': '{}' }), ['node']);
  assert.deepEqual(ids({ 'requirements.txt': '' }), ['python']);
  assert.deepEqual(ids({ 'go.mod': '' }), ['go']);
  assert.deepEqual(ids({ 'Cargo.toml': '' }), ['rust']);
  assert.deepEqual(ids({ 'package.json': '{}', 'pyproject.toml': '' }), ['node', 'python']);
  assert.deepEqual(ids({}), []);
  assert.deepEqual(detectCommands(makeRepo({ 'requirements.txt': '' })), { setup: null, verify: [] });
});

test('item da base de testes por stack', () => {
  const node = renderItemBlock(testBaseItem({ empty: true, stack: findStack('node') }));
  assert.match(node, /estrutura mínima de Node\/TypeScript com Vitest/);
  assert.match(node, /`npm run typecheck` e `npm test` rodam e passam/);
  assert.match(node, /`setup` igual a `npm ci` e `verify` com `typecheck` \(`npm run typecheck`\) e `test` \(`npm test`\)/);

  const go = renderItemBlock(testBaseItem({ empty: true, stack: findStack('go') }));
  assert.doesNotMatch(go, /`setup` igual/, 'Go não tem setup');
  assert.match(go, /`verify` com `vet`/);

  const existing = renderItemBlock(testBaseItem({ empty: false, stack: findStack('python') }));
  assert.match(existing, /Configurar pytest/);
  assert.match(existing, /Comando sugerido: `uv run pytest`/);

  assert.match(renderItemBlock(testBaseItem({ empty: true, other: 'Elixir' })), /Stack: Elixir/);
  for (const stack of STACKS) assert.ok(stack.template.verify.some((command) => command.name === 'test'));
});

test('init com --stack em projeto sem código grava setup e verify vazios', () => {
  const root = makeRepo();
  const result = mabel(root, 'init', '--stack', 'rust');
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(readFileSync(join(root, '.mabel', 'config.json'), 'utf8'));
  assert.equal(config.setup, null);
  assert.deepEqual(config.verify, []);
  // Projeto vazio: a rede da stack escolhida vai para o config, porque ainda não há o que detectar.
  assert.deepEqual(config.rede, ['crates.io', 'static.crates.io', 'index.crates.io']);
  assert.equal(config.sandbox, true);
  const backlog = readFileSync(join(root, '.mabel', 'backlog.md'), 'utf8');
  assert.match(backlog, /estrutura mínima de Rust/);
  assert.match(backlog, /`cargo clippy -- -D warnings` e `cargo test` rodam e passam/);
});

test('init depois de apagar o .mabel/ reaproveita o id registrado', () => {
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const root = makeRepo({ 'package.json': PKG({ test: 'node --test' }) });
  assert.equal(mabelIn(home, root, 'init').status, 0);
  const configPath = join(root, '.mabel', 'config.json');
  const { projectId } = JSON.parse(readFileSync(configPath, 'utf8'));

  rmSync(join(root, '.mabel'), { recursive: true });
  const again = mabelIn(home, root, 'init');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /histórico anterior foi mantido/);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).projectId, projectId);
});

test('falha ao gravar o .mabel/ desfaz o que foi criado e preserva os arquivos do usuário', () => {
  const root = makeRepo();
  mkdirSync(join(root, '.mabel'));
  writeFileSync(join(root, '.mabel', 'regras-criticas.md'), 'minhas regras\n');
  // O último arquivo falha: o diretório `sub/x` não existe.
  assert.throws(() =>
    createProjectFiles(root, [
      ['regras-criticas.md', 'modelo'],
      ['backlog.md', 'backlog'],
      ['sub/x/y.md', 'falha'],
    ]),
  );
  assert.equal(readFileSync(join(root, '.mabel', 'regras-criticas.md'), 'utf8'), 'minhas regras\n');
  assert.equal(existsSync(join(root, '.mabel', 'backlog.md')), false);

  const fresh = makeRepo();
  assert.throws(() => createProjectFiles(fresh, [['backlog.md', 'b'], ['nao/existe.md', 'x']]));
  assert.equal(existsSync(join(fresh, '.mabel')), false);
});

test('init que falha ao gravar pode ser repetido', () => {
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const root = makeRepo({ 'package.json': PKG({ test: 'node --test' }) });
  mkdirSync(join(root, '.mabel'));
  chmodSync(join(root, '.mabel'), 0o555);
  const failed = mabelIn(home, root, 'init');
  chmodSync(join(root, '.mabel'), 0o755);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Não foi possível criar o \.mabel\/.*\nNenhum arquivo foi criado/);
  assert.equal(existsSync(join(root, '.mabel', 'config.json')), false);

  const again = mabelIn(home, root, 'init');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /histórico anterior foi mantido/);
});

test('init com --stack inválido lista as stacks e falha', () => {
  const result = mabel(makeRepo(), 'init', '--stack', 'cobol');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Stack desconhecida: cobol\. Use uma destas: node, python, go, rust\./);
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

test('init em repositório sem commits explica como commitar o .mabel/', () => {
  const root = makeRepo({ 'src/app.py': '' }, { commit: false });
  const result = mabel(root, 'init');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fora do git/);
  assert.match(result.stdout, /git add \.mabel && git commit/);
  assert.equal(hasCommits(root), false);

  commitMabelDir(root);
  assert.equal(hasCommits(root), true);
  const tracked = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepEqual(tracked.sort(), ['.mabel/.gitignore', '.mabel/backlog.md', '.mabel/config.json', '.mabel/regras-criticas.md']);
});

test('commit do .mabel/ não leva o que o usuário deixou no índice; init repetido avisa enquanto falta commitar', () => {
  const root = makeRepo({ 'src/app.py': '' });
  assert.match(mabel(root, 'init').stdout, /fora do git/);
  assert.match(mabel(root, 'init').stdout, /fora do git/);
  writeFileSync(join(root, 'src', 'app.py'), 'print(1)\n');
  spawnSync('git', ['add', 'src/app.py'], { cwd: root });

  commitMabelDir(root);
  const files = spawnSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout;
  assert.doesNotMatch(files, /app\.py/);
  const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  assert.equal(staged, 'src/app.py');
  assert.doesNotMatch(mabel(root, 'init').stdout, /fora do git/);
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
