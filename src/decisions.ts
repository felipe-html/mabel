import type { DatabaseSync } from 'node:sqlite';
import { truncate } from './format.ts';
import { git, tryGit, withTrailers } from './git.ts';
import { isAncestor, itemTrailers, onTempWorktree, unitOf } from './integration.ts';
import { inSpec, unitBranch } from './worktree.ts';
import {
  type Item,
  type ItemStatus,
  type ItemUpdate,
  TRANSITIONS,
  listItems,
  refreshBoard,
  transition,
  updateItem,
  acknowledgeSpecChange,
  appendItemDecision,
  isStarted,
  FORMAT_ERROR_PREFIX,
  getItemById,
  syncBacklog,
} from './items.ts';
import { attemptsSummary, sameAssumption } from './pipeline.ts';
import { appendSpecDecision } from './specs.ts';
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

const today = () => new Date().toISOString().slice(0, 10);

/** `pergunta → resposta` a partir do texto da inbox (`P1: …\nR1: …`) ou da pergunta única. */
function answerPairs(item: Item, answer: string): string[] {
  const pairs = [...answer.matchAll(/^P(\d+): (.+)\nR\1: ([\s\S]*?)(?=\nP\d+: |$)/gm)].map(
    (m) => `${(m[2] as string).trim()} → ${(m[3] as string).trim().replace(/\s+/g, ' ')}`,
  );
  if (pairs.length > 0) return pairs;
  const questions = item.pending?.questions ?? [];
  const text = answer.trim().replace(/\s+/g, ' ');
  return [questions.length === 1 ? `${(questions[0] as { texto: string }).texto} → ${text}` : text];
}

/**
 * Decisão do humano sobre uma tarefa (inbox, `responder`, aprovação de plano): na tarefa de
 * spec, vai para as `Decisões` da spec, com a origem; no avulso, para as `Decisões:` dele.
 */
export function recordDecisions(db: DatabaseSync, project: Project, item: Item, decisions: string[], origin: string): void {
  for (const decision of decisions) {
    const entry = `${decision} (${origin}, #${item.number}, ${today()})`;
    if (item.spec) appendSpecDecision(project.root, item.spec, entry);
    else appendItemDecision(db, project, item, entry);
  }
  if (item.spec && isStarted(db, item.id)) acknowledgeSpecChange(db, project, item);
}

/**
 * Suposições críticas da parada que o humano respondeu ou aprovou: viram decisão dele e o G7
 * não para de novo nelas, nem depois de um replanejamento.
 */
