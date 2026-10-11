import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { tryGit } from './git.ts';

export type Stage = 'plan' | 'execute' | 'review';

export interface VerifyCommand {
  name: string;
  command: string;
}

export interface StageLimits {
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface ProjectConfig {
  projectId: string;
  baseBranch: string;
  setup: string | null;
  verify: VerifyCommand[];
  models: Record<Stage, string>;
  limits: Record<Stage, StageLimits>;
}

export interface Project {
  id: string;
  root: string;
  name: string;
  config: ProjectConfig;
}

export const MABEL_DIR = '.mabel';

export function mabelPath(root: string, file: string): string {
  return join(root, MABEL_DIR, file);
}

export const DEFAULT_MODELS: Record<Stage, string> = { plan: 'opus', execute: 'sonnet', review: 'opus' };

export const DEFAULT_LIMITS: Record<Stage, StageLimits> = {
  plan: { maxTurns: 40, maxBudgetUsd: 3 },
  execute: { maxTurns: 120, maxBudgetUsd: 8 },
  review: { maxTurns: 40, maxBudgetUsd: 3 },
};

export class ProjectError extends Error {}

/** Raiz real do repositório git que contém `cwd`, ou `undefined` fora de um repositório. */
export function gitRoot(cwd: string): string | undefined {
  const root = tryGit(cwd, 'rev-parse', '--show-toplevel');
  return root ? realpathSync(root) : undefined;
}

export function hasCommits(root: string): boolean {
  return tryGit(root, 'rev-parse', '--verify', '--quiet', 'HEAD') !== undefined;
}

/** Branch atual; funciona também em repositório sem commits. */
export function currentBranch(root: string): string {
  return tryGit(root, 'symbolic-ref', '--short', 'HEAD') ?? 'main';
}

export function readConfig(root: string): ProjectConfig | undefined {
  const path = mabelPath(root, 'config.json');
  if (!existsSync(path)) return undefined;
  let raw: Partial<ProjectConfig>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProjectConfig>;
  } catch (error) {
    throw new ProjectError(`${path} não é um JSON válido: ${(error as Error).message}`);
  }
  if (typeof raw.projectId !== 'string' || !raw.projectId) {
    throw new ProjectError(`${path} não tem projectId.`);
  }
  return {
    projectId: raw.projectId,
    baseBranch: raw.baseBranch || 'main',
    setup: raw.setup ?? null,
    verify: Array.isArray(raw.verify) ? raw.verify : [],
    models: { ...DEFAULT_MODELS, ...raw.models },
    limits: {
      plan: { ...DEFAULT_LIMITS.plan, ...raw.limits?.plan },
      execute: { ...DEFAULT_LIMITS.execute, ...raw.limits?.execute },
      review: { ...DEFAULT_LIMITS.review, ...raw.limits?.review },
    },
  };
}

