import type { DatabaseSync } from 'node:sqlite';
import { git, tryGit, withTrailers } from './git.ts';
import { checkedOutAt, conflictedFiles, integrationWorktree, isAncestor, removeTemp, unitOf } from './integration.ts';
import { type Item, listItems, updateItem } from './items.ts';
import type { Project } from './project.ts';
import { getSpecRecord, setSpecStatus } from './specs.ts';
import { branchExists, deleteBranch, isMerged, shell, specBranch, unitBranch } from './worktree.ts';

// Branch por unidade (S.5, `docs/specs/specs-e-entrega.md`): a spec tem a sua branch, o
// avulso trabalha na dele, e a `mabel/integracao` é refeita a cada `run` a partir da base,
// com o merge de cada unidade aberta, só para teste. Conflito ou verificação vermelha nela
// viram aviso; nunca bloqueiam a tarefa.

/** Unidade das tarefas da integração antiga, migradas no primeiro `run` deste modelo. */
export const LEGACY_UNIT = 'legado';

/** A resolução de conflito que o humano gravou é reaplicada quando o conflito volta. */
export const RERERE = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoUpdate=true'];

export interface Unit {
  name: string;
  branch: string;
  /** Tarefas concluídas na branch da unidade e ainda fora da base. */
  items: Item[];
}

export interface UnitConflict {
  unit: string;
  /** Tarefa cujo merge trouxe o conflito; nula na reconstrução da abertura. */
  item: number | null;
  files: string[];
  /** Unidades já na integração que mexem nos mesmos arquivos. */
  others: string[];
}

export interface VerifyResult {
  ok: boolean;
  command?: string;
  detail?: string;
  /** Tarefa cujo merge deixou a integração vermelha; nula na abertura. */
  item?: number | null;
}

/** Estado da integração do último `run` (o `run.md` e o documento de entrega o leem). */
export interface IntegrationState {
  base: string;
  builtAt: string;
  /** Unidades na integração, na ordem do merge. */
  included: string[];
  /** Unidades que conflitaram com a integração: avisos, sem bloquear. */
  conflicts: UnitConflict[];
  /** Unidades pausadas: a base conflita com a branch delas. */
  paused: { unit: string; branch: string; files: string[] }[];
  verify: VerifyResult | null;
}

export function readIntegrationState(db: DatabaseSync, projectId: string): IntegrationState | undefined {
  const row = db.prepare('SELECT state FROM integration_state WHERE project_id = ?').get(projectId) as { state: string } | undefined;
  return row ? (JSON.parse(row.state) as IntegrationState) : undefined;
}

