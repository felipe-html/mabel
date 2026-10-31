import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Interrupted, interactive } from './ask.ts';
import { terminalGuided } from './guided.ts';
import { dataDir, openDb } from './db.ts';
import { formatCost, formatDuration, formatTokens, truncate } from './format.ts';
import { type RunOutcome, type RunRequest, startRun } from './runner.ts';
import { toolTarget } from './stream.ts';
import { style } from './style.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';

export const execUsage =
  'mabel exec "<prompt>" [--model <m>] [--max-turns <n>] [--max-budget-usd <x>] [--allowed-tools <a,b>] [--cwd <dir>]';

export const execOptions = {
  model: { type: 'string', value: '<m>', description: 'Modelo do Claude Code (sonnet, opus, haiku…)' },
  'max-turns': { type: 'string', value: '<n>', description: 'Limite de turnos do agente' },
  'max-budget-usd': { type: 'string', value: '<x>', description: 'Limite de custo em dólares' },
  'allowed-tools': { type: 'string', value: '<a,b>', description: 'Ferramentas liberadas, separadas por vírgula' },
  cwd: { type: 'string', value: '<dir>', values: 'diretorio', description: 'Diretório em que o agente roda (padrão: o atual)' },
} satisfies OptionSpecs;

export const execArgs: ArgSpec[] = [{ name: '"<prompt>"', description: 'O pedido ao agente' }];

/** Converte os argumentos de `mabel exec` num pedido de run, ou devolve a mensagem de erro. */
export function parseExecArgs(args: string[], baseCwd = process.cwd()): RunRequest | string {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: execOptions,
    });
  } catch (error) {
    return (error as Error).message;
  }
  const { values, positionals } = parsed;

  const prompt = positionals.join(' ').trim();
  if (!prompt) return 'Informe o prompt.';

  const request: RunRequest = { kind: 'exec', prompt, cwd: resolve(baseCwd, values.cwd ?? '.') };
  if (!statSync(request.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    return `Diretório não encontrado: ${request.cwd}`;
  }
  if (values.model) request.model = values.model;
  if (values['max-turns'] !== undefined) {
    const turns = Number(values['max-turns']);
    if (!Number.isInteger(turns) || turns < 1) return '--max-turns precisa ser um inteiro positivo.';
    request.maxTurns = turns;
  }
  if (values['max-budget-usd'] !== undefined) {
    const budget = Number(values['max-budget-usd']);
    if (!Number.isFinite(budget) || budget <= 0) return '--max-budget-usd precisa ser um número positivo.';
    request.maxBudgetUsd = budget;
  }
  if (values['allowed-tools'] !== undefined) {
    const tools = values['allowed-tools']
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean);
    if (tools.length > 0) request.allowedTools = tools;
  }
  return request;
}

/** Alvo exibido: relativo ao cwd quando está dentro dele, primeira linha, truncado. */
export function displayTarget(input: unknown, cwd: string, width: number): string {
  let target = toolTarget(input).split('\n')[0] ?? '';
  if (isAbsolute(target) && target.startsWith(cwd + sep)) target = relative(cwd, target);
  return truncate(target, width);
}

function statusHead(outcome: RunOutcome): string {
  if (outcome.status === 'succeeded') return '✓ concluída';
  if (outcome.status === 'interrupted') return '■ interrompida';
  return `✗ falhou: ${outcome.error ?? 'erro desconhecido'}`;
}

export function summaryLine(outcome: RunOutcome): string {
  const { totals } = outcome;
  const parts = [statusHead(outcome)];
  if (totals?.numTurns !== undefined) parts.push(`${totals.numTurns} ${totals.numTurns === 1 ? 'turno' : 'turnos'}`);
  parts.push(formatDuration(outcome.durationMs));
  if (totals?.costUsd !== undefined) parts.push(formatCost(totals.costUsd));
  if (totals?.inputTokens !== undefined) {
    const input = totals.inputTokens + (totals.cacheReadTokens ?? 0) + (totals.cacheCreationTokens ?? 0);
    parts.push(`${formatTokens(input)} tokens de entrada`);
  }
  if (totals?.outputTokens !== undefined) parts.push(`${formatTokens(totals.outputTokens)} de saída`);
  return parts.join(' · ');
}

