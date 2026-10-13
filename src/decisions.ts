import type { DatabaseSync } from 'node:sqlite';
import { truncate } from './format.ts';
import { tryGit } from './git.ts';
import { integratedItems, isAncestor, onTempWorktree } from './integration.ts';
import {
  type Item,
  type ItemStatus,
  type ItemUpdate,
  TRANSITIONS,
  listItems,
  refreshBoard,
  transition,
  updateItem,
} from './items.ts';
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
    case 'integration_conflict': {
      if (replan) {
        decide(db, project, item, 'planning', reason, replanFresh);
        return 'planning';
      }
      // Sessão nova: o Mabel refaz o merge da origem e o executor resolve os conflitos.
      const files = (item.pending?.files ?? []).map((file) => `- ${file}`).join('\n');
      decide(db, project, item, 'executing', reason, {
        attempts: 0,
        nextInput: {
          answer,
          mergeOrigin: true,
          failure: `O merge da branch de integração no item tem conflitos. Resolva-os nos arquivos marcados, mantendo o que já foi integrado e o objetivo do item:\n${files}`,
        },
      });
      return 'executing';
    }
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

export interface RejectResult {
  to: 'planning' | 'cancelled';
  /** Itens integrados que dependem do rejeitado: não são revertidos sozinhos. */
  dependents: number[];
}

/** Arquivos que o commit de integração mudou em relação à integração anterior. */
function integratedFiles(root: string, commit: string): string[] {
  return (tryGit(root, 'diff', '--name-only', `${commit}^1`, commit) ?? '').split('\n').filter(Boolean);
}

/**
 * Rejeita um item integrado: reverte o merge dele na integração e o leva a replanejar com o
 * motivo (ou o cancela). Revert com conflito não muda nada e aponta os itens que o impedem.
 */
export function reject(
  db: DatabaseSync,
  home: string,
  project: Project,
  item: Item,
  reason: string,
  { cancel: cancelItem = false }: { cancel?: boolean } = {},
): RejectResult {
  const integration = project.config.integracao;
  const commit = item.integratedCommit;
  if (!integration || item.status !== 'awaiting_merge' || !commit) {
    throw new DecisionError(`#${item.number} não está na integração (estado: ${item.status}).`);
  }
  if (isAncestor(project.root, commit, project.config.baseBranch)) {
    throw new DecisionError(`#${item.number} já está na ${project.config.baseBranch}; reverta por lá.`);
  }
  const reverted = onTempWorktree(
    home,
    project,
    integration,
    (path) => tryGit(path, 'revert', '--no-edit', '-m', '1', commit) !== undefined,
    ['revert', '--abort'],
  );
  if (reverted.kind === 'conflict') {
    const touched = new Set(integratedFiles(project.root, commit));
    const later = integratedItems(db, project);
    const blockers = later
      .slice(later.findIndex((other) => other.id === item.id) + 1)
      .filter((other) => integratedFiles(project.root, other.integratedCommit as string).some((file) => touched.has(file)))
      .map((other) => `#${other.number}`);
    throw new DecisionError(
      `Não foi possível reverter #${item.number}: conflito em ${reverted.files.join(', ')}.` +
        (blockers.length > 0 ? ` Rejeite antes ${blockers.join(', ')}, integrados depois dele nos mesmos arquivos.` : '') +
        ' A integração não mudou.',
    );
  }

  const text = `rejeitado — ${truncate(reason.replace(/\s+/g, ' '), 200)}`;
  const update: ItemUpdate = { integratedCommit: null };
  if (cancelItem) decide(db, project, item, 'cancelled', text, { ...update, nextInput: null });
  else {
    decide(db, project, item, 'planning', text, {
      ...update,
      attempts: 0,
      escalatedCycle: false,
      approvedAt: null,
      planRetries: 0,
      nextInput: {
        answer: `O humano rejeitou a entrega anterior deste item: ${reason}`,
        previousPlan: true,
        attemptsSummary: attemptsSummary(db, item.id) || undefined,
      },
    });
  }
  const dependents = listItems(db, project.id)
    .filter((other) => other.status === 'awaiting_merge' && other.integratedCommit && other.dependsOn.includes(item.number))
    .map((other) => other.number);
  return { to: cancelItem ? 'cancelled' : 'planning', dependents };
}
