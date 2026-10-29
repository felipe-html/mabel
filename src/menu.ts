import { emitKeypressEvents } from 'node:readline';
import { redrawFooter } from './footer.ts';

export interface MenuOption {
  label: string;
  hint: string;
  /** Motivo pelo qual a opção não pode ser escolhida agora; ausente quando está disponível. */
  disabledReason?: string;
}

export interface MenuState {
  cursor: number;
  message?: string;
}

/** Subconjunto do evento `keypress` do readline usado pelo menu. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
}

export type MenuStep = { state: MenuState } | { chosen: number | null };

/** Transição pura do menu: recebe o estado e a tecla, devolve o novo estado ou a escolha. */
export function menuStep(options: MenuOption[], state: MenuState, key: Key): MenuStep {
  const last = options.length - 1;
  const move = (cursor: number): MenuStep => ({ state: { cursor } });

  if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') {
    return { chosen: null };
  }
  if (key.name === 'up' || key.name === 'k') return move(state.cursor === 0 ? last : state.cursor - 1);
  if (key.name === 'down' || key.name === 'j') return move(state.cursor === last ? 0 : state.cursor + 1);
  if (key.name === 'home') return move(0);
  if (key.name === 'end') return move(last);

  const digit = Number(key.sequence);
  if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
    return choose(options, digit - 1);
  }
  if (key.name === 'return' || key.name === 'enter' || key.name === 'space') {
    return choose(options, state.cursor);
  }
  return { state };
}

function choose(options: MenuOption[], index: number): MenuStep {
  const reason = options[index]?.disabledReason;
  return reason ? { state: { cursor: index, message: reason } } : { chosen: index };
}

export interface Style {
  dim: (text: string) => string;
  bold: (text: string) => string;
  accent: (text: string) => string;
}

export function renderMenu(options: MenuOption[], state: MenuState, style: Style): string[] {
  const width = Math.max(...options.map((option) => option.label.length));
  const lines = options.map((option, i) => {
    const selected = i === state.cursor;
    const number = i < 9 ? `${i + 1}` : ' ';
    const text = `${number}  ${option.label.padEnd(width)}  ${option.hint}`;
    if (selected) return style.accent(`❯ ${text}`);
    return option.disabledReason ? style.dim(`  ${text}`) : `  ${text}`;
  });
  return [
    ...lines,
    '',
    state.message ? style.accent(state.message) : style.dim('↑/↓ navegar · enter escolher · q sair'),
  ];
}

/**
 * Mostra o menu no terminal e resolve com o índice escolhido, ou `null` se o usuário sair.
 * Exige stdin e stdout interativos.
 */
export function select(options: MenuOption[], style: Style): Promise<number | null> {
  const { stdin, stdout } = process;
  let state: MenuState = { cursor: options.findIndex((option) => !option.disabledReason) };
  if (state.cursor < 0) state = { cursor: 0 };
  let drawn = 0;

  const draw = () => {
    const lines = renderMenu(options, state, style);
    if (drawn > 0) stdout.write(`\x1b[${drawn}A`);
    stdout.write(`\x1b[0J${lines.join('\n')}\n`);
    redrawFooter();
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const finish = (chosen: number | null) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
      resolve(chosen);
    };
    const onKey = (_: string, key: Key = {}) => {
      const step = menuStep(options, { cursor: state.cursor }, key);
      if ('chosen' in step) return finish(step.chosen);
      state = step.state;
      draw();
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l');
    stdin.on('keypress', onKey);
    draw();
  });
}

// Múltipla escolha -----------------------------------------------------------------------

export interface MultiState {
  /** Posição na lista filtrada. */
  cursor: number;
  /** Índices marcados, na lista completa. */
  chosen: number[];
  /** Texto digitado; filtra pelo rótulo e pela dica. */
  filter: string;
}

export type MultiStep = { state: MultiState } | { chosen: number[] | null };

export const MULTI_LIST_SIZE = 10;

