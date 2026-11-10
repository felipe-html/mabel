import type { Key, Style } from './menu.ts';

/**
 * Componentes de tela da interface guiada (`docs/specs/terminal.md`), puros: `step` recebe o
 * estado e a tecla e devolve o estado novo ou o resultado; `render` devolve as linhas. Quem
 * desenha no terminal e lê as teclas é `src/menu.ts`.
 *
 * Só valem as teclas universais: ↑ ↓, ← →, enter, espaço, esc e digitar. O rodapé de cada
 * tela lista as que funcionam nela.
 */

// Estilo ---------------------------------------------------------------------------------

/** Estilos da tela: os de `Style` e as cores do protótipo. */
export interface ScreenStyle extends Style {
  italic: (text: string) => string;
  green: (text: string) => string;
  yellow: (text: string) => string;
  red: (text: string) => string;
  /** Faixa da linha selecionada. */
  selected: (text: string) => string;
}

const same = (text: string) => text;

/** Sem cores: para os testes e para quem só quer o texto. */
export const plainStyle: ScreenStyle = {
  dim: same,
  bold: same,
  accent: same,
  italic: same,
  green: same,
  yellow: same,
  red: same,
  selected: same,
};

export type Tone = 'green' | 'yellow' | 'red' | 'accent' | 'dim';

const toned = (style: ScreenStyle, tone: Tone | undefined, text: string) => (tone ? style[tone](text) : text);

// Linhas ---------------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Colunas que o texto ocupa, sem as sequências de cor. */
export function visibleLength(text: string): number {
  return [...text.replace(ANSI, '')].length;
}

/** Corta o texto (sem cores) em `width` colunas, com reticências. */
export function fit(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

/**
 * Quebra a linha em pedaços de até `width` colunas sem partir as sequências de cor; cada
 * pedaço fecha a cor, e o seguinte a reabre.
 */
export function wrapLine(text: string, width: number, indent = ''): string[] {
  if (visibleLength(text) <= width || width <= indent.length) return [text];
  const out: string[] = [];
  let current = '';
  let columns = 0;
  let open = '';
  for (const token of text.match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu) ?? []) {
    if (token.startsWith('\x1b[')) {
      current += token;
      open = token === '\x1b[0m' ? '' : open + token;
      continue;
    }
    if (columns === width) {
      out.push(open ? `${current}\x1b[0m` : current);
      current = indent + open;
      columns = indent.length;
    }
    current += token;
    columns++;
  }
  out.push(current);
  return out;
}

/** Corta o texto colorido em `width` colunas, com reticências, sem partir as sequências de cor. */
export function clip(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  let out = '';
  let columns = 0;
  for (const token of text.match(/\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu) ?? []) {
    if (token.startsWith('\x1b[')) out += token;
    else if (columns < width - 1) {
      out += token;
      columns++;
    }
  }
  return `${out}…${text.includes('\x1b[') ? '\x1b[0m' : ''}`;
}

/** Linha com `left` à esquerda e `right` encostado à direita em `width` colunas. */
export function row(left: string, right: string, width: number): string {
  if (!right) return left;
  const free = width - visibleLength(left) - visibleLength(right);
  return `${left}${' '.repeat(Math.max(1, free))}${right}`;
}

const MARK_ON = '  › ';
const MARK_OFF = '    ';

/** Linha de uma lista: marcador, faixa de seleção na escolhida. */
export function listRow(on: boolean, left: string, right: string, style: ScreenStyle, width: number): string {
  const line = row(`${on ? style.accent(MARK_ON) : MARK_OFF}${left}`, right ? `${right}  ` : '', width);
  if (!on) return line;
  return style.selected(`${line}${' '.repeat(Math.max(0, width - visibleLength(line)))}`);
}

/** Título da tela: "‹ <título>", à direita o nome no shell, e a descrição embaixo. */
export function titleRows(title: string, style: ScreenStyle, width: number, right = '', description = ''): string[] {
  const lines = [row(`${style.accent('  ‹ ')}${style.bold(title)}`, right ? `${style.dim(right)}  ` : '', width)];
  if (description) lines.push(`    ${style.italic(description)}`);
  lines.push('');
  return lines;
}

// Rodapé de teclas -----------------------------------------------------------------------

/** Tecla e o que ela faz nesta tela. */
export type Hint = [key: string, action: string];

/** Teclas universais: as únicas que o rodapé pode citar. */
export const UNIVERSAL_KEYS = ['↑↓', '←→', 'enter', 'espaço', 'esc', 'digite'] as const;

