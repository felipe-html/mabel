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
  render: (state: S, width: number, height: number) => string[];
  /** Linhas que ficam na rolagem quando a tela fecha; sem elas, a tela some. */
  summary?: (result: R) => string[];
  /**
   * Abre no buffer alternativo do terminal, como o vim, desenhada a partir do topo. O buffer
   * continua aberto quando a tela fecha (`leaveFullscreen` o fecha).
   */
  fullscreen?: boolean;
}

/**
 * O buffer alternativo fica aberto entre uma tela cheia e a próxima, para a troca de tela não
 * piscar; quem abriu a sequência o fecha com `leaveFullscreen`.
 */
let alternate = false;

export function leaveFullscreen(): void {
  if (!alternate) return;
  alternate = false;
  process.stdout.write('\x1b[?1049l');
}

/** Linhas físicas que o texto ocupa, com a quebra do terminal. */
function physicalRows(lines: string[], width: number): number {
  return lines.reduce((total, line) => total + Math.max(1, Math.ceil(visibleLength(line) / Math.max(1, width))), 0);
}

/**
 * Desenha a tela abaixo do cursor (ou na tela cheia, com `fullscreen`), redesenha a cada
 * tecla e quando o terminal muda de tamanho, e resolve com o resultado. Ctrl+C rejeita com
 * `Interrupted`. Exige stdin e stdout interativos.
 */
export function runScreen<S, R>(screen: Screen<S, R>): Promise<R> {
  const { stdin, stdout } = process;
  let state = screen.state;
  let drawn = 0;
  const width = () => stdout.columns ?? 80;
  const height = () => stdout.rows ?? 24;

  const clear = () => {
    if (screen.fullscreen) return;
    if (drawn > 0) stdout.write(`\x1b[${drawn}A\r`);
    stdout.write('\x1b[0J');
  };
  const draw = () => {
    const lines = screen.render(state, width(), height());
    if (screen.fullscreen) {
      // Linha a linha a partir do topo, sem passar da última: o buffer alternativo não rola.
      stdout.write(`\x1b[H${lines.slice(0, height()).map((line) => `${line}\x1b[K`).join('\r\n')}\x1b[J`);
      return;
    }
    clear();
    stdout.write(`${lines.join('\n')}\n`);
    redrawFooter();
    drawn = physicalRows(lines, width());
  };

  return new Promise((resolve, reject) => {
    const close = () => {
      stdin.off('keypress', onKey);
      stdout.off('resize', draw);
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
      close();
      const summary = screen.summary?.(step.result) ?? [];
      if (summary.length > 0) stdout.write(`${summary.join('\n')}\n`);
      redrawFooter();
      resolve(step.result);
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    if (screen.fullscreen && !alternate) {
      alternate = true;
      stdout.write('\x1b[?1049h');
    }
    if (!screen.fullscreen) leaveFullscreen();
    stdout.write('\x1b[?25l');
    stdin.on('keypress', onKey);
    stdout.on('resize', draw);
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
