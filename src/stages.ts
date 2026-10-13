import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Item } from './items.ts';
import { projectContext } from './hermetic.ts';
import type { Project } from './project.ts';
import { sandboxSettings } from './sandbox.ts';
import { type RunHandle, type RunObserver, type RunOutcome, type RunRequest, type RunStage, startRun } from './runner.ts';
import {
  type ExecuteOutput,
  type PlanOutput,
  type ReviewOutput,
  executeSchema,
  planSchema,
  reviewSchema,
} from './schemas/stages.ts';
import { type Schema, validate } from './schemas/validate.ts';
import { originBranch } from './worktree.ts';

/** Ferramentas que existem na etapa (`--tools`); o `init` precisa listar exatamente estas. */
export const STAGE_TOOLS: Record<RunStage, string[]> = {
  plan: ['Read', 'Glob', 'Grep'],
  execute: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
  review: ['Read', 'Glob', 'Grep', 'Bash'],
};

/** Ferramentas liberadas sem pedir (`--allowedTools`); no `dontAsk`, o resto é negado. */
export const STAGE_ALLOWED: Record<RunStage, string[]> = {
  plan: STAGE_TOOLS.plan,
  execute: STAGE_TOOLS.execute,
  review: ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
};

export class ContextBudgetError extends Error {}

/** Barreira fraca contra comandos perigosos na execução; a trava real é o hook do passo 5. */
export const EXECUTE_DISALLOWED = [
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git merge:*)',
  'Bash(git checkout:*)',
  'Bash(git reset:*)',
  'Bash(git rebase:*)',
  'Bash(rm -rf:*)',
  'Bash(sudo:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
];

const SCHEMAS: Record<RunStage, Schema> = { plan: planSchema, execute: executeSchema, review: reviewSchema };

const PROMPT_FILES: Record<RunStage, string> = {
  plan: 'planejar.md',
  execute: 'executar.md',
  review: 'revisar.md',
};

export function systemPrompt(stage: RunStage): string {
  return readFileSync(new URL(`../prompts/${PROMPT_FILES[stage]}`, import.meta.url), 'utf8');
}

export interface StageContext {
  home: string;
  project: Project;
  item: Item;
  /** Worktree do item: cwd de todas as etapas. */
  worktree: string;
}

export interface StageOptions {
  /** Modelo no lugar do `config.models` (escalonamento). */
  model?: string;
  resumeSessionId?: string;
  observer?: RunObserver;
  /** Recebe a run assim que o `claude` inicia, para interrupção. */
  onStart?: (handle: RunHandle) => void;
}

export interface StageResult<T> {
  outcome: RunOutcome;
  /** Saída estruturada válida; ausente quando a run falhou ou a saída é inválida. */
  output?: T;
  /** Motivo da saída ausente ou fora do esquema, quando a run terminou bem. */
  invalid?: string;
}

/** Argumentos da run de cada etapa: ferramentas, modo, modelo, limites, esquema e sessão. */
export function stageRequest(ctx: StageContext, stage: RunStage, prompt: string, options: StageOptions = {}): RunRequest {
  const { config } = ctx.project;
  const limits = config.limits[stage];
  const context = projectContext(ctx.worktree, config.contexto.maxCaracteres);
  if (context.kind === 'over_budget') throw new ContextBudgetError(context.reason);
  const request: RunRequest = {
    kind: 'stage',
    stage,
    itemId: ctx.item.id,
    prompt,
    cwd: ctx.worktree,
    model: options.model ?? config.models[stage],
    maxTurns: limits.maxTurns,
    maxBudgetUsd: limits.maxBudgetUsd,
    permissionMode: 'dontAsk',
    tools: STAGE_TOOLS[stage],
    allowedTools: STAGE_ALLOWED[stage],
    appendSystemPrompt: `${systemPrompt(stage).trimEnd()}\n\n${context.text}`,
    jsonSchema: SCHEMAS[stage],
    settings: config.sandbox ? { sandbox: sandboxSettings(ctx.project) } : {},
  };
  if (!config.sandbox) request.sandboxDisabled = true;
  if (stage === 'execute') request.disallowedTools = EXECUTE_DISALLOWED;
  if (options.resumeSessionId) request.resumeSessionId = options.resumeSessionId;
  return request;
}

