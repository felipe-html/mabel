import type { DatabaseSync } from 'node:sqlite';
import { truncate } from './format.ts';
import { type Item, type ItemStatus, type ItemUpdate, TRANSITIONS, refreshBoard, transition, updateItem } from './items.ts';
import { attemptsSummary } from './pipeline.ts';
import type { Project } from './project.ts';

export class DecisionError extends Error {}

const CLEAR_PENDING: ItemUpdate = { pendingKind: null, pending: null };

/** Por onde a decisão chegou; entra no motivo da transição (`humano: inbox …`). */
export interface DecisionOptions {
  via?: 'inbox';
}

function via(reason: string, options: DecisionOptions): string {
  return options.via ? `${options.via} ${reason}` : reason;
}

function decide(db: DatabaseSync, project: Project, item: Item, to: ItemStatus, reason: string, update: ItemUpdate) {
  db.exec('SAVEPOINT decision');
  try {
    updateItem(db, item.id, { ...CLEAR_PENDING, ...update });
    transition(db, project, item.id, to, `humano: ${reason}`, { board: false });
    db.exec('RELEASE decision');
  } catch (error) {
    db.exec('ROLLBACK TO decision');
    db.exec('RELEASE decision');
    throw error;
  }
  refreshBoard(db, project);
}

/**
 * Orienta um item parado em `needs_human`. O efeito depende do motivo da parada
 * (`pending_kind`); ver a tabela "Motivos de needs_human" do passo 4.
 */
export function respond(
  db: DatabaseSync,
  project: Project,
  item: Item,
  answer: string,
  { replan = false, ...options }: { replan?: boolean } & DecisionOptions = {},
): ItemStatus {
  if (item.status !== 'needs_human' || !item.pendingKind) {
    throw new DecisionError(`#${item.number} não está aguardando resposta (estado: ${item.status}).`);
  }
  const reason = via(`responder${replan ? ' --replanejar' : ''}: ${truncate(answer.replace(/\s+/g, ' '), 200)}`, options);
  const sessionId = item.pending?.sessionId ?? undefined;
  const replanFresh: ItemUpdate = {
    attempts: 0,
    escalatedCycle: false,
    approvedAt: null,
    planRetries: 0,
    nextInput: { answer, previousPlan: true, attemptsSummary: attemptsSummary(db, item.id) || undefined },
  };

  switch (item.pendingKind) {
    case 'question_plan':
    case 'plan_incomplete':
    case 'critical_approval':
      decide(db, project, item, 'planning', reason, {
        approvedAt: null,
        planRetries: 0,
        nextInput: { resumeSessionId: sessionId, answer },
      });
      return 'planning';
    case 'question_execute':
      if (replan) {
        decide(db, project, item, 'planning', reason, replanFresh);
        return 'planning';
      }
      decide(db, project, item, 'executing', reason, {
        nextInput: { resumeSessionId: sessionId, answer, sameAttempt: true },
      });
      return 'executing';
    case 'attempts_exhausted':
      if (replan) {
        decide(db, project, item, 'planning', reason, replanFresh);
        return 'planning';
      }
      decide(db, project, item, 'executing', reason, {
        attempts: 0,
        escalatedCycle: true,
        nextInput: { answer, attemptsSummary: attemptsSummary(db, item.id) || undefined },
      });
      return 'executing';
  }
}

/** Aprova os critérios de um item crítico: vai a `planned` e executa com o plano atual. */
export function approve(db: DatabaseSync, project: Project, item: Item, options: DecisionOptions = {}): void {
  if (item.status !== 'needs_human' || item.pendingKind !== 'critical_approval') {
    throw new DecisionError(`#${item.number} não está aguardando aprovação de critérios (estado: ${item.status}).`);
  }
  decide(db, project, item, 'planned', via('critérios aprovados', options), {
    approvedAt: new Date().toISOString(),
    attempts: 0,
    escalatedCycle: false,
    nextInput: null,
  });
}

export function cancel(db: DatabaseSync, project: Project, item: Item, options: DecisionOptions = {}): void {
  if (!TRANSITIONS[item.status].includes('cancelled')) {
    throw new DecisionError(`#${item.number} não pode ser cancelado no estado ${item.status}.`);
  }
  decide(db, project, item, 'cancelled', via('cancelado', options), { nextInput: null });
}
