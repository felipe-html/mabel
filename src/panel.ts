import type { DatabaseSync } from 'node:sqlite';
import { type BalanceReading, renderBalanceFooter } from './balance.ts';
import { displayTarget } from './exec.ts';
import { formatCost, formatDuration } from './format.ts';
import { type ItemStatus, listItems } from './items.ts';
import type { Key } from './menu.ts';
import type { Project } from './project.ts';
import { PROOF_PROGRESS, type ProofProgress } from './proof.ts';
import type { RunStage, RunStatus } from './runner.ts';
import type { QueueEnd } from './run.ts';
import { QUEUE_ENDINGS } from './runreport.ts';
import type { PlanOutput } from './schemas/stages.ts';
import { type Hint, type ScreenStyle, clip, fit, isEnter, isEscape, row, visibleLength } from './screens.ts';
import { readArtifact } from './stages.ts';

/**
 * Painel da fila (`docs/specs/terminal.md`, aba "Fila (rodar)" do protótipo): a fila como
 * uma lista que se atualiza no lugar, uma linha por item e as etapas do item ativo.
 *
 * O painel não lê a saída do `rodar`: lê o banco, como o `mabel eventos`. As transições, as
 * runs, os gates e os eventos da fila desde o início dela viram `PanelEvent`s, que
 * `reducePanel` dobra num `PanelState`; `renderPanel` desenha o estado na altura do
 * terminal. As três partes são puras; quem lê o banco é `loadPanel`, e quem desenha no
 * terminal é `src/queuepanel.ts`.
 */

// Estado ---------------------------------------------------------------------------------

export interface PanelTool {
  name: string;
  target: string;
  /** `null` enquanto a ferramenta não devolveu o resultado. */
  ok: boolean | null;
}

export interface PanelRun {
  id: string;
  stage: RunStage;
  model: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  cost: number;
  turns: number;
  /** Só da run em andamento: as ferramentas, na ordem. */
  tools: PanelTool[];
}

export interface PanelGate {
  attempt: number;
  gate: string;
  passed: boolean;
  detail: string | null;
  at: number;
}

export interface PanelItem {
  number: number;
  title: string;
  status: ItemStatus;
  reason: string | null;
  /** Tentativas reprovadas do ciclo (`items.attempts`). */
  attempts: number;
  /** Branch da unidade, a dica do "merge na unidade". */
  /** Branch onde a tarefa entra por merge: a integração (a fila). */
  integrationBranch: string;
  /** "3 critérios, escopo de 4 caminhos", do plano aceito. */
  planNote?: string;
  /** O item teve alguma transição nesta fila. */
  touched: boolean;
  /** Tempo nas etapas (planejar, executar, verificar, revisar), sem a espera entre elas. */
  activeMs: number;
  activeSince: number | null;
  /** Quando chegou a `awaiting_merge` ou `done` nesta fila. */
  doneAt: number | null;
  /** Início do ciclo de execução: as reprovações antes dele não contam para "tentativa 2/3". */
  cycleStart: number | null;
  /** Teste da prova em andamento, de `prova-N/progresso.json`; só em `verifying`. */
  proof?: ProofProgress;
  runs: PanelRun[];
  gates: PanelGate[];
}

/** Quais itens a fila vai tomar: os de `--item` ou `--limite`, ou todos os prontos. */
export interface PanelScope {
  itemNumber?: number;
  limit?: number;
}

export interface PanelState {
  project: string;
  items: PanelItem[];
  /** Branch de integração ligada: a última etapa é o merge na fila (G10). */
  integration: boolean;
  /** Comandos de verificação do projeto (G3). */
  verify: { name: string; command: string }[];
  scope: PanelScope;
  phase: 'plan' | 'execute';
  started: number | null;
  ended: { at: number; end: QueueEnd | 'error' } | null;
  /** Espera por saldo em curso: a janela, o limite e até quando. */
  wait: { at: number; detail: string; until: number | null } | null;
  /** Motivo da última pausa (a fila encerra pausada). */
  pause: string | null;
  /** Último registro da fila (evento, transição, run ou gate), para o tempo da preparação. */
  lastAt: number | null;
}

export type PanelEvent =
  | { kind: 'queue'; at: number; event: 'start' | 'stop' | 'wait' | 'pause' | 'answer'; detail: string; until?: number }
  | { kind: 'transition'; at: number; item: number; from: ItemStatus; to: ItemStatus; reason: string | null }
  | { kind: 'run'; at: number; item: number; run: PanelRun }
  | { kind: 'gate'; at: number; item: number; gate: PanelGate };

export interface PanelBase {
  project: string;
  items: Pick<PanelItem, 'number' | 'title' | 'status' | 'reason' | 'attempts' | 'integrationBranch' | 'planNote' | 'proof'>[];
  integration: boolean;
  verify: { name: string; command: string }[];
  scope: PanelScope;
  /** Fase antes do primeiro evento: planejamento na fila em lote com itens prontos. */
  phase?: 'plan' | 'execute';
}

export function panelState(base: PanelBase): PanelState {
  return {
    project: base.project,
    items: base.items.map((item) => ({ ...item, touched: false, activeMs: 0, activeSince: null, doneAt: null, cycleStart: null, runs: [], gates: [] })),
    integration: base.integration,
    verify: base.verify,
    scope: base.scope,
    phase: base.phase ?? 'plan',
    started: null,
    ended: null,
    wait: null,
    pause: null,
    lastAt: null,
  };
}

const IN_PROGRESS: ItemStatus[] = ['planning', 'executing', 'verifying', 'reviewing'];
const CONCLUDED: ItemStatus[] = ['awaiting_merge', 'done'];
const EXECUTION: ItemStatus[] = ['executing', 'verifying', 'reviewing'];

