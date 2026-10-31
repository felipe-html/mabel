import { existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { interactive } from './ask.ts';
import { fillForm } from './guided.ts';
import { type FormConfig, shellLine } from './screens.ts';
import { dataDir, openDb, runDir } from './db.ts';
import { type DeliveryStatus, listDeliveries } from './delivery.ts';
import { fail } from './errors.ts';
import { formatCost, formatTokens, formatWhen, truncate } from './format.ts';
import { tryGit } from './git.ts';
import { ITEM_STATES } from './items.ts';
import { STAGE_VALUES, WINDOW_KEYS, attemptInProgress, inboxCount, isoLocal, queueState, stageInProgress, writeJson } from './json.ts';
import { LockError, acquireLock, lockHolder, lockPath } from './lock.ts';
import { select } from './menu.ts';
import { autonomousDecisions, escalate } from './pipeline.ts';
import { isAncestor } from './integration.ts';
import { DEFAULT_INTEGRATION, ProjectError, readConfig } from './project.ts';
import { type QueueEvent, type QueueEventCause, listQueueEvents } from './run.ts';
import { signals, signalsComparison } from './refine.ts';
import { queueLogPath, queueStatePath } from './supervisor.ts';
import { itemDir } from './stages.ts';
import { style } from './style.ts';
import { type ArgSpec, type OptionSpecs, itemArg, jsonOption } from './options.ts';

// Classificação para a remoção -----------------------------------------------------------

/** Runs que pertencem ao projeto: as dos seus itens. `exec` e probe ficam de fora. */
const PROJECT_RUNS = 'SELECT r.id FROM runs r JOIN items i ON i.id = r.item_id WHERE i.project_id = ?';
const PROJECT_ITEMS = 'SELECT id FROM items WHERE project_id = ?';

export type TableScope = { scope: 'project'; where: string } | { scope: 'global' };

/**
 * Toda tabela do banco, classificada para a remoção de projeto. As `project` são apagadas
 * nesta ordem (dependentes antes), com o `where` que encontra as linhas do projeto; o único
 * parâmetro é o id do projeto. Tabela nova numa migração precisa entrar aqui.
 */
export const tableScope: Record<string, TableScope> = {
  events: { scope: 'project', where: `run_id IN (${PROJECT_RUNS})` },
  tool_calls: { scope: 'project', where: `run_id IN (${PROJECT_RUNS})` },
  rate_limits: { scope: 'project', where: `run_id IN (${PROJECT_RUNS})` },
  gate_results: { scope: 'project', where: `item_id IN (${PROJECT_ITEMS})` },
  refinements: { scope: 'project', where: `item_id IN (${PROJECT_ITEMS})` },
  item_transitions: { scope: 'project', where: `item_id IN (${PROJECT_ITEMS})` },
  runs: { scope: 'project', where: `item_id IN (${PROJECT_ITEMS})` },
  items: { scope: 'project', where: 'project_id = ?' },
  queue_events: { scope: 'project', where: 'project_id = ?' },
  deliveries: { scope: 'project', where: 'project_id = ?' },
  births: { scope: 'project', where: 'project_id = ?' },
  specs: { scope: 'project', where: 'project_id = ?' },
  spec_proposals: { scope: 'project', where: 'project_id = ?' },
  integration_state: { scope: 'project', where: 'project_id = ?' },
  projects: { scope: 'project', where: 'id = ?' },
  removals: { scope: 'global' },
};

/** O que a remoção apaga em disco, a partir dos ids do projeto, dos itens e das runs. */
export interface RemovalTarget {
  projectId: string;
  itemIds: string[];
  runIds: string[];
}

export type DirScope = { scope: 'project'; paths: (home: string, target: RemovalTarget) => string[] } | { scope: 'global' };

/** Toda entrada da raiz de `~/.mabel`, classificada como as tabelas. */
export const dirScope: Record<string, DirScope> = {
  runs: { scope: 'project', paths: (home, t) => t.runIds.map((id) => runDir(home, id)) },
  items: { scope: 'project', paths: (home, t) => t.itemIds.map((id) => itemDir(home, id)) },
  worktrees: { scope: 'project', paths: (home, t) => [join(home, 'worktrees', t.projectId)] },
  locks: { scope: 'project', paths: (home, t) => [lockPath(home, t.projectId)] },
  entregas: { scope: 'project', paths: (home, t) => [join(home, 'entregas', t.projectId)] },
  filas: { scope: 'project', paths: (home, t) => [queueLogPath(home, t.projectId), queueStatePath(home, t.projectId)] },
  'mabel.db': { scope: 'global' },
  'mabel.db-wal': { scope: 'global' },
  'mabel.db-shm': { scope: 'global' },
  historico: { scope: 'global' },
  'supervisor.sock': { scope: 'global' },
  'supervisor.log': { scope: 'global' },
  'credenciais.json': { scope: 'global' },
};

/** Tabelas do banco que não estão em `tableScope`. */
export function unclassifiedTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((row) => row.name).filter((name) => !(name in tableScope));
}

