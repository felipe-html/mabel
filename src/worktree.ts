import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { git, tryGit } from './git.ts';
import type { Item } from './items.ts';
import type { Project } from './project.ts';

/** Título em minúsculas, sem acentos, só `[a-z0-9-]`, até 40 caracteres. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 40).replace(/-+$/, '') || 'item';
}

export function branchName(item: Pick<Item, 'number' | 'title'>): string {
  return `mabel/${item.number}-${slugify(item.title)}`;
}

export function worktreePath(home: string, projectId: string, item: Pick<Item, 'number' | 'title'>): string {
  return join(home, 'worktrees', projectId, `${item.number}-${slugify(item.title)}`);
}

export interface PreparedWorktree {
  path: string;
  branch: string;
  created: boolean;
  /** Saída resumida do `config.setup` quando ele falha. */
  setupError?: string;
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

/** Roda um comando de shell no diretório dado, com stdout e stderr juntos. */
export function shell(command: string, cwd: string): { code: number; output: string } {
  const result = spawnSync('sh', ['-c', `${command} 2>&1`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? 1, output: result.stdout ?? '' };
}

/**
 * Cria (ou reutiliza, na retomada) o worktree e a branch do item a partir da branch base,
 * grava os caminhos no item e roda o `setup` do projeto quando o worktree é novo.
 */
export function prepareWorktree(db: DatabaseSync, home: string, project: Project, item: Item): PreparedWorktree {
  const branch = item.branch ?? branchName(item);
  const path = item.worktree ?? worktreePath(home, project.id, item);
  let created = false;

  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    tryGit(project.root, 'worktree', 'prune');
    const branchExists = tryGit(project.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`) !== undefined;
    if (branchExists) git(project.root, 'worktree', 'add', path, branch);
    else git(project.root, 'worktree', 'add', '-b', branch, path, project.config.baseBranch);
    created = true;
  } else {
    catchUp(path, project.config.baseBranch);
  }
  db.prepare('UPDATE items SET branch = ?, worktree = ?, updated_at = ? WHERE id = ?').run(
    branch,
    path,
    new Date().toISOString(),
    item.id,
  );
  item.branch = branch;
  item.worktree = path;

  if (created && project.config.setup) {
    const { code, output } = shell(project.config.setup, path);
    if (code !== 0) {
      return { path, branch, created, setupError: `setup \`${project.config.setup}\` saiu com ${code}: ${lastLines(output, 20)}` };
    }
  }
  return { path, branch, created };
}

/**
 * Worktree reutilizado sem commits próprios e sem alterações (ex.: item parado no
 * planejamento) avança até a branch base, para enxergar o que foi commitado depois.
 */
function catchUp(path: string, baseBranch: string): void {
  if (tryGit(path, 'merge-base', '--is-ancestor', 'HEAD', baseBranch) === undefined) return;
  if (tryGit(path, 'status', '--porcelain', '--untracked-files=no') !== '') return;
  tryGit(path, 'merge', '-q', '--ff-only', baseBranch);
}

/** Remove o worktree do item (a branch fica). */
export function removeWorktree(db: DatabaseSync, project: Project, item: Item): void {
  if (item.worktree && existsSync(item.worktree)) {
    git(project.root, 'worktree', 'remove', '--force', item.worktree);
  }
  tryGit(project.root, 'worktree', 'prune');
  db.prepare('UPDATE items SET worktree = NULL, updated_at = ? WHERE id = ?').run(new Date().toISOString(), item.id);
  item.worktree = null;
}

/** Commit de tudo que mudou no worktree. Devolve `false` quando não há alteração. */
export function commitAll(path: string, message: string): boolean {
  git(path, 'add', '-A');
  if (tryGit(path, 'diff', '--cached', '--quiet') !== undefined) return false;
  git(path, 'commit', '-q', '-m', message);
  return true;
}

export function commitMessage(item: Pick<Item, 'number' | 'title'>, attempt: number): string {
  return `mabel(#${item.number}): ${item.title} — execução ${attempt}`;
}

/** A branch do item já está contida na branch base (merge feito pelo humano). */
export function isMerged(project: Project, branch: string): boolean {
  return tryGit(project.root, 'merge-base', '--is-ancestor', branch, project.config.baseBranch) !== undefined;
}