/** Um evento a mais no estado. Não muda o estado recebido. */
export function reducePanel(state: PanelState, event: PanelEvent): PanelState {
  const latest = event.kind === 'run' ? Math.max(event.at, event.run.endedAt ?? 0) : event.at;
  const next: PanelState = { ...state, items: state.items, lastAt: Math.max(state.lastAt ?? 0, latest) };
  const touch = (number: number, change: (item: PanelItem) => PanelItem) => {
    next.items = next.items.map((item) => (item.number === number ? change(item) : item));
  };
  switch (event.kind) {
    case 'queue':
      if (event.event === 'start') Object.assign(next, { started: event.at, ended: null, wait: null, pause: null });
      else if (event.event === 'stop') Object.assign(next, { ended: { at: event.at, end: event.detail as QueueEnd }, wait: null });
      else if (event.event === 'wait') next.wait = { at: event.at, detail: event.detail, until: event.until ?? null };
      else if (event.event === 'pause') next.pause = event.detail;
      return next;
    case 'transition':
      touch(event.item, (item) => {
        const changed = { ...item, status: event.to, reason: event.reason, touched: true };
        const wasActive = IN_PROGRESS.includes(event.from);
        const isActive = IN_PROGRESS.includes(event.to);
        if (isActive && changed.activeSince === null) changed.activeSince = event.at;
        if (wasActive && !isActive && changed.activeSince !== null) {
          changed.activeMs += event.at - changed.activeSince;
          changed.activeSince = null;
        }
        if (CONCLUDED.includes(event.to)) changed.doneAt = event.at;
        if (event.to === 'executing' && !EXECUTION.includes(event.from)) changed.cycleStart = event.at;
        return changed;
      });
      if (event.to === 'planning') next.phase = 'plan';
      if (event.to === 'executing') next.phase = 'execute';
      return next;
    case 'run':
      touch(event.item, (item) => ({ ...item, touched: true, runs: [...item.runs.filter((run) => run.id !== event.run.id), event.run] }));
      // A espera por saldo terminou quando a próxima etapa começa.
      if (next.wait && event.run.startedAt >= next.wait.at) next.wait = null;
      return next;
    case 'gate':
      touch(event.item, (item) => ({ ...item, gates: [...item.gates, event.gate] }));
      return next;
  }
}

// Leitura do banco -----------------------------------------------------------------------

const iso = (at: string) => new Date(at).getTime();

/** Início da última fila do projeto, de `queue_events`; `undefined` se nunca rodou. */
export function lastQueueStart(db: DatabaseSync, projectId: string): string | undefined {
  const row = db
    .prepare("SELECT at FROM queue_events WHERE project_id = ? AND kind = 'start' ORDER BY id DESC LIMIT 1")
    .get(projectId) as { at: string } | undefined;
  return row?.at;
}

/** "3 critérios, escopo de 4 caminhos", do `plano.json` do item. */
function planNote(home: string, itemId: string): string | undefined {
  const plan = readArtifact<PlanOutput>(home, itemId, 'plano.json');
  if (!plan || !Array.isArray(plan.criterios) || !Array.isArray(plan.escopo)) return undefined;
  const criteria = plan.criterios.length;
  const scope = plan.escopo.length;
  return `${criteria} ${criteria === 1 ? 'critério' : 'critérios'}, escopo de ${scope} ${scope === 1 ? 'caminho' : 'caminhos'}`;
}

/**
 * Lê do banco o que aconteceu no projeto desde `since` (o início da fila) e devolve o
 * estado do painel. As runs em andamento trazem as ferramentas e os turnos até agora.
 */
