import type { Key, Style } from './menu.ts';

/** Comando oferecido na lista de autocompletar. */
export interface Suggestion {
  name: string;
  description: string;
  /** Passo do plano em que o comando será implementado; ausente quando está disponível. */
  plannedStep?: number;
}

export interface LineContext {
  suggestions: Suggestion[];
  /** Linhas anteriores, da mais antiga para a mais recente. */
  history: string[];
}

export interface LineState {
  text: string;
  cursor: number;
  /** Posição no histórico; igual a `history.length` quando se edita a linha nova. */
  historyIndex: number;
  /** Linha nova guardada enquanto se navega pelo histórico. */
  draft: string;
  selected: number;
  /** Lista fechada com Esc até a próxima tecla que altere a linha. */
  dismissed: boolean;
  message?: string;
}

export type LineStep = { state: LineState } | { submit: string } | { exit: true };

export const LIST_SIZE = 8;

export function initialLine(context: LineContext): LineState {
  return { text: '', cursor: 0, historyIndex: context.history.length, draft: '', selected: 0, dismissed: false };
}

/** Comandos que casam com o texto, ou `undefined` quando a lista está fechada. */
export function suggestionsFor(state: LineState, context: LineContext): Suggestion[] | undefined {
  if (state.dismissed || !state.text.startsWith('/') || state.text.includes(' ')) return undefined;
  const prefix = state.text.slice(1);
  return context.suggestions.filter((suggestion) => suggestion.name.startsWith(prefix));
}

function edit(state: LineState, text: string, cursor: number): { state: LineState } {
  return { state: { ...state, text, cursor, selected: 0, dismissed: false, message: undefined } };
}

function previousWordStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && text[i - 1] === ' ') i--;
  while (i > 0 && text[i - 1] !== ' ') i--;
  return i;
}

/** Caracteres imprimíveis da sequência; colagens chegam como uma sequência longa. */
function printable(key: Key): string {
  if (key.ctrl || !key.sequence) return '';
  return [...key.sequence].filter((char) => char >= ' ' && char !== '\x7f').join('');
}

/** Transição pura do editor: recebe o estado e a tecla, devolve o novo estado ou a ação. */
export function lineStep(state: LineState, key: Key, context: LineContext): LineStep {
  const { text, cursor } = state;
  const list = suggestionsFor(state, context);
  const quiet = { ...state, message: undefined };

  if (key.ctrl && key.name === 'c') {
    if (text) return edit({ ...state, historyIndex: context.history.length, draft: '' }, '', 0);
    return { state: { ...state, message: 'use exit para sair' } };
  }
  if (key.ctrl && key.name === 'd') {
    if (!text) return { exit: true };
    return cursor < text.length ? edit(state, text.slice(0, cursor) + text.slice(cursor + 1), cursor) : { state: quiet };
  }
  if (key.name === 'return' || key.name === 'enter') {
    const chosen = list?.[state.selected];
    return { submit: chosen ? `/${chosen.name}` : text };
  }
  if (key.name === 'tab') {
    const chosen = list?.[state.selected];
    if (!chosen) return { state: quiet };
    const completed = `/${chosen.name} `;
    return edit(state, completed, completed.length);
  }
  if (key.name === 'escape') return { state: { ...quiet, dismissed: list !== undefined || state.dismissed } };

  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    if (list && list.length > 0) {
      const selected = (state.selected + delta + list.length) % list.length;
      return { state: { ...quiet, selected } };
    }
    const index = state.historyIndex + delta;
    if (index < 0 || index > context.history.length) return { state: quiet };
    const draft = state.historyIndex === context.history.length ? text : state.draft;
    const recalled = index === context.history.length ? draft : (context.history[index] ?? '');
    // A lista fica fechada para que as setas continuem percorrendo o histórico.
    return { state: { ...edit(state, recalled, recalled.length).state, historyIndex: index, draft, dismissed: true } };
  }

  if (key.name === 'left') return { state: { ...quiet, cursor: Math.max(0, cursor - 1) } };
  if (key.name === 'right') return { state: { ...quiet, cursor: Math.min(text.length, cursor + 1) } };
  if (key.name === 'home' || (key.ctrl && key.name === 'a')) return { state: { ...quiet, cursor: 0 } };
  if (key.name === 'end' || (key.ctrl && key.name === 'e')) return { state: { ...quiet, cursor: text.length } };
  if (key.name === 'backspace') {
    if (cursor === 0) return { state: quiet };
    return edit(state, text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1);
  }
  if (key.name === 'delete') {
    if (cursor === text.length) return { state: quiet };
    return edit(state, text.slice(0, cursor) + text.slice(cursor + 1), cursor);
  }
  if (key.ctrl && key.name === 'u') return edit(state, text.slice(cursor), 0);
  if (key.ctrl && key.name === 'w') {
    const start = previousWordStart(text, cursor);
    return edit(state, text.slice(0, start) + text.slice(cursor), start);
  }

  const chars = printable(key);
  if (!chars) return { state: quiet };
  return edit(state, text.slice(0, cursor) + chars + text.slice(cursor), cursor + chars.length);
}

/** Primeira linha da janela de `LIST_SIZE` que mantém a seleção visível. */
function windowStart(selected: number, total: number): number {
  if (total <= LIST_SIZE) return 0;
  return Math.min(Math.max(0, selected - LIST_SIZE + 1), total - LIST_SIZE);
}

function fit(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Linhas abaixo do prompt: a lista de autocompletar ou a mensagem. Cabem em `width` colunas. */
export function renderBelow(state: LineState, context: LineContext, style: Style, width = 80): string[] {
  const list = suggestionsFor(state, context);
  const lines: string[] = [];
  if (list) {
    if (list.length === 0) lines.push(style.dim('  nenhum comando'));
    const nameWidth = Math.max(...list.map((suggestion) => suggestion.name.length + 1));
    const start = windowStart(state.selected, list.length);
    list.slice(start, start + LIST_SIZE).forEach((suggestion, offset) => {
      const planned = suggestion.plannedStep ? `  (passo ${suggestion.plannedStep})` : '';
      const text = fit(`/${suggestion.name}`.padEnd(nameWidth) + `  ${suggestion.description}${planned}`, width - 3);
      if (start + offset === state.selected) lines.push(style.accent(`❯ ${text}`));
      else lines.push(suggestion.plannedStep ? style.dim(`  ${text}`) : `  ${text}`);
    });
  }
  if (state.message) lines.push(style.dim(fit(state.message, width - 1)));
  return lines;
}

// Argumentos -----------------------------------------------------------------------------

export class ArgsError extends Error {}

/** Separa a linha como o shell: espaços, aspas simples, aspas duplas e `\`. */
export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else current += char;
    } else if (char === '\\' && i + 1 < line.length && (quote === undefined || /["\\$`]/.test(line[i + 1] as string))) {
      current += line[++i];
      started = true;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === ' ' || char === '\t') {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new ArgsError(`Aspas ${quote} sem fechamento.`);
  if (started) args.push(current);
  return args;
}
