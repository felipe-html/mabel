import { homedir } from 'node:os';
import { basename } from 'node:path';
import { Interrupted, headless } from './ask.ts';
import { type BalanceReading, latestReadings, renderBalanceFooter } from './balance.ts';
import { type Command, GROUP_TITLES, MENU_GROUPS, type MenuBadge, type MenuGroup, commands } from './commands.ts';
import { dataDir, openDb } from './db.ts';
import { startFooter } from './footer.ts';
import { commandScreen, loadScreenData } from './forms.ts';
import { type ChooseSettings, type GuidedIO, type TextSettings, itemChip } from './guided.ts';
import { baseConflictLines, pendingItems, pendingLabel, runInbox } from './inbox.ts';
import { type Item, boardItems, syncBacklog } from './items.ts';
import { type Key, leaveFullscreen, runScreen } from './menu.ts';
import { type Project, ProjectError, gitRoot, readConfig, resolveProject } from './project.ts';
import {
  type ChoiceConfig,
  type ChoiceOption,
  type ChoiceState,
  type FormConfig,
  type FormState,
  type FormValues,
  type Hint,
  type ListConfig,
  type ListState,
  type ScreenStyle,
  type TextState,
  TEXT_HINTS,
  choiceHints,
  choiceState,
  choiceStep,
  fit,
  formBody,
  formExit,
  formHints,
  formState,
  formStep,
  isEnter,
  isEscape,
  listBody,
  listHints,
  listRow,
  listState,
  listStep,
  renderChoice,
  renderKeys,
  renderText,
  row,
  scrollStep,
  scrollWindow,
  shellLine,
  shellRows,
  textState,
  textStep,
  titleRows,
  typed,
  viewStep,
  visibleLength,
  wrapLine,
} from './screens.ts';
import { queuePanel } from './queuepanel.ts';
import { paint, style } from './style.ts';
import { openUnits } from './units.ts';

/**
 * Tela inicial (`docs/specs/terminal.md`, aba "Comandos" do protótipo): o projeto, o que
 * espera por você, o filtro e a lista de comandos agrupada pela ordem do momento.
 */

// Contexto -------------------------------------------------------------------------------

export interface HomeContext {
  project: string;
  /** Caminho do projeto, com `~` no lugar da pasta pessoal. */
  path: string;
  /** O Mabel foi preparado aqui (há `.mabel/config.json`). */
  instance: boolean;
  ready: number;
  pending: number;
  units: number;
  /** Aviso no lugar das contagens (configuração inválida, banco indisponível). */
  notice?: string;
  /** Leituras de saldo para a linha do rodapé, e o instante em que foram lidas. */
  readings: BalanceReading[];
  now: Date;
}

