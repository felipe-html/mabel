import type { Item } from './items.ts';
import { runScreen } from './menu.ts';
import {
  type ChoiceConfig,
  type ChoiceOption,
  type FormConfig,
  type FormValues,
  type ListConfig,
  type Tone,
  choiceState,
  choiceStep,
  ENTRY_ACTIONS,
  formState,
  formStep,
  listState,
  listStep,
  renderChoice,
  renderForm,
  renderList,
  renderText,
  textState,
  textStep,
} from './screens.ts';
import { style } from './style.ts';

/**
 * Entrada e saída dos fluxos interativos na interface guiada: toda escolha é um menu, todo
 * texto é um campo. Os testes trocam o terminal por respostas roteirizadas.
 */
export interface GuidedIO {
  write: (line: string) => void;
  /**
   * Menu de opções; resolve com o índice escolhido. Esc escolhe `back`, quando dado (e só
   * então aparece no rodapé). Ctrl+C lança `Interrupted`.
   */
  choose: (options: (string | ChoiceOption)[], settings?: ChooseSettings) => Promise<number>;
  /** Campo de texto, com o valor pré-preenchido; `null` quando o usuário cancela com esc. */
  text: (label: string, settings?: TextSettings) => Promise<string | null>;
  /** Lista repetível: as entradas e "+ adicionar"; esc conclui com a lista editada. */
  list: (title: string, entries: string[], settings?: ListConfig) => Promise<string[]>;
  /** Formulário; `null` quando o usuário volta. Sem ele, quem chama pede campo a campo. */
  form?: (config: FormConfig, values?: FormValues) => Promise<FormValues | null>;
}

export interface ChooseSettings {
  /** Opção selecionada ao abrir; o padrão é a primeira. */
  initial?: number;
  /** Opção que o esc escolhe. */
  back?: number;
}

export interface TextSettings {
  initial?: string;
  placeholder?: string;
}

const asOption = (option: string | ChoiceOption): ChoiceOption => (typeof option === 'string' ? { label: option } : option);

export const terminalGuided: GuidedIO = {
  write: (line) => process.stdout.write(`${line}\n`),
  choose: (options, settings = {}) => {
    const config: ChoiceConfig = { options: options.map(asOption), back: settings.back !== undefined };
    return runScreen<ReturnType<typeof choiceState>, number>({
      state: choiceState(settings.initial ?? 0),
      step: (state, key) => {
        const step = choiceStep(config, state, key);
        if ('state' in step) return step;
        return { result: 'chosen' in step ? step.chosen : (settings.back ?? 0) };
      },
      render: (state, width) => renderChoice(config, state, style, width),
      summary: (chosen) => [`${style.accent('    › ')}${config.options[chosen]?.label ?? ''}`],
    });
  },
  text: (label, settings = {}) =>
    runScreen<ReturnType<typeof textState>, string | null>({
      state: textState(settings.initial ?? ''),
      step: (state, key) => {
        const step = textStep(state, key);
        if ('state' in step) return step;
        return { result: 'done' in step ? step.done : null };
      },
      render: (state, width) => renderText({ label, placeholder: settings.placeholder }, state, style, width),
      summary: (value) => (value ? [`    ${style.dim(label.padEnd(12))} ${value}`] : []),
    }),
  list: (title, entries, settings = {}) =>
    runScreen<ReturnType<typeof listState>, string[]>({
      state: listState(entries),
      step: (state, key) => {
        const step = listStep(settings, state, key);
        return 'state' in step ? step : { result: step.done };
      },
      render: (state, width) => [style.bold(`  ${title}`), ...renderList(settings, state, style, width)],
      summary: (result) => [style.bold(`  ${title}`), ...result.map((entry) => `    - ${entry}`)],
    }),
  form: (config, values) => fillForm(config, values),
};

/**
 * Formulário no terminal; resolve com os valores, ou `null` quando o usuário volta com esc.
 * Ctrl+C lança `Interrupted`.
 */
export function fillForm(config: FormConfig, values: FormValues = {}): Promise<FormValues | null> {
  return runScreen<ReturnType<typeof formState>, FormValues | null>({
    state: formState(config, values),
    step: (state, key) => {
      const step = formStep(config, state, key);
      if ('state' in step) return step;
      return { result: 'submit' in step ? step.submit : null };
    },
    render: (state, width, height) => renderForm(config, state, style, width, height - 1),
    summary: (result) => (result && config.shell ? [style.dim(`  $ ${config.shell(result)}`)] : []),
  });
}

// Padrões de conversão -------------------------------------------------------------------

export interface ConfirmSettings {
  /** Texto da opção que não faz a ação; o padrão é "Voltar". */
  back?: string;
  /** Ação que apaga ou reverte: em vermelho. */
  danger?: boolean;
  /** A ação vem selecionada (o antigo `[S/n]`); sem isso, vem a opção segura. */
  actionFirst?: boolean;
}