/**
 * Linhas de chamada de ferramenta. No TTY a linha aparece na chamada e recebe ✓/✗ no
 * resultado; fora dele é impressa só quando fecha, para a saída ser estável.
 */
export class ToolLog {
  private readonly tty = Boolean(process.stdout.isTTY);
  private readonly open = new Map<string, { text: string; line: number }>();
  private cwd: string;
  private readonly indent: string;
  private written = 0;

  constructor(cwd: string, indent = '  ') {
    this.cwd = cwd;
    this.indent = indent;
  }

  private format(name: string, input: unknown): string {
    const columns = process.stdout.columns ?? 100;
    const width = Math.max(20, Math.min(40, columns - 20 - this.indent.length));
    return `${this.indent}→ ${name.padEnd(6)} ${displayTarget(input, this.cwd, width).padEnd(width)}`;
  }

  /** Diretório usado para mostrar caminhos relativos (o worktree da etapa atual). */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  write(text: string): void {
    process.stdout.write(`${text}\n`);
    this.written += text.split('\n').length;
  }

  use(id: string, name: string, input: unknown): void {
    const text = this.format(name, input);
    this.open.set(id, { text, line: this.written });
    if (this.tty) this.write(style.dim(text));
  }

  close(id: string, isError: boolean): void {
    const entry = this.open.get(id);
    if (!entry) return;
    this.open.delete(id);
    const text = `${entry.text} ${isError ? '✗' : '✓'}`;
    if (!this.tty) return this.write(text);
    const up = this.written - entry.line;
    process.stdout.write(`\x1b[${up}A\r\x1b[2K${text}\x1b[${up}B\r`);
  }

  /** Chamadas sem resultado (run interrompida, por exemplo). */
  flush(): void {
    for (const [id, entry] of this.open) {
      if (!this.tty) this.write(`${entry.text} ·`);
      this.open.delete(id);
    }
  }
}

/** Uma run da conversa: o que o `exec` mostra durante ela fica a cargo de quem a roda. */
export interface ChatIO {
  turn(request: RunRequest): Promise<RunOutcome>;
  /** Próxima mensagem; `null` encerra a sessão. Ctrl+C lança `Interrupted`. */
  read(): Promise<string | null>;
  write(text: string): void;
}

export const chatHint = 'Continue a conversa; esc encerra.';

/** Linha curta depois de cada resposta da conversa. */
export function turnLine(outcome: RunOutcome): string {
  const parts = [statusHead(outcome), formatDuration(outcome.durationMs)];
  if (outcome.totals?.costUsd !== undefined) parts.push(formatCost(outcome.totals.costUsd));
  return style.dim(parts.join(' · '));
}

/** Total da sessão, mostrado quando ela é encerrada. */
export function sessionLine(outcomes: RunOutcome[]): string {
  const sum = (pick: (outcome: RunOutcome) => number | undefined) =>
    outcomes.reduce((total, outcome) => total + (pick(outcome) ?? 0), 0);
  const parts = [
    '■ sessão encerrada',
    `${outcomes.length} ${outcomes.length === 1 ? 'mensagem' : 'mensagens'}`,
    formatDuration(sum((outcome) => outcome.durationMs)),
    formatCost(sum((outcome) => outcome.totals?.costUsd)),
  ];
  const input = sum(
    ({ totals }) => (totals?.inputTokens ?? 0) + (totals?.cacheReadTokens ?? 0) + (totals?.cacheCreationTokens ?? 0),
  );
  parts.push(`${formatTokens(input)} tokens de entrada`);
  parts.push(`${formatTokens(sum((outcome) => outcome.totals?.outputTokens))} de saída`);
  return parts.join(' · ');
}

/**
 * Conversa a partir da primeira resposta: cada mensagem é uma run nova que retoma a sessão
 * do claude. Encerra só com esc no campo da mensagem ou o orçamento da sessão esgotado.
 */
