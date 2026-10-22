import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VerifyCommand } from './project.ts';

/** O que um projeto novo da stack deve ter depois do item da base de testes. */
export interface StackTemplate {
  framework: string;
  setup: string | null;
  verify: VerifyCommand[];
}

export interface Stack {
  id: string;
  label: string;
  /** Reconhece a stack num projeto com código. */
  detect: (root: string) => boolean;
  /** Setup e verificação que já existem no projeto. */
  commands: (root: string) => { setup: string | null; verify: VerifyCommand[] };
  template: StackTemplate;
  /** Campos da prova: comando de um teste só e globs dos arquivos de teste. */
  proof: (root: string, empty: boolean) => StackProof;
  /** Domínios do registro de pacotes, liberados na rede do sandbox. */
  rede: string[];
  /** Caches do gerenciador de pacotes fora do projeto, graváveis no sandbox (`~` = home). */
  caches: string[];
}

export interface StackProof {
  testeUnico: string;
  arquivosDeTeste: string[];
}

const has = (root: string, file: string) => existsSync(join(root, file));

const LOCKFILES: [string, string][] = [
  ['package-lock.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
];

/** Script `test` que o `npm init` gera por padrão: não é um comando de teste de verdade. */
const NPM_PLACEHOLDER_TEST = /no test specified/;

interface PackageJson {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

function readPackage(root: string): PackageJson {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  } catch {
    // package.json ausente ou inválido: nada detectado.
    return {};
  }
}

/** O projeto usa Vitest: dependência declarada ou script que o chama. */
export function usesVitest(root: string): boolean {
  const pkg = readPackage(root);
  if ('vitest' in (pkg.dependencies ?? {}) || 'vitest' in (pkg.devDependencies ?? {})) return true;
  return Object.values(pkg.scripts ?? {}).some((body) => typeof body === 'string' && /\bvitest\b/.test(body));
}

const NODE_TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', 'test/**', 'tests/**'];

/** `testeUnico` que o `init` grava num projeto Node sem Vitest. */
export const NODE_TEST_COMMAND = 'node --test --test-name-pattern={padrao} {arquivo}';
const VITEST_COMMAND = 'npx vitest run {arquivo} -t {padrao}';

/**
 * Comando da prova para um teste: o `testeUnico` do config, salvo quando ele é o padrão do
 * `node --test` gravado pelo `init` e o item passou a usar Vitest (o item que estabelece a
 * base de testes, por exemplo). O config é do humano e o agente não o altera; sem o ajuste,
 * a prova rodaria os testes do item com o runner errado.
 */
export function proofTestCommand(configured: string | null, worktree: string): string | null {
  return configured === NODE_TEST_COMMAND && usesVitest(worktree) ? VITEST_COMMAND : configured;
}

function nodeCommands(root: string) {
  const scripts = readPackage(root).scripts ?? {};
  const verify: VerifyCommand[] = [];
  for (const script of ['build', 'typecheck', 'lint', 'test']) {
    const body = scripts[script];
    if (typeof body !== 'string' || !body.trim()) continue;
    if (script === 'test' && NPM_PLACEHOLDER_TEST.test(body)) continue;
    verify.push({ name: script, command: script === 'test' ? 'npm test' : `npm run ${script}` });
  }
  // Sem lockfile, `npm install` ainda deixa o worktree pronto para os comandos acima.
  const setup = LOCKFILES.find(([lockfile]) => has(root, lockfile))?.[1] ?? 'npm install';
  return { setup, verify };
}

export const STACKS: Stack[] = [
  {
    id: 'node',
    label: 'Node/TypeScript',
    detect: (root) => has(root, 'package.json'),
    commands: nodeCommands,
    template: {
      framework: 'Vitest',
      setup: 'npm ci',
      verify: [
        { name: 'typecheck', command: 'npm run typecheck' },
        { name: 'test', command: 'npm test' },
      ],
    },
    // Projeto vazio nasce com o template (Vitest); nos outros, Vitest só se já estiver lá.
    rede: ['registry.npmjs.org'],
    caches: ['~/.npm'],
    proof: (root, empty) => ({
      testeUnico: empty || usesVitest(root) ? VITEST_COMMAND : NODE_TEST_COMMAND,
      arquivosDeTeste: NODE_TEST_GLOBS,
    }),
  },
  {
    id: 'python',
    label: 'Python',
    detect: (root) => ['pyproject.toml', 'pytest.ini', 'requirements.txt'].some((file) => has(root, file)),
    commands: (root) => ({
      setup: null,
      verify: has(root, 'pyproject.toml') || has(root, 'pytest.ini') ? [{ name: 'test', command: 'pytest' }] : [],
    }),
    template: {
      framework: 'pytest',
      setup: 'uv sync',
      verify: [
        { name: 'lint', command: 'uv run ruff check' },
        { name: 'test', command: 'uv run pytest' },
      ],
    },
    rede: ['pypi.org', 'files.pythonhosted.org'],
    caches: ['~/.cache/pip', '~/.cache/uv', '~/Library/Caches/pip'],
    proof: () => ({
      testeUnico: 'pytest {arquivo} -k {nome}',
      arquivosDeTeste: ['tests/**', '**/test_*.py', '**/*_test.py', '**/conftest.py'],
    }),
  },
  {
    id: 'go',
    label: 'Go',
    detect: (root) => has(root, 'go.mod'),
    commands: () => ({
      setup: null,
      verify: [
        { name: 'build', command: 'go build ./...' },
        { name: 'test', command: 'go test ./...' },
      ],
    }),
    template: {
      framework: 'o pacote `testing`',
      setup: null,
      verify: [
        { name: 'vet', command: 'go vet ./...' },
        { name: 'test', command: 'go test ./...' },
      ],
    },
    rede: ['proxy.golang.org', 'sum.golang.org'],
    caches: ['~/go/pkg/mod', '~/.cache/go-build', '~/Library/Caches/go-build'],
    proof: () => ({
      testeUnico: 'go test -run {padrao} ./{pasta}',
      arquivosDeTeste: ['**/*_test.go', '**/testdata/**'],
    }),
  },
  {
    id: 'rust',
    label: 'Rust',
    detect: (root) => has(root, 'Cargo.toml'),
    commands: () => ({
      setup: null,
      verify: [
        { name: 'build', command: 'cargo build' },
        { name: 'test', command: 'cargo test' },
      ],
    }),
    template: {
      framework: '`cargo test`',
      setup: null,
      verify: [
        { name: 'lint', command: 'cargo clippy -- -D warnings' },
        { name: 'test', command: 'cargo test' },
      ],
    },
    rede: ['crates.io', 'static.crates.io', 'index.crates.io'],
    caches: ['~/.cargo/registry', '~/.cargo/git'],
    proof: () => ({ testeUnico: 'cargo test {nome}', arquivosDeTeste: ['tests/**'] }),
  },
];

/**
 * Domínios que o build de frameworks conhecidos busca além do registro de pacotes. O
 * `next/font/google` do template do Next baixa as fontes do Google no build.
 */
export function frameworkDomains(root: string): string[] {
  const pkg = readPackage(root);
  const next = 'next' in (pkg.dependencies ?? {}) || 'next' in (pkg.devDependencies ?? {});
  return next ? ['fonts.googleapis.com', 'fonts.gstatic.com'] : [];
}

export function findStack(id: string): Stack | undefined {
  return STACKS.find((stack) => stack.id === id);
}

export interface DetectedCommands {
  stacks: Stack[];
  setup: string | null;
  verify: VerifyCommand[];
}

/** Lê os arquivos de build da raiz: stacks reconhecidas, `setup` e `verify`. Somente leitura. */
export function detectCommands(root: string): DetectedCommands {
  const stacks = STACKS.filter((stack) => stack.detect(root));
  const verify: VerifyCommand[] = [];
  let setup: string | null = null;
  const add = (command: VerifyCommand) => {
    if (!verify.some((existing) => existing.name === command.name)) verify.push(command);
  };
  for (const stack of stacks) {
    const found = stack.commands(root);
    setup ??= found.setup;
    found.verify.forEach(add);
  }
  if (has(root, 'Makefile') && /^test\s*:/m.test(readFileSync(join(root, 'Makefile'), 'utf8'))) {
    add({ name: 'test', command: 'make test' });
  }
  return { stacks, setup, verify };
}

export function stackLabel(stacks: Stack[]): string {
  return stacks.map((stack) => stack.label).join(' + ');
}
