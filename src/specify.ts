import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Interrupted, interactive } from './ask.ts';
import { appendBlocks, parseBacklog, renderItemBlock } from './backlog.ts';
import { dataDir, openDb } from './db.ts';
import {
  type Answerer,
  type Answers,
  type Conversation,
  type ReviewIO,
  type Target,
  allDecisions,
  converse,
  engineLog,
  metricsLine,
  metricsOf,
  noAnswers,
  outputLines,
  reviewOutput,
  specFromOutput,
  suggestionAnswerer,
  terminalAnswerer,
  terminalReviewIO,
} from './engine.ts';
import { formatWhen } from './format.ts';
import { backlogPath, listItems, nextNumber, syncBacklog } from './items.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import { ensureRefineBalance, lowBalancePrompt } from './refine.ts';
import type { SpecifyOutput } from './schemas/stages.ts';
import {
  SLUG,
  getSpecMetrics,
  getSpecRecord,
  listSpecFiles,
  parseSpec,
  readSpec,
  renderSpec,
  setSpecMetrics,
  setSpecStatus,
  specPath,
  validateSpec,
} from './specs.ts';
import { style } from './style.ts';

// `mabel especificar`: o motor de especificação (Example Mapping) sobre uma spec, e o aceite
// da spec escrita à mão (`--aceitar`, sem proposta pendente).

export const specifyUsage = 'mabel especificar [<slug>] [--refazer] [--aceitar | --descartar]';

export const specifyOptions = {
  refazer: { type: 'boolean', description: 'Descarta a proposta pendente e pede outra ao agente' },
  aceitar: {
    type: 'boolean',
    description: 'Com proposta pendente: responde com as sugestões e grava sem revisão. Sem ela: aceita a spec do arquivo, se válida',
  },
  descartar: { type: 'boolean', description: 'Descarta a proposta pendente sem gravar nada' },
} satisfies OptionSpecs;

export const specifyArgs: ArgSpec[] = [
  { name: '<slug>', description: 'Nome da spec em .mabel/specs/<slug>.md; sem ele, a lista das specs', values: 'spec' },
];

// Propostas no banco ---------------------------------------------------------------------

export type ProposalStatus = 'proposed' | 'accepted' | 'discarded';

export interface SpecProposal {
  id: number;
  slug: string;
  /** Hash do arquivo da spec quando a conversa começou: se ele mudar, a proposta fica desatualizada. */
  contentHash: string;
  conversation: Conversation;
  status: ProposalStatus;
  createdAt: string;
}

interface ProposalRow {
  id: number;
  slug: string;
  session_id: string | null;
  rounds: number;
  questions: number;
  content_hash: string;
  output: string;
  answers: string | null;
  status: ProposalStatus;
  created_at: string;
}

function fromRow(row: ProposalRow): SpecProposal {
  return {
    id: row.id,
    slug: row.slug,
    contentHash: row.content_hash,
    conversation: {
      sessionId: row.session_id,
      rounds: row.rounds,
      questions: row.questions,
      output: JSON.parse(row.output) as SpecifyOutput,
      answers: row.answers ? (JSON.parse(row.answers) as Answers) : noAnswers(),
      runId: null,
    },
    status: row.status,
    createdAt: row.created_at,
  };
}

export function latestSpecProposal(db: DatabaseSync, projectId: string, slug: string): SpecProposal | undefined {
  const row = db.prepare('SELECT * FROM spec_proposals WHERE project_id = ? AND slug = ? ORDER BY id DESC LIMIT 1').get(projectId, slug) as
    | ProposalRow
    | undefined;
  return row ? fromRow(row) : undefined;
}