const tilde = (path: string) => {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** Lê o projeto do diretório, as contagens e o saldo. Nunca lança: o que falha vira aviso. */
export function loadHomeContext(cwd: string = process.cwd()): HomeContext {
  const root = gitRoot(cwd);
  const base: HomeContext = { project: basename(root ?? cwd), path: tilde(root ?? cwd), instance: false, ready: 0, pending: 0, units: 0, readings: [], now: new Date() };
  let db;
  try {
    db = openDb(dataDir());
  } catch (error) {
    return { ...base, notice: `banco indisponível: ${(error as Error).message}` };
  }
  try {
    base.readings = latestReadings(db);
    if (!root) return base;
    try {
      if (!readConfig(root)) return base;
      const project = resolveProject(db, root);
      syncBacklog(db, project);
      const items = boardItems(db, project);
      return {
        ...base,
        project: project.name,
        instance: true,
        ready: items.filter((item) => item.status === 'ready').length,
        // O conflito da base que pausa a fila conta como uma pendência (`base_conflict`).
        pending: pendingItems(db, project.id).length + (baseConflictLines(db, project).length > 0 ? 1 : 0),
        units: project.config.integracao
          ? openUnits(db, project).length
          : items.filter((item) => item.status === 'awaiting_merge' && item.branch).length,
      };
    } catch (error) {
      if (error instanceof ProjectError) return { ...base, instance: true, notice: error.message };
      throw error;
    }
  } catch (error) {
    return { ...base, notice: (error as Error).message };
  } finally {
    db.close();
  }
}

// Lista ----------------------------------------------------------------------------------

export type HomeEntry = { head: MenuGroup } | { command: Command };

/** Decidir sobe quando há pendência; Rodar, quando há itens prontos. Começar só sem Mabel. */
export function groupOrder(context: HomeContext): MenuGroup[] {
  if (!context.instance) return ['comecar', 'acompanhar', 'avulso'];
  const first: MenuGroup[] = [];
  if (context.pending > 0) first.push('decidir');
  if (context.ready > 0) first.push('rodar');
  return [...first, ...MENU_GROUPS.filter((group) => group !== 'comecar' && !first.includes(group))];
}

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Cabeçalhos e comandos visíveis com o filtro, na ordem do momento. */
export function homeEntries(context: HomeContext, filter: string, list: Command[] = commands): HomeEntry[] {
  const needle = normalize(filter.trim());
  const out: HomeEntry[] = [];
  for (const group of groupOrder(context)) {
    const inGroup = list.filter((command) => {
      const menu = command.menu;
      if (!menu || menu.group !== group) return false;
      if (!context.instance && group !== 'comecar' && !menu.global) return false;
      return !needle || normalize(`${menu.title} ${command.name}`).includes(needle);
    });
    if (inGroup.length === 0) continue;
    out.push({ head: group });
    for (const command of inGroup) out.push({ command });
  }
  return out;
}

const commandsOf = (entries: HomeEntry[]) => entries.flatMap((entry) => ('command' in entry ? [entry.command] : []));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Contagem à direita do comando ("2 esperando", "2 prontos", "1 pronta"); vazia quando zero. */
export function badgeText(badge: MenuBadge | undefined, context: HomeContext): string {
  if (badge === 'ready' && context.ready > 0) return plural(context.ready, 'pronto', 'prontos');
  if (badge === 'pending' && context.pending > 0) return `${context.pending} esperando`;
  if (badge === 'units' && context.units > 0) return plural(context.units, 'pronta', 'prontas');
  return '';
}

// Estado e teclas ------------------------------------------------------------------------

export interface HomeState {
  filter: string;
  /** Posição entre os comandos visíveis. */
  cursor: number;
  /** Primeira linha da lista na tela. */
  scroll: number;
}

export type HomeStep = { state: HomeState } | { open: Command } | { exit: true };

/** Estado inicial, com o cursor no comando dado (o último aberto), se ele estiver na lista. */
export function homeState(context: HomeContext, selected?: string): HomeState {
  const cursor = commandsOf(homeEntries(context, '')).findIndex((command) => command.name === selected);
  return { filter: '', cursor: Math.max(0, cursor), scroll: 0 };
}

/** ↑ ↓ navegam, enter abre, digitar filtra, esc limpa o filtro (ou sai, com ele vazio). */
export function homeStep(context: HomeContext, state: HomeState, key: Key): HomeStep {
  const visible = commandsOf(homeEntries(context, state.filter));
  const move = (cursor: number): HomeStep => ({
    state: { ...state, cursor: visible.length === 0 ? 0 : (cursor + visible.length) % visible.length },
  });
  if (isEscape(key)) return state.filter ? { state: { ...state, filter: '', cursor: 0 } } : { exit: true };
  if (key.name === 'up') return move(state.cursor - 1);
  if (key.name === 'down') return move(state.cursor + 1);
  if (key.name === 'home') return move(0);
  if (key.name === 'end') return move(visible.length - 1);
  if (isEnter(key)) {
    const command = visible[state.cursor];
    return command ? { open: command } : { state };
  }
  if (key.name === 'backspace') return { state: { ...state, filter: state.filter.slice(0, -1), cursor: 0 } };
  const input = typed(key);
  if (input && (state.filter || input.trim())) return { state: { ...state, filter: state.filter + input, cursor: 0 } };
  return { state };
}

// Desenho --------------------------------------------------------------------------------

/** Abaixo disso some o nome no shell à direita; abaixo de `NARROW`, as contagens também. */
export const WIDE = 88;
export const NARROW = 60;
/** Linhas da tela fora da lista: topo, filtro, setas de rolagem, descrição e rodapé. */
const CHROME_ROWS = 14;
const MIN_LIST_ROWS = 3;

/** As duas linhas do topo: "mabel", o projeto e o caminho; o que espera por você. */
export function homeTop(context: HomeContext, style: ScreenStyle, width: number): string[] {
  const head = `  ${style.bold('mabel')}  ${context.project}`;
  const room = width - visibleLength(head) - 3;
  const path = room > 1 ? style.dim(` · ${fit(context.path, room)}`) : '';
  let facts: string;
  if (context.notice) facts = style.yellow(context.notice);
  else if (!context.instance) facts = style.yellow('sem Mabel neste diretório');
  else {
    const parts = [plural(context.ready, 'pronto', 'prontos')];
    if (context.pending > 0) parts.push(style.yellow(`${context.pending} esperando você`));
    if (context.units > 0) parts.push(style.green(plural(context.units, 'unidade pronta', 'unidades prontas')));
    facts = parts.join(style.dim(' · '));
  }
  return [`${head}${path}`, `  ${facts}`];
}

export function homeHints(state: HomeState): Hint[] {
  return [
    ['↑↓', 'navegar'],
    ['enter', 'abrir'],
    ['digite', 'filtra'],
    ['esc', state.filter ? 'limpa' : 'sai'],
  ];
}

/**
 * Rodapé: as teclas e, embaixo, a linha de saldo do rodapé fixo (saldo, reset, ritmo e idade
 * da leitura, como pede o contrato), que perde detalhes quando falta largura.
 */
export function footer(hints: Hint[], context: HomeContext, style: ScreenStyle, width: number): string[] {
  const paint = { good: style.green, warn: style.yellow, bad: style.red, dim: style.dim };
  return [...renderKeys(hints, style, width), renderBalanceFooter(context.readings, context.now, width - 1, paint)];
}

/** Desenha a tela inteira em `height` linhas e devolve a rolagem usada. */
export function renderHome(context: HomeContext, state: HomeState, style: ScreenStyle, width = 80, height = 24): { lines: string[]; scroll: number } {
  const entries = homeEntries(context, state.filter);
  const visible = commandsOf(entries);
  const cursor = Math.min(state.cursor, Math.max(0, visible.length - 1));
  const selected = visible[cursor];

  const lines = ['', ...homeTop(context, style, width), ''];
  lines.push(
    state.filter
      ? `${style.accent('  › ')}${style.bold(state.filter)}${style.accent('▏')}`
      : `${style.accent('  › ')}${style.accent('▏')}${style.dim('o que você quer fazer?')}`,
    '',
  );

  const listRows = Math.max(MIN_LIST_ROWS, height - CHROME_ROWS);
  const rows = entries.map((entry) => {
    if ('head' in entry) return `  ${style.dim(GROUP_TITLES[entry.head].toUpperCase())}`;
    const { command } = entry;
    const menu = command.menu as NonNullable<Command['menu']>;
    const on = command === selected;
    const badge = width >= NARROW ? badgeText(menu.badge, context) : '';
    const painted = badge ? (menu.group === 'decidir' ? style.yellow(badge) : style.green(badge)) : '';
    const shell = width >= WIDE ? style.dim(`mabel ${command.name}`) : '';
    const right = [painted, shell].filter(Boolean).join('   ');
    return listRow(on, on ? style.bold(menu.title) : menu.title, right, style, width);
  });

  // A linha do comando escolhido fica visível, com o cabeçalho do grupo quando cabe.
  const selectedRow = selected ? entries.findIndex((entry) => 'command' in entry && entry.command === selected) : 0;
  let scroll = state.scroll;
  if (selectedRow < scroll + 1) scroll = Math.max(0, selectedRow - 1);
  if (selectedRow > scroll + listRows - 1) scroll = selectedRow - listRows + 1;
  scroll = Math.min(Math.max(0, scroll), Math.max(0, rows.length - listRows));

  lines.push(scroll > 0 ? `    ${style.dim(`↑ mais ${scroll}`)}` : '');
  const shown = rows.slice(scroll, scroll + listRows);
  lines.push(...shown, ...Array.from({ length: listRows - shown.length }, () => ''));
  const below = rows.length - scroll - listRows;
  lines.push(below > 0 ? `    ${style.dim(`↓ mais ${below}`)}` : '', '');
  lines.push(
    selected
      ? `  ${style.italic(fit(selected.description, width - 3))}`
      : `  ${style.yellow(fit('Nenhum comando com esse nome. esc limpa o filtro.', width - 3))}`,
    '',
  );
  lines.push(...footer(homeHints(state), context, style, width));
  return { lines, scroll };
}

// Terminal -------------------------------------------------------------------------------

/** A tela inicial no buffer alternativo; resolve com o comando escolhido, ou `null` ao sair. */
export async function chooseCommand(context: HomeContext, selected?: string): Promise<Command | null> {
  try {
    return await runScreen<HomeState, Command | null>({
      state: homeState(context, selected),
      fullscreen: true,
      step: (state, key) => {
        const step = homeStep(context, state, key);
        if ('state' in step) return step;
        return { result: 'open' in step ? step.open : null };
      },
      render: (state, width, height) => {
        const { lines, scroll } = renderHome(context, state, style, width, height);
        // A rolagem acompanha o cursor entre uma tecla e outra.
        state.scroll = scroll;
        return lines;
      },
    });
  } catch (error) {
    if (error instanceof Interrupted) return null;
    throw error;
  }
}

// Moldura das telas ----------------------------------------------------------------------

/** Linhas do topo (as duas do projeto, entre linhas vazias) e do rodapé (teclas e saldo). */
const TOP_ROWS = 4;
const FOOTER_ROWS = 3;

/** Linhas do corpo que cabem entre o topo e o rodapé. */
export const bodyRows = (height: number) => Math.max(3, height - TOP_ROWS - FOOTER_ROWS);

/**
 * Toda tela de comando: as duas linhas do topo, o corpo (cortado no que cabe, com linhas
 * longas quebradas) e o rodapé com as teclas e o saldo, como na tela inicial.
 */
export function frame(context: HomeContext, body: string[], hints: Hint[], style: ScreenStyle, width = 80, height = 24): string[] {
  const rows = bodyRows(height);
  const wrapped = body.flatMap((line) => wrapLine(line, width, '    '));
  const shown = wrapped.slice(0, rows);
  return ['', ...homeTop(context, style, width), '', ...shown, ...Array.from({ length: rows - shown.length }, () => ''), ...footer(hints, context, style, width)];
}

// Vista ----------------------------------------------------------------------------------

export interface ResultView {
  /** "✓ <ação>" no resultado de um formulário; o título do comando nas vistas. */
  title: string;
  /** Nome no shell à direita, nas vistas. */
  command?: string;
  lines: string[];
  /** Comando de shell que deu o resultado, embaixo. */
  shell?: string;
}

/** Saída de um comando em linhas da vista: recuadas, sem o fim vazio e sem o que o `\r` apagou. */
export function outputLines(output: string): string[] {
  const lines = output.split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1));
  // Linhas só com cor (o fim de um `dim` com quebra) contam como vazias.
  while (lines.length > 0 && visibleLength(lines.at(-1) as string) === 0) lines.pop();
  return lines.map((line) => (visibleLength(line) > 0 ? `  ${line}` : ''));
}