/** Rodapé com as teclas que funcionam na tela. */
export function renderKeys(hints: Hint[], style: ScreenStyle, width = 80): string[] {
  return [style.dim('─'.repeat(Math.max(0, width - 1))), hints.map(([key, action]) => `${style.accent(` ${key}`)}${style.dim(` ${action} `)}`).join('')];
}

// Teclas ---------------------------------------------------------------------------------

export const isEnter = (key: Key) => key.name === 'return' || key.name === 'enter';
export const isEscape = (key: Key) => key.name === 'escape';
export const isInterrupt = (key: Key) => Boolean(key.ctrl && key.name === 'c');

/** Caracteres imprimíveis da tecla; colagens chegam como uma sequência longa. */
export function typed(key: Key): string {
  if (key.ctrl || key.meta || !key.sequence || key.name === 'escape' || key.name === 'return' || key.name === 'enter' || key.name === 'tab') return '';
  return [...key.sequence].filter((char) => char >= ' ' && char !== '\x7f').join('');
}

const wrap = (index: number, total: number) => (total === 0 ? 0 : (index + total) % total);

// Campo de texto -------------------------------------------------------------------------

export interface TextState {
  text: string;
  cursor: number;
}

export type TextStep = { state: TextState } | { done: string } | { cancel: true };

/** Campo com o valor pré-preenchido e o cursor no fim. */
export const textState = (text = ''): TextState => ({ text, cursor: [...text].length });

/** Transição do campo: digitar edita, ← → movem, enter confirma, esc cancela. */
export function textStep(state: TextState, key: Key): TextStep {
  const chars = [...state.text];
  const { cursor } = state;
  if (isEnter(key)) return { done: state.text.trim() };
  if (isEscape(key)) return { cancel: true };
  if (key.name === 'left') return { state: { ...state, cursor: Math.max(0, cursor - 1) } };
  if (key.name === 'right') return { state: { ...state, cursor: Math.min(chars.length, cursor + 1) } };
  if (key.name === 'home') return { state: { ...state, cursor: 0 } };
  if (key.name === 'end') return { state: { ...state, cursor: chars.length } };
  if (key.name === 'backspace') {
    if (cursor === 0) return { state };
    chars.splice(cursor - 1, 1);
    return { state: { text: chars.join(''), cursor: cursor - 1 } };
  }
  if (key.name === 'delete') {
    chars.splice(cursor, 1);
    return { state: { text: chars.join(''), cursor } };
  }
  const input = typed(key);
  if (!input) return { state };
  const added = [...input];
  chars.splice(cursor, 0, ...added);
  return { state: { text: chars.join(''), cursor: cursor + added.length } };
}

/** Texto em edição: negrito, com o cursor marcado; com `width`, a janela que mostra o cursor. */
export function editingText(state: TextState, style: ScreenStyle, width = Infinity): string {
  const chars = [...state.text];
  let before = chars.slice(0, state.cursor).join('');
  let after = chars.slice(state.cursor).join('');
  if (chars.length + 1 > width) {
    const room = Math.max(2, width - 1);
    if ([...before].length >= room) before = `…${[...before].slice(-(room - 1)).join('')}`;
    after = fit(after, Math.max(1, room - [...before].length));
  }
  return `${style.bold(before)}${style.accent('▏')}${style.bold(after)}`;
}

export const TEXT_HINTS: Hint[] = [
  ['enter', 'confirma'],
  ['esc', 'cancela'],
];

export interface TextConfig {
  label: string;
  /** Exemplo esmaecido, enquanto o campo está vazio. */
  placeholder?: string;
}

export function renderText(config: TextConfig, state: TextState, style: ScreenStyle, width = 80): string[] {
  const value = state.text || !config.placeholder ? editingText(state, style) : `${style.accent('▏')}${style.dim(config.placeholder)}`;
  return [`${style.accent(MARK_ON)}${config.label.padEnd(LABEL_WIDTH)}${value}`, '', ...renderKeys(TEXT_HINTS, style, width)];
}

// Escolha --------------------------------------------------------------------------------

export interface ChoiceOption {
  label: string;
  /** Texto esmaecido à direita. */
  hint?: string;
  /** Estado à direita, colorido ("pronto", "esperando você"). */
  chip?: { text: string; tone?: Tone };
  /** Ação que apaga ou reverte: em vermelho. */
  danger?: boolean;
  /** Motivo pelo qual a opção não pode ser escolhida agora; ausente quando está disponível. */
  disabledReason?: string;
}

