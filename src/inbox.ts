import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Interrupted, interactive } from './ask.ts';
import { dataDir, openDb } from './db.ts';
import { type DecisionOptions, approve, cancel, respond } from './decisions.ts';
import { renderItemDetail } from './decide.ts';
import { fail } from './errors.ts';
import { type GuidedIO, answerQuestion } from './guided.ts';
import { type Item, type ItemStatus, type Pending, type PendingKind, listItems } from './items.ts';
import { writeJson } from './json.ts';
import { humanAttemptsSummary } from './pipeline.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import type { PlanOutput, Question } from './schemas/stages.ts';
import { readArtifact } from './stages.ts';
import { style } from './style.ts';
import { conflictCommand, queueConflict } from './units.ts';
import { type OptionSpecs, jsonOption } from './options.ts';

export const inboxUsage = 'mabel decidir [--json]';

export const inboxOptions = { json: jsonOption } satisfies OptionSpecs;

/** Resposta gravada quando o humano devolve a pergunta ao agente. */
export const DELEGATE = 'decida e registre como suposição.';

/** Entrada e saída da inbox; os testes trocam o terminal por respostas roteirizadas. */
export type InboxIO = GuidedIO;


export interface InboxResult {
  answered: number;
  skipped: number;
  interrupted: boolean;
}

const KIND_LABELS: Record<PendingKind, string> = {
  question_plan: 'perguntas do planejamento',
  question_execute: 'perguntas da execução',
  plan_incomplete: 'plano incompleto',
  critical_approval: 'aprovação de item crítico',
  attempts_exhausted: 'tentativas esgotadas',
  environment_block: 'impedimento de ambiente',
  integration_conflict: 'conflito com a integração',
};

const VIA: DecisionOptions = { via: 'inbox' };
const INDENT = '      ';

/** Itens parados em `needs_human`, em ordem de número. */
export function pendingItems(db: DatabaseSync, projectId: string): Item[] {
  return listItems(db, projectId)
    .filter((item) => item.status === 'needs_human' && item.pendingKind)
    .sort((a, b) => a.number - b.number);
}

/**
 * O conflito da base que pausa a fila (`base_conflict`): não é de um item, e a decisão é
 * resolver o merge à mão. Vazio quando não há.
 */
export function baseConflictLines(db: DatabaseSync, project: Project): string[] {
  const conflict = queueConflict(db, project);
  if (!conflict) return [];
  const what = conflict.unit ? `a unidade ${conflict.unit} (${conflict.source})` : `a ${conflict.source}`;
  return [
    `Fila pausada: conflito entre ${what} e a ${project.config.integracao}`,
    `${INDENT}arquivos em conflito: ${conflict.files.join(', ')}`,
    `${INDENT}resolva: ${conflictCommand(project, conflict)}`,
    `${INDENT}corrija os arquivos, commite e volte com git switch ${project.config.baseBranch}; o próximo mabel rodar segue`,
  ];
}

/** Junta perguntas e respostas no texto que vai para o agente. */
export function answerText(pairs: { question: string; answer: string }[]): string {
  return pairs.map(({ question, answer }, i) => `P${i + 1}: ${question}\nR${i + 1}: ${answer}`).join('\n');
}

/** Resposta gravada quando o humano confirma as suposições críticas sem corrigir. */
const CONFIRM_ASSUMPTIONS = 'Confirmo as suposições.';

function assumptionsQuestion(critical: string[]): string {
  return `Suposições críticas: ${critical.join('; ')}`;
}

/**
 * Respostas de `mabel responder --respostas` no texto que a inbox monta. Aceita uma lista,
 * uma resposta por pergunta, ou `{ "perguntas": [...], "suposicoes_criticas": … }`, a forma
 * exigida quando o item tem suposições críticas. Por pergunta: texto responde, `null` ou
 * vazio aceita a sugestão e `DELEGATE` devolve ao agente, recusado em regra crítica (G7).
 * Nas suposições críticas, `null` confirma e texto corrige; não há delegação.
 */
