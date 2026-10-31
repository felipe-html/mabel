import type { Paint } from './balance.ts';
import type { ScreenStyle } from './screens.ts';

export const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const paintWith = (code: number) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

/** Faixa de seleção: fundo invertido, refeito depois de cada cor que a linha fecha. */
const selected = (text: string) => (color ? `\x1b[7m${text.replaceAll('\x1b[0m', '\x1b[0m\x1b[7m')}\x1b[0m` : text);

export const style: ScreenStyle = {
  dim: paintWith(2),
  bold: paintWith(1),
  accent: paintWith(36),
  italic: paintWith(3),
  green: paintWith(32),
  yellow: paintWith(33),
  red: paintWith(31),
  selected,
};

export const paint: Paint = {
  good: paintWith(32),
  warn: paintWith(33),
  bad: paintWith(31),
  dim: paintWith(2),
};