/** Corpo da vista, como no protótipo: título, as linhas e a linha de shell esmaecida. */
export function viewBody(view: ResultView, style: ScreenStyle, width: number): string[] {
  const right = view.command && width >= WIDE ? `mabel ${view.command}` : '';
  const lines = [...titleRows(view.title, style, width, right), ...view.lines];
  if (view.shell) lines.push('', ...shellRows(view.shell, style, width).map((line) => style.dim(line)));
  return lines;
}

export const RESULT_HINTS: Hint[] = [
  ['enter', 'volta ao menu'],
  ['esc', 'volta ao menu'],
];

/** Fora da tela inicial (o `decidir` aberto pelo shell), a vista só fecha. */
const SHELL_RESULT_HINTS: Hint[] = [
  ['enter', 'fecha'],
  ['esc', 'fecha'],
];

/** A tela cheia foi aberta pelo shell (`standalone`), não pela tela inicial. */
let fromShell = false;

const resultHints = () => (fromShell ? SHELL_RESULT_HINTS : RESULT_HINTS);

/** Desenha a vista com a rolagem; devolve as linhas e quanto dá para rolar. */
export function renderResult(context: HomeContext, view: ResultView, scroll: number, style: ScreenStyle, width = 80, height = 24): { lines: string[]; overflow: number } {
  const body = viewBody(view, style, width).flatMap((line) => wrapLine(line, width, '    '));
  const rows = bodyRows(height);
  const overflow = body.length > rows ? body.length - Math.max(1, rows - 2) : 0;
  const hints: Hint[] = overflow > 0 ? [['↑↓', 'rola'], ...resultHints()] : resultHints();
  return { lines: frame(context, scrollWindow(body, scroll, rows, style), hints, style, width, height), overflow };
}

