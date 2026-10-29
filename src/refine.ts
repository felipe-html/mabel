import { readFileSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Interrupted, interactive } from './ask.ts';
import { type ItemFields, parseBacklog, renderItemBlock, replaceItemBlock } from './backlog.ts';
import { checkBalance, latestReadings, stageEstimate } from './balance.ts';
import { type CatalogEntry, referenceCatalog } from './capture.ts';
import { dataDir, openDb } from './db.ts';
import {
  type Answerer,
  type Answers,
  type Conversation,
  type ReviewIO,
  allDecisions,
  converse,
  editList,
  engineLog,
  firstPrompt,
  itemCriteria,
  itemDraft,
  metricsOf,
  noAnswers,
  outputLines,
  reviewOutput,
  suggestionAnswerer,
  terminalAnswerer,
  terminalReviewIO as engineTerminalIO,
} from './engine.ts';
import { formatWhen, truncate } from './format.ts';
import { type Item, REPRODUCTION, backlogPath, getItem, isStarted, listItems, syncBacklog } from './items.ts';
import { select } from './menu.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import type { RunStage } from './runner.ts';
import type { SpecifyOutput } from './schemas/stages.ts';
import { renderChange } from './specs.ts';
import { writeArtifact } from './stages.ts';
import { runProbe } from './status.ts';
import { style } from './style.ts';

export const refineUsage = 'mabel refinar [<n>] [--refazer] [--aceitar | --descartar] | mabel refinar <n> --referencias';

export const refineOptions = {
  refazer: { type: 'boolean', description: 'Descarta a proposta pendente e pede outra ao agente' },
  aceitar: { type: 'boolean', description: 'Responde as perguntas com as sugestões e grava a proposta inteira sem revisão' },
  descartar: { type: 'boolean', description: 'Descarta a proposta pendente sem gravar nada' },
  referencias: { type: 'boolean', description: 'Só escolhe as referências do item na lista, sem agente e sem custo' },
} satisfies OptionSpecs;

export const refineArgs: ArgSpec[] = [{ name: '<n>', description: 'Número do item; sem ele, a lista dos itens para refinar', values: 'item' }];

// Propostas no banco ---------------------------------------------------------------------

export type RefinementStatus = 'proposed' | 'accepted' | 'discarded';

export interface Refinement {
  id: number;
  itemId: string;
  runId: string | null;
  /** Hash do item quando a proposta foi feita: se o item mudar, a proposta fica desatualizada. */
  contentHash: string;
  /** Estado da conversa com o motor; `null` na proposta do refinamento antigo (antes do S.4). */
  conversation: Conversation | null;
  status: RefinementStatus;
  decision: unknown;
  createdAt: string;
  decidedAt: string | null;
}

interface RefinementRow {
  id: number;
  item_id: string;
  run_id: string | null;
  content_hash: string;
  proposal: string;
  status: RefinementStatus;
  decision: string | null;
  created_at: string;
  decided_at: string | null;
  session_id: string | null;
  rounds: number;
  questions: number;
  answers: string | null;
}