export interface ChoiceConfig {
  options: ChoiceOption[];
  /** Várias escolhas: espaço marca, enter confirma. */
  multi?: boolean;
  /** Digitar filtra a lista. */
  filter?: boolean;
  /** Esc volta sem escolher. */
  back?: boolean;
  /** Texto da lista vazia. */
  empty?: string;
  /** Linhas visíveis de uma vez; as outras rolam. */
  size?: number;
}

export interface ChoiceState {
  /** Posição na lista filtrada. */
  cursor: number;
  /** Índices marcados, na lista completa (só na escolha de várias). */
  chosen: number[];
  filter: string;
  message?: string;
}

export type ChoiceStep = { state: ChoiceState } | { chosen: number } | { marked: number[] } | { back: true };

export const EMPTY_LIST = 'Nenhum item nesse estado agora.';

export const choiceState = (cursor = 0, chosen: number[] = []): ChoiceState => ({ cursor, chosen, filter: '' });

const normalize = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Índices (na lista completa) das opções que casam com o filtro. */
export function visibleOptions(options: ChoiceOption[], filter: string): number[] {
  const needle = normalize(filter.trim());
  return options.flatMap((option, i) =>
    !needle || normalize(`${option.label} ${option.hint ?? ''} ${option.chip?.text ?? ''}`).includes(needle) ? [i] : [],
  );
}

/** Transição da escolha: ↑ ↓ navegam, enter escolhe (ou confirma as marcadas), espaço marca. */
export function choiceStep(config: ChoiceConfig, state: ChoiceState, key: Key): ChoiceStep {
  const visible = visibleOptions(config.options, state.filter);
  const quiet = { ...state, message: undefined };
  const move = (cursor: number): ChoiceStep => ({ state: { ...quiet, cursor: wrap(cursor, visible.length) } });

  if (isEscape(key)) {
    if (state.filter) return { state: { ...quiet, filter: '', cursor: 0 } };
    return config.back ? { back: true } : { state: quiet };
  }
  if (key.name === 'up') return move(state.cursor - 1);
  if (key.name === 'down') return move(state.cursor + 1);
  if (key.name === 'home') return move(0);
  if (key.name === 'end') return move(visible.length - 1);
  const index = visible[state.cursor];
  if (key.name === 'space' && config.multi) {
    if (index === undefined) return { state: quiet };
    const chosen = state.chosen.includes(index) ? state.chosen.filter((i) => i !== index) : [...state.chosen, index];
    return { state: { ...quiet, chosen } };
  }
  if (isEnter(key)) {
    if (config.multi) return { marked: [...state.chosen].sort((a, b) => a - b) };
    if (index === undefined) return { state: quiet };
    const reason = config.options[index]?.disabledReason;
    return reason ? { state: { ...quiet, message: reason } } : { chosen: index };
  }
  if (config.filter) {
    if (key.name === 'backspace') return { state: { ...quiet, filter: state.filter.slice(0, -1), cursor: 0 } };
    const input = typed(key);
    if (input && input.trim()) return { state: { ...quiet, filter: state.filter + input, cursor: 0 } };
  }
  return { state: quiet };
}

export function choiceHints(config: ChoiceConfig, back = 'volta'): Hint[] {
  return [
    ['↑↓', 'navegar'],
    ...(config.multi ? ([['espaço', 'marca']] as Hint[]) : []),
    ['enter', config.multi ? 'confirma' : 'escolher'],
    ...(config.filter ? ([['digite', 'filtra']] as Hint[]) : []),
    ...(config.back ? ([['esc', back]] as Hint[]) : []),
  ];
}

/** Linhas das opções, sem o rodapé (o formulário usa o mesmo corpo). */
export function choiceBody(config: ChoiceConfig, state: ChoiceState, style: ScreenStyle, width = 80): string[] {
  const visible = visibleOptions(config.options, state.filter);
  const lines: string[] = [];
  if (config.filter) {
    lines.push(state.filter ? `${style.accent(MARK_ON)}${style.bold(state.filter)}${style.accent('▏')}` : `${style.accent(MARK_ON)}${style.accent('▏')}${style.dim('digite para filtrar')}`, '');
  }
  if (config.options.length === 0) lines.push(`  ${style.dim(config.empty ?? EMPTY_LIST)}`);
  else if (visible.length === 0) lines.push(`  ${style.yellow('Nada casa com o filtro.')}`);
  const size = config.size ?? visible.length;
  const start = visible.length <= size ? 0 : Math.min(Math.max(0, state.cursor - size + 1), visible.length - size);
  if (start > 0) lines.push(`    ${style.dim(`↑ mais ${start}`)}`);
  visible.slice(start, start + size).forEach((index, offset) => {
    const option = config.options[index] as ChoiceOption;
    const on = start + offset === state.cursor;
    const mark = config.multi ? (state.chosen.includes(index) ? '[x] ' : '[ ] ') : '';
    const label = option.danger ? style.red(option.label) : option.disabledReason ? style.dim(option.label) : on ? style.bold(option.label) : option.label;
    const right = option.chip ? toned(style, option.chip.tone, option.chip.text) : option.hint ? style.dim(option.hint) : '';
    lines.push(listRow(on, `${mark}${label}`, right, style, width));
  });
  const below = visible.length - start - size;
  if (below > 0) lines.push(`    ${style.dim(`↓ mais ${below}`)}`);
  return lines;
}