function writeIntegrationState(db: DatabaseSync, projectId: string, state: IntegrationState): void {
  db.prepare(
    `INSERT INTO integration_state (project_id, state, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (project_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
  ).run(projectId, JSON.stringify(state), new Date().toISOString());
}

// Unidades -------------------------------------------------------------------------------

/** Primeira entrada em `awaiting_merge` de cada tarefa: ordena as unidades na integração. */
function firstDone(db: DatabaseSync, itemId: string): string {
  const row = db.prepare("SELECT min(at) AS at FROM item_transitions WHERE item_id = ? AND to_state = 'awaiting_merge'").get(itemId) as {
    at: string | null;
  };
  return row.at ?? '';
}

/** Unidades com tarefa concluída e não entregue, na ordem da primeira integração. */
export function openUnits(db: DatabaseSync, project: Project, items = listItems(db, project.id)): Unit[] {
  const units = new Map<string, Unit & { first: string }>();
  for (const item of items) {
    if (item.status !== 'awaiting_merge' || !item.integratedCommit) continue;
    const name = unitOf(item);
    const unit = units.get(name) ?? { name, branch: unitBranch(item), items: [], first: '' };
    unit.items.push(item);
    const first = firstDone(db, item.id);
    if (!unit.first || first < unit.first) unit.first = first;
    units.set(name, unit);
  }
  return [...units.values()]
    // Unidade cuja branch já chegou à base não tem o que entregar (o `run` a leva a done).
    .filter((unit) => branchExists(project.root, unit.branch) && !isAncestor(project.root, unit.branch, project.config.baseBranch))
    .sort((a, b) => a.first.localeCompare(b.first))
    .map(({ first: _, ...unit }) => unit);
}

// Worktree temporário e merges -----------------------------------------------------------

/** Roda `fn` num worktree temporário destacado em `start`; o worktree é removido no fim. */
function withTemp<T>(home: string, project: Project, start: string, fn: (path: string) => T): T {
  const path = integrationWorktree(home, project.id);
  removeTemp(project, path);
  git(project.root, 'worktree', 'add', '-q', '--detach', path, start);
  try {
    return fn(path);
  } finally {
    removeTemp(project, path);
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

/** Verificação do projeto num worktree (o `setup`, depois cada comando do `verify`). */
export function verifyAt(project: Project, path: string): VerifyResult | null {
  if (project.config.verify.length === 0) return null;
  const tail = (output: string) => output.trimEnd().split('\n').slice(-20).join('\n');
  if (project.config.setup) {
    const { code, output } = shell(project.config.setup, path);
    if (code !== 0) return { ok: false, command: project.config.setup, detail: tail(output) };
  }
  for (const command of project.config.verify) {
    const { code, output } = shell(command.command, path);
    if (code !== 0) return { ok: false, command: command.command, detail: tail(output) };
  }
  return { ok: true };
}

const changedFiles = (root: string, base: string, branch: string) =>
  new Set((tryGit(root, 'diff', '--name-only', `${base}...${branch}`) ?? '').split('\n').filter(Boolean));

/** Unidades da lista que mexem em algum dos arquivos (em relação à base). */
function touching(project: Project, units: Unit[], files: string[]): string[] {
  return units
    .filter((unit) => {
      const changed = changedFiles(project.root, project.config.baseBranch, unit.branch);
      return files.some((file) => changed.has(file));
    })
    .map((unit) => unit.name);
}

/** Avança a branch para o commit, criando-a se preciso. */
function setBranch(project: Project, branch: string, commit: string, old?: string): void {
  if (old) git(project.root, 'update-ref', `refs/heads/${branch}`, commit, old);
  else git(project.root, 'update-ref', `refs/heads/${branch}`, commit);
}

// Migração -------------------------------------------------------------------------------

/**
 * Primeiro `run` com o modelo por unidade: tarefas concluídas na integração antiga viram a
 * unidade `legado` (`mabel/spec/legado`, sem arquivo de spec, só para entrega).
 */
export function migrateLegacy(db: DatabaseSync, project: Project, notes: string[]): void {
  const integration = project.config.integracao;
  if (!integration || readIntegrationState(db, project.id) || !branchExists(project.root, integration)) return;
  const items = listItems(db, project.id).filter(
    (item) =>
      item.status === 'awaiting_merge' &&
      item.integratedCommit &&
      !item.unit &&
      !isAncestor(project.root, item.integratedCommit, project.config.baseBranch),
  );
  if (items.length === 0) return;
  const branch = specBranch(LEGACY_UNIT);
  if (!branchExists(project.root, branch)) git(project.root, 'branch', branch, integration);
  for (const item of items) updateItem(db, item.id, { unit: LEGACY_UNIT });
  notes.push(
    `migração: ${items.map((item) => `#${item.number}`).join(', ')} da ${integration} antiga viraram a unidade ${LEGACY_UNIT} (${branch}); entregue com mabel entregar ${LEGACY_UNIT}`,
  );
}

// Abertura do run ------------------------------------------------------------------------

export interface OpenResult {
  /** Motivo para a fila não começar. */
  pause?: string;
  notes: string[];
  /** Unidades pausadas neste run: as tarefas delas não são escolhidas. */
  paused: Set<string>;
}

/** Branches de unidade que chegaram à base e já não têm tarefa em aberto: apagadas. */
export function removeDeliveredBranches(project: Project, items: Item[], notes: string[]): void {
  const byBranch = new Map<string, Item[]>();
  for (const item of items) {
    if (!project.config.integracao) continue;
    const branch = unitBranch(item);
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), item]);
  }
  for (const [branch, unitItems] of byBranch) {
    if (!branchExists(project.root, branch)) continue;
    if (unitItems.some((item) => item.status !== 'done' && item.status !== 'cancelled')) continue;
    if (!unitItems.some((item) => item.status === 'done')) continue;
    if (!isMerged(project, branch)) continue;
    const warning = deleteBranch(project, branch);
    notes.push(warning ?? `branch ${branch} entregue e apagada`);
  }
}

/**
 * Abertura do `run` (S3): migração do legado, merge da base em cada unidade aberta (conflito
 * pausa a unidade), integração refeita a partir da base com o merge de cada unidade (conflito
 * a deixa de fora, com aviso) e a verificação do projeto nela (vermelho: aviso).
 */
export function openUnitModel(home: string, db: DatabaseSync, project: Project): OpenResult {
  const integration = project.config.integracao;
  const notes: string[] = [];
  const paused = new Set<string>();
  if (!integration) return { notes, paused };
  const open = checkedOutAt(project, integration);
  if (open) return { pause: `a branch ${integration} está aberta em ${open}; feche-a para o Mabel continuar`, notes, paused };
  migrateLegacy(db, project, notes);

  const base = project.config.baseBranch;
  const units = openUnits(db, project);
  const state: IntegrationState = {
    base: git(project.root, 'rev-parse', '--short', base),
    builtAt: new Date().toISOString(),
    included: [],
    conflicts: [],
    paused: [],
    verify: null,
  };

  // A base anda (a `develop` recebe o que outros entregaram): cada unidade aberta a recebe.
  for (const unit of units) {
    if (isAncestor(project.root, base, unit.branch) || checkedOutAt(project, unit.branch)) continue;
    const old = git(project.root, 'rev-parse', `refs/heads/${unit.branch}`);
    const merged = withTemp(home, project, old, (path) => {
      const files = mergeBranch(path, base, `mabel: traz a ${base} para a ${unit.branch}`);
      return files ? { kind: 'conflict' as const, files } : { kind: 'ok' as const, commit: git(path, 'rev-parse', 'HEAD') };
    });
    if (merged.kind === 'conflict') {
      state.paused.push({ unit: unit.name, branch: unit.branch, files: merged.files });
      paused.add(unit.name);
      notes.push(`unidade ${unit.name} pausada: conflito da ${base} em ${merged.files.join(', ')}; resolva o merge da ${base} na ${unit.branch}`);
    } else {
      setBranch(project, unit.branch, merged.commit, old);
      notes.push(`${base} trazida para a ${unit.branch}`);
    }
  }

  // Integração refeita a partir da base, só para teste.
  const included: Unit[] = [];
  const tip = withTemp(home, project, git(project.root, 'rev-parse', base), (path) => {
    for (const unit of units.filter((u) => !paused.has(u.name))) {
      const message = withTrailers(`mabel: integra ${unit.name}`, { 'Mabel-Unidade': unit.name });
      const files = mergeBranch(path, unit.branch, message);
      if (files) {
        const others = touching(project, included, files);
        state.conflicts.push({ unit: unit.name, item: null, files, others });
        notes.push(`integração: ${unit.name} ficou de fora, conflito em ${files.join(', ')}${others.length > 0 ? ` com ${others.join(', ')}` : ''}`);
      } else {
        included.push(unit);
      }
    }
    if (included.length > 0) state.verify = verifyAt(project, path);
    return git(path, 'rev-parse', 'HEAD');
  });
  setBranch(project, integration, tip);
  state.included = included.map((unit) => unit.name);
  writeIntegrationState(db, project.id, state);
  notes.push(`${integration} refeita: ${base} + ${included.length} ${included.length === 1 ? 'unidade' : 'unidades'}`);
  if (state.verify && !state.verify.ok) notes.push(`integração: verificação vermelha em \`${state.verify.command}\``);
  return { notes, paused };
}

