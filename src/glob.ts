/** Globs de caminho: `**` atravessa diretórios, `*` e `?` não, `{a,b}` alterna. */

const WILDCARD = /[*?{]/;

function escape(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Expressão regular de um segmento (sem `/`). */
function segmentRegExp(segment: string): RegExp {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i] as string;
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{' && segment.indexOf('}', i) > i) {
      const end = segment.indexOf('}', i);
      source += `(?:${segment.slice(i + 1, end).split(',').map(escape).join('|')})`;
      i = end;
    } else source += escape(char);
  }
  return new RegExp(`^${source}$`);
}

function segments(glob: string): string[] {
  return glob.trim().replace(/^\.?\//, '').split('/').filter(Boolean);
}

/** Dois segmentos podem casar com o mesmo nome? Dois curingas: sim, por precaução. */
function segmentsOverlap(a: string, b: string): boolean {
  const aWild = WILDCARD.test(a);
  const bWild = WILDCARD.test(b);
  if (!aWild && !bWild) return a === b;
  if (aWild && !bWild) return segmentRegExp(a).test(b);
  if (!aWild && bWild) return segmentRegExp(b).test(a);
  return true;
}

/** O caminho casa com o glob. */
export function matchGlob(glob: string, path: string): boolean {
  const pattern = segments(glob);
  const parts = segments(path);
  const match = (i: number, j: number): boolean => {
    if (i === pattern.length) return j === parts.length;
    if (pattern[i] === '**') return match(i + 1, j) || (j < parts.length && match(i, j + 1));
    return j < parts.length && segmentRegExp(pattern[i] as string).test(parts[j] as string) && match(i + 1, j + 1);
  };
  return match(0, 0);
}

/**
 * Os dois globs podem casar com um mesmo caminho? Conservador: na dúvida, sim — um falso
 * positivo só pede aprovação humana a mais.
 */
export function globsOverlap(a: string, b: string): boolean {
  const left = segments(a);
  const right = segments(b);
  const overlap = (i: number, j: number): boolean => {
    if (i === left.length && j === right.length) return true;
    if (left[i] === '**') return overlap(i + 1, j) || (j < right.length && overlap(i, j + 1));
    if (right[j] === '**') return overlap(i, j + 1) || (i < left.length && overlap(i + 1, j));
    if (i === left.length || j === right.length) return false;
    return segmentsOverlap(left[i] as string, right[j] as string) && overlap(i + 1, j + 1);
  };
  return overlap(0, 0);
}