/** A vista em tela cheia até enter ou esc; depois, o resultado fica na rolagem do terminal comum. */
async function showResult(context: HomeContext, view: ResultView): Promise<void> {
  let overflow = 0;
  await runScreen<number, true>({
    state: 0,
    fullscreen: true,
    step: (scroll, key) => {
      const step = scrollStep(scroll, key, overflow);
      return 'done' in step ? { result: true } : step;
    },
    render: (scroll, width, height) => {
      const result = renderResult(context, view, scroll, style, width, height);
      overflow = result.overflow;
      return result.lines;
    },
  }).catch((error) => {
    if (!(error instanceof Interrupted)) throw error;
  });
  leaveFullscreen();
  process.stdout.write(`\n${viewBody(view, style, process.stdout.columns ?? 80).join('\n')}\n`);
}

// Rodar o comando ------------------------------------------------------------------------

/** Garante o terminal em modo normal se o processo sair no meio de uma tela. */
function restoreTerminal(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  leaveFullscreen();
  process.stdout.write('\x1b[?25h');
}

/**
 * Tela cheia aberta pelo shell (o painel do `rodar` e do `acompanhar`, o `decidir`): o
 * terminal volta ao normal no fim, e ctrl+c sai com 130.
 */
export async function standalone(open: () => Promise<number>): Promise<number> {
  process.on('exit', restoreTerminal);
  fromShell = true;
  try {
    return await open();
  } catch (error) {
    if (error instanceof Interrupted) return 130;
    throw error;
  } finally {
    fromShell = false;
    process.off('exit', restoreTerminal);
    restoreTerminal();
  }
}