// Fim de cada tarefa ---------------------------------------------------------------------

/**
 * Depois do merge da tarefa na branch da unidade: merge da unidade na integração. Conflito
 * ou verificação vermelha viram aviso com a tarefa que o causou, sem desfazer nada (S4).
 */
export function integrateUnit(home: string, db: DatabaseSync, project: Project, item: Item): string[] {
  const integration = project.config.integracao;
  if (!integration) return [];
  const base = project.config.baseBranch;
  if (!branchExists(project.root, integration)) git(project.root, 'branch', integration, base);
  const open = checkedOutAt(project, integration);
  if (open) return [`a ${integration} está aberta em ${open}; a unidade entra nela no próximo run`];
  const unit = unitOf(item);
  const branch = unitBranch(item);
  const state = readIntegrationState(db, project.id) ?? {
    base: git(project.root, 'rev-parse', '--short', base),
    builtAt: new Date().toISOString(),
    included: [],
    conflicts: [],
    paused: [],
    verify: null,
  };
  const old = git(project.root, 'rev-parse', `refs/heads/${integration}`);
  const message = withTrailers(`mabel: integra ${unit} (#${item.number})`, { 'Mabel-Item': `#${item.number}`, 'Mabel-Unidade': unit });
  const result = withTemp(home, project, old, (path) => {
    const files = mergeBranch(path, branch, message);
    if (files) return { kind: 'conflict' as const, files };
    return { kind: 'ok' as const, commit: git(path, 'rev-parse', 'HEAD'), verify: verifyAt(project, path) };
  });
  const notes: string[] = [];
  state.conflicts = state.conflicts.filter((conflict) => conflict.unit !== unit || result.kind === 'conflict');
  if (result.kind === 'conflict') {
    const others = touching(
      project,
      openUnits(db, project).filter((other) => state.included.includes(other.name) && other.name !== unit),
      result.files,
    );
    state.conflicts.push({ unit, item: item.number, files: result.files, others });
    notes.push(`integração: ${unit} conflita em ${result.files.join(', ')}${others.length > 0 ? ` com ${others.join(', ')}` : ''} (desde #${item.number}); a tarefa segue concluída na ${branch}`);
  } else {
    setBranch(project, integration, result.commit, old);
    if (!state.included.includes(unit)) state.included.push(unit);
    state.verify = result.verify && { ...result.verify, item: result.verify.ok ? null : item.number };
    if (result.verify && !result.verify.ok) notes.push(`integração: verificação vermelha em \`${result.verify.command}\` depois de #${item.number}`);
  }
  writeIntegrationState(db, project.id, state);
  return notes;
}

