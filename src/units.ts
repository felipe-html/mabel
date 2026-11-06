import type { DatabaseSync } from 'node:sqlite';
import { git, tryGit, withTrailers } from './git.ts';
import { checkedOutAt, conflictedFiles, integratedItems, integrationWorktree, isAncestor, removeTemp, unitOf } from './integration.ts';
import { type Item, listItems } from './items.ts';
import type { Project } from './project.ts';
import { type OnStep, timed } from './progress.ts';
import { getSpecRecord, setSpecStatus } from './specs.ts';
import { branchExists, shell, slugify } from './worktree.ts';

// Fila linear (F.1, `docs/specs/fila-e-pilha.md`): a `mabel/integracao` é o trunk do Mabel.
// Toda tarefa nasce da ponta dela e entra nela por merge, em ordem; ela recebe também o
// merge da base na abertura do `run` e nunca é refeita. A unidade (spec ou avulso) é um
// trecho da fila, identificado pelo trailer `Mabel-Unidade` dos merges.

/** A resolução de conflito que o humano gravou é reaplicada quando o conflito volta. */
export const RERERE = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true'];

export interface Unit {
  name: string;
  /** Ponta da unidade: o último commit dela no primeiro pai da integração (F7). */
  tip: string;
  /** Tarefas concluídas da unidade, na fila e ainda fora da base, em ordem. */
  items: Item[];
}

/**
 * Conflito que pausa a fila (`base_conflict`): o merge da base na integração ou, na migração
 * do modelo por unidade (F12), o de uma branch de unidade.
 */
export interface QueueConflict {
  /** Branch cujo merge na integração conflitou: a base ou a da unidade migrada. */
  source: string;
  /** Unidade migrada; nula no merge da base. */
  unit: string | null;
  files: string[];
}

/** Estado da fila na última abertura do `run` (o `run.md`, a inbox e o painel o leem). */
export interface IntegrationState {
  /** Commit da base contido na integração. */
  base: string;
  updatedAt: string;
  conflict: QueueConflict | null;
}

export function readIntegrationState(db: DatabaseSync, projectId: string): IntegrationState | undefined {
  const row = db.prepare('SELECT state FROM integration_state WHERE project_id = ?').get(projectId) as { state: string } | undefined;
  if (!row) return undefined;
  // O estado do S.5 (`included`, `conflicts`, `paused`) não vale mais: a abertura o reescreve.
  const state = JSON.parse(row.state) as Partial<IntegrationState>;
  return { base: state.base ?? '', updatedAt: state.updatedAt ?? '', conflict: state.conflict ?? null };
}