type Write = typeof process.stdout.write;

/**
 * Roda o comando sem perguntas (como fora do TTY) e devolve a saída, em vez de escrevê-la:
 * é o que o botão de um formulário faz antes de mostrar o resultado numa vista.
 */
export async function captureRun(command: Command, args: string[]): Promise<{ code: number; output: string }> {
  let output = '';
  const keep = (chunk: unknown) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    return true;
  };
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = keep as Write;
  process.stderr.write = keep as Write;
  headless.on = true;
  try {
    const code = await (command.run as NonNullable<Command['run']>)(args);
    return { code, output };
  } catch (error) {
    return { code: 1, output: `${output}${paint.bad(`Erro em mabel ${command.name}: ${(error as Error).message}`)}\n` };
  } finally {
    headless.on = false;
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** Espera enter ou esc no terminal comum, para dar tempo de ler antes de a tela inicial voltar. */
async function waitReturn(): Promise<void> {
  await runScreen<null, true>({
    state: null,
    step: (_, key) => ('done' in viewStep(key) ? { result: true } : { state: null }),
    render: (_, width) => renderKeys(RESULT_HINTS, style, width),
  }).catch((error) => {
    if (!(error instanceof Interrupted)) throw error;
  });
}

/**
 * Roda o comando no terminal comum, com o fluxo e a saída de hoje (as rodadas do criar, a
 * fila do rodar), sob a linha "‹ <título>" e o "$ mabel …"; o resultado fica na rolagem.
 */
async function terminalRun(command: Command, args: string[], settings: { headless?: boolean } = {}): Promise<number> {
  leaveFullscreen();
  const width = process.stdout.columns ?? 80;
  const title = titleRows(command.menu?.title ?? command.name, style, width, width >= WIDE ? `mabel ${command.name}` : '');
  process.stdout.write(`\n${title.join('\n')}${style.dim(`  $ ${shellLine(['mabel', command.name, ...args])}`)}\n\n`);
  // No terminal comum, o rodapé fixo de saldo volta, como em qualquer comando.
  const stopFooter = startFooter();
  // Sem este listener, um ctrl+c num comando que não trata SIGINT encerraria o Mabel.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  headless.on = settings.headless ?? false;
  let code: number;
  try {
    code = await (command.run as NonNullable<Command['run']>)(args);
  } catch (error) {
    if (error instanceof Interrupted) {
      process.stdout.write(`${style.dim('interrompido')}\n`);
      code = 130;
    } else {
      process.stderr.write(`${paint.bad(`Erro em mabel ${command.name}: ${(error as Error).message}`)}\n`);
      code = 1;
    }
  } finally {
    headless.on = false;
    process.off('SIGINT', ignore);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }
  try {
    process.stdout.write('\n');
    await waitReturn();
  } finally {
    stopFooter();
  }
  return code;
}

/** Formulário em tela cheia; `null` quando o usuário volta ao menu. */
async function fillScreen(context: HomeContext, config: FormConfig): Promise<FormValues | null> {
  return runScreen<FormState, FormValues | null>({
    state: formState(config),
    fullscreen: true,
    step: (state, key) => {
      const step = formStep(config, state, key);
      if ('state' in step) return step;
      return { result: 'submit' in step ? step.submit : null };
    },
    render: (state, width, height) => frame(context, formBody(config, state, style, width), formHints(config, state), style, width, height),
  });
}

/** Abre a tela do comando escolhido na tela inicial e devolve o código de saída. */
export async function openScreen(command: Command, context: HomeContext): Promise<number> {
  const screen = commandScreen(command.name, loadScreenData());
  const title = command.menu?.title ?? command.name;
  switch (screen.kind) {
    case 'view': {
      const { code, output } = await captureRun(command, screen.args);
      await showResult(loadHomeContext(), { title, command: command.name, lines: outputLines(output) });
      return code;
    }
    case 'message':
      await showResult(context, { title, command: command.name, lines: screen.lines.map((line) => `  ${line}`) });
      return 0;
    case 'terminal':
      if (command.name === 'acompanhar') return queuePanel({ mode: 'acompanhar', args: [], origin: 'menu' });
      return terminalRun(command, screen.args);
    case 'decide':
      return decideFlow(context);
    case 'form': {
      const { form } = screen;
      const values = await fillScreen(context, form.config);
      if (!values) return 0;
      const args = form.args(values);
      // Rodar a fila (sem "Em segundo plano") abre o painel da fila.
      if (command.name === 'rodar' && form.mode(values) === 'terminal') return queuePanel({ mode: 'rodar', args, origin: 'menu' });
      if (form.mode(values) === 'terminal') return terminalRun(command, args, { headless: form.headless });
      const { code, output } = await captureRun(command, args);
      const next = code === 0 ? (form.next?.(values) ?? []) : [];
      await showResult(loadHomeContext(), {
        title: code === 0 ? `✓ ${form.config.action}` : `✗ ${form.config.action}`,
        lines: [...outputLines(output), ...(next.length > 0 ? ['', ...next.map((line) => `  ${style.dim(line)}`)] : [])],
        shell: shellLine(['mabel', command.name, ...args]),
      });
      return code;
    }
  }
}

// Decidir as pendências ------------------------------------------------------------------

/**
 * `GuidedIO` em tela cheia: o que os fluxos escrevem vira a página da decisão, e cada menu,
 * campo ou formulário aparece embaixo dela, com o topo e o rodapé de toda tela. Esc num menu
 * sem "Voltar" sai do fluxo (como ctrl+c).
 */
export class PageGuided implements GuidedIO {
  page: string[] = [];
  head: string[] = [];
  private readonly context: HomeContext;
  constructor(context: HomeContext) {
    this.context = context;
  }

  write = (line: string) => {
    this.page.push(line);
  };

  /** Página e corpo do componente na tela: o começo da página some quando não cabe. */
  private render(body: string[], hints: Hint[], width: number, height: number): string[] {
    const page = this.page.flatMap((line) => wrapLine(line, width, '    '));
    const room = Math.max(0, bodyRows(height) - this.head.length - body.length - 1);
    const visible = page.length > room ? page.slice(page.length - room) : page;
    return frame(this.context, [...this.head, ...visible, '', ...body], hints, style, width, height);
  }

  choose = async (options: (string | ChoiceOption)[], settings: ChooseSettings = {}) => {
    const config: ChoiceConfig = { options: options.map((option) => (typeof option === 'string' ? { label: option } : option)), back: true };
    const chosen = await runScreen<ChoiceState, number | null>({
      state: choiceState(settings.initial ?? 0),
      fullscreen: true,
      step: (state, key) => {
        const step = choiceStep(config, state, key);
        if ('state' in step) return step;
        return { result: 'chosen' in step ? step.chosen : null };
      },
      render: (state, width, height) =>
        this.render(renderChoice(config, state, style, width).slice(0, -2), choiceHints(config, settings.back !== undefined ? 'volta' : 'sai'), width, height),
    });
    if (chosen === null) {
      if (settings.back === undefined) throw new Interrupted();
      return settings.back;
    }
    this.page.push(style.dim(`    › ${config.options[chosen]?.label ?? ''}`));
    return chosen;
  };

  text = async (label: string, settings: TextSettings = {}) => {
    const value = await runScreen<TextState, string | null>({
      state: textState(settings.initial ?? ''),
      fullscreen: true,
      step: (state, key) => {
        const step = textStep(state, key);
        if ('state' in step) return step;
        return { result: 'done' in step ? step.done : null };
      },
      render: (state, width, height) => this.render(renderText({ label, placeholder: settings.placeholder }, state, style, width).slice(0, -2), TEXT_HINTS, width, height),
    });
    if (value) this.page.push(`    ${style.dim(label.padEnd(12))} ${value}`);
    return value;
  };

  list = async (title: string, entries: string[], settings: ListConfig = {}) =>
    runScreen<ListState, string[]>({
      state: listState(entries),
      fullscreen: true,
      step: (state, key) => {
        const step = listStep(settings, state, key);
        return 'state' in step ? step : { result: step.done };
      },
      render: (state, width, height) => this.render([style.bold(`  ${title}`), ...listBody(settings, state, style, width)], listHints(settings, state), width, height),
    });

  form = async (config: FormConfig, values: FormValues = {}) =>
    runScreen<FormState, FormValues | null>({
      state: formState(config, values),
      fullscreen: true,
      step: (state, key) => {
        const step = formStep(config, state, key);
        if ('state' in step) return step;
        return { result: 'submit' in step ? step.submit : null };
      },
      render: (state, width, height) => frame(this.context, formBody(config, state, style, width), formHints(config, state), style, width, height),
    });
}

const DECIDE = { title: 'Decidir as pendências', description: 'Responde perguntas e aprova critérios: uma pendência ou todas, uma por vez.' };

/** Primeiro passo do Decidir: "Passar por todas (N)" e as pendências, cada uma com o estado à direita. */
export function pendingChoice(pending: Item[]): ChoiceConfig {
  return {
    options: [{ label: `Passar por todas (${pending.length})` }, ...pending.map((item) => ({ label: `#${item.number}  ${item.title}`, chip: itemChip(item) }))],
    back: true,
  };
}

/**
 * "Decidir as pendências": a lista com "Passar por todas"; depois, uma decisão por vez
 * ("1 de 2"), com o item e o menu de opções da inbox; no fim, o resumo do que foi decidido.
 */
export async function decideFlow(context: HomeContext): Promise<number> {
  const home = dataDir();
  const db = openDb(home);
  try {
    let project: Project;
    try {
      project = resolveProject(db);
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      await showResult(context, { title: DECIDE.title, command: 'decidir', lines: [`  ${error.message}`] });
      return 1;
    }
    const pending = pendingItems(db, project.id);
    const conflict = baseConflictLines(db, project);
    if (pending.length === 0) {
      const lines = conflict.length > 0 ? conflict.map((line) => `  ${line.trim()}`) : [`  ${style.dim('Nenhuma pendência esperando você.')}`];
      await showResult(context, { title: DECIDE.title, command: 'decidir', lines });
      return 0;
    }
    const config = pendingChoice(pending);
    const chosen = await runScreen<ChoiceState, number | null>({
      state: choiceState(),
      fullscreen: true,
      step: (state, key) => {
        const step = choiceStep(config, state, key);
        if ('state' in step) return step;
        return { result: 'chosen' in step ? step.chosen : null };
      },
      render: (state, width, height) => {
        const body = renderChoice(config, state, style, width).slice(0, -2);
        // Uma linha entre "Passar por todas" e as pendências, como no protótipo.
        body.splice(1, 0, '');
        const back = fromShell ? 'sai' : 'menu';
        return frame(context, [...titleRows(DECIDE.title, style, width, width >= WIDE ? 'mabel decidir' : '', DECIDE.description), ...body], choiceHints(config, back), style, width, height);
      },
    });
    if (chosen === null) return 0;
    const queue = chosen === 0 ? pending : [pending[chosen - 1] as Item];
    const io = new PageGuided(context);
    const decided = new Map<number, string>();
    await runInbox(db, home, project, io, {
      items: queue,
      onItem: (item, index, total) => {
        const width = process.stdout.columns ?? 80;
        const chip = itemChip(item);
        io.head = [...titleRows(DECIDE.title, style, width, `${index + 1} de ${total}`), row(`  ${style.bold(`#${item.number}  ${item.title}`)}`, `${style[chip.tone ?? 'dim'](chip.text)}  `, width), `  ${style.dim(pendingLabel(item))}`];
        io.page = [];
      },
      onDecision: (item, decision) => decided.set(item.number, decision),
    });
    const lines = queue.map((item) => `  #${item.number}: ${decided.get(item.number) ?? 'continua esperando você'}`);
    await showResult(loadHomeContext(), {
      title: '✓ Pendências decididas',
      lines: [...lines, '', `  ${style.dim('Os itens voltam para a fila na próxima vez que ela rodar.')}`],
    });
    return 0;
  } finally {
    db.close();
  }
}

// Laço da tela inicial -------------------------------------------------------------------

/** `mabel` sem argumentos no terminal: tela inicial, a tela do comando, e de volta. */
export async function home(): Promise<number> {
  process.on('exit', restoreTerminal);
  // Os formulários abertos daqui voltam para a tela inicial.
  formExit.action = 'menu';
  let last: string | undefined;
  let code = 0;
  try {
    for (;;) {
      const command = await chooseCommand(loadHomeContext(), last);
      if (!command) return code;
      last = command.name;
      try {
        code = await openScreen(command, loadHomeContext());
      } catch (error) {
        // Ctrl+C numa tela de comando sai do Mabel, como na tela inicial.
        if (error instanceof Interrupted) return code;
        throw error;
      }
    }
  } finally {
    process.off('exit', restoreTerminal);
    restoreTerminal();
  }
}