/** Entradas da raiz de `~/.mabel` que não estão em `dirScope`. */
export function unclassifiedEntries(home: string): string[] {
  if (!existsSync(home)) return [];
  return readdirSync(home).filter((name) => !(name in dirScope)).sort();
}

// Consultas ------------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  root: string;
  runs: number;
  costUsd: number;
  lastActivity: string;
  /** Itens por estado, na ordem do ciclo de vida. */
  states: { status: string; count: number }[];
  items: number;
}

export function listProjects(db: DatabaseSync): ProjectRow[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.root,
         (SELECT count(*) FROM runs r JOIN items i ON i.id = r.item_id WHERE i.project_id = p.id) AS runs,
         (SELECT coalesce(sum(r.cost_usd), 0) FROM runs r JOIN items i ON i.id = r.item_id WHERE i.project_id = p.id) AS cost,
         max(p.created_at,
             coalesce((SELECT max(coalesce(r.ended_at, r.started_at)) FROM runs r JOIN items i ON i.id = r.item_id
                       WHERE i.project_id = p.id), ''),
             coalesce((SELECT max(t.at) FROM item_transitions t JOIN items i ON i.id = t.item_id
                       WHERE i.project_id = p.id), '')) AS last
       FROM projects p ORDER BY last DESC, p.name`,
    )
    .all() as { id: string; name: string; root: string; runs: number; cost: number; last: string }[];
  const countStates = db.prepare('SELECT status, count(*) AS count FROM items WHERE project_id = ? GROUP BY status');
  return rows.map((row) => {
    const counts = new Map(
      (countStates.all(row.id) as { status: string; count: number }[]).map((c) => [c.status, c.count]),
    );
    const states = ITEM_STATES.filter((status) => counts.has(status)).map((status) => ({
      status,
      count: counts.get(status) as number,
    }));
    return {
      id: row.id,
      name: row.name,
      root: row.root,
      runs: row.runs,
      costUsd: row.cost,
      lastActivity: row.last,
      states,
      items: states.reduce((sum, state) => sum + state.count, 0),
    };
  });
}

/**
 * Projeto pelo nome ou por um prefixo único do id. Nome repetido, prefixo ambíguo ou
 * nada encontrado lançam `ProjectError` (com os candidatos, quando há).
 */
export function findProject(db: DatabaseSync, query: string): ProjectRow {
  const projects = listProjects(db);
  const byName = projects.filter((project) => project.name === query);
  const matches = byName.length > 0 ? byName : projects.filter((project) => project.id.startsWith(query));
  if (matches.length === 1) return matches[0] as ProjectRow;
  if (matches.length === 0) {
    throw new ProjectError(`Projeto não encontrado: ${query}. Veja a lista com \`mabel listar\`.`, 'nao_encontrado');
  }
  const what = byName.length > 0 ? `Há ${matches.length} projetos com o nome ${query}` : `O prefixo ${query} é ambíguo`;
  throw new ProjectError(
    [`${what}. Use um prefixo do id:`, ...matches.map((p) => `  ${p.id.slice(0, 8)}  ${p.name}  ${p.root}`)].join('\n'),
    'argumento_invalido',
  );
}

/** Caminho com `~` no lugar da pasta pessoal, para as tabelas. */
export function displayPath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function statesText(project: ProjectRow): string {
  if (project.items === 0) return 'sem itens';
  return project.states.map((state) => `${state.count} ${state.status}`).join(' · ');
}

export function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]) => `  ${cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd()}`;
  return [style.dim(line(header)), ...rows.map(line)];
}

export function renderProjects(projects: ProjectRow[]): string[] {
  if (projects.length === 0) return ['Nenhum projeto registrado. Rode `mabel preparar` num repositório.'];
  return [
    style.bold('Projetos'),
    ...table(
      ['nome', 'raiz', 'itens', 'runs', 'custo', 'última atividade'],
      projects.map((p) => [p.name, displayPath(p.root), statesText(p), String(p.runs), formatCost(p.costUsd), formatWhen(p.lastActivity)]),
    ),
  ];
}