function writeIntegrationState(db: DatabaseSync, projectId: string, state: IntegrationState): void {
  db.prepare(
    `INSERT INTO integration_state (project_id, state, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run(projectId, JSON.stringify(state), new Date().toISOString());
}

/** O que o humano roda para resolver o conflito que pausou a fila. */
export function conflictCommand(project: Project, conflict: QueueConflict): string {
  return `git switch ${project.config.integracao} && git merge ${conflict.source}`;
}

/** O conflito em uma linha: o que conflitou, os arquivos e como resolver. */
export function conflictText(project: Project, conflict: QueueConflict): string {
  const integration = project.config.integracao as string;
  const what = conflict.unit ? `a unidade ${conflict.unit} (${conflict.source})` : `a ${conflict.source}`;
  return `conflito entre ${what} e a ${integration} em ${conflict.files.join(', ')}; resolva com \`${conflictCommand(project, conflict)}\`, commite e volte à ${project.config.baseBranch}`;
}

/** O conflito da base que pausa a fila, se houver. */
export function queueConflict(db: DatabaseSync, project: Project): QueueConflict | null {
  return project.config.integracao ? (readIntegrationState(db, project.id)?.conflict ?? null) : null;
}

// Unidades -------------------------------------------------------------------------------

/** Ponta de cada unidade na integração: o último commit do primeiro pai com o trailer dela. */
function unitTips(project: Project): { tips: Map<string, string>; order: Map<string, number> } {
  const integration = project.config.integracao as string;
  const log =
    tryGit(
      project.root,
      'log',
      '--first-parent',
      '--reverse',
      '--format=%H%x00%(trailers:key=Mabel-Unidade,valueonly,separator=%x00)%x01',
      `${project.config.baseBranch}..${integration}`,
    ) ?? '';
  const tips = new Map<string, string>();
  const order = new Map<string, number>();
  for (const [i, record] of log.split('\x01').entries()) {
    const [commit, unit] = record.trim().split('\0').map((part) => part.trim());
    if (!commit || !unit) continue;
    tips.set(unit, commit);
    order.set(commit, i);
  }
  return { tips, order };
}

/** Unidades com tarefa concluída na fila e fora da base, na ordem da ponta de cada uma. */
export function openUnits(db: DatabaseSync, project: Project, items = listItems(db, project.id)): Unit[] {
  if (!project.config.integracao) return [];
  const ids = new Set(items.map((item) => item.id));
  const queued = integratedItems(db, project).filter((item) => ids.has(item.id));
  const { tips, order } = unitTips(project);
  const units = new Map<string, Unit>();
  for (const item of queued) {
    const name = unitOf(item);
    const unit = units.get(name) ?? { name, tip: tips.get(name) ?? (item.integratedCommit as string), items: [] };
    unit.items.push(item);
    units.set(name, unit);
  }
  return [...units.values()]
    .filter((unit) => !isAncestor(project.root, unit.tip, project.config.baseBranch))
    .sort((a, b) => (order.get(a.tip) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.tip) ?? Number.MAX_SAFE_INTEGER));
}

// Worktree temporário e merges -----------------------------------------------------------

/**
 * Roda `fn` num worktree temporário destacado em `start`; o worktree é removido no fim. Com
 * `onStep`, a criação e a remoção são etapas (a remoção leva o `node_modules` do `setup`).
 */
function withTemp<T>(home: string, project: Project, start: string, fn: (path: string) => T, onStep?: OnStep): T {
  const path = integrationWorktree(home, project.id);
  timed(onStep, 'preparar a cópia da base', () => {
    removeTemp(project, path);
    git(project.root, 'worktree', 'add', '-q', '--detach', path, start);
  });
  try {
    return fn(path);
  } finally {
    timed(onStep, 'apagar a cópia', () => removeTemp(project, path));
  }
}

/**
 * Merge de `branch` no worktree, com o rerere ligado. Devolve `undefined` quando entrou
 * (inclusive com conflito que o rerere resolveu) ou os arquivos em conflito (merge abortado).
 */
