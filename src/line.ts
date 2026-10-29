import type { Key, Style } from './menu.ts';
import type { ArgSpec, OptionSpecs, ValueOption, ValueSource } from './options.ts';
import { optionDescription, optionLabel } from './options.ts';

/** Comando, opção ou valor oferecido na lista de autocompletar. */
export interface Suggestion {
  name: string;
  description: string;
  /** Passo do plano em que o comando será implementado; ausente quando está disponível. */
  plannedStep?: number;
  /** Texto mostrado na lista; ausente nos comandos, que aparecem como `/nome`. */
  label?: string;
  /** Texto que entra na linha no lugar da palavra atual; ausente nos comandos. */
  insert?: string;
}

/** Opções e argumentos de um comando, para a lista que abre depois de `/comando `. */
export interface CommandSpec {
  options?: OptionSpecs;
  args?: ArgSpec[];
}

export interface LineContext {
  suggestions: Suggestion[];
  /** Por nome de comando. */
  commandSpecs?: Record<string, CommandSpec>;
  /** Valores de uma fonte (itens, projetos, referências); chamado só quando a lista precisa. */
  values?: (source: ValueSource) => ValueOption[];
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
  /** Seleção movida com as setas desde a última edição: na lista de opções, enter escolhe. */
  navigated?: boolean;
  message?: string;
}

export type LineStep = { state: LineState } | { submit: string } | { exit: true };

export const LIST_SIZE = 8;

export function initialLine(context: LineContext): LineState {
  return { text: '', cursor: 0, historyIndex: context.history.length, draft: '', selected: 0, dismissed: false };
}

/** Comandos que casam com o texto, ou `undefined` quando a lista está fechada. */
export function suggestionsFor(state: LineState, context: LineContext): Suggestion[] | undefined {
  if (state.dismissed || !state.text.startsWith('/')) return undefined;
  if (state.text.includes(' ')) return argSuggestions(state, context);
  const prefix = state.text.slice(1);
  return context.suggestions.filter((suggestion) => suggestion.name.startsWith(prefix));
}

/** A lista aberta é de opções e valores (depois de `/comando `), não de comandos. */
const isArgList = (state: LineState) => state.text.includes(' ');

function matches(option: ValueOption, current: string): boolean {
  if (!current) return true;
  const needle = current.toLowerCase();
  return option.value.toLowerCase().startsWith(needle) || option.description.toLowerCase().includes(needle);
}

function valueSuggestions(options: ValueOption[], current: string): Suggestion[] {
  return options
    .filter((option) => matches(option, current))
    .map((option) => ({ name: option.value, label: option.value, insert: option.value, description: option.description }));
}

/**
 * Opções e valores para a palavra no fim da linha: o valor de uma opção que o espera, a
 * escolha ou o valor do próximo argumento, e as opções ainda não usadas. `undefined` fecha a
 * lista (aspas abertas, cursor no meio, comando sem opções nem valores para oferecer).
 */
export function argSuggestions(state: LineState, context: LineContext): Suggestion[] | undefined {
  const { text } = state;
  if (state.cursor !== text.length) return undefined;
  let words: string[];
  try {
    words = splitArgs(text.slice(1));
  } catch {
    return undefined;
  }
  const spec = context.commandSpecs?.[words[0] ?? ''];
  if (!spec) return undefined;
  const fresh = /\s$/.test(text);
  const current = fresh ? '' : (words.at(-1) ?? '');
  const before = words.slice(1, fresh ? undefined : -1);
  const options = spec.options ?? {};
  const values = (source: ValueSource | undefined) => (source && context.values ? context.values(source) : []);

  const used = new Set<string>();
  let positional = 0;
  let pending: string | undefined;
  for (let i = 0; i < before.length; i++) {
    const word = before[i] as string;
    if (word.startsWith('--')) {
      const [name = '', inline] = word.slice(2).split('=');
      used.add(name);
      if (options[name]?.type === 'string' && inline === undefined) {
        if (i + 1 === before.length) pending = name;
        i++;
      }
    } else {
      positional++;
    }
  }

  if (pending) {
    const list = valueSuggestions(values(options[pending]?.values), current);
    return list.length > 0 ? list : undefined;
  }
  const optionList: Suggestion[] = Object.entries(options)
    .filter(([name, option]) => option.multiple || !used.has(name))
    .filter(([name]) => `--${name}`.startsWith(current))
    .map(([name, option]) => ({ name, label: optionLabel(name, option), insert: `--${name}`, description: optionDescription(option) }));
  if (current.startsWith('-')) return optionList.length > 0 ? optionList : undefined;

  const arg = spec.args?.[positional];
  const argList = [
    ...valueSuggestions((arg?.choices ?? []).map((choice) => ({ value: choice.name, description: choice.description })), current),
    ...valueSuggestions(values(arg?.values), current),
  ];
  const list = current ? argList : [...argList, ...optionList];
  return list.length > 0 ? list : undefined;
}