export function renderChoice(config: ChoiceConfig, state: ChoiceState, style: ScreenStyle, width = 80, back = 'volta'): string[] {
  const lines = choiceBody(config, state, style, width);
  lines.push('');
  if (state.message) lines.push(`  ${style.yellow(state.message)}`);
  return [...lines, ...renderKeys(choiceHints(config, back), style, width)];
}

// Lista repetível ------------------------------------------------------------------------

export const ADD_ENTRY = '+ adicionar';

/** Menu de cada entrada, quando a lista revisa o que veio pronto. */
export const ENTRY_ACTIONS = ['Manter', 'Editar', 'Remover'] as const;

export interface ListConfig {
  /** Enter numa entrada abre "Manter, Editar, Remover"; sem isso, abre o campo já preenchido. */
  entryActions?: boolean;
  /** O que o esc faz, no rodapé: "volta" no formulário, "conclui" num fluxo. */
  done?: string;
}

export interface ListState {
  entries: string[];
  /** Posição: as entradas e, por último, "+ adicionar". */
  cursor: number;
  /** Entrada em edição; `index` igual ao número de entradas é a nova. */
  edit?: { index: number; text: TextState };
  /** Menu aberto da entrada sob o cursor. */
  actions?: number;
}

export type ListStep = { state: ListState } | { done: string[] };

export const listState = (entries: string[]): ListState => ({ entries: [...entries], cursor: 0 });

/** Transição da lista: enter edita (ou abre o menu da entrada), editar e deixar vazia remove, esc conclui. */
export function listStep(config: ListConfig, state: ListState, key: Key): ListStep {
  const { entries, cursor } = state;
  if (state.edit) {
    const { index } = state.edit;
    const step = textStep(state.edit.text, key);
    if ('state' in step) return { state: { ...state, edit: { index, text: step.state } } };
    if ('cancel' in step) return { state: { ...state, edit: undefined } };
    const next = [...entries];
    if (index === entries.length) {
      if (step.done) next.push(step.done);
    } else if (step.done) next[index] = step.done;
    else next.splice(index, 1);
    return { state: { entries: next, cursor: Math.min(cursor, next.length) } };
  }
  if (state.actions !== undefined) {
    if (key.name === 'up' || key.name === 'down') {
      return { state: { ...state, actions: wrap(state.actions + (key.name === 'up' ? -1 : 1), ENTRY_ACTIONS.length) } };
    }
    if (isEscape(key)) return { state: { ...state, actions: undefined } };
    if (!isEnter(key)) return { state };
    const action = ENTRY_ACTIONS[state.actions];
    if (action === 'Editar') return { state: { ...state, actions: undefined, edit: { index: cursor, text: textState(entries[cursor]) } } };
    if (action === 'Remover') {
      const next = entries.filter((_, i) => i !== cursor);
      return { state: { entries: next, cursor: Math.min(cursor, next.length) } };
    }
    return { state: { ...state, actions: undefined } };
  }
  const total = entries.length + 1;
  if (key.name === 'up') return { state: { ...state, cursor: wrap(cursor - 1, total) } };
  if (key.name === 'down') return { state: { ...state, cursor: wrap(cursor + 1, total) } };
  if (isEscape(key)) return { done: entries };
  if (isEnter(key)) {
    if (cursor < entries.length && config.entryActions) return { state: { ...state, actions: 0 } };
    return { state: { ...state, edit: { index: cursor, text: textState(entries[cursor] ?? '') } } };
  }
  return { state };
}

export function listHints(config: ListConfig, state: ListState): Hint[] {
  if (state.edit) return TEXT_HINTS;
  if (state.actions !== undefined) return [['↑↓', 'navegar'], ['enter', 'escolher'], ['esc', 'volta']];
  return [['↑↓', 'navegar'], ['enter', config.entryActions && state.cursor < state.entries.length ? 'abrir' : 'editar'], ['esc', config.done ?? 'conclui']];
}

