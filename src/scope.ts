import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { matchGlob } from './glob.ts';

/**
 * Hook de escopo (G4, arquivos): decide cada escrita do agente pelo escopo do plano. Roda no
 * processo do hook (`hooks/escopo.mjs`), que o Claude Code chama antes de cada ferramenta.
 */

/** Contexto gravado pelo Mabel em `<run>/escopo.json` e apontado por `MABEL_ESCOPO`. */
export interface ScopeContext {
  worktree: string;
  stage: string;
  escopo: string[];
  criticos: string[];
  criticosAprovados: boolean;
  log: string;
}

export interface HookInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

export interface ScopeDecision {
  decision: 'allow' | 'deny';
  reason?: string;
  tool: string;
  /** Caminho relativo ao worktree (ou absoluto, fora dele). */
  path?: string;
  command?: string;
}

export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

/** `realpath` do ancestral mais próximo que existe, com o resto do caminho por cima. */
function realish(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return missing.length > 0 ? join(base, ...missing) : base;
}

function targetOf(input: HookInput): string | undefined {
  const toolInput = input.tool_input ?? {};
  const value = toolInput.file_path ?? toolInput.notebook_path;
  return typeof value === 'string' && value ? value : undefined;
}

export function decideScope(input: HookInput, context: ScopeContext): ScopeDecision {
  const tool = input.tool_name ?? '';
  if (tool === 'Bash') {
    // O sandbox confina a escrita do terminal; o hook só registra.
    const command = input.tool_input?.command;
    return { decision: 'allow', tool, command: typeof command === 'string' ? command : undefined };
  }
  if (!WRITE_TOOLS.includes(tool)) return { decision: 'allow', tool };

  const target = targetOf(input);
  if (!target) return { decision: 'deny', tool, reason: 'caminho do arquivo ausente' };
  const worktree = realish(resolve(context.worktree));
  const absolute = realish(isAbsolute(target) ? target : resolve(input.cwd ?? context.worktree, target));
  const path = relative(worktree, absolute);
  if (path === '' || path.startsWith(`..${sep}`) || path === '..' || isAbsolute(path)) {
    return { decision: 'deny', tool, path: absolute, reason: 'fora do worktree do item' };
  }
  const posix = path.split(sep).join('/');
  const reason = scopeViolation(posix, context);
  return reason ? { decision: 'deny', tool, path: posix, reason } : { decision: 'allow', tool, path: posix };
}

export const OUT_OF_SCOPE = 'fora do escopo do plano; declare em escopoAdicional se for necessário';

/**
 * Regras 2 a 4 do escopo para um caminho relativo ao worktree (em `/`): valem para o hook,
 * antes da escrita, e para o gate de escopo, sobre o que o item mudou.
 */
export function scopeViolation(
  path: string,
  context: Pick<ScopeContext, 'escopo' | 'criticos' | 'criticosAprovados'>,
): string | undefined {
  const first = path.split('/')[0];
  if (first === '.git' || first === '.mabel') return 'arquivo do Mabel ou do git';
  const critical = context.criticos.find((glob) => matchGlob(glob, path));
  if (critical && !context.criticosAprovados) return `caminho crítico sem aprovação: ${critical}`;
  if (!context.escopo.some((glob) => matchGlob(glob, path))) return OUT_OF_SCOPE;
  return undefined;
}

/** Saída do hook que nega a ação; permitir é não escrever nada. */
export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}