export async function runStage<T>(
  db: DatabaseSync,
  ctx: StageContext,
  stage: RunStage,
  prompt: string,
  options: StageOptions = {},
): Promise<StageResult<T>> {
  const handle = startRun(db, ctx.home, stageRequest(ctx, stage, prompt, options), options.observer);
  options.onStart?.(handle);
  const outcome = await handle.done;
  if (outcome.status !== 'succeeded') return { outcome };
  const output = outcome.totals?.structuredOutput;
  if (output === undefined || output === null) return { outcome, invalid: 'saída estruturada ausente' };
  const errors = validate(SCHEMAS[stage], output);
  if (errors.length > 0) return { outcome, invalid: `saída fora do esquema: ${errors.slice(0, 8).join('; ')}` };
  return { outcome, output: output as T };
}

// Artefatos ------------------------------------------------------------------------------

export function itemDir(home: string, itemId: string): string {
  return join(home, 'items', itemId);
}

export function writeArtifact(home: string, itemId: string, name: string, content: unknown): string {
  const dir = itemDir(home, itemId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

export function readArtifact<T>(home: string, itemId: string, name: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(itemDir(home, itemId), name), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Versão legível do plano, usada nos prompts das etapas seguintes. */
export function renderPlanMarkdown(item: Pick<Item, 'number' | 'title'>, plan: PlanOutput): string {
  const lines = [`# Plano do item #${item.number}: ${item.title}`, '', plan.resumo, '', '## Critérios de aceite'];
  for (const criterion of plan.criterios) {
    const kind = [criterion.verificacao, criterion.comportamento].filter(Boolean).join(', ');
    lines.push(`- **${criterion.id}** (${kind}): ${criterion.texto}`);
  }
  lines.push('', '## Escopo', ...plan.escopo.map((glob) => `- \`${glob}\``));
  lines.push('', '## Passos', ...plan.passos.map((step, i) => `${i + 1}. ${step}`));
  if (plan.suposicoes.length > 0) {
    lines.push('', '## Suposições');
    for (const assumption of plan.suposicoes) {
      lines.push(`- ${assumption.texto}${assumption.regraCritica ? ' **(regra crítica)**' : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// Prompts das runs -----------------------------------------------------------------------

function section(title: string, body: string | string[]): string[] {
  const text = Array.isArray(body) ? body.join('\n') : body;
  return text.trim() ? [`## ${title}`, '', text.trim(), ''] : [];
}

function bullet(items: string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

function verifyCommands(project: Project): string {
  return bullet(
    project.config.verify.map((command) => `\`${command.command}\` (${command.name})`),
    'Nenhum comando de verificação configurado.',
  );
}

export interface PlanPromptInput {
  /** Resposta do humano às perguntas ou ao pedido de aprovação. */
  answer?: string;
  /** Motivo de um plano incompleto, para refazer na mesma sessão. */
  retryReason?: string;
  /** Replanejamento em sessão nova: o plano anterior e o resumo das tentativas. */
  previousPlan?: PlanOutput;
  attemptsSummary?: string;
  /** A sessão está sendo retomada: só o que é novo vai no prompt. */
  resuming?: boolean;
  /** A run anterior desta etapa foi interrompida. */
  interrupted?: boolean;
}

const INTERRUPTED = 'A run anterior foi interrompida antes de terminar. Continue de onde parou.';

export function planPrompt(ctx: StageContext, input: PlanPromptInput = {}): string {
  const { item, project } = ctx;
  if (input.resuming) {
    return [
      ...(input.interrupted ? [INTERRUPTED, ''] : []),
      ...section('Plano incompleto', input.retryReason ?? ''),
      ...section('Resposta do humano', input.answer ?? ''),
      'Refaça o plano completo levando isso em conta e termine com a saída estruturada.',
    ].join('\n');
  }
  return [
    `# Item #${item.number}: ${item.title}`,
    '',
    ...section('Intenção', item.intent),
    ...section(
      'Critérios de aceite do backlog',
      bullet(item.criteria, 'Nenhum. Proponha critérios verificáveis.'),
    ),
    ...section('Restrições', item.restrictions ?? ''),
    ...section('Comandos de verificação', verifyCommands(project)),
    ...(input.previousPlan
      ? section('Plano anterior', renderPlanMarkdown(item, input.previousPlan).replace(/^# .*\n/, ''))
      : []),
    ...section('Tentativas anteriores', input.attemptsSummary ?? ''),
    ...section('Resposta do humano', input.answer ?? ''),
    '## Tarefa',
    '',
    `Planeje o item a partir do diretório atual (worktree da branch \`${item.branch ?? ''}\`). Não altere arquivos.`,
  ].join('\n');
}

export interface ExecutePromptInput {
  plan: PlanOutput;
  attempt: number;
  /** Saída da falha da tentativa anterior (log do gate ou problemas da revisão). */
  failure?: string;
  answer?: string;
  attemptsSummary?: string;
  resuming?: boolean;
  interrupted?: boolean;
}

export function executePrompt(ctx: StageContext, input: ExecutePromptInput): string {
  if (input.resuming) {
    return [
      `# Tentativa ${input.attempt}`,
      '',
      ...(input.interrupted ? [INTERRUPTED, ''] : []),
      ...section('Falha da tentativa anterior', input.failure ?? ''),
      ...section('Resposta do humano', input.answer ?? ''),
      'Corrija o que for preciso dentro do plano, rode a verificação e termine com a saída estruturada.',
    ].join('\n');
  }
  return [
    `# Item #${ctx.item.number}: ${ctx.item.title} · tentativa ${input.attempt}`,
    '',
    ...section('Plano', renderPlanMarkdown(ctx.item, input.plan).replace(/^# .*\n/, '')),
    ...section('Restrições', ctx.item.restrictions ?? ''),
    ...section('Comandos de verificação', verifyCommands(ctx.project)),
    ...section('Tentativas anteriores', input.attemptsSummary ?? ''),
    ...section('Falha da tentativa anterior', input.failure ?? ''),
    ...section('Resposta do humano', input.answer ?? ''),
    '## Tarefa',
    '',
    'Implemente o plano no diretório atual. Não use git: o Mabel faz o commit.',
  ].join('\n');
}

export interface ReviewPromptInput {
  plan: PlanOutput;
  execution: ExecuteOutput;
  resuming?: boolean;
}

export function reviewPrompt(ctx: StageContext, input: ReviewPromptInput): string {
  if (input.resuming) return `${INTERRUPTED} Termine a revisão com a saída estruturada.`;
  const base = originBranch(ctx.project.config);
  const tests = input.execution.criterios.map(
    (criterion) => `${criterion.id}: ${criterion.testes.map((t) => `\`${t.arquivo}\` › ${t.nome}`).join(', ') || '(nenhum)'}`,
  );
  return [
    `# Revisão do item #${ctx.item.number}: ${ctx.item.title}`,
    '',
    ...section('Plano', renderPlanMarkdown(ctx.item, input.plan).replace(/^# .*\n/, '')),
    ...section('Resumo da execução', input.execution.resumo),
    ...section('Testes declarados por critério', bullet(tests, 'Nenhum.')),
    '## Tarefa',
    '',
    `Revise as alterações rodando, cada um num comando separado (sem \`;\` nem \`&&\`),`,
    `\`git diff ${base}...HEAD\` e \`git log ${base}..HEAD\`. Não edite nada.`,
  ].join('\n');
}

// Etapas tipadas, com artefatos ----------------------------------------------------------

/** Grava o `plano.json` e o `plano.md` do item. */
export function writePlan(home: string, item: Pick<Item, 'id' | 'number' | 'title'>, plan: PlanOutput): void {
  writeArtifact(home, item.id, 'plano.json', plan);
  writeArtifact(home, item.id, 'plano.md', renderPlanMarkdown(item, plan));
}

export async function runPlan(
  db: DatabaseSync,
  ctx: StageContext,
  input: PlanPromptInput,
  options: StageOptions = {},
): Promise<StageResult<PlanOutput>> {
  const result = await runStage<PlanOutput>(db, ctx, 'plan', planPrompt(ctx, input), options);
  if (result.output) writePlan(ctx.home, ctx.item, result.output);
  return result;
}

export async function runExecute(
  db: DatabaseSync,
  ctx: StageContext,
  input: ExecutePromptInput,
  options: StageOptions = {},
): Promise<StageResult<ExecuteOutput>> {
  const result = await runStage<ExecuteOutput>(db, ctx, 'execute', executePrompt(ctx, input), options);
  if (result.output) writeArtifact(ctx.home, ctx.item.id, `execucao-${input.attempt}.json`, result.output);
  return result;
}

export async function runReview(
  db: DatabaseSync,
  ctx: StageContext,
  input: ReviewPromptInput & { attempt: number },
  options: StageOptions = {},
): Promise<StageResult<ReviewOutput>> {
  const result = await runStage<ReviewOutput>(db, ctx, 'review', reviewPrompt(ctx, input), options);
  if (result.output) writeArtifact(ctx.home, ctx.item.id, `revisao-${input.attempt}.json`, result.output);
  return result;
}
