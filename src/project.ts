import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { tryGit } from './git.ts';

export type Stage = 'refine' | 'plan' | 'execute' | 'review';

export interface VerifyCommand {
  name: string;
  command: string;
}

export interface StageLimits {
  maxTurns: number;
  maxBudgetUsd: number;
}

/**
 * O que fazer com a pergunta do agente que não toca regra crítica e traz sugestão:
 * `sugestoes` adota a sugestão e registra como suposição; `perguntar` para o item.
 */
export type Autonomy = 'sugestoes' | 'perguntar';

export interface ProjectConfig {
  projectId: string;
  baseBranch: string;
  setup: string | null;
  verify: VerifyCommand[];
  models: Record<Stage, string>;
  limits: Record<Stage, StageLimits>;
  autonomia: Autonomy;
  /**
   * Comando que roda um teste só, para a prova (`{arquivo}`, `{pasta}`, `{nome}`, `{padrao}`).
   * `null`: a prova roda o comando de teste do `verify` uma vez (modo por item).
   */
  testeUnico: string | null;
  /** Globs dos arquivos que são só de teste; ficam com a versão do item quando a prova roda a base. */
  arquivosDeTeste: string[];
  /**
   * Branch de integração: item provado entra nela e os próximos nascem dela. `null`: uma
   * branch por item, com merge do humano na base.
   */
  integracao: string | null;
  /** Orçamento do contexto do projeto injetado nas etapas (`CLAUDE.md`, `AGENTS.md`, regras críticas). */
  contexto: { maxCaracteres: number };
  /**
   * Domínios liberados na rede do sandbox. O `init` grava os da stack; `null` (config antiga):
   * os das stacks detectadas no projeto.
   */
  rede: string[] | null;
  /** `false` roda as etapas sem sandbox, com aviso a cada execução e registro em cada run. */
  sandbox: boolean;
}

export const DEFAULT_INTEGRATION = 'mabel/integracao';

/** Caracteres somados do contexto do projeto injetado nas etapas. */
export const DEFAULT_CONTEXT_BUDGET = 40_000;

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

export const DEFAULT_MODELS: Record<Stage, string> = { refine: 'sonnet', plan: 'opus', execute: 'sonnet', review: 'opus' };

export const DEFAULT_LIMITS: Record<Stage, StageLimits> = {
  refine: { maxTurns: 30, maxBudgetUsd: 1 },
  plan: { maxTurns: 40, maxBudgetUsd: 3 },
  execute: { maxTurns: 120, maxBudgetUsd: 8 },
  review: { maxTurns: 40, maxBudgetUsd: 3 },
};

/** Arquivos de teste de todas as stacks do catálogo: vale para config sem `arquivosDeTeste`. */
export const DEFAULT_TEST_GLOBS = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  'test/**',
  'tests/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/conftest.py',
  '**/*_test.go',
  '**/testdata/**',
];

export class ProjectError extends Error {}

/** Raiz real do repositório git que contém `cwd`, ou `undefined` fora de um repositório. */
export function gitRoot(cwd: string): string | undefined {
  const root = tryGit(cwd, 'rev-parse', '--show-toplevel');
  return root ? realpathSync(root) : undefined;
}

export function hasCommits(root: string): boolean {
  return tryGit(root, 'rev-parse', '--verify', '--quiet', 'HEAD') !== undefined;
}

/** O `.mabel/config.json` está commitado na branch base: os worktrees dos itens nascem dela. */
export function mabelCommitted(root: string, baseBranch: string): boolean {
  return tryGit(root, 'cat-file', '-e', `${baseBranch}:${MABEL_DIR}/config.json`) !== undefined;
}

/** Arquivos do `.mabel/` não commitados (novos ou alterados), fora os ignorados. */
export function mabelUncommitted(root: string): boolean {
  return (tryGit(root, 'status', '--porcelain', '--', MABEL_DIR) ?? '') !== '';
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
      refine: { ...DEFAULT_LIMITS.refine, ...raw.limits?.refine },
      plan: { ...DEFAULT_LIMITS.plan, ...raw.limits?.plan },
      execute: { ...DEFAULT_LIMITS.execute, ...raw.limits?.execute },
      review: { ...DEFAULT_LIMITS.review, ...raw.limits?.review },
    },
    autonomia: raw.autonomia === 'perguntar' ? 'perguntar' : 'sugestoes',
    testeUnico: typeof raw.testeUnico === 'string' && raw.testeUnico.trim() ? raw.testeUnico : null,
    arquivosDeTeste: Array.isArray(raw.arquivosDeTeste) ? raw.arquivosDeTeste : [...DEFAULT_TEST_GLOBS],
    // Config sem o campo vale ligada; `null` (ou vazio) desliga.
    integracao: !('integracao' in raw) ? DEFAULT_INTEGRATION : typeof raw.integracao === 'string' && raw.integracao.trim() ? raw.integracao : null,
    contexto: {
      maxCaracteres:
        typeof raw.contexto?.maxCaracteres === 'number' && raw.contexto.maxCaracteres > 0
          ? raw.contexto.maxCaracteres
          : DEFAULT_CONTEXT_BUDGET,
    },
    rede: Array.isArray(raw.rede) ? raw.rede.filter((domain) => typeof domain === 'string' && domain.trim()) : null,
    sandbox: raw.sandbox !== false,
  };
}

export function writeConfig(root: string, config: ProjectConfig): void {
  writeFileSync(mabelPath(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

/** Id com que a raiz já foi registrada, por exemplo antes de o `.mabel/` ser apagado. */
export function registeredProjectId(db: DatabaseSync, root: string): string | undefined {
  const row = db.prepare('SELECT id FROM projects WHERE root = ?').get(root) as { id: string } | undefined;
  return row?.id;
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