/** Índices (na lista completa) das opções que casam com o filtro. */
export function visibleOptions(options: MenuOption[], filter: string): number[] {
  const needle = filter.toLowerCase();
  return options.flatMap((option, i) =>
    !needle || option.label.toLowerCase().includes(needle) || option.hint.toLowerCase().includes(needle) ? [i] : [],
  );
}

/** Transição pura da múltipla escolha: espaço marca, enter confirma, letras filtram. */
export function multiStep(options: MenuOption[], state: MultiState, key: Key): MultiStep {
  const visible = visibleOptions(options, state.filter);
  const last = visible.length - 1;
  const move = (cursor: number): MultiStep => ({ state: { ...state, cursor } });

  if ((key.ctrl && key.name === 'c') || key.name === 'escape') return { chosen: null };
  if (key.name === 'return' || key.name === 'enter') return { chosen: [...state.chosen].sort((a, b) => a - b) };
  if (key.name === 'up') return move(state.cursor <= 0 ? Math.max(last, 0) : state.cursor - 1);
  if (key.name === 'down') return move(state.cursor >= last ? 0 : state.cursor + 1);
  if (key.name === 'space') {
    const index = visible[state.cursor];
    if (index === undefined) return { state };
    const chosen = state.chosen.includes(index) ? state.chosen.filter((i) => i !== index) : [...state.chosen, index];
    return { state: { ...state, chosen } };
  }
  if (key.name === 'backspace') return { state: { ...state, filter: state.filter.slice(0, -1), cursor: 0 } };
  const char = !key.ctrl && key.sequence && key.sequence.length === 1 && key.sequence > ' ' && key.sequence !== '\x7f' ? key.sequence : '';
  if (char) return { state: { ...state, filter: state.filter + char, cursor: 0 } };
  return { state };
}

export function renderMulti(options: MenuOption[], state: MultiState, style: Style): string[] {
  const visible = visibleOptions(options, state.filter);
  const start = visible.length <= MULTI_LIST_SIZE ? 0 : Math.min(Math.max(0, state.cursor - MULTI_LIST_SIZE + 1), visible.length - MULTI_LIST_SIZE);
  const shown = visible.slice(start, start + MULTI_LIST_SIZE);
  const width = Math.max(0, ...shown.map((i) => options[i]?.label.length ?? 0));
  const lines = shown.map((index, offset) => {
    const option = options[index] as MenuOption;
    const mark = state.chosen.includes(index) ? '[x]' : '[ ]';
    const text = `${mark} ${option.label.padEnd(width)}  ${option.hint}`;
    return start + offset === state.cursor ? style.accent(`❯ ${text}`) : `  ${text}`;
  });
  if (visible.length === 0) lines.push(style.dim('  nada casa com o filtro'));
  const more = visible.length > shown.length ? ` · ${visible.length - shown.length} fora da tela` : '';
  return [
    ...lines,
    '',
    state.filter ? style.accent(`filtro: ${state.filter}${more}`) : style.dim(`digite para filtrar${more}`),
    style.dim(`espaço marca · enter confirma (${state.chosen.length} marcadas) · esc cancela`),
  ];
}

/**
 * Lista com várias escolhas no terminal; resolve com os índices marcados, ou `null` se o
 * usuário cancelar. Exige stdin e stdout interativos.
 */
export function selectMany(options: MenuOption[], preselected: number[], style: Style): Promise<number[] | null> {
  const { stdin, stdout } = process;
  let state: MultiState = { cursor: 0, chosen: [...preselected], filter: '' };
  let drawn = 0;

  const draw = () => {
    const lines = renderMulti(options, state, style);
    if (drawn > 0) stdout.write(`\x1b[${drawn}A`);
    stdout.write(`\x1b[0J${lines.join('\n')}\n`);
    redrawFooter();
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const finish = (chosen: number[] | null) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
      resolve(chosen);
    };
    const onKey = (_: string, key: Key = {}) => {
      const step = multiStep(options, state, key);
      if ('chosen' in step) return finish(step.chosen);
      state = step.state;
      draw();
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l');
    stdin.on('keypress', onKey);
    draw();
  });
}