export function answersFromJson(value: unknown, pending: Pending): { text: string } | { error: string } {
  const questions = pending.questions ?? [];
  const critical = pending.criticalAssumptions ?? [];
  if (questions.length === 0 && critical.length === 0) return { error: 'o item não tem perguntas; responda com texto' };
  let answers: unknown;
  let assumptions: unknown;
  if (Array.isArray(value)) {
    if (critical.length > 0) return { error: 'o item tem suposições críticas; use {"perguntas": [...], "suposicoes_criticas": null ou texto}' };
    answers = value;
  } else if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    answers = object.perguntas ?? [];
    if (critical.length > 0 && !('suposicoes_criticas' in object)) {
      return { error: 'confirme (null) ou corrija (texto) as suposições críticas em "suposicoes_criticas"' };
    }
    if (critical.length === 0 && 'suposicoes_criticas' in object) return { error: 'o item não tem suposições críticas' };
    assumptions = object.suposicoes_criticas;
  } else {
    return { error: 'use uma lista JSON ou um objeto com "perguntas"' };
  }
  if (!Array.isArray(answers)) return { error: '"perguntas" precisa ser uma lista' };
  if (answers.length !== questions.length) return { error: `${answers.length} respostas para ${questions.length} perguntas` };

  const pairs: { question: string; answer: string }[] = [];
  for (const [i, answer] of answers.entries()) {
    const question = questions[i] as Question;
    if (answer !== null && typeof answer !== 'string') return { error: `resposta ${i + 1}: use texto ou null` };
    const text = (answer ?? '').trim();
    if (text === DELEGATE && question.regraCritica) return { error: `resposta ${i + 1}: pergunta de regra crítica; a resposta é sua` };
    if (!text && !question.sugestao) return { error: `resposta ${i + 1}: a pergunta não tem sugestão; responda com texto` };
    pairs.push({ question: question.texto, answer: text || question.sugestao });
  }
  if (critical.length > 0) {
    if (assumptions !== null && typeof assumptions !== 'string') return { error: 'suposições críticas: use texto ou null' };
    const text = (assumptions ?? '').trim();
    if (text === DELEGATE) return { error: 'suposições críticas: a decisão é sua; confirme (null) ou corrija' };
    pairs.push({ question: assumptionsQuestion(critical), answer: text || CONFIRM_ASSUMPTIONS });
  }
  return { text: answerText(pairs) };
}

/** Item pulado: continua em `needs_human`. */
const SKIP = Symbol('skip');
type Answer = string | typeof SKIP;

/** Opção da pendência: o texto do menu e o que ela faz. */
interface Action<T> {
  label: string;
  danger?: boolean;
  then: () => Promise<T | null>;
}

/** Menu das opções da pendência; uma opção que devolve `null` (texto cancelado) volta ao menu. */
async function chooseAction<T>(io: InboxIO, actions: Action<T>[]): Promise<T> {
  for (;;) {
    const action = actions[await io.choose(actions.map(({ label, danger }) => ({ label, danger })))];
    const result = await action?.then();
    if (result !== null && result !== undefined) return result;
  }
}

/** Campo de texto que devolve `null` quando vazio ou cancelado. */
async function textOrNull(io: InboxIO, label: string): Promise<string | null> {
  return (await io.text(label)) || null;
}

const SKIP_LABEL = 'Pular por agora';

async function askQuestions(io: InboxIO, questions: Question[]): Promise<Answer[] | typeof SKIP> {
  const answers: Answer[] = [];
  for (const [i, question] of questions.entries()) {
    io.write(`  ${i + 1}/${questions.length} ${question.texto}${question.regraCritica ? style.dim(' (regra crítica)') : ''}`);
    if (question.sugestao) io.write(`${INDENT}sugestão: ${question.sugestao}`);
    // Regra crítica é decisão humana (G7): sem "deixar o agente decidir".
    const result = await answerQuestion(io, { sugestao: question.sugestao, delegate: !question.regraCritica, skip: SKIP_LABEL });
    if ('skip' in result) return SKIP;
    answers.push('delegate' in result ? DELEGATE : result.answer);
  }
  return answers;
}

/** Resultado da decisão de um item: o estado novo, ou pulado. */
type Decision = ItemStatus | typeof SKIP;

