import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { globsOverlap } from './glob.ts';
import {
  type Item,
  type ItemStatus,
  type NextInput,
  type Pending,
  type PendingKind,
  getItemById,
  transition,
  updateItem,
} from './items.ts';
import { type CriticalRules, type Project, type ProjectConfig, readCriticalRules } from './project.ts';
import { type RunHandle, type RunObserver, type RunOutcome, type RunStage, isUsageLimit } from './runner.ts';
import type { Assumption, ExecuteOutput, PlanOutput, Question, ReviewOutput, ScopeRequest } from './schemas/stages.ts';
import {
  type StageContext,
  itemDir,
  readArtifact,
  runExecute,
  runPlan,
  runReview,
  writeArtifact,
  writePlan,
} from './stages.ts';
import { git, tryGit } from './git.ts';
import { integrateItem, mergeInProgress, mergeOrigin, setIntegrated } from './integration.ts';
import { bringDependencies, integrateUnit } from './units.ts';
import { projectContext } from './hermetic.ts';
import { foundTests, proofDetail, runProof } from './proof.ts';
import { scopeViolation } from './scope.ts';
import { type PreparedWorktree, commitAll, commitMessage, itemOrigin, prepareWorktree, removeWorktree, shell, unitBranch } from './worktree.ts';

export interface PipelineEnv {
  db: DatabaseSync;
  home: string;
  project: Project;
  /** Chamado antes de cada etapa com agente; `false` pausa o item (política de saldo). */
  beforeAgentStage?: (stage: RunStage, item: Item) => Promise<boolean>;
  observer?: RunObserver;
  onStart?: (handle: RunHandle) => void;
  /** Uma linha por transição, para a saída ao vivo. */
  log?: (line: string) => void;
}

export type AdvanceResult =
  | { kind: 'stopped'; status: ItemStatus }
  | { kind: 'interrupted' }
  | { kind: 'usage_limit' }
  /** `reason`: motivo da pausa decidida pelo pipeline (a da política de saldo fica com o `run`). */
  | { kind: 'paused'; reason?: string };

/** Escada de escalonamento de modelo. */
const MODEL_LADDER = ['haiku', 'sonnet', 'opus'];

export function escalate(model: string): string {
  const index = MODEL_LADDER.findIndex((name) => model.toLowerCase().includes(name));
  if (index < 0) return 'opus';
  return MODEL_LADDER[Math.min(index + 1, MODEL_LADDER.length - 1)] as string;
}

// Gate de início (G2) --------------------------------------------------------------------

export type StartVerdict =
  | { kind: 'pass' }
  | { kind: 'questions'; questions: Question[] }
  | { kind: 'incomplete'; reason: string }
  | { kind: 'critical'; reasons: string[] };

/**
 * Motivos que tornam o item crítico: escopo em caminho crítico, conceitos (os do plano e os
 * declarados no backlog), suposições.
 */
export function criticalReasons(plan: PlanOutput, rules: CriticalRules, declared: string[] = []): string[] {
  const reasons: string[] = [];
  for (const scope of plan.escopo) {
    for (const path of rules.paths) {
      if (globsOverlap(scope, path)) reasons.push(`escopo \`${scope}\` toca o caminho crítico \`${path}\``);
    }
  }
  const concepts = [...plan.conceitosCriticos];
  for (const concept of declared) {
    if (!concepts.some((other) => other.trim().toLowerCase() === concept.trim().toLowerCase())) concepts.push(concept);
  }
  for (const concept of concepts) reasons.push(`conceito crítico: ${concept}`);
  for (const assumption of plan.suposicoes) {
    if (assumption.regraCritica) reasons.push(`suposição sobre regra crítica: ${assumption.texto}`);
  }
  return reasons;
}