interface RemovalRow {
  project_id: string;
  name: string;
  root: string;
  items: number;
  runs: number;
  cost_usd: number;
  removed_at: string;
}

export function renderRemovals(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT * FROM removals ORDER BY id DESC').all() as unknown as RemovalRow[];
  if (rows.length === 0) return ['Nenhum projeto removido.'];
  return [
    style.bold('Projetos removidos'),
    ...table(
      ['nome', 'raiz', 'id', 'itens', 'runs', 'custo', 'removido em'],
      rows.map((r) => [
        r.name,
        displayPath(r.root),
        r.project_id.slice(0, 8),
        String(r.items),
        String(r.runs),
        formatCost(r.cost_usd),
        formatWhen(r.removed_at),
      ]),
    ),
  ];
}

const oneLine = (text: string | null, width: number) => truncate((text ?? '').replace(/\s+/g, ' ').trim(), width);

/** Auditoria do projeto: totais, custo por etapa e modelo, itens, gates, escalonamentos e transições. */
export function renderProjectDetail(db: DatabaseSync, project: ProjectRow): string[] {
  const lines = [style.bold(`${project.name} · ${project.root}`), style.dim(`id ${project.id}`)];

  const totals = db
    .prepare(
      `SELECT count(*) AS runs, coalesce(sum(r.cost_usd), 0) AS cost,
         coalesce(sum(r.input_tokens), 0) AS input, coalesce(sum(r.output_tokens), 0) AS output,
         coalesce(sum(r.cache_read_tokens), 0) AS cache_read, coalesce(sum(r.cache_creation_tokens), 0) AS cache_creation
       FROM runs r JOIN items i ON i.id = r.item_id WHERE i.project_id = ?`,
    )
    .get(project.id) as { runs: number; cost: number; input: number; output: number; cache_read: number; cache_creation: number };
  lines.push(
    '',
    style.bold('Totais'),
    `  ${totals.runs} runs · ${formatCost(totals.cost)}`,
    `  tokens: entrada ${formatTokens(totals.input)} · saída ${formatTokens(totals.output)} · cache ${formatTokens(
      totals.cache_read + totals.cache_creation,
    )} (leitura ${formatTokens(totals.cache_read)}, criação ${formatTokens(totals.cache_creation)})`,
  );

  const grouped = (expression: string, title: string) => {
    const rows = db
      .prepare(
        `SELECT ${expression} AS key, count(*) AS runs, coalesce(sum(r.cost_usd), 0) AS cost
         FROM runs r JOIN items i ON i.id = r.item_id WHERE i.project_id = ? GROUP BY key ORDER BY cost DESC, key`,
      )
      .all(project.id) as { key: string; runs: number; cost: number }[];
    if (rows.length === 0) return;
    lines.push('', style.bold(title), ...table(['', 'runs', 'custo'], rows.map((r) => [r.key, String(r.runs), formatCost(r.cost)])).slice(1));
  };
  grouped('coalesce(r.stage, r.kind)', 'Por etapa');
  grouped("coalesce(r.model, r.model_requested, '?')", 'Por modelo');

  const items = db
    .prepare(
      `SELECT i.id, i.number, i.title, i.status, i.attempts,
         (SELECT coalesce(sum(r.cost_usd), 0) FROM runs r WHERE r.item_id = i.id) AS cost
       FROM items i WHERE i.project_id = ? ORDER BY i.number`,
    )
    .all(project.id) as { id: string; number: number; title: string; status: string; attempts: number; cost: number }[];
  lines.push('', style.bold('Itens'));
  if (items.length === 0) lines.push('  nenhum item');
  else {
    lines.push(
      ...table(
        ['#', 'título', 'estado', 'tentativas', 'custo', 'refin.', 'perg.', 'sup.'],
        items.map((i) => {
          const s = signals(db, i.id);
          return [
            `#${i.number}`,
            oneLine(i.title, 48),
            i.status,
            String(i.attempts),
            formatCost(i.cost),
            s.refined ? 'sim' : '—',
            s.planned ? String(s.questions) : '—',
            s.planned ? String(s.assumptions) : '—',
          ];
        }),
      ),
    );
  }

  const comparison = signalsComparison(db, project.id);
  if (comparison.length > 0) lines.push('', style.bold('Refinamento'), ...comparison);

  const gates = db
    .prepare(
      `SELECT i.number, g.attempt, g.gate, g.detail FROM gate_results g JOIN items i ON i.id = g.item_id
       WHERE i.project_id = ? AND g.passed = 0 ORDER BY g.id`,
    )
    .all(project.id) as { number: number; attempt: number; gate: string; detail: string | null }[];
  if (gates.length > 0) {
    lines.push('', style.bold('Gates reprovados'));
    for (const g of gates) lines.push(`  #${g.number} tentativa ${g.attempt} · ${g.gate} — ${oneLine(g.detail ?? 'reprovado', 100)}`);
  }

  const escalations = projectEscalations(db, project.id);
  if (escalations.length > 0) lines.push('', style.bold('Escalonamentos de modelo'), ...escalations.map((e) => `  ${e}`));

  const autonomous = autonomousDecisions(db, { projectId: project.id, since: new Date(0) });
  if (autonomous.length > 0) {
    lines.push('', style.bold('Decisões autônomas'));
    for (const { number, decision } of autonomous) lines.push(`  #${number} ${oneLine(decision, 120)} (autônomo)`);
  }

  const events = listQueueEvents(db, project.id);
  if (events.length > 0) {
    lines.push('', style.bold('Pausas da fila e decisões de saldo'));
    for (const event of events) lines.push(`  ${formatWhen(event.at.toISOString())}  ${queueEventText(event)}`);
  }

  const deliveries = listDeliveries(db, project.id);
  if (deliveries.length > 0) {
    lines.push('', style.bold('Entregas'));
    for (const d of deliveries) {
      const items = d.items.map((n) => `#${n}`).join(', ');
      lines.push(`  ${formatWhen(d.createdAt)}  ${d.branch} · ${DELIVERY_LABELS[d.status]} · ${items} · ${d.prUrl ?? 'sem PR'}`);
    }
  }

  const transitions = db
    .prepare(
      `SELECT i.number, t.from_state, t.to_state, t.reason, t.at FROM item_transitions t JOIN items i ON i.id = t.item_id
       WHERE i.project_id = ? ORDER BY t.id DESC LIMIT 20`,
    )
    .all(project.id) as { number: number; from_state: string; to_state: string; reason: string | null; at: string }[];
  if (transitions.length > 0) {
    lines.push('', style.bold('Últimas transições'));
    for (const t of transitions.reverse()) {
      const reason = t.reason ? ` · ${oneLine(t.reason, 80)}` : '';
      lines.push(`  ${formatWhen(t.at)}  #${t.number} ${t.from_state} → ${t.to_state}${reason}`);
    }
  }
  return lines;
}