function fromRow(row: RefinementRow): Refinement {
  const proposal = JSON.parse(row.proposal) as SpecifyOutput;
  const legacy = !Array.isArray((proposal as Partial<SpecifyOutput>).regras);
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    contentHash: row.content_hash,
    conversation: legacy
      ? null
      : {
          sessionId: row.session_id,
          rounds: row.rounds,
          questions: row.questions,
          output: proposal,
          answers: row.answers ? (JSON.parse(row.answers) as Answers) : noAnswers(),
          runId: row.run_id,
        },
    status: row.status,
    decision: row.decision ? JSON.parse(row.decision) : null,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export function latestRefinement(db: DatabaseSync, itemId: string): Refinement | undefined {
  const row = db.prepare('SELECT * FROM refinements WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(itemId) as
    | RefinementRow
    | undefined;
  return row ? fromRow(row) : undefined;
}

/** Item com alguma proposta aceita. */
export function wasRefined(db: DatabaseSync, itemId: string): boolean {
  return db.prepare("SELECT 1 FROM refinements WHERE item_id = ? AND status = 'accepted' LIMIT 1").get(itemId) !== undefined;
}

export function recordProposal(db: DatabaseSync, item: Item, conversation: Conversation): Refinement {
  const result = db
    .prepare(
      `INSERT INTO refinements (item_id, run_id, content_hash, proposal, status, created_at, session_id, rounds, questions, answers)
       VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
    )
    .run(
      item.id,
      conversation.runId,
      item.contentHash,
      JSON.stringify(conversation.output),
      new Date().toISOString(),
      conversation.sessionId,
      conversation.rounds,
      conversation.questions,
      JSON.stringify(conversation.answers),
    );
  const row = db.prepare('SELECT * FROM refinements WHERE id = ?').get(result.lastInsertRowid) as unknown as RefinementRow;
  return fromRow(row);
}

/** Nova rodada da mesma proposta. */
export function updateProposal(db: DatabaseSync, id: number, conversation: Conversation): void {
  db.prepare('UPDATE refinements SET run_id = ?, proposal = ?, session_id = ?, rounds = ?, questions = ?, answers = ? WHERE id = ?').run(
    conversation.runId,
    JSON.stringify(conversation.output),
    conversation.sessionId,
    conversation.rounds,
    conversation.questions,
    JSON.stringify(conversation.answers),
    id,
  );
}

export function decideProposal(db: DatabaseSync, id: number, status: Exclude<RefinementStatus, 'proposed'>, decision: unknown): void {
  db.prepare('UPDATE refinements SET status = ?, decision = ?, decided_at = ? WHERE id = ?').run(
    status,
    JSON.stringify(decision),
    new Date().toISOString(),
    id,
  );
}

export type Situation = 'não refinado' | 'perguntas pendentes' | 'proposta pendente' | 'proposta desatualizada' | 'refinado' | 'descartado';

export function situation(db: DatabaseSync, item: Item): Situation {
  const latest = latestRefinement(db, item.id);
  if (latest?.status === 'proposed') {
    if (latest.contentHash !== item.contentHash || !latest.conversation) return 'proposta desatualizada';
    return latest.conversation.output.perguntas.length > 0 ? 'perguntas pendentes' : 'proposta pendente';
  }
  if (wasRefined(db, item.id)) return 'refinado';
  if (latest?.status === 'discarded') return 'descartado';
  return 'não refinado';
}

/** Itens que ainda podem ser refinados: no backlog ou prontos, sem nunca ter entrado em planejamento. */
export function refinableItems(db: DatabaseSync, project: Project): Item[] {
  return listItems(db, project.id).filter((item) => isRefinable(db, item));
}

function isRefinable(db: DatabaseSync, item: Item): boolean {
  return (item.status === 'backlog' || item.status === 'ready') && !isStarted(db, item.id);
}

// Run de refinamento ---------------------------------------------------------------------

/** O prompt da primeira rodada do avulso; `root`: raiz do projeto, de onde as referências e as regras vigentes são lidas. */
export function refinePrompt(item: Item, root?: string): string {
  return root ? firstPrompt({ kind: 'item', item }, root).prompt : itemDraft(item).join('\n');
}

/**
 * Política de saldo numa chamada só: sem leitura recente, faz a chamada mínima; abaixo do
 * piso ou acima do ritmo, pergunta (TTY) ou recusa. Não espera reset: o comando é interativo.
 * `stage` é a etapa cuja estimativa de consumo entra na conta (`specify`, `birth`).
 */
export async function ensureRefineBalance(
  db: DatabaseSync,
  home: string,
  stage: RunStage,
  confirmLow: ((notice: string) => Promise<boolean>) | undefined,
  /** Para onde vai o aviso da chamada mínima (stderr quando o stdout é só JSON). */
  progress: NodeJS.WritableStream = process.stdout,
): Promise<string | undefined> {
  let decision = checkBalance(latestReadings(db), new Date(), stageEstimate(db, stage));
  if (decision.action === 'refresh') {
    progress.write(style.dim('  Atualizando o saldo com uma chamada mínima (haiku)…\n'));
    const outcome = await runProbe(db, home);
    if (outcome.status === 'interrupted') return 'interrompido';
    decision = checkBalance(latestReadings(db), new Date(), stageEstimate(db, stage));
    if (decision.action === 'refresh') return 'sem leitura de saldo depois da chamada mínima';
  }
  if (decision.action === 'proceed') return undefined;
  const notice =
    decision.action === 'pace'
      ? `janela de 7 dias acima do ritmo (${Math.round(decision.used * 100)}% usados, ritmo de ${Math.round(decision.expected * 100)}%)`
      : `saldo da janela de ${decision.window === 'five_hour' ? '5h' : '7 dias'} em ${Math.round(decision.balance * 100)}%`;
  if (confirmLow && (await confirmLow(notice))) return undefined;
  return notice;
}

/** Pergunta de saldo baixo no terminal; sem ele, a recusa. */
export function lowBalancePrompt(io: ReviewIO | undefined, what: string): ((notice: string) => Promise<boolean>) | undefined {
  if (!io) return undefined;
  return async (notice: string) => {
    const answer = (await io.ask(`  ${notice}. ${what} mesmo assim? [s/N] `)).trim().toLowerCase();
    return answer.startsWith('s') || answer.startsWith('y');
  };
}

// Revisão --------------------------------------------------------------------------------

/** O que a revisão acrescenta ao item. */
export interface Additions {
  criteria: string[];
  outOfScope: string[];
  decisions: string[];
  criticalConcepts: string[];
  /** Alterações nas regras vigentes, aplicadas na entrega (`assunto: incluir "texto"`). */
  ruleChanges?: string[];
  /** Intenção nova (a história), só quando o item não tinha. */
  intent?: string;
  /** Lista nova de referências, escolhida no catálogo; ausente quando não muda. */
  references?: string[];
}

export const isEmpty = (additions: Additions) =>
  additions.criteria.length +
    additions.outOfScope.length +
    additions.decisions.length +
    additions.criticalConcepts.length +
    (additions.ruleChanges?.length ?? 0) ===
    0 &&
  additions.references === undefined &&
  additions.intent === undefined;

const NOTHING = /^nada\.?$/i;

/** A proposta do motor como adições ao avulso: regras e exemplos viram critérios; respostas, decisões. */
export function additionsFrom(item: Item, output: SpecifyOutput, answers: Answers): Additions {
  return {
    criteria: itemCriteria(output, item.kind === 'bug'),
    outOfScope: output.foraDoEscopo.filter((entry) => !NOTHING.test(entry.trim())),
    decisions: allDecisions(output, answers),
    criticalConcepts: output.conceitosCriticos,
    ruleChanges: output.alteracoesRegrasVigentes.map(renderChange),
    ...(!item.intent.trim() && output.historia.trim() ? { intent: output.historia.trim() } : {}),
  };
}

export const terminalReviewIO: ReviewIO = engineTerminalIO;
export { type ReviewIO, editList };

const sameEntries = (a: string[], b: string[]) => {
  const key = (list: string[]) => list.map((entry) => entry.trim().toLowerCase()).sort().join('\n');
  return key(a) === key(b);
};

/** Etapa das referências: a lista do catálogo com as atuais marcadas; devolve a nova lista se mudou. */
export async function reviewReferences(io: ReviewIO, item: Item, catalog: CatalogEntry[]): Promise<string[] | undefined> {
  if (catalog.length === 0 || !io.pickReferences) return undefined;
  io.write('');
  io.write(style.bold('Referências') + style.dim(' (telas, operações de API e arquivos já capturados)'));
  const chosen = await io.pickReferences(catalog, item.references);
  return chosen && !sameEntries(chosen, item.references) ? chosen : undefined;
}

export type ReviewResult = { kind: 'accept'; additions: Additions } | { kind: 'keep' } | { kind: 'discard' };

/** Revisão do motor, parte a parte, com a etapa das referências e a prévia do bloco do item. */
export async function reviewProposal(
  io: ReviewIO,
  item: Item,
  conversation: Conversation,
  catalog: CatalogEntry[] = [],
): Promise<ReviewResult> {
  let references: string[] | undefined;
  const review = await reviewOutput(io, conversation.output, {
    target: { kind: 'item', item },
    answers: noAnswers(),
    metrics: metricsOf(conversation),
    extraStep: async () => {
      references = await reviewReferences(io, item, catalog);
    },
    preview: (output) => {
      const additions = { ...additionsFrom(item, output, noAnswers()), ...(references ? { references } : {}) };
      return renderItemBlock({ ...merge(item, additions), number: item.number }).trimEnd().split('\n');
    },
  });
  if (review.kind !== 'accept') return review;
  // As respostas já entraram nas decisões revisadas (`reviewOutput` as junta).
  return { kind: 'accept', additions: { ...additionsFrom(item, review.output, noAnswers()), ...(references ? { references } : {}) } };
}

// Gravação -------------------------------------------------------------------------------

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

function union(current: string[], added: string[]): string[] {
  const result = [...current];
  for (const entry of added) {
    if (entry.trim() && !result.some((other) => normalize(other) === normalize(entry))) result.push(entry.trim());
  }
  return result;
}

/** Campos do item com as adições, sem repetir entradas iguais. A reprodução nova do bug vai à frente. */
export function merge(fields: ItemFields, additions: Additions): ItemFields {
  const [first, ...rest] = additions.criteria;
  const reproduction = first !== undefined && REPRODUCTION.test(first);
  const criteria = reproduction
    ? [first, ...union(fields.criteria.filter((criterion) => !REPRODUCTION.test(criterion)), rest)]
    : union(fields.criteria, additions.criteria);
  return {
    title: fields.title,
    intent: additions.intent ?? fields.intent,
    dependsOn: fields.dependsOn,
    restrictions: fields.restrictions,
    criteria,
    outOfScope: union(fields.outOfScope, additions.outOfScope),
    decisions: union(fields.decisions, additions.decisions),
    criticalConcepts: union(fields.criticalConcepts, additions.criticalConcepts),
    references: additions.references ?? fields.references ?? [],
    kind: fields.kind ?? null,
    ruleChanges: union(fields.ruleChanges ?? [], additions.ruleChanges ?? []),
  };
}

export class RefineError extends Error {}

/**
 * Grava as adições no bloco do item no `backlog.md` (relido agora, com o que o humano tiver
 * mudado) e sincroniza. Recusa item que já entrou em planejamento.
 */
export function applyRefinement(db: DatabaseSync, project: Project, item: Item, refinement: Pick<Refinement, 'id'>, additions: Additions): void {
  if (isStarted(db, item.id)) throw new RefineError(`#${item.number} já entrou em planejamento; o conteúdo dele está congelado.`);
  const path = backlogPath(project);
  if (!isEmpty(additions)) {
    const text = readFileSync(path, 'utf8');
    const entry = parseBacklog(text).find((parsed) => parsed.number === item.number);
    if (!entry) throw new RefineError(`#${item.number} não está mais no backlog.md.`);
    const block = renderItemBlock({ ...entry, ...merge(entry, additions), number: item.number });
    writeFileSync(path, replaceItemBlock(text, entry, block));
  }
  decideProposal(db, refinement.id, 'accepted', additions);
  syncBacklog(db, project);
}

/** Troca as referências do item no `backlog.md`, sem refinamento. Recusa item iniciado. */
export function applyReferences(db: DatabaseSync, project: Project, item: Item, references: string[]): void {
  if (isStarted(db, item.id)) throw new RefineError(`#${item.number} já entrou em planejamento; o conteúdo dele está congelado.`);
  const path = backlogPath(project);
  const text = readFileSync(path, 'utf8');
  const entry = parseBacklog(text).find((parsed) => parsed.number === item.number);
  if (!entry) throw new RefineError(`#${item.number} não está mais no backlog.md.`);
  writeFileSync(path, replaceItemBlock(text, entry, renderItemBlock({ ...entry, references, number: item.number })));
  syncBacklog(db, project);
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Medição -------------------------------------------------------------------------------

/** Sinais de que o item chegou com pouco detalhe, calculados das runs auditadas. */
export interface Signals {
  /** O item já teve alguma run de planejamento. */
  planned: boolean;
  refined: boolean;
  /** Perguntas de todas as runs de planejamento e execução (saída bruta, antes da autonomia). */
  questions: number;
  /** Suposições da última run de planejamento e da última de execução. */
  assumptions: number;
  /** Entradas em `planning` além da primeira. */
  replans: number;
}

export function signals(db: DatabaseSync, itemId: string): Signals {
  const runs = db
    .prepare(
      `SELECT stage, structured_output FROM runs
       WHERE item_id = ? AND kind = 'stage' AND stage IN ('plan', 'execute') AND structured_output IS NOT NULL
       ORDER BY started_at`,
    )
    .all(itemId) as { stage: 'plan' | 'execute'; structured_output: string }[];
  let questions = 0;
  const lastAssumptions: Record<string, number> = {};
  for (const run of runs) {
    let output: { perguntas?: unknown[]; suposicoes?: unknown[] };
    try {
      output = JSON.parse(run.structured_output) as typeof output;
    } catch {
      continue;
    }
    questions += Array.isArray(output.perguntas) ? output.perguntas.length : 0;
    lastAssumptions[run.stage] = Array.isArray(output.suposicoes) ? output.suposicoes.length : 0;
  }
  const plannings = db
    .prepare("SELECT count(*) AS total FROM item_transitions WHERE item_id = ? AND to_state = 'planning'")
    .get(itemId) as { total: number };
  return {
    planned: runs.some((run) => run.stage === 'plan'),
    refined: wasRefined(db, itemId),
    questions,
    assumptions: (lastAssumptions.plan ?? 0) + (lastAssumptions.execute ?? 0),
    replans: Math.max(0, plannings.total - 1),
  };
}

export function signalsLine(s: Signals, situationText: string): string {
  if (!s.planned) return situationText;
  return `${situationText} · ${count(s.questions, 'pergunta', 'perguntas')} · ${count(s.assumptions, 'suposição', 'suposições')} · ${count(s.replans, 'replanejamento', 'replanejamentos')}`;
}

/** Médias dos itens já planejados, separando os refinados dos que não foram. */
export function signalsComparison(db: DatabaseSync, projectId: string): string[] {
  const items = listItems(db, projectId).map((item) => signals(db, item.id)).filter((s) => s.planned);
  if (items.length === 0) return [];
  const average = (group: Signals[], label: string) => {
    if (group.length === 0) return `  ${label}: nenhum item planejado`;
    const mean = (pick: (s: Signals) => number) => (group.reduce((sum, s) => sum + pick(s), 0) / group.length).toFixed(1).replace('.', ',');
    return `  ${label} (${count(group.length, 'item', 'itens')}): ${mean((s) => s.questions)} perguntas · ${mean((s) => s.assumptions)} suposições · ${mean((s) => s.replans)} replanejamentos por item`;
  };
  return [average(items.filter((s) => s.refined), 'refinados'), average(items.filter((s) => !s.refined), 'não refinados')];
}

// Comando --------------------------------------------------------------------------------

export interface RefineFlags {
  redo?: boolean;
  accept?: boolean;
  discard?: boolean;
}

function additionsSummary(additions: Additions): string {
  const parts = [
    additions.criteria.length && count(additions.criteria.length, 'critério', 'critérios'),
    additions.outOfScope.length && count(additions.outOfScope.length, 'fora do escopo', 'fora do escopo'),
    additions.decisions.length && count(additions.decisions.length, 'decisão', 'decisões'),
    additions.criticalConcepts.length && count(additions.criticalConcepts.length, 'regra crítica', 'regras críticas'),
    additions.ruleChanges?.length && count(additions.ruleChanges.length, 'regra vigente', 'regras vigentes'),
    additions.references && count(additions.references.length, 'referência', 'referências'),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'nada acrescentado';
}

/** Interrompe a conversa fora do TTY sem `--aceitar`: as perguntas ficam pendentes. */
class StopAsking extends Error {}

/** Proposta com mais de uma tarefa: o avulso parece uma spec. */
function specHint(item: Item, output: SpecifyOutput): string | undefined {
  if (output.tarefas.length <= 1) return undefined;
  return `A proposta tem ${output.tarefas.length} tarefas: #${item.number} parece uma spec. Escreva a história em .mabel/specs/<slug>.md e rode \`mabel especificar <slug>\`.`;
}

/** Refina um avulso no motor: continua a proposta pendente ou roda o agente, e então revisa, aceita ou descarta. */
export async function refineItem(
  db: DatabaseSync,
  home: string,
  project: Project,
  item: Item,
  flags: RefineFlags,
  io: ReviewIO | undefined,
): Promise<number> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  if (!isRefinable(db, item)) {
    process.stderr.write(
      isStarted(db, item.id)
        ? `#${item.number} já entrou em planejamento; refinamento só antes disso.\n`
        : `#${item.number} está em ${item.status}; só itens em backlog ou ready são refinados.\n`,
    );
    return 1;
  }
  if (item.spec) {
    process.stderr.write(`#${item.number} é tarefa da spec ${item.spec}: refine a spec com \`mabel especificar ${item.spec}\`.\n`);
    return 1;
  }
  const latest = latestRefinement(db, item.id);
  const pendingProposal = latest?.status === 'proposed' ? latest : undefined;
  if (flags.discard) {
    if (!pendingProposal) {
      process.stderr.write(`#${item.number} não tem proposta pendente.\n`);
      return 1;
    }
    decideProposal(db, pendingProposal.id, 'discarded', { motivo: 'descartada' });
    out(`Proposta de #${item.number} descartada.`);
    return 0;
  }

  const usable = pendingProposal && pendingProposal.contentHash === item.contentHash && pendingProposal.conversation && !flags.redo;
  let refinement = usable ? pendingProposal : undefined;
  if (!refinement && !pendingProposal && !flags.redo && io && wasRefined(db, item.id)) {
    try {
      const answer = (await io.ask(`#${item.number} já foi refinado. Pedir outra proposta ao agente? [s/N] `)).trim().toLowerCase();
      if (!answer.startsWith('s') && !answer.startsWith('y')) return 0;
    } catch (error) {
      if (error instanceof Interrupted) return 130;
      throw error;
    }
  }
  if (pendingProposal && !refinement) {
    const motivo = flags.redo ? 'refeita' : pendingProposal.conversation ? 'item mudou depois da proposta' : 'proposta do refinamento antigo';
    decideProposal(db, pendingProposal.id, 'discarded', { motivo });
  }
  out(style.bold(`#${item.number} ${item.title}`) + style.dim(item.kind === 'bug' ? ' · refinamento (bug)' : ' · refinamento'));

  let conversation = refinement?.conversation ?? undefined;
  if (conversation && conversation.output.perguntas.length === 0) {
    out(style.dim(`  proposta de ${formatWhen((refinement as Refinement).createdAt)} (use --refazer para pedir outra)`));
  } else {
    if (!conversation || flags.accept || io) {
      const blocked = await ensureRefineBalance(db, home, 'specify', lowBalancePrompt(io, 'Refinar'));
      if (blocked) {
        process.stderr.write(`Refinamento não iniciado: ${blocked}.\n`);
        return blocked === 'interrompido' ? 130 : 1;
      }
    }
    let id = refinement?.id;
    const save = (next: Conversation) => {
      if (id === undefined) id = recordProposal(db, item, next).id;
      else updateProposal(db, id, next);
      writeArtifact(home, item.id, `refinamento-${id}-rodada-${next.rounds}.json`, next.output);
    };
    const answerer: Answerer = flags.accept
      ? suggestionAnswerer
      : io
        ? terminalAnswerer(io)
        : async () => {
            throw new StopAsking();
          };
    const env = { db, home, project, log: engineLog(project.root) };
    let result;
    try {
      result = await converse(env, { kind: 'item', item }, conversation, answerer, save, (line) => out(style.dim(`  ${line}`)));
    } catch (error) {
      if (error instanceof StopAsking) {
        const pending = latestRefinement(db, item.id)?.conversation as Conversation;
        out('');
        out(outputLines(pending.output, pending.answers).join('\n'));
        out('');
        out(`Responda as perguntas no terminal com \`mabel refinar ${item.number}\`, aceite as sugestões com \`mabel refinar ${item.number} --aceitar\``);
        out(`ou descarte com \`mabel refinar ${item.number} --descartar\`.`);
        return 0;
      }
      if (error instanceof Interrupted) {
        out('');
        out(style.dim(`interrompido: a proposta de #${item.number} continua pendente`));
        return 130;
      }
      throw error;
    }
    if ('error' in result) {
      process.stderr.write(`${result.error}\n`);
      return result.interrupted ? 130 : 1;
    }
    conversation = result.conversation;
    refinement = latestRefinement(db, item.id) as Refinement;
  }
  out('');
  const hint = specHint(item, conversation.output);

  if (flags.accept) {
    const additions = additionsFrom(item, conversation.output, conversation.answers);
    out(outputLines(conversation.output, conversation.answers).join('\n'));
    applyRefinement(db, project, item, refinement as Refinement, additions);
    out('');
    out(`✓ #${item.number} refinado: ${additionsSummary(additions)}.`);
    for (const question of conversation.answers.adiadas) out(style.dim(`  pergunta sem sugestão, deixada para o planejamento: ${question}`));
    if (hint) out(style.dim(`  ${hint}`));
    return 0;
  }
  if (!io) {
    out(outputLines(conversation.output, conversation.answers).join('\n'));
    out('');
    out(`Revise no terminal com \`mabel refinar ${item.number}\`, grave como está com \`mabel refinar ${item.number} --aceitar\``);
    out(`ou descarte com \`mabel refinar ${item.number} --descartar\`.`);
    return 0;
  }

  if (hint) io.write(style.dim(hint));
  let review: ReviewResult;
  try {
    review = await reviewProposal(
      io,
      item,
      { ...conversation, output: { ...conversation.output, decisoes: allDecisions(conversation.output, conversation.answers) } },
      referenceCatalog(project.root, listItems(db, project.id)),
    );
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    io.write('');
    io.write(style.dim(`interrompido: a proposta de #${item.number} continua pendente`));
    return 130;
  }
  if (review.kind === 'keep') {
    io.write(style.dim(`Proposta de #${item.number} mantida pendente; nada gravado.`));
    return 0;
  }
  if (review.kind === 'discard') {
    decideProposal(db, (refinement as Refinement).id, 'discarded', { motivo: 'descartada na revisão' });
    io.write(`Proposta de #${item.number} descartada.`);
    return 0;
  }
  applyRefinement(db, project, item, refinement as Refinement, review.additions);
  const updated = getItem(db, project.id, item.number);
  io.write(`✓ #${item.number} refinado: ${additionsSummary(review.additions)} · ${updated?.status ?? '?'}`);
  if (updated?.status === 'backlog' && updated.statusReason) io.write(style.dim(`  ${updated.statusReason}`));
  return 0;
}

function renderRefinable(db: DatabaseSync, items: Item[]): string[] {
  const rows = items.map((item) => [`#${item.number}`, truncate(item.title, 48), item.status, situation(db, item)]);
  const header = ['#', 'título', 'estado', 'refinamento'];
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [line(header), ...rows.map(line)];
}

/** Menu dos itens refináveis; o escolhido é refinado e o menu volta até `q`. */
async function chooseLoop(db: DatabaseSync, home: string, project: Project): Promise<number> {
  for (;;) {
    const items = refinableItems(db, project);
    if (items.length === 0) {
      process.stdout.write('Nenhum item para refinar.\n');
      return 0;
    }
    process.stdout.write(`${style.bold('Itens para refinar')}\n`);
    const chosen = await select(
      items.map((item) => ({ label: `#${item.number} ${truncate(item.title, 50)}`, hint: style.dim(`${item.status} · ${situation(db, item)}`) })),
      style,
    );
    if (chosen === null) return 0;
    process.stdout.write('\n');
    const code = await refineItem(db, home, project, items[chosen] as Item, {}, terminalReviewIO);
    if (code === 130) return 130;
    process.stdout.write('\n');
  }
}

/** `mabel refinar <n> --referencias`: só a etapa das referências, gravada direto no item. */
async function editReferences(db: DatabaseSync, project: Project, item: Item): Promise<number> {
  if (!interactive()) {
    process.stderr.write('--referencias escolhe numa lista e precisa do terminal. Sem ele, edite o campo "Referências:" no backlog.md.\n');
    return 1;
  }
  if (isStarted(db, item.id)) {
    process.stderr.write(`#${item.number} já entrou em planejamento; o conteúdo dele está congelado.\n`);
    return 1;
  }
  const catalog = referenceCatalog(project.root, listItems(db, project.id));
  if (catalog.length === 0) {
    process.stderr.write('Nenhuma referência capturada. Capture com `mabel referencia api` ou `mabel referencia tela`.\n');
    return 1;
  }
  process.stdout.write(`${style.bold(`#${item.number} ${item.title}`)}${style.dim(' · referências')}\n`);
  const references = await reviewReferences(terminalReviewIO, item, catalog);
  if (!references) {
    process.stdout.write(style.dim('Nada mudou.\n'));
    return 0;
  }
  applyReferences(db, project, item, references);
  const updated = getItem(db, project.id, item.number);
  process.stdout.write(`✓ #${item.number}: ${count(references.length, 'referência', 'referências')} · ${updated?.status ?? '?'}\n`);
  if (updated?.status === 'backlog' && updated.statusReason) process.stdout.write(style.dim(`  ${updated.statusReason}\n`));
  return 0;
}

export async function refineCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: refineOptions,
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${refineUsage}\n`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.referencias && (values.aceitar || values.descartar || values.refazer)) {
    process.stderr.write(`--referencias não se combina com --refazer, --aceitar ou --descartar.\nUso: ${refineUsage}\n`);
    return 1;
  }
  if (values.aceitar && values.descartar) {
    process.stderr.write(`Use --aceitar ou --descartar, não os dois.\nUso: ${refineUsage}\n`);
    return 1;
  }
  const value = positionals[0];
  const number = value === undefined ? undefined : Number(value.replace(/^#/, ''));
  if (number !== undefined && (!Number.isInteger(number) || number < 1)) {
    process.stderr.write(`"${value}" não é o número de um item.\nUso: ${refineUsage}\n`);
    return 1;
  }

  const home = dataDir();
  const db = openDb(home);
  try {
    const project = resolveProject(db);
    syncBacklog(db, project);
    if (number === undefined) {
      if (values.aceitar || values.descartar || values.refazer || values.referencias) {
        process.stderr.write(`Informe o número do item.\nUso: ${refineUsage}\n`);
        return 1;
      }
      if (interactive()) return await chooseLoop(db, home, project);
      const items = refinableItems(db, project);
      process.stdout.write(items.length === 0 ? 'Nenhum item para refinar.\n' : `${renderRefinable(db, items).join('\n')}\n`);
      return 0;
    }
    const item = getItem(db, project.id, number);
    if (!item) {
      process.stderr.write(`Item #${number} não existe.\n`);
      return 1;
    }
    if (values.referencias) return await editReferences(db, project, item);
    const flags = { redo: values.refazer, accept: values.aceitar, discard: values.descartar };
    return await refineItem(db, home, project, item, flags, interactive() ? terminalReviewIO : undefined);
  } catch (error) {
    if (error instanceof ProjectError || error instanceof RefineError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}
