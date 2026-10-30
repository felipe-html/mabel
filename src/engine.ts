import { existsSync, readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { ask } from './ask.ts';
import { type CatalogEntry, chooseReferences } from './capture.ts';
import { ToolLog, summaryLine } from './exec.ts';
import { truncate } from './format.ts';
import { projectContext } from './hermetic.ts';
import type { Item } from './items.ts';
import { type Project, mabelPath, readCriticalRules } from './project.ts';
import { liveReferences, referencesSection } from './references.ts';
import { type RunOutcome, type RunRequest, startRun } from './runner.ts';
import { sandboxSettings } from './sandbox.ts';
import type { Question, SpecifyOutput } from './schemas/stages.ts';
import { validate } from './schemas/validate.ts';
import {
  type RuleChange,
  type Spec,
  type SpecExample,
  EDGE_MARK,
  parseChange,
  parseExample,
  parseSpec,
  renderChange,
  renderExample,
  ruleChangeProblems,
  validateSpec,
} from './specs.ts';
import { ContextBudgetError, SCHEMAS, STAGE_ALLOWED, STAGE_TOOLS, scopeHooks, systemPrompt } from './stages.ts';
import { style } from './style.ts';

// Motor de especificação (S.4): Example Mapping em rodadas na mesma sessão, para o
// `mabel especificar` (uma spec) e o `mabel refinar` (um avulso). História → regras →
// exemplos → perguntas: exemplo sem resultado dedutível vira pergunta.

export const MAX_QUESTIONS = 5;
export const MAX_ROUNDS = 5;
/** Regras de negócio vigentes, por assunto (`docs/specs/specs-e-entrega.md`, R2). */
export const RULES_FILE = 'regras.md';
/** Caracteres do `regras.md` que o agente recebe no prompt; acima disso, o aviso de consolidar. */
export const RULES_BUDGET = 20_000;
/** Resposta "p": a pergunta fica para o planejamento. */
export const DEFERRED = 'deixe para o planejamento';

export type Target = { kind: 'spec'; slug: string; title: string; draft: string } | { kind: 'item'; item: Item };

/** O que o humano respondeu ao longo das rodadas, registrado pelo Mabel (não pelo agente). */
export interface Answers {
  /** "pergunta → resposta". */
  decisoes: string[];
  /** Perguntas deixadas para o planejamento. */
  adiadas: string[];
}

export const noAnswers = (): Answers => ({ decisoes: [], adiadas: [] });

/** Estado da conversa: o que a proposta guarda entre rodadas e entre comandos. */
export interface Conversation {
  sessionId: string | null;
  rounds: number;
  /** Perguntas feitas em todas as rodadas. */
  questions: number;
  output: SpecifyOutput;
  answers: Answers;
  runId: string | null;
}

export interface Metrics {
  regras: number;
  exemplos: number;
  rodadas: number;
  perguntas: number;
  tarefas: number;
}

export function metricsOf(conversation: Pick<Conversation, 'rounds' | 'questions' | 'output'>): Metrics {
  const { output } = conversation;
  return {
    regras: output.regras.length,
    exemplos: output.regras.reduce((sum, rule) => sum + rule.exemplos.length, 0),
    rodadas: conversation.rounds,
    perguntas: conversation.questions,
    tarefas: output.tarefas.length,
  };
}

export function metricsLine(metrics: Metrics): string {
  return `${metrics.regras} regras · ${metrics.exemplos} exemplos · ${metrics.rodadas} rodadas · ${metrics.perguntas} perguntas · ${metrics.tarefas} tarefas`;
}

// Regras vigentes ------------------------------------------------------------------------

/** O `regras.md` inteiro; vazio se ainda não existe. */
export function rulesFile(root: string): string {
  const path = mabelPath(root, RULES_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

/** O `regras.md` que o agente recebe, cortado no orçamento, com o aviso para o humano. */
export function currentRules(root: string, budget = RULES_BUDGET): { text: string; warning?: string } {
  const text = rulesFile(root);
  if (text.length <= budget) return { text };
  return {
    text: `${text.slice(0, budget)}\n\n(… cortado no orçamento: busque o resto em .mabel/${RULES_FILE} com Grep)`,
    warning: `.mabel/${RULES_FILE} tem ${text.length} caracteres, acima do orçamento de ${budget}: o agente lê só o começo. Consolide o arquivo (tire as regras obsoletas, junte as repetidas).`,
  };
}

// Prompts --------------------------------------------------------------------------------

function section(title: string, body: string): string[] {
  return body.trim() ? [`## ${title}`, '', body.trim(), ''] : [];
}

const bullets = (entries: string[], empty = '') => (entries.length > 0 ? entries.map((entry) => `- ${entry}`).join('\n') : empty);

function roundText(round: number): string {
  return round >= MAX_ROUNDS
    ? `Rodada ${round} de ${MAX_ROUNDS}, a última: não faça perguntas. Exemplo ainda sem resultado recebe a sua sugestão, e a decisão vai para \`decisoes\` com "(sugestão do agente)".`
    : `Rodada ${round} de ${MAX_ROUNDS}.`;
}

/** Prompt da primeira rodada: o rascunho (spec ou avulso), as regras vigentes e a tarefa. */
export function firstPrompt(target: Target, root: string): { prompt: string; warning?: string } {
  const rules = currentRules(root);
  const head =
    target.kind === 'spec'
      ? [
          `# Spec ${target.slug}: ${target.title}`,
          '',
          ...section('Rascunho (.mabel/specs/' + target.slug + '.md)', target.draft || '(vazio)'),
          ...section('Referências da spec', referencesSection(liveReferences(root, parseSpec(target.draft).referencias), '')),
        ]
      : itemDraft(target.item, root);
  const kind =
    target.kind === 'spec'
      ? 'Especifique a funcionalidade e proponha as tarefas do quadro.'
      : target.item.kind === 'bug'
        ? 'Especifique o avulso, que é um bug (`Tipo: bug`): uma tarefa só, com `reproducao` preenchida.'
        : 'Especifique o avulso: uma tarefa só.';
  return {
    prompt: [
      ...head,
      ...section('Regras vigentes (.mabel/regras.md)', rules.text || 'Nenhuma ainda.'),
      '## Tarefa',
      '',
      `${kind} ${roundText(1)} Não altere arquivos.`,
    ].join('\n'),
    warning: rules.warning,
  };
}

/** O avulso como rascunho: o que o backlog já diz dele. */
export function itemDraft(item: Item, root?: string): string[] {
  return [
    `# Item #${item.number}: ${item.title}${item.kind === 'bug' ? ' (bug)' : ''}`,
    '',
    ...section('Intenção', item.intent),
    ...section('Critérios de aceite atuais', bullets(item.criteria, 'Nenhum.')),
    ...section('Fora do escopo declarado', bullets(item.outOfScope, 'Nada.')),
    ...section('Decisões já tomadas', bullets(item.decisions, 'Nenhuma.')),
    ...section('Regras críticas declaradas', bullets(item.criticalConcepts, 'Nenhuma.')),
    ...section('Alterações nas regras vigentes declaradas', bullets(item.ruleChanges)),
    ...section('Referências', root ? referencesSection(liveReferences(root, item.references), '') : ''),
    ...section('Restrições', item.restrictions ?? ''),
  ];
}

/** Resposta do humano a uma pergunta da rodada; `null` deixa para o planejamento. */
export interface AnswerPair {
  question: Question & { regra: string };
  answer: string | null;
}

/** Prompt das rodadas seguintes, na mesma sessão: as respostas e as regras que elas mexem. */
export function answersPrompt(round: number, pairs: AnswerPair[]): string {
  const touched = [...new Set(pairs.map((pair) => pair.question.regra).filter(Boolean))];
  return [
    '## Respostas do humano',
    '',
    ...pairs.flatMap((pair) => [`P (${pair.question.regra || 'geral'}): ${pair.question.texto}`, `R: ${pair.answer ?? DEFERRED}`, '']),
    `Regras a retrabalhar: ${touched.length > 0 ? touched.join(', ') : 'nenhuma'}. As outras voltam como estavam.`,
    'Leve cada resposta para `decisoes` (`pergunta → resposta`) e, quando ela define um resultado, preencha o exemplo.',
    '',
    '## Tarefa',
    '',
    roundText(round),
  ].join('\n');
}

export function correctionPrompt(problems: string[]): string {
  return ['## Saída recusada pelo Mabel', '', ...problems.map((problem) => `- ${problem}`), '', 'Corrija e devolva a saída estruturada completa.'].join(
    '\n',
  );
}

// Validação ------------------------------------------------------------------------------

const NOTHING = /^nada\.?$/i;
const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const unresolved = (example: SpecExample) => !example.resultado.trim() || example.resultado.trim() === '?';

/** A proposta como spec (o que vai para `.mabel/specs/<slug>.md`). */
export function specFromOutput(title: string, output: SpecifyOutput, answers: Answers = noAnswers()): Spec {
  return {
    titulo: title,
    historia: output.historia.trim(),
    regras: output.regras.map((rule) => ({ id: rule.id, texto: rule.texto, exemplos: rule.exemplos.map((e) => ({ ...e })) })),
    decisoes: allDecisions(output, answers),
    foraDoEscopo: output.foraDoEscopo.filter((entry) => !NOTHING.test(entry.trim())),
    regrasCriticas: output.conceitosCriticos,
    referencias: [],
    alteracoesRegrasVigentes: output.alteracoesRegrasVigentes,
    secoes: [],
  };
}

/** Decisões do agente mais as respostas registradas pelo Mabel, sem repetir. */
export function allDecisions(output: Pick<SpecifyOutput, 'decisoes'>, answers: Answers): string[] {
  const result: string[] = [];
  for (const entry of [...output.decisoes, ...answers.decisoes]) {
    if (entry.trim() && !result.some((other) => normalize(other) === normalize(entry))) result.push(entry.trim());
  }
  return result;
}

export interface CheckContext {
  target: Target;
  round: number;
  /** Conceitos de `regras-criticas.md`. */
  concepts: string[];
  /** O `regras.md` inteiro, contra o qual as alterações são conferidas. */
  rules: string;
}

/** Problemas da saída de uma rodada; vazio quando ela serve. Sem perguntas, a proposta tem de estar pronta. */
export function outputProblems(output: unknown, ctx: CheckContext): string[] {
  const errors = validate(SCHEMAS.specify, output);
  if (errors.length > 0) return [`saída fora do esquema: ${errors.slice(0, 8).join('; ')}`];
  const proposal = output as SpecifyOutput;
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const rule of proposal.regras) {
    if (!/^R\d+$/.test(rule.id)) problems.push(`regra "${rule.id}": o id é R seguido de um número`);
    if (ids.has(rule.id)) problems.push(`${rule.id} repetida`);
    ids.add(rule.id);
  }
  if (proposal.perguntas.length > MAX_QUESTIONS) problems.push(`${proposal.perguntas.length} perguntas; o máximo é ${MAX_QUESTIONS} por rodada`);
  if (proposal.perguntas.length > 0 && ctx.round >= MAX_ROUNDS) problems.push('na última rodada não há perguntas: use a sua sugestão como resultado');
  for (const question of proposal.perguntas) {
    if (!ids.has(question.regra)) problems.push(`a pergunta "${truncate(question.texto, 60)}" cita a regra "${question.regra}", que não está em regras`);
  }
  // As perguntas nascem dos exemplos: exemplo sem resultado precisa da pergunta da regra,
  // salvo quando as 5 da rodada já foram usadas (as outras ficam para a próxima).
  const asked = new Set(proposal.perguntas.map((question) => question.regra));
  if (proposal.perguntas.length < MAX_QUESTIONS) {
    for (const rule of proposal.regras) {
      for (const example of rule.exemplos.filter(unresolved)) {
        if (!asked.has(rule.id)) problems.push(`${rule.id}: exemplo sem resultado e sem pergunta ("${truncate(example.situacao, 60)}"): preencha o resultado ou pergunte`);
      }
    }
  }
  const concepts = new Set(ctx.concepts.map(normalize));
  for (const concept of proposal.conceitosCriticos) {
    if (!concepts.has(normalize(concept))) problems.push(`conceito crítico "${concept}" não está em .mabel/regras-criticas.md`);
  }
  problems.push(...ruleChangeProblems(ctx.rules, proposal.alteracoesRegrasVigentes));
  if (problems.length > 0 || proposal.perguntas.length > 0) return problems;
  return readyProblems(proposal, ctx.target);
}

/** O que falta para a proposta sem perguntas ser gravada. */
export function readyProblems(proposal: SpecifyOutput, target: Target): string[] {
  const problems: string[] = [];
  if (!proposal.historia.trim()) problems.push('sem história');
  if (proposal.foraDoEscopo.length === 0) problems.push('foraDoEscopo vazio: declare o que não entra (ou ["Nada."])');
  for (const rule of proposal.regras) {
    if (rule.exemplos.length === 0) problems.push(`${rule.id} sem exemplo`);
    for (const example of rule.exemplos.filter(unresolved)) problems.push(`${rule.id}: exemplo sem resultado ("${truncate(example.situacao, 60)}")`);
  }
  if (proposal.tarefas.length === 0) problems.push('nenhuma tarefa');
  const ids = new Set(proposal.regras.map((rule) => rule.id));
  proposal.tarefas.forEach((task, i) => {
    const position = i + 1;
    if (!task.titulo.trim()) problems.push(`tarefa ${position} sem título`);
    for (const id of task.regras) if (!ids.has(id)) problems.push(`tarefa ${position} cita ${id}, que não está em regras`);
    for (const dep of task.dependeDe) {
      if (!Number.isInteger(dep) || dep < 1 || dep >= position) {
        problems.push(`tarefa ${position} depende de ${dep}: dependeDe só aponta para posições anteriores${position > 1 ? ` (1 a ${position - 1})` : ''}`);
      }
    }
  });
  if (target.kind === 'spec') {
    if (proposal.regras.length === 0) problems.push('sem regras');
    else if (!proposal.regras.some((rule) => rule.exemplos.some((e) => e.borda))) problems.push('nenhum exemplo de borda (borda: true)');
    const covered = new Set(proposal.tarefas.flatMap((task) => task.regras));
    const loose = proposal.regras.filter((rule) => !covered.has(rule.id)).map((rule) => rule.id);
    if (loose.length > 0 && proposal.tarefas.length > 0) problems.push(`regra sem tarefa: ${loose.join(', ')}`);
  } else if (target.item.kind === 'bug') {
    const { passos, esperado, obtido } = proposal.reproducao;
    if (!passos.trim() || !esperado.trim() || !obtido.trim()) problems.push('bug sem reprodução: preencha reproducao.passos, esperado e obtido');
  }
  return problems;
}

// Run ------------------------------------------------------------------------------------

/**
 * Run da etapa `specify`: na raiz, só leitura, com as travas do refinamento (flags
 * herméticas, sandbox, hook de escopo com escopo vazio, conferência do `init` e orçamento
 * de contexto). Modelo e limites são os do `refine` no config.
 */
export function specifyRequest(project: Project, itemId: string | undefined, prompt: string, resumeSessionId?: string): RunRequest {
  const { config } = project;
  const context = projectContext(project.root, config.contexto.maxCaracteres);
  if (context.kind === 'over_budget') throw new ContextBudgetError(context.reason);
  return {
    kind: 'stage',
    stage: 'specify',
    ...(itemId ? { itemId } : {}),
    prompt,
    cwd: project.root,
    model: config.models.refine,
    maxTurns: config.limits.refine.maxTurns,
    maxBudgetUsd: config.limits.refine.maxBudgetUsd,
    permissionMode: 'dontAsk',
    tools: STAGE_TOOLS.specify,
    allowedTools: STAGE_ALLOWED.specify,
    appendSystemPrompt: `${systemPrompt('specify').trimEnd()}\n\n${context.text}`,
    jsonSchema: SCHEMAS.specify,
    settings: { ...(config.sandbox ? { sandbox: sandboxSettings(project) } : {}), hooks: scopeHooks() },
    scope: { worktree: project.root, stage: 'specify', escopo: [], criticos: readCriticalRules(project.root).paths, criticosAprovados: false },
    ...(config.sandbox ? {} : { sandboxDisabled: true }),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

export interface EngineEnv {
  db: DatabaseSync;
  home: string;
  project: Project;
  /** Mostra as chamadas de ferramenta; sem ele, a rodada roda calada. */
  log?: ToolLog;
}

export type RoundResult = { output: SpecifyOutput; sessionId: string | null; runId: string } | { error: string; interrupted?: boolean };

async function runOnce(env: EngineEnv, request: RunRequest): Promise<RunOutcome> {
  const { log } = env;
  const handle = startRun(env.db, env.home, request, {
    onInit: ({ model }) => log?.write(style.dim(`  ▸ especificar · ${model ?? '?'}`)),
    onToolUse: (call) => log?.use(call.id, call.name, call.input),
    onToolResult: (result) => log?.close(result.id, result.isError),
  });
  const onSigint = () => handle.interrupt();
  process.on('SIGINT', onSigint);
  try {
    return await handle.done;
  } finally {
    process.off('SIGINT', onSigint);
    log?.flush();
  }
}

/**
 * Uma rodada: roda o agente e confere a saída. Saída inválida volta ao agente, na mesma
 * sessão, uma vez; falhando de novo, a rodada falha com o motivo.
 */
export async function runRound(env: EngineEnv, target: Target, prompt: string, round: number, resumeSessionId?: string | null): Promise<RoundResult> {
  const itemId = target.kind === 'item' ? target.item.id : undefined;
  const ctx: CheckContext = { target, round, concepts: readCriticalRules(env.project.root).concepts, rules: rulesFile(env.project.root) };
  let request: RunRequest;
  try {
    request = specifyRequest(env.project, itemId, prompt, resumeSessionId ?? undefined);
  } catch (error) {
    if (error instanceof ContextBudgetError) return { error: error.message };
    throw error;
  }
  for (let attempt = 1; ; attempt++) {
    const outcome = await runOnce(env, request);
    env.log?.write(style.dim(`  ${summaryLine(outcome)}`));
    if (outcome.status === 'interrupted') return { error: 'especificação interrompida', interrupted: true };
    if (outcome.status !== 'succeeded') return { error: `a run de especificação falhou: ${outcome.error ?? 'erro desconhecido'}` };
    const output = outcome.totals?.structuredOutput;
    const problems = output === undefined || output === null ? ['saída estruturada ausente'] : outputProblems(output, ctx);
    if (problems.length === 0) return { output: output as SpecifyOutput, sessionId: outcome.sessionId, runId: outcome.runId };
    if (attempt > 1 || !outcome.sessionId) return { error: `proposta inválida: ${problems.join('; ')}` };
    env.log?.write(style.dim(`  saída recusada (${truncate(problems.join('; '), 120)}); pedindo a correção na mesma sessão`));
    request = specifyRequest(env.project, itemId, correctionPrompt(problems), outcome.sessionId);
  }
}

/** Quem responde as perguntas de uma rodada: o humano no TTY ou as sugestões (`--aceitar`). */
export type Answerer = (output: SpecifyOutput) => Promise<AnswerPair[]>;

/** Sem TTY (`--aceitar`): a sugestão responde; pergunta sem sugestão fica para o planejamento. */
export const suggestionAnswerer: Answerer = async (output) =>
  output.perguntas.map((question) => ({ question, answer: question.sugestao.trim() || null }));

/** Grava as respostas da rodada nas decisões e nas adiadas. */
export function recordAnswers(answers: Answers, pairs: AnswerPair[]): Answers {
  return {
    decisoes: [...answers.decisoes, ...pairs.flatMap((pair) => (pair.answer ? [`${pair.question.texto.trim()} → ${pair.answer.trim()}`] : []))],
    adiadas: [...answers.adiadas, ...pairs.flatMap((pair) => (pair.answer ? [] : [pair.question.texto.trim()]))],
  };
}

/**
 * Conversa até a proposta sem perguntas: primeira rodada (sem `conversation`) ou a
 * continuação de uma pendente. `save` grava cada rodada, para o ctrl+c não perder nada.
 */
export async function converse(
  env: EngineEnv,
  target: Target,
  conversation: Conversation | undefined,
  answerer: Answerer,
  save: (conversation: Conversation) => void,
  warn: (line: string) => void = () => {},
): Promise<{ conversation: Conversation } | { error: string; interrupted?: boolean }> {
  let current = conversation;
  if (!current) {
    const { prompt, warning } = firstPrompt(target, env.project.root);
    if (warning) warn(warning);
    const result = await runRound(env, target, prompt, 1);
    if ('error' in result) return result;
    current = { sessionId: result.sessionId, rounds: 1, questions: result.output.perguntas.length, output: result.output, answers: noAnswers(), runId: result.runId };
    save(current);
  }
  while (current.output.perguntas.length > 0) {
    const pairs = await answerer(current.output);
    const answers = recordAnswers(current.answers, pairs);
    const round: number = current.rounds + 1;
    const result = await runRound(env, target, answersPrompt(round, pairs), round, current.sessionId);
    if ('error' in result) {
      // As respostas ficam gravadas: a próxima tentativa não as pergunta de novo.
      save({ ...current, answers });
      return result;
    }
    current = {
      sessionId: result.sessionId ?? current.sessionId,
      rounds: round,
      questions: current.questions + result.output.perguntas.length,
      output: result.output,
      answers,
      runId: result.runId,
    };
    save(current);
  }
  return { conversation: current };
}

// Terminal -------------------------------------------------------------------------------

/** Entrada e saída da revisão; os testes trocam o terminal por respostas roteirizadas. */
export interface ReviewIO {
  /** Lê uma linha; ctrl+c lança `Interrupted`. */
  ask: (prompt: string) => Promise<string>;
  write: (line: string) => void;
  /** Escolha das referências no catálogo; `null` quando cancelada. Sem ela, a etapa não aparece. */
  pickReferences?: (catalog: CatalogEntry[], current: string[]) => Promise<string[] | null>;
}

export const terminalReviewIO: ReviewIO = {
  ask,
  pickReferences: chooseReferences,
  write: (line) => process.stdout.write(`${line}\n`),
};

export const INDENT = '  ';

/** Perguntas da rodada uma a uma, como na inbox: enter aceita a sugestão, texto responde, `p` adia. */
export function terminalAnswerer(io: ReviewIO): Answerer {
  return async (output) => {
    io.write('');
    io.write(style.bold('Perguntas'));
    const pairs: AnswerPair[] = [];
    for (const [i, q] of output.perguntas.entries()) {
      const example = output.regras.find((rule) => rule.id === q.regra);
      io.write(`${INDENT}${i + 1}/${output.perguntas.length} ${q.texto}${style.dim(` (${q.regra}${example ? ` ${example.texto}` : ''})`)}${q.regraCritica ? style.dim(' (regra crítica)') : ''}`);
      if (q.sugestao) io.write(`${INDENT}    sugestão: ${q.sugestao}`);
      const hint = q.sugestao ? 'enter aceita a sugestão · texto responde · p deixa para o planejamento' : 'texto responde · enter ou p deixa para o planejamento';
      const answer = (await io.ask(`${INDENT}    › ${style.dim(hint)}: `)).trim();
      const chosen = answer.toLowerCase() === 'p' ? '' : answer || q.sugestao;
      pairs.push({ question: q, answer: chosen.trim() || null });
    }
    return pairs;
  };
}

/** Lista proposta: enter aceita, `e` edita uma a uma, `-` descarta. */
export async function reviewList(io: ReviewIO, title: string, entries: string[]): Promise<string[]> {
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

async function choice(io: ReviewIO, prompt: string, valid: string[]): Promise<string> {
  for (;;) {
    const answer = (await io.ask(prompt)).trim().toLowerCase();
    if (valid.includes(answer)) return answer;
    io.write(style.dim(`${INDENT}responda ${valid.map((v) => v || 'enter').join(', ')}`));
  }
}

async function reviewText(io: ReviewIO, title: string, text: string): Promise<string> {
  io.write('');
  io.write(style.bold(title));
  for (const line of text.trim().split('\n')) io.write(`${INDENT}${line}`);
  if ((await choice(io, `${INDENT}› enter aceita · e edita: `, ['', 'e'])) === '') return text;
  const edited = (await io.ask(`${INDENT}novo texto (enter mantém) › `)).trim();
  return edited || text;
}

const exampleLine = (example: SpecExample) => renderExample(example);

function ruleLines(rule: SpecifyOutput['regras'][number]): string[] {
  return [`${INDENT}${rule.id} ${rule.texto}`, ...rule.exemplos.map((e) => `${INDENT}   - ${exampleLine(e)}`)];
}

async function reviewRules(io: ReviewIO, rules: SpecifyOutput['regras']): Promise<SpecifyOutput['regras']> {
  if (rules.length === 0) return [];
  io.write('');
  io.write(style.bold('Regras e exemplos') + style.dim(` (borda marcada com ${EDGE_MARK})`));
  for (const rule of rules) for (const line of ruleLines(rule)) io.write(line);
  if ((await choice(io, `${INDENT}› enter aceita · e edita uma a uma: `, ['', 'e'])) === '') return rules;
  const kept: SpecifyOutput['regras'] = [];
  for (const rule of rules) {
    io.write(`${INDENT}${rule.id} ${rule.texto}`);
    const answer = (await io.ask(`${INDENT}   › enter mantém · - remove · texto novo substitui: `)).trim();
    if (answer === '-') continue;
    const exemplos = (await editList(io, rule.exemplos.map(exampleLine))).map(parseExample);
    kept.push({ ...rule, texto: answer || rule.texto, exemplos });
  }
  return kept;
}

type Task = SpecifyOutput['tarefas'][number];

/** Tarefas na revisão: `dependeDe` em posições, refeito quando uma sai. */
export function taskLines(tasks: Task[], offset = 0): string[] {
  return tasks.flatMap((task, i) => [
    `${INDENT}${i + 1 + offset}. ${task.titulo}`,
    style.dim(`${INDENT}   regras: ${task.regras.join(', ') || '—'}${task.dependeDe.length > 0 ? ` · depende de: ${task.dependeDe.map((d) => d + offset).join(', ')}` : ''}`),
  ]);
}

export function dropTasks(tasks: Task[], keep: boolean[]): Task[] {
  const newPosition = new Map<number, number>();
  let next = 1;
  tasks.forEach((_, i) => {
    if (keep[i]) newPosition.set(i + 1, next++);
  });
  return tasks.flatMap((task, i) =>
    keep[i] ? [{ ...task, dependeDe: task.dependeDe.flatMap((dep) => (newPosition.has(dep) ? [newPosition.get(dep) as number] : [])) }] : [],
  );
}

async function reviewTasks(io: ReviewIO, tasks: Task[], offset: number): Promise<Task[]> {
  if (tasks.length === 0) return [];
  io.write('');
  io.write(style.bold('Tarefas para o quadro'));
  for (const line of taskLines(tasks, offset)) io.write(line);
  const answer = await choice(io, `${INDENT}› enter aceita · e edita uma a uma · - descarta: `, ['', 'e', '-']);
  if (answer === '') return tasks;
  if (answer === '-') return [];
  const keep: boolean[] = [];
  const renamed: Task[] = [];
  for (const task of tasks) {
    io.write(`${INDENT}${task.titulo}`);
    const title = (await io.ask(`${INDENT}   › enter mantém · - remove · texto novo troca o título: `)).trim();
    keep.push(title !== '-');
    renamed.push(title && title !== '-' ? { ...task, titulo: title } : task);
  }
  return dropTasks(renamed, keep);
}

async function reviewReproduction(io: ReviewIO, reproduction: SpecifyOutput['reproducao']): Promise<SpecifyOutput['reproducao']> {
  io.write('');
  io.write(style.bold('Reprodução do bug'));
  io.write(`${INDENT}passos: ${reproduction.passos}`);
  io.write(`${INDENT}esperado: ${reproduction.esperado}`);
  io.write(`${INDENT}obtido hoje: ${reproduction.obtido}`);
  if ((await choice(io, `${INDENT}› enter aceita · e edita: `, ['', 'e'])) === '') return reproduction;
  const field = async (label: string, value: string) => (await io.ask(`${INDENT}${label} (enter mantém) › `)).trim() || value;
  return {
    passos: await field('passos', reproduction.passos),
    esperado: await field('esperado', reproduction.esperado),
    obtido: await field('obtido hoje', reproduction.obtido),
  };
}

export type EngineReview = { kind: 'accept'; output: SpecifyOutput } | { kind: 'keep' } | { kind: 'discard' };

export interface ReviewOptions {
  target: Target;
  answers: Answers;
  metrics: Metrics;
  /** Número que a primeira tarefa terá no backlog, para mostrar as dependências. */
  firstNumber?: number;
  /** Prévia do que será gravado, a partir da proposta revisada. */
  preview: (output: SpecifyOutput) => string[];
  /** Etapa a mais antes da prévia (as referências do avulso). */
  extraStep?: () => Promise<void>;
}

/**
 * Revisão parte a parte (história, regras com exemplos, decisões, fora do escopo, regras
 * críticas, alterações nas regras vigentes e tarefas), a prévia e `Gravar? [S/n/d]`.
 */
export async function reviewOutput(io: ReviewIO, output: SpecifyOutput, options: ReviewOptions): Promise<EngineReview> {
  const { target } = options;
  const historia = await reviewText(io, 'História', output.historia);
  const regras = await reviewRules(io, output.regras);
  const decisoes = await reviewList(io, 'Decisões', allDecisions(output, options.answers));
  const foraDoEscopo = await reviewList(io, 'Fora do escopo', output.foraDoEscopo);
  const conceitosCriticos = await reviewList(io, 'Regras críticas que a proposta toca', output.conceitosCriticos);
  const changes = await reviewList(io, 'Alterações nas regras vigentes (aplicadas na entrega)', output.alteracoesRegrasVigentes.map(renderChange));
  const alteracoesRegrasVigentes: RuleChange[] = [];
  for (const line of changes) {
    const change = parseChange(line);
    if (change) alteracoesRegrasVigentes.push(change);
    else io.write(style.dim(`${INDENT}ignorada (use assunto: incluir|alterar|remover "texto"): ${line}`));
  }
  const ids = new Set(regras.map((rule) => rule.id));
  let tarefas = output.tarefas.map((task) => ({ ...task, regras: task.regras.filter((id) => ids.has(id)) }));
  if (target.kind === 'spec') tarefas = await reviewTasks(io, tarefas, (options.firstNumber ?? 1) - 1);
  const reproducao = target.kind === 'item' && target.item.kind === 'bug' ? await reviewReproduction(io, output.reproducao) : output.reproducao;
  if (options.answers.adiadas.length > 0) {
    io.write('');
    io.write(style.bold('Deixadas para o planejamento'));
    for (const question of options.answers.adiadas) io.write(`${INDENT}- ${question}`);
  }
  if (output.sugestaoQuebra.length > 0) {
    io.write('');
    io.write(style.bold('Sugestão de quebra') + style.dim(' (não é aplicada; escreva as specs menores se concordar)'));
    for (const part of output.sugestaoQuebra) io.write(`${INDENT}- ${part.titulo}: ${part.historia}`);
  }
  await options.extraStep?.();
  io.write('');
  io.write(style.dim(`Tamanho: ${metricsLine(options.metrics)}`));
  // As respostas já estão em `decisoes`; o resto da revisão monta a proposta final.
  const reviewed: SpecifyOutput = { ...output, historia, regras, decisoes, foraDoEscopo, conceitosCriticos, alteracoesRegrasVigentes, tarefas, reproducao };
  io.write('');
  io.write(style.bold('Como fica'));
  for (const line of options.preview(reviewed)) io.write(`${INDENT}${line}`);
  io.write('');
  for (;;) {
    const answer = (await io.ask('Gravar? [S/n/d] (n deixa a proposta pendente · d descarta) ')).trim().toLowerCase();
    if (!answer || answer.startsWith('s') || answer.startsWith('y')) return { kind: 'accept', output: reviewed };
    if (answer.startsWith('n')) return { kind: 'keep' };
    if (answer.startsWith('d')) return { kind: 'discard' };
  }
}

/** Resumo da proposta fora do TTY (sem revisão). */
export function outputLines(output: SpecifyOutput, answers: Answers): string[] {
  const lines = [style.bold('História'), ...output.historia.trim().split('\n').map((line) => `${INDENT}${line}`)];
  if (output.regras.length > 0) {
    lines.push('', style.bold('Regras e exemplos'));
    for (const rule of output.regras) lines.push(...ruleLines(rule));
  }
  if (output.perguntas.length > 0) {
    lines.push('', style.bold('Perguntas'));
    for (const [i, q] of output.perguntas.entries()) {
      lines.push(`${INDENT}${i + 1}. ${q.texto} (${q.regra})${q.regraCritica ? ' (regra crítica)' : ''}`);
      if (q.sugestao) lines.push(`${INDENT}   sugestão: ${q.sugestao}`);
    }
  }
  const list = (title: string, entries: string[]) => {
    if (entries.length > 0) lines.push('', style.bold(title), ...entries.map((entry, i) => `${INDENT}${i + 1}. ${entry}`));
  };
  list('Decisões', allDecisions(output, answers));
  list('Fora do escopo', output.foraDoEscopo);
  list('Regras críticas que a proposta toca', output.conceitosCriticos);
  list('Alterações nas regras vigentes', output.alteracoesRegrasVigentes.map(renderChange));
  if (output.tarefas.length > 0) lines.push('', style.bold('Tarefas'), ...taskLines(output.tarefas));
  if (output.sugestaoQuebra.length > 0) {
    lines.push('', style.bold('Sugestão de quebra'), ...output.sugestaoQuebra.map((part) => `${INDENT}- ${part.titulo}: ${part.historia}`));
  }
  return lines;
}

/** Critérios do avulso a partir da proposta: a reprodução (bug) primeiro, depois um por exemplo. */
export function itemCriteria(output: SpecifyOutput, bug: boolean): string[] {
  const criteria: string[] = [];
  if (bug) {
    const { passos, esperado, obtido } = output.reproducao;
    criteria.push(`Reprodução: ${passos.trim()} → ${esperado.trim()} (hoje: ${obtido.trim()})`);
  }
  for (const rule of output.regras) {
    for (const example of rule.exemplos) criteria.push(`${rule.texto}: ${renderExample({ ...example, borda: false })}`);
  }
  return criteria;
}

/** ToolLog da raiz do projeto, recuado como as outras etapas interativas. */
export const engineLog = (root: string) => new ToolLog(root, '    ');
