import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { confirm, interactive as isInteractive } from './ask.ts';
import {
  type BalanceReading,
  balanceOf,
  checkBalance,
  formatReset,
  latestReadings,
  stageEstimate,
} from './balance.ts';
import { dataDir, openDb } from './db.ts';
import { ToolLog, summaryLine } from './exec.ts';
import { startFooter } from './footer.ts';
import { formatCost, formatDuration } from './format.ts';
import { inboxSession, pendingItems, runInbox, terminalIO } from './inbox.ts';
import { type Item, type ItemStatus, getItemById, listItems, syncBacklog, transition } from './items.ts';
import { type Notify, notify as systemNotify } from './notify.ts';
import { finishIntegrated, openIntegration } from './integration.ts';
import { writeIntegrationReport } from './report.ts';
import { LockError, acquireLock } from './lock.ts';
import { type AdvanceResult, advanceItem, autonomousDecisions } from './pipeline.ts';
import { type Project, ProjectError, mabelCommitted, resolveProject } from './project.ts';
import { type RunHandle, type RunStage, startRun } from './runner.ts';
import { sandboxUnavailable } from './sandbox.ts';
import { probeRequest } from './status.ts';
import { style } from './style.ts';
import { deleteBranch, isMerged, removeOrphanWorktrees, removeWorktree } from './worktree.ts';

export const runUsage = 'mabel run [--item <n>] [--uma] [--sem-lote]';

/** Relógio injetável: os testes avançam o tempo sem esperar de verdade. */
export interface Clock {
  now: () => Date;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done);
    }),
};

export interface QueueOptions {
  db: DatabaseSync;
  home: string;
  project: Project;
  itemNumber?: number;
  once?: boolean;
  clock?: Clock;
  /** Perguntas no terminal (saldo, inbox); fora do TTY, a política decide sozinha. */
  interactive?: boolean;
  /**
   * Planeja todos os itens `ready` antes de executar o primeiro (padrão). `--item` e `--uma`
   * implicam item a item.
   */
  batch?: boolean;
  /** Pergunta sim/não no terminal; os testes trocam por respostas roteirizadas. */
  confirm?: (question: string, defaultYes?: boolean) => Promise<boolean>;
  /** Abre a inbox no fim da fase de planejamento; sem ela, a oferta não acontece. */
  inbox?: () => Promise<void>;
  /** Aviso do sistema quando a fila para ou espera o humano. */
  notify?: Notify;
}

export type QueueEnd = 'empty' | 'once' | 'interrupted' | 'paused' | 'not_found';

export interface QueueResult {
  end: QueueEnd;
  message?: string;
  /** Estado final de cada item processado nesta execução. */
  finalStates: Map<number, ItemStatus>;
  costUsd: number;
  elapsedMs: number;
  /** Perguntas respondidas pela sugestão nesta execução (gate `autonomy`). */
  autonomous: { number: number; decision: string }[];
}

/**
 * Auditoria da fila fora das runs: `pause` encerra o `run` até o humano agir, `wait` é a
 * espera que retoma sozinha (até `until`) e `answer` é a resposta do humano a uma pergunta
 * da política de saldo (`approved`: seguir mesmo assim).
 */
export type QueueEventKind = 'pause' | 'wait' | 'answer';
export type QueueEventCause = 'five_hour' | 'seven_day' | 'pace' | 'no_reading' | 'usage_limit' | 'integration' | 'context';

export interface QueueEvent {
  at: Date;
  kind: QueueEventKind;
  cause: QueueEventCause;
  detail: string;
  until?: Date;
  approved?: boolean;
}

export function recordQueueEvent(db: DatabaseSync, projectId: string, event: QueueEvent): void {
  db.prepare(
    'INSERT INTO queue_events (project_id, at, kind, cause, detail, until, approved) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    projectId,
    event.at.toISOString(),
    event.kind,
    event.cause,
    event.detail,
    event.until?.toISOString() ?? null,
    event.approved === undefined ? null : Number(event.approved),
  );
}

