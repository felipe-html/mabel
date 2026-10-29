import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { git, tryGit, withTrailers } from './git.ts';
import { type Item, listItems, transition, updateItem } from './items.ts';
import type { Project } from './project.ts';
import { branchExists, worktreesDir } from './worktree.ts';

// Branch de integração (P.4): item provado entra sozinho nela; o humano faz o merge na base.

/** Worktree temporário do Mabel para merges e reverts na integração. */
export function integrationWorktree(home: string, projectId: string): string {
  return join(worktreesDir(home, projectId), '_integracao');
}

/** O commit está contido na branch (ou commit) dada. */
export function isAncestor(root: string, commit: string, of: string): boolean {
  return tryGit(root, 'merge-base', '--is-ancestor', commit, of) !== undefined;
}

/** Arquivos em conflito no worktree (merge ou revert interrompido). */
export function conflictedFiles(worktree: string): string[] {
  return (tryGit(worktree, 'diff', '--name-only', '--diff-filter=U') ?? '').split('\n').filter(Boolean);
}

/**
 * Caminho do worktree com a branch aberta (o checkout do humano, por exemplo), ou
 * `undefined`. O Mabel nunca abre a integração: os worktrees dele usam a branch do item ou
 * ficam destacados.
 */
export function checkedOutAt(project: Project, branch: string): string | undefined {
  const list = tryGit(project.root, 'worktree', 'list', '--porcelain') ?? '';
  for (const entry of list.split('\n\n')) {
    if (/^branch (.+)$/m.exec(entry)?.[1] === `refs/heads/${branch}`) return /^worktree (.+)$/m.exec(entry)?.[1];
  }
  return undefined;
}

function removeTemp(project: Project, path: string): void {
  if (existsSync(path) && tryGit(project.root, 'worktree', 'remove', '--force', path) === undefined) {
    rmSync(path, { recursive: true, force: true });
  }
  tryGit(project.root, 'worktree', 'prune');
}

export type TempResult = { kind: 'ok'; commit: string } | { kind: 'conflict'; files: string[] };

/**
 * Roda `op` num worktree temporário destacado em `branch` e, se der certo, avança a branch
 * para o novo commit com `update-ref` contra o valor antigo (nada é sobrescrito). Conflito:
 * `abort` e a branch fica como estava.
 */
export function onTempWorktree(
  home: string,
  project: Project,
  branch: string,
  op: (path: string) => boolean,
  abort: string[],
): TempResult {
  const path = integrationWorktree(home, project.id);
  removeTemp(project, path);
  const old = git(project.root, 'rev-parse', `refs/heads/${branch}`);
  git(project.root, 'worktree', 'add', '-q', '--detach', path, old);
  try {
    if (!op(path)) {
      const files = conflictedFiles(path);
      tryGit(path, ...abort);
      return { kind: 'conflict', files };
    }
    const commit = git(path, 'rev-parse', 'HEAD');
    git(project.root, 'update-ref', `refs/heads/${branch}`, commit, old);
    return { kind: 'ok', commit };
  } finally {
    removeTemp(project, path);
  }
}

export interface OpenResult {
  /** Motivo para a fila não começar. */
  pause?: string;
  notes: string[];
}

/**
 * Abertura do `run` com integração: cria a branch, recusa seguir se ela estiver aberta fora
 * do Mabel e traz para ela o que entrou na base (avanço direto ou merge).
 */
export function openIntegration(home: string, project: Project): OpenResult {
  const integration = project.config.integracao;
  const base = project.config.baseBranch;
  const notes: string[] = [];
  if (!integration) return { notes };
  if (!branchExists(project.root, integration)) {
    git(project.root, 'branch', integration, base);
    notes.push(`branch ${integration} criada a partir da ${base}`);
    return { notes };
  }
  const open = checkedOutAt(project, integration);
  if (open) return { pause: `a branch ${integration} está aberta em ${open}; feche-a para o Mabel continuar`, notes };
  if (isAncestor(project.root, base, integration)) return { notes };

  if (isAncestor(project.root, integration, base)) {
    const old = git(project.root, 'rev-parse', `refs/heads/${integration}`);
    git(project.root, 'update-ref', `refs/heads/${integration}`, git(project.root, 'rev-parse', base), old);
    notes.push(`${integration} avançada até a ${base}`);
    return { notes };
  }
  const merged = onTempWorktree(
    home,
    project,
    integration,
    (path) => tryGit(path, 'merge', '-q', '--no-edit', '-m', `mabel: traz a ${base} para a integração`, base) !== undefined,
    ['merge', '--abort'],
  );
  if (merged.kind === 'conflict') {
    return {
      pause: `a ${base} e a ${integration} divergiram com conflito em: ${merged.files.join(', ')}. Faça o merge da ${base} na ${integration} à mão e rode de novo`,
      notes,
    };
  }
  notes.push(`${base} trazida para a ${integration} (merge)`);
  return { notes };
}