const DELIVERY_LABELS: Record<DeliveryStatus, string> = { open: 'aberta', merged: 'na base', replaced: 'substituída' };

const CAUSE_LABELS: Record<QueueEventCause, string> = {
  queue: 'fila',
  five_hour: 'saldo de 5h',
  seven_day: 'saldo de 7 dias',
  pace: 'ritmo de 7 dias',
  no_reading: 'sem leitura de saldo',
  usage_limit: 'saldo esgotado',
  integration: 'integração',
  context: 'contexto do projeto',
  code: 'Mabel atualizado',
};

/** `pausa · saldo de 7 dias — …`, `espera até 14/10 18:00 · …`, `você: continuar · …`. */
function queueEventText(event: QueueEvent): string {
  const head =
    event.kind === 'pause'
      ? 'pausa'
      : event.kind === 'wait'
        ? `espera${event.until ? ` até ${formatWhen(event.until.toISOString())}` : ''}`
        : `você: ${event.approved ? 'continuar' : 'não continuar'}`;
  return `${head} · ${CAUSE_LABELS[event.cause]} — ${oneLine(event.detail, 100)}`;
}

/** Runs de etapa em que o modelo pedido subiu um degrau em relação à run anterior da mesma etapa. */
function projectEscalations(db: DatabaseSync, projectId: string): string[] {
  const runs = db
    .prepare(
      `SELECT i.number, r.stage, r.model_requested AS model, r.started_at FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.project_id = ? AND r.stage IS NOT NULL AND r.model_requested IS NOT NULL
       ORDER BY i.number, r.stage, r.started_at`,
    )
    .all(projectId) as { number: number; stage: string; model: string; started_at: string }[];
  const result: string[] = [];
  let previous: (typeof runs)[number] | undefined;
  for (const run of runs) {
    const same = previous && previous.number === run.number && previous.stage === run.stage;
    if (same && previous && run.model !== previous.model && escalate(previous.model) === run.model) {
      result.push(`${formatWhen(run.started_at)}  #${run.number} ${run.stage}: ${previous.model} → ${run.model}`);
    }
    previous = run;
  }
  return result;
}

// Saídas --json --------------------------------------------------------------------------