export function loadPanel(db: DatabaseSync, home: string, project: Project, scope: PanelScope, since: string, batch = true): PanelState {
  const items = listItems(db, project.id);
  const byNumber = new Map(items.map((item) => [item.number, item]));
  const base: PanelBase = {
    project: project.name,
    items: items.map((item) => ({
      number: item.number,
      title: item.title,
      status: item.status,
      reason: item.statusReason,
      attempts: item.attempts,
      integrationBranch: project.config.integracao ?? project.config.baseBranch,
      planNote: planNote(home, item.id),
      proof: item.status === 'verifying' ? readArtifact<ProofProgress>(home, item.id, `prova-${item.attemptNo}/${PROOF_PROGRESS}`) : undefined,
    })),
    integration: Boolean(project.config.integracao),
    verify: project.config.verify.map(({ name, command }) => ({ name, command })),
    scope,
    // Em lote, só há planejamento se algum item está pronto: com todos planejados, a fila executa.
    phase: batch && items.some((item) => item.status === 'ready' || item.status === 'planning') ? 'plan' : 'execute',
  };

  const events: PanelEvent[] = [];
  const queue = db
    .prepare('SELECT at, kind, detail, until FROM queue_events WHERE project_id = ? AND at >= ? ORDER BY id')
    .all(project.id, since) as { at: string; kind: string; detail: string; until: string | null }[];
  for (const row of queue) {
    const event = row.kind as Extract<PanelEvent, { kind: 'queue' }>['event'];
    events.push({ kind: 'queue', at: iso(row.at), event, detail: row.detail, ...(row.until ? { until: iso(row.until) } : {}) });
  }

  const transitions = db
    .prepare(
      `SELECT t.at, t.from_state, t.to_state, t.reason, i.number FROM item_transitions t JOIN items i ON i.id = t.item_id
       WHERE i.project_id = ? AND t.at >= ? ORDER BY t.id`,
    )
    .all(project.id, since) as { at: string; from_state: ItemStatus; to_state: ItemStatus; reason: string | null; number: number }[];
  for (const row of transitions) {
    events.push({ kind: 'transition', at: iso(row.at), item: row.number, from: row.from_state, to: row.to_state, reason: row.reason });
  }

  const runs = db
    .prepare(
      `SELECT r.id, r.stage, r.model, r.model_requested, r.status, r.started_at, r.ended_at, r.cost_usd, r.num_turns, i.number
       FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.project_id = ? AND r.kind = 'stage' AND r.started_at >= ? ORDER BY r.started_at, r.rowid`,
    )
    .all(project.id, since) as {
    id: string;
    stage: RunStage;
    model: string | null;
    model_requested: string | null;
    status: RunStatus;
    started_at: string;
    ended_at: string | null;
    cost_usd: number | null;
    num_turns: number | null;
    number: number;
  }[];
  const countTurns = db.prepare("SELECT count(*) AS n FROM events WHERE run_id = ? AND type = 'assistant'");
  const toolsOf = db.prepare('SELECT name, input, ended_at, is_error FROM tool_calls WHERE run_id = ? ORDER BY rowid');
  for (const row of runs) {
    const running = row.status === 'running';
    const item = byNumber.get(row.number);
    const cwd = item?.worktree ?? project.root;
    const tools = running
      ? (toolsOf.all(row.id) as { name: string; input: string; ended_at: string | null; is_error: number | null }[]).map((tool) => {
          let input: unknown;
          try {
            input = JSON.parse(tool.input);
          } catch {
            input = {};
          }
          return { name: tool.name, target: displayTarget(input, cwd, 60), ok: tool.ended_at === null ? null : tool.is_error !== 1 };
        })
      : [];
    const turns = running ? (countTurns.get(row.id) as { n: number }).n : (row.num_turns ?? 0);
    const run: PanelRun = {
      id: row.id,
      stage: row.stage,
      model: row.model ?? row.model_requested ?? '?',
      status: row.status,
      startedAt: iso(row.started_at),
      endedAt: row.ended_at ? iso(row.ended_at) : null,
      cost: row.cost_usd ?? 0,
      turns,
      tools,
    };
    events.push({ kind: 'run', at: run.startedAt, item: row.number, run });
  }

  const gates = db
    .prepare(
      `SELECT g.attempt, g.gate, g.passed, g.detail, g.at, i.number FROM gate_results g JOIN items i ON i.id = g.item_id
       WHERE i.project_id = ? AND g.at >= ? ORDER BY g.id`,
    )
    .all(project.id, since) as { attempt: number; gate: string; passed: number; detail: string | null; at: string; number: number }[];
  for (const row of gates) {
    events.push({ kind: 'gate', at: iso(row.at), item: row.number, gate: { attempt: row.attempt, gate: row.gate, passed: row.passed === 1, detail: row.detail, at: iso(row.at) } });
  }

  // Ordem estável: horário, depois a ordem de leitura.
  const sorted = events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index);
  return sorted.reduce((state, { event }) => reducePanel(state, event), panelState(base));
}

// Etapas do item ativo -------------------------------------------------------------------

export type RowStatus = 'done' | 'failed' | 'running' | 'waiting' | 'pending' | 'interrupted';

/** Uma linha de etapa: agente (planejar, executar, revisar) ou gate. */
export interface StageRow {
  label: string;
  kind: 'agent' | 'gate' | 'plan';
  status: RowStatus;
  /** G2, G3, G4, G10. */
  gate?: string;
  hint?: string;
  note?: string;
  run?: PanelRun;
  /** Começo da etapa em andamento (o gate começa quando a anterior termina). */
  since?: number;
  /** Quando o gate foi gravado. */
  end?: number;
  /** Duração, das etapas encerradas. */
  ms?: number;
  /** "tentativa 2/3", da execução refeita. */
  attempt?: number;
  /** Causa mecânica de cada tentativa reprovada antes desta. */
  history?: string[];
}

export const MAX_ATTEMPTS = 3;

/** Gates da prova (G3): os testes ligados aos critérios e a prova, que roda cada um. */
const PROOF_GATES = ['criteria_tests', 'proof'];
/** Onde a tentativa reprovou, para o ↻. */
function failureCause(gate: string, verify: string[]): string {
  if (verify.includes(gate)) return 'na verificação';
  const causes: Record<string, string> = {
    scope: 'no escopo',
    criteria_tests: 'na prova',
    proof: 'na prova',
    review: 'na revisão',
    changes: 'sem alteração',
    execution_output: 'na saída da execução',
    environment: 'no ambiente',
    integration: 'na integração',
  };
  return causes[gate] ?? `no gate ${gate}`;
}

const lastOf = <T>(list: T[], test: (value: T) => boolean): T | undefined => list.filter(test).at(-1);

function agentRow(label: string, run: PanelRun | undefined, note?: string): StageRow {
  if (!run) return { label, kind: 'agent', status: 'pending' };
  const status: RowStatus = run.status === 'running' ? 'running' : run.status === 'succeeded' ? 'done' : run.status === 'interrupted' ? 'interrupted' : 'failed';
  return { label, kind: 'agent', status, run, since: run.startedAt, ms: run.endedAt === null ? undefined : run.endedAt - run.startedAt, note };
}

function gateRow(label: string, gate: string, hint: string, results: PanelGate[], note: (passed: PanelGate[]) => string): StageRow {
  if (results.length === 0) return { label, kind: 'gate', gate, hint, status: 'pending' };
  const failed = results.find((result) => !result.passed);
  const at = (results.at(-1) as PanelGate).at;
  if (failed) return { label, kind: 'gate', gate, hint, status: 'failed', note: failed.detail ?? 'reprovou', end: at };
  return { label, kind: 'gate', gate, hint, status: 'done', note: note(results), end: at };
}

/** "R7-2 na base · teste 14 de 16": o teste que a prova está rodando. */
function proofHint(progress: ProofProgress): string {
  const where = `${progress.criterio ?? 'comando de teste'} ${progress.lado === 'item' ? 'no item' : 'na base'}`;
  return `${where} · ${progress.criterio ? 'teste' : 'execução'} ${progress.feitos + 1} de ${progress.total}`;
}

