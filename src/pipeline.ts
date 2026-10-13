import { mkdirSync, writeFileSync } from 'node:fs';
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
import type { Assumption, ExecuteOutput, PlanOutput, Question, ReviewOutput } from './schemas/stages.ts';
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
import { git } from './git.ts';
import { foundTests, proofDetail, runProof } from './proof.ts';
import { commitAll, commitMessage, originBranch, prepareWorktree, shell } from './worktree.ts';

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
  | { kind: 'paused' };

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

/** Motivos que tornam o item crítico: escopo em caminho crítico, conceitos, suposições. */
export function criticalReasons(plan: PlanOutput, rules: CriticalRules): string[] {
  const reasons: string[] = [];
  for (const scope of plan.escopo) {
    for (const path of rules.paths) {
      if (globsOverlap(scope, path)) reasons.push(`escopo \`${scope}\` toca o caminho crítico \`${path}\``);
    }
  }
  for (const concept of plan.conceitosCriticos) reasons.push(`conceito crítico: ${concept}`);
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
): StartVerdict {
  if (!plan) return { kind: 'incomplete', reason: invalid ?? 'saída estruturada ausente' };
  if (plan.perguntas.length > 0) return { kind: 'questions', questions: plan.perguntas };
  if (plan.criterios.length === 0) return { kind: 'incomplete', reason: 'plano sem critérios de aceite' };
  const unverified = plan.criterios.filter((c) => c.verificacao !== 'teste' && c.verificacao !== 'humano');
  if (unverified.length > 0) {
    return { kind: 'incomplete', reason: `critérios sem verificação: ${unverified.map((c) => c.id).join(', ')}` };
  }
  if (plan.escopo.length === 0) return { kind: 'incomplete', reason: 'plano sem escopo de arquivos' };
  const reasons = criticalReasons(plan, rules);
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
 * com todo critério do plano avaliado e atendido e nenhum problema bloqueante. Um
 * `aprovado` gravado por pareceres antigos é ignorado.
 */
export function reviewVerdict(plan: PlanOutput, review: ReviewOutput): ReviewVerdict {
  const planned = new Set(plan.criterios.map((c) => c.id));
  const evaluated = new Set(review.criterios.map((c) => c.id));
  const reasons = [
    ...plan.criterios.filter((c) => !evaluated.has(c.id)).map((c) => `revisão não avaliou o critério ${c.id}`),
    ...review.criterios
      .filter((c) => planned.has(c.id) && !c.atendido)
      .map((c) => `critério ${c.id} não atendido: ${c.evidencia}`),
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
  const detail = [...reasons, ...minor, ...ignored].join('; ');
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

function stageOptions(env: PipelineEnv, resumeSessionId: string | undefined, model?: string) {
  return { resumeSessionId, model, observer: env.observer, onStart: env.onStart };
}

async function planStep(env: PipelineEnv, item: Item): Promise<Step> {
  const prepared = prepareWorktree(env.db, env.home, env.project, item);
  if (prepared.setupError) {
    move(env, item, 'blocked', prepared.setupError);
    return { kind: 'stopped', status: 'blocked' };
  }
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
  const prepared = prepareWorktree(env.db, env.home, env.project, item);
  if (prepared.setupError) {
    move(env, item, 'blocked', prepared.setupError);
    return { kind: 'stopped', status: 'blocked' };
  }
  if (env.beforeAgentStage && !(await env.beforeAgentStage('execute', item))) return { kind: 'paused' };

  const next = item.nextInput ?? {};
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

  if (!commitAll(item.worktree as string, commitMessage(item, attemptNo))) {
    recordGate(env.db, item.id, attemptNo, 'changes', false, 'execução sem nenhuma alteração');
    return attemptFailed(env, item, cycleAttempt, 'A execução não alterou nenhum arquivo.');
  }
  updateItem(env.db, item.id, { attempts: cycleAttempt, nextInput: null });
  move(env, item, 'verifying', `execução ${attemptNo} commitada`, runId);
  return undefined;
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
  const logDir = join(itemDir(env.home, item.id), `verificacao-${attemptNo}`);
  mkdirSync(logDir, { recursive: true });

  for (const command of env.project.config.verify) {
    const { code, output } = shell(command.command, worktree);
    const logPath = join(logDir, `${command.name.replace(/[^\w.-]/g, '_')}.log`);
    writeFileSync(logPath, output);
    const passed = code === 0;
    recordGate(env.db, item.id, attemptNo, command.name, passed, passed ? null : `\`${command.command}\` saiu com ${code}`, logPath);
    if (!passed) {
      return attemptFailed(
        env,
        item,
        item.attempts,
        `O comando de verificação \`${command.command}\` falhou (código ${code}). Últimas linhas:\n${tail(output, 200)}`,
      );
    }
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
  const base = git(worktree, 'merge-base', 'HEAD', originBranch(env.project.config));
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
  move(env, item, 'awaiting_merge', mergeNotes(plan, execution), result.outcome.runId);
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

