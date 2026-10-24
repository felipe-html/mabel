import { readFileSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Interrupted, ask, interactive } from './ask.ts';
import { type ItemFields, parseBacklog, renderItemBlock, replaceItemBlock } from './backlog.ts';
import { checkBalance, latestReadings, stageEstimate } from './balance.ts';
import { dataDir, openDb } from './db.ts';
import { ToolLog, summaryLine } from './exec.ts';
import { formatWhen, truncate } from './format.ts';
import { type Item, backlogPath, getItem, isStarted, listItems, syncBacklog } from './items.ts';
import { select } from './menu.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import { liveReferences, referencesSection } from './references.ts';
import type { RefineOutput } from './schemas/stages.ts';
import { ContextBudgetError, type StageContext, runStage, writeArtifact } from './stages.ts';
import type { RunStage } from './runner.ts';
import { runProbe } from './status.ts';
import { style } from './style.ts';

export const refineUsage = 'mabel refinar [<n>] [--refazer] [--aceitar | --descartar]';

// Propostas no banco ---------------------------------------------------------------------

export type RefinementStatus = 'proposed' | 'accepted' | 'discarded';

export interface Refinement {
  id: number;
  itemId: string;
  runId: string | null;
  /** Hash do item quando a proposta foi feita: se o item mudar, a proposta fica desatualizada. */
  contentHash: string;
  proposal: RefineOutput;
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
}