/**
 * A prova só termina com o gate `proof`: o `criteria_tests`, gravado antes dela, passa na
 * hora. Até lá a linha segue pendente, e vira a etapa em andamento com o teste da vez.
 */
function proofRow(results: PanelGate[], progress: ProofProgress | undefined): StageRow {
  const hint = progress ? proofHint(progress) : 'cada critério ligado a um teste';
  const finished = results.some((result) => result.gate === 'proof' || !result.passed);
  return gateRow('prova', 'G3', hint, finished ? results : [], (passed) => passed.at(-1)?.detail ?? 'critérios ligados a testes');
}

/**
 * Etapas visíveis do item na fase em que ele está. No planejamento: planejar e o critério de
 * início (G2). Na execução: o plano aceito numa linha, executar, os gates e revisar, e o
 * merge na unidade com a integração ligada. A etapa seguinte a uma encerrada, sem agente
 * rodando, é a que o Mabel está fazendo agora.
 */
export function stageRows(state: PanelState, item: PanelItem, now: number): StageRow[] {
  const verifyNames = state.verify.map((command) => command.name);
  const plan = lastOf(item.runs, (run) => run.stage === 'plan');
  let rows: StageRow[];
  if (item.status === 'planning') {
    const start = plan ? item.gates.filter((gate) => gate.gate === 'start' && gate.at >= plan.startedAt) : [];
    rows = [
      agentRow('planejar', plan),
      gateRow('critério de início', 'G2', 'critérios, escopo, regra crítica', start.slice(-1), () => item.planNote ?? 'plano aceito'),
    ];
  } else {
    const execute = lastOf(item.runs, (run) => run.stage === 'execute');
    const from = execute?.startedAt ?? item.cycleStart ?? 0;
    const current = item.gates.filter((gate) => gate.at >= from);
    const named = (names: string[]) => current.filter((gate) => names.includes(gate.gate));
    const review = lastOf(item.runs, (run) => run.stage === 'review' && run.startedAt >= from);
    const reviewGate = named(['review']).at(-1);

    // Reprovações do ciclo antes da execução atual: uma linha ↻ por tentativa.
    const cycleFrom = item.cycleStart ?? 0;
    const failures = new Map<number, string>();
    for (const gate of item.gates) {
      if (gate.passed || gate.at < cycleFrom || gate.at >= from || failures.has(gate.attempt)) continue;
      failures.set(gate.attempt, `${failureCause(gate.gate, verifyNames)}${gate.detail ? `: ${gate.detail}` : ''}`);
    }
    const history = [...failures.values()].map((cause, index) => `tentativa ${index + 1} reprovada ${cause}`);
    const executeRow = agentRow('executar', execute);
    if (history.length > 0) Object.assign(executeRow, { history, attempt: history.length + 1 });

    rows = [
      { label: 'planejar', kind: 'plan', status: 'done', run: plan, ms: plan?.endedAt ? plan.endedAt - plan.startedAt : undefined },
      executeRow,
      gateRow('escopo', 'G4', 'arquivos alterados × plano', named(['scope']), () => 'arquivos no escopo'),
      gateRow('verificação', 'G3', state.verify.map((command) => command.command).join(' · ') || 'sem comando de verificação', named(verifyNames), (passed) =>
        passed.length === 1 ? `${passed[0]?.gate} verde` : `${passed.map((gate) => gate.gate).join(' · ')} verdes`,
      ),
      proofRow(named(PROOF_GATES), item.proof),
      agentRow('revisar', review, reviewGate?.detail ?? undefined),
    ];
    if (reviewGate && !reviewGate.passed && rows[5]) Object.assign(rows[5], { status: 'failed', note: reviewGate.detail ?? 'revisão reprovou' });
    if (state.integration) {
      rows.push(gateRow('merge na fila', 'G10', item.integrationBranch, named(['integration']), () => item.integrationBranch));
    }
  }

  // Gates não têm duração gravada: contam do fim da etapa anterior.
  let previousEnd: number | undefined = plan?.endedAt ?? undefined;
  for (const row_ of rows) {
    if (row_.kind === 'gate' && row_.end !== undefined) {
      if (previousEnd !== undefined) row_.ms = Math.max(0, row_.end - previousEnd);
      previousEnd = row_.end;
    } else if (row_.run?.endedAt) previousEnd = row_.run.endedAt;
  }

  // Fila encerrada: o que ainda constava como rodando parou com ela.
  if (state.ended) for (const row_ of rows) if (row_.status === 'running') row_.status = 'interrupted';

  // A etapa que o Mabel está fazendo agora: a primeira pendente depois das encerradas.
  const active = IN_PROGRESS.includes(item.status) && !state.ended;
  if (active && !rows.some((row) => row.status === 'running')) {
    const blocked = rows.some((row) => row.status === 'failed' || row.status === 'interrupted');
    const next = rows.find((row) => row.status === 'pending');
    if (next && !blocked) {
      next.status = state.wait && next.kind === 'agent' ? 'waiting' : 'running';
      next.since = previousEnd ?? now;
    }
  }
  return rows;
}

// Frase do agente ------------------------------------------------------------------------

const EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/**
 * Frase montada pelo Mabel a partir das ferramentas da run, sem o texto do agente: o que a
 * última ferramenta faz e quantos arquivos a run já alterou.
 */