export function startGate(
  plan: PlanOutput | undefined,
  invalid: string | undefined,
  rules: CriticalRules,
  approved: boolean,
  declared: string[] = [],
  bug = false,
): StartVerdict {
  if (!plan) return { kind: 'incomplete', reason: invalid ?? 'saída estruturada ausente' };
  if (plan.perguntas.length > 0) return { kind: 'questions', questions: plan.perguntas };
  if (plan.criterios.length === 0) return { kind: 'incomplete', reason: 'plano sem critérios de aceite' };
  const unverified = plan.criterios.filter((c) => c.verificacao !== 'teste' && c.verificacao !== 'humano');
  if (unverified.length > 0) {
    return { kind: 'incomplete', reason: `critérios sem verificação: ${unverified.map((c) => c.id).join(', ')}` };
  }
  if (plan.escopo.length === 0) return { kind: 'incomplete', reason: 'plano sem escopo de arquivos' };
  // Bug: a reprodução é provada pelo teste vermelho na base (comportamento novo).
  if (bug && !plan.criterios.some((c) => /reprodu[çc][ãa]o/i.test(c.texto) && c.verificacao === 'teste' && c.comportamento === 'novo')) {
    return { kind: 'incomplete', reason: 'bug sem critério de reprodução com teste de comportamento novo (vermelho na base)' };
  }
  // O gate de escopo reprova toda escrita no `.mabel/` e no `.git/`: o plano que os inclui
  // reprovaria na execução, por mais certo que o código estivesse.
  const reserved = plan.escopo.filter((glob) => /^(\.\/)?\.(mabel|git)(\/|$)/.test(glob));
  if (reserved.length > 0) {
    return {
      kind: 'incomplete',
      reason: `escopo em arquivo do Mabel ou do git (${reserved.map((glob) => `\`${glob}\``).join(', ')}): o config do Mabel é do humano; registre a mudança como recomendação em suposicoes`,
    };
  }
  const reasons = criticalReasons(plan, rules, declared);
  if (reasons.length > 0 && !approved) return { kind: 'critical', reasons };
  return { kind: 'pass' };
}

// Gate de verificação (G3) ---------------------------------------------------------------

/** Critérios `teste` sem teste declarado cujo arquivo existe no worktree e contém o nome. */
export function criteriaWithoutTests(plan: PlanOutput, execution: ExecuteOutput, worktree: string): string[] {
  const missing: string[] = [];
  for (const criterion of plan.criterios) {
    if (criterion.verificacao !== 'teste') continue;
    const declared = execution.criterios.find((c) => c.id === criterion.id)?.testes ?? [];
    if (foundTests(worktree, declared).length === 0) {
      missing.push(
        declared.length === 0
          ? `${criterion.id}: nenhum teste declarado`
          : `${criterion.id}: nenhum dos testes declarados foi encontrado (${declared.map((t) => `${t.arquivo} › ${t.nome}`).join('; ')})`,
      );
    }
  }
  return missing;
}

// Veredito da revisão (G3) -------------------------------------------------------------

export interface ReviewVerdict {
  approved: boolean;
  /** Motivos da reprovação ou critérios ignorados; `null` quando não há nada a registrar. */
  detail: string | null;
}

/**
 * Parecer calculado a partir dos critérios avaliados e dos problemas apontados: aprova só
 * com todo critério do plano avaliado, os de teste atendidos e nenhum problema bloqueante.
 * Critério de validação humana não reprova por falta de confirmação: ela vem do humano
 * no `awaiting_merge` (G3); o que impede a validação o revisor aponta como bloqueante.
 * Um `aprovado` gravado por pareceres antigos é ignorado.
 */
export function reviewVerdict(plan: PlanOutput, review: ReviewOutput): ReviewVerdict {
  const planned = new Set(plan.criterios.map((c) => c.id));
  const human = new Set(plan.criterios.filter((c) => c.verificacao === 'humano').map((c) => c.id));
  const evaluated = new Set(review.criterios.map((c) => c.id));
  const unmet = review.criterios.filter((c) => planned.has(c.id) && !c.atendido);
  const reasons = [
    ...plan.criterios.filter((c) => !evaluated.has(c.id)).map((c) => `revisão não avaliou o critério ${c.id}`),
    ...unmet.filter((c) => !human.has(c.id)).map((c) => `critério ${c.id} não atendido: ${c.evidencia}`),
    ...review.problemas
      .filter((p) => p.gravidade === 'bloqueante')
      .map((p) => `bloqueante: ${p.descricao}${p.arquivo ? ` (${p.arquivo})` : ''}`),
  ];
  const unknown = review.criterios.filter((c) => !planned.has(c.id)).map((c) => c.id);
  const ignored = unknown.length > 0 ? [`critérios fora do plano ignorados: ${unknown.join(', ')}`] : [];
  const approved = reasons.length === 0;
  const minor = approved
    ? []
    : review.problemas.filter((p) => p.gravidade === 'menor').map((p) => `menor: ${p.descricao}${p.arquivo ? ` (${p.arquivo})` : ''}`);
  const pending = unmet.filter((c) => human.has(c.id)).map((c) => `critério ${c.id} fica para a validação humana: ${c.evidencia}`);
  const detail = [...reasons, ...minor, ...pending, ...ignored].join('; ');
  return { approved, detail: detail || null };
}

// Autonomia ------------------------------------------------------------------------------

/**
 * Suposições que respondem às perguntas pela sugestão do agente, ou `undefined` quando o
 * item precisa parar: autonomia desligada, alguma pergunta crítica ou alguma sem sugestão.
 */
export function autonomousAnswers(config: ProjectConfig, questions: Question[]): Assumption[] | undefined {
  if (questions.length === 0 || config.autonomia !== 'sugestoes') return undefined;
  if (questions.some((q) => q.regraCritica || !q.sugestao.trim())) return undefined;
  return questions.map((q) => ({ texto: `P: ${q.texto} → R: ${q.sugestao} (autônomo)`, regraCritica: false }));
}

/** Pares `pergunta → sugestão` gravados no gate `autonomy`. */
export const AUTONOMY_SEPARATOR = ' | ';

function recordAutonomy(env: PipelineEnv, item: Item, attempt: number, questions: Question[]): void {
  const pairs = questions.map((q) => `${q.texto} → ${q.sugestao}`).join(AUTONOMY_SEPARATOR);
  recordGate(env.db, item.id, attempt, 'autonomy', true, pairs);
  const count = questions.length === 1 ? '1 pergunta respondida' : `${questions.length} perguntas respondidas`;
  env.log?.(`#${item.number} ${item.title}: ${count} pela sugestão (autônomo)`);
}

