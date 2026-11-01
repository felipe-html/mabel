import type { DatabaseSync } from 'node:sqlite';

export type BalanceWindow = 'five_hour' | 'seven_day';

export const BALANCE_WINDOWS: BalanceWindow[] = ['five_hour', 'seven_day'];

/** Limiar da política de saldo sem estimativa da etapa: abaixo dele, a fila pergunta antes de seguir. */
export const BALANCE_THRESHOLD = 0.3;

/** Piso do saldo projetado depois da etapa, quando há estimativa de consumo. */
export const BALANCE_FLOOR = 0.1;

/** Leitura mais velha que isso é antiga: a política pede uma nova antes da etapa. */
export const STALE_AFTER_MS = 30 * 60_000;

/** Folga, em pontos de utilização, entre o uso da janela de 7 dias e o ritmo esperado. */
export const PACE_MARGIN = 0.1;

/** Amostras mínimas e máximas de consumo de uma etapa para estimar a próxima. */
export const MIN_SAMPLES = 3;
export const SAMPLE_LIMIT = 10;

const WINDOW_MS: Record<BalanceWindow, number> = { five_hour: 5 * 3600_000, seven_day: 7 * 86_400_000 };

export interface BalanceReading {
  window: string;
  utilization: number;
  resetsAt: Date;
  observedAt: Date;
}

/** Consumo estimado de uma etapa, em pontos de utilização, por janela. */
export type BalanceEstimate = Partial<Record<BalanceWindow, number>>;

export type BalanceDecision =
  | { action: 'proceed' }
  | { action: 'ask'; window: BalanceWindow; balance: number; estimate?: number }
  | { action: 'pace'; used: number; expected: number; caughtUpAt: Date }
  | { action: 'refresh'; reason: 'missing' | 'expired' | 'stale' };

/** Leitura atual: a linha mais recente de `rate_limits` para cada janela. */
export function latestReadings(db: DatabaseSync): BalanceReading[] {
  const rows = db
    .prepare(
      `SELECT window, utilization, resets_at, observed_at FROM rate_limits AS r
       WHERE id = (SELECT id FROM rate_limits WHERE window = r.window ORDER BY observed_at DESC, id DESC LIMIT 1)
       ORDER BY window`,
    )
    .all() as { window: string; utilization: number; resets_at: string; observed_at: string }[];
  return rows.map((row) => ({
    window: row.window,
    utilization: row.utilization,
    resetsAt: new Date(row.resets_at),
    observedAt: new Date(row.observed_at),
  }));
}

/**
 * Consumo médio da etapa: última leitura da run menos a primeira, por janela, nas runs em
 * que as duas pertencem à mesma janela. Sem `MIN_SAMPLES` amostras, a janela fica de fora.
 */
export function stageEstimate(db: DatabaseSync, stage: string): BalanceEstimate {
  const rows = db
    .prepare(
      `SELECT r.window, r.run_id,
         (SELECT utilization FROM rate_limits WHERE run_id = r.run_id AND window = r.window ORDER BY id DESC LIMIT 1)
           - (SELECT utilization FROM rate_limits WHERE run_id = r.run_id AND window = r.window ORDER BY id LIMIT 1) AS used,
         (SELECT count(DISTINCT resets_at) FROM rate_limits WHERE run_id = r.run_id AND window = r.window) AS windows
       FROM rate_limits AS r JOIN runs ON runs.id = r.run_id
       WHERE runs.kind = 'stage' AND runs.stage = ? AND runs.status = 'succeeded'
       GROUP BY r.run_id, r.window
       ORDER BY runs.started_at DESC`,
    )
    .all(stage) as { window: string; used: number; windows: number }[];
  const estimate: BalanceEstimate = {};
  for (const window of BALANCE_WINDOWS) {
    const samples = rows
      .filter((row) => row.window === window && row.windows === 1)
      .slice(0, SAMPLE_LIMIT)
      .map((row) => Math.max(0, row.used));
    if (samples.length < MIN_SAMPLES) continue;
    estimate[window] = samples.reduce((sum, used) => sum + used, 0) / samples.length;
  }
  return estimate;
}

export function balanceOf(reading: BalanceReading): number {
  return Math.min(1, Math.max(0, 1 - reading.utilization));
}

export function isExpired(reading: BalanceReading, now: Date): boolean {
  return reading.resetsAt.getTime() <= now.getTime();
}

export function isStale(reading: BalanceReading, now: Date): boolean {
  return now.getTime() - reading.observedAt.getTime() > STALE_AFTER_MS;
}

export type PaceState = 'ahead' | 'on' | 'behind';