/** Os `limit` eventos mais recentes do projeto, em ordem cronológica. */
export function listQueueEvents(db: DatabaseSync, projectId: string, limit = 20): QueueEvent[] {
  const rows = db
    .prepare('SELECT at, kind, cause, detail, until, approved FROM queue_events WHERE project_id = ? ORDER BY id DESC LIMIT ?')
    .all(projectId, limit) as {
    at: string;
    kind: QueueEventKind;
    cause: QueueEventCause;
    detail: string;
    until: string | null;
    approved: number | null;
  }[];
  return rows.reverse().map((row) => ({
    at: new Date(row.at),
    kind: row.kind,
    cause: row.cause,
    detail: row.detail,
    ...(row.until === null ? {} : { until: new Date(row.until) }),
    ...(row.approved === null ? {} : { approved: row.approved === 1 }),
  }));
}

const STAGE_LABELS: Record<RunStage, string> = { refine: 'refinar', plan: 'planejar', execute: 'executar', review: 'revisar' };
const IN_PROGRESS: ItemStatus[] = ['planning', 'executing', 'verifying', 'reviewing'];
const PLANNING: ItemStatus[] = ['ready', 'planning'];
const EXECUTING: ItemStatus[] = ['planned', 'executing', 'verifying', 'reviewing'];

const countItems = (count: number) => (count === 1 ? '1 item' : `${count} itens`);
const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7 dias' };

