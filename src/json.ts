import type { DatabaseSync } from 'node:sqlite';
import { type BalanceReading, type BalanceWindow, BALANCE_WINDOWS, type PaceState, isExpired, paceOf } from './balance.ts';
import { lockHolder } from './lock.ts';

/**
 * Saídas para outros programas (`docs/specs/integracao-externa.md`). Campo novo não muda a
 * versão; remover um campo ou mudar o sentido dele muda.
 */
export const JSON_VERSION = 1;

/** Uma linha de JSON, com `versao` no topo. */
export function writeJson(data: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ versao: JSON_VERSION, ...data })}\n`);
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO 8601 no fuso local, com o deslocamento: `2026-10-23T16:40:00-03:00`. */
export function isoLocal(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offset);
  return `${local}${offset >= 0 ? '+' : '-'}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

// Saldo ----------------------------------------------------------------------------------

export const WINDOW_KEYS: Record<BalanceWindow, string> = { five_hour: '5h', seven_day: '7d' };

const PACE_VALUES: Record<PaceState, string> = { ahead: 'acima_do_ritmo', on: 'no_ritmo', behind: 'com_folga' };

const CAUSE_VALUES: Record<string, string> = {
  five_hour: 'saldo_5h',
  seven_day: 'saldo_7d',
  pace: 'ritmo_7d',
  no_reading: 'sem_leitura',
  usage_limit: 'saldo_esgotado',
  integration: 'integracao',
  context: 'contexto',
  code: 'mabel_atualizado',
};

/** Causas de pausa que vêm da política de saldo. */
const BALANCE_CAUSES = new Set(['five_hour', 'seven_day', 'pace', 'no_reading', 'usage_limit']);

/** Pausa ou espera da fila que ainda vale. */
export interface QueuePause {
  tipo: 'pausa' | 'espera';
  causa: string;
  motivo: string;
  desde: string;
  ate: string | null;
  /** A pausa vem da política de saldo. */
  saldo: boolean;
}

/**
 * Pausa em vigor no projeto: a última `pause` ou `wait` do `queue_events`, se nenhum `start`
 * veio depois. A espera vale enquanto o `run` que a gravou segura a trava e o prazo não
 * passou; a pausa vale até a fila voltar a rodar (como no `mabel eventos`). Projetos com
 * pausas de antes do `start` contam também a trava ativa e as runs de item depois dela.
 */
export function queuePause(db: DatabaseSync, home: string, projectId: string, now: Date): QueuePause | null {
  const row = db
    .prepare(
      `SELECT at, kind, cause, detail, until FROM queue_events
       WHERE project_id = ? AND kind IN ('pause', 'wait', 'start') ORDER BY id DESC LIMIT 1`,
    )
    .get(projectId) as { at: string; kind: 'pause' | 'wait' | 'start'; cause: string; detail: string; until: string | null } | undefined;
  if (!row || row.kind === 'start') return null;
  const running = lockHolder(home, projectId) !== undefined;
  if (row.kind === 'wait') {
    if (!running || (row.until !== null && new Date(row.until).getTime() <= now.getTime())) return null;
  } else {
    if (running) return null;
    const after = db
      .prepare('SELECT 1 FROM runs r JOIN items i ON i.id = r.item_id WHERE i.project_id = ? AND r.started_at > ? LIMIT 1')
      .get(projectId, row.at);
    if (after) return null;
  }
  return {
    tipo: row.kind === 'pause' ? 'pausa' : 'espera',
    causa: CAUSE_VALUES[row.cause] ?? row.cause,
    motivo: row.detail,
    desde: isoLocal(new Date(row.at)),
    ate: row.until === null ? null : isoLocal(new Date(row.until)),
    saldo: BALANCE_CAUSES.has(row.cause),
  };
}

/** A pausa por saldo mais recente entre os projetos, com o projeto. */
export function balancePause(db: DatabaseSync, home: string, now: Date): (QueuePause & { projeto: string }) | null {
  const projects = db.prepare('SELECT id, name FROM projects').all() as { id: string; name: string }[];
  const pauses = projects.flatMap((project) => {
    const pause = queuePause(db, home, project.id, now);
    return pause?.saldo ? [{ ...pause, projeto: project.name }] : [];
  });
  return pauses.sort((a, b) => (a.desde < b.desde ? 1 : -1))[0] ?? null;
}

/** As duas janelas, cada uma nula sem leitura. O ritmo só existe na de 7 dias. */
export function balanceWindowsJson(readings: BalanceReading[], now: Date): Record<string, unknown> {
  const byWindow = new Map(readings.map((reading) => [reading.window, reading]));
  return Object.fromEntries(
    BALANCE_WINDOWS.map((window) => {
      const reading = byWindow.get(window);
      if (!reading) return [WINDOW_KEYS[window], null];
      const json: Record<string, unknown> = {
        uso: reading.utilization,
        reset: isoLocal(reading.resetsAt),
        idade_leitura_s: Math.max(0, Math.round((now.getTime() - reading.observedAt.getTime()) / 1000)),
        vencida: isExpired(reading, now),
      };
      if (window === 'seven_day') {
        const pace = paceOf(reading, now);
        json.ritmo = { esperado: pace.expected, estado: PACE_VALUES[pace.state] };
      }
      return [WINDOW_KEYS[window], json];
    }),
  );
}

export function balanceJson(db: DatabaseSync, home: string, readings: BalanceReading[], now: Date): Record<string, unknown> {
  const pause = balancePause(db, home, now);
  return { janelas: balanceWindowsJson(readings, now), pausa: pause ? withoutFlag(pause) : null };
}

function withoutFlag<T extends { saldo: boolean }>(pause: T): Omit<T, 'saldo'> {
  const { saldo: _saldo, ...rest } = pause;
  return rest;
}