/** Um projeto em `mabel listar --json`. */
export function projectJson(db: DatabaseSync, home: string, project: ProjectRow, now: Date): Record<string, unknown> {
  const { fila, pausa } = queueState(db, home, project.id, now);
  const stage = fila === 'rodando' || fila === 'pausada_por_saldo' ? stageInProgress(db, project.id) : null;
  return {
    id: project.id,
    nome: project.name,
    raiz: project.root,
    fila,
    pausa,
    em_andamento: stage ? { ...stage, ...attemptInProgress(db, project.id, stage) } : null,
    inbox: inboxCount(db, project.id),
    itens: Object.fromEntries(project.states.map((state) => [state.status, state.count])),
    runs: project.runs,
    custo_usd: project.costUsd,
    ultima_atividade: isoLocal(new Date(project.lastActivity)),
  };
}

/** Uso de cada janela por run de item: última leitura menos a primeira, quando estão na mesma janela. */
const RUN_USAGE = `
  SELECT r.run_id, r.window,
    (SELECT utilization FROM rate_limits WHERE run_id = r.run_id AND window = r.window ORDER BY id DESC LIMIT 1)
      - (SELECT utilization FROM rate_limits WHERE run_id = r.run_id AND window = r.window ORDER BY id LIMIT 1) AS used
  FROM rate_limits r JOIN runs ON runs.id = r.run_id JOIN items i ON i.id = runs.item_id
  WHERE i.project_id = ?
  GROUP BY r.run_id, r.window
  HAVING count(DISTINCT r.resets_at) = 1`;

/**
 * Diagnóstico de consumo (`mabel auditar <nome> --json`): custo, tokens e uso das janelas,
 * no total e por etapa, por modelo e por item.
 */
export function projectDetailJson(db: DatabaseSync, project: ProjectRow): Record<string, unknown> {
  const usageRows = db.prepare(RUN_USAGE).all(project.id) as { run_id: string; window: string; used: number }[];
  const usage = new Map<string, Record<string, number>>();
  for (const row of usageRows) {
    const key = WINDOW_KEYS[row.window as keyof typeof WINDOW_KEYS];
    if (!key) continue;
    const byWindow = usage.get(row.run_id) ?? {};
    byWindow[key] = Math.max(0, row.used);
    usage.set(row.run_id, byWindow);
  }

  const runs = db
    .prepare(
      `SELECT r.id, coalesce(r.stage, r.kind) AS stage, coalesce(r.model, r.model_requested, '?') AS model,
         i.number, coalesce(r.cost_usd, 0) AS cost, coalesce(r.input_tokens, 0) AS input, coalesce(r.output_tokens, 0) AS output,
         coalesce(r.cache_read_tokens, 0) AS cache_read, coalesce(r.cache_creation_tokens, 0) AS cache_creation
       FROM runs r JOIN items i ON i.id = r.item_id WHERE i.project_id = ?`,
    )
    .all(project.id) as {
    id: string;
    stage: string;
    model: string;
    number: number;
    cost: number;
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  }[];

  interface Totals {
    runs: number;
    custo_usd: number;
    tokens: { entrada: number; saida: number; cache_leitura: number; cache_criacao: number };
    uso: Record<string, number>;
  }
  const empty = (): Totals => ({ runs: 0, custo_usd: 0, tokens: { entrada: 0, saida: 0, cache_leitura: 0, cache_criacao: 0 }, uso: { '5h': 0, '7d': 0 } });
  const add = (totals: Totals, run: (typeof runs)[number]) => {
    totals.runs++;
    totals.custo_usd += run.cost;
    totals.tokens.entrada += run.input;
    totals.tokens.saida += run.output;
    totals.tokens.cache_leitura += run.cache_read;
    totals.tokens.cache_criacao += run.cache_creation;
    for (const [window, used] of Object.entries(usage.get(run.id) ?? {})) totals.uso[window] = (totals.uso[window] ?? 0) + used;
  };
  const group = <K extends string | number>(key: (run: (typeof runs)[number]) => K) => {
    const groups = new Map<K, Totals>();
    for (const run of runs) {
      const k = key(run);
      const totals = groups.get(k) ?? empty();
      add(totals, run);
      groups.set(k, totals);
    }
    return groups;
  };

  const total = empty();
  for (const run of runs) add(total, run);
  const byCost = (a: Totals, b: Totals) => b.custo_usd - a.custo_usd;

  const items = db
    .prepare('SELECT number, title, status FROM items WHERE project_id = ? ORDER BY number')
    .all(project.id) as { number: number; title: string; status: string }[];
  const byItem = group((run) => run.number);

  return {
    projeto: { id: project.id, nome: project.name, raiz: project.root },
    total,
    por_etapa: [...group((run) => run.stage)]
      .sort(([, a], [, b]) => byCost(a, b))
      .map(([stage, totals]) => ({ etapa: STAGE_VALUES[stage] ?? stage, ...totals })),
    por_modelo: [...group((run) => run.model)].sort(([, a], [, b]) => byCost(a, b)).map(([model, totals]) => ({ modelo: model, ...totals })),
    por_item: items.map((item) => ({ item: item.number, titulo: item.title, estado: item.status, ...(byItem.get(item.number) ?? empty()) })),
  };
}

