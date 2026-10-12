import type { DatabaseSync } from 'node:sqlite';
import { Interrupted, ask, interactive } from './ask.ts';
import { dataDir, openDb } from './db.ts';
import { type DecisionOptions, approve, cancel, respond } from './decisions.ts';
import { renderItemDetail } from './decide.ts';
import { type Item, type ItemStatus, type PendingKind, listItems } from './items.ts';
import { attemptsSummary } from './pipeline.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import { run } from './run.ts';
import type { PlanOutput, Question } from './schemas/stages.ts';
import { readArtifact } from './stages.ts';
import { style } from './style.ts';

export const inboxUsage = 'mabel inbox';

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
    io.write(`  ${i + 1}/${questions.length} ${question.texto}`);
    if (question.sugestao) io.write(`${INDENT}sugestão: ${question.sugestao}`);
    const hint = `${question.sugestao ? 'enter aceita · ' : ''}texto responde · d decide você · p pula o item`;
    const answer = await choose<Answer>(io, hint, (input) => {
      if (input === 'p') return SKIP;
      if (input === 'd') return DELEGATE;
      if (input) return input;
      return question.sugestao || { retry: 'Sem sugestão: digite a resposta, d ou p.' };
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
      input === 'p' ? SKIP : input || 'Confirmo as suposições.',
    );
    if (answer === SKIP) return SKIP;
    pairs.push({ question: `Suposições críticas: ${critical.join('; ')}`, answer });
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
      return 'executing';
    }
    if (input === 'c') {
      if (!(await confirmCancel(io, item))) continue;
      cancel(db, project, item, VIA);
      return 'cancelled';
    }
    return respond(db, project, item, input, VIA);
  }
}

async function exhaustedFlow(db: DatabaseSync, project: Project, io: InboxIO, item: Item): Promise<Decision> {
  const summary = item.pending?.summary || attemptsSummary(db, item.id);
  for (const line of summary.split('\n')) io.write(`${INDENT}${line}`);
  for (;;) {
    const input = await choose<string>(
      io,
      'texto orienta um novo ciclo · r <texto> replaneja · c cancela · p pula',
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
      return exhaustedFlow(db, project, io, item);
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

/** Inbox seguida da pergunta de retomada. Devolve `true` quando a fila deve seguir. */
export async function inboxSession(db: DatabaseSync, home: string, project: Project, io: InboxIO): Promise<boolean> {
  const result = await runInbox(db, home, project, io);
  if (result.interrupted || result.answered === 0) return false;
  try {
    const answer = (await io.ask('Retomar a esteira agora? [S/n] ')).toLowerCase();
    return !answer || answer.startsWith('s') || answer.startsWith('y');
  } catch (error) {
    if (error instanceof Interrupted) return false;
    throw error;
  }
}

export async function inboxCommand(_args: string[]): Promise<number> {
  const home = dataDir();
  const db = openDb(home);
  let resume = false;
  try {
    const project = resolveProject(db);
    if (!interactive()) {
      const items = pendingItems(db, project.id);
      if (items.length === 0) process.stdout.write('Nada aguardando você.\n');
      for (const item of items) process.stdout.write(`${renderItemDetail(db, home, item).join('\n')}\n\n`);
      return 0;
    }
    resume = await inboxSession(db, home, project, terminalIO);
  } catch (error) {
    if (error instanceof ProjectError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
  return resume ? run([]) : 0;
}
