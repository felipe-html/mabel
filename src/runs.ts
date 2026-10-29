import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { interactive } from './ask.ts';
import { dataDir, openDb, runDir } from './db.ts';
import { formatCost, formatDuration, formatTokens, formatWhen, truncate } from './format.ts';
import { select } from './menu.ts';
import { displayPath, table } from './projects.ts';
import { toolTarget } from './stream.ts';
import { style } from './style.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';

export const runsUsage = 'mabel runs [--limite <n>] | mabel runs <id>';

export const runsOptions = {
  limite: { type: 'string', value: '<n>', description: 'Quantas runs listar (padrão 20)' },
} satisfies OptionSpecs;

export const runsArgs: ArgSpec[] = [{ name: '<id>', description: 'Run a detalhar (o começo do id basta); sem ele, a lista' }];

export class RunNotFoundError extends Error {}

export interface RunRow {
  id: string;
  kind: string;
  stage: string | null;
  item_number: number | null;
  item_title: string | null;
  project_name: string | null;
  status: string;
  error: string | null;
  exit_code: number | null;
  model: string | null;
  model_requested: string | null;
  session_id: string | null;
  claude_version: string | null;
  cwd: string;
  prompt: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  num_turns: number | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  transcript_path: string | null;
}

const SELECT_RUNS = `SELECT r.*, i.number AS item_number, i.title AS item_title, p.name AS project_name
  FROM runs r LEFT JOIN items i ON i.id = r.item_id LEFT JOIN projects p ON p.id = i.project_id`;

export function listRuns(db: DatabaseSync, limit: number): RunRow[] {
  return db.prepare(`${SELECT_RUNS} ORDER BY r.started_at DESC LIMIT ?`).all(limit) as unknown as RunRow[];
}

/** Run pelo id ou por um prefixo único dele; prefixo ambíguo lista as candidatas. */
export function findRun(db: DatabaseSync, query: string): RunRow {
  const matches = db
    .prepare(`${SELECT_RUNS} WHERE r.id = ? OR substr(r.id, 1, ?) = ? ORDER BY r.started_at DESC`)
    .all(query, query.length, query) as unknown as RunRow[];
  const exact = matches.find((run) => run.id === query);
  if (exact) return exact;
  if (matches.length === 1) return matches[0] as RunRow;
  if (matches.length === 0) throw new RunNotFoundError(`Run não encontrada: ${query}. Veja a lista com \`mabel runs\`.`);
  throw new RunNotFoundError(
    [
      `O prefixo ${query} é ambíguo. Candidatas:`,
      ...matches.map((run) => `  ${run.id}  ${formatWhen(run.started_at)}  ${runKind(run)}`),
    ].join('\n'),
  );
}

/** `exec`, `probe` ou `plan #3`: a etapa e o item, nas runs de etapa. */
function runKind(run: RunRow): string {
  if (run.kind !== 'stage') return run.kind;
  return `${run.stage ?? 'stage'}${run.item_number === null ? '' : ` #${run.item_number}`}`;
}

const modelOf = (run: RunRow) => run.model ?? run.model_requested ?? '?';
const oneLine = (text: string, width: number) => truncate(text.replace(/\s+/g, ' ').trim(), width);
const optional = (value: number | null, format: (n: number) => string) => (value === null ? '' : format(value));

export function renderRunList(runs: RunRow[]): string[] {
  if (runs.length === 0) return ['Nenhuma run registrada.'];
  const total = runs.reduce((sum, run) => sum + (run.cost_usd ?? 0), 0);
  return [
    ...table(
      ['id', 'início', 'status', 'tipo', 'modelo', 'turnos', 'duração', 'custo', 'prompt'],
      runs.map((run) => [
        run.id.slice(0, 8),
        formatWhen(run.started_at),
        run.status,
        runKind(run),
        modelOf(run),
        optional(run.num_turns, String),
        optional(run.duration_ms, formatDuration),
        optional(run.cost_usd, formatCost),
        oneLine(run.prompt, 40),
      ]),
    ),
    '',
    `${runs.length === 1 ? '1 run' : `${runs.length} runs`} · ${formatCost(total)}`,
  ];
}

interface ToolCallRow {
  name: string;
  input: string;
  started_at: string;
  ended_at: string | null;
  is_error: number | null;
}

/** Posição de uma run do `exec` na conversa (` · mensagem 2 de 3`); vazio fora de conversa. */
function sessionPosition(db: DatabaseSync, run: RunRow): string {
  if (run.kind !== 'exec' || !run.session_id) return '';
  const ids = db
    .prepare("SELECT id FROM runs WHERE kind = 'exec' AND session_id = ? ORDER BY started_at, rowid")
    .all(run.session_id)
    .map((row) => row.id);
  if (ids.length < 2) return '';
  return ` · mensagem ${ids.indexOf(run.id) + 1} de ${ids.length}`;
}