/** Palavra com aspas quando tem espaço ou caractere que o shell trataria. */
function quoteWord(word: string): string {
  return /[\s"'\\$`]/.test(word) ? `"${word.replace(/(["\\$`])/g, '\\$1')}"` : word;
}

/** Troca a palavra no fim da linha pela sugestão, seguida de espaço. */
function insertSuggestion(state: LineState, suggestion: Suggestion): { state: LineState } {
  const { text } = state;
  const start = /\s$/.test(text) ? text.length : text.lastIndexOf(' ') + 1;
  const completed = `${text.slice(0, start)}${quoteWord(suggestion.insert ?? suggestion.name)} `;
  return edit(state, completed, completed.length);
}

function edit(state: LineState, text: string, cursor: number): { state: LineState } {
  return { state: { ...state, text, cursor, selected: 0, dismissed: false, navigated: false, message: undefined } };
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
    if (chosen && isArgList(state)) return state.navigated ? insertSuggestion(state, chosen) : { submit: text };
    return { submit: chosen ? `/${chosen.name}` : text };
  }
  if (key.name === 'tab') {
    const chosen = list?.[state.selected];
    if (!chosen) return { state: quiet };
    if (isArgList(state)) return insertSuggestion(state, chosen);
    const completed = `/${chosen.name} `;
    return edit(state, completed, completed.length);
  }
  if (key.name === 'escape') return { state: { ...quiet, dismissed: list !== undefined || state.dismissed } };

  if (key.name === 'up' || key.name === 'down') {
    const delta = key.name === 'up' ? -1 : 1;
    if (list && list.length > 0) {
      // Na lista de opções, a primeira seta só mostra a seleção, na primeira linha.
      const selected = isArgList(state) && !state.navigated ? (delta > 0 ? 0 : list.length - 1) : (state.selected + delta + list.length) % list.length;
      return { state: { ...quiet, selected, navigated: true } };
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
    const args = isArgList(state);
    const label = (suggestion: Suggestion) => suggestion.label ?? `/${suggestion.name}`;
    const nameWidth = Math.max(...list.map((suggestion) => label(suggestion).length));
    const start = windowStart(state.selected, list.length);
    list.slice(start, start + LIST_SIZE).forEach((suggestion, offset) => {
      const planned = suggestion.plannedStep ? `  (passo ${suggestion.plannedStep})` : '';
      const plain = fit(label(suggestion).padEnd(nameWidth) + `  ${suggestion.description}${planned}`, width - 3);
      const text = args ? plain.slice(0, nameWidth) + style.dim(plain.slice(nameWidth)) : plain;
      // Na lista de opções, a seleção só aparece depois das setas: enter sem elas executa a linha.
      if (start + offset === state.selected && (!args || state.navigated)) lines.push(style.accent(`❯ ${text}`));
      else lines.push(suggestion.plannedStep ? style.dim(`  ${text}`) : `  ${text}`);
    });
    if (args) {
      const more = list.length > LIST_SIZE ? ` · ${list.length} ao todo` : '';
      lines.push(style.dim(`  tab completa · ↑/↓ escolhe · enter ${state.navigated ? 'escolhe' : 'executa'}${more}`));
    }
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