export function listBody(config: ListConfig, state: ListState, style: ScreenStyle, width = 80): string[] {
  const lines: string[] = [];
  [...state.entries, null].forEach((entry, i) => {
    const on = i === state.cursor;
    const editing = state.edit && state.edit.index === i;
    const text = editing ? editingText((state.edit as { text: TextState }).text, style) : entry === null ? style.accent(ADD_ENTRY) : entry;
    lines.push(listRow(on && !state.edit && state.actions === undefined, text, '', style, width));
    if (on && state.actions !== undefined) {
      ENTRY_ACTIONS.forEach((action, j) => {
        const label = action === 'Remover' ? style.red(action) : action;
        lines.push(listRow(j === state.actions, `    ${label}`, '', style, width));
      });
    }
  });
  return lines;
}

export function renderList(config: ListConfig, state: ListState, style: ScreenStyle, width = 80): string[] {
  return [...listBody(config, state, style, width), '', ...renderKeys(listHints(config, state), style, width)];
}

// Formulário -----------------------------------------------------------------------------

export type FormValue = string | boolean | string[];
export type FormValues = Record<string, FormValue | undefined>;

interface FieldBase {
  key: string;
  label: string;
  /** Obrigatório; a função decide pelo que já foi preenchido. */
  required?: boolean | ((values: FormValues) => boolean);
  /** Campo condicional: só aparece quando faz sentido. */
  when?: (values: FormValues) => boolean;
}

/** Valor ou exemplo esmaecido; enter edita, começar a digitar também. */
export interface TextField extends FieldBase {
  type: 'text';
  placeholder?: string;
}

/** "◂ valor ▸": ← → ou enter trocam. */
export interface ChoiceField extends FieldBase {
  type: 'choice';
  options: [value: string, label: string][];
}

/** "[x] sim" / "[ ] não": espaço ou enter trocam. */
export interface BoolField extends FieldBase {
  type: 'bool';
}

/** Abre a escolha de item: uma, ou várias com "[x]". */
export interface PickField extends FieldBase {
  type: 'pick';
  options: (values: FormValues) => (ChoiceOption & { value: string })[];
  multi?: boolean;
  /** Singular e plural, para "2 referências". */
  noun?: [string, string];
}

/** Abre as entradas com "+ adicionar". */
export interface ListField extends FieldBase {
  type: 'list';
  noun?: [string, string];
}

/** Linhas só de leitura que dependem do que foi escolhido. */
export interface InfoField {
  type: 'info';
  key: string;
  lines: (values: FormValues) => string[];
  when?: (values: FormValues) => boolean;
}

export type FormField = TextField | ChoiceField | BoolField | PickField | ListField | InfoField;
type InputField = Exclude<FormField, InfoField>;

export interface FormConfig {
  title: string;
  description?: string;
  /** Nome no shell, à direita do título. */
  command?: string;
  fields: FormField[];
  /** Texto do botão. */
  action: string;
  /** Ação que apaga ou reverte: botão em vermelho. */
  danger?: boolean | ((values: FormValues) => boolean);
  /** Problema que impede a ação mesmo com os campos preenchidos. */
  check?: (values: FormValues) => string | null;
  /** Comando de shell equivalente, sem o "$ ". */
  shell?: (values: FormValues) => string;
}

export interface FormState {
  values: FormValues;
  /** Posição: os campos visíveis e, por último, o botão. */
  cursor: number;
  edit?: { key: string; text: TextState };
  sub?: { key: string; choice?: ChoiceState; list?: ListState };
  message?: string;
}

export type FormStep = { state: FormState } | { submit: FormValues } | { back: true };

export function formState(config: FormConfig, values: FormValues = {}): FormState {
  const initial: FormValues = {};
  for (const field of config.fields) {
    if (field.type === 'choice') initial[field.key] = field.options[0]?.[0] ?? '';
    if (field.type === 'bool') initial[field.key] = false;
  }
  return { values: { ...initial, ...values }, cursor: 0 };
}

const visibleFields = (config: FormConfig, values: FormValues) => config.fields.filter((field) => !field.when || field.when(values));
const inputFields = (config: FormConfig, values: FormValues) => visibleFields(config, values).filter((field): field is InputField => field.type !== 'info');

const blank = (value: FormValue | undefined) => value === undefined || value === '' || value === false || (Array.isArray(value) && value.length === 0);

