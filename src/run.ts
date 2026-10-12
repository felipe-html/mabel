import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { confirm, interactive as isInteractive } from './ask.ts';
import { type BalanceReading, balanceOf, checkBalance, formatReset, latestReadings } from './balance.ts';
import { dataDir, openDb } from './db.ts';
import { ToolLog, summaryLine } from './exec.ts';
import { formatCost, formatDuration } from './format.ts';
import { inboxSession, pendingItems, terminalIO } from './inbox.ts';
import { type Item, type ItemStatus, getItemById, listItems, syncBacklog, transition } from './items.ts';
import { LockError, acquireLock } from './lock.ts';
import { type AdvanceResult, advanceItem, autonomousDecisions } from './pipeline.ts';
import { type Project, ProjectError, mabelCommitted, resolveProject } from './project.ts';
import { type RunHandle, type RunStage, startRun } from './runner.ts';
import { probeRequest } from './status.ts';
import { style } from './style.ts';
import { isMerged, removeWorktree } from './worktree.ts';

export const runUsage = 'mabel run [--item <n>] [--uma]';

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
  /** Perguntas no terminal (saldo); fora do TTY, a política decide sozinha. */
  interactive?: boolean;
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

const STAGE_LABELS: Record<RunStage, string> = { plan: 'planejar', execute: 'executar', review: 'revisar' };
const IN_PROGRESS: ItemStatus[] = ['planning', 'executing', 'verifying', 'reviewing'];
const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7 dias' };

/** Consome a fila do projeto. `interrupt` repassa o ctrl+c à run atual e encerra o laço. */
export function startQueue(options: QueueOptions): { interrupt: () => void; done: Promise<QueueResult> } {
  const { db, home, project } = options;
  const clock = options.clock ?? systemClock;
  const interactive = options.interactive ?? false;
  const abort = new AbortController();
  const log = new ToolLog(project.root, '    ');
  let current: RunHandle | undefined;
  let currentStage: RunStage | undefined;
  let pauseReason: string | undefined;
  // Autorizações dadas no terminal valem até o reset da janela autorizada.
  const approvedUntil = new Map<string, number>();

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
  const ensureBalance = async (): Promise<boolean> => {
    let probed = false;
    for (;;) {
      if (abort.signal.aborted) return false;
      const readings = latestReadings(db);
      const decision = checkBalance(readings, clock.now());
      if (decision.action === 'proceed') return true;
      if (decision.action === 'refresh') {
        if (probed) {
          pauseReason = 'sem leitura de saldo depois da chamada mínima; fila pausada';
          return false;
        }
        probed = true;
        if (!(await probe())) return false;
        continue;
      }
      const reading = readings.find((r) => r.window === decision.window) as BalanceReading;
      const resetsAt = reading.resetsAt.getTime();
      if ((approvedUntil.get(decision.window) ?? 0) >= resetsAt) return true;
      const percent = `${Math.round(decision.balance * 100)}%`;
      const label = WINDOW_LABELS[decision.window];
      log.write(style.bold(`  Saldo da janela de ${label} em ${percent} (abaixo de 30%).`));
      if (interactive && (await confirm('  Continuar mesmo assim?', false))) {
        approvedUntil.set(decision.window, resetsAt);
        return true;
      }
      if (decision.window === 'seven_day') {
        pauseReason = `saldo da janela de 7 dias em ${percent}; fila pausada até sua decisão`;
        return false;
      }
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
    await waitUntil(target, 'o reset do saldo');
  };

  const env = {
    db,
    home,
    project,
    log: (line: string) => log.write(line),
    beforeAgentStage: async (stage: RunStage, item: Item) => {
      if (!(await ensureBalance())) return false;
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

  const loop = async (): Promise<{ end: QueueEnd; message?: string }> => {
    for (;;) {
      if (abort.signal.aborted) return { end: 'interrupted' };

      // Itens cuja branch já entrou na base: concluídos.
      for (const item of listItems(db, project.id)) {
        if (item.status === 'awaiting_merge' && item.branch && isMerged(project, item.branch)) {
          transition(db, project, item.id, 'done', `merge de ${item.branch} na ${project.config.baseBranch}`);
          log.write(`#${item.number} ${item.title}: awaiting_merge → done`);
          removeWorktree(db, project, item);
          finalStates.set(item.number, 'done');
        }
      }
      for (const warning of syncBacklog(db, project).warnings) log.write(style.dim(warning));

      const items = listItems(db, project.id);
      const inProgress = items.find((item) => IN_PROGRESS.includes(item.status));
      let target: Item | undefined;
      if (inProgress) {
        target = inProgress;
      } else if (options.itemNumber !== undefined) {
        if (finalStates.has(options.itemNumber)) return { end: 'once' };
        target = items.find((item) => item.number === options.itemNumber);
        if (!target) return { end: 'not_found', message: `Item #${options.itemNumber} não existe.` };
        if (target.status !== 'ready') {
          return { end: 'not_found', message: `Item #${target.number} está em ${target.status}, não em ready.` };
        }
      } else {
        target = items.find((item) => item.status === 'ready');
      }
      if (!target) return { end: 'empty' };

      log.setCwd(target.worktree ?? project.root);
      const result: AdvanceResult = await advanceItem(env, target.id);
      current = undefined;
      log.flush();
      finalStates.set(target.number, getItemById(db, target.id).status);

      if (result.kind === 'interrupted') return { end: 'interrupted' };
      if (result.kind === 'paused') return { end: abort.signal.aborted ? 'interrupted' : 'paused', message: pauseReason };
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

export function renderQueueSummary(result: QueueResult): string {
  const counts = new Map<ItemStatus, number>();
  for (const status of result.finalStates.values()) counts.set(status, (counts.get(status) ?? 0) + 1);
  const states = [...counts].map(([status, count]) => `${status} ${count}`).join(' · ') || 'nenhum item processado';
  const endings: Record<QueueEnd, string> = {
    empty: 'fila vazia',
    once: 'concluído',
    interrupted: 'interrompido',
    paused: 'pausado',
    not_found: 'nada a fazer',
  };
  const lines = [`■ ${endings[result.end]} · ${states} · ${formatCost(result.costUsd)} · ${formatDuration(result.elapsedMs)}`];
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
    ({ values } = parseArgs({ args, options: { item: { type: 'string' }, uma: { type: 'boolean' } } }));
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
  try {
    const project = resolveProject(db);
    if (!mabelCommitted(project.root, project.config.baseBranch)) {
      process.stderr.write(
        `O .mabel/ não está commitado na branch ${project.config.baseBranch}; os worktrees dos itens nasceriam sem ele.\n` +
          'Rode `mabel init` para commitar, ou `git add .mabel && git commit -m "mabel init" -- .mabel`.\n',
      );
      return 1;
    }
    release = acquireLock(home, project.id);
    const interactive = isInteractive();
    // run → inbox → run: com itens aguardando, o humano responde e a fila segue sem sair.
    for (;;) {
      const queue = startQueue({ db, home, project, itemNumber, once: values.uma, interactive });
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
      if (!(await confirm(`\n${label}. Abrir a inbox agora?`))) return 0;
      process.stdout.write('\n');
      if (!(await inboxSession(db, home, project, terminalIO))) return 0;
      process.stdout.write('\n');
    }
  } catch (error) {
    if (error instanceof ProjectError || error instanceof LockError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    release?.();
    db.close();
  }
}
