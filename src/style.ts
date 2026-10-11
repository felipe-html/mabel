import type { Style } from './menu.ts';

export const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export const style: Style = {
  dim: (text) => (color ? `\x1b[2m${text}\x1b[0m` : text),
  bold: (text) => (color ? `\x1b[1m${text}\x1b[0m` : text),
  accent: (text) => (color ? `\x1b[36m${text}\x1b[0m` : text),
};