function confirmAssumptions(item: Item, assumptions = item.pending?.criticalAssumptions ?? []): string[] {
  const confirmed = [...item.confirmedAssumptions];
  for (const assumption of assumptions) {
    if (!confirmed.some((c) => sameAssumption(c, assumption))) confirmed.push(assumption);
  }
  return confirmed;
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
  if (item.pendingKind !== 'attempts_exhausted' && item.pendingKind !== 'environment_block') {
    recordDecisions(db, project, item, answerPairs(item, answer), options.via ?? 'responder');
  }
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
        decide(db, project, item, 'planning', reason, { ...replanFresh, confirmedAssumptions: confirmAssumptions(item) });
        return 'planning';
      }
      decide(db, project, item, 'executing', reason, {
        nextInput: { resumeSessionId: sessionId, answer, sameAttempt: true },
        confirmedAssumptions: confirmAssumptions(item),
      });
      return 'executing';
    case 'environment_block':
      if (replan) {
        decide(db, project, item, 'planning', reason, replanFresh);
        return 'planning';
      }
      // O ambiente mudou: ciclo novo, na mesma sessão, que verifica de novo o que já foi feito.
      decide(db, project, item, 'executing', reason, {
        attempts: 0,
        nextInput: { resumeSessionId: sessionId, answer },
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

/**
 * Aprova os critérios de um item crítico: vai a `planned` e executa com o plano atual. As
 * suposições críticas do plano entram aprovadas junto e não param a execução de novo (G7).
 */
export function approve(db: DatabaseSync, project: Project, item: Item, options: DecisionOptions = {}): void {
  if (item.status !== 'needs_human' || item.pendingKind !== 'critical_approval') {
    throw new DecisionError(`#${item.number} não está aguardando aprovação de critérios (estado: ${item.status}).`);
  }
  recordDecisions(db, project, item, ['Critérios do plano aprovados (regra crítica)'], options.via ?? 'aprovar');
  decide(db, project, item, 'planned', via('critérios aprovados', options), {
    approvedAt: new Date().toISOString(),
    attempts: 0,
    escalatedCycle: false,
    nextInput: null,
    confirmedAssumptions: confirmAssumptions(item, item.pending?.planAssumptions ?? []),
  });
}

export function cancel(db: DatabaseSync, project: Project, item: Item, options: DecisionOptions = {}): void {
  if (!TRANSITIONS[item.status].includes('cancelled')) {
    throw new DecisionError(`#${item.number} não pode ser cancelado no estado ${item.status}.`);
  }
  decide(db, project, item, 'cancelled', via('cancelado', options), { nextInput: null });
}

/** Estados de onde o `mabel retomar` devolve o item à fila. */
export const RESUMABLE: ItemStatus[] = ['failed', 'blocked'];

/**
 * Devolve à fila um item parado em `failed` (vai a `ready`) ou `blocked` (vai a `backlog`,
 * e a `ready` quando o backlog permite). O ciclo recomeça do planejamento, com o motivo da
 * parada e a orientação do humano. Bloqueio por erro de formato no backlog não se retoma:
 * some sozinho quando o backlog é corrigido.
 */
export function resume(db: DatabaseSync, project: Project, item: Item, guidance = ''): ItemStatus {
  if (!RESUMABLE.includes(item.status)) {
    throw new DecisionError(`#${item.number} não está parado por falha ou bloqueio (estado: ${item.status}).`);
  }
  if (item.statusReason?.startsWith(FORMAT_ERROR_PREFIX)) {
    throw new DecisionError(`#${item.number} está bloqueado pelo formato no backlog: ${item.statusReason.slice(FORMAT_ERROR_PREFIX.length)}. Corrija o .mabel/backlog.md; o item volta sozinho.`);
  }
  const why = item.statusReason ?? (item.status === 'failed' ? 'falhou' : 'bloqueado');
  const text = guidance.trim();
  const answer = [`O item parou (${item.status === 'failed' ? 'falha' : 'bloqueio'}): ${why}.`, ...(text ? [`Orientação do humano: ${text}`] : [])].join('\n');
  decide(db, project, item, item.status === 'failed' ? 'ready' : 'backlog', `retomar${text ? `: ${truncate(text.replace(/\s+/g, ' '), 200)}` : ''}`, {
    attempts: 0,
    escalatedCycle: false,
    approvedAt: null,
    planRetries: 0,
    nextInput: { answer, previousPlan: true, attemptsSummary: attemptsSummary(db, item.id) || undefined, resumed: true },
  });
  syncBacklog(db, project);
  return getItemById(db, item.id).status;
}

export interface RejectResult {
  to: 'planning' | 'cancelled';
  /** Itens integrados que dependem do rejeitado: não são revertidos sozinhos. */
  dependents: number[];
}

/** Tarefas concluídas da mesma unidade, na ordem em que entraram na branch dela. */
function unitItems(db: DatabaseSync, project: Project, item: Item): Item[] {
  const branch = unitBranch(item);
  const order = (tryGit(project.root, 'rev-list', '--topo-order', '--reverse', `${project.config.baseBranch}..${branch}`) ?? '').split('\n');
  const position = new Map(order.map((commit, i) => [commit, i]));
  return listItems(db, project.id)
    .filter((other) => other.status === 'awaiting_merge' && other.integratedCommit && position.has(other.integratedCommit) && unitOf(other) === unitOf(item))
    .sort((a, b) => (position.get(a.integratedCommit as string) as number) - (position.get(b.integratedCommit as string) as number));
}

/** Arquivos que o commit de merge mudou em relação ao primeiro pai. */
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
    throw new DecisionError(`#${item.number} não está concluída na branch da unidade (estado: ${item.status}).`);
  }
  if (isAncestor(project.root, commit, project.config.baseBranch)) {
    throw new DecisionError(`#${item.number} já está na ${project.config.baseBranch}; reverta por lá.`);
  }
  if (inSpec(item)) {
    // Dentro da spec, as tarefas se acumulam: o merge da tarefa é revertido na branch da spec.
    const branch = unitBranch(item);
    const reverted = onTempWorktree(
      home,
      project,
      branch,
      (path) =>
        tryGit(path, 'revert', '--no-commit', '-m', '1', commit) !== undefined &&
        tryGit(path, 'commit', '-q', '-m', withTrailers(`mabel: rejeita #${item.number} ${item.title}`, itemTrailers(item))) !== undefined,
      ['revert', '--abort'],
    );
    if (reverted.kind === 'conflict') {
      const touched = new Set(integratedFiles(project.root, commit));
      const later = unitItems(db, project, item);
      const blockers = later
        .slice(later.findIndex((other) => other.id === item.id) + 1)
        .filter((other) => integratedFiles(project.root, other.integratedCommit as string).some((file) => touched.has(file)))
        .map((other) => `#${other.number}`);
      throw new DecisionError(
        `Não foi possível reverter #${item.number}: conflito em ${reverted.files.join(', ')}.` +
          (blockers.length > 0 ? ` Rejeite antes ${blockers.join(', ')}, concluídas depois dela nos mesmos arquivos.` : '') +
          ` A ${branch} não mudou.`,
      );
    }
  } else {
    // Avulso: a branch volta ao commit da base de onde nasceu; o replanejamento a refaz.
    const branch = unitBranch(item);
    const start = git(project.root, 'merge-base', project.config.baseBranch, branch);
    git(project.root, 'update-ref', `refs/heads/${branch}`, start);
    if (cancelItem) tryGit(project.root, 'branch', '-D', branch);
  }
  // A integração não precisa de revert: o próximo `run` a refaz a partir da base.

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