// Remoção --------------------------------------------------------------------------------

export interface RemovalPlan {
  project: ProjectRow;
  target: RemovalTarget;
  /** Linhas por tabela `project`, só as que têm alguma. */
  tables: { table: string; rows: number }[];
  /** Caminhos existentes por entrada de `dirScope`. */
  dirs: { entry: string; paths: string[] }[];
  /** Itens integrados que ainda não chegaram à base, e onde o trabalho deles está. */
  unmerged: { numbers: number[]; integration: string; base: string };
  /** Motivos que impedem a remoção agora. */
  refusals: string[];
}

/**
 * Itens em `awaiting_merge` já integrados cujo commit não está na base: o trabalho deles só
 * existe na branch de integração. Sem o repositório ou o config, vale o estado do banco.
 */
function unmergedItems(db: DatabaseSync, project: ProjectRow): RemovalPlan['unmerged'] {
  let config;
  try {
    config = existsSync(project.root) ? readConfig(project.root) : undefined;
  } catch {
    config = undefined;
  }
  const base = config?.baseBranch ?? 'main';
  const rows = db
    .prepare(
      `SELECT number, integrated_commit AS commit_id FROM items
       WHERE project_id = ? AND status = 'awaiting_merge' AND integrated_commit IS NOT NULL ORDER BY number`,
    )
    .all(project.id) as { number: number; commit_id: string }[];
  const numbers = rows.filter((row) => !config || !isAncestor(project.root, row.commit_id, base)).map((row) => row.number);
  return { numbers, integration: config?.integracao ?? DEFAULT_INTEGRATION, base };
}

function dirtyWorktrees(home: string, projectId: string): string[] {
  const dir = join(home, 'worktrees', projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => (tryGit(path, 'status', '--porcelain') ?? '') !== '');
}

export function planRemoval(db: DatabaseSync, home: string, project: ProjectRow): RemovalPlan {
  const ids = (sql: string) => (db.prepare(sql).all(project.id) as { id: string }[]).map((row) => row.id);
  const target: RemovalTarget = { projectId: project.id, itemIds: ids(PROJECT_ITEMS), runIds: ids(PROJECT_RUNS) };

  const tables = Object.entries(tableScope).flatMap(([table, scope]) => {
    if (scope.scope !== 'project') return [];
    const { rows } = db.prepare(`SELECT count(*) AS rows FROM ${table} WHERE ${scope.where}`).get(project.id) as { rows: number };
    return rows > 0 ? [{ table, rows }] : [];
  });
  const dirs = Object.entries(dirScope).flatMap(([entry, scope]) => {
    if (scope.scope !== 'project') return [];
    const paths = scope.paths(home, target).filter((path) => existsSync(path));
    return paths.length > 0 ? [{ entry, paths }] : [];
  });

  const refusals: string[] = [];
  const running = db
    .prepare(
      `SELECT r.id, i.number FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.project_id = ? AND r.status = 'running' ORDER BY r.started_at`,
    )
    .all(project.id) as { id: string; number: number }[];
  for (const run of running) {
    refusals.push(`Run ${run.id.slice(0, 8)} do item #${run.number} em andamento. Espere terminar ou interrompa-a.`);
  }
  const pid = lockHolder(home, project.id);
  if (pid !== undefined) refusals.push(`Há um \`mabel rodar\` ativo neste projeto (pid ${pid}).`);
  const dirty = dirtyWorktrees(home, project.id);
  if (dirty.length > 0) {
    refusals.push(['Worktrees com alterações sem commit:', ...dirty.map((path) => `  ${path}`)].join('\n'));
  }
  return { project, target, tables, dirs, unmerged: unmergedItems(db, project), refusals };
}

