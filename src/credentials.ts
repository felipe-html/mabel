import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dataDir } from './db.ts';
import { paint } from './style.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';

/**
 * Validade das credenciais que o Mabel usa fora das runs (`FIGMA_TOKEN`). O Mabel não guarda
 * o token, só a data de vencimento informada pelo humano, em `~/.mabel/credenciais.json`.
 */

export const credentialUsage = ['mabel credenciar', 'mabel credenciar figma --expira <AAAA-MM-DD>'].join('\n       ');

export const credentialOptions = {
  expira: { type: 'string', value: '<AAAA-MM-DD>', description: 'Data em que o token vence; o Mabel avisa antes' },
} satisfies OptionSpecs;

export const credentialArgs: ArgSpec[] = [
  { name: '<credencial>', description: 'Qual token; sem ela, mostra a validade de todos', values: 'credencial' },
];

export const CREDENTIALS_FILE = 'credenciais.json';

/** Avisa quando faltam até estes dias para vencer. */
export const WARN_DAYS = 14;

export const CREDENTIALS: Record<string, { env: string; renew: string }> = {
  figma: { env: 'FIGMA_TOKEN', renew: 'Figma › Settings › Security › Personal access tokens' },
};

interface Stored {
  expira: string;
  registradoEm: string;
}

function path(home: string): string {
  return join(home, CREDENTIALS_FILE);
}

export function readCredentials(home: string): Record<string, Stored> {
  if (!existsSync(path(home))) return {};
  try {
    return JSON.parse(readFileSync(path(home), 'utf8')) as Record<string, Stored>;
  } catch {
    return {};
  }
}

export function setExpiry(home: string, name: string, expira: string, now = new Date()): void {
  const all = readCredentials(home);
  all[name] = { expira, registradoEm: now.toISOString() };
  mkdirSync(home, { recursive: true });
  writeFileSync(path(home), `${JSON.stringify(all, null, 2)}\n`);
}

/** Data `AAAA-MM-DD` válida no calendário. */
export function isDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text;
}

/** Dias de calendário (no fuso local) de hoje até a data: 0 vence hoje, negativo já venceu. */
export function daysUntil(expira: string, now = new Date()): number {
  const [year, month, day] = expira.split('-').map(Number) as [number, number, number];
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(year, month - 1, day) - today) / 86_400_000);
}

export function formatDate(expira: string): string {
  const [year, month, day] = expira.split('-');
  return `${day}/${month}/${year}`;
}

/** Aviso de vencimento próximo ou passado, ou `null` (sem data registrada ou longe do fim). */
export function expiryWarning(home: string, name: string, now = new Date()): string | null {
  const stored = readCredentials(home)[name];
  const known = CREDENTIALS[name];
  if (!stored || !known) return null;
  const days = daysUntil(stored.expira, now);
  if (days > WARN_DAYS) return null;
  const renew = `crie outro em ${known.renew}, troque o ${known.env} e rode \`mabel credenciar ${name} --expira <data>\``;
  if (days < 0) return `${known.env} venceu em ${formatDate(stored.expira)}: ${renew}.`;
  const when = days === 0 ? 'vence hoje' : days === 1 ? 'vence amanhã' : `vence em ${days} dias`;
  return `${known.env} ${when} (${formatDate(stored.expira)}): ${renew}.`;
}

/** Avisos de todas as credenciais registradas, para o `status`. */
export function expiryWarnings(home: string, now = new Date()): string[] {
  return Object.keys(CREDENTIALS).flatMap((name) => expiryWarning(home, name, now) ?? []);
}

export function expired(home: string, name: string, now = new Date()): boolean {
  const stored = readCredentials(home)[name];
  return stored !== undefined && daysUntil(stored.expira, now) < 0;
}

export function renderCredentials(home: string, env: NodeJS.ProcessEnv, now = new Date()): string[] {
  const stored = readCredentials(home);
  return Object.entries(CREDENTIALS).map(([name, { env: variable }]) => {
    const defined = env[variable] ? `${variable} definido` : `${variable} ausente`;
    const entry = stored[name];
    if (!entry) return `${name} · ${defined} · validade não registrada (mabel credenciar ${name} --expira <AAAA-MM-DD>)`;
    const days = daysUntil(entry.expira, now);
    const left = days < 0 ? paint.bad('vencido') : days <= WARN_DAYS ? paint.warn(`${days} dias`) : `${days} dias`;
    return `${name} · ${defined} · vence em ${formatDate(entry.expira)} (${left})`;
  });
}

export function credentialCommand(args: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: credentialOptions });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${credentialUsage}\n`);
    return 1;
  }
  const [name, ...extra] = parsed.positionals;
  const { expira } = parsed.values;
  const home = dataDir();
  if (name === undefined) {
    if (expira !== undefined) {
      process.stderr.write(`Informe a credencial.\nUso: ${credentialUsage}\n`);
      return 1;
    }
    process.stdout.write(`${renderCredentials(home, process.env).join('\n')}\n`);
    return 0;
  }
  if (!(name in CREDENTIALS) || extra.length > 0 || expira === undefined) {
    process.stderr.write(`Uso: ${credentialUsage}\n`);
    return 1;
  }
  if (!isDate(expira)) {
    process.stderr.write(`"${expira}" não é uma data AAAA-MM-DD.\n`);
    return 1;
  }
  setExpiry(home, name, expira);
  const lines = [`Validade de ${name} registrada: ${formatDate(expira)} (${daysUntil(expira)} dias).`];
  const warning = expiryWarning(home, name);
  if (warning) lines.push(paint.warn(warning));
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}