export function standardPhrase(tools: PanelTool[]): string {
  const last = tools.at(-1);
  if (!last) return 'iniciando a sessão…';
  const changed = new Set(tools.filter((tool) => EDITS.includes(tool.name) && tool.ok !== false).map((tool) => tool.target)).size;
  const target = last.target;
  const verbs: Record<string, string> = {
    Read: `lendo ${target}`,
    Grep: `procurando "${target}"`,
    Glob: `procurando arquivos ${target}`,
    Edit: `editando ${target}`,
    MultiEdit: `editando ${target}`,
    NotebookEdit: `editando ${target}`,
    Write: `criando ${target}`,
    WebFetch: `lendo ${target}`,
    WebSearch: `pesquisando ${target}`,
    TodoWrite: 'organizando as tarefas',
    StructuredOutput: 'entregando o resultado',
    Bash: /\btest/.test(target) ? `rodando os testes (${target})` : `executando ${target}`,
  };
  const verb = verbs[last.name] ?? `${last.name} ${target}`.trim();
  return changed ? `${verb} · ${changed} ${changed === 1 ? 'arquivo alterado' : 'arquivos alterados'}` : verb;
}

// Barra de ações -------------------------------------------------------------------------

export type PanelActionId = 'tools' | 'done' | 'decide' | 'stop' | 'leave' | 'answer_yes' | 'answer_no';

export interface PanelAction {
  id: PanelActionId;
  label: string;
}

/** Pergunta da política de saldo, feita pela fila rodando neste terminal. */
export interface PanelQuestion {
  notice: string;
  action: string;
  back: string;
}

/** O que só o terminal sabe: o que está aberto, a ação escolhida, a pergunta e a parada pedida. */
export interface PanelView {
  tools: boolean;
  done: boolean;
  selected: number;
  /** `rodar`: a fila roda neste terminal; `acompanhar`: em segundo plano, e sair não a para. */
  mode: 'rodar' | 'acompanhar';
  /** Aberto pela tela inicial (volta ao menu) ou pelo shell (sai do painel). */
  origin: 'menu' | 'shell';
  question: PanelQuestion | null;
  stopRequested: boolean;
  /** Ctrl+C no `rodar`: a run atual foi interrompida e a fila está encerrando. */
  interrupting: boolean;
}

export function panelView(mode: PanelView['mode'], origin: PanelView['origin']): PanelView {
  return { tools: false, done: false, selected: 0, mode, origin, question: null, stopRequested: false, interrupting: false };
}

/** Itens que aguardam você no painel. */
const waitingYou = (state: PanelState) => panelItems(state).filter((item) => item.status === 'needs_human');

/** Ações da barra, como itens de menu: nenhuma tem atalho de uma tecla. */
export function panelActions(state: PanelState, view: PanelView): PanelAction[] {
  const leave: PanelAction = { id: 'leave', label: view.origin === 'menu' ? 'Voltar ao menu' : 'Sair do painel' };
  const decide: PanelAction[] = waitingYou(state).length > 0 ? [{ id: 'decide', label: 'Decidir agora' }] : [];
  if (view.question) {
    return [
      { id: 'answer_no', label: view.question.back },
      { id: 'answer_yes', label: view.question.action },
    ];
  }
  if (state.ended) return [leave, ...decide];
  return [
    { id: 'tools', label: view.tools ? 'Esconder ferramentas' : 'Mostrar ferramentas' },
    { id: 'done', label: view.done ? 'Esconder concluídos' : 'Mostrar concluídos' },
    ...decide,
    { id: 'stop', label: view.stopRequested ? 'Parada pedida' : 'Parar depois da etapa' },
    // Em segundo plano, sair do painel não para a fila.
    ...(view.mode === 'acompanhar' ? [leave] : []),
  ];
}

export type PanelStep = { view: PanelView } | { act: PanelActionId };

/** ← → escolhem a ação, enter a executa; esc sai quando a fila já encerrou. */
export function panelStep(state: PanelState, view: PanelView, key: Key): PanelStep {
  const actions = panelActions(state, view);
  const selected = Math.min(view.selected, actions.length - 1);
  if (key.name === 'right') return { view: { ...view, selected: (selected + 1) % actions.length } };
  if (key.name === 'left') return { view: { ...view, selected: (selected - 1 + actions.length) % actions.length } };
  if (isEnter(key)) return { act: (actions[selected] as PanelAction).id };
  if (isEscape(key) && state.ended) return { act: 'leave' };
  return { view };
}

export const PANEL_HINTS: Hint[] = [
  ['←→', 'escolher'],
  ['enter', 'executar'],
];

/** Teclas do rodapé: com a fila encerrada, esc também sai. */
export function panelHints(state: PanelState, view: PanelView): Hint[] {
  return state.ended ? [...PANEL_HINTS, ['esc', view.origin === 'menu' ? 'volta ao menu' : 'sai']] : PANEL_HINTS;
}

// Desenho --------------------------------------------------------------------------------

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
/** Concluídos que ficam na tela; os anteriores viram "+N concluídos". */
export const DONE_SHOWN = 3;
/** Ferramentas na lista aberta. */
export const TOOLS_SHOWN = 6;
const LABEL_WIDTH = 19;

