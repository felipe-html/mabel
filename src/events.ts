import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { dataDir, openDb } from './db.ts';
import { fail } from './errors.ts';
import { pendingItems } from './inbox.ts';
import { isoLocal } from './json.ts';
import { systemClock } from './run.ts';
import { type RunOutcome, type RunStage, isUsageLimit } from './runner.ts';
import { type OptionSpecs, jsonOption } from './options.ts';

export const eventsUsage = 'mabel eventos --json';

export const eventsOptions = {
  json: { ...jsonOption, description: 'Obrigatória: uma linha de JSON por evento' },
} satisfies OptionSpecs;

/** Versão do formato do fluxo (`docs/specs/integracao-externa.md`). */
export const EVENTS_VERSION = 1;

export type StreamEvent = { versao: number; tipo: string } & Record<string, unknown>;

type QueueState = 'rodando' | 'parada' | 'pausada_por_saldo';

/**
 * Até onde o fluxo já leu cada tabela (o `rowid` do último registro enviado), as runs de
 * etapa que começaram e ainda não terminaram, e o último valor enviado por projeto de
 * pendências da inbox e de estado da fila.
 */
export interface EventCursor {
  runs: number;
  toolCalls: number;
  gates: number;
  transitions: number;
  rateLimits: number;
  queue: number;
  openRuns: Set<string>;
  inbox: Map<string, number>;
  queueState: Map<string, QueueState>;
}

const STAGE_LABELS: Record<RunStage, string> = { refine: 'refinar', plan: 'planejar', execute: 'executar', review: 'revisar', birth: 'nascer' };
const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d' };
/** Pausas por saldo; as outras (integração, contexto, código) aparecem como `parada` no fim da fila. */
const BALANCE_PAUSES = new Set(['seven_day', 'no_reading']);