async function questionsFlow(
  db: DatabaseSync,
  project: Project,
  io: InboxIO,
  item: Item,
): Promise<Decision> {
  const pending = item.pending ?? {};
  const questions = pending.questions ?? [];
  const answers = await askQuestions(io, questions);
  if (answers === SKIP) return SKIP;
  const pairs = questions.map((q, i) => ({ question: q.texto, answer: answers[i] as string }));

  const critical = pending.criticalAssumptions ?? [];
  if (critical.length > 0) {
    for (const assumption of critical) io.write(`  ! suposição crítica: ${assumption}`);
    // Suposição sobre regra crítica é decisão humana (G7): sem "deixar o agente decidir".
    const answer = await chooseAction<Answer>(io, [
      { label: 'Confirmar as suposições', then: async () => CONFIRM_ASSUMPTIONS },
      { label: 'Corrigir com outro texto', then: () => textOrNull(io, 'Correção') },
      { label: SKIP_LABEL, then: async () => SKIP },
    ]);
    if (answer === SKIP) return SKIP;
    pairs.push({ question: assumptionsQuestion(critical), answer });
  }

  let replan = false;
  if (item.pendingKind === 'question_execute') {
    const next = await chooseAction<'go' | 'replan' | typeof SKIP>(io, [
      { label: 'Retomar a execução', then: async () => 'go' },
      { label: 'Replanejar com as respostas', then: async () => 'replan' },
      { label: SKIP_LABEL, then: async () => SKIP },
    ]);
    if (next === SKIP) return SKIP;
    replan = next === 'replan';
  }
  return respond(db, project, item, answerText(pairs), { replan, ...VIA });
}

async function incompleteFlow(db: DatabaseSync, project: Project, io: InboxIO, item: Item): Promise<Decision> {
  io.write(`${INDENT}motivo: ${item.pending?.reason ?? 'plano incompleto'}`);
  return chooseAction<Decision>(io, [
    { label: 'Orientar o plano', then: async () => answerWith(db, project, item, await textOrNull(io, 'Orientação')) },
    cancelAction(db, project, item),
    { label: SKIP_LABEL, then: async () => SKIP },
  ]);
}

/** Resposta gravada com o texto do campo; `null` (vazio ou cancelado) volta ao menu. */
function answerWith(db: DatabaseSync, project: Project, item: Item, text: string | null, replan = false): Decision | null {
  return text ? respond(db, project, item, text, { replan, ...VIA }) : null;
}

/** "Cancelar o item", em vermelho: o botão vermelho basta, sem confirmação. */
function cancelAction(db: DatabaseSync, project: Project, item: Item): Action<Decision> {
  return {
    label: 'Cancelar o item',
    danger: true,
    then: async () => {
      cancel(db, project, item, VIA);
      return 'cancelled';
    },
  };
}

async function criticalFlow(
  db: DatabaseSync,
  home: string,
  project: Project,
  io: InboxIO,
  item: Item,
): Promise<Decision> {
  for (const reason of (item.pending?.reason ?? '').split('; ').filter(Boolean)) io.write(`${INDENT}motivo: ${reason}`);
  const plan = readArtifact<PlanOutput>(home, item.id, 'plano.json');
  if (plan) {
    io.write(`${INDENT}critérios:`);
    for (const c of plan.criterios) io.write(`${INDENT}  ${c.id} (${c.verificacao}) ${c.texto}`);
    io.write(`${INDENT}escopo: ${plan.escopo.join(', ')}`);
    // Inclui as respostas autônomas: aqui o humano revê o que o agente decidiu sozinho.
    if (plan.suposicoes.length > 0) {
      io.write(`${INDENT}suposições:`);
      for (const s of plan.suposicoes) io.write(`${INDENT}  - ${s.texto}${s.regraCritica ? ' (regra crítica)' : ''}`);
    }
  }
  // Item crítico: a aprovação é humana, sem "deixar o agente decidir".
  return chooseAction<Decision>(io, [
    {
      label: 'Aprovar os critérios',
      then: async () => {
        approve(db, project, item, VIA);
        return 'planned';
      },
    },
    { label: 'Ajustar os critérios', then: async () => answerWith(db, project, item, await textOrNull(io, 'Ajuste')) },
    cancelAction(db, project, item),
    { label: SKIP_LABEL, then: async () => SKIP },
  ]);
}

/** A opção que orienta, em cada pendência que pede orientação. */
const GUIDANCE: Partial<Record<PendingKind, string>> = {
  attempts_exhausted: 'Orientar um novo ciclo',
  environment_block: 'Dizer o que mudou no ambiente e retomar',
  integration_conflict: 'Orientar a resolução do conflito',
};

/**
 * Tentativas esgotadas, impedimento de ambiente ou conflito com a integração: orientar,
 * replanejar ou cancelar.
 */