export function mergeBranch(path: string, branch: string, message: string): string[] | undefined {
  if (tryGit(path, ...RERERE, 'merge', '-q', '--no-ff', '--no-edit', '-m', message, branch) !== undefined) return undefined;
  const files = conflictedFiles(path);
  if (files.length === 0 && tryGit(path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD') !== undefined) {
    if (tryGit(path, 'commit', '-q', '--no-edit') !== undefined) return undefined;
  }
  tryGit(path, 'merge', '--abort');
  return files.length > 0 ? files : ['(merge falhou)'];
}

/**
 * Merge de `source` na integração, num worktree temporário, e `update-ref` contra o valor
 * antigo: a integração só anda para frente (G10). Devolve os arquivos em conflito.
 */
function mergeIntoIntegration(home: string, project: Project, source: string, message: string): string[] | undefined {
  const integration = project.config.integracao as string;
  const old = git(project.root, 'rev-parse', `refs/heads/${integration}`);
  const merged = withTemp(home, project, old, (path) => {
    const files = mergeBranch(path, source, message);
    return files ? { files } : { commit: git(path, 'rev-parse', 'HEAD') };
  });
  if ('files' in merged) return merged.files;
  git(project.root, 'update-ref', `refs/heads/${integration}`, merged.commit, old);
  return undefined;
}

export interface VerifyResult {
  ok: boolean;
  command?: string;
  detail?: string;
}

/**
 * Verificação do projeto num worktree (o `setup`, depois cada comando do `verify`). Com
 * `onStep`, cada comando é uma etapa (a prova da entrega).
 */
export function verifyAt(project: Project, path: string, onStep?: OnStep): VerifyResult | null {
  if (project.config.verify.length === 0) return null;
  const tail = (output: string) => output.trimEnd().split('\n').slice(-20).join('\n');
  const run = (label: string, command: string) => timed(onStep, label, () => shell(command, path), (result) => result.code === 0);
  const setup = project.config.setup;
  if (setup) {
    const { code, output } = run(`setup · ${setup}`, setup);
    if (code !== 0) return { ok: false, command: setup, detail: tail(output) };
  }
  for (const command of project.config.verify) {
    const { code, output } = run(`verificar ${command.name} · ${command.command}`, command.command);
    if (code !== 0) return { ok: false, command: command.command, detail: tail(output) };
  }
  return { ok: true };
}

// Migração do modelo por unidade (F12) ---------------------------------------------------

/** Prefixos das branches de unidade do S.5, que deixam de existir. */
const LEGACY_PREFIXES = ['mabel/spec/', 'mabel/avulso/'];

/** Branch de unidade do S.5: a da spec (ou do `legado`) ou a do avulso. */
export function legacyUnitBranch(item: Pick<Item, 'number' | 'title' | 'spec'> & { unit?: string | null }): string {
  const unit = item.unit ?? item.spec;
  return unit ? `mabel/spec/${unit}` : `mabel/avulso/${item.number}-${slugify(item.title)}`;
}

/** Primeira entrada em `awaiting_merge` de cada tarefa: ordena as unidades migradas. */
function firstDone(db: DatabaseSync, itemId: string): string {
  const row = db.prepare("SELECT min(at) AS at FROM item_transitions WHERE item_id = ? AND to_state = 'awaiting_merge'").get(itemId) as {
    at: string | null;
  };
  return row.at ?? '';
}

/**
 * Unidades abertas do S.5 (tarefa concluída numa branch de unidade, fora da integração):
 * entram na integração por merge, na ordem da primeira tarefa concluída de cada uma.
 * Devolve o conflito da primeira que não entra; as seguintes esperam.
 */
function migrateUnits(home: string, db: DatabaseSync, project: Project, notes: string[]): QueueConflict | undefined {
  const integration = project.config.integracao as string;
  const units = new Map<string, { branch: string; first: string }>();
  for (const item of listItems(db, project.id)) {
    const commit = item.integratedCommit;
    if (item.status !== 'awaiting_merge' || !commit) continue;
    if (isAncestor(project.root, commit, integration) || isAncestor(project.root, commit, project.config.baseBranch)) continue;
    const branch = legacyUnitBranch(item);
    if (!branchExists(project.root, branch)) continue;
    const name = unitOf(item);
    const first = firstDone(db, item.id);
    const unit = units.get(name);
    if (!unit || first < unit.first) units.set(name, { branch, first });
  }
  const ordered = [...units].sort(([, a], [, b]) => a.first.localeCompare(b.first));
  for (const [name, { branch }] of ordered) {
    const message = withTrailers(`mabel: integra ${name} na ${integration} (migração)`, { 'Mabel-Unidade': name });
    const files = mergeIntoIntegration(home, project, branch, message);
    if (files) return { source: branch, unit: name, files };
    notes.push(`migração: ${branch} entrou na ${integration}`);
  }
  return undefined;
}

/** Branches de unidade do S.5 que a integração já contém: apagadas. */
function removeLegacyBranches(project: Project, notes: string[]): void {
  const integration = project.config.integracao as string;
  const refs = tryGit(project.root, 'for-each-ref', '--format=%(refname:short)', ...LEGACY_PREFIXES.map((prefix) => `refs/heads/${prefix}`)) ?? '';
  for (const branch of refs.split('\n').filter(Boolean)) {
    if (!isAncestor(project.root, branch, integration) || checkedOutAt(project, branch)) continue;
    if (tryGit(project.root, 'branch', '-D', branch) !== undefined) notes.push(`branch ${branch} contida na ${integration} e apagada`);
  }
}

// Abertura do run ------------------------------------------------------------------------

export interface OpenResult {
  /** Motivo para a fila não começar. */
  pause?: string;
  /** O conflito que pausou a fila (`base_conflict`). */
  conflict?: QueueConflict;
  notes: string[];
}

/**
 * Abertura do `run` (F4, F12): a integração nasce da base se não existe; as unidades abertas
 * do S.5 entram nela por merge; depois, o merge da base. Conflito pausa a fila com
 * `base_conflict`: nada novo entra sem o merge limpo.
 */
export function openQueue(home: string, db: DatabaseSync, project: Project): OpenResult {
  const integration = project.config.integracao;
  const notes: string[] = [];
  if (!integration) return { notes };
  const open = checkedOutAt(project, integration);
  if (open) return { pause: `a branch ${integration} está aberta em ${open}; feche-a para o Mabel continuar`, notes };
  const base = project.config.baseBranch;
  if (!branchExists(project.root, integration)) git(project.root, 'branch', integration, base);

  let conflict = migrateUnits(home, db, project, notes);
  if (!conflict && !isAncestor(project.root, base, integration)) {
    const files = mergeIntoIntegration(home, project, base, `mabel: traz a ${base} para a ${integration}`);
    if (files) conflict = { source: base, unit: null, files };
    else notes.push(`${base} trazida para a ${integration}`);
  }
  removeLegacyBranches(project, notes);
  writeIntegrationState(db, project.id, {
    base: git(project.root, 'rev-parse', '--short', base),
    updatedAt: new Date().toISOString(),
    conflict: conflict ?? null,
  });
  if (!conflict) return { notes };
  return { pause: `fila pausada: ${conflictText(project, conflict)}`, conflict, notes };
}

// Entrega (S.6) ----------------------------------------------------------------------------

export type DeliveryProof = { kind: 'ok' } | { kind: 'conflict'; files: string[] } | { kind: 'red'; verify: VerifyResult };

/**
 * Prova da entrega (regra do merge queue): num worktree temporário, a base mais o merge do
 * snapshot e a verificação do projeto. Testa exatamente o que vai entrar.
 */
export function proveDelivery(home: string, project: Project, snapshot: string, onStep?: OnStep): DeliveryProof {
  const base = git(project.root, 'rev-parse', project.config.baseBranch);
  return withTemp(
    home,
    project,
    base,
    (path) => {
      const files = timed(onStep, 'juntar a unidade', () => mergeBranch(path, snapshot, 'mabel: prova da entrega'), (result) => !result);
      if (files) return { kind: 'conflict', files };
      const verify = verifyAt(project, path, onStep);
      return verify && !verify.ok ? { kind: 'red', verify } : { kind: 'ok' };
    },
    onStep,
  );
}

/** Snapshot de várias unidades juntas (`--com`): merge das outras pontas sobre a primeira. */
export function combineUnits(home: string, project: Project, tips: string[]): { commit: string } | { files: string[]; tip: string } {
  const [first, ...rest] = tips as [string, ...string[]];
  return withTemp(home, project, first, (path) => {
    for (const tip of rest) {
      if (isAncestor(path, tip, 'HEAD')) continue;
      const files = mergeBranch(path, tip, `mabel: junta ${tip.slice(0, 7)} na entrega`);
      if (files) return { files, tip };
    }
    return { commit: git(path, 'rev-parse', 'HEAD') };
  });
}

/** Specs com todas as tarefas concluídas na base: `entregue`. */
export function markDeliveredSpecs(db: DatabaseSync, project: Project, items: Item[], notes: string[]): void {
  const specs = new Set(items.flatMap((item) => (item.spec ? [item.spec] : [])));
  for (const slug of specs) {
    const tasks = items.filter((item) => item.spec === slug && item.status !== 'cancelled');
    if (tasks.length === 0 || !tasks.every((item) => item.status === 'done')) continue;
    if (getSpecRecord(db, project.id, slug)?.status === 'entregue') continue;
    setSpecStatus(db, project.id, slug, 'entregue');
    notes.push(`spec ${slug} entregue`);
  }
}