const isRequired = (field: InputField, values: FormValues) => (typeof field.required === 'function' ? field.required(values) : Boolean(field.required));

/** Campos obrigatórios ainda vazios. */
export function missingFields(config: FormConfig, values: FormValues): InputField[] {
  return inputFields(config, values).filter((field) => isRequired(field, values) && blank(values[field.key]));
}

/** Transição do formulário, como no protótipo: ↑ ↓ campos, enter edita ou abre, ← → trocam, esc volta. */
export function formStep(config: FormConfig, state: FormState, key: Key): FormStep {
  const fields = inputFields(config, state.values);
  const quiet: FormState = { ...state, message: undefined };
  const set = (fieldKey: string, value: FormValue): FormState => ({ ...quiet, values: { ...state.values, [fieldKey]: value } });

  if (state.edit) {
    const { key: fieldKey } = state.edit;
    const step = textStep(state.edit.text, key);
    if ('state' in step) return { state: { ...quiet, edit: { key: fieldKey, text: step.state } } };
    if ('cancel' in step) return { state: { ...quiet, edit: undefined } };
    return { state: { ...set(fieldKey, step.done), edit: undefined } };
  }

  if (state.sub) {
    const field = fields.find((f) => f.key === state.sub?.key);
    if (field?.type === 'list') {
      const step = listStep({ done: 'volta' }, state.sub.list as ListState, key);
      if ('state' in step) return { state: { ...quiet, sub: { key: field.key, list: step.state } } };
      return { state: { ...set(field.key, step.done), sub: undefined } };
    }
    if (field?.type === 'pick') {
      const options = field.options(state.values);
      const step = choiceStep(pickChoice(field, options), state.sub.choice as ChoiceState, key);
      if ('state' in step) return { state: { ...quiet, sub: { key: field.key, choice: step.state } } };
      if ('back' in step) return { state: { ...quiet, sub: undefined } };
      if ('marked' in step) return { state: { ...set(field.key, step.marked.map((i) => options[i]?.value ?? '')), sub: undefined } };
      return { state: { ...set(field.key, options[step.chosen]?.value ?? ''), sub: undefined } };
    }
    return { state: { ...quiet, sub: undefined } };
  }

  const total = fields.length + 1;
  if (key.name === 'up') return { state: { ...quiet, cursor: wrap(state.cursor - 1, total) } };
  if (key.name === 'down' || key.name === 'tab') return { state: { ...quiet, cursor: wrap(state.cursor + 1, total) } };
  if (isEscape(key)) return { back: true };

  const field = fields[state.cursor];
  if (!field) {
    if (!isEnter(key)) return { state: quiet };
    const missing = missingFields(config, state.values);
    if (missing.length > 0) return { state: { ...quiet, message: `Preencha antes: ${missing.map((f) => f.label).join(', ')}.` } };
    const problem = config.check?.(state.values);
    if (problem) return { state: { ...quiet, message: problem } };
    return { submit: state.values };
  }
  if (field.type === 'choice' && (key.name === 'left' || key.name === 'right' || isEnter(key))) {
    const current = field.options.findIndex(([value]) => value === (state.values[field.key] ?? ''));
    const next = field.options[wrap(current + (key.name === 'left' ? -1 : 1), field.options.length)];
    return { state: set(field.key, next?.[0] ?? '') };
  }
  if (field.type === 'bool' && (key.name === 'space' || isEnter(key))) return { state: set(field.key, !state.values[field.key]) };
  if (field.type === 'text') {
    const current = typeof state.values[field.key] === 'string' ? (state.values[field.key] as string) : '';
    if (isEnter(key)) return { state: { ...quiet, edit: { key: field.key, text: textState(current) } } };
    const input = typed(key);
    if (input) return { state: { ...quiet, edit: { key: field.key, text: textState(current + input) } } };
  }
  if (field.type === 'list' && isEnter(key)) {
    const current = Array.isArray(state.values[field.key]) ? (state.values[field.key] as string[]) : [];
    return { state: { ...quiet, sub: { key: field.key, list: listState(current) } } };
  }
  if (field.type === 'pick' && isEnter(key)) {
    const options = field.options(state.values);
    const current = state.values[field.key];
    const chosen = Array.isArray(current) ? options.flatMap((option, i) => (current.includes(option.value) ? [i] : [])) : [];
    const cursor = typeof current === 'string' ? Math.max(0, options.findIndex((option) => option.value === current)) : 0;
    return { state: { ...quiet, sub: { key: field.key, choice: choiceState(cursor, chosen) } } };
  }
  return { state: quiet };
}