/** Consome a fila do projeto. `interrupt` repassa o ctrl+c à run atual e encerra o laço. */
export function startQueue(options: QueueOptions): { interrupt: () => void; done: Promise<QueueResult> } {
  const { db, home, project } = options;
  const clock = options.clock ?? systemClock;
  const interactive = options.interactive ?? false;
  const ask = options.confirm ?? confirm;
  const batch = (options.batch ?? true) && options.itemNumber === undefined && !options.once;
  const notify = options.notify ?? systemNotify;
  const title = notifyTitle(project);
  /** Pergunta no terminal: avisa antes, porque a fila fica parada até a resposta. */
  const askHuman = (question: string, defaultYes?: boolean, notice = question.trim()) => {
    notify(title, `aguardando você: ${notice}`);
    return ask(question, defaultYes);
  };
  const abort = new AbortController();
  const log = new ToolLog(project.root, '    ');
  let current: RunHandle | undefined;
  let currentStage: RunStage | undefined;
  let pauseReason: string | undefined;
  // Autorizações dadas no terminal valem até o reset da janela autorizada.
  const approvedUntil = new Map<string, number>();
  const record = (event: Omit<QueueEvent, 'at'>) => recordQueueEvent(db, project.id, { at: clock.now(), ...event });
  /** Pergunta da política de saldo; a resposta do humano fica na auditoria. */
  const askBalance = async (cause: QueueEventCause, notice: string): Promise<boolean> => {
    const approved = await askHuman('  Continuar mesmo assim?', false, notice);
    record({ kind: 'answer', cause, detail: notice, approved });
    return approved;
  };

  const interrupt = () => {
    abort.abort();
    current?.interrupt();
  };

  const waitUntil = async (target: Date, label: string) => {
    log.write(style.dim(`  Aguardando ${label} (${formatReset(target, clock.now())})…`));
    while (!abort.signal.aborted && clock.now().getTime() < target.getTime()) {
      const remaining = target.getTime() - clock.now().getTime();
      if (process.stdout.isTTY) {
        process.stdout.write(`\r\x1b[2K  ${style.dim(`faltam ${formatDuration(remaining)}`)}`);
      }
      await clock.sleep(Math.min(remaining, process.stdout.isTTY ? 1000 : 60_000), abort.signal);
    }
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
  };

  const probe = async (): Promise<boolean> => {
    log.write(style.dim('  Atualizando o saldo com uma chamada mínima (haiku)…'));
    current = startRun(db, home, probeRequest(home));
    const outcome = await current.done;
    current = undefined;
    log.write(style.dim(`  ${summaryLine(outcome)}`));
    return outcome.status !== 'interrupted';
  };

  /** Política de saldo do contrato, antes de cada etapa com agente. */
  const ensureBalance = async (stage: RunStage): Promise<boolean> => {
    let probed = false;
    const estimate = stageEstimate(db, stage);
    for (;;) {
      if (abort.signal.aborted) return false;
      const readings = latestReadings(db);
      const decision = checkBalance(readings, clock.now(), estimate);
      if (decision.action === 'proceed') return true;
      if (decision.action === 'refresh') {
        if (probed) {
          pauseReason = 'sem leitura de saldo depois da chamada mínima; fila pausada';
          record({ kind: 'pause', cause: 'no_reading', detail: pauseReason });
          return false;
        }
        probed = true;
        if (!(await probe())) return false;
        continue;
      }
      const fiveHour = readings.find((r) => r.window === 'five_hour') as BalanceReading;
      if (decision.action === 'pace') {
        // A autorização para seguir acima do ritmo vale até o reset da janela de 5h em curso.
        if ((approvedUntil.get('pace') ?? 0) >= fiveHour.resetsAt.getTime()) return true;
        const used = `${Math.round(decision.used * 100)}%`;
        const expected = `${Math.round(decision.expected * 100)}%`;
        log.write(style.bold(`  Janela de 7 dias acima do ritmo: ${used} usados depois da etapa, ritmo de ${expected}.`));
        const notice = `7 dias acima do ritmo (${used} usados, ritmo de ${expected}); continuar mesmo assim?`;
        if (interactive && (await askBalance('pace', notice))) {
          approvedUntil.set('pace', fiveHour.resetsAt.getTime());
          return true;
        }
        record({ kind: 'wait', cause: 'pace', detail: `7 dias acima do ritmo (${used} usados, ritmo de ${expected})`, until: decision.caughtUpAt });
        await waitUntil(decision.caughtUpAt, 'o ritmo da janela de 7 dias');
        probed = false;
        continue;
      }
      const reading = readings.find((r) => r.window === decision.window) as BalanceReading;
      const resetsAt = reading.resetsAt.getTime();
      if ((approvedUntil.get(decision.window) ?? 0) >= resetsAt) return true;
      const percent = `${Math.round(decision.balance * 100)}%`;
      const label = WINDOW_LABELS[decision.window];
      const why =
        decision.estimate === undefined
          ? 'abaixo de 30%'
          : `a etapa costuma usar ${Math.round(decision.estimate * 100)}% e o piso é 10%`;
      log.write(style.bold(`  Saldo da janela de ${label} em ${percent} (${why}).`));
      if (interactive && (await askBalance(decision.window, `saldo de ${label} em ${percent}; continuar mesmo assim?`))) {
        approvedUntil.set(decision.window, resetsAt);
        return true;
      }
      if (decision.window === 'seven_day') {
        pauseReason = `saldo da janela de 7 dias em ${percent}; fila pausada até sua decisão`;
        record({ kind: 'pause', cause: 'seven_day', detail: `${pauseReason} (${why})` });
        return false;
      }
      record({ kind: 'wait', cause: 'five_hour', detail: `saldo da janela de 5h em ${percent} (${why})`, until: reading.resetsAt });
      await waitUntil(reading.resetsAt, 'o reset da janela de 5h');
      probed = false;
    }
  };

  /** Saldo esgotado no meio da etapa: espera o reset da janela mais usada. */
  const waitForReset = async () => {
    const readings = latestReadings(db);
    const worst = [...readings].sort((a, b) => balanceOf(a) - balanceOf(b))[0];
    const now = clock.now().getTime();
    const target = worst && worst.resetsAt.getTime() > now ? worst.resetsAt : new Date(now + 5 * 60_000);
    log.write(style.bold('  Saldo esgotado durante a etapa; a etapa será retomada pela mesma sessão.'));
    record({ kind: 'wait', cause: 'usage_limit', detail: 'saldo esgotado durante a etapa', until: target });
    await waitUntil(target, 'o reset do saldo');
  };

  const env = {
    db,
    home,
    project,
    log: (line: string) => log.write(line),
    beforeAgentStage: async (stage: RunStage, item: Item) => {
      if (!(await ensureBalance(stage))) return false;
      currentStage = stage;
      if (item.worktree) log.setCwd(item.worktree);
      return true;
    },
    onStart: (handle: RunHandle) => {
      current = handle;
    },
    observer: {
      onInit: ({ model }: { model?: string }) =>
        log.write(style.dim(`  ▸ ${currentStage ? STAGE_LABELS[currentStage] : 'run'} · ${model ?? '?'}`)),
      onToolUse: (call: { id: string; name: string; input: unknown }) => log.use(call.id, call.name, call.input),
      onToolResult: (result: { id: string; isError: boolean }) => log.close(result.id, result.isError),
    },
  };

  const startedAt = new Date();
  const finalStates = new Map<number, ItemStatus>();
  let phase: 'plan' | 'execute' | undefined;
  let inboxOffered = false;

  /** Separador ao trocar de fase no lote: `── planejamento (3 itens) ──`. */
  const enterPhase = (next: 'plan' | 'execute', items: Item[]) => {
    if (phase === next) return;
    phase = next;
    const states = next === 'plan' ? PLANNING : EXECUTING;
    const count = items.filter((item) => states.includes(item.status)).length;
    log.write(style.dim(`── ${next === 'plan' ? 'planejamento' : 'execução'} (${countItems(count)}) ──`));
  };

  /** Fim da fase de planejamento: oferece a inbox uma vez, se há itens aguardando. */
  const offerInbox = async (): Promise<boolean> => {
    if (inboxOffered || !interactive || !options.inbox) return false;
    const waiting = pendingItems(db, project.id).length;
    if (waiting === 0) return false;
    inboxOffered = true;
    log.flush();
    const label = waiting === 1 ? '1 item aguarda você' : `${waiting} itens aguardam você`;
    if (!(await askHuman(`\n${label}. Abrir a inbox agora?`))) return false;
    await options.inbox();
    return true;
  };

  /** Próximo item da fila e se ele para em `planned`; `undefined` quando a fila acabou. */
  const pick = async (items: Item[]): Promise<{ target: Item; until?: 'planned' } | { end: QueueEnd; message?: string }> => {
    const inProgress = items.find((item) => IN_PROGRESS.includes(item.status));
    if (options.itemNumber !== undefined && !inProgress) {
      if (finalStates.has(options.itemNumber)) return { end: 'once' };
      const target = items.find((item) => item.number === options.itemNumber);
      if (!target) return { end: 'not_found', message: `Item #${options.itemNumber} não existe.` };
      if (target.status !== 'ready' && target.status !== 'planned') {
        return { end: 'not_found', message: `Item #${target.number} está em ${target.status}, não em ready nem em planned.` };
      }
      return { target };
    }
    if (!batch) {
      // Item a item: o planejado (aprovado, por exemplo) antes do próximo `ready`.
      const target = inProgress ?? items.find((item) => item.status === 'planned') ?? items.find((item) => item.status === 'ready');
      return target ? { target } : { end: 'empty' };
    }
    const planning = inProgress ?? items.find((item) => item.status === 'ready');
    if (planning) return PLANNING.includes(planning.status) ? { target: planning, until: 'planned' } : { target: planning };
    if (await offerInbox()) return pick(listItems(db, project.id));
    const planned = items.find((item) => item.status === 'planned');
    return planned ? { target: planned } : { end: 'empty' };
  };

  /**
   * Abertura do `run`: prepara a integração (pode pausar a fila) e limpa os worktrees que
   * sobraram de itens que já não precisam deles.
   */
  const open = (): string | undefined => {
    const opened = openIntegration(home, project);
    for (const note of opened.notes) log.write(style.dim(note));
    if (opened.pause) {
      record({ kind: 'pause', cause: 'integration', detail: opened.pause });
      return opened.pause;
    }
    const cleaned = removeOrphanWorktrees(db, home, project, listItems(db, project.id));
    if (cleaned.length > 0) log.write(style.dim(`worktrees removidos: ${cleaned.map((n) => `#${n}`).join(', ')}`));
    finishIntegrated(db, project, listItems(db, project.id)).forEach(markDone);
    writeIntegrationReport(db, home, project);
    return undefined;
  };

  const markDone = (item: Item) => {
    log.write(`#${item.number} ${item.title}: awaiting_merge → done`);
    finalStates.set(item.number, 'done');
  };

  const loop = async (): Promise<{ end: QueueEnd; message?: string }> => {
    const paused = open();
    if (paused) return { end: 'paused', message: paused };
    for (;;) {
      if (abort.signal.aborted) return { end: 'interrupted' };

      // Itens cujo merge já entrou na base: concluídos.
      finishIntegrated(db, project, listItems(db, project.id)).forEach(markDone);
      for (const item of listItems(db, project.id)) {
        if (item.status === 'awaiting_merge' && !item.integratedCommit && item.branch && isMerged(project, item.branch)) {
          transition(db, project, item.id, 'done', `merge de ${item.branch} na ${project.config.baseBranch}`);
          log.write(`#${item.number} ${item.title}: awaiting_merge → done`);
          removeWorktree(db, project, item);
          const warning = deleteBranch(project, item.branch);
          if (warning) log.write(style.dim(`#${item.number}: ${warning}`));
          finalStates.set(item.number, 'done');
        }
      }
      for (const warning of syncBacklog(db, project).warnings) log.write(style.dim(warning));

      const items = listItems(db, project.id);
      const next = await pick(items);
      if ('end' in next) return next;
      const { target, until } = next;
      if (abort.signal.aborted) return { end: 'interrupted' };
      if (batch) enterPhase(until ? 'plan' : 'execute', listItems(db, project.id));

      log.setCwd(target.worktree ?? project.root);
      const result: AdvanceResult = await advanceItem(env, target.id, { until });
      current = undefined;
      log.flush();
      finalStates.set(target.number, getItemById(db, target.id).status);

      if (result.kind === 'interrupted') return { end: 'interrupted' };
      if (result.kind === 'paused') {
        // A pausa do pipeline (contexto acima do orçamento); as do saldo já foram gravadas.
        if (result.reason && !abort.signal.aborted) record({ kind: 'pause', cause: 'context', detail: result.reason });
        return { end: abort.signal.aborted ? 'interrupted' : 'paused', message: result.reason ?? pauseReason };
      }
      if (result.kind === 'usage_limit') {
        await waitForReset();
        continue;
      }
      if (options.once || options.itemNumber !== undefined) return { end: 'once' };
    }
  };

  const done = loop().then(({ end, message }) => {
    const cost = db
      .prepare('SELECT coalesce(sum(cost_usd), 0) AS total FROM runs WHERE started_at >= ?')
      .get(startedAt.toISOString()) as { total: number };
    if (end === 'empty' || end === 'once') notify(title, queueStatusLine(end, finalStates));
    else if (end === 'paused') notify(title, message ?? 'fila pausada');
    return {
      end,
      message,
      finalStates,
      costUsd: cost.total,
      elapsedMs: Date.now() - startedAt.getTime(),
      autonomous: autonomousDecisions(db, { projectId: project.id, since: startedAt }),
    };
  });
  return { interrupt, done };
}

export function notifyTitle(project: Project): string {
  return `Mabel · ${project.name}`;
}

const ENDINGS: Record<QueueEnd, string> = {
  empty: 'fila vazia',
  once: 'concluído',
  interrupted: 'interrompido',
  paused: 'pausado',
  not_found: 'nada a fazer',
};

/** Fim da fila e estados finais, sem custo e tempo: `fila vazia · awaiting_merge 3 · needs_human 1`. */
export function queueStatusLine(end: QueueEnd, finalStates: Map<number, ItemStatus>): string {
  const counts = new Map<ItemStatus, number>();
  for (const status of finalStates.values()) counts.set(status, (counts.get(status) ?? 0) + 1);
  const states = [...counts].map(([status, count]) => `${status} ${count}`).join(' · ') || 'nenhum item processado';
  return `${ENDINGS[end]} · ${states}`;
}

export function renderQueueSummary(result: QueueResult): string {
  const lines = [
    `■ ${queueStatusLine(result.end, result.finalStates)} · ${formatCost(result.costUsd)} · ${formatDuration(result.elapsedMs)}`,
  ];
  if (result.message) lines.push(result.message);
  if (result.autonomous.length > 0) {
    lines.push('', 'Decididas pela sugestão (revise no merge):');
    for (const { number, decision } of result.autonomous) lines.push(`  #${number} ${decision}`);
  }
  return lines.join('\n');
}

export async function run(args: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: { item: { type: 'string' }, uma: { type: 'boolean' }, 'sem-lote': { type: 'boolean' } },
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${runUsage}\n`);
    return 1;
  }
  let itemNumber: number | undefined;
  if (values.item !== undefined) {
    itemNumber = Number(values.item.replace(/^#/, ''));
    if (!Number.isInteger(itemNumber) || itemNumber < 1) {
      process.stderr.write(`--item precisa ser o número de um item.\nUso: ${runUsage}\n`);
      return 1;
    }
  }

  const home = dataDir();
  const db = openDb(home);
  let release: (() => void) | undefined;
  let stopFooter: (() => void) | undefined;
  try {
    const project = resolveProject(db);
    if (!mabelCommitted(project.root, project.config.baseBranch)) {
      process.stderr.write(
        `O .mabel/ não está commitado na branch ${project.config.baseBranch}; os worktrees dos itens nasceriam sem ele.\n` +
          'Rode `mabel init` para commitar, ou `git add .mabel && git commit -m "mabel init" -- .mabel`.\n',
      );
      return 1;
    }
    if (project.config.sandbox) {
      const unavailable = sandboxUnavailable();
      if (unavailable) {
        process.stderr.write(
          `Sandbox indisponível: ${unavailable}. O Mabel não roda etapas sem ele.\n` +
            'Instale o que falta ou, por sua conta, ponha "sandbox": false no .mabel/config.json.\n',
        );
        return 1;
      }
    } else {
      process.stdout.write(
        `${style.bold('Aviso:')} "sandbox": false no .mabel/config.json; o terminal do agente roda sem confinamento nem filtro de rede.\n`,
      );
    }
    release = acquireLock(home, project.id);
    const interactive = isInteractive();
    if (interactive) stopFooter = startFooter();
    // run → inbox → run: com itens aguardando, o humano responde e a fila segue sem sair.
    for (;;) {
      const queue = startQueue({
        db,
        home,
        project,
        itemNumber,
        once: values.uma,
        batch: !values['sem-lote'],
        interactive,
        inbox: async () => {
          process.stdout.write('\n');
          await runInbox(db, home, project, terminalIO);
          process.stdout.write('\n');
        },
      });
      const onSigint = () => queue.interrupt();
      process.on('SIGINT', onSigint);
      let result: QueueResult;
      try {
        result = await queue.done;
      } finally {
        process.off('SIGINT', onSigint);
      }
      process.stdout.write(`\n${renderQueueSummary(result)}\n`);
      if (result.end === 'interrupted') return 130;
      if (result.end === 'not_found') return 1;
      const waiting = pendingItems(db, project.id).length;
      if (!interactive || waiting === 0) return 0;
      const label = waiting === 1 ? '1 item aguarda você' : `${waiting} itens aguardam você`;
      const question = `${label}. Abrir a inbox agora?`;
      const waitingFor = (text: string) => systemNotify(notifyTitle(project), `aguardando você: ${text}`);
      waitingFor(question);
      if (!(await confirm(`\n${question}`))) return 0;
      process.stdout.write('\n');
      if (!(await inboxSession(db, home, project, terminalIO, waitingFor))) return 0;
      process.stdout.write('\n');
    }
  } catch (error) {
    if (error instanceof ProjectError || error instanceof LockError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    stopFooter?.();
    release?.();
    db.close();
  }
}
