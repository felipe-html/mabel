import { emitKeypressEvents } from 'node:readline';
import { Interrupted } from './ask.ts';
import { redrawFooter } from './footer.ts';
import { type ChoiceConfig, choiceState, choiceStep, isInterrupt, renderChoice, type ScreenStyle, visibleLength } from './screens.ts';

export interface MenuOption {
  label: string;
  hint: string;
  /** Motivo pelo qual a opção não pode ser escolhida agora; ausente quando está disponível. */
  disabledReason?: string;
}

/** Subconjunto do evento `keypress` do readline usado pelas telas. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  /** Alt, ou esc seguido de outra tecla antes do tempo do readline. */
  meta?: boolean;
}

export interface Style {
  dim: (text: string) => string;
  bold: (text: string) => string;
  accent: (text: string) => string;
}

/** Um componente de `src/screens.ts` ligado ao terminal. */
export interface Screen<S, R> {
  state: S;
  step: (state: S, key: Key) => { state: S } | { result: R };
  render: (state: S, width: number) => string[];
  /** Linhas que ficam na rolagem quando a tela fecha; sem elas, a tela some. */
  summary?: (result: R) => string[];
}

/** Linhas físicas que o texto ocupa, com a quebra do terminal. */
function physicalRows(lines: string[], width: number): number {
  return lines.reduce((total, line) => total + Math.max(1, Math.ceil(visibleLength(line) / Math.max(1, width))), 0);
}

/**
 * Desenha a tela abaixo do cursor, redesenha a cada tecla e resolve com o resultado.
 * Ctrl+C rejeita com `Interrupted`. Exige stdin e stdout interativos.
 */
export function runScreen<S, R>(screen: Screen<S, R>): Promise<R> {
  const { stdin, stdout } = process;
  let state = screen.state;
  let drawn = 0;
  const width = () => stdout.columns ?? 80;

  const clear = () => {
    if (drawn > 0) stdout.write(`\x1b[${drawn}A\r`);
    stdout.write('\x1b[0J');
  };
  const draw = () => {
    const lines = screen.render(state, width());
    clear();
    stdout.write(`${lines.join('\n')}\n`);
    redrawFooter();
    drawn = physicalRows(lines, width());
  };

  return new Promise((resolve, reject) => {
    const close = () => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
    };
    const onKey = (_: string, key: Key = {}) => {
      if (isInterrupt(key)) {
        clear();
        close();
        return reject(new Interrupted());
      }
      const step = screen.step(state, key);
      if ('state' in step) {
        state = step.state;
        return draw();
      }
      clear();
      const summary = screen.summary?.(step.result) ?? [];
      if (summary.length > 0) stdout.write(`${summary.join('\n')}\n`);
      redrawFooter();
      close();
      resolve(step.result);
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write('\x1b[?25l');
    stdin.on('keypress', onKey);
    draw();
  });
}

/** Escolha de uma opção numa lista que se filtra ao digitar; `null` quando o usuário volta. */
export async function select(options: MenuOption[], style: ScreenStyle): Promise<number | null> {
  const config: ChoiceConfig = {
    options: options.map((option) => ({ label: option.label, hint: option.hint, disabledReason: option.disabledReason })),
    filter: true,
    back: true,
    size: 12,
  };
  const first = Math.max(0, options.findIndex((option) => !option.disabledReason));
  try {
    return await runScreen<ReturnType<typeof choiceState>, number | null>({
      state: choiceState(first),
      step: (state, key) => {
        const step = choiceStep(config, state, key);
        if ('state' in step) return step;
        return { result: 'chosen' in step ? step.chosen : null };
      },
      render: (state, width) => renderChoice(config, state, style, width),
      summary: (chosen) => (chosen === null ? [] : [`${style.accent('  › ')}${options[chosen]?.label ?? ''}`]),
    });
  } catch (error) {
    if (error instanceof Interrupted) return null;
    throw error;
  }
}

/**
 * Lista com várias escolhas no terminal; resolve com os índices marcados, ou `null` se o
 * usuário voltar. Exige stdin e stdout interativos.
 */
export async function selectMany(options: MenuOption[], preselected: number[], style: ScreenStyle): Promise<number[] | null> {
  const config: ChoiceConfig = {
    options: options.map((option) => ({ label: option.label, hint: option.hint })),
    multi: true,
    filter: true,
    back: true,
    size: 10,
  };
  try {
    return await runScreen<ReturnType<typeof choiceState>, number[] | null>({
      state: choiceState(0, [...preselected]),
      step: (state, key) => {
        const step = choiceStep(config, state, key);
        if ('state' in step) return step;
        return { result: 'marked' in step ? step.marked : null };
      },
      render: (state, width) => renderChoice(config, state, style, width),
      summary: (chosen) => (chosen === null ? [] : [style.dim(`  ${chosen.length} ${chosen.length === 1 ? 'marcada' : 'marcadas'}`)]),
    });
  } catch (error) {
    if (error instanceof Interrupted) return null;
    throw error;
  }
}
