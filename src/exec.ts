import { statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { ask } from './ask.ts';
import { dataDir, openDb } from './db.ts';
import { formatCost, formatDuration, formatTokens, truncate } from './format.ts';
import { type RunOutcome, type RunRequest, startRun } from './runner.ts';
import { toolTarget } from './stream.ts';
import { style } from './style.ts';

export const execUsage =
  'mabel exec "<prompt>" [--model <m>] [--max-turns <n>] [--max-budget-usd <x>] [--allowed-tools <a,b>] [--cwd <dir>]';

/** Converte os argumentos de `mabel exec` num pedido de run, ou devolve a mensagem de erro. */
export function parseExecArgs(args: string[], baseCwd = process.cwd()): RunRequest | string {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        model: { type: 'string' },
        'max-turns': { type: 'string' },
        'max-budget-usd': { type: 'string' },
        'allowed-tools': { type: 'string' },
        cwd: { type: 'string' },
      },
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

export function summaryLine(outcome: RunOutcome): string {
  const { totals } = outcome;
  const head =
    outcome.status === 'succeeded'
      ? '✓ concluída'
      : outcome.status === 'interrupted'
        ? '■ interrompida'
        : `✗ falhou: ${outcome.error ?? 'erro desconhecido'}`;
  const parts = [head];
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

export async function exec(args: string[]): Promise<number> {
  const request = parseExecArgs(args);
  if (typeof request === 'string') {
    process.stderr.write(`${request}\nUso: ${execUsage}\n`);
    return 1;
  }

  const log = new ToolLog(request.cwd);
  let runId = '';
  let headerPrinted = false;
  const printHeader = (model: string | undefined) => {
    if (headerPrinted) return;
    headerPrinted = true;
    const where = `${model ?? request.model ?? '?'}  ·  ${request.cwd}`;
    log.write(style.bold(`▸ run ${runId.slice(0, 4)}…  ·  ${where}`));
  };

  const home = dataDir();
  let handle;
  try {
    handle = startRun(openDb(home), home, request, {
      onInit: ({ model }) => printHeader(model),
      onToolUse: (call) => log.use(call.id, call.name, call.input),
      onToolResult: (result) => log.close(result.id, result.isError),
    });
  } catch (error) {
    process.stderr.write(
      `Não foi possível gravar o registro da run em ${home}: ${(error as Error).message}\n` +
        'O claude não foi iniciado.\n',
    );
    return 1;
  }
  runId = handle.runId;

  process.on('SIGINT', handle.interrupt);
  let outcome: RunOutcome;
  try {
    outcome = await handle.done;
  } finally {
    process.off('SIGINT', handle.interrupt);
  }

  printHeader(outcome.model ?? undefined);
  log.flush();
  const text = outcome.totals?.text?.trim();
  if (text) process.stdout.write(`${text}\n`);
  process.stdout.write(`\n${summaryLine(outcome)}\n`);

  if (outcome.status === 'succeeded') return 0;
  return outcome.status === 'interrupted' ? 130 : 1;
}

/** Pede o prompt numa linha de entrada, para o `exec` escolhido no menu. */
export async function askPrompt(): Promise<string[]> {
  const prompt = await ask(style.bold('Prompt: '));
  return prompt ? [prompt] : [];
}
