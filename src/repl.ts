import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { Interrupted } from './ask.ts';
import { type Command, commands } from './commands.ts';
import { dataDir } from './db.ts';
import { redrawFooter, startFooter } from './footer.ts';
import {
  ArgsError,
  type CommandSpec,
  type LineContext,
  type LineState,
  type Suggestion,
  initialLine,
  lineStep,
  renderBelow,
  splitArgs,
} from './line.ts';
import type { Key } from './menu.ts';
import type { ValueOption, ValueSource } from './options.ts';
import { ProjectError, gitRoot, readConfig } from './project.ts';
import { paint, style } from './style.ts';
import { valuesFor } from './values.ts';

export const HISTORY_LIMIT = 500;

const replCommands = (): Command[] => commands.filter((command) => !command.shellOnly);

export function replSuggestions(): Suggestion[] {
  return [
    ...replCommands().map(({ name, description, plannedStep }) => ({ name, description, plannedStep })),
    { name: 'sair', description: 'Fecha o Mabel' },
  ];
}

export function replCommandSpecs(): Record<string, CommandSpec> {
  return Object.fromEntries(replCommands().map(({ name, options, args }) => [name, { options, args }]));
}

/** Valores lidos uma vez por linha: o banco não é aberto a cada tecla. */
export function cachedValues(read: (source: ValueSource) => ValueOption[] = valuesFor): (source: ValueSource) => ValueOption[] {
  const cache = new Map<ValueSource, ValueOption[]>();
  return (source) => {
    const cached = cache.get(source);
    if (cached) return cached;
    const values = read(source);
    cache.set(source, values);
    return values;
  };
}

// Histórico ------------------------------------------------------------------------------

export function historyPath(home: string = dataDir()): string {
  return join(home, 'historico');
}

export function loadHistory(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_LIMIT);
}

/** Acrescenta a linha ao histórico, sem repetir a anterior, e mantém as últimas `HISTORY_LIMIT`. */
export function pushHistory(history: string[], line: string): string[] {
  if (!line || history.at(-1) === line) return history;
  return [...history, line].slice(-HISTORY_LIMIT);
}

function saveHistory(path: string, history: string[]): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, history.length > 0 ? `${history.join('\n')}\n` : '');
  } catch {
    // Histórico é conveniência: falha ao gravar não interrompe o Mabel.
  }
}

// Local ----------------------------------------------------------------------------------

export interface Location {
  /** Nome do projeto Mabel, quando o cwd está dentro de um. */
  project?: string;
  /** Aviso exibido quando não há projeto. */
  notice?: string;
}

export function locate(cwd: string = process.cwd()): Location {
  const root = gitRoot(cwd);
  if (!root) return { notice: 'Fora de um repositório git. Rode git init aqui ou abra o Mabel num projeto.' };
  try {
    if (readConfig(root)) return { project: basename(root) };
  } catch (error) {
    if (error instanceof ProjectError) return { notice: error.message };
    throw error;
  }
  return { notice: 'Este repositório ainda não é um projeto Mabel. Digite /init.' };
}

export function promptText(location: Location, failed: boolean): string {
  const name = location.project ? ` · ${location.project}` : '';
  const mark = failed ? ` ${paint.bad('✗')}` : '';
  return `${style.accent(`mabel${name}`)}${mark} ${style.accent('›')} `;
}

// Linha de comando -----------------------------------------------------------------------

export type Parsed =
  | { kind: 'empty' }
  | { kind: 'exit' }
  | { kind: 'message'; text: string }
  | { kind: 'command'; command: Command; args: string[] };

/** Interpreta a linha digitada no modo Mabel. */
export function parseLine(line: string): Parsed {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'empty' };
  if (trimmed === 'exit') return { kind: 'exit' };
  if (!trimmed.startsWith('/')) return { kind: 'message', text: 'Comandos começam com /. Digite / para ver a lista.' };

  let words: string[];
  try {
    words = splitArgs(trimmed.slice(1));
  } catch (error) {
    if (error instanceof ArgsError) return { kind: 'message', text: error.message };
    throw error;
  }
  const [name = '', ...args] = words;
  if (name === 'sair') return { kind: 'exit' };
  const command = replCommands().find((candidate) => candidate.name === name);
  if (!command) return { kind: 'message', text: `Comando desconhecido: /${name}. Digite / para ver os comandos.` };
  if (!command.run) {
    return { kind: 'message', text: `/${command.name} ainda não implementado (passo ${command.plannedStep} do plano).` };
  }
  return { kind: 'command', command, args };
}