// Fila -----------------------------------------------------------------------------------

export type QueueState = 'parada' | 'rodando' | 'pausada_por_saldo' | 'aguardando_humano';

export const STAGE_VALUES: Record<string, string> = { refine: 'refinar', plan: 'planejar', execute: 'executar', review: 'revisar', birth: 'nascer' };

const ROLES: Record<string, string> = { refine: 'refinador', plan: 'planejador', execute: 'executor', review: 'revisor' };

/** Etapa do item quando nenhuma run está aberta (a verificação roda sem agente). */
const STATUS_STAGES: Record<string, string> = {
  planning: 'planejar',
  executing: 'executar',
  verifying: 'verificar',
  reviewing: 'revisar',
};

export interface StageInProgress {
  item: number;
  titulo: string;
  etapa: string;
  papel: string | null;
  modelo: string | null;
  run: string | null;
  inicio: string | null;
}

/** Runs de etapa abertas no projeto, da mais antiga para a mais nova. */
export function runningStages(db: DatabaseSync, projectId: string): StageInProgress[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.stage, r.kind, coalesce(r.model, r.model_requested) AS model, r.started_at, i.number, i.title
       FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.project_id = ? AND r.status = 'running' ORDER BY r.started_at`,
    )
    .all(projectId) as { id: string; stage: string | null; kind: string; model: string | null; started_at: string; number: number; title: string }[];
  return rows.map((row) => {
    const stage = row.stage ?? row.kind;
    return {
      item: row.number,
      titulo: row.title,
      etapa: STAGE_VALUES[stage] ?? stage,
      papel: ROLES[stage] ?? null,
      modelo: row.model,
      run: row.id,
      inicio: isoLocal(new Date(row.started_at)),
    };
  });
}

/**
 * Item e etapa em andamento numa fila que roda: a run aberta, ou o item mais recente num
 * estado de trabalho (a verificação, por exemplo, não tem run).
 */
export function stageInProgress(db: DatabaseSync, projectId: string): StageInProgress | null {
  const running = runningStages(db, projectId);
  if (running.length > 0) return running[running.length - 1] as StageInProgress;
  const row = db
    .prepare(
      `SELECT number, title, status FROM items WHERE project_id = ?
       AND status IN ('planning', 'executing', 'verifying', 'reviewing') ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(projectId) as { number: number; title: string; status: string } | undefined;
  if (!row) return null;
  return { item: row.number, titulo: row.title, etapa: STATUS_STAGES[row.status] as string, papel: null, modelo: null, run: null, inicio: null };
}

/** Etapas em que o item está numa tentativa de execução. */
const ATTEMPT_STAGES = new Set(['executar', 'verificar', 'revisar']);

export interface AttemptInProgress {
  /** Tentativa atual no ciclo, a partir de 1; nula fora de executar, verificar e revisar. */
  tentativa: number | null;
  /** Revisões reprovadas desde o último plano aprovado. */
  reprovacoes: number;
  ultima_revisao: { resultado: 'aprovada' | 'reprovada'; em: string } | null;
}

/**
 * Tentativa e revisões do item em andamento (`projetos --json`). Na execução, `attempts`
 * ainda conta as tentativas encerradas; na verificação e na revisão, já inclui a atual. As
 * revisões contam desde o último gate de início aprovado, que abre o plano em vigor.
 */
export function attemptInProgress(db: DatabaseSync, projectId: string, stage: StageInProgress): AttemptInProgress {
  const item = db
    .prepare('SELECT id, attempts FROM items WHERE project_id = ? AND number = ?')
    .get(projectId, stage.item) as { id: string; attempts: number } | undefined;
  if (!item) return { tentativa: null, reprovacoes: 0, ultima_revisao: null };
  const tentativa = ATTEMPT_STAGES.has(stage.etapa) ? (stage.etapa === 'executar' ? item.attempts + 1 : Math.max(item.attempts, 1)) : null;
  const since = db
    .prepare("SELECT coalesce(max(id), 0) AS id FROM gate_results WHERE item_id = ? AND gate = 'start' AND passed = 1")
    .get(item.id) as { id: number };
  const reviews = db
    .prepare("SELECT passed, at FROM gate_results WHERE item_id = ? AND gate = 'review' AND id > ? ORDER BY id")
    .all(item.id, since.id) as { passed: number; at: string }[];
  const last = reviews[reviews.length - 1];
  return {
    tentativa,
    reprovacoes: reviews.filter((review) => !review.passed).length,
    ultima_revisao: last ? { resultado: last.passed ? 'aprovada' : 'reprovada', em: isoLocal(new Date(last.at)) } : null,
  };
}

export function inboxCount(db: DatabaseSync, projectId: string): number {
  const row = db
    .prepare("SELECT count(*) AS count FROM items WHERE project_id = ? AND status = 'needs_human' AND pending_kind IS NOT NULL")
    .get(projectId) as { count: number };
  return row.count;
}

/**
 * Estado da fila do projeto. Pausa por saldo em vigor vence; depois, a trava de um `run`
 * vivo; parada com pendências na inbox é `aguardando_humano`.
 */
export function queueState(db: DatabaseSync, home: string, projectId: string, now: Date): { fila: QueueState; pausa: Omit<QueuePause, 'saldo'> | null } {
  const pause = queuePause(db, home, projectId, now);
  const pausa = pause ? withoutFlag(pause) : null;
  if (pause?.saldo) return { fila: 'pausada_por_saldo', pausa };
  if (lockHolder(home, projectId) !== undefined) return { fila: 'rodando', pausa };
  return { fila: inboxCount(db, projectId) > 0 ? 'aguardando_humano' : 'parada', pausa };
}
