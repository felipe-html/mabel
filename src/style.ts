import type { Paint } from './balance.ts';
import type { ScreenStyle } from './screens.ts';

export const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paintWith = (code: number, on = color) => (text: string) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);

/** Estilo das telas, com ou sem cor (o worker do acompanhamento não tem TTY para decidir). */
export function screenStyle(on: boolean): ScreenStyle {
  return {
    dim: paintWith(2, on),
    bold: paintWith(1, on),
    accent: paintWith(36, on),
    italic: paintWith(3, on),
    green: paintWith(32, on),
    yellow: paintWith(33, on),
    red: paintWith(31, on),
    // Faixa de seleção: fundo invertido, refeito depois de cada cor que a linha fecha.
    selected: (text: string) => (on ? `\x1b[7m${text.replaceAll('\x1b[0m', '\x1b[0m\x1b[7m')}\x1b[0m` : text),
  };
}

export const style: ScreenStyle = screenStyle(color);

export const paint: Paint = {
  good: paintWith(32),
  warn: paintWith(33),
  bad: paintWith(31),
  dim: paintWith(2),
};