/** Resumo da run, linha do tempo das ferramentas e caminhos dos arquivos brutos. */
export function renderRunDetail(db: DatabaseSync, home: string, run: RunRow): string[] {
  const field = (label: string, value: string) => `  ${label.padEnd(11)}${value}`;
  const lines = [style.bold(`Run ${run.id}`)];

  let kind = runKind(run);
  if (run.item_title !== null) kind += ` · ${oneLine(run.item_title, 60)}${run.project_name ? ` (${run.project_name})` : ''}`;
  lines.push(field('tipo', kind));
  const failure = [run.error, run.exit_code !== null && run.exit_code !== 0 ? `código ${run.exit_code}` : null].filter(Boolean);
  lines.push(field('status', `${run.status}${failure.length > 0 ? ` · ${failure.join(' · ')}` : ''}`));
  const requested = run.model_requested && run.model_requested !== run.model ? ` (pedido: ${run.model_requested})` : '';
  lines.push(field('modelo', `${modelOf(run)}${requested}`));
  if (run.session_id) lines.push(field('sessão', `${run.session_id}${sessionPosition(db, run)}`));
  if (run.claude_version) lines.push(field('claude', run.claude_version));
  const timing = [`início ${formatWhen(run.started_at)}`];
  if (run.ended_at) timing.push(`fim ${formatWhen(run.ended_at)}`);
  if (run.duration_ms !== null) timing.push(formatDuration(run.duration_ms));
  lines.push(field('tempo', timing.join(' · ')));
  const totals = [
    run.num_turns === null ? null : `${run.num_turns} ${run.num_turns === 1 ? 'turno' : 'turnos'}`,
    run.cost_usd === null ? null : formatCost(run.cost_usd),
  ].filter(Boolean);
  if (totals.length > 0) lines.push(field('custo', totals.join(' · ')));
  if (run.input_tokens !== null || run.output_tokens !== null) {
    const cache = (run.cache_read_tokens ?? 0) + (run.cache_creation_tokens ?? 0);
    lines.push(
      field(
        'tokens',
        `entrada ${formatTokens(run.input_tokens ?? 0)} · saída ${formatTokens(run.output_tokens ?? 0)} · cache ${formatTokens(cache)}`,
      ),
    );
  }
  lines.push(field('diretório', displayPath(run.cwd)));
  lines.push(field('prompt', oneLine(run.prompt, 100)));

  const calls = db
    .prepare('SELECT name, input, started_at, ended_at, is_error FROM tool_calls WHERE run_id = ? ORDER BY started_at, rowid')
    .all(run.id) as unknown as ToolCallRow[];
  lines.push('', style.bold(`Ferramentas (${calls.length})`));
  if (calls.length === 0) lines.push('  nenhuma chamada');
  const start = new Date(run.started_at).getTime();
  for (const call of calls) {
    let input: unknown;
    try {
      input = JSON.parse(call.input);
    } catch {
      input = undefined;
    }
    const at = `+${formatDuration(Math.max(0, new Date(call.started_at).getTime() - start))}`;
    const took = call.ended_at ? formatDuration(new Date(call.ended_at).getTime() - new Date(call.started_at).getTime()) : 'sem fim';
    const target = oneLine(toolTarget(input), 70);
    const error = call.is_error ? ' · erro' : '';
    lines.push(`  ${at.padStart(8)}  ${call.name.padEnd(10)} ${target ? `${target} · ` : ''}${took}${error}`);
  }

  lines.push(
    '',
    style.bold('Arquivos'),
    field('stream', join(runDir(home, run.id), 'stream.jsonl')),
    field('transcript', run.transcript_path ?? 'não copiado'),
  );
  return lines;
}

/** Menu de runs no terminal; a escolhida mostra o detalhe. */
async function chooseAndShow(db: DatabaseSync, home: string, runs: RunRow[]): Promise<number> {
  const chosen = await select(
    runs.map((run) => ({
      label: `${run.id.slice(0, 8)}  ${formatWhen(run.started_at)}  ${runKind(run)}`,
      hint: style.dim(
        `${run.status} · ${modelOf(run)} · ${optional(run.cost_usd, formatCost) || 'sem custo'} · ${oneLine(run.prompt, 40)}`,
      ),
    })),
    style,
  );
  if (chosen === null) return 0;
  process.stdout.write(`\n${renderRunDetail(db, home, runs[chosen] as RunRow).join('\n')}\n`);
  return 0;
}

export async function runsCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: runsOptions });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${runsUsage}\n`);
    return 1;
  }
  const limit = Number(parsed.values.limite ?? 20);
  if (!Number.isInteger(limit) || limit < 1) {
    process.stderr.write(`--limite precisa ser um inteiro positivo.\nUso: ${runsUsage}\n`);
    return 1;
  }
  const [query] = parsed.positionals;

  const home = dataDir();
  const db = openDb(home);
  try {
    if (query) {
      process.stdout.write(`${renderRunDetail(db, home, findRun(db, query)).join('\n')}\n`);
      return 0;
    }
    const runs = listRuns(db, limit);
    if (runs.length > 0 && interactive()) {
      process.stdout.write(`${renderRunList(runs).at(-1)}\n`);
      return await chooseAndShow(db, home, runs);
    }
    process.stdout.write(`${renderRunList(runs).join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RunNotFoundError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}