const LABEL_WIDTH = 29;

function count(n: number, noun: [string, string]): string {
  return `${n} ${n === 1 ? noun[0] : noun[1]}`;
}

function fieldValue(field: InputField, values: FormValues, style: ScreenStyle): string {
  const value = values[field.key];
  switch (field.type) {
    case 'bool':
      return value ? '[x] sim' : style.dim('[ ] não');
    case 'choice': {
      const label = field.options.find(([option]) => option === (value ?? ''))?.[1] ?? '';
      return `${style.dim('◂ ')}${label}${style.dim(' ▸')}`;
    }
    case 'list': {
      const n = Array.isArray(value) ? value.length : 0;
      return n ? count(n, field.noun ?? ['item', 'itens']) : style.dim('nenhum');
    }
    case 'pick': {
      if (field.multi) {
        const n = Array.isArray(value) ? value.length : 0;
        return n ? count(n, field.noun ?? ['item', 'itens']) : style.dim('nenhum');
      }
      const option = typeof value === 'string' && value ? field.options(values).find((o) => o.value === value) : undefined;
      if (option) return option.label;
      if (typeof value === 'string' && value) return value;
      return style.dim(isRequired(field, values) ? 'escolher (obrigatório)' : 'escolher');
    }
    case 'text':
      return typeof value === 'string' && value ? value : style.dim(field.placeholder ?? '');
  }
}

/** Linha de shell quebrada em palavras, para caber na largura sem cortar. */
export function shellRows(line: string, style: ScreenStyle, width = 80): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current && current.length + 1 + word.length > width - 8) {
      out.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  out.push(current);
  return out.map((text, i) => `${style.dim(i ? '      ' : '  $ ')}${text}`);
}

/** O que o esc faz no nível de cima do formulário: "menu" quando a tela inicial está aberta. */
export const formExit = { action: 'volta' };

export function formHints(config: FormConfig, state: FormState): Hint[] {
  if (state.edit) return TEXT_HINTS;
  const fields = inputFields(config, state.values);
  const sub = state.sub && fields.find((f) => f.key === state.sub?.key);
  if (sub?.type === 'list') return listHints({ done: 'volta' }, state.sub?.list as ListState);
  if (sub?.type === 'pick') return choiceHints(pickChoice(sub, []));
  return [
    ['↑↓', 'campos'],
    ['enter', 'editar'],
    ...(fields.some((f) => f.type === 'choice') ? ([['←→', 'opções']] as Hint[]) : []),
    ...(fields.some((f) => f.type === 'bool') ? ([['espaço', 'marca']] as Hint[]) : []),
    ['esc', formExit.action],
  ];
}

/** Escolha aberta por um campo `pick`: filtra ao digitar e rola em `size` linhas. */
function pickChoice(field: PickField, options: ChoiceOption[], size?: number): ChoiceConfig {
  return { options, multi: field.multi, back: true, filter: true, size };
}

/** Linhas da escolha de um `pick` fora as opções: filtro, as duas setas de rolagem, a mensagem e o rodapé. */
const PICK_CHROME_ROWS = 2 + 2 + 2 + 2;

/**
 * Formulário sem o rodapé de teclas: o corpo que uma tela cheia emoldura. `rows` são as
 * linhas que o corpo pode ocupar; a lista de um `pick` rola dentro delas.
 */
export function formBody(config: FormConfig, state: FormState, style: ScreenStyle, width = 80, rows?: number): string[] {
  const lines = renderForm(config, state, style, width, rows === undefined ? undefined : rows + 2);
  return lines.slice(0, -2);
}

