import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { latestReadings, renderBalanceHeader } from './balance.ts';
import { renderBoardSummary } from './board.ts';
import { expiryWarnings } from './credentials.ts';
import { dataDir, openDb } from './db.ts';
import { fail } from './errors.ts';
import { summaryLine } from './exec.ts';
import { formatCost, formatWhen, truncate } from './format.ts';
import { boardItems, syncBacklog } from './items.ts';
import { balanceJson, balancePause, queueState, runningStages, writeJson } from './json.ts';
import { ProjectError, type Project, resolveProject } from './project.ts';
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

/** Projeto do diretório atual; indefinido fora de um projeto Mabel. */
function currentProject(db: DatabaseSync): Project | undefined {
  try {
    return resolveProject(db);
  } catch (error) {
    if (error instanceof ProjectError) return undefined;
    throw error;
  }
}

/** Resumo do quadro do projeto atual; vazio fora de um projeto Mabel. */
function projectSummary(db: DatabaseSync): string[] {
  const project = currentProject(db);
  if (!project) return [];
  const { warnings } = syncBacklog(db, project);
  return [
    ...renderBoardSummary(project.name, boardItems(db, project)),
    ...warnings.map((warning) => style.dim(warning)),
  ];
}

/** `mabel status --json`: a fila do projeto atual por estado, as etapas em andamento e o saldo. */
export function statusJson(db: DatabaseSync, home: string, now: Date): Record<string, unknown> {
  const saldo = balanceJson(db, home, latestReadings(db), now);
  const project = currentProject(db);
  if (!project) return { projeto: null, saldo };
  const { warnings } = syncBacklog(db, project);
  const items = boardItems(db, project);
  const byState: Record<string, number> = {};
  for (const item of items) byState[item.status] = (byState[item.status] ?? 0) + 1;
  const { fila, pausa } = queueState(db, home, project.id, now);
  return {
    projeto: { id: project.id, nome: project.name, raiz: project.root },
    fila,
    pausa,
    por_estado: byState,
    itens: items.map((item) => ({
      numero: item.number,
      titulo: item.title,
      estado: item.status,
      motivo: item.statusReason,
      tentativas: item.attempts,
      custo_usd: item.costUsd,
      dependencias_pendentes: item.pendingDeps,
      integrado: item.integrated ?? false,
    })),
    etapas: runningStages(db, project.id),
    saldo,
    avisos: warnings,
  };
}

export const statusUsage = 'mabel status [--atualizar] [--json]';
export const balanceUsage = 'mabel saldo [--atualizar] [--json]';

/** Abre o banco, atualiza o saldo se pedido e entrega o resto a `show`. */
async function withBalance(
  args: string[],
  usage: string,
  show: (db: DatabaseSync, home: string, json: boolean) => void,
): Promise<number> {
  let refresh: boolean;
  let json: boolean;
  try {
    const { values } = parseArgs({ args, options: { atualizar: { type: 'boolean' }, json: { type: 'boolean' } } });
    refresh = values.atualizar ?? false;
    json = values.json ?? false;
  } catch (error) {
    return fail('argumento_invalido', (error as Error).message, usage);
  }

  const home = dataDir();
  let db: DatabaseSync;
  try {
    db = openDb(home);
  } catch (error) {
    return fail('interno', `Não foi possível abrir o banco em ${home}: ${(error as Error).message}`);
  }

  let code = 0;
  try {
    if (refresh) {
      // Com --json, a saída é só a linha de JSON; o resumo da probe vai para o stderr.
      const out = json ? process.stderr : process.stdout;
      out.write(style.dim('Atualizando o saldo com uma chamada mínima (haiku)…\n'));
      const outcome = await runProbe(db, home);
      out.write(`${style.dim(summaryLine(outcome))}\n${json ? '' : '\n'}`);
      if (outcome.status !== 'succeeded') code = 1;
    }
    show(db, home, json);
  } finally {
    db.close();
  }
  return code;
}

export function balanceCommand(args: string[]): Promise<number> {
  return withBalance(args, balanceUsage, (db, home, json) => {
    const now = new Date();
    if (json) {
      writeJson(balanceJson(db, home, latestReadings(db), now));
      return;
    }
    const lines = renderBalanceHeader(latestReadings(db), now, paint);
    const pause = balancePause(db, home, now);
    if (pause) lines.push('', paint.warn(`${pause.tipo === 'pausa' ? 'Fila pausada' : 'Fila esperando'} (${pause.projeto}): ${pause.motivo}`));
    process.stdout.write(`${lines.join('\n')}\n`);
  });
}

export function status(args: string[]): Promise<number> {
  return withBalance(args, statusUsage, (db, home, json) => {
    if (json) {
      writeJson(statusJson(db, home, new Date()));
      return;
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
  });
}