const maxRowid = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT coalesce(max(rowid), 0) AS max FROM ${table}`).get() as { max: number }).max;

/** Cursor no fim de cada tabela: o fluxo começa no que acontecer depois de aberto. */
export function eventCursor(db: DatabaseSync): EventCursor {
  const open = db.prepare("SELECT id FROM runs WHERE kind = 'stage' AND status = 'running'").all() as { id: string }[];
  const projects = db.prepare('SELECT id FROM projects').all() as { id: string }[];
  return {
    runs: maxRowid(db, 'runs'),
    toolCalls: maxRowid(db, 'tool_calls'),
    gates: maxRowid(db, 'gate_results'),
    transitions: maxRowid(db, 'item_transitions'),
    rateLimits: maxRowid(db, 'rate_limits'),
    queue: maxRowid(db, 'queue_events'),
    openRuns: new Set(open.map((run) => run.id)),
    inbox: new Map(projects.map((project) => [project.id, pendingItems(db, project.id).length])),
    queueState: new Map(),
  };
}

/**
 * Registro lido do banco, antes de virar evento. `order` desempata registros do mesmo
 * milissegundo na ordem em que acontecem numa etapa.
 */
interface Entry {
  at: string;
  order: number;
  projectId?: string;
  event?: Record<string, unknown>;
  queue?: { kind: string; cause: string; detail: string; project: string };
}

const ORDER = { queueStart: 0, stageStart: 1, balance: 2, tool: 3, stageEnd: 4, gate: 5, item: 6, inbox: 7, queue: 8 };

interface RunRow {
  rowid: number;
  id: string;
  stage: RunStage | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  error: string | null;
  result_text: string | null;
  rate_status: string | null;
  number: number | null;
  project: string | null;
  project_id: string | null;
}

const RUN_SELECT = `SELECT r.rowid AS rowid, r.id, r.stage, r.status, r.started_at, r.ended_at, r.error, r.result_text,
  (SELECT status FROM rate_limits WHERE run_id = r.id ORDER BY id DESC LIMIT 1) AS rate_status,
  i.number, p.name AS project, p.id AS project_id
  FROM runs r LEFT JOIN items i ON i.id = r.item_id LEFT JOIN projects p ON p.id = i.project_id`;

/** Por que a run falhou: `interrompida` (ctrl+c), `saldo` (limite de uso) ou `erro`. */
function failureReason(run: RunRow): string {
  if (run.status === 'interrupted') return 'interrompida';
  const outcome = {
    status: run.status,
    error: run.error ?? undefined,
    rateLimitStatus: run.rate_status ?? undefined,
    totals: run.result_text === null ? undefined : { text: run.result_text },
  } as unknown as RunOutcome;
  return isUsageLimit(outcome) ? 'saldo' : 'erro';
}

function stageEnd(run: RunRow): Entry {
  const succeeded = run.status === 'succeeded';
  return {
    at: run.ended_at ?? run.started_at,
    order: ORDER.stageEnd,
    projectId: run.project_id ?? undefined,
    event: {
      tipo: 'etapa',
      projeto: run.project,
      projeto_id: run.project_id,
      item: run.number,
      etapa: STAGE_LABELS[run.stage as RunStage],
      estado: succeeded ? 'terminou' : 'falhou',
      ...(succeeded ? {} : { motivo: failureReason(run) }),
    },
  };
}

/** Lê o que entrou no banco desde o cursor, avança o cursor e devolve os eventos em ordem. */
export function pollEvents(db: DatabaseSync, cursor: EventCursor): StreamEvent[] {
  const entries: Entry[] = [];

  // Runs de etapa: início das novas e fim das que estavam abertas.
  for (const id of [...cursor.openRuns]) {
    const run = db.prepare(`${RUN_SELECT} WHERE r.id = ?`).get(id) as RunRow | undefined;
    if (run?.status === 'running') continue;
    cursor.openRuns.delete(id);
    if (run?.stage && run.project) entries.push(stageEnd(run));
  }
  const runs = db.prepare(`${RUN_SELECT} WHERE r.rowid > ? ORDER BY r.rowid`).all(cursor.runs) as unknown as RunRow[];
  for (const run of runs) {
    cursor.runs = run.rowid;
    if (!run.stage || !run.project) continue;
    entries.push({
      at: run.started_at,
      order: ORDER.stageStart,
      projectId: run.project_id ?? undefined,
      event: {
        tipo: 'etapa',
        projeto: run.project,
        projeto_id: run.project_id,
        item: run.number,
        etapa: STAGE_LABELS[run.stage],
        estado: 'iniciou',
      },
    });
    if (run.status === 'running') cursor.openRuns.add(run.id);
    else entries.push(stageEnd(run));
  }

  const tools = db
    .prepare(
      `SELECT t.rowid AS rowid, t.name, t.started_at, i.number, p.name AS project, p.id AS project_id
       FROM tool_calls t JOIN runs r ON r.id = t.run_id
       LEFT JOIN items i ON i.id = r.item_id LEFT JOIN projects p ON p.id = i.project_id
       WHERE t.rowid > ? ORDER BY t.rowid`,
    )
    .all(cursor.toolCalls) as {
    rowid: number;
    name: string;
    started_at: string;
    number: number | null;
    project: string | null;
    project_id: string | null;
  }[];
  for (const tool of tools) {
    cursor.toolCalls = tool.rowid;
    if (!tool.project) continue;
    entries.push({
      at: tool.started_at,
      order: ORDER.tool,
      event: { tipo: 'ferramenta', projeto: tool.project, projeto_id: tool.project_id, item: tool.number, nome: tool.name },
    });
  }

  // O gate `review` é o parecer da revisão: sai como `revisao`.
  const gates = db
    .prepare(
      `SELECT g.id, g.gate, g.passed, g.at, i.number, p.name AS project, p.id AS project_id
       FROM gate_results g JOIN items i ON i.id = g.item_id JOIN projects p ON p.id = i.project_id
       WHERE g.id > ? ORDER BY g.id`,
    )
    .all(cursor.gates) as { id: number; gate: string; passed: number; at: string; number: number; project: string; project_id: string }[];
  for (const gate of gates) {
    cursor.gates = gate.id;
    const where = { projeto: gate.project, projeto_id: gate.project_id, item: gate.number };
    const event =
      gate.gate === 'review'
        ? { tipo: 'revisao', ...where, resultado: gate.passed ? 'aprovada' : 'reprovada' }
        : { tipo: 'gate', ...where, gate: gate.gate, resultado: gate.passed ? 'verde' : 'vermelho' };
    entries.push({ at: gate.at, order: ORDER.gate, event });
  }

  // Transições; a inbox é recontada nos projetos que tiveram alguma.
  const transitions = db
    .prepare(
      `SELECT t.id, t.from_state, t.to_state, t.reason, t.at, i.number, p.name AS project, p.id AS project_id
       FROM item_transitions t JOIN items i ON i.id = t.item_id JOIN projects p ON p.id = i.project_id
       WHERE t.id > ? ORDER BY t.id`,
    )
    .all(cursor.transitions) as {
    id: number;
    from_state: string;
    to_state: string;
    reason: string | null;
    at: string;
    number: number;
    project: string;
    project_id: string;
  }[];
  const touched = new Map<string, { project: string; at: string }>();
  for (const row of transitions) {
    cursor.transitions = row.id;
    entries.push({
      at: row.at,
      order: ORDER.item,
      event: {
        tipo: 'item',
        projeto: row.project,
        projeto_id: row.project_id,
        item: row.number,
        de: row.from_state,
        para: row.to_state,
        motivo: row.reason,
      },
    });
    touched.set(row.project_id, { project: row.project, at: row.at });
  }
  for (const [projectId, { project, at }] of touched) {
    const pending = pendingItems(db, projectId).length;
    if (pending === (cursor.inbox.get(projectId) ?? 0)) continue;
    cursor.inbox.set(projectId, pending);
    entries.push({ at, order: ORDER.inbox, event: { tipo: 'inbox', projeto: project, projeto_id: projectId, pendencias: pending } });
  }

  const readings = db
    .prepare('SELECT id, observed_at, window, utilization, resets_at FROM rate_limits WHERE id > ? ORDER BY id')
    .all(cursor.rateLimits) as { id: number; observed_at: string; window: string; utilization: number; resets_at: string }[];
  for (const reading of readings) {
    cursor.rateLimits = reading.id;
    entries.push({
      at: reading.observed_at,
      order: ORDER.balance,
      event: { tipo: 'saldo', janela: WINDOW_LABELS[reading.window] ?? reading.window, uso: reading.utilization, reset: isoLocal(new Date(reading.resets_at)) },
    });
  }

  const queue = db
    .prepare(
      `SELECT q.id, q.at, q.kind, q.cause, q.detail, p.name AS project, p.id AS project_id
       FROM queue_events q JOIN projects p ON p.id = q.project_id WHERE q.id > ? ORDER BY q.id`,
    )
    .all(cursor.queue) as { id: number; at: string; kind: string; cause: string; detail: string; project: string; project_id: string }[];
  for (const row of queue) {
    cursor.queue = row.id;
    entries.push({
      at: row.at,
      order: row.kind === 'start' ? ORDER.queueStart : ORDER.queue,
      projectId: row.project_id,
      queue: { kind: row.kind, cause: row.cause, detail: row.detail, project: row.project },
    });
  }

  // Ordem estável: horário, depois a posição na etapa, depois a ordem de leitura.
  const sorted = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.at < b.entry.at ? -1 : a.entry.at > b.entry.at ? 1 : a.entry.order - b.entry.order || a.index - b.index))
    .map(({ entry }) => entry);

  const out: StreamEvent[] = [];
  const emit = (event: Record<string, unknown>) => out.push({ versao: EVENTS_VERSION, ...event } as StreamEvent);
  const setQueue = (projectId: string, project: string, state: QueueState) => {
    if (cursor.queueState.get(projectId) === state) return;
    cursor.queueState.set(projectId, state);
    emit({ tipo: 'fila', projeto: project, projeto_id: projectId, estado: state });
  };
  for (const entry of sorted) {
    if (entry.queue) {
      const { kind, cause, detail, project } = entry.queue;
      const projectId = entry.projectId as string;
      if (kind === 'start') setQueue(projectId, project, 'rodando');
      else if (kind === 'wait' || (kind === 'pause' && BALANCE_PAUSES.has(cause))) setQueue(projectId, project, 'pausada_por_saldo');
      // A fila que encerrou pausada por saldo continua `pausada_por_saldo` até o próximo `run`.
      else if (kind === 'stop' && !(detail === 'paused' && cursor.queueState.get(projectId) === 'pausada_por_saldo')) {
        setQueue(projectId, project, 'parada');
      }
      continue;
    }
    const event = entry.event as Record<string, unknown>;
    // A espera por saldo terminou quando a próxima etapa começa.
    if (event.tipo === 'etapa' && event.estado === 'iniciou' && entry.projectId) {
      if (cursor.queueState.get(entry.projectId) === 'pausada_por_saldo') setQueue(entry.projectId, event.projeto as string, 'rodando');
    }
    emit(event);
  }
  return out;
}

/** `mabel eventos --json`: NDJSON de todos os projetos até o processo ser encerrado. */
export async function eventsCommand(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args, options: eventsOptions }));
  } catch (error) {
    return fail('argumento_invalido', (error as Error).message, eventsUsage);
  }
  if (!values.json) {
    return fail('argumento_faltando', 'O fluxo de eventos só tem a saída em JSON por enquanto.', eventsUsage);
  }
  // Intervalo entre as leituras do banco; os testes encurtam.
  const interval = Number(process.env.MABEL_EVENTOS_INTERVALO_MS) || 1000;
  const db = openDb(dataDir());
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  // Cliente fechou a leitura: encerra sem erro.
  process.stdout.on('error', onSignal);
  try {
    const cursor = eventCursor(db);
    while (!stop.signal.aborted) {
      const events = pollEvents(db, cursor);
      if (events.length > 0) process.stdout.write(events.map((event) => `${JSON.stringify(event)}\n`).join(''));
      await systemClock.sleep(interval, stop.signal);
    }
    return 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    db.close();
  }
}