/** `rows`: linhas que a tela pode ocupar; sem ele, a lista de um `pick` mostra todas as opções. */
export function renderForm(config: FormConfig, state: FormState, style: ScreenStyle, width = 80, rows?: number): string[] {
  const fields = inputFields(config, state.values);
  const lines: string[] = [];
  const sub = state.sub && fields.find((f) => f.key === state.sub?.key);
  if (sub && state.sub) {
    if (sub.type === 'list') {
      lines.push(...titleRows(`${config.title} › ${sub.label}`, style, width, '', 'enter edita; deixe vazio para remover'));
      lines.push(...listBody({ done: 'volta' }, state.sub.list as ListState, style, width));
    } else if (sub.type === 'pick') {
      lines.push(...titleRows(`${config.title} › ${sub.label}`, style, width, '', sub.multi ? 'espaço marca, enter confirma' : ''));
      const size = rows === undefined ? undefined : Math.max(3, rows - lines.length - PICK_CHROME_ROWS);
      lines.push(...choiceBody(pickChoice(sub, sub.options(state.values), size), state.sub.choice as ChoiceState, style, width));
    }
  } else {
    lines.push(...titleRows(config.title, style, width, config.command ? `mabel ${config.command}` : '', config.description));
    let position = 0;
    for (const field of visibleFields(config, state.values)) {
      if (field.type === 'info') {
        const info = field.lines(state.values);
        for (const line of info) lines.push(`${' '.repeat(LABEL_WIDTH + 2)}${line}`);
        if (info.length > 0) lines.push('');
        continue;
      }
      const on = position === state.cursor;
      const editing = state.edit?.key === field.key;
      const arrow = field.type === 'pick' || field.type === 'list' ? style.dim('▸') : '';
      // O valor longo é cortado com "…", como no protótipo; a linha nunca quebra.
      const room = Math.max(4, width - MARK_ON.length - LABEL_WIDTH - (arrow ? 4 : 1));
      const value = editing ? editingText((state.edit as { text: TextState }).text, style, room) : clip(fieldValue(field, state.values, style), room);
      const label = on ? style.bold(field.label.padEnd(LABEL_WIDTH)) : field.label.padEnd(LABEL_WIDTH);
      lines.push(listRow(on, `${label}${value}`, arrow, style, width));
      position++;
    }
    lines.push('');
    const missing = missingFields(config, state.values);
    const danger = typeof config.danger === 'function' ? config.danger(state.values) : config.danger;
    const button = `[ ${config.action} ]`;
    const painted = missing.length > 0 ? style.dim(button) : style.bold(danger ? style.red(button) : style.accent(button));
    const lack = missing.length > 0 ? style.yellow(`falta: ${missing.map((f) => f.label).join(', ')}`) : '';
    lines.push(listRow(state.cursor === fields.length, painted, lack, style, width));
    if (config.shell) lines.push('', ...shellRows(config.shell(state.values), style, width));
  }
  lines.push('');
  lines.push(state.message ? `  ${style.yellow(state.message)}` : '');
  return [...lines, ...renderKeys(formHints(config, state), style, width)];
}

// Vista ----------------------------------------------------------------------------------

/** Saída só de leitura: enter ou esc voltam. */
export type ViewStep = { state: null } | { done: true };

export function viewStep(key: Key): ViewStep {
  return isEnter(key) || isEscape(key) ? { done: true } : { state: null };
}

export const VIEW_HINTS: Hint[] = [
  ['enter', 'volta'],
  ['esc', 'volta'],
];

/** Vista mais alta que a tela: ↑ ↓ rolam, enter ou esc voltam. */
export type ScrollStep = { state: number } | { done: true };

export function scrollStep(scroll: number, key: Key, overflow: number): ScrollStep {
  if (isEnter(key) || isEscape(key)) return { done: true };
  if (key.name === 'up') return { state: Math.max(0, scroll - 1) };
  if (key.name === 'down') return { state: Math.min(Math.max(0, overflow), scroll + 1) };
  if (key.name === 'home') return { state: 0 };
  if (key.name === 'end') return { state: Math.max(0, overflow) };
  return { state: scroll };
}

/** Janela de `rows` linhas a partir de `scroll`, com "↑ mais N" e "↓ mais N" quando há o que rolar. */
export function scrollWindow(lines: string[], scroll: number, rows: number, style: ScreenStyle): string[] {
  if (lines.length <= rows) return lines;
  const room = Math.max(1, rows - 2);
  const start = Math.min(Math.max(0, scroll), lines.length - room);
  const below = lines.length - start - room;
  return [start > 0 ? `    ${style.dim(`↑ mais ${start}`)}` : '', ...lines.slice(start, start + room), below > 0 ? `    ${style.dim(`↓ mais ${below}`)}` : ''];
}

export function renderView(title: string, body: string[], style: ScreenStyle, width = 80, command = ''): string[] {
  return [...titleRows(title, style, width, command ? `mabel ${command}` : ''), ...body, '', ...renderKeys(VIEW_HINTS, style, width)];
}

// Linha de shell -------------------------------------------------------------------------

/** Palavra com aspas quando tem espaço ou caractere que o shell trataria. */
export function shellWord(word: string): string {
  return word && !/[\s"'\\$`*?#&|;<>()!]/.test(word) ? word : `"${word.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** Comando de shell com as palavras citadas quando preciso. */
export function shellLine(words: string[]): string {
  return words.map(shellWord).join(' ');
}