function fromRow(row: RefinementRow): Refinement {
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    contentHash: row.content_hash,
    proposal: JSON.parse(row.proposal) as RefineOutput,
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

export function recordProposal(db: DatabaseSync, item: Item, proposal: RefineOutput, runId: string | null): Refinement {
  const result = db
    .prepare(
      `INSERT INTO refinements (item_id, run_id, content_hash, proposal, status, created_at)
       VALUES (?, ?, ?, ?, 'proposed', ?)`,
    )
    .run(item.id, runId, item.contentHash, JSON.stringify(proposal), new Date().toISOString());
  const row = db.prepare('SELECT * FROM refinements WHERE id = ?').get(result.lastInsertRowid) as unknown as RefinementRow;
  return fromRow(row);
}

export function decideProposal(db: DatabaseSync, id: number, status: Exclude<RefinementStatus, 'proposed'>, decision: unknown): void {
  db.prepare('UPDATE refinements SET status = ?, decision = ?, decided_at = ? WHERE id = ?').run(
    status,
    JSON.stringify(decision),
    new Date().toISOString(),
    id,
  );
}

export type Situation = 'não refinado' | 'proposta pendente' | 'proposta desatualizada' | 'refinado' | 'descartado';

export function situation(db: DatabaseSync, item: Item): Situation {
  const latest = latestRefinement(db, item.id);
  if (latest?.status === 'proposed') return latest.contentHash === item.contentHash ? 'proposta pendente' : 'proposta desatualizada';
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

function bullets(entries: string[], empty: string): string {
  return entries.length > 0 ? entries.map((entry) => `- ${entry}`).join('\n') : empty;
}

/** `root`: raiz do projeto (cwd do refinamento), de onde as referências são lidas sem cópia. */
export function refinePrompt(item: Item, root?: string): string {
  const section = (title: string, body: string) => (body.trim() ? [`## ${title}`, '', body.trim(), ''] : []);
  return [
    `# Item #${item.number}: ${item.title}`,
    '',
    ...section('Intenção', item.intent),
    ...section('Critérios de aceite atuais', bullets(item.criteria, 'Nenhum.')),
    ...section('Fora do escopo declarado', bullets(item.outOfScope, 'Nada.')),
    ...section('Decisões já tomadas', bullets(item.decisions, 'Nenhuma.')),
    ...section('Regras críticas declaradas', bullets(item.criticalConcepts, 'Nenhuma.')),
    ...section('Referências', root ? referencesSection(liveReferences(root, item.references), '') : ''),
    ...section('Restrições', item.restrictions ?? ''),
    '## Tarefa',
    '',
    'Leia o código do projeto no diretório atual o quanto precisar para entender o item e proponha o refinamento. Não altere arquivos.',
  ].join('\n');
}

export type RefineRunResult = { refinement: Refinement } | { error: string; interrupted?: boolean };

/** Roda a etapa `refine` na raiz do projeto e grava a proposta (artefato e banco). */
export async function runRefine(db: DatabaseSync, home: string, project: Project, item: Item): Promise<RefineRunResult> {
  const ctx: StageContext = { home, project, item, worktree: project.root };
  const log = new ToolLog(project.root, '    ');
  let interrupt = () => {};
  const onSigint = () => interrupt();
  process.on('SIGINT', onSigint);
  let result;
  try {
    result = await runStage<RefineOutput>(db, ctx, 'refine', refinePrompt(item, project.root), {
      observer: {
        onInit: ({ model }) => log.write(style.dim(`  ▸ refinar · ${model ?? '?'}`)),
        onToolUse: (call) => log.use(call.id, call.name, call.input),
        onToolResult: (toolResult) => log.close(toolResult.id, toolResult.isError),
      },
      onStart: (handle) => {
        interrupt = handle.interrupt;
      },
    });
  } catch (error) {
    if (error instanceof ContextBudgetError) return { error: error.message };
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
  }
  log.flush();
  log.write(style.dim(`  ${summaryLine(result.outcome)}`));
  if (result.outcome.status === 'interrupted') return { error: 'refinamento interrompido', interrupted: true };
  if (result.outcome.status !== 'succeeded') return { error: `a run de refinamento falhou: ${result.outcome.error ?? 'erro desconhecido'}` };
  if (!result.output) return { error: `proposta inválida: ${result.invalid ?? 'saída ausente'}` };
  const previous = db.prepare('SELECT count(*) AS total FROM refinements WHERE item_id = ?').get(item.id) as { total: number };
  writeArtifact(home, item.id, `refinamento-${previous.total + 1}.json`, result.output);
  return { refinement: recordProposal(db, item, result.output, result.outcome.runId) };
}

/**
 * Política de saldo numa chamada só: sem leitura recente, faz a chamada mínima; abaixo do
 * piso ou acima do ritmo, pergunta (TTY) ou recusa. Não espera reset: o comando é interativo.
 * `stage` é a etapa cuja estimativa de consumo entra na conta (`refine`, `birth`).
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

// Revisão --------------------------------------------------------------------------------

/** O que a revisão acrescenta ao item. */
export interface Additions {
  criteria: string[];
  outOfScope: string[];
  decisions: string[];
  criticalConcepts: string[];
}

export const isEmpty = (additions: Additions) =>
  additions.criteria.length + additions.outOfScope.length + additions.decisions.length + additions.criticalConcepts.length === 0;

/** Resposta a uma pergunta do refinamento, no formato que vai para `Decisões`. */
export function decisionText(question: string, answer: string): string {
  return `${question.trim()} → ${answer.trim()}`;
}

/** Aceita a proposta inteira: perguntas com sugestão viram decisões; as sem sugestão ficam de fora. */
export function acceptAll(proposal: RefineOutput): { additions: Additions; unanswered: string[] } {
  return {
    additions: {
      criteria: proposal.criterios,
      outOfScope: proposal.foraDoEscopo,
      decisions: proposal.perguntas.filter((q) => q.sugestao.trim()).map((q) => decisionText(q.texto, q.sugestao)),
      criticalConcepts: proposal.conceitosCriticos,
    },
    unanswered: proposal.perguntas.filter((q) => !q.sugestao.trim()).map((q) => q.texto),
  };
}

/** Entrada e saída da revisão; os testes trocam o terminal por respostas roteirizadas. */
export interface ReviewIO {
  /** Lê uma linha; ctrl+c lança `Interrupted`. */
  ask: (prompt: string) => Promise<string>;
  write: (line: string) => void;
}

export const terminalReviewIO: ReviewIO = {
  ask,
  write: (line) => process.stdout.write(`${line}\n`),
};

export type ReviewResult = { kind: 'accept'; additions: Additions } | { kind: 'keep' } | { kind: 'discard' };

const INDENT = '  ';

/** Lista proposta: enter aceita, `e` edita uma a uma, `-` descarta. */
async function reviewList(io: ReviewIO, title: string, entries: string[]): Promise<string[]> {
  if (entries.length === 0) return [];
  io.write('');
  io.write(style.bold(title));
  entries.forEach((entry, i) => io.write(`${INDENT}${i + 1}. ${entry}`));
  for (;;) {
    const answer = (await io.ask(`${INDENT}› enter aceita · e edita um a um · - descarta: `)).trim().toLowerCase();
    if (!answer) return entries;
    if (answer === '-') return [];
    if (answer === 'e') return editList(io, entries);
    io.write(style.dim(`${INDENT}responda enter, e ou -`));
  }
}

export async function editList(io: ReviewIO, entries: string[]): Promise<string[]> {
  io.write(style.dim(`${INDENT}enter mantém · - remove · texto novo substitui`));
  const kept: string[] = [];
  for (const [i, entry] of entries.entries()) {
    io.write(`${INDENT}${i + 1}. ${entry}`);
    const answer = (await io.ask(`${INDENT}   › `)).trim();
    if (answer === '-') continue;
    kept.push(answer || entry);
  }
  io.write(style.dim(`${INDENT}acrescente outros, um por linha (linha vazia encerra)`));
  for (;;) {
    const extra = (await io.ask(`${INDENT}+ `)).trim();
    if (!extra) return kept;
    kept.push(extra);
  }
}

export function renderProposal(item: Item, proposal: RefineOutput): string[] {
  const lines = [style.bold('Entendimento'), ...proposal.entendimento.trim().split('\n').map((line) => `${INDENT}${line}`)];
  const list = (title: string, entries: string[]) => {
    if (entries.length > 0) lines.push('', style.bold(title), ...entries.map((entry, i) => `${INDENT}${i + 1}. ${entry}`));
  };
  if (proposal.perguntas.length > 0) {
    lines.push('', style.bold('Perguntas'));
    for (const [i, q] of proposal.perguntas.entries()) {
      lines.push(`${INDENT}${i + 1}. ${q.texto}${q.regraCritica ? ' (regra crítica)' : ''}`);
      if (q.sugestao) lines.push(`${INDENT}   sugestão: ${q.sugestao}`);
    }
  }
  list('Critérios propostos', proposal.criterios);
  list('Fora do escopo proposto', proposal.foraDoEscopo);
  list('Regras críticas que o item toca', proposal.conceitosCriticos);
  if (proposal.quebra.length > 0) {
    lines.push('', style.bold(`Quebra sugerida para #${item.number} (não é aplicada; crie os itens com /add se concordar)`));
    for (const part of proposal.quebra) lines.push(`${INDENT}- ${part.titulo}: ${part.intencao}`);
  }
  return lines;
}

/** Revisão no terminal: perguntas uma a uma, depois cada lista, a prévia e a gravação. */
export async function reviewProposal(io: ReviewIO, item: Item, proposal: RefineOutput): Promise<ReviewResult> {
  io.write(style.bold('Entendimento'));
  for (const line of proposal.entendimento.trim().split('\n')) io.write(`${INDENT}${line}`);

  const decisions: string[] = [];
  if (proposal.perguntas.length > 0) {
    io.write('');
    io.write(style.bold('Perguntas'));
    for (const [i, q] of proposal.perguntas.entries()) {
      io.write(`${INDENT}${i + 1}/${proposal.perguntas.length} ${q.texto}${q.regraCritica ? style.dim(' (regra crítica)') : ''}`);
      if (q.sugestao) io.write(`${INDENT}    sugestão: ${q.sugestao}`);
      const hint = q.sugestao ? 'enter aceita a sugestão · texto responde · p deixa para o planejamento' : 'texto responde · enter ou p deixa para o planejamento';
      const answer = (await io.ask(`${INDENT}    › ${style.dim(hint)}: `)).trim();
      if (answer.toLowerCase() === 'p') continue;
      const chosen = answer || q.sugestao;
      if (chosen) decisions.push(decisionText(q.texto, chosen));
    }
  }

  const additions: Additions = {
    criteria: await reviewList(io, 'Critérios propostos', proposal.criterios),
    outOfScope: await reviewList(io, 'Fora do escopo proposto', proposal.foraDoEscopo),
    decisions,
    criticalConcepts: await reviewList(io, 'Regras críticas que o item toca', proposal.conceitosCriticos),
  };

  if (proposal.quebra.length > 0) {
    io.write('');
    io.write(style.bold('Quebra sugerida (não é aplicada; crie os itens com /add se concordar)'));
    for (const part of proposal.quebra) io.write(`${INDENT}- ${part.titulo}: ${part.intencao}`);
  }

  io.write('');
  if (isEmpty(additions)) {
    const answer = (await io.ask('Nada a acrescentar ao item. Marcar como refinado? [S/n] ')).trim().toLowerCase();
    return !answer || answer.startsWith('s') || answer.startsWith('y') ? { kind: 'accept', additions } : { kind: 'keep' };
  }
  io.write(style.bold('Como fica o item'));
  for (const line of renderItemBlock({ ...merge(item, additions), number: item.number }).trimEnd().split('\n')) {
    io.write(`${INDENT}${line}`);
  }
  io.write('');
  for (;;) {
    const answer = (await io.ask('Gravar no backlog? [S/n/d] (n deixa a proposta pendente · d descarta) ')).trim().toLowerCase();
    if (!answer || answer.startsWith('s') || answer.startsWith('y')) return { kind: 'accept', additions };
    if (answer.startsWith('n')) return { kind: 'keep' };
    if (answer.startsWith('d')) return { kind: 'discard' };
  }
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

/** Campos do item com as adições, sem repetir entradas iguais. */
export function merge(fields: ItemFields, additions: Additions): ItemFields {
  return {
    title: fields.title,
    intent: fields.intent,
    dependsOn: fields.dependsOn,
    restrictions: fields.restrictions,
    criteria: union(fields.criteria, additions.criteria),
    outOfScope: union(fields.outOfScope, additions.outOfScope),
    decisions: union(fields.decisions, additions.decisions),
    criticalConcepts: union(fields.criticalConcepts, additions.criticalConcepts),
    references: fields.references ?? [],
  };
}

export class RefineError extends Error {}

/**
 * Grava as adições no bloco do item no `backlog.md` (relido agora, com o que o humano tiver
 * mudado) e sincroniza. Recusa item que já entrou em planejamento.
 */
export function applyRefinement(db: DatabaseSync, project: Project, item: Item, refinement: Refinement, additions: Additions): void {
  if (isStarted(db, item.id)) throw new RefineError(`#${item.number} já entrou em planejamento; o conteúdo dele está congelado.`);
  const path = backlogPath(project);
  if (!isEmpty(additions)) {
    const text = readFileSync(path, 'utf8');
    const entry = parseBacklog(text).find((parsed) => parsed.number === item.number);
    if (!entry) throw new RefineError(`#${item.number} não está mais no backlog.md.`);
    const block = renderItemBlock({ ...merge(entry, additions), number: item.number });
    writeFileSync(path, replaceItemBlock(text, entry, block));
  }
  decideProposal(db, refinement.id, 'accepted', additions);
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
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'nada acrescentado';
}

/** Refina um item: usa a proposta pendente ou roda o agente, e então revisa, aceita ou descarta. */
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

  let refinement = pendingProposal && pendingProposal.contentHash === item.contentHash && !flags.redo ? pendingProposal : undefined;
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
    decideProposal(db, pendingProposal.id, 'discarded', { motivo: flags.redo ? 'refeita' : 'item mudou depois da proposta' });
  }
  out(style.bold(`#${item.number} ${item.title}`) + style.dim(' · refinamento'));
  if (refinement) {
    out(style.dim(`  proposta de ${formatWhen(refinement.createdAt)} (use --refazer para pedir outra)`));
  } else {
    const confirmLow = io
      ? async (notice: string) => {
          const answer = (await io.ask(`  ${notice}. Refinar mesmo assim? [s/N] `)).trim().toLowerCase();
          return answer.startsWith('s') || answer.startsWith('y');
        }
      : undefined;
    const blocked = await ensureRefineBalance(db, home, 'refine', confirmLow);
    if (blocked) {
      process.stderr.write(`Refinamento não iniciado: ${blocked}.\n`);
      return blocked === 'interrompido' ? 130 : 1;
    }
    const result = await runRefine(db, home, project, item);
    if ('error' in result) {
      process.stderr.write(`${result.error}\n`);
      return result.interrupted ? 130 : 1;
    }
    refinement = result.refinement;
  }
  out('');

  if (flags.accept) {
    const { additions, unanswered } = acceptAll(refinement.proposal);
    out(renderProposal(item, refinement.proposal).join('\n'));
    applyRefinement(db, project, item, refinement, additions);
    out('');
    out(`✓ #${item.number} refinado: ${additionsSummary(additions)}.`);
    for (const question of unanswered) out(style.dim(`  pergunta sem sugestão, deixada para o planejamento: ${question}`));
    return 0;
  }
  if (!io) {
    out(renderProposal(item, refinement.proposal).join('\n'));
    out('');
    out(`Revise no terminal com \`mabel refinar ${item.number}\`, grave como está com \`mabel refinar ${item.number} --aceitar\``);
    out(`ou descarte com \`mabel refinar ${item.number} --descartar\`.`);
    return 0;
  }

  let review: ReviewResult;
  try {
    review = await reviewProposal(io, item, refinement.proposal);
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
    decideProposal(db, refinement.id, 'discarded', { motivo: 'descartada na revisão' });
    io.write(`Proposta de #${item.number} descartada.`);
    return 0;
  }
  applyRefinement(db, project, item, refinement, review.additions);
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

export async function refineCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { refazer: { type: 'boolean' }, aceitar: { type: 'boolean' }, descartar: { type: 'boolean' } },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${refineUsage}\n`);
    return 1;
  }
  const { values, positionals } = parsed;
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
      if (values.aceitar || values.descartar || values.refazer) {
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
