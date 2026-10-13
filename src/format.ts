/** Formatação de números e durações para o usuário, em pt-BR. */

function decimal(value: number, digits: number): string {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${decimal(ms / 1000, ms < 10_000 ? 1 : 0)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** Custo em dólares; valores abaixo de um centavo mostram quatro casas para não virar zero. */
export function formatCost(usd: number): string {
  return `US$ ${decimal(usd, usd > 0 && usd < 0.01 ? 4 : 2)}`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${decimal(count / 1000, 1)}k`;
  return `${decimal(count / 1_000_000, 1)}M`;
}

export function truncate(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** Data e hora no fuso local, `dd/mm hh:mm`. */
export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
