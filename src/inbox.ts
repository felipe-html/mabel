import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Interrupted, ask, interactive } from './ask.ts';
import { dataDir, openDb } from './db.ts';
import { type DecisionOptions, approve, cancel, respond } from './decisions.ts';
import { renderItemDetail } from './decide.ts';
import { fail } from './errors.ts';
import { type Item, type ItemStatus, type Pending, type PendingKind, listItems } from './items.ts';
import { writeJson } from './json.ts';
import { humanAttemptsSummary } from './pipeline.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import { run } from './run.ts';
import type { PlanOutput, Question } from './schemas/stages.ts';
import { readArtifact } from './stages.ts';
import { style } from './style.ts';
import { type OptionSpecs, jsonOption } from './options.ts';

export const inboxUsage = 'mabel inbox [--json]';

export const inboxOptions = { json: jsonOption } satisfies OptionSpecs;

/** Resposta gravada quando o humano devolve a pergunta ao agente. */
export const DELEGATE = 'decida e registre como suposição.';

/** Entrada e saída da inbox; os testes trocam o terminal por respostas roteirizadas. */
export interface InboxIO {
  /** Lê uma linha; ctrl+c lança `Interrupted`. */
  ask: (prompt: string) => Promise<string>;
  write: (line: string) => void;
}

export const terminalIO: InboxIO = {
  ask,
  write: (line) => process.stdout.write(`${line}\n`),
};

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

/** Mostra as opções e lê até `parse` aceitar a entrada; `{ retry }` repete com um aviso. */
async function choose<T>(io: InboxIO, hint: string, parse: (input: string) => T | { retry: string }): Promise<T> {
  io.write(`${INDENT}${style.dim(`[${hint}]`)}`);
  for (;;) {
    const result = parse(await io.ask(`${INDENT}› `));
    if (typeof result === 'object' && result !== null && 'retry' in result) {
      io.write(`${INDENT}${result.retry}`);
      continue;
    }
    return result as T;
  }
}

async function confirmCancel(io: InboxIO, item: Item): Promise<boolean> {
  const answer = (await io.ask(`${INDENT}Cancelar o item #${item.number}? [s/N] `)).toLowerCase();
  return answer.startsWith('s') || answer.startsWith('y');
}

async function askQuestions(io: InboxIO, questions: Question[]): Promise<Answer[] | typeof SKIP> {
  const answers: Answer[] = [];
  for (const [i, question] of questions.entries()) {
    io.write(`  ${i + 1}/${questions.length} ${question.texto}${question.regraCritica ? style.dim(' (regra crítica)') : ''}`);
    if (question.sugestao) io.write(`${INDENT}sugestão: ${question.sugestao}`);
    // Regra crítica é decisão humana (G7): sem "decide você".
    const delegate = !question.regraCritica;
    const hint = [question.sugestao ? 'enter aceita' : '', 'texto responde', delegate ? 'd decide você' : '', 'p pula o item'].filter(Boolean).join(' · ');
    const answer = await choose<Answer>(io, hint, (input) => {
      if (input === 'p') return SKIP;
      if (input === 'd') return delegate ? DELEGATE : { retry: 'Regra crítica: a resposta é sua.' };
      if (input) return input;
      return question.sugestao || { retry: `Sem sugestão: digite a resposta${delegate ? ', d' : ''} ou p.` };
    });
    if (answer === SKIP) return SKIP;
    answers.push(answer);
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
    // Suposição sobre regra crítica é decisão humana (G7): sem "decide você".
    const answer = await choose<Answer>(io, 'enter confirma · texto corrige · p pula o item', (input) =>
      input === 'p' ? SKIP : input || CONFIRM_ASSUMPTIONS,
    );
    if (answer === SKIP) return SKIP;
    pairs.push({ question: assumptionsQuestion(critical), answer });
  }

  let replan = false;
  if (item.pendingKind === 'question_execute') {
    const next = await choose<'go' | 'replan' | typeof SKIP>(
      io,
      'enter retoma a execução · r replaneja com as respostas · p pula o item',
      (input) => (input === '' ? 'go' : input === 'r' ? 'replan' : input === 'p' ? SKIP : { retry: 'Use enter, r ou p.' }),
    );
    if (next === SKIP) return SKIP;
    replan = next === 'replan';
  }
  return respond(db, project, item, answerText(pairs), { replan, ...VIA });
}