export function renderRemovalSummary(plan: RemovalPlan): string[] {
  const { project } = plan;
  const disk = plan.dirs.map(({ entry, paths }) => {
    if (entry === 'runs' || entry === 'items') return `${entry}/ (${paths.length})`;
    if (entry === 'worktrees') return `worktrees/${project.id.slice(0, 8)}…`;
    return `${entry}/`;
  });
  const lines = [
    style.bold(`${project.name} · ${project.root}`),
    `${project.items} ${project.items === 1 ? 'item' : 'itens'} · ${project.runs} runs · ${formatCost(project.costUsd)}`,
    `banco: ${plan.tables.map(({ table }) => table).join(', ') || 'nenhuma linha'}`,
    `disco: ${disk.join(', ') || 'nada'}`,
  ];
  const { numbers, integration, base } = plan.unmerged;
  if (numbers.length > 0) {
    const which = numbers.map((n) => `#${n}`).join(', ');
    const count = numbers.length === 1 ? `1 item integrado (${which}) ainda não chegou` : `${numbers.length} itens integrados (${which}) ainda não chegaram`;
    lines.push(
      style.accent(`aviso: ${count} a ${base}; o trabalho só existe na branch ${integration}, que a remoção não toca.`),
    );
  }
  return lines;
}

/**
 * Apaga o projeto: as tabelas `project` numa transação, com o registro em `removals`, e
 * depois os diretórios. Devolve os avisos de diretórios que não puderam ser apagados.
 */
export function removeProject(db: DatabaseSync, home: string, plan: RemovalPlan, now = new Date()): string[] {
  const { project } = plan;
  db.exec('BEGIN');
  try {
    for (const [table, scope] of Object.entries(tableScope)) {
      if (scope.scope === 'project') db.prepare(`DELETE FROM ${table} WHERE ${scope.where}`).run(project.id);
    }
    db.prepare(
      'INSERT INTO removals (project_id, name, root, items, runs, cost_usd, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(project.id, project.name, project.root, project.items, project.runs, project.costUsd, now.toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const warnings: string[] = [];
  for (const { paths } of plan.dirs) {
    for (const path of paths) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch (error) {
        warnings.push(`Não foi possível apagar ${path}: ${(error as Error).message}`);
      }
    }
  }
  return warnings;
}

function shellQuote(text: string): string {
  return /^[\w./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

// Comandos -------------------------------------------------------------------------------

export const projectsUsage = 'mabel listar [--removidos] [--json]';

export const projectsOptions = {
  removidos: { type: 'boolean', description: 'Lista as remoções feitas, com o que foi apagado' },
  json: jsonOption,
} satisfies OptionSpecs;
export const projectOptions = {
  confirmar: { type: 'string', value: '<nome>', values: 'projeto', description: 'Com remover: o nome do projeto de novo, para remover sem perguntar' },
  json: jsonOption,
} satisfies OptionSpecs;

export const projectArgs: ArgSpec[] = [
  {
    name: '<nome> | remover',
    description: 'Projeto a auditar; sem ele, a lista para escolher',
    values: 'projeto',
    choices: [{ name: 'remover', description: 'Apaga os dados do projeto no Mabel (o repositório fica)' }],
  },
  { name: '<nome>', description: 'Com remover: o projeto', values: 'projeto' },
];
export const projectUsage = 'mabel auditar <nome> [--json] | mabel auditar remover <nome> [--confirmar <nome>] [--json]';

function withDb(action: (db: DatabaseSync, home: string) => number | Promise<number>): Promise<number> {
  const home = dataDir();
  const db = openDb(home);
  return (async () => {
    try {
      return await action(db, home);
    } catch (error) {
      if (error instanceof ProjectError) return fail(error.code, error.message);
      if (error instanceof LockError) return fail('estado_invalido', error.message);
      throw error;
    } finally {
      db.close();
    }
  })();
}

/** Menu de projetos no terminal; o escolhido mostra a auditoria. */
async function chooseAndShow(db: DatabaseSync, projects: ProjectRow[]): Promise<number> {
  const chosen = await select(
    projects.map((p) => ({
      label: p.name,
      hint: style.dim(`${statesText(p)} · ${p.runs} runs · ${formatCost(p.costUsd)} · ${displayPath(p.root)}`),
    })),
    style,
  );
  if (chosen === null) return 0;
  process.stdout.write(`\n${renderProjectDetail(db, projects[chosen] as ProjectRow).join('\n')}\n`);
  return 0;
}

export function projectsCommand(args: string[]): Promise<number> {
  let removed: boolean;
  let json: boolean;
  try {
    const { values } = parseArgs({ args, options: projectsOptions });
    removed = values.removidos ?? false;
    json = values.json ?? false;
  } catch (error) {
    return Promise.resolve(fail('argumento_invalido', (error as Error).message, projectsUsage));
  }
  if (removed && json) {
    return Promise.resolve(fail('argumento_invalido', '--removidos não tem saída --json.', projectsUsage));
  }
  return withDb((db, home) => {
    if (json) {
      const now = new Date();
      writeJson({ projetos: listProjects(db).map((project) => projectJson(db, home, project, now)) });
      return 0;
    }
    if (removed) {
      process.stdout.write(`${renderRemovals(db).join('\n')}\n`);
      return 0;
    }
    const projects = listProjects(db);
    if (projects.length > 0 && interactive()) return chooseAndShow(db, projects);
    process.stdout.write(`${renderProjects(projects).join('\n')}\n`);
    return 0;
  });
}

export function projectCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: projectOptions });
  } catch (error) {
    return Promise.resolve(fail('argumento_invalido', (error as Error).message, projectUsage));
  }
  const [first, second] = parsed.positionals;
  if (first === 'remover') {
    if (!second) return Promise.resolve(fail('argumento_faltando', 'Informe o projeto.', projectUsage));
    return withDb((db, home) => removeCommand(db, home, second, parsed.values.confirmar, parsed.values.json ?? false));
  }
  if (first === undefined && parsed.values.json) return Promise.resolve(fail('argumento_faltando', 'Informe o projeto.', projectUsage));
  return withDb((db) => {
    if (!first) {
      const projects = listProjects(db);
      if (projects.length > 0 && interactive()) return chooseAndShow(db, projects);
      return fail('argumento_faltando', 'Informe o projeto.', projectUsage);
    }
    if (parsed.values.json) {
      writeJson(projectDetailJson(db, findProject(db, first)));
      return 0;
    }
    process.stdout.write(`${renderProjectDetail(db, findProject(db, first)).join('\n')}\n`);
    return 0;
  });
}

