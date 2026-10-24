import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Interrupted, interactive } from './ask.ts';
import { dataDir, openDb } from './db.ts';
import { ToolLog, summaryLine } from './exec.ts';
import { formatCost, formatWhen, truncate } from './format.ts';
import { projectContext } from './hermetic.ts';
import { DELEGATE } from './inbox.ts';
import { gitRoot, isEmptyProject, readConfig } from './project.ts';
import { type ReviewIO, ensureRefineBalance, terminalReviewIO } from './refine.ts';
import { type RunOutcome, type RunRequest, startRun } from './runner.ts';
import { birthSandbox } from './sandbox.ts';
import type { BirthOutput, BirthProposal, Question } from './schemas/stages.ts';
import { validate } from './schemas/validate.ts';
import { STACKS, type Stack, detectCommands, findStack, stackLabel } from './stacks.ts';
import { SCHEMAS, STAGE_ALLOWED, STAGE_TOOLS, scopeHooks, systemPrompt } from './stages.ts';
import { style } from './style.ts';

/**
 * `mabel nascer` (`docs/specs/nascer.md`): conversa curta com um agente, só de leitura, que
 * termina numa proposta de stack, `CLAUDE.md`, regras críticas e backlog inicial.
 */

export const birthUsage = 'mabel nascer ["<descrição>"] [--stack <id>] [--modelo <m>]';

/** Rodadas de perguntas e resposta; na última, o agente propõe com suposições. */
export const MAX_ROUNDS = 3;
export const MAX_QUESTIONS = 5;
export const MAX_ITEMS = 10;
/** Padrões da etapa: ainda não há `config.json` para ler. */
export const BIRTH_MODEL = 'sonnet';
export const BIRTH_LIMITS = { maxTurns: 40, maxBudgetUsd: 2 };
/** Stack fora do catálogo. */
export const OTHER_STACK = 'outra';

// Nascimentos no banco -------------------------------------------------------------------

export type BirthStatus = 'asking' | 'proposed' | 'accepted' | 'discarded';

/** Opções da primeira chamada, valendo para as rodadas seguintes. */
export interface BirthOptions {
  stack?: string;
  model?: string;
}

