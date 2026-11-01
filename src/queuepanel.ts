import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { latestReadings } from './balance.ts';
import { dataDir, openDb, processAlive } from './db.ts';
import { leaveFullscreen, runScreen } from './menu.ts';
import {
  type PanelQuestion,
  type PanelScope,
  type PanelState,
  type PanelView,
  lastQueueStart,
  loadPanel,
  panelActions,
  panelStep,
  panelSummary,
  panelView,
  renderPanel,
} from './panel.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import { PANEL_ENV, runOptions } from './run.ts';
import { titleRows } from './screens.ts';
import { CLI, LOG_HEADER, NODE_ARGS, queueLogPath, queuesDir, readQueueState, requestStop } from './supervisor.ts';
import { style } from './style.ts';

/**
 * O painel da fila no terminal (`src/panel.ts` tem o estado e o desenho). No `rodar`, a fila
 * roda num processo filho, como a de segundo plano, com a saída de hoje no log da fila: a
 * verificação e a prova bloqueiam o processo que as roda, e o painel continua girando. As
 * perguntas da política de saldo chegam pelo canal do filho e viram itens da barra de ações.
 * No `acompanhar`, o painel lê a fila em segundo plano; sair dele não a para.
 */

export interface QueuePanelOptions {
  mode: PanelView['mode'];
  /** Argumentos do `rodar` (no `acompanhar`, os da fila em segundo plano). */
  args: string[];
  origin: PanelView['origin'];
}

/** Mensagens entre o `rodar` filho e o painel. */
export type ChildMessage = { tipo: 'pergunta'; aviso: string; acao: string; voltar: string } | { tipo: 'parada' };
export type PanelMessage = { tipo: 'resposta'; sim: boolean };

const POLL_MS = 500;
const TICK_MS = 100;
/** Fim do log lido para o terminal baixo demais. */
const LOG_TAIL_BYTES = 64 * 1024;

interface Ui {
  data: PanelState;
  view: PanelView;
  log: string[];
}

type Outcome = { kind: 'closed' } | { kind: 'detached' } | { kind: 'decide' } | { kind: 'failed' };

/** Últimas linhas do log a partir de `from` (o cabeçalho desta fila). */
function logTail(path: string, from: number): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(from, size - LOG_TAIL_BYTES);
  if (size <= start) return [];
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > from) lines.shift();
    return lines.map((line) => line.slice(line.lastIndexOf('\r') + 1));
  } finally {
    closeSync(fd);
  }
}

/** Encerramento da fila no log: do último "■ " ao fim. */
function endingLines(lines: string[]): string[] {
  const at = lines.findLastIndex((line) => line.startsWith('■ '));
  if (at < 0) return [];
  const out = lines.slice(at);
  while (out.length > 0 && out.at(-1)?.trim() === '') out.pop();
  return out;
}

