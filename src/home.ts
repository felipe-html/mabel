import { homedir } from 'node:os';
import { basename } from 'node:path';
import { Interrupted } from './ask.ts';
import { type BalanceReading, latestReadings, renderBalanceFooter } from './balance.ts';
import { type Command, GROUP_TITLES, MENU_GROUPS, type MenuBadge, type MenuGroup, commands } from './commands.ts';
import { dataDir, openDb } from './db.ts';
import { startFooter } from './footer.ts';
import { terminalGuided } from './guided.ts';
import { pendingItems } from './inbox.ts';
import { boardItems, syncBacklog } from './items.ts';
import { type Key, runScreen } from './menu.ts';
import { ProjectError, gitRoot, readConfig, resolveProject } from './project.ts';
import {
  type Hint,
  type ScreenStyle,
  fit,
  formExit,
  isEnter,
  isEscape,
  listRow,
  renderKeys,
  titleRows,
  typed,
  visibleLength,
} from './screens.ts';
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
        pending: pendingItems(db, project.id).length,
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
function footer(hints: Hint[], context: HomeContext, style: ScreenStyle, width: number): string[] {
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

/** Garante o terminal em modo normal se o processo sair no meio de uma tela. */
function restoreTerminal(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdout.write('\x1b[?25h');
}

/**
 * Abre o comando no terminal comum, com o fluxo que ele tem hoje: o resultado fica na
 * rolagem. `null` quando o usuário volta antes de rodar (no pedido dos argumentos).
 */
export async function openCommand(command: Command): Promise<number | null> {
  const width = process.stdout.columns ?? 80;
  process.stdout.write('\n');
  if (!command.menu?.form) process.stdout.write(`${titleRows(command.menu?.title ?? command.name, style, width, width >= WIDE ? `mabel ${command.name}` : '').join('\n')}\n`);
  // Sem este listener, um ctrl+c num comando que não trata SIGINT encerraria o Mabel.
  const ignore = () => {};
  process.on('SIGINT', ignore);
  try {
    let args: string[] = [];
    if (command.promptArgs) {
      const prompted = await command.promptArgs();
      if (!prompted) return null;
      args = prompted;
    }
    return await (command.run as NonNullable<Command['run']>)(args);
  } catch (error) {
    if (error instanceof Interrupted) {
      process.stdout.write(`${style.dim('interrompido')}\n`);
      return 130;
    }
    process.stderr.write(`${paint.bad(`Erro em mabel ${command.name}: ${(error as Error).message}`)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', ignore);
    restoreTerminal();
  }
}

export const AFTER_COMMAND = ['Voltar ao menu', 'Sair do Mabel'];

/** `mabel` sem argumentos no terminal: tela inicial, comando, e de volta à tela. */
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
      // No terminal comum, o rodapé fixo de saldo volta, como em qualquer comando.
      const stopFooter = startFooter();
      try {
        const result = await openCommand(command);
        if (result === null) continue;
        code = result;
        process.stdout.write('\n');
        if ((await terminalGuided.choose(AFTER_COMMAND, { back: 0 })) === 1) return code;
      } catch (error) {
        if (error instanceof Interrupted) return code;
        throw error;
      } finally {
        stopFooter();
      }
    }
  } finally {
    process.off('exit', restoreTerminal);
    restoreTerminal();
  }
}
