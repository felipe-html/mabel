import { writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { balanceOf, formatReset, latestReadings } from './balance.ts';
import { formatCost, formatDuration } from './format.ts';
import { unitArg } from './delivery.ts';
import { unitOf } from './integration.ts';
import { type Unit, openUnits, readIntegrationState } from './units.ts';
import { specBranch, unitBranch } from './worktree.ts';
import { type Item, type ItemStatus, listItems } from './items.ts';
import { type Project, mabelPath } from './project.ts';
import { ensureIgnored, integrationSection } from './report.ts';
import type { QueueEnd } from './run.ts';

// Relatório de run (S.1): `.mabel/run.md`, reescrito ao fim de cada tarefa e no fim do `run`.
// Montado só do banco e do git, para sair igual de qualquer processo (o `rejeitar`, por exemplo).

export const RUN_REPORT_FILE = 'run.md';

export const QUEUE_ENDINGS: Record<QueueEnd, string> = {
  empty: 'fila vazia',
  once: 'concluído',
  interrupted: 'interrompido',
  paused: 'pausado',
  not_found: 'nada a fazer',
  stopped: 'parado',
};

const RESULTS: Partial<Record<ItemStatus, string>> = {
  awaiting_merge: 'concluída',
  done: 'concluída',
  needs_human: 'precisa de você',
  failed: 'falhou',
  blocked: 'bloqueada',
  cancelled: 'cancelada',
  planned: 'planejada',
};

const STAGES: Record<string, string> = { refine: 'refinar', plan: 'planejar', execute: 'executar', review: 'revisar' };
const IN_PROGRESS: ItemStatus[] = ['planning', 'planned', 'executing', 'verifying', 'reviewing'];

const PENDING: Record<string, string> = {
  question_plan: 'pergunta',
  question_execute: 'pergunta',
  critical_approval: 'aprovação de plano',
  plan_incomplete: 'plano incompleto',
  attempts_exhausted: 'tentativas esgotadas',
  environment_block: 'impedimento de ambiente',
  integration_conflict: 'conflito na integração',
};

const two = (n: number) => String(n).padStart(2, '0');
const day = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const time = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

interface Session {
  startId: number;
  start: Date;
  stop?: { at: Date; end: string };
}

/** O último `run` do projeto, pelo `queue_events` (início e, se já acabou, fim). */
function lastSession(db: DatabaseSync, projectId: string): Session | undefined {
  const start = db
    .prepare("SELECT id, at FROM queue_events WHERE project_id = ? AND kind = 'start' ORDER BY id DESC LIMIT 1")
    .get(projectId) as { id: number; at: string } | undefined;
  if (!start) return undefined;
  const stop = db
    .prepare("SELECT at, detail FROM queue_events WHERE project_id = ? AND kind = 'stop' AND id > ? ORDER BY id LIMIT 1")
    .get(projectId, start.id) as { at: string; detail: string } | undefined;
  return { startId: start.id, start: new Date(start.at), ...(stop ? { stop: { at: new Date(stop.at), end: stop.detail } } : {}) };
}

interface TaskRow {
  item: Item;
  stages: string[];
  cost: number;
}

/** Tarefas que tiveram run ou transição desde o início do `run`, na ordem do backlog. */
function sessionTasks(db: DatabaseSync, items: Item[], since: string): TaskRow[] {
  const runs = db.prepare('SELECT stage, coalesce(cost_usd, 0) AS cost FROM runs WHERE item_id = ? AND started_at >= ? ORDER BY started_at');
  const moved = db.prepare('SELECT 1 FROM item_transitions WHERE item_id = ? AND at >= ? LIMIT 1');
  const rows: TaskRow[] = [];
  for (const item of items) {
    const found = runs.all(item.id, since) as { stage: string | null; cost: number }[];
    if (found.length === 0 && !moved.get(item.id, since)) continue;
    const stages = [...new Set(found.map((r) => (r.stage ? (STAGES[r.stage] ?? r.stage) : 'run')))];
    rows.push({ item, stages, cost: found.reduce((sum, r) => sum + r.cost, 0) });
  }
  return rows;
}

function header(db: DatabaseSync, session: Session | undefined, now: Date): string[] {
  if (!session) return [`# Run · nenhum run registrado`];
  const end = session.stop?.at;
  const span = end ? `${time(end)} (${formatDuration(end.getTime() - session.start.getTime())})` : 'em andamento';
  const cost = db
    .prepare('SELECT coalesce(sum(cost_usd), 0) AS total FROM runs WHERE started_at >= ?')
    .get(session.start.toISOString()) as { total: number };
  const status = session.stop ? (QUEUE_ENDINGS[session.stop.end as QueueEnd] ?? session.stop.end) : 'em andamento';
  const parts = [status, formatCost(cost.total)];
  const week = latestReadings(db).find((r) => r.window === 'seven_day');
  if (week) parts.push(`saldo 7 dias: ${Math.round(balanceOf(week) * 100)}% (reset ${formatReset(week.resetsAt, now)})`);
  return [`# Run de ${day(session.start)} · ${time(session.start)} → ${span}`, '', `Fim: ${parts.join(' · ')}`];
}

function needsYou(db: DatabaseSync, project: Project, items: Item[], session: Session | undefined): string[] {
  const lines: string[] = [];
  const inbox = items.filter((item) => item.status === 'needs_human' && item.pendingKind);
  if (inbox.length > 0) {
    const kinds = new Map<string, number[]>();
    for (const item of inbox) {
      const kind = PENDING[item.pendingKind as string] ?? (item.pendingKind as string);
      kinds.set(kind, [...(kinds.get(kind) ?? []), item.number]);
    }
    const parts = [...kinds].map(([kind, numbers]) => `${kind}: ${numbers.map((n) => `#${n}`).join(', ')}`);
    lines.push(`- Inbox (mabel inbox): ${parts.join('; ')}`);
  }
  for (const item of items) {
    const reason = item.statusReason ? `: ${item.statusReason}` : '';
    if (item.status === 'needs_human' && !item.pendingKind) lines.push(`- #${item.number} ${item.title}: needs_human${reason}`);
    if (item.status === 'failed') lines.push(`- #${item.number} ${item.title} falhou${reason}`);
    if (item.status === 'blocked') lines.push(`- #${item.number} ${item.title} bloqueada${reason}`);
  }
  if (session?.stop?.end === 'paused') {
    const pause = db
      .prepare("SELECT detail FROM queue_events WHERE project_id = ? AND kind = 'pause' AND id > ? ORDER BY id DESC LIMIT 1")
      .get(project.id, session.startId) as { detail: string } | undefined;
    if (pause) lines.push(`- Fila pausada: ${pause.detail}`);
  }
  lines.push(...integrationWarnings(db, project, items));
  return lines.length > 0 ? lines : ['Nada.'];
}

/** Branch da unidade pelo nome (`avulso-<n>` ou o slug da spec). */
function branchOfUnit(items: Item[], unit: string): string {
  const avulso = /^avulso-(\d+)$/.exec(unit);
  const item = avulso ? items.find((i) => i.number === Number(avulso[1])) : undefined;
  return item ? unitBranch(item) : specBranch(unit);
}

/** Unidades pausadas, conflitos e verificação vermelha na integração (S4): avisos para o humano. */
function integrationWarnings(db: DatabaseSync, project: Project, items: Item[]): string[] {
  const state = project.config.integracao ? readIntegrationState(db, project.id) : undefined;
  if (!state) return [];
  const base = project.config.baseBranch;
  const lines = state.paused.map(
    (p) => `- Unidade ${p.unit} pausada: conflito da ${base} em ${p.files.join(', ')} (resolva o merge da ${base} na ${p.branch})`,
  );
  for (const conflict of state.conflicts) {
    const branches = [conflict.unit, ...conflict.others].map((unit) => branchOfUnit(items, unit));
    const since = conflict.item !== null ? ` (desde #${conflict.item})` : '';
    lines.push(
      branches.length > 1
        ? `- Integração: ${branches.join(' × ')} conflitam em ${conflict.files.join(', ')}${since}`
        : `- Integração: ${branches[0]} conflita com a integração em ${conflict.files.join(', ')}${since}`,
    );
  }
  if (state.verify && !state.verify.ok) {
    lines.push(`- Integração: verificação vermelha em \`${state.verify.command}\`${state.verify.item ? ` (depois de #${state.verify.item})` : ''}`);
  }
  return lines;
}

function readyToDeliver(db: DatabaseSync, project: Project, items: Item[]): string[] {
  if (project.config.integracao) {
    const units = openUnits(db, project, items);
    return units.length > 0 ? units.map((unit) => `- ${unitLine(unit, items)} · mabel entregar ${unitArg(unit.name)}`) : ['Nada.'];
  }
  const own = items.filter((item) => item.status === 'awaiting_merge' && item.branch);
  return own.length > 0 ? own.map((item) => `- #${item.number} ${item.title} · ${item.branch}`) : ['Nada.'];
}

/** `exportar-csv (2/3)` ou `avulso #9 Corrige total`. */
function unitLine(unit: Unit, items: Item[]): string {
  const avulso = /^avulso-(\d+)$/.exec(unit.name);
  if (avulso) return `avulso #${avulso[1]} ${unit.items[0]?.title ?? ''}`.trimEnd();
  const all = items.filter((item) => unitOf(item) === unit.name && item.status !== 'cancelled');
  return `${unit.name} (${unit.items.length}/${all.length})`;
}

function inProgress(items: Item[]): string[] {
  const open = items.filter((item) => IN_PROGRESS.includes(item.status));
  return open.length > 0 ? open.map((item) => `- #${item.number} ${item.title}: ${item.status}`) : ['Nada.'];
}

function tasksTable(tasks: TaskRow[]): string[] {
  if (tasks.length === 0) return ['Nenhuma tarefa neste run.'];
  return [
    '| # | Unidade | Resultado | Etapas | Custo |',
    '|---|---|---|---|---|',
    ...tasks.map(
      ({ item, stages, cost }) =>
        `| ${item.number} | ${unitOf(item)} | ${RESULTS[item.status] ?? item.status} | ${stages.join(', ') || '—'} | ${formatCost(cost)} |`,
    ),
  ];
}

/** Seções de unidade (o que o `mabel integracao` mostra): prontas, em andamento e integração. */
export function unitSections(db: DatabaseSync, home: string, project: Project, items = listItems(db, project.id)): string[] {
  return [
    '## Prontas para entregar',
    ...readyToDeliver(db, project, items),
    '',
    '## Em andamento',
    ...inProgress(items),
    '',
    '## Integração',
    ...integrationSection(db, home, project),
  ];
}

export function renderRunReport(db: DatabaseSync, home: string, project: Project, now = new Date()): string {
  const session = lastSession(db, project.id);
  const items = listItems(db, project.id);
  const tasks = session ? sessionTasks(db, items, session.start.toISOString()) : [];
  const lines = [
    '<!-- Gerado pelo Mabel. Edições aqui são descartadas. -->',
    ...header(db, session, now),
    '',
    '## Precisa de você',
    ...needsYou(db, project, items, session),
    '',
    ...unitSections(db, home, project, items),
    '',
    '## Tarefas deste run',
    ...tasksTable(tasks),
  ];
  return `${lines.join('\n')}\n`;
}

/** Reescreve o `.mabel/run.md` (não versionado). */
export function writeRunReport(db: DatabaseSync, home: string, project: Project, now = new Date()): string {
  const content = renderRunReport(db, home, project, now);
  ensureIgnored(project.root, RUN_REPORT_FILE);
  writeFileSync(mabelPath(project.root, RUN_REPORT_FILE), content);
  return content;
}
