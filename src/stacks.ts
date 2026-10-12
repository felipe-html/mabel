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
}

const has = (root: string, file: string) => existsSync(join(root, file));

const LOCKFILES: [string, string][] = [
  ['package-lock.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
];

/** Script `test` que o `npm init` gera por padrão: não é um comando de teste de verdade. */
const NPM_PLACEHOLDER_TEST = /no test specified/;

function nodeCommands(root: string) {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    scripts = pkg.scripts ?? {};
  } catch {
    // package.json inválido: nenhum script detectado.
  }
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
  },
];

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