/** Ritmo da janela: o uso esperado é a fração já decorrida dela. */
export function paceOf(reading: BalanceReading, now: Date, extra = 0): { expected: number; state: PaceState } {
  const length = WINDOW_MS[reading.window as BalanceWindow] ?? WINDOW_MS.seven_day;
  const start = reading.resetsAt.getTime() - length;
  const expected = Math.min(1, Math.max(0, (now.getTime() - start) / length));
  const used = reading.utilization + extra;
  const state = used > expected + PACE_MARGIN ? 'ahead' : used < expected - PACE_MARGIN ? 'behind' : 'on';
  return { expected, state };
}

/** Momento em que o ritmo alcança `used`, com a margem: a partir dele a janela volta ao ritmo. */
function paceCatchUp(reading: BalanceReading, used: number): Date {
  const length = WINDOW_MS[reading.window as BalanceWindow] ?? WINDOW_MS.seven_day;
  const start = reading.resetsAt.getTime() - length;
  return new Date(Math.min(reading.resetsAt.getTime(), start + (used - PACE_MARGIN) * length));
}

/** A janela segue com a etapa? Com estimativa, o saldo depois dela não pode cair abaixo do piso. */
function belowFloor(reading: BalanceReading, estimate: number | undefined): boolean {
  if (estimate === undefined) return balanceOf(reading) < BALANCE_THRESHOLD;
  return balanceOf(reading) - estimate < BALANCE_FLOOR;
}

/** Política de saldo, aplicada antes de cada etapa com agente. */
export function checkBalance(readings: BalanceReading[], now: Date, estimate: BalanceEstimate = {}): BalanceDecision {
  const byWindow = new Map(readings.map((reading) => [reading.window, reading]));
  const current = BALANCE_WINDOWS.map((window) => byWindow.get(window));
  if (current.some((reading) => reading === undefined)) return { action: 'refresh', reason: 'missing' };
  const [fiveHour, sevenDay] = current as [BalanceReading, BalanceReading];
  if (isExpired(fiveHour, now) || isExpired(sevenDay, now)) return { action: 'refresh', reason: 'expired' };
  if (isStale(fiveHour, now) || isStale(sevenDay, now)) return { action: 'refresh', reason: 'stale' };
  // Com as duas abaixo do piso, vale a de 7 dias: é a que não se resolve esperando 5 horas.
  if (belowFloor(sevenDay, estimate.seven_day)) {
    return withEstimate({ action: 'ask', window: 'seven_day', balance: balanceOf(sevenDay) }, estimate.seven_day);
  }
  const used = sevenDay.utilization + (estimate.seven_day ?? 0);
  const pace = paceOf(sevenDay, now, estimate.seven_day);
  if (pace.state === 'ahead') {
    return { action: 'pace', used, expected: pace.expected, caughtUpAt: paceCatchUp(sevenDay, used) };
  }
  if (belowFloor(fiveHour, estimate.five_hour)) {
    return withEstimate({ action: 'ask', window: 'five_hour', balance: balanceOf(fiveHour) }, estimate.five_hour);
  }
  return { action: 'proceed' };
}

function withEstimate(
  decision: { action: 'ask'; window: BalanceWindow; balance: number },
  estimate: number | undefined,
): BalanceDecision {
  return estimate === undefined ? decision : { ...decision, estimate };
}

// Avisos de leitura nova: o runner avisa, o rodapé redesenha.
const listeners = new Set<() => void>();

export function onBalanceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function balanceChanged(): void {
  for (const listener of listeners) listener();
}

export interface Paint {
  good: (text: string) => string;
  warn: (text: string) => string;
  bad: (text: string) => string;
  dim: (text: string) => string;
}

export const plainPaint: Paint = { good: (t) => t, warn: (t) => t, bad: (t) => t, dim: (t) => t };

const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Horário de reset no fuso local: `hoje 16:40`, `amanhã 09:00`, `sex 09:00` ou `18/10 09:00`. */
export function formatReset(resetsAt: Date, now: Date): string {
  const time = `${two(resetsAt.getHours())}:${two(resetsAt.getMinutes())}`;
  const days = Math.round((startOfDay(resetsAt) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `hoje ${time}`;
  if (days === 1) return `amanhã ${time}`;
  if (days > 1 && days < 7) return `${WEEKDAYS[resetsAt.getDay()]} ${time}`;
  return `${two(resetsAt.getDate())}/${two(resetsAt.getMonth() + 1)} ${time}`;
}

export function formatAge(observedAt: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - observedAt.getTime()) / 60_000);
  if (minutes < 1) return 'leitura de agora';
  if (minutes < 60) return `leitura de ${minutes} min atrás`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `leitura de ${hours}h atrás`;
  const days = Math.floor(hours / 24);
  return `leitura de ${days} ${days === 1 ? 'dia' : 'dias'} atrás`;
}