async function exhaustedFlow(db: DatabaseSync, home: string, project: Project, io: InboxIO, item: Item): Promise<Decision> {
  const kind = item.pendingKind as PendingKind;
  const lines =
    kind === 'integration_conflict'
      ? [`arquivos em conflito: ${(item.pending?.files ?? []).join(', ')}`]
      : kind === 'environment_block'
        ? [
            `O executor diz que a verificação não passa por causa do ambiente, não do código:`,
            `${item.pending?.reason ?? ''}`,
            '',
            'Ajuste o ambiente (ex.: o domínio em `rede` no .mabel/config.json) e responda o que mudou.',
          ]
        : humanAttemptsSummary(db, home, item);
  for (const line of lines) io.write(line ? `${INDENT}${line}` : '');
  return chooseAction<Decision>(io, [
    { label: GUIDANCE[kind] as string, then: async () => answerWith(db, project, item, await textOrNull(io, 'Orientação')) },
    { label: 'Replanejar com uma orientação', then: async () => answerWith(db, project, item, await textOrNull(io, 'Orientação'), true) },
    cancelAction(db, project, item),
    { label: SKIP_LABEL, then: async () => SKIP },
  ]);
}

function itemFlow(db: DatabaseSync, home: string, project: Project, io: InboxIO, item: Item): Promise<Decision> {
  switch (item.pendingKind as PendingKind) {
    case 'question_plan':
    case 'question_execute':
      return questionsFlow(db, project, io, item);
    case 'plan_incomplete':
      return incompleteFlow(db, project, io, item);
    case 'critical_approval':
      return criticalFlow(db, home, project, io, item);
    case 'attempts_exhausted':
    case 'environment_block':
    case 'integration_conflict':
      return exhaustedFlow(db, home, project, io, item);
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export interface InboxOptions {
  /** Só estas pendências (escolher uma decide só ela); o padrão é todas. */
  items?: Item[];
  /**
   * Cabeçalho de cada pendência ("1 de 2" na tela cheia); sem ele, a linha do item. Na tela
   * cheia também não sai o título do começo nem o resumo do fim, que ela mostra à parte.
   */
  onItem?: (item: Item, index: number, total: number) => void;
  /** Cada decisão gravada, para o resumo da tela cheia. */
  onDecision?: (item: Item, decision: string) => void;
}

/** O que foi decidido na pendência, para o resumo. */
export function decisionLabel(status: ItemStatus): string {
  switch (status) {
    case 'planning':
      return 'volta ao planejamento';
    case 'planned':
      return 'critérios aprovados';
    case 'executing':
      return 'volta à execução';
    case 'cancelled':
      return 'cancelado';
    default:
      return status;
  }
}

/** Descrição da pendência: "perguntas do planejamento", "aprovação de item crítico"… */
export const pendingLabel = (item: Item) => KIND_LABELS[item.pendingKind as PendingKind];

/**
 * Percorre os itens em `needs_human`, um por vez. Cada item vira uma decisão só, gravada
 * ao final do item; ctrl+c descarta o item em andamento e mantém os já gravados.
 */
export async function runInbox(db: DatabaseSync, home: string, project: Project, io: InboxIO, options: InboxOptions = {}): Promise<InboxResult> {
  const items = options.items ?? pendingItems(db, project.id);
  const result: InboxResult = { answered: 0, skipped: 0, interrupted: false };
  const conflict = options.items ? [] : baseConflictLines(db, project);
  for (const line of conflict) io.write(line);
  if (items.length === 0) {
    if (conflict.length === 0) io.write('Nada aguardando você.');
    return result;
  }
  if (!options.onItem) io.write(style.bold(`${plural(items.length, 'item aguardando', 'itens aguardando')} você`));
  for (const [index, item] of items.entries()) {
    if (options.onItem) options.onItem(item, index, items.length);
    else {
      io.write('');
      io.write(`${style.bold(`#${item.number} ${item.title}`)}${style.dim(` · ${KIND_LABELS[item.pendingKind as PendingKind]}`)}`);
    }
    let decision: Decision;
    try {
      decision = await itemFlow(db, home, project, io, item);
    } catch (error) {
      if (!(error instanceof Interrupted)) throw error;
      io.write('');
      io.write(style.dim(`interrompido: #${item.number} não foi gravado`));
      result.interrupted = true;
      break;
    }
    if (decision === SKIP) {
      result.skipped++;
      options.onDecision?.(item, 'pulado');
      if (!options.onItem) io.write(style.dim(`  #${item.number} pulado; continua aguardando você`));
    } else {
      result.answered++;
      options.onDecision?.(item, decisionLabel(decision));
      if (!options.onItem) io.write(`  ✓ #${item.number} → ${decision}`);
    }
  }
  if (options.onItem) return result;
  const skipped = result.skipped > 0 ? ` · ${plural(result.skipped, 'pulado', 'pulados')}` : '';
  io.write('');
  io.write(`Respostas registradas em ${plural(result.answered, 'item', 'itens')}${skipped}.`);
  return result;
}

const PENDING_VALUES: Record<PendingKind, string> = {
  question_plan: 'perguntas_planejamento',
  question_execute: 'perguntas_execucao',
  plan_incomplete: 'plano_incompleto',
  critical_approval: 'aprovacao_critica',
  attempts_exhausted: 'tentativas_esgotadas',
  environment_block: 'impedimento_ambiente',
  integration_conflict: 'conflito_integracao',
};

/**
 * O que o humano pode fazer em cada pendência, como na inbox do terminal. `decidir` é o
 * `responder` com a resposta que devolve a pergunta ao agente (`DELEGATE`).
 */
const PENDING_OPTIONS: Record<PendingKind, string[]> = {
  question_plan: ['responder', 'decidir', 'cancelar'],
  question_execute: ['responder', 'decidir', 'replanejar', 'cancelar'],
  plan_incomplete: ['responder', 'cancelar'],
  critical_approval: ['aprovar', 'responder', 'cancelar'],
  attempts_exhausted: ['responder', 'replanejar', 'cancelar'],
  environment_block: ['responder', 'replanejar', 'cancelar'],
  integration_conflict: ['responder', 'replanejar', 'cancelar'],
};

/** O `base_conflict` no `--json`: o que conflitou, os arquivos e o comando; `null` sem conflito. */
function baseConflictJson(db: DatabaseSync, project: Project): Record<string, unknown> | null {
  const conflict = queueConflict(db, project);
  if (!conflict) return null;
  return {
    pendencia: 'conflito_base',
    origem: conflict.source,
    unidade: conflict.unit,
    arquivos: conflict.files,
    comando: conflictCommand(project, conflict),
  };
}

/** `mabel decidir --json`: as pendências do projeto, com as perguntas e as opções de cada uma. */
export function inboxJson(db: DatabaseSync, project: Project): Record<string, unknown> {
  return {
    projeto: { id: project.id, nome: project.name, raiz: project.root },
    resposta_decidir: DELEGATE,
    conflito_base: baseConflictJson(db, project),
    pendencias: pendingItems(db, project.id).map((item) => {
      const kind = item.pendingKind as PendingKind;
      const pending = item.pending ?? {};
      // Pendências antigas guardavam as perguntas como texto.
      const questions = (pending.questions ?? []).map((q: Question | string) =>
        typeof q === 'string' ? { texto: q, sugestao: '', regra_critica: false } : { texto: q.texto, sugestao: q.sugestao ?? '', regra_critica: q.regraCritica ?? false },
      );
      return {
        item: item.number,
        titulo: item.title,
        tipo: kind === 'critical_approval' ? 'aprovar' : 'responder',
        pendencia: PENDING_VALUES[kind],
        motivo: pending.reason ?? item.statusReason,
        perguntas: questions,
        suposicoes_criticas: pending.criticalAssumptions ?? [],
        arquivos: pending.files ?? [],
        opcoes: PENDING_OPTIONS[kind],
      };
    }),
  };
}

export async function inboxCommand(args: string[]): Promise<number> {
  let json: boolean;
  try {
    json = parseArgs({ args, options: inboxOptions }).values.json ?? false;
  } catch (error) {
    return fail('argumento_invalido', (error as Error).message, inboxUsage);
  }
  const home = dataDir();
  const db = openDb(home);
  try {
    const project = resolveProject(db);
    if (json) {
      writeJson(inboxJson(db, project));
      return 0;
    }
    if (!interactive()) {
      const items = pendingItems(db, project.id);
      const conflict = baseConflictLines(db, project);
      if (conflict.length > 0) process.stdout.write(`${conflict.join('\n')}\n\n`);
      else if (items.length === 0) process.stdout.write('Nada aguardando você.\n');
      for (const item of items) process.stdout.write(`${renderItemDetail(db, home, item).join('\n')}\n\n`);
      return 0;
    }
  } catch (error) {
    if (error instanceof ProjectError) return fail(error.code, error.message);
    throw error;
  } finally {
    db.close();
  }
  // No terminal, a mesma tela cheia de "Decidir as pendências" da tela inicial.
  const { decideFlow, loadHomeContext, standalone } = await import('./home.ts');
  return standalone(() => decideFlow(loadHomeContext()));
}