function scopeOf(args: string[]): { scope: PanelScope; batch: boolean } {
  try {
    const { values } = parseArgs({ args, options: runOptions, strict: false });
    const scope: PanelScope = {};
    if (typeof values.item === 'string') scope.itemNumber = Number(values.item.replace(/^#/, ''));
    if (typeof values.limite === 'string') scope.limit = Number(values.limite);
    return { scope, batch: !values['sem-lote'] && scope.itemNumber === undefined };
  } catch {
    return { scope: {}, batch: true };
  }
}

/** Abre o painel; devolve o código de saída (o do `rodar` filho, no `rodar`). */
export async function queuePanel(options: QueuePanelOptions): Promise<number> {
  const home = dataDir();
  const db = openDb(home);
  let project: Project;
  try {
    project = resolveProject(db);
  } catch (error) {
    db.close();
    if (error instanceof ProjectError) {
      leaveFullscreen();
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  try {
    return await (options.mode === 'rodar' ? foreground(db, home, project, options) : attached(db, home, project, options));
  } finally {
    db.close();
  }
}

/** `rodar` no terminal: a fila num processo filho e o painel neste. */
async function foreground(db: DatabaseSync, home: string, project: Project, options: QueuePanelOptions): Promise<number> {
  const since = new Date().toISOString();
  mkdirSync(queuesDir(home), { recursive: true });
  const logPath = queueLogPath(home, project.id);
  const from = existsSync(logPath) ? statSync(logPath).size : 0;
  const fd = openSync(logPath, 'a');
  writeFileSync(fd, `\n${LOG_HEADER} ${options.args.join(' ')} · ${since} · neste terminal ──\n`);
  const child = spawn(process.execPath, [...NODE_ARGS, CLI, 'rodar', ...options.args], {
    cwd: process.cwd(),
    stdio: ['ignore', fd, fd, 'ipc'],
    env: { ...process.env, [PANEL_ENV]: '1' },
  });
  closeSync(fd);
  let exitCode: number | null | undefined;
  const exited = new Promise<number>((resolve) =>
    child.on('exit', (code, signal) => {
      exitCode = code ?? (signal ? 130 : 1);
      resolve(exitCode);
    }),
  );
  const { scope, batch } = scopeOf(options.args);
  const outcome = await panelLoop(db, home, project, options, { since, scope, batch, logPath, from, child, exited: () => exitCode !== undefined });
  const code = await exited;
  const lines = logTail(logPath, from);
  if (outcome.kind === 'failed') {
    // A fila nem começou (trava, sandbox, `.mabel/` sem commit): a saída do `rodar` explica.
    process.stdout.write(`${lines.filter((line) => !line.startsWith(LOG_HEADER)).join('\n').trim()}\n`);
  } else printSummary(outcome.state, options, endingLines(lines));
  return code;
}

/** `acompanhar` no terminal: o painel da fila em segundo plano. */
async function attached(db: DatabaseSync, home: string, project: Project, options: QueuePanelOptions): Promise<number> {
  const state = readQueueState(home, project.id);
  const logPath = queueLogPath(home, project.id);
  const running = () => {
    const current = readQueueState(home, project.id);
    return current !== undefined && current.desired === 'rodando' && processAlive(current.pid);
  };
  if (!state || !existsSync(logPath) || !running()) {
    leaveFullscreen();
    process.stdout.write('Nenhuma fila em segundo plano rodando neste projeto.\n');
    return 0;
  }
  const since = lastQueueStart(db, project.id) ?? state.startedAt;
  const { scope, batch } = scopeOf(state.args);
  const text = existsSync(logPath) ? statSync(logPath).size : 0;
  const outcome = await panelLoop(db, home, project, options, {
    since: since < state.startedAt ? state.startedAt : since,
    scope,
    batch,
    logPath,
    from: Math.max(0, text - LOG_TAIL_BYTES),
    exited: () => !running(),
  });
  if (outcome.kind === 'detached') {
    printSummary(outcome.state, options, [style.dim('Solto; a fila continua em segundo plano.')]);
  } else printSummary(outcome.state, options, endingLines(logTail(logPath, 0)));
  return 0;
}

interface Source {
  since: string;
  scope: PanelScope;
  batch: boolean;
  logPath: string;
  from: number;
  child?: ChildProcess;
  exited: () => boolean;
}

const TITLES = { rodar: 'Rodar a fila', acompanhar: 'Acompanhar a fila' };

/** O que fica na rolagem: o título, uma linha por item e o encerramento. */
function printSummary(state: PanelState, options: QueuePanelOptions, ending: string[]): void {
  const width = process.stdout.columns ?? 80;
  const lines = [...titleRows(TITLES[options.mode], style, width, `mabel ${options.mode}`), ...panelSummary(state, style, width)];
  if (ending.length > 0) lines.push('', ...ending.map((line) => ` ${line}`));
  process.stdout.write(`\n${lines.join('\n')}\n`);
}

/** O painel até a fila encerrar e o usuário sair (ou soltar, no `acompanhar`). */
async function panelLoop(db: DatabaseSync, home: string, project: Project, options: QueuePanelOptions, source: Source): Promise<Outcome & { state: PanelState }> {
  const load = () => loadPanel(db, home, project, source.scope, source.since, source.batch);
  let ui: Ui = { data: load(), view: panelView(options.mode, options.origin), log: logTail(source.logPath, source.from) };
  let readings = latestReadings(db);
  let lastPoll = Date.now();
  let question: PanelQuestion | null = null;
  let stopNotice = false;
  let finished = false;

  const child = source.child;
  const onMessage = (message: ChildMessage) => {
    if (message.tipo === 'pergunta') question = { notice: message.aviso, action: message.acao, back: message.voltar };
    else if (message.tipo === 'parada') stopNotice = true;
  };
  child?.on('message', onMessage);

  const answer = (yes: boolean) => {
    if (child?.connected) child.send({ tipo: 'resposta', sim: yes } satisfies PanelMessage);
    question = null;
  };
  const stop = () => {
    if (child) child.kill('SIGUSR2');
    else requestStop(home, project.id);
  };

  try {
    for (;;) {
      const outcome = await runScreen<Ui, Outcome>({
        state: ui,
        fullscreen: true,
        tick: {
          ms: TICK_MS,
          update: (current) => {
            const next = { ...current, view: { ...current.view } };
            const now = Date.now();
            const gone = source.exited();
            if (now - lastPoll >= POLL_MS || (gone && !finished)) {
              next.data = load();
              next.log = logTail(source.logPath, source.from);
              readings = latestReadings(db);
              lastPoll = now;
              if (gone) finished = true;
            }
            if (question && !next.view.question) next.view = { ...next.view, question, selected: 0 };
            if (stopNotice) next.view.stopRequested = true;
            ui = next;
            if (finished) {
              if (child && next.data.started === null) return { result: { kind: 'failed' } };
              if (next.view.interrupting) return { result: { kind: 'closed' } };
              // O processo saiu sem gravar o fim (caiu): a fila está encerrada mesmo assim.
              if (!next.data.ended) next.data = { ...next.data, ended: { at: now, end: 'error' } };
              next.view.question = null;
            }
            ui = next;
            return { state: next };
          },
        },
        interrupt: (current) => {
          if (!child || current.data.ended) return { result: { kind: current.data.ended ? 'closed' : 'detached' } };
          // Ctrl+C no `rodar`: a run em andamento é interrompida, e o painel volta quando a fila encerrar.
          child.kill('SIGINT');
          ui = { ...current, view: { ...current.view, interrupting: true } };
          return { state: ui };
        },
        step: (current, key) => {
          const step = panelStep(current.data, current.view, key);
          if ('view' in step) {
            ui = { ...current, view: step.view };
            return { state: ui };
          }
          const view = { ...current.view };
          switch (step.act) {
            case 'tools':
              view.tools = !view.tools;
              break;
            case 'done':
              view.done = !view.done;
              break;
            case 'stop':
              if (!view.stopRequested) stop();
              view.stopRequested = true;
              break;
            case 'answer_yes':
            case 'answer_no':
              answer(step.act === 'answer_yes');
              view.question = null;
              view.selected = 0;
              break;
            case 'decide':
              return { result: { kind: 'decide' } };
            case 'leave':
              return { result: { kind: current.data.ended ? 'closed' : 'detached' } };
          }
          view.selected = Math.min(view.selected, panelActions(current.data, view).length - 1);
          ui = { ...current, view };
          return { state: ui };
        },
        render: (current, width, height) => renderPanel(current.data, current.view, { readings, log: current.log, now: Date.now() }, style, width, height),
      });
      if (outcome.kind !== 'decide') {
        leaveFullscreen();
        return { ...outcome, state: ui.data };
      }
      // "Decidir as pendências" sobre o painel; a fila segue enquanto você decide.
      const { decideFlow, loadHomeContext } = await import('./home.ts');
      await decideFlow(loadHomeContext());
      ui = { ...ui, data: load() };
    }
  } finally {
    child?.off('message', onMessage);
  }
}