const two = (n: number) => String(n).padStart(2, '0');
const clock = (at: number) => {
  const date = new Date(at);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const money = (usd: number) => formatCost(usd);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Linha com o trecho do meio cortado com "…" para caber, e o lado direito encostado. */
function line(left: string, middle: string, paintMiddle: (text: string) => string, right: string, width: number): string {
  const room = width - 1 - visibleLength(left) - (right ? visibleLength(right) + 1 : 0);
  const shown = room > 0 ? paintMiddle(fit(middle, room)) : '';
  return row(`${left}${shown}`, right, width - 1);
}

/** Itens do painel: os que a fila já tocou e os que ela ainda vai tomar. */
export function panelItems(state: PanelState): PanelItem[] {
  const touched = state.items.filter((item) => item.touched);
  let waiting = state.items.filter((item) => !item.touched && (item.status === 'ready' || item.status === 'planned'));
  if (state.scope.itemNumber !== undefined) waiting = waiting.filter((item) => item.number === state.scope.itemNumber);
  else if (state.scope.limit !== undefined) {
    const taken = touched.filter((item) => item.status !== 'needs_human' || item.runs.length > 0).length;
    waiting = waiting.slice(0, Math.max(0, state.scope.limit - taken));
  }
  const keep = new Set([...touched, ...waiting].map((item) => item.number));
  return state.items.filter((item) => keep.has(item.number));
}

const itemCost = (item: PanelItem) => item.runs.reduce((total, run) => total + (run.endedAt === null ? 0 : run.cost), 0);
const itemElapsed = (item: PanelItem, now: number) => item.activeMs + (item.activeSince === null ? 0 : now - item.activeSince);

/** Linhas de uma etapa, como no protótipo. */
function stageLines(row_: StageRow, style: ScreenStyle, width: number, now: number, spin: string, showTools: boolean): string[] {
  const label = row_.label.padEnd(LABEL_WIDTH);
  const time = (ms: number | undefined) => (ms === undefined ? '' : formatDuration(ms));
  const out: string[] = [];
  const run = row_.run;
  switch (row_.status) {
    case 'done':
    case 'failed':
    case 'interrupted': {
      const ok = row_.status === 'done';
      if (row_.kind === 'plan') {
        const right = run ? style.dim(`${time(row_.ms)} · ${money(run.cost)}`) : '';
        out.push(line(`    ${style.green('✓')} ${label}`, run ? `plano aceito · ${run.model}` : 'plano aceito', style.dim, right, width));
      } else if (row_.kind === 'agent' && run) {
        const mark = ok ? style.green('✓') : row_.status === 'interrupted' ? style.yellow('■') : style.red('✗');
        const what = row_.status === 'interrupted' ? 'interrompida' : `${run.model} · ${plural(run.turns, 'turno', 'turnos')}${row_.note ? ` · ${row_.note}` : ''}`;
        out.push(line(`    ${mark} ${ok ? label : style.red(label)}`, what, ok ? style.dim : style.red, style.dim(`${time(row_.ms)} · ${money(run.cost)}`), width));
      } else {
        out.push(line(`    ${ok ? style.green('✓') : style.red('✗')} ${ok ? label : style.red(label)}`, row_.note ?? '', ok ? style.dim : style.red, style.dim(`${row_.gate} · ${time(row_.ms)}`), width));
      }
      break;
    }
    case 'running': {
      const elapsed = formatDuration(Math.max(0, now - (row_.since ?? now)));
      if (row_.kind === 'agent') {
        const attempt = row_.attempt ? ` · tentativa ${row_.attempt}/${MAX_ATTEMPTS}` : '';
        // Sem run, o Mabel ainda não abriu a sessão: não há ferramentas a mostrar.
        const model = run ? `${run.model} · turno ${run.turns}${attempt}` : `preparando a sessão${attempt}`;
        out.push(line(`    ${style.accent(spin)} ${style.bold(label)}`, model, style.dim, elapsed, width));
        for (const entry of row_.history ?? []) out.push(line(`      ${style.yellow('↻')} `, entry, style.dim, '', width));
        if (!run) break;
        const tools = run?.tools ?? [];
        out.push(line('      ', standardPhrase(tools), style.italic, style.dim(`${plural(tools.length, 'ferramenta', 'ferramentas')} ${showTools ? '▾' : '▸'}`), width));
        if (showTools) {
          const shown = tools.slice(-TOOLS_SHOWN);
          if (tools.length > shown.length) out.push(`        ${style.dim(`… ${tools.length - shown.length} anteriores`)}`);
          for (const tool of shown) {
            const mark = tool.ok === null ? style.accent(spin) : tool.ok ? style.green('✓') : style.red('✗');
            out.push(line(`        ${mark}${style.dim(` ${tool.name.padEnd(6)} `)}`, tool.target, style.dim, '', width));
          }
        }
      } else {
        out.push(line(`    ${style.accent(spin)} ${style.bold(label)}`, row_.hint ?? '', style.dim, style.dim(`${row_.gate} · ${elapsed}`), width));
      }
      break;
    }
    case 'waiting':
      out.push(line(`    ${style.yellow('⏸')} ${label}`, 'espera o saldo', style.yellow, '', width));
      break;
    case 'pending':
      out.push(line(`    ${style.dim('◌')} ${style.dim(label)}`, row_.hint ?? '', style.dim, style.dim(row_.gate ?? ''), width));
      break;
  }
  return out;
}

/** O que o desenho pode recolher num terminal baixo, do mais ao menos dispensável. */
interface Layout {
  tools: boolean;
  doneStages: boolean;
  /** Pendentes mostrados; o resto vira "+N na fila". */
  pending: number;
  /** Concluídos mostrados; o resto vira "+N concluídos". */
  done: number;
  /** As duas linhas abaixo de um item que aguarda você. */
  humanDetail: boolean;
  /** Linhas vazias em volta do item ativo. */
  blanks: boolean;
}

export interface PanelFrame {
  readings: BalanceReading[];
  /** Linhas da saída de hoje (o log da fila), para o terminal baixo demais. */
  log: string[];
  now: number;
}

/**
 * O que a fila faz sem item em andamento: a abertura (commit do `.mabel/`, a base trazida
 * para a integração) ou a escolha do próximo item. O texto é a última
 * linha do log da fila; o tempo conta do último registro no banco.
 */
interface Preparing {
  label: string;
  hint: string;
  since: number;
}

/** Última linha com texto do log, sem o cabeçalho da fila nem as cores. */
function lastLogLine(log: string[]): string {
  for (let i = log.length - 1; i >= 0; i--) {
    const text = (log[i] ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (text && !text.startsWith('── mabel ')) return text;
  }
  return '';
}

function preparing(state: PanelState, view: PanelView, frame_: PanelFrame): Preparing | null {
  if (state.ended || view.question || state.items.some((item) => IN_PROGRESS.includes(item.status))) return null;
  const opening = !state.items.some((item) => item.touched);
  return {
    label: opening ? 'abrindo a fila' : 'próximo item',
    hint: lastLogLine(frame_.log),
    since: state.lastAt ?? state.started ?? frame_.now,
  };
}

/** Corpo do painel (entre o cabeçalho e o rodapé) num layout. */
function body(state: PanelState, layout: Layout, style: ScreenStyle, width: number, now: number, prep: Preparing | null = null): string[] {
  const spin = SPINNER[Math.floor(now / 100) % SPINNER.length] as string;
  const items = panelItems(state);
  const done = items.filter((item) => CONCLUDED.includes(item.status) && item.doneAt !== null).sort((a, b) => (a.doneAt as number) - (b.doneAt as number));
  const out: string[] = [];

  const shownDone = done.slice(done.length - Math.min(layout.done, done.length));
  const hiddenDone = done.length - shownDone.length;
  if (hiddenDone > 0) out.push(`   ${style.dim(`+${plural(hiddenDone, 'concluído', 'concluídos')}`)}`);
  for (const item of shownDone) {
    out.push(line(` ${style.green('✓')} ${style.dim(`#${item.number}  `)}`, item.title, (text) => text, style.dim(`${formatDuration(item.activeMs)} · ${money(itemCost(item))}`), width));
    if (layout.doneStages) {
      for (const stage of stageRows(state, item, now)) out.push(...stageLines(stage, style, width, now, spin, false));
    }
  }

  if (prep) {
    const elapsed = formatDuration(Math.max(0, now - prep.since));
    out.push(line(` ${style.accent(spin)} ${style.bold(prep.label.padEnd(LABEL_WIDTH + 3))}`, prep.hint, style.dim, elapsed, width));
  }

  const rest = items.filter((item) => !done.includes(item));
  const pendingItems = rest.filter((item) => !IN_PROGRESS.includes(item.status) && !item.touched);
  const shownPending = new Set(pendingItems.slice(0, layout.pending).map((item) => item.number));
  for (const item of rest) {
    if (item.status === 'needs_human') {
      out.push(line(` ${style.yellow('⏸')} ${style.dim(`#${item.number}  `)}`, item.title, (text) => text, style.yellow('aguardando você'), width));
      if (layout.humanDetail) {
        out.push(line('      ', item.reason ?? 'pendência na inbox', style.dim, '', width));
        out.push(line('      ', '"Decidir agora", na barra abaixo, responde e devolve o item à fila', style.dim, '', width));
      }
    } else if (IN_PROGRESS.includes(item.status)) {
      if (layout.blanks) out.push('');
      out.push(line(` ${style.accent('●')} ${style.dim(`#${item.number}  `)}`, item.title, style.bold, style.dim(`${formatDuration(itemElapsed(item, now))} · ${money(itemCost(item))}`), width));
      for (const stage of stageRows(state, item, now)) out.push(...stageLines(stage, style, width, now, spin, layout.tools));
      if (layout.blanks) out.push('');
    } else if (item.status === 'failed' || item.status === 'blocked' || item.status === 'cancelled') {
      const label = { failed: 'falhou', blocked: 'bloqueado', cancelled: 'cancelado' }[item.status];
      out.push(line(` ${style.red('✗')} ${style.dim(`#${item.number}  `)}`, item.title, (text) => text, style.red(label), width));
      if (layout.humanDetail && item.reason) out.push(line('      ', item.reason, style.dim, '', width));
    } else if (item.status === 'planned' && state.phase === 'plan' && item.touched) {
      const planning = item.runs.filter((run) => run.stage === 'plan');
      const cost = planning.reduce((total, run) => total + run.cost, 0);
      out.push(line(` ${style.green('✓')} ${style.dim(`#${item.number}  `)}`, item.title, (text) => text, style.dim(`plano aceito · ${formatDuration(item.activeMs)} · ${money(cost)}`), width));
    } else if (shownPending.has(item.number) || item.touched) {
      const right = item.status === 'planned' ? 'planejado' : state.phase === 'plan' ? 'a planejar' : '';
      out.push(line(` ${style.dim('◌')} `, `#${item.number}  ${item.title}`, style.dim, style.dim(right), width));
    }
  }
  const hiddenPending = pendingItems.length - shownPending.size;
  if (hiddenPending > 0) out.push(`   ${style.dim(`+${hiddenPending} na fila`)}`);

  if (state.ended) {
    const fresh = done.length;
    const waiting = waitingYou(state).length;
    const total = items.reduce((sum, item) => sum + itemCost(item), 0);
    const parts = [plural(fresh, 'concluído', 'concluídos'), ...(waiting ? [`${waiting} aguardando você`] : []), money(total)];
    out.push('');
    out.push(line(` ${style.bold('Fila encerrada')}`, ` · ${parts.join(' · ')}`, style.dim, '', width));
    const reason = state.ended.end === 'paused' ? state.pause : state.ended.end === 'empty' || state.ended.end === 'once' ? null : (QUEUE_ENDINGS[state.ended.end as QueueEnd] ?? state.ended.end);
    if (reason) out.push(line('   ', reason, style.yellow, '', width));
  }
  return out;
}

/** Linhas fixas embaixo: avisos, a barra de ações, as teclas e o saldo. */
function footerLines(state: PanelState, view: PanelView, frame_: PanelFrame, style: ScreenStyle, width: number): string[] {
  const out: string[] = [];
  if (view.question) out.push(line(` ${style.yellow('⏸')} `, capitalize(view.question.notice), style.yellow, '', width));
  else if (state.wait && !state.ended) {
    const until = state.wait.until;
    const detail = `${capitalize(state.wait.detail)}${until ? `. Retoma às ${clock(until)}` : ''}`;
    const left = until ? style.yellow(`faltam ${formatDuration(Math.max(0, until - frame_.now))}`) : '';
    out.push(line(` ${style.yellow('⏸')} `, detail, style.yellow, left, width));
  }
  if (view.interrupting && !state.ended) out.push(line(` ${style.yellow('■')} `, 'Interrompendo: a run em andamento para e a fila encerra.', style.yellow, '', width));
  else if (view.stopRequested && !state.ended) out.push(line(` ${style.yellow('■')} `, 'Parada pedida: a fila encerra depois da etapa em andamento.', style.yellow, '', width));
  out.push(style.dim('─'.repeat(Math.max(0, width - 1))));
  const actions = panelActions(state, view);
  const selected = Math.min(view.selected, actions.length - 1);
  const bar = actions.map((action, index) => (index === selected ? style.accent(style.bold(`[${action.label}]`)) : style.dim(` ${action.label} `))).join(' ');
  out.push(clip(` ${bar}`, Math.max(1, width - 1)));
  out.push(panelHints(state, view).map(([key, action]) => `${style.accent(` ${key}`)}${style.dim(` ${action} `)}`).join(''));
  const paint = { good: style.green, warn: style.yellow, bad: style.red, dim: style.dim };
  out.push(renderBalanceFooter(frame_.readings, new Date(frame_.now), width - 1, paint));
  return out;
}

/**
 * O painel em `height` linhas. Terminal baixo recolhe nesta ordem: ferramentas abertas,
 * pendentes ("+N na fila"), concluídos; o item ativo e o rodapé nunca são cortados. Abaixo
 * do mínimo, volta o log de hoje, com a barra de ações embaixo.
 */
export function renderPanel(state: PanelState, view: PanelView, frame_: PanelFrame, style: ScreenStyle, width = 88, height = 30): string[] {
  const now = frame_.now;
  const items = panelItems(state);
  const doneCount = items.filter((item) => CONCLUDED.includes(item.status) && item.doneAt !== null).length;
  const phase = state.phase === 'plan' ? 'planejamento' : 'execução';
  const header = [
    line(` ${style.bold('mabel')}${style.dim(` · ${state.project} · `)}`, phase, style.bold, style.dim(`fila ${doneCount}/${items.length} · ${clock(now)}`), width),
    style.dim('─'.repeat(Math.max(0, width - 1))),
  ];
  const foot = footerLines(state, view, frame_, style, width);
  const room = height - header.length - foot.length;

  const pendingTotal = items.filter((item) => !IN_PROGRESS.includes(item.status) && !item.touched).length;
  const doneTotal = doneCount;
  const layouts: Layout[] = [];
  const full: Layout = { tools: view.tools, doneStages: view.done, pending: pendingTotal, done: Math.min(DONE_SHOWN, doneTotal), humanDetail: true, blanks: true };
  layouts.push(full, { ...full, tools: false });
  for (let pending = pendingTotal - 1; pending >= 0; pending--) layouts.push({ ...full, tools: false, pending });
  layouts.push({ ...full, tools: false, pending: 0, doneStages: false });
  for (let done = full.done - 1; done >= 0; done--) layouts.push({ ...full, tools: false, pending: 0, doneStages: false, done });
  layouts.push({ tools: false, doneStages: false, pending: 0, done: 0, humanDetail: false, blanks: true });
  layouts.push({ tools: false, doneStages: false, pending: 0, done: 0, humanDetail: false, blanks: false });

  const prep = preparing(state, view, frame_);
  for (const layout of layouts) {
    const lines = body(state, layout, style, width, now, prep);
    if (lines.length <= room) return [...header, ...lines, ...Array.from({ length: room - lines.length }, () => ''), ...foot];
  }

  // Não cabe: o log de hoje, com a barra de ações (e a pergunta, se houver) embaixo.
  const bar = foot.slice(Math.max(0, foot.length - 4), foot.length - 1);
  const notices = view.question ? foot.slice(0, 1) : [];
  const keep = [...notices, ...bar];
  const logRows = Math.max(0, height - keep.length);
  const tail = frame_.log.slice(-logRows).map((text) => fit(text, Math.max(1, width - 1)));
  if (logRows === 0) return keep.slice(-height);
  return [...tail, ...Array.from({ length: logRows - tail.length }, () => ''), ...keep];
}

/** Onde o item parou, para o resumo da fila interrompida. */
const STATUS_WORDS: Partial<Record<ItemStatus, string>> = {
  ready: 'pronto',
  planning: 'planejando',
  planned: 'planejado',
  executing: 'executando',
  verifying: 'verificando',
  reviewing: 'revisando',
  cancelled: 'cancelado',
};

/**
 * O que fica na rolagem quando o painel fecha: uma linha por item que a fila tocou e o
 * encerramento.
 */
export function panelSummary(state: PanelState, style: ScreenStyle, width: number): string[] {
  const out: string[] = [];
  for (const item of panelItems(state).filter((entry) => entry.touched)) {
    if (CONCLUDED.includes(item.status)) {
      out.push(line(` ${style.green('✓')} ${style.dim(`#${item.number}  `)}`, item.title, (text) => text, style.dim(`${formatDuration(item.activeMs)} · ${money(itemCost(item))}`), width));
    } else if (item.status === 'needs_human') {
      out.push(line(` ${style.yellow('⏸')} ${style.dim(`#${item.number}  `)}`, item.title, (text) => text, style.yellow('aguardando você'), width));
    } else if (item.status === 'failed' || item.status === 'blocked') {
      out.push(line(` ${style.red('✗')} ${style.dim(`#${item.number}  `)}`, item.title, (text) => text, style.red(item.status === 'failed' ? 'falhou' : 'bloqueado'), width));
    } else {
      out.push(line(` ${style.accent('●')} ${style.dim(`#${item.number}  `)}`, item.title, (text) => text, style.dim(STATUS_WORDS[item.status] ?? item.status), width));
    }
  }
  return out;
}
