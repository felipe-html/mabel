import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { latestReadings } from './balance.ts';
import { type ItemFields, insertIds, parseBacklog, renderItemBlock, replaceItemBlock, validateBacklog } from './backlog.ts';
import { type BoardItem, renderBoard, writeBoardFile } from './board.ts';
import { type Project, mabelPath } from './project.ts';
import { referenceProblem, referencesDigest } from './references.ts';
import { type SpecExcerpt, excerptDigest, readSpec, specExcerpt, specProblem } from './specs.ts';
import type { Question } from './schemas/stages.ts';

export const ITEM_STATES = [
  'backlog',
  'ready',
  'planning',
  'planned',
  'executing',
  'verifying',
  'reviewing',
  'awaiting_merge',
  'done',
  'needs_human',
  'blocked',
  'failed',
  'cancelled',
] as const;

export type ItemStatus = (typeof ITEM_STATES)[number];

/** Transições permitidas; qualquer outra lança `TransitionError`. */
export const TRANSITIONS: Record<ItemStatus, readonly ItemStatus[]> = {
  backlog: ['ready', 'blocked', 'cancelled'],
  ready: ['planning', 'backlog', 'blocked', 'cancelled'],
  planning: ['planned', 'needs_human', 'failed', 'blocked'],
  planned: ['executing', 'blocked', 'cancelled'],
  executing: ['verifying', 'needs_human', 'failed', 'blocked'],
  verifying: ['reviewing', 'executing', 'needs_human', 'failed'],
  reviewing: ['awaiting_merge', 'executing', 'needs_human', 'failed'],
  // `executing`: retrabalho sem integração; `planning`/`cancelled`: rejeição na integração.
  awaiting_merge: ['done', 'executing', 'planning', 'cancelled'],
  needs_human: ['planning', 'planned', 'executing', 'cancelled'],
  blocked: ['backlog', 'cancelled'],
  failed: ['ready', 'cancelled'],
  done: [],
  cancelled: [],
};

export class TransitionError extends Error {}

export interface Item extends Required<Omit<ItemFields, 'number'>> {
  id: string;
  projectId: string;
  number: number;
  position: number;
  contentHash: string;
  status: ItemStatus;
  statusReason: string | null;
  attempts: number;
  branch: string | null;
  worktree: string | null;
  pendingKind: PendingKind | null;
  pending: Pending | null;
  approvedAt: string | null;
  /** Ciclo aberto pelo `responder` em `attempts_exhausted`: todas as tentativas escalonadas. */
  escalatedCycle: boolean;
  /** Número global da tentativa em andamento (artefatos, commits, gates). */
  attemptNo: number;
  planRetries: number;
  /** Instruções para a próxima run da etapa atual (sessão a retomar, resposta, falha). */
  nextInput: NextInput | null;
  /** Commit de merge do item na branch de integração; nulo até a integração. */
  integratedCommit: string | null;
  /** Trecho da spec citado pela tarefa, congelado como o resto do conteúdo quando ela inicia. */
  specContext: SpecExcerpt | null;
  /** Unidade de entrega fixada pelo Mabel (`legado`, na migração); nula, vem da spec ou do avulso. */
  unit: string | null;
}

export type PendingKind =
  | 'question_plan'
  | 'plan_incomplete'
  | 'critical_approval'
  | 'question_execute'
  | 'attempts_exhausted'
  | 'environment_block'
  | 'integration_conflict';

/** Detalhes da parada em `needs_human`, mostrados pelo `mabel item`. */
export interface Pending {
  sessionId?: string | null;
  questions?: Question[];
  criticalAssumptions?: string[];
  reason?: string;
  summary?: string;
  /** Arquivos em conflito (`integration_conflict`). */
  files?: string[];
}

export interface NextInput {
  resumeSessionId?: string;
  answer?: string;
  failure?: string;
  retryReason?: string;
  attemptsSummary?: string;
  /** Replanejamento em sessão nova a partir do plano anterior. */
  previousPlan?: boolean;
  /** A run anterior foi interrompida: retomar a sessão e continuar. */
  interrupted?: boolean;
  /** Continua a mesma tentativa (resposta a uma pergunta da execução). */
  sameAttempt?: boolean;
  /** Antes da execução, o Mabel faz o merge da origem e deixa os conflitos para o executor. */
  mergeOrigin?: boolean;
  /** Globs acrescentados ao escopo a pedido da execução; a mesma sessão retoma para concluir. */
  scopeExtended?: string[];
}