export interface Birth {
  id: string;
  root: string;
  description: string;
  options: BirthOptions;
  sessionId: string | null;
  rounds: number;
  output: BirthOutput | null;
  status: BirthStatus;
  decision: unknown;
  projectId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface BirthRow {
  id: string;
  root: string;
  description: string;
  options: string;
  session_id: string | null;
  rounds: number;
  output: string | null;
  status: BirthStatus;
  decision: string | null;
  project_id: string | null;
  created_at: string;
  decided_at: string | null;
}

function fromRow(row: BirthRow): Birth {
  return {
    id: row.id,
    root: row.root,
    description: row.description,
    options: JSON.parse(row.options) as BirthOptions,
    sessionId: row.session_id,
    rounds: row.rounds,
    output: row.output ? (JSON.parse(row.output) as BirthOutput) : null,
    status: row.status,
    decision: row.decision ? JSON.parse(row.decision) : null,
    projectId: row.project_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export function getBirth(db: DatabaseSync, id: string): Birth | undefined {
  const row = db.prepare('SELECT * FROM births WHERE id = ?').get(id) as BirthRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** Nascimento pelo id ou por um prefixo único dele; o texto é o motivo quando não acha. */
export function findBirth(db: DatabaseSync, prefix: string): Birth | string {
  const rows = db.prepare("SELECT * FROM births WHERE id LIKE ? || '%' ORDER BY created_at").all(prefix.trim()) as unknown as BirthRow[];
  if (!prefix.trim() || rows.length === 0) return `Nenhum nascimento com o id ${prefix}.`;
  if (rows.length > 1) return `O prefixo ${prefix} serve a ${rows.length} nascimentos; use mais caracteres.`;
  return fromRow(rows[0] as BirthRow);
}

/** Nascimentos com perguntas ou proposta pendente, do mais recente ao mais antigo. */
export function openBirths(db: DatabaseSync, root?: string): Birth[] {
  const rows = db
    .prepare(
      `SELECT * FROM births WHERE status IN ('asking', 'proposed') AND (? IS NULL OR root = ?)
       ORDER BY created_at DESC`,
    )
    .all(root ?? null, root ?? null) as unknown as BirthRow[];
  return rows.map(fromRow);
}

const statusOf = (output: BirthOutput): BirthStatus => (output.perguntas.length > 0 ? 'asking' : 'proposed');

export function createBirth(
  db: DatabaseSync,
  root: string,
  description: string,
  options: BirthOptions,
  sessionId: string | null,
  output: BirthOutput,
): Birth {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO births (id, root, description, options, session_id, rounds, output, status, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, root, description, JSON.stringify(options), sessionId, JSON.stringify(output), statusOf(output), new Date().toISOString());
  return getBirth(db, id) as Birth;
}

/** Grava a rodada seguinte de um nascimento em aberto. */
export function recordRound(db: DatabaseSync, birth: Birth, sessionId: string | null, output: BirthOutput): Birth {
  db.prepare('UPDATE births SET session_id = coalesce(?, session_id), rounds = rounds + 1, output = ?, status = ? WHERE id = ?').run(
    sessionId,
    JSON.stringify(output),
    statusOf(output),
    birth.id,
  );
  return getBirth(db, birth.id) as Birth;
}

export function decideBirth(
  db: DatabaseSync,
  id: string,
  status: 'accepted' | 'discarded',
  decision: unknown,
  projectId: string | null = null,
): void {
  db.prepare('UPDATE births SET status = ?, decision = ?, project_id = ?, decided_at = ? WHERE id = ?').run(
    status,
    JSON.stringify(decision),
    projectId,
    new Date().toISOString(),
    id,
  );
}

/** Custo das rodadas: as runs de etapa `birth` da sessão do nascimento. */
export function birthCost(db: DatabaseSync, birth: Pick<Birth, 'sessionId'>): number {
  if (!birth.sessionId) return 0;
  const row = db
    .prepare("SELECT coalesce(sum(cost_usd), 0) AS total FROM runs WHERE kind = 'stage' AND stage = 'birth' AND session_id = ?")
    .get(birth.sessionId) as { total: number };
  return row.total;
}

// Onde o projeto nasce -------------------------------------------------------------------

export interface BirthSite {
  root: string;
  /** Já é um repositório git; sem git, a raiz é um diretório vazio. */
  git: boolean;
  /** Repositório com código: o agente parte dele. */
  hasCode: boolean;
  /** A raiz tem `CLAUDE.md`: entra como contexto e nunca é sobrescrito. */
  claudeMd: boolean;
}

export class BirthError extends Error {}

/** Arquivos que não contam para "diretório vazio". */
const IGNORED_ENTRIES = new Set(['.DS_Store']);

/** Raiz do nascimento a partir do cwd; recusa projeto Mabel e diretório com arquivos sem git. */
export function birthSite(cwd: string): BirthSite {
  const root = gitRoot(cwd);
  if (root) {
    if (readConfig(root)) throw new BirthError(`${basename(root)} já é um projeto Mabel; use \`mabel add\` ou \`mabel refinar\`.`);
    return { root, git: true, hasCode: !isEmptyProject(root), claudeMd: existsSync(join(root, 'CLAUDE.md')) };
  }
  const entries = readdirSync(cwd).filter((name) => !IGNORED_ENTRIES.has(name));
  if (entries.length > 0) {
    throw new BirthError('Diretório com arquivos e sem git. Rode `git init` aqui e depois `mabel nascer`.');
  }
  return { root: realpathSync(cwd), git: false, hasCode: false, claudeMd: false };
}

// Prompts --------------------------------------------------------------------------------

function section(title: string, body: string): string[] {
  return body.trim() ? [`## ${title}`, '', body.trim(), ''] : [];
}

const code = (text: string) => `\`${text}\``;

export function catalogText(): string {
  return STACKS.map((stack) => {
    const { framework, setup, verify } = stack.template;
    const commands = [...(setup ? [`setup ${code(setup)}`] : []), `verificação ${verify.map((command) => code(command.command)).join(', ')}`];
    return `- ${code(stack.id)}: ${stack.label}, testes com ${framework.replaceAll('`', '')}; ${commands.join('; ')}`;
  }).join('\n');
}

function detectionText(root: string): string {
  const detected = detectCommands(root);
  const lines = [`Stacks detectadas: ${detected.stacks.length > 0 ? stackLabel(detected.stacks) : 'nenhuma do catálogo'}`];
  lines.push(`setup: ${detected.setup ? code(detected.setup) : 'nenhum'}`);
  lines.push(
    `verificação: ${detected.verify.length > 0 ? detected.verify.map((command) => `${code(command.command)} (${command.name})`).join(', ') : 'nenhum comando'}`,
  );
  return lines.join('\n');
}

function roundText(round: number): string {
  return round >= MAX_ROUNDS
    ? `Rodada ${round} de ${MAX_ROUNDS}, a última: não faça perguntas. Proponha e declare as suposições.`
    : `Rodada ${round} de ${MAX_ROUNDS}. Pergunte só se a resposta mudar a proposta; senão, proponha já.`;
}

/** Prompt da primeira rodada. */
export function birthPrompt(site: BirthSite, description: string, fixed?: Stack): string {
  const situation = site.hasCode
    ? ['Repositório com código, ainda sem o Mabel. Leia o código o quanto precisar.', '', detectionText(site.root)].join('\n')
    : 'Diretório vazio: não há código para ler. Parta só da descrição.';
  return [
    `# Nascimento de ${basename(site.root)}`,
    '',
    ...section('Descrição do humano', description || '(nenhuma: parta do código)'),
    ...section('Situação', situation),
    ...section('Catálogo de stacks', catalogText()),
    ...section('Stack fixada', fixed ? `${code(fixed.id)} (${fixed.label}), escolhida pelo humano: use-a em \`stack\`.` : ''),
    ...section(
      'CLAUDE.md',
      site.claudeMd
        ? 'A raiz já tem `CLAUDE.md` (no contexto do projeto) e ele não será sobrescrito: deixe `claudeMd` vazio e sugira acréscimos em `acrescimosClaudeMd`.'
        : '',
    ),
    '## Tarefa',
    '',
    `${roundText(1)} Não altere arquivos.`,
  ].join('\n');
}

/** Par pergunta e resposta, no formato que vai para a rodada seguinte. */
export interface AnswerPair {
  question: string;
  answer: string;
}

/** Prompt das rodadas seguintes, na mesma sessão: só as respostas e a rodada. */
export function answersPrompt(round: number, pairs: AnswerPair[]): string {
  return [
    '## Respostas do humano',
    '',
    ...pairs.flatMap((pair) => [`P: ${pair.question}`, `R: ${pair.answer}`, '']),
    'Leve as respostas para `decisoes` nos itens que elas afetam ou para o `CLAUDE.md`, como fizer mais sentido.',
    '',
    '## Tarefa',
    '',
    roundText(round),
  ].join('\n');
}

export function correctionPrompt(problems: string[]): string {
  return [
    '## Saída recusada pelo Mabel',
    '',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'Corrija e devolva a saída estruturada completa.',
  ].join('\n');
}

/** Respostas do humano às perguntas da rodada; `null` aceita a sugestão. */
export function answerPairs(questions: Question[], answers: (string | null)[]): AnswerPair[] {
  return questions.map((q, i) => {
    const answer = answers[i]?.trim();
    return { question: q.texto, answer: answer || q.sugestao || DELEGATE };
  });
}

// Validação ------------------------------------------------------------------------------

/** Glob relativo à raiz: nem absoluto, nem com `..`, nem a partir do `~`. */
function relativeGlob(glob: string): boolean {
  return Boolean(glob.trim()) && !isAbsolute(glob) && !glob.startsWith('~') && !glob.split(/[\\/]/).includes('..');
}

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** O que a proposta tem de errado além do esquema; vazio quando está boa. */
export function proposalProblems(proposal: BirthProposal): string[] {
  const problems: string[] = [];
  if (proposal.stack !== OTHER_STACK && !findStack(proposal.stack)) {
    problems.push(`stack "${proposal.stack}" fora do catálogo (${[...STACKS.map((stack) => stack.id), OTHER_STACK].join(', ')})`);
  }
  for (const glob of proposal.regrasCriticas.caminhos) {
    if (!relativeGlob(glob)) problems.push(`caminho crítico "${glob}" não é um glob relativo à raiz`);
  }
  if (proposal.backlog.length === 0) problems.push('backlog vazio');
  if (proposal.backlog.length > MAX_ITEMS) problems.push(`backlog com ${proposal.backlog.length} itens; o máximo é ${MAX_ITEMS}`);
  const concepts = new Set(proposal.regrasCriticas.conceitos.map(normalize));
  proposal.backlog.forEach((item, i) => {
    const position = i + 1;
    if (!item.titulo.trim()) problems.push(`item ${position} sem título`);
    for (const concept of item.regrasCriticas) {
      if (!concepts.has(normalize(concept))) problems.push(`item ${position} cita a regra crítica "${concept}", que não está em regrasCriticas.conceitos`);
    }
    for (const dep of item.dependeDe) {
      if (!Number.isInteger(dep) || dep < 1 || dep >= position) {
        problems.push(`item ${position} depende de ${dep}: dependeDe só aponta para posições anteriores${position > 1 ? ` (1 a ${position - 1})` : ''}`);
      }
    }
  });
  return problems;
}

/** Problemas da saída de uma rodada: esquema, limites de perguntas e, sem perguntas, a proposta. */
export function outputProblems(output: unknown, round: number): string[] {
  const errors = validate(SCHEMAS.birth, output);
  if (errors.length > 0) return [`saída fora do esquema: ${errors.slice(0, 8).join('; ')}`];
  const birth = output as BirthOutput;
  if (birth.perguntas.length > 0) {
    if (round >= MAX_ROUNDS) return ['na última rodada não há perguntas: proponha e declare as suposições'];
    if (birth.perguntas.length > MAX_QUESTIONS) return [`${birth.perguntas.length} perguntas; o máximo é ${MAX_QUESTIONS} por rodada`];
    return [];
  }
  return proposalProblems(birth.proposta);
}

// Run de nascimento ----------------------------------------------------------------------

/**
 * Run da etapa `birth`: sem item, na raiz, só leitura, com as travas das outras etapas
 * (flags herméticas, sandbox, hook de escopo com escopo vazio, conferência do `init` e
 * orçamento de contexto).
 */
export function birthRequest(site: BirthSite, options: BirthOptions, prompt: string, resumeSessionId?: string): RunRequest {
  const context = projectContext(site.root);
  if (context.kind === 'over_budget') throw new BirthError(context.reason.replace(/; ajuste contexto\.maxCaracteres.*$/, ''));
  return {
    kind: 'stage',
    stage: 'birth',
    prompt,
    cwd: site.root,
    model: options.model ?? BIRTH_MODEL,
    maxTurns: BIRTH_LIMITS.maxTurns,
    maxBudgetUsd: BIRTH_LIMITS.maxBudgetUsd,
    permissionMode: 'dontAsk',
    tools: STAGE_TOOLS.birth,
    allowedTools: STAGE_ALLOWED.birth,
    appendSystemPrompt: `${systemPrompt('birth').trimEnd()}\n\n${context.text}`,
    jsonSchema: SCHEMAS.birth,
    settings: { sandbox: birthSandbox(site.root), hooks: scopeHooks() },
    scope: { worktree: site.root, stage: 'birth', escopo: [], criticos: [], criticosAprovados: false },
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}

export type RoundResult = { output: BirthOutput; sessionId: string | null } | { error: string; interrupted?: boolean };

/** Quem mostra a run; sem ele (saída `--json`), a rodada roda calada. */
export interface RoundView {
  log?: ToolLog;
}

async function runOnce(db: DatabaseSync, home: string, request: RunRequest, view: RoundView): Promise<RunOutcome> {
  const { log } = view;
  const handle = startRun(db, home, request, {
    onInit: ({ model }) => log?.write(style.dim(`  ▸ nascer · ${model ?? '?'}`)),
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
export async function runRound(
  db: DatabaseSync,
  home: string,
  site: BirthSite,
  options: BirthOptions,
  prompt: string,
  round: number,
  resumeSessionId: string | undefined,
  view: RoundView = {},
): Promise<RoundResult> {
  let request = birthRequest(site, options, prompt, resumeSessionId);
  for (let attempt = 1; ; attempt++) {
    const outcome = await runOnce(db, home, request, view);
    view.log?.write(style.dim(`  ${summaryLine(outcome)}`));
    if (outcome.status === 'interrupted') return { error: 'nascimento interrompido', interrupted: true };
    if (outcome.status !== 'succeeded') return { error: `a run de nascimento falhou: ${outcome.error ?? 'erro desconhecido'}` };
    const output = outcome.totals?.structuredOutput;
    const problems = output === undefined || output === null ? ['saída estruturada ausente'] : outputProblems(output, round);
    if (problems.length === 0) {
      const birth = output as BirthOutput;
      const fixed = options.stack && findStack(options.stack);
      if (fixed && birth.perguntas.length === 0) birth.proposta = { ...birth.proposta, stack: fixed.id, stackMotivo: 'fixada com --stack' };
      return { output: birth, sessionId: outcome.sessionId };
    }
    if (attempt > 1 || !outcome.sessionId) return { error: `proposta inválida: ${problems.join('; ')}` };
    view.log?.write(style.dim(`  saída recusada (${truncate(problems.join('; '), 120)}); pedindo a correção na mesma sessão`));
    request = birthRequest(site, options, correctionPrompt(problems), outcome.sessionId);
  }
}

// Exibição -------------------------------------------------------------------------------

const INDENT = '  ';

function questionLines(questions: Question[]): string[] {
  const lines: string[] = [];
  for (const [i, q] of questions.entries()) {
    lines.push(`${INDENT}${i + 1}. ${q.texto}${q.regraCritica ? ' (regra crítica)' : ''}`);
    if (q.sugestao) lines.push(`${INDENT}   sugestão: ${q.sugestao}`);
  }
  return lines;
}

function understandingLines(output: BirthOutput): string[] {
  const lines = [style.bold('Entendimento'), ...output.entendimento.trim().split('\n').map((line) => `${INDENT}${line}`)];
  if (output.suposicoes.length > 0) lines.push('', style.bold('Suposições'), ...output.suposicoes.map((entry) => `${INDENT}- ${entry}`));
  return lines;
}

export function stackText(id: string): string {
  const stack = findStack(id);
  return stack ? `${stack.id} (${stack.label})` : 'outra (fora do catálogo)';
}

/** A proposta inteira em texto, sem perguntas: o que a revisão mostra parte a parte. */
export function proposalLines(name: string, output: BirthOutput, site: Pick<BirthSite, 'claudeMd'>): string[] {
  const { proposta } = output;
  const lines = [style.bold(`Proposta para ${name}`), '', ...understandingLines(output), ''];
  lines.push(`${style.bold('Stack:')} ${stackText(proposta.stack)}${proposta.stackMotivo ? ` — ${proposta.stackMotivo}` : ''}`);
  lines.push('');
  if (site.claudeMd) {
    lines.push(style.bold('CLAUDE.md (existente, não é alterado)'));
    if (proposta.acrescimosClaudeMd.length === 0) lines.push(`${INDENT}nenhum acréscimo sugerido`);
    for (const entry of proposta.acrescimosClaudeMd) lines.push(`${INDENT}- ${entry}`);
  } else if (proposta.claudeMd.trim()) {
    const text = proposta.claudeMd.trimEnd().split('\n');
    lines.push(style.bold(`CLAUDE.md (novo, ${text.length} linhas)`), ...text.map((line) => `${INDENT}${line}`));
  } else {
    lines.push(style.bold('CLAUDE.md: nenhum proposto'));
  }
  lines.push('', style.bold('Regras críticas'));
  const { caminhos, conceitos } = proposta.regrasCriticas;
  lines.push(`${INDENT}Caminhos: ${caminhos.length > 0 ? caminhos.join(', ') : 'nenhum'}`);
  lines.push(`${INDENT}Conceitos: ${conceitos.length > 0 ? conceitos.join('; ') : 'nenhum'}`);
  lines.push('', style.bold(`Backlog (${proposta.backlog.length} itens)`));
  for (const [i, item] of proposta.backlog.entries()) {
    lines.push(`${INDENT}${i + 1}. ${item.titulo}`);
    lines.push(`${INDENT}   ${truncate(item.intencao.replace(/\s+/g, ' '), 90)}`);
    const facts = [`critérios: ${item.criterios.length}`];
    if (item.dependeDe.length > 0) facts.push(`depende de: ${item.dependeDe.join(', ')}`);
    if (item.regrasCriticas.length > 0) facts.push(`regras críticas: ${item.regrasCriticas.join('; ')}`);
    lines.push(style.dim(`${INDENT}   ${facts.join(' · ')}`));
  }
  return lines;
}

// Perguntas no terminal ------------------------------------------------------------------

/**
 * Perguntas uma a uma: enter aceita a sugestão, texto responde, `d` deixa a decisão ao
 * agente (salvo em regra crítica, que é decisão humana). Ctrl+C lança `Interrupted`.
 */
export async function askQuestions(io: ReviewIO, output: BirthOutput): Promise<AnswerPair[]> {
  for (const line of understandingLines(output)) io.write(line);
  io.write('');
  io.write(style.bold('Perguntas'));
  const pairs: AnswerPair[] = [];
  for (const [i, q] of output.perguntas.entries()) {
    io.write(`${INDENT}${i + 1}/${output.perguntas.length} ${q.texto}${q.regraCritica ? style.dim(' (regra crítica)') : ''}`);
    if (q.sugestao) io.write(`${INDENT}    sugestão: ${q.sugestao}`);
    const hint = [q.sugestao ? 'enter aceita a sugestão' : '', 'texto responde', q.regraCritica ? '' : 'd decide você'].filter(Boolean).join(' · ');
    for (;;) {
      const answer = (await io.ask(`${INDENT}    › ${style.dim(hint)}: `)).trim();
      if (answer.toLowerCase() === 'd' && !q.regraCritica) {
        pairs.push({ question: q.texto, answer: DELEGATE });
        break;
      }
      const chosen = answer || q.sugestao;
      if (chosen && !(answer.toLowerCase() === 'd')) {
        pairs.push({ question: q.texto, answer: chosen });
        break;
      }
      io.write(style.dim(`${INDENT}    ${q.regraCritica ? 'regra crítica: a resposta é sua' : 'sem sugestão: digite a resposta ou d'}`));
    }
  }
  return pairs;
}

// Fluxo ----------------------------------------------------------------------------------

export interface BirthEnv {
  db: DatabaseSync;
  home: string;
  /** Terminal para perguntas e revisão; ausente fora do TTY. */
  io?: ReviewIO;
  view: RoundView;
}

const out = (line: string) => process.stdout.write(`${line}\n`);

/** Confere o saldo antes de cada rodada; o texto é o motivo da recusa. */
async function balanceBlock(env: BirthEnv): Promise<string | undefined> {
  const { io } = env;
  const confirmLow = io
    ? async (notice: string) => {
        const answer = (await io.ask(`  ${notice}. Rodar mesmo assim? [s/N] `)).trim().toLowerCase();
        return answer.startsWith('s') || answer.startsWith('y');
      }
    : undefined;
  return ensureRefineBalance(env.db, env.home, 'birth', confirmLow);
}

export type StepResult = { birth: Birth } | { error: string; code: number };

/** Primeira rodada: roda o agente e cria o nascimento. */
export async function startBirth(env: BirthEnv, site: BirthSite, description: string, options: BirthOptions): Promise<StepResult> {
  const blocked = await balanceBlock(env);
  if (blocked) return { error: `Nascimento não iniciado: ${blocked}.`, code: blocked === 'interrompido' ? 130 : 1 };
  const fixed = options.stack ? findStack(options.stack) : undefined;
  const result = await runRound(env.db, env.home, site, options, birthPrompt(site, description, fixed), 1, undefined, env.view);
  if ('error' in result) return { error: result.error, code: result.interrupted ? 130 : 1 };
  return { birth: createBirth(env.db, site.root, description, options, result.sessionId, result.output) };
}

/** Rodada seguinte, na mesma sessão, com as respostas às perguntas da anterior. */
export async function answerBirth(env: BirthEnv, birth: Birth, pairs: AnswerPair[]): Promise<StepResult> {
  if (birth.status !== 'asking') return { error: 'Este nascimento não tem perguntas em aberto.', code: 1 };
  const blocked = await balanceBlock(env);
  if (blocked) return { error: `Rodada não iniciada: ${blocked}.`, code: blocked === 'interrompido' ? 130 : 1 };
  const site = siteOf(birth);
  const round = birth.rounds + 1;
  const result = await runRound(env.db, env.home, site, birth.options, answersPrompt(round, pairs), round, birth.sessionId ?? undefined, env.view);
  if ('error' in result) return { error: result.error, code: result.interrupted ? 130 : 1 };
  return { birth: recordRound(env.db, birth, result.sessionId, result.output) };
}

/** Raiz do nascimento como está agora (o `CLAUDE.md` e o código podem ter mudado). */
export function siteOf(birth: Birth): BirthSite {
  const git = gitRoot(birth.root) === birth.root;
  return {
    root: birth.root,
    git,
    hasCode: git && !isEmptyProject(birth.root),
    claudeMd: existsSync(join(birth.root, 'CLAUDE.md')),
  };
}

/**
 * No terminal: perguntas de cada rodada até a proposta, que é mostrada no fim. Ctrl+C
 * deixa o nascimento em aberto.
 */
export async function converse(env: BirthEnv, io: ReviewIO, start: Birth): Promise<number> {
  let birth = start;
  while (birth.status === 'asking' && birth.output) {
    let pairs: AnswerPair[];
    try {
      io.write('');
      io.write(style.dim(`rodada ${birth.rounds} de ${MAX_ROUNDS}`));
      pairs = await askQuestions(io, birth.output);
    } catch (error) {
      if (!(error instanceof Interrupted)) throw error;
      io.write('');
      io.write(style.dim(`interrompido: o nascimento ${shortId(birth.id)} continua em aberto (mabel nascer --lista)`));
      return 130;
    }
    io.write('');
    const result = await answerBirth(env, birth, pairs);
    if ('error' in result) {
      process.stderr.write(`${result.error}\n`);
      if (result.code !== 130) io.write(style.dim(`As perguntas continuam em aberto: rode \`mabel nascer\` de novo aqui.`));
      return result.code;
    }
    birth = result.birth;
  }
  if (birth.status !== 'proposed' || !birth.output) return 0;
  io.write('');
  for (const line of proposalLines(basename(birth.root), birth.output, siteOf(birth))) io.write(line);
  io.write('');
  io.write(style.dim(`Proposta ${shortId(birth.id)} pendente; nada foi gravado. Custo das rodadas: ${formatCost(birthCost(env.db, birth))}.`));
  return 0;
}

export const shortId = (id: string) => id.slice(0, 8);

/** Fora do TTY: o estado do nascimento em texto, com o id para o passo seguinte. */
function printStep(env: BirthEnv, birth: Birth): void {
  if (!birth.output) return;
  out('');
  if (birth.status === 'asking') {
    for (const line of understandingLines(birth.output)) out(line);
    out('');
    out(style.bold(`Perguntas (rodada ${birth.rounds} de ${MAX_ROUNDS})`));
    for (const line of questionLines(birth.output.perguntas)) out(line);
  } else {
    for (const line of proposalLines(basename(birth.root), birth.output, siteOf(birth))) out(line);
  }
  out('');
  out(style.dim(`Nascimento ${birth.id} · custo ${formatCost(birthCost(env.db, birth))}`));
}

// Comando --------------------------------------------------------------------------------

export async function birthCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { stack: { type: 'string' }, modelo: { type: 'string' } },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${birthUsage}\n`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.stack !== undefined && !findStack(values.stack)) {
    process.stderr.write(`Stack desconhecida: ${values.stack}. Use uma destas: ${STACKS.map((stack) => stack.id).join(', ')}.\n`);
    return 1;
  }
  const options: BirthOptions = {
    ...(values.stack ? { stack: values.stack } : {}),
    ...(values.modelo ? { model: values.modelo } : {}),
  };

  const home = dataDir();
  const db = openDb(home);
  try {
    const io = interactive() ? terminalReviewIO : undefined;
    const env: BirthEnv = { db, home, io, view: { log: new ToolLog(process.cwd(), '    ') } };
    const site = birthSite(process.cwd());

    if (io) {
      const pending = openBirths(db, site.root)[0];
      if (pending) {
        const answer = (await io.ask(`Há um nascimento em aberto aqui, de ${formatWhen(pending.createdAt)}. Retomar? [S/n] `)).trim().toLowerCase();
        if (!answer || answer.startsWith('s') || answer.startsWith('y')) return await converse(env, io, pending);
        decideBirth(db, pending.id, 'discarded', { motivo: 'substituído por um novo' });
      }
    }

    let description = positionals.join(' ').trim();
    if (!description && io) {
      description = (await io.ask(`O que é o projeto?${site.hasCode ? ' (enter parte do código)' : ''} `)).trim();
    }
    if (!description && !site.hasCode) {
      process.stderr.write(`Diga o que é o projeto: mabel nascer "<descrição>".\nUso: ${birthUsage}\n`);
      return 1;
    }

    out(style.bold(`Nascimento de ${basename(site.root)}`) + style.dim(` · ${site.hasCode ? 'repositório com código' : 'diretório vazio'}`));
    const result = await startBirth(env, site, description, options);
    if ('error' in result) {
      process.stderr.write(`${result.error}\n`);
      return result.code;
    }
    if (io) return await converse(env, io, result.birth);
    printStep(env, result.birth);
    return 0;
  } catch (error) {
    if (error instanceof Interrupted) return 130;
    if (error instanceof BirthError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}