export async function chat(request: RunRequest, first: RunOutcome, io: ChatIO): Promise<RunOutcome[]> {
  const outcomes = [first];
  let sessionId = first.sessionId;
  io.write(`\n${turnLine(first)}`);
  if (!sessionId) io.write('A sessão não chegou a começar: a próxima mensagem abre uma nova.');
  io.write(style.dim(chatHint));

  while (true) {
    let remaining: number | undefined;
    if (request.maxBudgetUsd !== undefined) {
      remaining = request.maxBudgetUsd - outcomes.reduce((total, outcome) => total + (outcome.totals?.costUsd ?? 0), 0);
      if (remaining <= 0) {
        io.write(`Orçamento da sessão esgotado (${formatCost(request.maxBudgetUsd)}).`);
        break;
      }
    }

    let message: string | null;
    try {
      message = await io.read();
    } catch (error) {
      if (!(error instanceof Interrupted)) throw error;
      io.write(style.dim(chatHint));
      continue;
    }
    if (message === null) break;
    if (!message) continue;

    const next: RunRequest = { ...request, prompt: message };
    if (sessionId) next.resumeSessionId = sessionId;
    if (remaining !== undefined) next.maxBudgetUsd = remaining;
    const outcome = await io.turn(next);
    outcomes.push(outcome);
    io.write(`\n${turnLine(outcome)}`);
    sessionId = outcome.sessionId ?? sessionId;
    if (!sessionId) io.write('A sessão não chegou a começar: a próxima mensagem abre uma nova.');
  }

  io.write(`\n${sessionLine(outcomes)}`);
  return outcomes;
}

export async function exec(args: string[]): Promise<number> {
  const request = parseExecArgs(args);
  if (typeof request === 'string') {
    process.stderr.write(`${request}\nUso: ${execUsage}\n`);
    return 1;
  }

  const log = new ToolLog(request.cwd);
  let headerPrinted = false;
  const printHeader = (runId: string, model: string | undefined) => {
    if (headerPrinted) return;
    headerPrinted = true;
    const where = `${model ?? request.model ?? '?'}  ·  ${request.cwd}`;
    log.write(style.bold(`▸ run ${runId.slice(0, 4)}…  ·  ${where}`));
  };

  const home = dataDir();
  let db: ReturnType<typeof openDb> | undefined;
  const turn = async (turnRequest: RunRequest): Promise<RunOutcome> => {
    let runId = '';
    db ??= openDb(home);
    const handle = startRun(db, home, turnRequest, {
      onInit: ({ model }) => printHeader(runId, model),
      onToolUse: (call) => log.use(call.id, call.name, call.input),
      onToolResult: (result) => log.close(result.id, result.isError),
    });
    runId = handle.runId;

    process.on('SIGINT', handle.interrupt);
    let outcome: RunOutcome;
    try {
      outcome = await handle.done;
    } finally {
      process.off('SIGINT', handle.interrupt);
    }

    printHeader(runId, outcome.model ?? undefined);
    log.flush();
    const text = outcome.totals?.text?.trim();
    if (text) process.stdout.write(`${text}\n`);
    return outcome;
  };

  let first: RunOutcome;
  try {
    first = await turn(request);
  } catch (error) {
    process.stderr.write(
      `Não foi possível gravar o registro da run em ${home}: ${(error as Error).message}\n` +
        'O claude não foi iniciado.\n',
    );
    return 1;
  }

  if (!interactive()) {
    process.stdout.write(`\n${summaryLine(first)}\n`);
    if (first.status === 'succeeded') return 0;
    return first.status === 'interrupted' ? 130 : 1;
  }

  await chat(request, first, {
    turn,
    read: () => terminalGuided.text('Mensagem', { placeholder: 'continue a conversa' }),
    write: (text) => log.write(text),
  });
  return 0;
}

/** Pede o pedido num campo de texto, para o `exec` escolhido no menu; `null` quando o usuário volta. */
export async function askPrompt(): Promise<string[] | null> {
  const prompt = await terminalGuided.text('Pedido', { placeholder: 'o que o agente deve fazer' });
  return prompt ? [prompt] : null;
}