/** O antigo `[s/N]`: dois itens, a ação e "Voltar"; esc escolhe "Voltar". */
export async function confirmAction(io: GuidedIO, action: string, settings: ConfirmSettings = {}): Promise<boolean> {
  const options: ChoiceOption[] = [{ label: action, danger: settings.danger }, { label: settings.back ?? 'Voltar' }];
  const chosen = await io.choose(options, { initial: settings.actionFirst ? 0 : 1, back: 1 });
  return chosen === 0;
}

/**
 * O antigo "enter mantém · - remove · texto substitui" seguido de "um por linha": cada
 * entrada com o menu Manter, Editar, Remover ("Editar" abre o campo já preenchido) e, no
 * fim, a lista repetível para acrescentar outras. `renamed` liga o texto antigo ao novo.
 */
export async function reviewEntries(io: GuidedIO, entries: string[], more = 'Acrescentar outros'): Promise<{ kept: string[]; renamed: Map<string, string> }> {
  const kept: string[] = [];
  const renamed = new Map<string, string>();
  for (const [i, entry] of entries.entries()) {
    io.write(`  ${i + 1}. ${entry}`);
    const action = ENTRY_ACTIONS[await io.choose([...ENTRY_ACTIONS.slice(0, 2), { label: 'Remover', danger: true }])];
    if (action === 'Remover') continue;
    if (action === 'Editar') {
      const edited = (await io.text('Novo texto', { initial: entry })) || entry;
      if (edited !== entry) renamed.set(entry, edited);
      kept.push(edited);
    } else kept.push(entry);
  }
  const extra = await io.list(more, []);
  return { kept: [...kept, ...extra], renamed };
}

/** Lista revisada entrada por entrada, sem guardar o que mudou. */
export async function editList(io: GuidedIO, entries: string[]): Promise<string[]> {
  return (await reviewEntries(io, entries)).kept;
}

/** O que a pessoa fez com uma pergunta do agente. */
export type QuestionAnswer = { answer: string } | { delegate: true } | { skip: true };

export interface QuestionSettings {
  sugestao?: string;
  /** "Deixar o agente decidir" aparece (não aparece em regra crítica, G7). */
  delegate?: boolean;
  /** Texto da opção de pular; ausente, a opção não aparece. */
  skip?: string;
}

/**
 * A pergunta com "enter aceita a sugestão · texto responde · d decide você · p pula" como
 * menu: "Aceitar a sugestão", "Responder com outro texto", "Deixar o agente decidir" e
 * "Pular por agora". A sugestão fica escrita acima, como no protótipo.
 */
export async function answerQuestion(io: GuidedIO, settings: QuestionSettings): Promise<QuestionAnswer> {
  const options: { label: string; then: () => Promise<QuestionAnswer | null> }[] = [];
  if (settings.sugestao) options.push({ label: 'Aceitar a sugestão', then: async () => ({ answer: settings.sugestao as string }) });
  options.push({
    label: 'Responder com outro texto',
    then: async () => {
      const text = await io.text('Resposta');
      return text ? { answer: text } : null;
    },
  });
  if (settings.delegate) options.push({ label: 'Deixar o agente decidir', then: async () => ({ delegate: true }) });
  if (settings.skip) options.push({ label: settings.skip, then: async () => ({ skip: true }) });
  for (;;) {
    const chosen = options[await io.choose(options.map((option) => option.label))];
    const result = await chosen?.then();
    if (result) return result;
  }
}

// Escolha de item ------------------------------------------------------------------------

/** Estado do item à direita, como no protótipo ("pronto", "esperando você", "na unidade"). */
export function itemChip(item: Item): { text: string; tone: Tone } {
  switch (item.status) {
    case 'backlog':
      return { text: 'rascunho', tone: 'dim' };
    case 'ready':
      return { text: 'pronto', tone: 'green' };
    case 'needs_human':
      return item.pendingKind === 'critical_approval' ? { text: 'aguardando aprovação', tone: 'yellow' } : { text: 'esperando você', tone: 'yellow' };
    case 'awaiting_merge':
      return { text: 'na unidade', tone: 'accent' };
    case 'blocked':
      return { text: 'bloqueado', tone: 'red' };
    case 'failed':
      return { text: 'falhou', tone: 'red' };
    case 'done':
      return { text: 'concluído', tone: 'dim' };
    case 'cancelled':
      return { text: 'cancelado', tone: 'dim' };
    default:
      return { text: 'em andamento', tone: 'accent' };
  }
}

/** Itens como opções da escolha de item, com o número como valor. */
export function itemOptions(items: Item[]): (ChoiceOption & { value: string })[] {
  return items.map((item) => ({ value: String(item.number), label: `#${item.number}  ${item.title}`, chip: itemChip(item) }));
}