function saveProposal(db: DatabaseSync, projectId: string, slug: string, contentHash: string, id: number | undefined, conversation: Conversation): number {
  const now = new Date().toISOString();
  const values = [conversation.sessionId, conversation.rounds, conversation.questions, JSON.stringify(conversation.output), JSON.stringify(conversation.answers)];
  if (id !== undefined) {
    db.prepare('UPDATE spec_proposals SET session_id = ?, rounds = ?, questions = ?, output = ?, answers = ?, updated_at = ? WHERE id = ?').run(
      ...values,
      now,
      id,
    );
    return id;
  }
  const result = db
    .prepare(
      `INSERT INTO spec_proposals (project_id, slug, session_id, rounds, questions, output, answers, content_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(projectId, slug, ...values, contentHash, now, now);
  return Number(result.lastInsertRowid);
}

function decideSpecProposal(db: DatabaseSync, id: number, status: Exclude<ProposalStatus, 'proposed'>, decision: unknown): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE spec_proposals SET status = ?, decision = ?, decided_at = ?, updated_at = ? WHERE id = ?').run(
    status,
    JSON.stringify(decision),
    now,
    now,
    id,
  );
}

export const draftHash = (text: string) => createHash('sha256').update(text).digest('hex');

// Gravação -------------------------------------------------------------------------------

export class SpecifyError extends Error {}

export interface SpecSaved {
  /** Números das tarefas acrescentadas ao backlog; vazio quando a spec já tinha tarefas. */
  tasks: number[];
  /** Tarefas que já citavam a spec (reespecificação): o Mabel não as duplica. */
  existing: number[];
}

/** Blocos das tarefas propostas, numeradas a partir de `first`; `dependeDe` vira número. */
export function taskBlocks(slug: string, output: SpecifyOutput, first: number): string[] {
  return output.tarefas.map((task, i) =>
    renderItemBlock({
      number: first + i,
      title: task.titulo.trim(),
      intent: task.intencao.trim(),
      criteria: [],
      dependsOn: task.dependeDe.map((dep) => first + dep - 1),
      restrictions: null,
      outOfScope: [],
      decisions: [],
      criticalConcepts: [],
      spec: slug,
      rules: task.regras,
    }),
  );
}

/**
 * Grava a spec aceita: `.mabel/specs/<slug>.md`, as tarefas no fim do `backlog.md` (com
 * `Spec:` e `Regras:`) e o estado `aceita`, com as métricas de tamanho.
 */
export function saveSpecification(
  db: DatabaseSync,
  project: Project,
  slug: string,
  title: string,
  output: SpecifyOutput,
  conversation: Pick<Conversation, 'rounds' | 'questions'>,
  answers: Answers = noAnswers(),
): SpecSaved {
  const spec = specFromOutput(title, output, answers);
  const errors = validateSpec(spec);
  if (errors.length > 0) throw new SpecifyError(`A spec ${slug} não passa na validação:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  const file = specPath(project.root, slug);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderSpec(spec));

  syncBacklog(db, project);
  const existing = listItems(db, project.id)
    .filter((item) => item.spec === slug && item.status !== 'cancelled')
    .map((item) => item.number);
  const tasks: number[] = [];
  if (existing.length === 0 && output.tarefas.length > 0) {
    const path = backlogPath(project);
    const text = readFileSync(path, 'utf8');
    const first = nextNumber(db, project.id, parseBacklog(text).flatMap((item) => (item.number === undefined ? [] : [item.number])));
    writeFileSync(path, appendBlocks(text, taskBlocks(slug, output, first)));
    tasks.push(...output.tarefas.map((_, i) => first + i));
  }
  setSpecStatus(db, project.id, slug, 'aceita');
  setSpecMetrics(db, project.id, slug, metricsOf({ ...conversation, output }));
  syncBacklog(db, project);
  return { tasks, existing };
}

// Comando --------------------------------------------------------------------------------

export interface SpecifyFlags {
  redo?: boolean;
  accept?: boolean;
  discard?: boolean;
}

class StopAsking extends Error {}