interface ItemRow {
  id: string;
  project_id: string;
  number: number;
  position: number;
  title: string;
  intent: string;
  criteria: string;
  depends_on: string;
  restrictions: string | null;
  out_of_scope: string;
  decisions: string;
  critical_concepts: string;
  item_references: string;
  content_hash: string;
  status: ItemStatus;
  status_reason: string | null;
  attempts: number;
  branch: string | null;
  worktree: string | null;
  pending_kind: PendingKind | null;
  pending: string | null;
  approved_at: string | null;
  escalated_cycle: number;
  attempt_no: number;
  plan_retries: number;
  next_input: string | null;
  integrated_commit: string | null;
  spec: string | null;
  spec_rules: string;
  spec_context: string | null;
  kind: 'bug' | null;
  rule_changes: string;
  unit: string | null;
}

/**
 * Pendências antigas: as gravadas antes das sugestões guardavam as perguntas como texto puro,
 * e as anteriores à autonomia não tinham `regraCritica`.
 */
function readPending(json: string): Pending {
  const pending = JSON.parse(json) as Omit<Pending, 'questions'> & {
    questions?: (Partial<Question> | string)[];
  };
  if (!pending.questions) return pending as Pending;
  return {
    ...pending,
    questions: pending.questions.map((q) =>
      typeof q === 'string'
        ? { texto: q, sugestao: '', regraCritica: false }
        : { texto: q.texto ?? '', sugestao: q.sugestao ?? '', regraCritica: q.regraCritica ?? false },
    ),
  };
}

function fromRow(row: ItemRow): Item {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    position: row.position,
    title: row.title,
    intent: row.intent,
    criteria: JSON.parse(row.criteria) as string[],
    dependsOn: JSON.parse(row.depends_on) as number[],
    restrictions: row.restrictions,
    outOfScope: JSON.parse(row.out_of_scope) as string[],
    decisions: JSON.parse(row.decisions) as string[],
    criticalConcepts: JSON.parse(row.critical_concepts) as string[],
    references: JSON.parse(row.item_references) as string[],
    contentHash: row.content_hash,
    status: row.status,
    statusReason: row.status_reason,
    attempts: row.attempts,
    branch: row.branch,
    worktree: row.worktree,
    pendingKind: row.pending_kind,
    pending: row.pending ? readPending(row.pending) : null,
    approvedAt: row.approved_at,
    escalatedCycle: row.escalated_cycle === 1,
    attemptNo: row.attempt_no,
    planRetries: row.plan_retries,
    nextInput: row.next_input ? (JSON.parse(row.next_input) as NextInput) : null,
    integratedCommit: row.integrated_commit,
    spec: row.spec,
    rules: JSON.parse(row.spec_rules) as string[],
    kind: row.kind,
    ruleChanges: JSON.parse(row.rule_changes) as string[],
    unit: row.unit,
    specContext: row.spec_context ? (JSON.parse(row.spec_context) as SpecExcerpt) : null,
  };
}

export interface ItemUpdate {
  attempts?: number;
  attemptNo?: number;
  planRetries?: number;
  escalatedCycle?: boolean;
  approvedAt?: string | null;
  pendingKind?: PendingKind | null;
  pending?: Pending | null;
  nextInput?: NextInput | null;
  integratedCommit?: string | null;
  unit?: string | null;
}

const UPDATE_COLUMNS: Record<keyof ItemUpdate, string> = {
  attempts: 'attempts',
  attemptNo: 'attempt_no',
  planRetries: 'plan_retries',
  escalatedCycle: 'escalated_cycle',
  approvedAt: 'approved_at',
  pendingKind: 'pending_kind',
  pending: 'pending',
  nextInput: 'next_input',
  integratedCommit: 'integrated_commit',
  unit: 'unit',
};