async function incompleteFlow(db: DatabaseSync, project: Project, io: InboxIO, item: Item): Promise<Decision> {
  io.write(`${INDENT}motivo: ${item.pending?.reason ?? 'plano incompleto'}`);
  for (;;) {
    const input = await choose<string>(io, 'texto orienta o plano · c cancela · p pula', (text) =>
      text || { retry: 'Digite a orientação, c ou p.' },
    );
    if (input === 'p') return SKIP;
    if (input === 'c') {
      if (!(await confirmCancel(io, item))) continue;
      cancel(db, project, item, VIA);
      return 'cancelled';
    }
    return respond(db, project, item, input, VIA);
  }
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
  for (;;) {
    const input = await choose<string>(io, 'a aprova · texto ajusta os critérios · c cancela · p pula', (text) => {
      if (text === 'd') return { retry: 'Item crítico: a aprovação é sua. Use a, texto, c ou p.' };
      return text || { retry: 'Digite a, o ajuste, c ou p.' };
    });
    if (input === 'p') return SKIP;
    if (input === 'a') {
      approve(db, project, item, VIA);
      return 'planned';
    }
    if (input === 'c') {
      if (!(await confirmCancel(io, item))) continue;
      cancel(db, project, item, VIA);
      return 'cancelled';
    }
    return respond(db, project, item, input, VIA);
  }
}

/** O que o texto livre faz em cada pendência que pede orientação. */
const GUIDANCE: Partial<Record<PendingKind, string>> = {
  attempts_exhausted: 'texto orienta um novo ciclo',
  environment_block: 'texto diz o que mudou no ambiente e retoma',
  integration_conflict: 'texto orienta a resolução do conflito',
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
  for (;;) {
    const input = await choose<string>(
      io,
      `${GUIDANCE[kind]} · r <texto> replaneja · c cancela · p pula`,
      (text) => text || { retry: 'Digite a orientação, r <texto>, c ou p.' },
    );
    if (input === 'p') return SKIP;
    if (input === 'c') {
      if (!(await confirmCancel(io, item))) continue;
      cancel(db, project, item, VIA);
      return 'cancelled';
    }
    if (input === 'r' || input.startsWith('r ')) {
      const guidance = input.slice(1).trim() || (await io.ask(`${INDENT}Orientação para o replanejamento: `)).trim();
      if (!guidance) continue;
      return respond(db, project, item, guidance, { replan: true, ...VIA });
    }
    return respond(db, project, item, input, VIA);
  }
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

/**
 * Percorre os itens em `needs_human`, um por vez. Cada item vira uma decisão só, gravada
 * ao final do item; ctrl+c descarta o item em andamento e mantém os já gravados.
 */
export async function runInbox(db: DatabaseSync, home: string, project: Project, io: InboxIO): Promise<InboxResult> {
  const items = pendingItems(db, project.id);
  const result: InboxResult = { answered: 0, skipped: 0, interrupted: false };
  if (items.length === 0) {
    io.write('Nada aguardando você.');
    return result;
  }
  io.write(style.bold(`${plural(items.length, 'item aguardando', 'itens aguardando')} você`));
  for (const item of items) {
    io.write('');
    io.write(`${style.bold(`#${item.number} ${item.title}`)}${style.dim(` · ${KIND_LABELS[item.pendingKind as PendingKind]}`)}`);
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
      io.write(style.dim(`  #${item.number} pulado; continua aguardando você`));
    } else {
      result.answered++;
      io.write(`  ✓ #${item.number} → ${decision}`);
    }
  }
  const skipped = result.skipped > 0 ? ` · ${plural(result.skipped, 'pulado', 'pulados')}` : '';
  io.write('');
  io.write(`Respostas registradas em ${plural(result.answered, 'item', 'itens')}${skipped}.`);
  return result;
}

/**
 * Inbox seguida da pergunta de retomada. Devolve `true` quando a fila deve seguir.
 * `waiting` é avisado antes da pergunta de retomada (aviso do sistema no `run`).
 */
export async function inboxSession(
  db: DatabaseSync,
  home: string,
  project: Project,
  io: InboxIO,
  waiting?: (question: string) => void,
): Promise<boolean> {
  const result = await runInbox(db, home, project, io);
  if (result.interrupted || result.answered === 0) return false;
  try {
    waiting?.('Retomar a esteira agora?');
    const answer = (await io.ask('Retomar a esteira agora? [S/n] ')).toLowerCase();
    return !answer || answer.startsWith('s') || answer.startsWith('y');
  } catch (error) {
    if (error instanceof Interrupted) return false;
    throw error;
  }
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

/** `mabel inbox --json`: as pendências do projeto, com as perguntas e as opções de cada uma. */
export function inboxJson(db: DatabaseSync, project: Project): Record<string, unknown> {
  return {
    projeto: { id: project.id, nome: project.name, raiz: project.root },
    resposta_decidir: DELEGATE,
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
  let resume = false;
  try {
    const project = resolveProject(db);
    if (json) {
      writeJson(inboxJson(db, project));
      return 0;
    }
    if (!interactive()) {
      const items = pendingItems(db, project.id);
      if (items.length === 0) process.stdout.write('Nada aguardando você.\n');
      for (const item of items) process.stdout.write(`${renderItemDetail(db, home, item).join('\n')}\n\n`);
      return 0;
    }
    resume = await inboxSession(db, home, project, terminalIO);
  } catch (error) {
    if (error instanceof ProjectError) return fail(error.code, error.message);
    throw error;
  } finally {
    db.close();
  }
  return resume ? run([]) : 0;
}
