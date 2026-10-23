import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { latestReadings, renderBalanceHeader } from './balance.ts';
import { renderBoardSummary } from './board.ts';
import { expiryWarnings } from './credentials.ts';
import { dataDir, openDb } from './db.ts';
import { summaryLine } from './exec.ts';
import { formatCost, formatWhen, truncate } from './format.ts';
import { boardItems, syncBacklog } from './items.ts';
import { ProjectError, resolveProject } from './project.ts';
import { type RunOutcome, type RunRequest, startRun } from './runner.ts';
import { paint, style } from './style.ts';

export const PROBE_PROMPT = 'Responda apenas: ok';

export function probeRequest(home: string): RunRequest {
  return { kind: 'probe', prompt: PROBE_PROMPT, cwd: home, model: 'haiku', maxTurns: 1, tools: [] };
}

/** Run mínima para obter uma leitura de saldo nova. Auditada como qualquer run. */
export async function runProbe(db: DatabaseSync, home: string): Promise<RunOutcome> {
  const handle = startRun(db, home, probeRequest(home));
  process.on('SIGINT', handle.interrupt);
  try {
    return await handle.done;
  } finally {
    process.off('SIGINT', handle.interrupt);
  }
}

export interface RecentRun {
  id: string;
  kind: string;
  status: string;
  model: string | null;
  model_requested: string | null;
  started_at: string;
  cost_usd: number | null;
  prompt: string;
}

export function recentRuns(db: DatabaseSync, limit: number): RecentRun[] {
  return db
    .prepare(
      `SELECT id, kind, status, model, model_requested, started_at, cost_usd, prompt
       FROM runs ORDER BY started_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as RecentRun[];
}

const STATUS_MARKS: Record<string, string> = {
  succeeded: '✓',
  failed: '✗',
  interrupted: '■',
  running: '▸',
};

/** Lista compacta de runs, uma por linha, com início no fuso local. */
export function renderRecentRuns(runs: RecentRun[]): string[] {
  if (runs.length === 0) return ['  nenhuma run registrada'];
  return runs.map((run) => {
    const when = formatWhen(run.started_at);
    const model = (run.model ?? run.model_requested ?? '?').padEnd(18);
    const cost = (run.cost_usd === null ? '' : formatCost(run.cost_usd)).padEnd(11);
    const prompt = truncate(run.prompt.replace(/\s+/g, ' '), 48);
    return `  ${STATUS_MARKS[run.status] ?? '?'} ${run.id.slice(0, 4)}  ${when}  ${run.kind.padEnd(5)}  ${model} ${cost} ${prompt}`;
  });
}

/** Resumo do quadro do projeto atual; vazio fora de um projeto Mabel. */
function projectSummary(db: DatabaseSync): string[] {
  let project;
  try {
    project = resolveProject(db);
  } catch (error) {
    if (error instanceof ProjectError) return [];
    throw error;
  }
  const { warnings } = syncBacklog(db, project);
  return [
    ...renderBoardSummary(project.name, boardItems(db, project)),
    ...warnings.map((warning) => style.dim(warning)),
  ];
}

export async function status(args: string[]): Promise<number> {
  let refresh: boolean;
  try {
    refresh = parseArgs({ args, options: { atualizar: { type: 'boolean' } } }).values.atualizar ?? false;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: mabel status [--atualizar]\n`);
    return 1;
  }

  const home = dataDir();
  let db: DatabaseSync;
  try {
    db = openDb(home);
  } catch (error) {
    process.stderr.write(`Não foi possível abrir o banco em ${home}: ${(error as Error).message}\n`);
    return 1;
  }

  let code = 0;
  try {
    if (refresh) {
      process.stdout.write(style.dim('Atualizando o saldo com uma chamada mínima (haiku)…\n'));
      const outcome = await runProbe(db, home);
      process.stdout.write(`${style.dim(summaryLine(outcome))}\n\n`);
      if (outcome.status !== 'succeeded') code = 1;
    }
    const lines = [...renderBalanceHeader(latestReadings(db), new Date(), paint), ''];
    const credentials = expiryWarnings(home);
    if (credentials.length > 0) lines.push(...credentials.map((warning) => paint.warn(warning)), '');
    const summary = projectSummary(db);
    if (summary.length > 0) lines.push(...summary, '');
    lines.push(
      style.bold('Runs recentes'),
      ...renderRecentRuns(recentRuns(db, 5)),
    );
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    db.close();
  }
  return code;
}
