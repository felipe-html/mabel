import type { DatabaseSync } from 'node:sqlite';

export type BalanceWindow = 'five_hour' | 'seven_day';

export const BALANCE_WINDOWS: BalanceWindow[] = ['five_hour', 'seven_day'];

/** Limiar da política de saldo do contrato: abaixo dele, a fila pergunta antes de seguir. */
export const BALANCE_THRESHOLD = 0.3;

export interface BalanceReading {
  window: string;
  utilization: number;
  resetsAt: Date;
  observedAt: Date;
}

export type BalanceDecision =
  | { action: 'proceed' }
  | { action: 'ask'; window: BalanceWindow; balance: number }
  | { action: 'refresh'; reason: 'missing' | 'expired' };

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

export function balanceOf(reading: BalanceReading): number {
  return Math.min(1, Math.max(0, 1 - reading.utilization));
}

export function isExpired(reading: BalanceReading, now: Date): boolean {
  return reading.resetsAt.getTime() <= now.getTime();
}

/** Política de saldo, aplicada antes de cada etapa com agente. */
export function checkBalance(readings: BalanceReading[], now: Date): BalanceDecision {
  const byWindow = new Map(readings.map((reading) => [reading.window, reading]));
  const current = BALANCE_WINDOWS.map((window) => byWindow.get(window));
  if (current.some((reading) => reading === undefined)) return { action: 'refresh', reason: 'missing' };
  const [fiveHour, sevenDay] = current as [BalanceReading, BalanceReading];
  if (isExpired(fiveHour, now) || isExpired(sevenDay, now)) return { action: 'refresh', reason: 'expired' };
  // Com as duas abaixo do limiar, vale a de 7 dias: é a que não se resolve esperando 5 horas.
  if (balanceOf(sevenDay) < BALANCE_THRESHOLD) {
    return { action: 'ask', window: 'seven_day', balance: balanceOf(sevenDay) };
  }
  if (balanceOf(fiveHour) < BALANCE_THRESHOLD) {
    return { action: 'ask', window: 'five_hour', balance: balanceOf(fiveHour) };
  }
  return { action: 'proceed' };
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

/** Cabeçalho de saldo: uma linha por janela, com barra, percentual livre, reset e idade da leitura. */
export function renderBalanceHeader(readings: BalanceReading[], now: Date, paint: Paint = plainPaint): string[] {
  const byWindow = new Map(readings.map((reading) => [reading.window, reading]));
  if (BALANCE_WINDOWS.every((window) => !byWindow.has(window))) {
    return [paint.dim(' saldo desconhecido · mabel status --atualizar')];
  }

  const lines = BALANCE_WINDOWS.map((window) => {
    const label = ` ${LABELS[window]}  `;
    const reading = byWindow.get(window);
    if (!reading) return `${label}${paint.dim('sem leitura · mabel status --atualizar')}`;

    const balance = balanceOf(reading);
    const filled = Math.round(balance * 10);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
    const percent = `${Math.round(balance * 100)}% livre`;
    const reset = `reset ${formatReset(reading.resetsAt, now)}`;
    if (isExpired(reading, now)) return paint.dim(`${label}${bar}  ${percent} · ${reset} (vencida)`);
    const color = balance >= 0.5 ? paint.good : balance >= BALANCE_THRESHOLD ? paint.warn : paint.bad;
    return `${label}${color(`${bar}  ${percent}`)} · ${reset}`;
  });

  const newest = Math.max(...readings.map((reading) => reading.observedAt.getTime()));
  const last = lines.length - 1;
  lines[last] = `${lines[last]}        ${paint.dim(formatAge(new Date(newest), now))}`;
  return lines;
}