export function writeConfig(root: string, config: ProjectConfig): void {
  writeFileSync(mabelPath(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Grava o projeto no banco; se o repositório mudou de lugar, atualiza a raiz pelo id. */
export function registerProject(db: DatabaseSync, root: string, projectId: string): void {
  const byRoot = db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: string } | undefined;
  if (byRoot && byRoot.id !== projectId) {
    throw new ProjectError(
      `${root} já está registrado com outro projectId (${byRoot.id}). Restaure o .mabel/config.json original.`,
    );
  }
  db.prepare(
    `INSERT INTO projects (id, root, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET root = excluded.root, name = excluded.name`,
  ).run(projectId, root, basename(root), new Date().toISOString());
}

/**
 * Projeto Mabel que contém `cwd`: raiz do repositório git com `.mabel/config.json`.
 * Lança `ProjectError` com uma dica quando não há projeto.
 */
export function resolveProject(db: DatabaseSync, cwd: string = process.cwd()): Project {
  const root = gitRoot(cwd);
  if (!root) throw new ProjectError('Não é um repositório git. Rode `git init` e depois `mabel init`.');
  const config = readConfig(root);
  if (!config) throw new ProjectError(`${root} não é um projeto Mabel. Rode \`mabel init\`.`);
  registerProject(db, root, config.projectId);
  return { id: config.projectId, root, name: basename(root), config };
}

export function newProjectId(): string {
  return randomUUID();
}

// Detecção de comandos -------------------------------------------------------------------

export interface DetectedCommands {
  setup: string | null;
  verify: VerifyCommand[];
}

const LOCKFILES: [string, string][] = [
  ['package-lock.json', 'npm ci'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
];

/** Script `test` que o `npm init` gera por padrão: não é um comando de teste de verdade. */
const NPM_PLACEHOLDER_TEST = /no test specified/;

/** Lê os arquivos de build da raiz e propõe `setup` e `verify`. Somente leitura. */
export function detectCommands(root: string): DetectedCommands {
  const verify: VerifyCommand[] = [];
  let setup: string | null = null;
  const add = (name: string, command: string) => {
    if (!verify.some((existing) => existing.name === name)) verify.push({ name, command });
  };
  const has = (file: string) => existsSync(join(root, file));

  if (has('package.json')) {
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
      scripts = pkg.scripts ?? {};
    } catch {
      // package.json inválido: nenhum script detectado.
    }
    for (const script of ['build', 'typecheck', 'lint', 'test']) {
      const body = scripts[script];
      if (typeof body !== 'string' || !body.trim()) continue;
      if (script === 'test' && NPM_PLACEHOLDER_TEST.test(body)) continue;
      add(script, script === 'test' ? 'npm test' : `npm run ${script}`);
    }
    // Sem lockfile, `npm install` ainda deixa o worktree pronto para os comandos acima.
    setup = LOCKFILES.find(([lockfile]) => has(lockfile))?.[1] ?? 'npm install';
  }
  if (has('pyproject.toml') || has('pytest.ini')) add('test', 'pytest');
  if (has('Cargo.toml')) {
    add('build', 'cargo build');
    add('test', 'cargo test');
  }
  if (has('go.mod')) {
    add('build', 'go build ./...');
    add('test', 'go test ./...');
  }
  if (has('Makefile') && /^test\s*:/m.test(readFileSync(join(root, 'Makefile'), 'utf8'))) {
    add('test', 'make test');
  }
  return { setup, verify };
}

export function hasTestCommand(verify: VerifyCommand[]): boolean {
  return verify.some((command) => command.name === 'test' || /\b(test|pytest)\b/.test(command.command));
}

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.rb',
  '.php', '.cs', '.c', '.h', '.cpp', '.hpp', '.swift', '.scala', '.ex', '.exs', '.vue', '.svelte',
]);

/** Projeto sem código: nenhum arquivo-fonte fora do `.mabel/` (respeitando o `.gitignore`). */
export function isEmptyProject(root: string): boolean {
  const files = tryGit(root, 'ls-files', '--cached', '--others', '--exclude-standard') ?? '';
  return !files
    .split('\n')
    .filter((file) => file && !file.startsWith(`${MABEL_DIR}/`))
    .some((file) => SOURCE_EXTENSIONS.has(extname(file).toLowerCase()));
}

// Regras críticas ------------------------------------------------------------------------

export interface CriticalRules {
  paths: string[];
  concepts: string[];
}

export const CRITICAL_RULES_TEMPLATE = `# Regras críticas

Itens que tocam estas regras exigem sua aprovação dos critérios de aceite.

## Caminhos

<!-- Um glob por linha, relativo à raiz. Ex.: - src/billing/** -->

## Conceitos

<!-- Uma regra de negócio por linha, em linguagem natural. -->
`;

/** Itens de lista sob `## Caminhos` e `## Conceitos`; comentários HTML e linhas vazias ignorados. */
export function parseCriticalRules(text: string): CriticalRules {
  const rules: CriticalRules = { paths: [], concepts: [] };
  let section: keyof CriticalRules | undefined;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1]?.toLowerCase();
      section = name === 'caminhos' ? 'paths' : name === 'conceitos' ? 'concepts' : undefined;
      continue;
    }
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (section && item?.[1]) rules[section].push(item[1].replace(/^`(.*)`$/, '$1'));
  }
  return rules;
}

export function readCriticalRules(root: string): CriticalRules {
  const path = mabelPath(root, 'regras-criticas.md');
  return existsSync(path) ? parseCriticalRules(readFileSync(path, 'utf8')) : { paths: [], concepts: [] };
}
