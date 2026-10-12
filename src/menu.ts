import { emitKeypressEvents } from 'node:readline';

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