const LABELS: Record<BalanceWindow, string> = { five_hour: '5h', seven_day: '7d' };

const PACE_LABELS: Record<PaceState, string> = { ahead: 'acima do ritmo', on: 'no ritmo', behind: 'com folga' };

function paceLabel(reading: BalanceReading, now: Date, paint: Paint): string {
  const { state } = paceOf(reading, now);
  const text = PACE_LABELS[state];
  return state === 'ahead' ? paint.warn(text) : paint.dim(text);
}

function colorFor(balance: number, paint: Paint): (text: string) => string {
  return balance >= 0.5 ? paint.good : balance >= BALANCE_THRESHOLD ? paint.warn : paint.bad;
}

/** Cabeçalho de saldo: uma linha por janela, com barra, percentual livre, reset e idade da leitura. */
export function renderBalanceHeader(readings: BalanceReading[], now: Date, paint: Paint = plainPaint): string[] {
  const byWindow = new Map(readings.map((reading) => [reading.window, reading]));
  if (BALANCE_WINDOWS.every((window) => !byWindow.has(window))) {
    return [paint.dim(' saldo desconhecido · mabel conferir --atualizar')];
  }

  const lines = BALANCE_WINDOWS.map((window) => {
    const label = ` ${LABELS[window]}  `;
    const reading = byWindow.get(window);
    if (!reading) return `${label}${paint.dim('sem leitura · mabel conferir --atualizar')}`;

    const balance = balanceOf(reading);
    const filled = Math.round(balance * 10);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
    const percent = `${Math.round(balance * 100)}% livre`;
    const reset = `reset ${formatReset(reading.resetsAt, now)}`;
    if (isExpired(reading, now)) return paint.dim(`${label}${bar}  ${percent} · ${reset} (vencida)`);
    const color = colorFor(balance, paint);
    const pace = window === 'seven_day' ? ` · ${paceLabel(reading, now, paint)}` : '';
    return `${label}${color(`${bar}  ${percent}`)} · ${reset}${pace}`;
  });

  const newest = Math.max(...readings.map((reading) => reading.observedAt.getTime()));
  const last = lines.length - 1;
  lines[last] = `${lines[last]}        ${paint.dim(formatAge(new Date(newest), now))}`;
  return lines;
}

const ANSI = /\x1b\[[0-9;]*m/g;

function visibleLength(text: string): number {
  return text.replace(ANSI, '').length;
}

/**
 * Linha do rodapé fixo: as duas janelas numa linha só. Quando não cabe em `width`, perde
 * primeiro a idade da leitura, depois os resets e por fim as barras.
 */
export function renderBalanceFooter(readings: BalanceReading[], now: Date, width: number, paint: Paint = plainPaint): string {
  const byWindow = new Map(readings.map((reading) => [reading.window, reading]));
  if (BALANCE_WINDOWS.every((window) => !byWindow.has(window))) {
    return paint.dim(' saldo desconhecido · mabel conferir --atualizar'.slice(0, width));
  }
  const newest = Math.max(...readings.map((reading) => reading.observedAt.getTime()));
  const age = paint.dim(formatAge(new Date(newest), now));

  const windowPart = (window: BalanceWindow, bars: boolean, resets: boolean): string => {
    const label = LABELS[window];
    const reading = byWindow.get(window);
    if (!reading) return `${label} ${paint.dim('?')}`;
    const balance = balanceOf(reading);
    const filled = Math.round(balance * 10);
    const bar = bars ? `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ` : '';
    const value = `${bar}${Math.round(balance * 100)}%`;
    const reset = resets ? ` · ${formatReset(reading.resetsAt, now)}` : '';
    const pace = window === 'seven_day' ? ` · ${paceLabel(reading, now, paint)}` : '';
    if (isExpired(reading, now)) return paint.dim(`${label} ${value}${reset} (vencida)`);
    return `${label} ${colorFor(balance, paint)(value)}${reset}${pace}`;
  };

  const separator = paint.dim(' │ ');
  const variants = [
    [true, true, true],
    [true, true, false],
    [true, false, false],
    [false, false, false],
  ] as const;
  for (const [bars, resets, withAge] of variants) {
    const parts = BALANCE_WINDOWS.map((window) => windowPart(window, bars, resets));
    if (withAge) parts.push(age);
    const line = ` ${parts.join(separator)}`;
    if (visibleLength(line) <= width) return line;
  }
  const short = BALANCE_WINDOWS.map((window) => {
    const reading = byWindow.get(window);
    return `${LABELS[window]} ${reading ? `${Math.round(balanceOf(reading) * 100)}%` : '?'}`;
  }).join(' ');
  return ` ${short}`.slice(0, width);
}