function savedLines(slug: string, saved: SpecSaved, metrics: string): string[] {
  const lines = [`✓ Spec ${slug} aceita · ${metrics}`];
  if (saved.tasks.length > 0) lines.push(`  tarefas no backlog: ${saved.tasks.map((n) => `#${n}`).join(', ')} (vão a ready no próximo mabel run)`);
  if (saved.existing.length > 0) {
    lines.push(style.dim(`  a spec já tinha as tarefas ${saved.existing.map((n) => `#${n}`).join(', ')}: nenhuma acrescentada; ajuste o backlog à mão se preciso`));
  }
  return lines;
}

/** Especifica uma spec: continua a proposta pendente ou roda o agente, e então revisa, aceita ou descarta. */
export async function specifySpec(
  db: DatabaseSync,
  home: string,
  project: Project,
  slug: string,
  flags: SpecifyFlags,
  io: ReviewIO | undefined,
): Promise<number> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const file = specPath(project.root, slug);
  let draft: string;
  try {
    draft = readFileSync(file, 'utf8');
  } catch {
    process.stderr.write(`${file} não existe. Escreva a spec (pode ser só a história) e rode de novo.\n`);
    return 1;
  }
  const status = getSpecRecord(db, project.id, slug)?.status ?? 'rascunho';
  if (status === 'entregue') {
    out(`A spec ${slug} já foi entregue.`);
    return 0;
  }
  const latest = latestSpecProposal(db, project.id, slug);
  const pending = latest?.status === 'proposed' ? latest : undefined;
  if (flags.discard) {
    if (!pending) {
      process.stderr.write(`A spec ${slug} não tem proposta pendente.\n`);
      return 1;
    }
    decideSpecProposal(db, pending.id, 'discarded', { motivo: 'descartada' });
    out(`Proposta da spec ${slug} descartada.`);
    return 0;
  }
  const hash = draftHash(draft);
  let proposal = pending && pending.contentHash === hash && !flags.redo ? pending : undefined;
  if (pending && !proposal) decideSpecProposal(db, pending.id, 'discarded', { motivo: flags.redo ? 'refeita' : 'spec mudou depois da proposta' });

  // Sem proposta, `--aceitar` aceita a spec escrita à mão, como está no arquivo.
  if (flags.accept && !proposal) {
    const errors = validateSpec(parseSpec(draft));
    if (errors.length > 0) {
      process.stderr.write(`A spec ${slug} não passa na validação:\n${errors.map((e) => `- ${e}`).join('\n')}\n`);
      process.stderr.write(`Rode \`mabel especificar ${slug}\` para o agente propor o que falta.\n`);
      return 1;
    }
    setSpecStatus(db, project.id, slug, 'aceita');
    out(`Spec ${slug} aceita. As tarefas com "Spec: ${slug}" podem ir a ready no próximo mabel run.`);
    return 0;
  }
  if (!proposal && !flags.redo && io && status === 'aceita') {
    try {
      const answer = (await io.ask(`A spec ${slug} já foi aceita. Pedir outra proposta ao agente? [s/N] `)).trim().toLowerCase();
      if (!answer.startsWith('s') && !answer.startsWith('y')) return 0;
    } catch (error) {
      if (error instanceof Interrupted) return 130;
      throw error;
    }
  }

  const title = parseSpec(draft).titulo || slug;
  const target: Target = { kind: 'spec', slug, title, draft };
  out(style.bold(`${title}`) + style.dim(` · especificar ${slug}`));
  let conversation = proposal?.conversation;
  if (conversation && conversation.output.perguntas.length === 0) {
    out(style.dim(`  proposta de ${formatWhen((proposal as SpecProposal).createdAt)} (use --refazer para pedir outra)`));
  } else if (conversation && !flags.accept && !io) {
    out('');
    out(outputLines(conversation.output, conversation.answers).join('\n'));
    out('');
    out(`Responda as perguntas no terminal com \`mabel especificar ${slug}\`, aceite as sugestões com \`mabel especificar ${slug} --aceitar\``);
    out(`ou descarte com \`mabel especificar ${slug} --descartar\`.`);
    return 0;
  } else {
    const blocked = await ensureRefineBalance(db, home, 'specify', lowBalancePrompt(io, 'Especificar'));
    if (blocked) {
      process.stderr.write(`Especificação não iniciada: ${blocked}.\n`);
      return blocked === 'interrompido' ? 130 : 1;
    }
    let id = proposal?.id;
    const save = (next: Conversation) => {
      id = saveProposal(db, project.id, slug, hash, id, next);
    };
    const answerer: Answerer = flags.accept
      ? suggestionAnswerer
      : io
        ? terminalAnswerer(io)
        : async () => {
            throw new StopAsking();
          };
    let result;
    try {
      result = await converse({ db, home, project, log: engineLog(project.root) }, target, conversation, answerer, save, (line) =>
        out(style.dim(`  ${line}`)),
      );
    } catch (error) {
      if (error instanceof StopAsking) return specifySpec(db, home, project, slug, {}, undefined);
      if (error instanceof Interrupted) {
        out('');
        out(style.dim(`interrompido: a proposta da spec ${slug} continua pendente`));
        return 130;
      }
      throw error;
    }
    if ('error' in result) {
      process.stderr.write(`${result.error}\n`);
      return result.interrupted ? 130 : 1;
    }
    conversation = result.conversation;
    proposal = latestSpecProposal(db, project.id, slug) as SpecProposal;
  }
  out('');
  const metrics = metricsOf(conversation);

  if (flags.accept) {
    out(outputLines(conversation.output, conversation.answers).join('\n'));
    out('');
    try {
      const saved = saveSpecification(db, project, slug, title, conversation.output, conversation, conversation.answers);
      decideSpecProposal(db, (proposal as SpecProposal).id, 'accepted', saved);
      for (const line of savedLines(slug, saved, metricsLine(metrics))) out(line);
      for (const question of conversation.answers.adiadas) out(style.dim(`  pergunta sem sugestão, deixada para o planejamento: ${question}`));
      return 0;
    } catch (error) {
      if (!(error instanceof SpecifyError)) throw error;
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
  }
  if (!io) {
    out(outputLines(conversation.output, conversation.answers).join('\n'));
    out('');
    out(style.dim(`Tamanho: ${metricsLine(metrics)}`));
    out(`Revise no terminal com \`mabel especificar ${slug}\`, grave como está com \`mabel especificar ${slug} --aceitar\``);
    out(`ou descarte com \`mabel especificar ${slug} --descartar\`.`);
    return 0;
  }

  const items = listItems(db, project.id);
  const existing = items.filter((item) => item.spec === slug && item.status !== 'cancelled');
  const first = nextNumber(db, project.id, []);
  let review;
  try {
    review = await reviewOutput(io, { ...conversation.output, decisoes: allDecisions(conversation.output, conversation.answers) }, {
      target,
      answers: noAnswers(),
      metrics,
      firstNumber: first,
      preview: (output) => [
        ...renderSpec(specFromOutput(title, output)).trimEnd().split('\n'),
        '',
        ...(existing.length > 0
          ? [`(a spec já tem as tarefas ${existing.map((item) => `#${item.number}`).join(', ')}: nenhuma será acrescentada)`]
          : taskBlocks(slug, output, first).flatMap((block) => ['', ...block.trimEnd().split('\n')])),
      ],
    });
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    io.write('');
    io.write(style.dim(`interrompido: a proposta da spec ${slug} continua pendente`));
    return 130;
  }
  if (review.kind === 'keep') {
    io.write(style.dim(`Proposta da spec ${slug} mantida pendente; nada gravado.`));
    return 0;
  }
  if (review.kind === 'discard') {
    decideSpecProposal(db, (proposal as SpecProposal).id, 'discarded', { motivo: 'descartada na revisão' });
    io.write(`Proposta da spec ${slug} descartada.`);
    return 0;
  }
  try {
    const saved = saveSpecification(db, project, slug, title, review.output, conversation);
    decideSpecProposal(db, (proposal as SpecProposal).id, 'accepted', saved);
    for (const line of savedLines(slug, saved, metricsLine(metricsOf({ ...conversation, output: review.output })))) io.write(line);
    return 0;
  } catch (error) {
    if (!(error instanceof SpecifyError)) throw error;
    io.write(error.message);
    io.write(style.dim(`A proposta continua pendente: rode \`mabel especificar ${slug}\` de novo para revisar.`));
    return 1;
  }
}

function listSpecs(db: DatabaseSync, project: Project): number {
  const slugs = listSpecFiles(project.root);
  if (slugs.length === 0) {
    process.stdout.write('Nenhuma spec em .mabel/specs/. Escreva uma (pode ser só a história) e rode mabel especificar <slug>.\n');
    return 0;
  }
  const items = listItems(db, project.id);
  for (const name of slugs) {
    const status = getSpecRecord(db, project.id, name)?.status ?? 'rascunho';
    const found = readSpec(project.root, name);
    const errors = found ? validateSpec(found) : ['arquivo não encontrado'];
    const tasks = items.filter((item) => item.spec === name && item.status !== 'cancelled');
    const done = tasks.filter((item) => item.status === 'awaiting_merge' || item.status === 'done').length;
    const pending = latestSpecProposal(db, project.id, name);
    const proposal =
      pending?.status === 'proposed' ? (pending.conversation.output.perguntas.length > 0 ? ' · perguntas pendentes' : ' · proposta pendente') : '';
    const metrics = getSpecMetrics(db, project.id, name);
    process.stdout.write(
      `${name} · ${status} · ${tasks.length > 0 ? `${done}/${tasks.length} tarefas` : 'sem tarefas'}${errors.length > 0 ? ' · inválida' : ''}${proposal}${metrics ? style.dim(` · ${metricsLine(metrics)}`) : ''}\n`,
    );
  }
  return 0;
}

export async function specifyCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: specifyOptions, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${specifyUsage}\n`);
    return 1;
  }
  const { values } = parsed;
  const [slug] = parsed.positionals;
  if (values.aceitar && values.descartar) {
    process.stderr.write(`Use --aceitar ou --descartar, não os dois.\nUso: ${specifyUsage}\n`);
    return 1;
  }
  const home = dataDir();
  const db = openDb(home);
  try {
    const project = resolveProject(db);
    if (!slug) {
      if (values.aceitar || values.descartar || values.refazer) {
        process.stderr.write(`Informe a spec.\nUso: ${specifyUsage}\n`);
        return 1;
      }
      return listSpecs(db, project);
    }
    if (!SLUG.test(slug)) {
      process.stderr.write(`"${slug}" não é um nome de spec: use letras minúsculas, dígitos e -.\n`);
      return 1;
    }
    syncBacklog(db, project);
    const flags = { redo: values.refazer, accept: values.aceitar, discard: values.descartar };
    return await specifySpec(db, home, project, slug, flags, interactive() ? terminalReviewIO : undefined);
  } catch (error) {
    if (error instanceof ProjectError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}