/** Atualiza campos de controle do item (não o estado, que só muda por `transition`). */
export function updateItem(db: DatabaseSync, itemId: string, update: ItemUpdate): void {
  const entries = Object.entries(update) as [keyof ItemUpdate, unknown][];
  if (entries.length === 0) return;
  const values = entries.map(([key, value]) => {
    if (key === 'escalatedCycle') return value ? 1 : 0;
    if ((key === 'pending' || key === 'nextInput') && value !== null) return JSON.stringify(value);
    return value as string | number | null;
  });
  db.prepare(
    `UPDATE items SET ${entries.map(([key]) => `${UPDATE_COLUMNS[key]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
  ).run(...values, new Date().toISOString(), itemId);
}

export function listItems(db: DatabaseSync, projectId: string): Item[] {
  const rows = db
    .prepare('SELECT * FROM items WHERE project_id = ? ORDER BY position, number')
    .all(projectId) as unknown as ItemRow[];
  return rows.map(fromRow);
}

export function getItem(db: DatabaseSync, projectId: string, number: number): Item | undefined {
  const row = db.prepare('SELECT * FROM items WHERE project_id = ? AND number = ?').get(projectId, number) as
    | ItemRow
    | undefined;
  return row ? fromRow(row) : undefined;
}

export function getItemById(db: DatabaseSync, itemId: string): Item {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId) as ItemRow | undefined;
  if (!row) throw new Error(`item ${itemId} não existe`);
  return fromRow(row);
}

/** Item que já entrou em planejamento alguma vez: seu conteúdo fica congelado. */
export function isStarted(db: DatabaseSync, itemId: string): boolean {
  return (
    db.prepare("SELECT 1 FROM item_transitions WHERE item_id = ? AND to_state = 'planning' LIMIT 1").get(itemId) !==
    undefined
  );
}

/**
 * Hash do conteúdo do item. `referencesDigest` é o hash dos arquivos referenciados
 * (`referencesDigest` de `references.ts`), calculado por quem tem a raiz do projeto.
 */