/** Itens integrados cujo merge já está na base: passam a `done`. */
export function finishIntegrated(db: DatabaseSync, project: Project, items: Item[]): Item[] {
  const finished = items.filter(
    (item) =>
      item.status === 'awaiting_merge' &&
      item.integratedCommit !== null &&
      isAncestor(project.root, item.integratedCommit, project.config.baseBranch),
  );
  for (const item of finished) {
    transition(db, project, item.id, 'done', `merge da ${project.config.integracao ?? 'integração'} na ${project.config.baseBranch}`);
  }
  return finished;
}

/**
 * Merge da origem no worktree do item, se ela andou desde o início do item. Devolve os
 * arquivos em conflito (o merge é abortado) ou `undefined` quando não há conflito.
 */
export function mergeOrigin(worktree: string, origin: string, abortOnConflict = true): string[] | undefined {
  if (isAncestor(worktree, origin, 'HEAD')) return undefined;
  if (tryGit(worktree, 'merge', '-q', '--no-edit', origin) !== undefined) return undefined;
  const files = conflictedFiles(worktree);
  if (abortOnConflict) tryGit(worktree, 'merge', '--abort');
  return files;
}

/** Há um merge em andamento no worktree (conflitos deixados para o executor). */
export function mergeInProgress(worktree: string): boolean {
  return tryGit(worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD') !== undefined;
}

/**
 * Integra o item: commit de merge com a árvore do item sobre a integração (o item já a
 * contém) e `update-ref` contra o valor antigo. Devolve o commit ou o motivo da falha.
 */
export function integrateItem(project: Project, item: Item): { commit: string } | { error: string } {
  const integration = project.config.integracao as string;
  const worktree = item.worktree as string;
  const old = git(project.root, 'rev-parse', `refs/heads/${integration}`);
  const head = git(worktree, 'rev-parse', 'HEAD');
  if (!isAncestor(project.root, old, head)) {
    return { error: `a ${integration} mudou durante o item; o item não contém o que já foi integrado` };
  }
  const tree = git(worktree, 'rev-parse', 'HEAD^{tree}');
  const message = withTrailers(`mabel: integra #${item.number} ${item.title}`, itemTrailers(item));
  const commit = git(project.root, 'commit-tree', tree, '-p', old, '-p', head, '-m', message);
  if (tryGit(project.root, 'update-ref', `refs/heads/${integration}`, commit, old) === undefined) {
    return { error: `a ${integration} mudou durante a integração; nada foi integrado` };
  }
  return { commit };
}

/** Unidade de entrega da tarefa: o slug da spec ou `avulso-<n>`. */
export function unitOf(item: Pick<Item, 'number' | 'spec'>): string {
  return item.spec ?? `avulso-${item.number}`;
}

/** Trailers dos commits de merge do Mabel: `Mabel-Item` e `Mabel-Unidade`. */
export function itemTrailers(item: Pick<Item, 'number' | 'spec'>): Record<string, string> {
  return { 'Mabel-Item': `#${item.number}`, 'Mabel-Unidade': unitOf(item) };
}

/** Grava o commit de integração no item (ou o limpa, na rejeição). */
export function setIntegrated(db: DatabaseSync, item: Item, commit: string | null): void {
  updateItem(db, item.id, { integratedCommit: commit });
  item.integratedCommit = commit;
}

/**
 * Itens na integração e ainda fora da base, na ordem em que foram integrados. Com `upTo`
 * (o commit de uma entrega), só os integrados até ele.
 */
export function integratedItems(db: DatabaseSync, project: Project, upTo?: string): Item[] {
  const integration = project.config.integracao;
  if (!integration || !branchExists(project.root, integration)) return [];
  const order = (tryGit(project.root, 'rev-list', '--first-parent', '--reverse', `${project.config.baseBranch}..${upTo ?? integration}`) ?? '')
    .split('\n')
    .filter(Boolean);
  const position = new Map(order.map((commit, i) => [commit, i]));
  return listItems(db, project.id)
    .filter((item) => item.status === 'awaiting_merge' && item.integratedCommit && position.has(item.integratedCommit))
    .sort((a, b) => (position.get(a.integratedCommit as string) as number) - (position.get(b.integratedCommit as string) as number));
}