/** Confirmação da remoção: o nome digitado no formulário, com o botão vermelho. */
export function removalForm(name: string, query = name): FormConfig {
  return {
    title: 'Remover os dados do Mabel',
    description: `Apaga do Mabel os dados de ${name}; o repositório do projeto não é tocado.`,
    command: 'auditar remover',
    fields: [{ type: 'text', key: 'confirma', label: 'Confirme o nome', required: true, placeholder: 'digite o nome do projeto' }],
    action: 'Remover os dados',
    danger: true,
    check: (values) => (values.confirma !== name ? 'O nome digitado não confere com o projeto escolhido.' : null),
    shell: (values) => shellLine(['mabel', 'auditar', 'remover', query, '--confirmar', String(values.confirma || '<nome>')]),
  };
}

async function removeCommand(
  db: DatabaseSync,
  home: string,
  query: string,
  confirmation: string | undefined,
  json: boolean,
): Promise<number> {
  const project = findProject(db, query);
  const plan = planRemoval(db, home, project);
  // Com --json, o stdout leva só a linha final; o resumo não sai.
  const out = (lines: string[]) => {
    if (!json) process.stdout.write(`${lines.map((line) => (line ? `  ${line}` : '')).join('\n')}\n`);
  };
  out(renderRemovalSummary(plan));

  if (plan.refusals.length > 0) return fail('estado_invalido', `\n${plan.refusals.join('\n')}\nNada foi removido.`);
  if (confirmation === undefined) {
    if (json || !interactive()) {
      return fail('argumento_faltando', `\nPara remover, confirme com: mabel auditar remover ${query} --confirmar ${project.name}`);
    }
    process.stdout.write('\n');
    const values = await fillForm(removalForm(project.name, query));
    if (!values) {
      process.stdout.write('  Nada foi removido.\n');
      return 0;
    }
    confirmation = String(values.confirma ?? '');
  }
  if (confirmation !== project.name) return fail('argumento_invalido', 'O nome não confere. Nada foi removido.');

  // A trava impede que um `mabel rodar` comece no meio da remoção; é apagada junto com `locks/`.
  const release = acquireLock(home, project.id);
  let warnings: string[];
  try {
    warnings = removeProject(db, home, planRemoval(db, home, project));
  } finally {
    release();
  }
  if (json) {
    writeJson({ removido: { id: project.id, nome: project.name, raiz: project.root }, avisos: warnings });
    return 0;
  }
  const root = shellQuote(project.root);
  out([
    'Projeto removido. Registro em removals.',
    ...warnings,
    '',
    'O repositório não foi alterado. Para limpar também:',
    `  git -C ${root} worktree prune`,
    `  git -C ${root} branch --list 'mabel/*'`,
    style.dim('O .mabel/ continua no repositório: um comando do Mabel ali registra o projeto de novo, sem o histórico.'),
  ]);
  return 0;
}
