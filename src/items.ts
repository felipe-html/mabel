import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { latestReadings } from './balance.ts';
import { type ItemFields, insertIds, parseBacklog, validateBacklog } from './backlog.ts';
import { type BoardItem, renderBoard, writeBoardFile } from './board.ts';
import { type Project, mabelPath } from './project.ts';

export const ITEM_STATES = [
  'backlog',
  'ready',
  'planning',
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
  planning: ['executing', 'needs_human', 'failed', 'blocked'],
  executing: ['verifying', 'needs_human', 'failed', 'blocked'],
  verifying: ['reviewing', 'executing', 'needs_human', 'failed'],
  reviewing: ['awaiting_merge', 'executing', 'needs_human', 'failed'],
  awaiting_merge: ['done', 'executing'],
  needs_human: ['planning', 'executing', 'cancelled'],
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
  content_hash: string;
  status: ItemStatus;
  status_reason: string | null;
  attempts: number;
  branch: string | null;
  worktree: string | null;
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
    contentHash: row.content_hash,
    status: row.status,
    statusReason: row.status_reason,
    attempts: row.attempts,
    branch: row.branch,
    worktree: row.worktree,
  };
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

export function contentHash(fields: ItemFields): string {
  const content = [fields.title, fields.intent, fields.criteria, fields.dependsOn, fields.restrictions];
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
  db.exec('BEGIN IMMEDIATE');
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
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
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

export function boardItems(db: DatabaseSync, projectId: string): BoardItem[] {
  const items = listItems(db, projectId);
  const done = new Set(items.filter((item) => item.status === 'done').map((item) => item.number));
  return items.map((item) => ({
    number: item.number,
    title: item.title,
    status: item.status,
    statusReason: item.statusReason,
    attempts: item.attempts,
    branch: item.branch,
    costUsd: itemCost(db, item.id),
    pendingDeps: item.dependsOn.filter((dep) => !done.has(dep)),
  }));
}

/** Regenera o `quadro.md` do projeto a partir do banco. */
export function refreshBoard(db: DatabaseSync, project: Project, now = new Date()): void {
  writeBoardFile(project.root, renderBoard(project.name, boardItems(db, project.id), latestReadings(db), now));
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
    };
    const hash = contentHash(fields);
    let item = getItem(db, project.id, entry.number);
    if (!item) {
      db.prepare(
        `INSERT INTO items (id, project_id, number, position, title, intent, criteria, depends_on, restrictions,
           content_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?)`,
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
             content_hash = ?, updated_at = ? WHERE id = ?`,
        ).run(
          fields.title,
          fields.intent,
          JSON.stringify(fields.criteria),
          JSON.stringify(fields.dependsOn),
          fields.restrictions,
          hash,
          now,
          item.id,
        );
        Object.assign(item, fields, { contentHash: hash });
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

  // 4. backlog ⇄ ready conforme título, intenção e dependências.
  const items = listItems(db, project.id);
  const done = new Set(items.filter((item) => item.status === 'done').map((item) => item.number));
  for (const item of items) {
    const ready = Boolean(item.title && item.intent) && item.dependsOn.every((dep) => done.has(dep));
    if (item.status === 'backlog' && ready) move(item, 'ready', null);
    else if (item.status === 'ready' && !ready) {
      move(item, 'backlog', item.intent ? 'dependências pendentes' : 'sem intenção');
    }
  }

  refreshBoard(db, project);
  return { warnings, assigned: assignments.map((assignment) => assignment.number) };
}