export function contentHash(fields: ItemFields, referencesDigest?: string, excerpt?: SpecExcerpt | null): string {
  const content: unknown[] = [fields.title, fields.intent, fields.criteria, fields.dependsOn, fields.restrictions];
  // Campos do refinamento só entram quando usados: o hash dos itens anteriores não muda.
  const { outOfScope, decisions, criticalConcepts } = fields;
  if (outOfScope.length + decisions.length + criticalConcepts.length > 0) content.push({ outOfScope, decisions, criticalConcepts });
  // Idem para as referências, que levam junto o conteúdo dos arquivos.
  const references = fields.references ?? [];
  if (references.length > 0) content.push({ references, files: referencesDigest ?? null });
  // Tarefa de spec: o trecho citado entra no hash; spec alterada muda a tarefa não iniciada.
  if (fields.spec) content.push({ spec: fields.spec, rules: fields.rules ?? [], excerpt: excerpt ? excerptDigest(excerpt) : null });
  if (fields.kind) content.push({ kind: fields.kind });
  if (fields.ruleChanges && fields.ruleChanges.length > 0) content.push({ ruleChanges: fields.ruleChanges });
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

export interface TransitionOptions {
  runId?: string;
  /** Regenera o quadro depois da transição (padrão). `false` quando o chamador o fará. */
  board?: boolean;
}

/**
 * Muda o estado do item e grava a auditoria na mesma transação; depois regenera o quadro.
 * Transição fora da tabela lança `TransitionError` sem gravar nada.
 */
export function transition(
  db: DatabaseSync,
  project: Project,
  itemId: string,
  to: ItemStatus,
  reason: string | null,
  options: TransitionOptions = {},
): void {
  // SAVEPOINT em vez de BEGIN: funciona também dentro de uma transação do chamador.
  db.exec('SAVEPOINT item_transition');
  try {
    const row = db.prepare('SELECT status, number FROM items WHERE id = ?').get(itemId) as
      | { status: ItemStatus; number: number }
      | undefined;
    if (!row) throw new TransitionError(`item ${itemId} não existe`);
    if (!TRANSITIONS[row.status]?.includes(to)) {
      throw new TransitionError(`transição inválida para o item #${row.number}: ${row.status} → ${to}`);
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE items SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').run(
      to,
      reason,
      now,
      itemId,
    );
    db.prepare(
      'INSERT INTO item_transitions (item_id, from_state, to_state, reason, run_id, at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(itemId, row.status, to, reason, options.runId ?? null, now);
    db.exec('RELEASE item_transition');
  } catch (error) {
    db.exec('ROLLBACK TO item_transition');
    db.exec('RELEASE item_transition');
    throw error;
  }
  if (options.board !== false) refreshBoard(db, project);
}

export function itemCost(db: DatabaseSync, itemId: string): number {
  const row = db.prepare('SELECT coalesce(sum(cost_usd), 0) AS total FROM runs WHERE item_id = ?').get(itemId) as {
    total: number;
  };
  return row.total;
}

/**
 * Números dos itens que satisfazem dependências: `done` e, com integração, os já integrados
 * (`awaiting_merge` com `integrated_commit`).
 */
export function satisfiedNumbers(items: Item[], integration: boolean): Set<number> {
  return new Set(
    items
      .filter((item) => item.status === 'done' || (integration && item.status === 'awaiting_merge' && item.integratedCommit))
      .map((item) => item.number),
  );
}

/**
 * Motivo pelo qual o item não está pronto para planejar, ou `null` quando está.
 * `referenceProblem`: a primeira referência que não confere (`references.ts`).
 */
/** Critério de reprodução do bug: o primeiro, gravado pelo refinamento. */
export const REPRODUCTION = /^reprodu[çc][ãa]o:/i;

export function notReadyReason(
  item: Item,
  satisfied: Set<number>,
  referenceProblem: string | null = null,
  specProblem: string | null = null,
): string | null {
  // Na tarefa de spec, a intenção vem da história.
  if (!item.title || (!item.intent && !item.spec)) return 'sem intenção';
  if (specProblem) return specProblem;
  // Item declarado crítico: os critérios vêm do humano (escritos ou aceitos no refinamento).
  if (item.criticalConcepts.length > 0 && item.criteria.length === 0) {
    return `regra crítica sem critérios: escreva os critérios ou rode \`mabel refinar ${item.number}\``;
  }
  if (item.kind === 'bug' && !item.criteria.some((criterion) => REPRODUCTION.test(criterion))) {
    return `bug sem critério de reprodução: escreva "Reprodução: passos → esperado (hoje: obtido)" ou rode \`mabel refinar ${item.number}\``;
  }
  if (referenceProblem) return referenceProblem;
  if (!item.dependsOn.every((dep) => satisfied.has(dep))) return 'dependências pendentes';
  return null;
}

export function boardItems(db: DatabaseSync, project: Pick<Project, 'id' | 'config'>): BoardItem[] {
  const items = listItems(db, project.id);
  const done = satisfiedNumbers(items, project.config.integracao !== null);
  return items.map((item) => ({
    number: item.number,
    title: item.title,
    status: item.status,
    statusReason: item.statusReason,
    attempts: item.attempts,
    branch: item.branch,
    integrated: item.integratedCommit !== null,
    costUsd: itemCost(db, item.id),
    pendingDeps: item.dependsOn.filter((dep) => !done.has(dep)),
  }));
}

/** Regenera o `quadro.md` do projeto a partir do banco. */
export function refreshBoard(db: DatabaseSync, project: Project, now = new Date()): void {
  writeBoardFile(project.root, renderBoard(project.name, boardItems(db, project), latestReadings(db), now));
}

// Sincronização --------------------------------------------------------------------------

export interface SyncResult {
  warnings: string[];
  /** Ids atribuídos a itens que não tinham `id:` no arquivo. */
  assigned: number[];
}

const FORMAT_ERROR_PREFIX = 'formato: ';

export function backlogPath(project: Project): string {
  return mabelPath(project.root, 'backlog.md');
}

/**
 * Acrescenta uma decisão ao campo `Decisões:` do item no backlog e no banco, com o hash
 * recalculado: a decisão do humano não conta como alteração do item iniciado.
 */
export function appendItemDecision(db: DatabaseSync, project: Project, item: Item, decision: string): boolean {
  const path = backlogPath(project);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const entry = parseBacklog(text).find((parsed) => parsed.number === item.number);
  if (!entry) return false;
  const decisions = [...entry.decisions, decision];
  writeFileSync(path, replaceItemBlock(text, entry, renderItemBlock({ ...entry, decisions, number: item.number })));
  // O hash passa a ser o do backlog com a decisão: o `run` não a toma por edição do humano.
  const references = entry.references.length > 0 ? referencesDigest(project.root, entry.references) : undefined;
  item.decisions = [...item.decisions, decision];
  item.contentHash = contentHash({ ...entry, decisions }, references, entryExcerpt(project, entry));
  db.prepare('UPDATE items SET decisions = ?, content_hash = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(item.decisions),
    item.contentHash,
    new Date().toISOString(),
    item.id,
  );
  return true;
}

/**
 * A decisão que a própria tarefa provocou mudou a spec: o hash do item passa a ser o do
 * conteúdo atual, e o `run` não a toma por edição do humano. O conteúdo segue congelado.
 */
export function acknowledgeSpecChange(db: DatabaseSync, project: Project, item: Item): void {
  let text: string;
  try {
    text = readFileSync(backlogPath(project), 'utf8');
  } catch {
    return;
  }
  const entry = parseBacklog(text).find((parsed) => parsed.number === item.number);
  if (!entry) return;
  const references = entry.references.length > 0 ? referencesDigest(project.root, entry.references) : undefined;
  item.contentHash = contentHash(entry, references, entryExcerpt(project, entry));
  db.prepare('UPDATE items SET content_hash = ?, updated_at = ? WHERE id = ?').run(item.contentHash, new Date().toISOString(), item.id);
}

/** Trecho da spec que a entrada do backlog cita, lido do disco; `null` sem spec ou sem arquivo. */
function entryExcerpt(project: Project, entry: { spec?: string | null; rules?: string[] }): SpecExcerpt | null {
  if (!entry.spec) return null;
  const spec = readSpec(project.root, entry.spec);
  return spec ? specExcerpt(entry.spec, spec, entry.rules ?? []) : null;
}

/** Próximo id livre, considerando o arquivo e o banco (inclusive itens cancelados). */
export function nextNumber(db: DatabaseSync, projectId: string, numbersInFile: number[]): number {
  const row = db.prepare('SELECT coalesce(max(number), 0) AS max FROM items WHERE project_id = ?').get(projectId) as {
    max: number;
  };
  return Math.max(row.max, ...numbersInFile, 0) + 1;
}

/**
 * Reconcilia o `backlog.md` com o banco: atribui ids, cria e atualiza itens, cancela os
 * removidos e move entre `backlog` e `ready`. Erros de formato bloqueiam só o item.
 */
export function syncBacklog(db: DatabaseSync, project: Project): SyncResult {
  const warnings: string[] = [];
  const path = backlogPath(project);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { warnings: [`${path} não encontrado.`], assigned: [] };
  }

  // 1. Ids para itens novos, gravados no arquivo sem tocar no resto.
  let parsed = parseBacklog(text);
  const numbers = parsed.flatMap((item) => (item.number === undefined ? [] : [item.number]));
  let next = nextNumber(db, project.id, numbers);
  const assignments = parsed
    .filter((item) => item.number === undefined && item.invalidId === undefined)
    .map((item) => ({ headingEnd: item.headingEnd, number: next++ }));
  if (assignments.length > 0) {
    text = insertIds(text, assignments);
    writeFileSync(path, text);
    parsed = parseBacklog(text);
  }

  const known = listItems(db, project.id);
  validateBacklog(
    parsed,
    known.filter((item) => item.status !== 'cancelled').map((item) => item.number),
  );

  const move = (item: Item, to: ItemStatus, reason: string | null) => {
    if (item.status === to) {
      if (item.statusReason !== reason) {
        db.prepare('UPDATE items SET status_reason = ?, updated_at = ? WHERE id = ?').run(
          reason,
          new Date().toISOString(),
          item.id,
        );
      }
      return;
    }
    transition(db, project, item.id, to, reason, { board: false });
    item.status = to;
  };

  // 2. Itens do arquivo.
  const now = new Date().toISOString();
  const seen = new Set<number>();
  for (const entry of parsed) {
    if (entry.number === undefined) {
      warnings.push(`Item "${entry.title}" ignorado: id inválido "${entry.invalidId}".`);
      continue;
    }
    if (seen.has(entry.number)) continue; // duplicata: o erro já está no primeiro
    seen.add(entry.number);

    const fields: ItemFields = {
      title: entry.title,
      intent: entry.intent,
      criteria: entry.criteria,
      dependsOn: entry.dependsOn,
      restrictions: entry.restrictions,
      outOfScope: entry.outOfScope,
      decisions: entry.decisions,
      criticalConcepts: entry.criticalConcepts,
      references: entry.references,
      spec: entry.spec,
      rules: entry.rules,
      kind: entry.kind,
      ruleChanges: entry.ruleChanges,
    };
    const excerpt = entryExcerpt(project, entry);
    const hash = contentHash(fields, entry.references.length > 0 ? referencesDigest(project.root, entry.references) : undefined, excerpt);
    let item = getItem(db, project.id, entry.number);
    if (!item) {
      db.prepare(
        `INSERT INTO items (id, project_id, number, position, title, intent, criteria, depends_on, restrictions,
           out_of_scope, decisions, critical_concepts, item_references, spec, spec_rules, spec_context, kind, rule_changes,
           content_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?)`,
      ).run(
        randomUUID(),
        project.id,
        entry.number,
        entry.position,
        fields.title,
        fields.intent,
        JSON.stringify(fields.criteria),
        JSON.stringify(fields.dependsOn),
        fields.restrictions,
        JSON.stringify(fields.outOfScope),
        JSON.stringify(fields.decisions),
        JSON.stringify(fields.criticalConcepts),
        JSON.stringify(entry.references),
        entry.spec,
        JSON.stringify(entry.rules),
        excerpt ? JSON.stringify(excerpt) : null,
        entry.kind,
        JSON.stringify(entry.ruleChanges),
        hash,
        now,
        now,
      );
      item = getItem(db, project.id, entry.number) as Item;
    } else {
      db.prepare('UPDATE items SET position = ? WHERE id = ?').run(entry.position, item.id);
    }

    if (item.status === 'cancelled') {
      warnings.push(`#${item.number} está cancelado; remova-o do backlog ou apague a linha \`id:\` para recriá-lo.`);
      continue;
    }
    const started = isStarted(db, item.id);
    if (hash !== item.contentHash) {
      if (started) {
        warnings.push(`#${item.number} mudou no backlog depois de iniciado; segue com o conteúdo do início.`);
      } else {
        db.prepare(
          `UPDATE items SET title = ?, intent = ?, criteria = ?, depends_on = ?, restrictions = ?,
             out_of_scope = ?, decisions = ?, critical_concepts = ?, item_references = ?, spec = ?, spec_rules = ?,
             spec_context = ?, kind = ?, rule_changes = ?, content_hash = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          fields.title,
          fields.intent,
          JSON.stringify(fields.criteria),
          JSON.stringify(fields.dependsOn),
          fields.restrictions,
          JSON.stringify(fields.outOfScope),
          JSON.stringify(fields.decisions),
          JSON.stringify(fields.criticalConcepts),
          JSON.stringify(entry.references),
          entry.spec,
          JSON.stringify(entry.rules),
          excerpt ? JSON.stringify(excerpt) : null,
          entry.kind,
          JSON.stringify(entry.ruleChanges),
          hash,
          now,
          item.id,
        );
        Object.assign(item, fields, { contentHash: hash, specContext: excerpt });
      }
    }

    if (entry.errors.length > 0) {
      const reason = `${FORMAT_ERROR_PREFIX}${entry.errors.join('; ')}`;
      if (started) warnings.push(`#${item.number}: ${entry.errors.join('; ')}`);
      else if (item.status === 'backlog' || item.status === 'ready' || item.status === 'blocked') {
        move(item, 'blocked', reason);
      }
    } else if (item.status === 'blocked' && item.statusReason?.startsWith(FORMAT_ERROR_PREFIX)) {
      move(item, 'backlog', 'formato corrigido');
    }
  }

  // 3. Itens que saíram do arquivo.
  for (const item of known) {
    if (seen.has(item.number) || item.status === 'cancelled') continue;
    if (isStarted(db, item.id)) {
      if (item.status !== 'done') warnings.push(`#${item.number} saiu do backlog, mas já foi iniciado; segue na fila.`);
    } else {
      move(item, 'cancelled', 'removido do backlog');
    }
  }

  // 4. backlog ⇄ ready conforme título, intenção, critérios de item crítico e dependências.
  const items = listItems(db, project.id);
  const done = satisfiedNumbers(items, project.config.integracao !== null);
  for (const item of items) {
    if (item.status !== 'backlog' && item.status !== 'ready') continue;
    const references = item.references.length > 0 ? referenceProblem(project.root, item.references) : null;
    const spec = item.spec ? specProblem(db, project, item.spec, item.rules) : null;
    const missing = notReadyReason(item, done, references, spec);
    if (item.status === 'backlog' && !missing) move(item, 'ready', null);
    else if (missing) move(item, 'backlog', missing);
  }

  refreshBoard(db, project);
  return { warnings, assigned: assignments.map((assignment) => assignment.number) };
}