// Terminal -------------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*m/g;
const visibleLength = (text: string) => text.replace(ANSI, '').length;

type ReadResult = { line: string } | { exit: true };

/** Lê uma linha com o editor do Mabel. Deixa o terminal em modo normal ao terminar. */
function readLine(prompt: string, context: LineContext): Promise<ReadResult> {
  const { stdin, stdout } = process;
  let state: LineState = initialLine(context);
  let cursorRow = 0;
  const promptWidth = visibleLength(prompt);

  const draw = (current: LineState, below: boolean) => {
    const columns = Math.max(stdout.columns || 80, 20);
    const lines = below ? renderBelow(current, context, style, columns) : [];
    const end = promptWidth + current.text.length;
    const textRows = Math.floor(end / columns) + 1;
    // Texto que termina exatamente na borda: força a linha seguinte para manter as contas.
    const wrap = end > 0 && end % columns === 0 ? '\r\n' : '';
    let out = cursorRow > 0 ? `\x1b[${cursorRow}A` : '';
    out += `\r\x1b[0J${prompt}${current.text}${wrap}`;
    for (const line of lines) out += `\n${line}`;
    const endRow = textRows - 1 + lines.length;
    const target = promptWidth + current.cursor;
    cursorRow = Math.floor(target / columns);
    if (endRow > cursorRow) out += `\x1b[${endRow - cursorRow}A`;
    out += `\x1b[${(target % columns) + 1}G`;
    stdout.write(out);
    redrawFooter();
    return textRows;
  };

  return new Promise((resolve) => {
    const finish = (result: ReadResult) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      const textRows = draw({ ...state, cursor: state.text.length, message: undefined }, false);
      stdout.write(`${'\n'.repeat(Math.max(0, textRows - 1 - cursorRow))}\r\n`);
      resolve(result);
    };
    const onKey = (_: string, key: Key = {}) => {
      const step = lineStep(state, key, context);
      if ('submit' in step) return finish({ line: step.submit });
      if ('exit' in step) return finish({ exit: true });
      state = step.state;
      draw(state, true);
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    draw(state, true);
  });
}

/** Garante o terminal em modo normal se o processo sair no meio da edição. */
function restoreTerminal(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h');
}

async function runCommand(command: Command, args: string[]): Promise<number> {
  // Sem este listener, um ctrl+c num comando que não trata SIGINT encerraria o Mabel.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    if (args.length === 0 && command.promptArgs) args = await command.promptArgs();
    return await (command.run as NonNullable<Command['run']>)(args);
  } catch (error) {
    if (error instanceof Interrupted) {
      process.stdout.write(`${style.dim('interrompido')}\n`);
      return 130;
    }
    process.stderr.write(`${paint.bad(`Erro em /${command.name}: ${(error as Error).message}`)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', ignore);
    restoreTerminal();
  }
}

/** Modo Mabel: laço de prompt com comandos `/`. Exige stdin e stdout interativos. */
export async function repl(): Promise<number> {
  const path = historyPath();
  const context: LineContext = { suggestions: replSuggestions(), commandSpecs: replCommandSpecs(), history: loadHistory(path) };
  let failed = false;
  let lastNotice: string | undefined;
  process.on('exit', restoreTerminal);
  const stopFooter = startFooter();
  process.stdout.write(`${style.dim('Digite / para ver os comandos · exit para sair')}\n\n`);

  try {
    for (;;) {
      const location = locate();
      if (location.notice && location.notice !== lastNotice) process.stdout.write(`${style.dim(location.notice)}\n`);
      lastNotice = location.notice;

      context.values = cachedValues();
      const result = await readLine(promptText(location, failed), context);
      if ('exit' in result) return 0;
      context.history = pushHistory(context.history, result.line.trim());
      saveHistory(path, context.history);

      const parsed = parseLine(result.line);
      if (parsed.kind === 'exit') return 0;
      if (parsed.kind === 'empty') continue;
      if (parsed.kind === 'message') {
        process.stdout.write(`${parsed.text}\n`);
        failed = true;
        continue;
      }
      const code = await runCommand(parsed.command, parsed.args);
      failed = code !== 0;
      process.stdout.write('\n');
    }
  } finally {
    stopFooter();
    process.off('exit', restoreTerminal);
    restoreTerminal();
  }
}