/**
 * Tarefa que depende de tarefa concluída em outra unidade, ainda fora da base: antes de
 * começar, o merge daquela unidade na branch da sua (spec ou avulso). Devolve o conflito.
 */
export function bringDependencies(home: string, db: DatabaseSync, project: Project, item: Item): { unit: string; files: string[] } | undefined {
  if (!project.config.integracao || item.dependsOn.length === 0) return undefined;
  const target = unitBranch(item);
  if (!branchExists(project.root, target)) git(project.root, 'branch', target, project.config.baseBranch);
  const items = listItems(db, project.id);
  const units = new Map<string, string>();
  for (const number of item.dependsOn) {
    const dep = items.find((other) => other.number === number);
    if (!dep || dep.status !== 'awaiting_merge' || !dep.integratedCommit || unitOf(dep) === unitOf(item)) continue;
    units.set(unitOf(dep), unitBranch(dep));
  }
  for (const [unit, branch] of units) {
    if (isAncestor(project.root, branch, target)) continue;
    const old = git(project.root, 'rev-parse', `refs/heads/${target}`);
    const merged = withTemp(home, project, old, (path) => {
      const files = mergeBranch(path, branch, withTrailers(`mabel: traz ${unit} para a ${target}`, { 'Mabel-Unidade': unitOf(item) }));
      return files ? { kind: 'conflict' as const, files } : { kind: 'ok' as const, commit: git(path, 'rev-parse', 'HEAD') };
    });
    if (merged.kind === 'conflict') return { unit, files: merged.files };
    setBranch(project, target, merged.commit, old);
  }
  return undefined;
}

// Entrega (S.6) ----------------------------------------------------------------------------

export type DeliveryProof = { kind: 'ok' } | { kind: 'conflict'; files: string[] } | { kind: 'red'; verify: VerifyResult };

/**
 * Prova da entrega (regra do merge queue): num worktree temporário, a base mais o merge do
 * snapshot e a verificação do projeto. Testa exatamente o que vai entrar.
 */
export function proveDelivery(home: string, project: Project, snapshot: string): DeliveryProof {
  return withTemp(home, project, git(project.root, 'rev-parse', project.config.baseBranch), (path) => {
    const files = mergeBranch(path, snapshot, 'mabel: prova da entrega');
    if (files) return { kind: 'conflict', files };
    const verify = verifyAt(project, path);
    return verify && !verify.ok ? { kind: 'red', verify } : { kind: 'ok' };
  });
}

/** Snapshot de várias unidades juntas (`--com`): merge das outras sobre a primeira. */
export function combineUnits(home: string, project: Project, branches: string[]): { commit: string } | { files: string[]; branch: string } {
  const [first, ...rest] = branches as [string, ...string[]];
  return withTemp(home, project, git(project.root, 'rev-parse', first), (path) => {
    for (const branch of rest) {
      const files = mergeBranch(path, branch, `mabel: junta ${branch} na entrega`);
      if (files) return { files, branch };
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

/** Unidades das quais a unidade depende (tarefas dela que dependem de outra unidade fora da base). */
export function unitDependencies(items: Item[], unit: string): string[] {
  const deps = new Set<string>();
  for (const item of items.filter((i) => unitOf(i) === unit && i.status !== 'cancelled')) {
    for (const number of item.dependsOn) {
      const dep = items.find((other) => other.number === number);
      if (dep && unitOf(dep) !== unit && dep.status !== 'done' && dep.status !== 'cancelled') deps.add(unitOf(dep));
    }
  }
  return [...deps];
}
