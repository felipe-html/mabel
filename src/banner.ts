import { readFileSync } from 'node:fs';

/** Grid de pixels: cada linha é uma lista de booleanos (true = pixel aceso). */
export type Grid = boolean[][];

const ASSETS = new URL('../assets/', import.meta.url);
const GAP = 4;

/** Lê um grid no formato dos arquivos de `assets/`: `#` aceso, `.` ou espaço apagado. */
export function parseGrid(text: string): Grid {
  const lines = text.split('\n').map((line) => line.trimEnd());
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines.map((line) => [...line].map((char) => char === '#'));
}

export function loadGrid(name: string): Grid {
  return parseGrid(readFileSync(new URL(name, ASSETS), 'utf8'));
}

/** Converte o grid em linhas de texto. `pixel` é o que representa um pixel aceso. */
export function renderGrid(grid: Grid, pixel: string): string[] {
  const blank = ' '.repeat(pixel.length);
  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.map((row) =>
    Array.from({ length: width }, (_, i) => (row[i] ? pixel : blank)).join(''),
  );
}

function width(lines: string[]): number {
  return Math.max(0, ...lines.map((line) => line.length));
}

/**
 * Monta o banner: gatinho à esquerda e título à direita, alinhado à base do gatinho.
 * Se o terminal for estreito, o título vai para baixo; se nem o gatinho couber, só o título.
 */
export function composeBanner(cat: string[], title: string[], columns: number): string[] {
  const catWidth = width(cat);
  const titleWidth = width(title);

  if (catWidth + GAP + titleWidth <= columns) {
    const offset = Math.max(0, cat.length - title.length - 2);
    return cat.map((line, i) => {
      const titleLine = title[i - offset];
      return titleLine === undefined
        ? line.trimEnd()
        : (line.padEnd(catWidth + GAP) + titleLine).trimEnd();
    });
  }
  if (catWidth <= columns) return [...cat, '', ...title].map((line) => line.trimEnd());
  return title.map((line) => line.trimEnd());
}

export function banner(columns: number): string {
  const cat = renderGrid(loadGrid('logo.txt'), '██');
  const title = renderGrid(loadGrid('titulo.txt'), '█');
  return composeBanner(cat, title, columns).join('\n');
}