/** Decisões autônomas gravadas no gate `autonomy`, uma linha `pergunta → sugestão` cada. */
export function autonomousDecisions(
  db: DatabaseSync,
  filter: { itemId: string } | { projectId: string; since: Date },
): { number: number; decision: string }[] {
  const rows = (
    'itemId' in filter
      ? db
          .prepare(
            `SELECT i.number, g.detail FROM gate_results g JOIN items i ON i.id = g.item_id
             WHERE g.gate = 'autonomy' AND g.item_id = ? ORDER BY g.id`,
          )
          .all(filter.itemId)
      : db
          .prepare(
            `SELECT i.number, g.detail FROM gate_results g JOIN items i ON i.id = g.item_id
             WHERE g.gate = 'autonomy' AND i.project_id = ? AND g.at >= ? ORDER BY g.id`,
          )
          .all(filter.projectId, filter.since.toISOString())
  ) as { number: number; detail: string | null }[];
  return rows.flatMap((row) =>
    (row.detail ?? '').split(AUTONOMY_SEPARATOR).filter(Boolean).map((decision) => ({ number: row.number, decision })),
  );
}

// Registro -------------------------------------------------------------------------------

export function recordGate(
  db: DatabaseSync,
  itemId: string,
  attempt: number,
  gate: string,
  passed: boolean,
  detail: string | null,
  logPath: string | null = null,
): void {
  db.prepare(
    'INSERT INTO gate_results (item_id, attempt, gate, passed, detail, log_path, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(itemId, attempt, gate, passed ? 1 : 0, detail, logPath, new Date().toISOString());
}

/** Resumo das tentativas reprovadas do item, para o prompt e para o humano. */
export function attemptsSummary(db: DatabaseSync, itemId: string): string {
  const rows = db
    .prepare(
      `SELECT attempt, gate, detail FROM gate_results
       WHERE item_id = ? AND attempt > 0 AND passed = 0 ORDER BY id`,
    )
    .all(itemId) as { attempt: number; gate: string; detail: string | null }[];
  return rows
    .map((row) => `- Tentativa ${row.attempt}: ${row.gate} — ${truncateText(row.detail ?? 'reprovado', 400)}`)
    .join('\n');
}

/** O que cada gate reprovado quer dizer, em português para o humano. */
const GATE_MEANING: Record<string, string> = {
  scope: 'alterou arquivo que o plano não permite',
  changes: 'a execução não alterou nada',
  execution_output: 'a saída da execução veio inválida',
  criteria_tests: 'critério sem teste encontrado',
  proof: 'a prova reprovou os testes',
  review: 'a revisão reprovou',
  environment: 'impedimento de ambiente',
};

/** Trechos de log que indicam bloqueio do ambiente (sandbox, rede), não erro do código. */
const ENVIRONMENT_SIGNS = /Operation not permitted|EPERM|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|Failed to fetch/;

function readLog(path: string | null): string {
  if (!path || !existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Resumo das tentativas para o humano decidir sem abrir o código: o que reprovou em cada
 * tentativa, a causa provável quando o log mostra bloqueio do ambiente e o diagnóstico que
 * o executor escreveu na última tentativa.
 */
export function humanAttemptsSummary(db: DatabaseSync, home: string, item: Pick<Item, 'id' | 'attemptNo'>): string[] {
  const rows = db
    .prepare(
      `SELECT attempt, gate, detail, log_path FROM gate_results
       WHERE item_id = ? AND attempt > 0 AND passed = 0 ORDER BY id`,
    )
    .all(item.id) as { attempt: number; gate: string; detail: string | null; log_path: string | null }[];
  const lines = ['O que reprovou:'];
  let environment = false;
  for (const row of rows) {
    const meaning = GATE_MEANING[row.gate] ?? `a verificação \`${row.gate}\` falhou`;
    const detail = row.detail && row.gate !== 'changes' ? ` (${truncateText(row.detail, 160)})` : '';
    lines.push(`- Tentativa ${row.attempt}: ${meaning}${detail}`);
    if (ENVIRONMENT_SIGNS.test(readLog(row.log_path))) {
      environment = true;
      lines.push(`  log: ${row.log_path}`);
    }
  }
  if (environment) {
    lines.push('', 'Causa provável: bloqueio do ambiente (sandbox ou rede), não o código.');
  }
  const execution = readArtifact<ExecuteOutput>(home, item.id, `execucao-${item.attemptNo}.json`);
  if (execution?.resumo) {
    lines.push('', `Diagnóstico do executor (tentativa ${item.attemptNo}):`, ...wrap(truncateText(execution.resumo, 1400), 90));
  }
  return lines;
}

/** Quebra o texto em linhas de até `width` caracteres, nos espaços. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function truncateText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function lastExecuteSession(db: DatabaseSync, itemId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT session_id FROM runs WHERE item_id = ? AND stage = 'execute' AND session_id IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as { session_id: string } | undefined;
  return row?.session_id;
}

function tail(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

// Etapas ---------------------------------------------------------------------------------

type Step = AdvanceResult | undefined;

function move(env: PipelineEnv, item: Item, to: ItemStatus, reason: string | null, runId?: string): void {
  transition(env.db, env.project, item.id, to, reason, { runId });
  env.log?.(`#${item.number} ${item.title}: ${item.status} → ${to}${reason ? ` · ${truncateText(reason, 160)}` : ''}`);
  item.status = to;
}

function stopForHuman(env: PipelineEnv, item: Item, kind: PendingKind, pending: Pending, reason: string, runId?: string): Step {
  updateItem(env.db, item.id, { pendingKind: kind, pending, nextInput: null });
  move(env, item, 'needs_human', reason, runId);
  return { kind: 'stopped', status: 'needs_human' };
}

/** Run interrompida, sem saldo ou com erro: decide o que acontece com o item. */
function runProblem(env: PipelineEnv, item: Item, stage: RunStage, outcome: RunOutcome): Step {
  if (outcome.status === 'succeeded') return undefined;
  const usageLimit = isUsageLimit(outcome);
  if (outcome.status === 'interrupted' || usageLimit) {
    const next: NextInput = { ...item.nextInput, interrupted: true };
    if (outcome.sessionId) next.resumeSessionId = outcome.sessionId;
    updateItem(env.db, item.id, { nextInput: next });
    return { kind: usageLimit ? 'usage_limit' : 'interrupted' };
  }
  move(env, item, 'failed', `run de ${stage} falhou: ${outcome.error ?? 'erro desconhecido'}`, outcome.runId);
  return { kind: 'stopped', status: 'failed' };
}

function context(env: PipelineEnv, item: Item): StageContext {
  return { home: env.home, project: env.project, item, worktree: item.worktree as string };
}

/** Contexto do projeto acima do orçamento: a etapa não inicia e a fila pausa (G8). */
function contextOverBudget(env: PipelineEnv, item: Item): Step {
  const context = projectContext(item.worktree as string, env.project.config.contexto.maxCaracteres);
  if (context.kind === 'ok') return undefined;
  env.log?.(`#${item.number} ${item.title}: ${context.reason}`);
  return { kind: 'paused', reason: context.reason };
}

function stageOptions(env: PipelineEnv, resumeSessionId: string | undefined, model?: string) {
  return { resumeSessionId, model, observer: env.observer, onStart: env.onStart };
}

async function planStep(env: PipelineEnv, item: Item): Promise<Step> {
  const prepared = prepare(env, item);
  if (prepared.setupError) {
    move(env, item, 'blocked', prepared.setupError);
    return { kind: 'stopped', status: 'blocked' };
  }
  const overBudget = contextOverBudget(env, item);
  if (overBudget) return overBudget;
  if (env.beforeAgentStage && !(await env.beforeAgentStage('plan', item))) return { kind: 'paused' };

  const next = item.nextInput ?? {};
  const previousPlan = next.previousPlan ? readArtifact<PlanOutput>(env.home, item.id, 'plano.json') : undefined;
  const result = await runPlan(
    env.db,
    context(env, item),
    {
      answer: next.answer,
      retryReason: next.retryReason,
      previousPlan,
      attemptsSummary: next.attemptsSummary,
      resuming: Boolean(next.resumeSessionId),
      interrupted: next.interrupted,
    },
    stageOptions(env, next.resumeSessionId),
  );
  const problem = runProblem(env, item, 'plan', result.outcome);
  if (problem) return problem;

  const { runId, sessionId } = result.outcome;
  const assumed = result.output && autonomousAnswers(env.project.config, result.output.perguntas);
  if (result.output && assumed) {
    const questions = result.output.perguntas;
    result.output.suposicoes.push(...assumed);
    result.output.perguntas = [];
    writePlan(env.home, item, result.output);
    recordAutonomy(env, item, 0, questions);
  }
  const verdict = startGate(
    result.output,
    result.invalid,
    readCriticalRules(env.project.root),
    item.approvedAt !== null,
    item.criticalConcepts,
    item.kind === 'bug',
  );
  switch (verdict.kind) {
    case 'questions': {
      const texts = verdict.questions.map((q) => q.texto).join(' | ');
      recordGate(env.db, item.id, 0, 'start', false, `perguntas: ${texts}`);
      return stopForHuman(
        env,
        item,
        'question_plan',
        { sessionId, questions: verdict.questions },
        `perguntas do planejamento: ${texts}`,
        runId,
      );
    }
    case 'incomplete':
      recordGate(env.db, item.id, 0, 'start', false, `plano incompleto: ${verdict.reason}`);
      if (item.planRetries < 1) {
        updateItem(env.db, item.id, {
          planRetries: item.planRetries + 1,
          nextInput: { resumeSessionId: sessionId ?? undefined, retryReason: verdict.reason },
        });
        env.log?.(`#${item.number} ${item.title}: plano incompleto (${verdict.reason}); refazendo na mesma sessão`);
        return undefined;
      }
      return stopForHuman(
        env,
        item,
        'plan_incomplete',
        { sessionId, reason: verdict.reason },
        `plano incompleto duas vezes: ${verdict.reason}`,
        runId,
      );
    case 'critical':
      recordGate(env.db, item.id, 0, 'start', false, `aprovação humana: ${verdict.reasons.join('; ')}`);
      return stopForHuman(
        env,
        item,
        'critical_approval',
        { sessionId, reason: verdict.reasons.join('; ') },
        `item crítico, aprove os critérios: ${verdict.reasons.join('; ')}`,
        runId,
      );
    case 'pass':
      recordGate(env.db, item.id, 0, 'start', true, null);
      updateItem(env.db, item.id, { planRetries: 0, attempts: 0, nextInput: null });
      move(env, item, 'planned', 'plano aprovado pelo gate de início', runId);
      return undefined;
  }
}

/**
 * Tentativa reprovada: nova tentativa (retomando a sessão na 2ª, sessão nova com resumo na
 * 3ª) ou `needs_human` depois da 3ª do ciclo.
 */
function attemptFailed(env: PipelineEnv, item: Item, cycleAttempt: number, failure: string): Step {
  updateItem(env.db, item.id, { attempts: cycleAttempt });
  const summary = attemptsSummary(env.db, item.id);
  if (cycleAttempt >= 3) {
    return stopForHuman(
      env,
      item,
      'attempts_exhausted',
      { summary },
      `três tentativas reprovadas:\n${summary}`,
    );
  }
  const failureText = tail(failure, 200);
  const next: NextInput =
    cycleAttempt === 1
      ? { resumeSessionId: lastExecuteSession(env.db, item.id), failure: failureText }
      : { failure: failureText, attemptsSummary: summary };
  updateItem(env.db, item.id, { nextInput: next });
  if (item.status !== 'executing') move(env, item, 'executing', `tentativa ${item.attemptNo} reprovada`);
  else env.log?.(`#${item.number} ${item.title}: tentativa ${item.attemptNo} reprovada`);
  return undefined;
}

async function executeStep(env: PipelineEnv, item: Item): Promise<Step> {
  const plan = readArtifact<PlanOutput>(env.home, item.id, 'plano.json');
  if (!plan) {
    move(env, item, 'failed', 'plano.json não encontrado');
    return { kind: 'stopped', status: 'failed' };
  }
  const prepared = prepare(env, item);
  if (prepared.setupError) {
    move(env, item, 'blocked', prepared.setupError);
    return { kind: 'stopped', status: 'blocked' };
  }
  const overBudget = contextOverBudget(env, item);
  if (overBudget) return overBudget;
  if (env.beforeAgentStage && !(await env.beforeAgentStage('execute', item))) return { kind: 'paused' };

  const next = item.nextInput ?? {};
  const worktree = item.worktree as string;
  const startHead = git(worktree, 'rev-parse', 'HEAD');
  // Conflito com a integração: o Mabel refaz o merge e deixa os conflitos para o executor.
  if (next.mergeOrigin && !mergeInProgress(worktree)) mergeOrigin(worktree, itemOrigin(env.project, item), false);
  const cycleAttempt = item.attempts + 1;
  const continuing = Boolean(next.interrupted || next.sameAttempt) && item.attemptNo > 0;
  const attemptNo = continuing ? item.attemptNo : item.attemptNo + 1;
  updateItem(env.db, item.id, { attemptNo });
  item.attemptNo = attemptNo;

  const base = env.project.config.models.execute;
  const model = item.escalatedCycle || cycleAttempt >= 3 ? escalate(base) : base;
  const result = await runExecute(
    env.db,
    context(env, item),
    {
      plan,
      attempt: attemptNo,
      failure: next.failure,
      answer: next.answer,
      attemptsSummary: next.attemptsSummary,
      scopeExtended: next.scopeExtended,
      resuming: Boolean(next.resumeSessionId),
      interrupted: next.interrupted,
    },
    stageOptions(env, next.resumeSessionId, model),
  );
  const problem = runProblem(env, item, 'execute', result.outcome);
  if (problem) return problem;
  const { runId, sessionId } = result.outcome;

  if (!result.output) {
    recordGate(env.db, item.id, attemptNo, 'execution_output', false, result.invalid ?? 'saída ausente');
    return attemptFailed(env, item, cycleAttempt, `A saída da execução foi rejeitada: ${result.invalid}`);
  }

  // G7: perguntas ou suposições sobre regra crítica param antes do commit. Com suposição
  // crítica o item para de qualquer jeito, e as perguntas vão junto para o humano.
  const critical = result.output.suposicoes.filter((s) => s.regraCritica).map((s) => s.texto);
  const assumed = critical.length === 0 ? autonomousAnswers(env.project.config, result.output.perguntas) : undefined;
  if (assumed) {
    const questions = result.output.perguntas;
    result.output.suposicoes.push(...assumed);
    result.output.perguntas = [];
    writeArtifact(env.home, item.id, `execucao-${attemptNo}.json`, result.output);
    recordAutonomy(env, item, attemptNo, questions);
  }
  if (result.output.perguntas.length > 0 || critical.length > 0) {
    const parts = [
      ...result.output.perguntas.map((q) => `pergunta: ${q.texto}`),
      ...critical.map((s) => `suposição crítica: ${s}`),
    ];
    return stopForHuman(
      env,
      item,
      'question_execute',
      { sessionId, questions: result.output.perguntas, criticalAssumptions: critical },
      `execução parou para perguntar: ${parts.join(' | ')}`,
      runId,
    );
  }

  const extension = scopeExtension(env, item, plan, attemptNo, result.output.escopoAdicional ?? [], sessionId, runId);
  if (extension !== 'none') return extension;

  const committed = commitAll(worktree, commitMessage(item, attemptNo));
  const unchanged = !committed && git(worktree, 'rev-parse', 'HEAD') === startHead;
  const blocker = result.output.impedimento?.trim();
  if (unchanged) {
    // Retentativa sem nada a mudar: o código das tentativas anteriores volta à verificação,
    // que reprova (e conta a tentativa) se o problema continuar.
    if (!hasOwnCommits(worktree, itemOrigin(env.project, item))) {
      if (blocker) {
        // Nada a verificar: o impedimento vai direto ao humano.
        updateItem(env.db, item.id, { attempts: cycleAttempt });
        recordGate(env.db, item.id, attemptNo, 'environment', false, blocker);
        return stopForHuman(env, item, 'environment_block', { reason: blocker, sessionId }, `impedimento de ambiente: ${blocker}`, runId);
      }
      recordGate(env.db, item.id, attemptNo, 'changes', false, 'execução sem nenhuma alteração');
      return attemptFailed(env, item, cycleAttempt, 'A execução não alterou nenhum arquivo.');
    }
    recordGate(env.db, item.id, attemptNo, 'changes', true, 'sem alteração nova: verifica de novo o que já foi commitado');
  }
  // Com impedimento declarado, a verificação do Mabel (fora do sandbox) decide: o bloqueio
  // costuma ser só do sandbox do agente. Ela para o item se também falhar.
  updateItem(env.db, item.id, { attempts: cycleAttempt, nextInput: null });
  move(env, item, 'verifying', committed ? `execução ${attemptNo} commitada` : `execução ${attemptNo} sem alteração nova`, runId);
  return undefined;
}

/** A branch do item tem commits que a origem não tem. */
function hasOwnCommits(worktree: string, origin: string): boolean {
  return Number(git(worktree, 'rev-list', '--count', `${origin}..HEAD`)) > 0;
}

/** Sessão do último planejamento, para o `responder` de uma aprovação pedida na execução. */
function lastPlanSession(db: DatabaseSync, itemId: string): string | null {
  const row = db
    .prepare(
      `SELECT session_id FROM runs WHERE item_id = ? AND stage = 'plan' AND session_id IS NOT NULL
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

/**
 * Escopo pedido pela execução (G4): globs novos entram no plano. Sem caminho crítico (ou com
 * o item aprovado), a mesma sessão retoma para concluir, sem contar tentativa; com caminho
 * crítico, o item vai à aprovação humana.
 */
function scopeExtension(
  env: PipelineEnv,
  item: Item,
  plan: PlanOutput,
  attemptNo: number,
  requested: ScopeRequest[],
  sessionId: string | null,
  runId: string,
): Step | 'none' {
  const added = requested.filter((r, i) => !plan.escopo.includes(r.glob) && requested.findIndex((o) => o.glob === r.glob) === i);
  if (added.length === 0) return 'none';
  plan.escopo.push(...added.map((r) => r.glob));
  writePlan(env.home, item, plan);
  const detail = added.map((r) => `\`${r.glob}\` — ${r.motivo}`).join('; ');
  const paths = readCriticalRules(item.worktree as string).paths;
  const critical = item.approvedAt
    ? []
    : added.flatMap((r) => paths.filter((path) => globsOverlap(r.glob, path)).map((path) => `\`${r.glob}\` toca o caminho crítico \`${path}\``));
  recordGate(env.db, item.id, attemptNo, 'scope_extension', critical.length === 0, detail);
  if (critical.length > 0) {
    const reason = `escopo pedido pela execução: ${critical.join('; ')}`;
    return stopForHuman(env, item, 'critical_approval', { sessionId: lastPlanSession(env.db, item.id), reason }, `item crítico, aprove os critérios: ${reason}`, runId);
  }
  recordGate(
    env.db,
    item.id,
    attemptNo,
    'autonomy',
    true,
    added.map((r) => `ampliar o escopo para \`${r.glob}\` → ${r.motivo}`).join(AUTONOMY_SEPARATOR),
  );
  env.log?.(`#${item.number} ${item.title}: escopo ampliado (autônomo): ${added.map((r) => r.glob).join(', ')}`);
  updateItem(env.db, item.id, {
    nextInput: { resumeSessionId: sessionId ?? undefined, sameAttempt: true, scopeExtended: added.map((r) => r.glob) },
  });
  return undefined;
}

const SETUP_FILES = 'setup-arquivos.json';

/**
 * Prepara o worktree e acumula os arquivos gerados pelo `setup` do Mabel, que o gate de
 * escopo não atribui ao agente. Acumula porque o retrabalho recria o worktree pela branch.
 */
function prepare(env: PipelineEnv, item: Item): PreparedWorktree {
  // Dependência em outra unidade, ainda fora da base: entra na branch da unidade antes do início.
  if (!item.worktree) {
    const conflict = bringDependencies(env.home, env.db, env.project, item);
    if (conflict) {
      const reason = `conflito ao trazer a unidade ${conflict.unit} para a ${unitBranch(item)} em: ${conflict.files.join(', ')}; faça o merge à mão`;
      return { path: '', branch: '', created: false, setupError: reason };
    }
  }
  const prepared = prepareWorktree(env.db, env.home, env.project, item);
  if (prepared.setupFiles && prepared.setupFiles.length > 0) {
    const known = readArtifact<string[]>(env.home, item.id, SETUP_FILES) ?? [];
    writeArtifact(env.home, item.id, SETUP_FILES, [...new Set([...known, ...prepared.setupFiles])].sort());
  }
  return prepared;
}

/**
 * Gate de escopo (G4): o que o item mudou desde que saiu da origem passa pelas regras do
 * hook. Pega a escrita pelo terminal, que o hook não interpreta. Violação volta à execução.
 */
function scopeGate(env: PipelineEnv, item: Item, plan: PlanOutput, worktree: string): Step | 'ok' {
  const base = git(worktree, 'merge-base', 'HEAD', itemOrigin(env.project, item));
  const fromSetup = new Set(readArtifact<string[]>(env.home, item.id, SETUP_FILES) ?? []);
  const changed = git(worktree, 'diff', '--name-only', '--no-renames', '-z', base, 'HEAD')
    .split('\0')
    .filter((path) => path && !fromSetup.has(path));
  const context = {
    escopo: plan.escopo,
    criticos: readCriticalRules(worktree).paths,
    criticosAprovados: item.approvedAt !== null,
  };
  const violations = changed.flatMap((path) => {
    const reason = scopeViolation(path, context);
    return reason ? [`\`${path}\`: ${reason}`] : [];
  });
  recordGate(env.db, item.id, item.attemptNo, 'scope', violations.length === 0, violations.join('; ') || null);
  if (violations.length === 0) return 'ok';
  return attemptFailed(
    env,
    item,
    item.attempts,
    [
      'Arquivos alterados fora do que o plano permite (o hook não vê a escrita pelo terminal):',
      ...violations.map((v) => `- ${v}`),
      'Desfaça essas alterações ou, se forem necessárias, declare os caminhos em escopoAdicional.',
    ].join('\n'),
  );
}

function verifyStep(env: PipelineEnv, item: Item): Step {
  const attemptNo = item.attemptNo;
  const plan = readArtifact<PlanOutput>(env.home, item.id, 'plano.json');
  const execution = readArtifact<ExecuteOutput>(env.home, item.id, `execucao-${attemptNo}.json`);
  if (!plan || !execution) {
    move(env, item, 'failed', `artefatos da tentativa ${attemptNo} não encontrados`);
    return { kind: 'stopped', status: 'failed' };
  }
  const worktree = item.worktree as string;
  const scope = scopeGate(env, item, plan, worktree);
  if (scope !== 'ok') return scope;
  // A origem andou desde o início do item: o que entra na integração é o que foi verificado.
  if (env.project.config.integracao) {
    const conflicts = mergeOrigin(worktree, itemOrigin(env.project, item));
    if (conflicts) {
      const reason = `conflito com a ${itemOrigin(env.project, item)} em: ${conflicts.join(', ')}`;
      recordGate(env.db, item.id, attemptNo, 'integration', false, reason);
      return stopForHuman(env, item, 'integration_conflict', { files: conflicts, reason }, reason);
    }
  }
  const logDir = join(itemDir(env.home, item.id), `verificacao-${attemptNo}`);
  mkdirSync(logDir, { recursive: true });
  const blocker = execution.impedimento?.trim();

  for (const command of env.project.config.verify) {
    const { code, output } = shell(command.command, worktree);
    const logPath = join(logDir, `${command.name.replace(/[^\w.-]/g, '_')}.log`);
    writeFileSync(logPath, output);
    const passed = code === 0;
    recordGate(env.db, item.id, attemptNo, command.name, passed, passed ? null : `\`${command.command}\` saiu com ${code}`, logPath);
    if (!passed && blocker) {
      // O impedimento se confirmou fora do sandbox: outra tentativa não muda o ambiente.
      const reason = `${blocker} A verificação do Mabel, fora do sandbox, também falhou em \`${command.command}\` (log: ${logPath}).`;
      recordGate(env.db, item.id, attemptNo, 'environment', false, reason);
      return stopForHuman(
        env,
        item,
        'environment_block',
        { reason, sessionId: lastExecuteSession(env.db, item.id) ?? null },
        `impedimento de ambiente: ${reason}`,
      );
    }
    if (!passed) {
      return attemptFailed(
        env,
        item,
        item.attempts,
        `O comando de verificação \`${command.command}\` falhou (código ${code}). Últimas linhas:\n${tail(output, 200)}`,
      );
    }
  }

  if (blocker) {
    recordGate(env.db, item.id, attemptNo, 'environment', true, `não se confirmou fora do sandbox: ${blocker}`);
    env.log?.(`#${item.number} ${item.title}: impedimento do executor não se confirmou; a verificação do Mabel passou`);
  }

  const missing = criteriaWithoutTests(plan, execution, worktree);
  recordGate(env.db, item.id, attemptNo, 'criteria_tests', missing.length === 0, missing.join('; ') || null);
  if (missing.length > 0) {
    return attemptFailed(env, item, item.attempts, `Critérios sem teste encontrado:\n${missing.map((m) => `- ${m}`).join('\n')}`);
  }
  return proofStep(env, item, plan, execution);
}

/**
 * Prova mecânica (G3): cada teste de critério roda no item e no código base. Lacuna volta à
 * execução; critério sem prova segue para o relatório; worktree não restaurado vai a `failed`.
 */
function proofStep(env: PipelineEnv, item: Item, plan: PlanOutput, execution: ExecuteOutput): Step {
  const attemptNo = item.attemptNo;
  const worktree = item.worktree as string;
  const logDir = join(itemDir(env.home, item.id), `prova-${attemptNo}`);
  const base = git(worktree, 'merge-base', 'HEAD', itemOrigin(env.project, item));
  const result = runProof({ worktree, base, config: env.project.config, plan, execution, logDir });
  writeArtifact(env.home, item.id, `prova-${attemptNo}.json`, result);
  if (!result.restored || result.error) {
    const reason = result.restored ? `prova interrompida: ${result.error}` : 'worktree não restaurado após a prova';
    recordGate(env.db, item.id, attemptNo, 'proof', false, reason, logDir);
    move(env, item, 'failed', reason);
    return { kind: 'stopped', status: 'failed' };
  }
  const gaps = result.criteria.filter((c) => c.status === 'nao_provado');
  recordGate(env.db, item.id, attemptNo, 'proof', gaps.length === 0, proofDetail(result) || null, logDir);
  if (gaps.length > 0) {
    return attemptFailed(
      env,
      item,
      item.attempts,
      `A prova reprovou testes que não protegem os critérios:\n${gaps.map((c) => `- ${c.id}: ${c.reason}`).join('\n')}`,
    );
  }
  move(env, item, 'reviewing', `verificação ${attemptNo} aprovada`);
  return undefined;
}

/** Notas para o humano no `awaiting_merge`: critérios de validação humana e suposições. */
function mergeNotes(plan: PlanOutput, execution: ExecuteOutput): string | null {
  const notes: string[] = [];
  const human = plan.criterios.filter((c) => c.verificacao === 'humano');
  if (human.length > 0) notes.push(`valide: ${human.map((c) => `${c.id} ${c.texto}`).join('; ')}`);
  const assumptions = [...plan.suposicoes, ...execution.suposicoes].map((s) => s.texto);
  if (assumptions.length > 0) notes.push(`suposições: ${assumptions.join('; ')}`);
  return notes.length > 0 ? notes.join(' · ') : null;
}

async function reviewStep(env: PipelineEnv, item: Item): Promise<Step> {
  const attemptNo = item.attemptNo;
  const plan = readArtifact<PlanOutput>(env.home, item.id, 'plano.json');
  const execution = readArtifact<ExecuteOutput>(env.home, item.id, `execucao-${attemptNo}.json`);
  if (!plan || !execution) {
    move(env, item, 'failed', `artefatos da tentativa ${attemptNo} não encontrados`);
    return { kind: 'stopped', status: 'failed' };
  }
  const overBudget = contextOverBudget(env, item);
  if (overBudget) return overBudget;
  if (env.beforeAgentStage && !(await env.beforeAgentStage('review', item))) return { kind: 'paused' };

  const next = item.nextInput ?? {};
  const result = await runReview(
    env.db,
    context(env, item),
    { plan, execution, attempt: attemptNo, resuming: Boolean(next.resumeSessionId) },
    stageOptions(env, next.resumeSessionId),
  );
  const problem = runProblem(env, item, 'review', result.outcome);
  if (problem) return problem;
  updateItem(env.db, item.id, { nextInput: null });

  if (!result.output) {
    recordGate(env.db, item.id, attemptNo, 'review', false, result.invalid ?? 'saída ausente');
    return attemptFailed(env, item, item.attempts, `A revisão não produziu um parecer válido: ${result.invalid}`);
  }
  const { approved, detail } = reviewVerdict(plan, result.output);
  recordGate(env.db, item.id, attemptNo, 'review', approved, detail);
  if (!approved) {
    return attemptFailed(env, item, item.attempts, `A revisão reprovou a tentativa:\n${detail}`);
  }
  if (env.project.config.integracao) return integrateStep(env, item, mergeNotes(plan, execution), result.outcome.runId);
  move(env, item, 'awaiting_merge', mergeNotes(plan, execution), result.outcome.runId);
  // A branch guarda tudo; um retrabalho recria o worktree a partir dela.
  removeWorktree(env.db, env.project, item);
  return { kind: 'stopped', status: 'awaiting_merge' };
}

/**
 * Tarefa aprovada entra na branch da unidade (G10) por merge; o worktree e a branch da
 * tarefa são apagados, a da unidade fica até a entrega. Depois, o merge da unidade na
 * integração, só para teste: conflito ou vermelho viram aviso.
 */
function integrateStep(env: PipelineEnv, item: Item, notes: string | null, runId: string): Step {
  const integrated = integrateItem(env.project, item, unitBranch(item));
  if ('error' in integrated) {
    recordGate(env.db, item.id, item.attemptNo, 'integration', false, integrated.error);
    move(env, item, 'failed', integrated.error, runId);
    return { kind: 'stopped', status: 'failed' };
  }
  setIntegrated(env.db, item, integrated.commit);
  recordGate(env.db, item.id, item.attemptNo, 'integration', true, integrated.commit);
  move(env, item, 'awaiting_merge', notes, runId);
  const branch = item.branch;
  removeWorktree(env.db, env.project, item);
  if (branch) tryGit(env.project.root, 'branch', '-D', branch);
  for (const note of integrateUnit(env.home, env.db, env.project, item)) env.log?.(`#${item.number} ${item.title}: ${note}`);
  return { kind: 'stopped', status: 'awaiting_merge' };
}

export interface AdvanceOptions {
  /** `planned`: para quando o item chega a `planned` (planejamento em lote). */
  until?: 'planned';
}

/** Leva o item pelas etapas até um estado de parada, interrupção ou pausa. */
export async function advanceItem(env: PipelineEnv, itemId: string, options: AdvanceOptions = {}): Promise<AdvanceResult> {
  for (;;) {
    const item = getItemById(env.db, itemId);
    let step: Step;
    switch (item.status) {
      case 'ready':
        updateItem(env.db, item.id, { planRetries: 0, nextInput: null, attempts: 0 });
        move(env, item, 'planning', 'início do planejamento');
        continue;
      case 'planning':
        step = await planStep(env, item);
        break;
      case 'planned':
        if (options.until === 'planned') return { kind: 'stopped', status: 'planned' };
        move(env, item, 'executing', 'início da execução');
        continue;
      case 'executing':
        step = await executeStep(env, item);
        break;
      case 'verifying':
        step = verifyStep(env, item);
        break;
      case 'reviewing':
        step = await reviewStep(env, item);
        break;
      default:
        return { kind: 'stopped', status: item.status };
    }
    if (step) return step;
  }
}

