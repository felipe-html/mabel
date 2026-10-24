import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Interrupted, interactive } from './ask.ts';
import { dataDir, openDb } from './db.ts';
import { ToolLog, summaryLine } from './exec.ts';
import { formatCost, formatWhen, truncate } from './format.ts';
import { projectContext } from './hermetic.ts';
import { type ItemFields, renderItemBlock } from './backlog.ts';
import { git } from './git.ts';
import { DELEGATE } from './inbox.ts';
import { TEST_BASE_TITLE, createProject } from './init.ts';
import { MABEL_DIR, currentBranch, gitRoot, hasTestCommand, isEmptyProject, readConfig } from './project.ts';
import { type ReviewIO, editList, ensureRefineBalance, terminalReviewIO } from './refine.ts';
import { type RunOutcome, type RunRequest, startRun } from './runner.ts';
import { birthSandbox } from './sandbox.ts';
import type { BirthItem, BirthOutput, BirthProposal, Question } from './schemas/stages.ts';
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

/**
 * O que a proposta tem de errado além do esquema; vazio quando está boa. Na gravação, o
 * backlog pode estar vazio: o humano descartou os itens na revisão.
 */
export function proposalProblems(proposal: BirthProposal, { allowEmptyBacklog = false } = {}): string[] {
  const problems: string[] = [];
  if (proposal.stack !== OTHER_STACK && !findStack(proposal.stack)) {
    problems.push(`stack "${proposal.stack}" fora do catálogo (${[...STACKS.map((stack) => stack.id), OTHER_STACK].join(', ')})`);
  }
  for (const glob of proposal.regrasCriticas.caminhos) {
    if (!relativeGlob(glob)) problems.push(`caminho crítico "${glob}" não é um glob relativo à raiz`);
  }
  if (proposal.backlog.length === 0 && !allowEmptyBacklog) problems.push('backlog vazio');
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

// Revisão --------------------------------------------------------------------------------

/** Terminal da revisão; `edit` abre um texto no editor e devolve o texto salvo. */
export interface BirthIO extends ReviewIO {
  edit?: (text: string) => Promise<string>;
}

/** Abre o texto num arquivo temporário no `$EDITOR` (padrão `vi`) e lê de volta. */
export async function editInEditor(text: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  const path = join(dir, 'CLAUDE.md');
  try {
    writeFileSync(path, text);
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    const result = spawnSync('sh', ['-c', `${editor} "$1"`, 'sh', path], { stdio: 'inherit' });
    if (result.status !== 0) throw new BirthError(`o editor (${editor}) saiu com erro; o CLAUDE.md ficou como estava`);
    return readFileSync(path, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const terminalBirthIO: BirthIO = { ...terminalReviewIO, edit: editInEditor };

export type BirthReview = { kind: 'accept'; proposal: BirthProposal } | { kind: 'keep' } | { kind: 'discard' };

/** O projeto ainda não tem comando de teste: a base de testes entra como item 1. */
export function missingTests(root: string): boolean {
  return !hasTestCommand(detectCommands(root).verify);
}

const PREVIEW_LINES = 12;

async function choice(io: ReviewIO, prompt: string, valid: string[]): Promise<string> {
  for (;;) {
    const answer = (await io.ask(`${INDENT}› ${prompt}: `)).trim().toLowerCase();
    if (valid.includes(answer)) return answer;
    io.write(style.dim(`${INDENT}responda ${valid.map((entry) => entry || 'enter').join(', ')}`));
  }
}

async function reviewStack(io: ReviewIO, proposal: BirthProposal, fixed: boolean): Promise<Pick<BirthProposal, 'stack' | 'stackMotivo'>> {
  io.write('');
  io.write(`${style.bold('Stack:')} ${stackText(proposal.stack)}${proposal.stackMotivo ? ` — ${proposal.stackMotivo}` : ''}`);
  if (fixed) return proposal;
  if ((await choice(io, 'enter aceita · s escolhe outra', ['', 's'])) === '') return proposal;
  const options = [...STACKS.map((stack) => `${stack.id} — ${stack.label}`), `${OTHER_STACK} — fora do catálogo`];
  options.forEach((option, i) => io.write(`${INDENT}${i + 1}. ${option}`));
  for (;;) {
    const answer = Number((await io.ask(`${INDENT}número: `)).trim());
    const stack = Number.isInteger(answer) ? (STACKS[answer - 1]?.id ?? (answer === options.length ? OTHER_STACK : undefined)) : undefined;
    if (stack) return { stack, stackMotivo: 'escolhida na revisão' };
    io.write(style.dim(`${INDENT}escolha de 1 a ${options.length}`));
  }
}

async function reviewClaudeMd(io: BirthIO, proposal: BirthProposal, existing: boolean): Promise<string> {
  io.write('');
  if (existing) {
    io.write(style.bold('CLAUDE.md (existente, não é alterado)'));
    if (proposal.acrescimosClaudeMd.length === 0) io.write(`${INDENT}nenhum acréscimo sugerido`);
    else {
      io.write(style.dim(`${INDENT}acréscimos sugeridos, que não serão gravados:`));
      for (const entry of proposal.acrescimosClaudeMd) io.write(`${INDENT}- ${entry}`);
    }
    return '';
  }
  let text = proposal.claudeMd;
  if (!text.trim()) {
    io.write(style.bold('CLAUDE.md: nenhum proposto'));
    return '';
  }
  const actions = io.edit ? 'enter aceita · v mostra tudo · e edita no $EDITOR · - não cria' : 'enter aceita · v mostra tudo · - não cria';
  for (let full = false; ; ) {
    const lines = text.trimEnd().split('\n');
    io.write(style.bold(`CLAUDE.md (novo, ${lines.length} linhas)`));
    const shown = full ? lines : lines.slice(0, PREVIEW_LINES);
    for (const line of shown) io.write(`${INDENT}${line}`);
    if (shown.length < lines.length) io.write(style.dim(`${INDENT}… mais ${lines.length - shown.length} linhas`));
    const answer = await choice(io, actions, ['', 'v', '-', ...(io.edit ? ['e'] : [])]);
    if (answer === '') return text;
    if (answer === '-') return '';
    if (answer === 'v') full = true;
    if (answer === 'e' && io.edit) {
      try {
        text = await io.edit(text);
      } catch (error) {
        if (!(error instanceof BirthError)) throw error;
        io.write(style.dim(`${INDENT}${error.message}`));
      }
      full = false;
    }
  }
}

/** Edição um a um que lembra o que foi trocado: os itens seguem o conceito renomeado. */
async function editTracked(io: ReviewIO, entries: string[]): Promise<{ kept: string[]; renamed: Map<string, string> }> {
  const renamed = new Map<string, string>();
  io.write(style.dim(`${INDENT}enter mantém · - remove · texto novo substitui`));
  const kept: string[] = [];
  for (const [i, entry] of entries.entries()) {
    io.write(`${INDENT}${i + 1}. ${entry}`);
    const answer = (await io.ask(`${INDENT}   › `)).trim();
    if (answer === '-') continue;
    if (answer && answer !== entry) renamed.set(normalize(entry), answer);
    kept.push(answer || entry);
  }
  io.write(style.dim(`${INDENT}acrescente outros, um por linha (linha vazia encerra)`));
  for (;;) {
    const extra = (await io.ask(`${INDENT}+ `)).trim();
    if (!extra) return { kept, renamed };
    kept.push(extra);
  }
}

async function reviewRules(io: ReviewIO, proposal: BirthProposal): Promise<{ rules: BirthProposal['regrasCriticas']; renamed: Map<string, string> }> {
  const rules = proposal.regrasCriticas;
  io.write('');
  io.write(style.bold('Regras críticas'));
  if (rules.caminhos.length === 0 && rules.conceitos.length === 0) {
    io.write(`${INDENT}nenhuma`);
    return { rules, renamed: new Map() };
  }
  io.write(`${INDENT}Caminhos: ${rules.caminhos.length > 0 ? rules.caminhos.join(', ') : 'nenhum'}`);
  io.write(`${INDENT}Conceitos: ${rules.conceitos.length > 0 ? rules.conceitos.join('; ') : 'nenhum'}`);
  const answer = await choice(io, 'enter aceita · e edita um a um · - descarta', ['', 'e', '-']);
  if (answer === '') return { rules, renamed: new Map() };
  if (answer === '-') return { rules: { caminhos: [], conceitos: [] }, renamed: new Map() };
  io.write(style.bold(`${INDENT}Caminhos`));
  const caminhos = await editList(io, rules.caminhos);
  io.write(style.bold(`${INDENT}Conceitos`));
  const { kept, renamed } = await editTracked(io, rules.conceitos);
  return { rules: { caminhos, conceitos: kept }, renamed };
}

/** Número do item no backlog gravado: a base de testes, quando entra, é o 1. */
const itemNumber = (position: number, offset: number) => position + offset;

function itemLines(item: BirthItem, position: number, offset: number): string[] {
  const deps = item.dependeDe.map((dep) => itemNumber(dep, offset));
  if (offset > 0 && deps.length === 0) deps.push(1);
  const facts = [`critérios: ${item.criterios.length}`];
  if (deps.length > 0) facts.push(`depende de: ${deps.join(', ')}`);
  if (item.regrasCriticas.length > 0) facts.push(`regras críticas: ${item.regrasCriticas.join('; ')}`);
  return [
    `${INDENT}${itemNumber(position, offset)}. ${item.titulo}`,
    `${INDENT}   intenção: ${truncate(item.intencao.replace(/\s+/g, ' '), 80)}`,
    style.dim(`${INDENT}   ${facts.join(' · ')}`),
  ];
}

/** Campos do backlog a partir do item proposto; `dependsOn` continua em posições. */
export function itemFields(item: BirthItem): ItemFields {
  return {
    title: item.titulo.trim(),
    intent: item.intencao.trim(),
    criteria: item.criterios,
    dependsOn: item.dependeDe,
    restrictions: null,
    outOfScope: item.foraDoEscopo,
    decisions: item.decisoes,
    criticalConcepts: item.regrasCriticas,
  };
}

async function editItem(io: ReviewIO, item: BirthItem): Promise<BirthItem> {
  const title = (await io.ask(`${INDENT}   título [${item.titulo}]: `)).trim();
  const intent = (await io.ask(`${INDENT}   intenção [${truncate(item.intencao.replace(/\s+/g, ' '), 60)}]: `)).trim();
  io.write(`${INDENT}   critérios`);
  const criterios = await editList(io, item.criterios);
  return { ...item, titulo: title || item.titulo, intencao: intent || item.intencao, criterios };
}

/**
 * Tira os itens descartados: as posições e as dependências dos que ficam são refeitas, e
 * cada dependência perdida vira um aviso.
 */
export function dropItems(backlog: BirthItem[], keep: boolean[]): { backlog: BirthItem[]; warnings: string[] } {
  const positions = new Map<number, number>();
  let next = 1;
  backlog.forEach((_, i) => {
    if (keep[i]) positions.set(i + 1, next++);
  });
  const warnings: string[] = [];
  const result: BirthItem[] = [];
  backlog.forEach((item, i) => {
    if (!keep[i]) return;
    const dependeDe: number[] = [];
    for (const dep of item.dependeDe) {
      const moved = positions.get(dep);
      if (moved) dependeDe.push(moved);
      else warnings.push(`"${item.titulo}" dependia de "${backlog[dep - 1]?.titulo ?? dep}", descartado; a dependência saiu`);
    }
    result.push({ ...item, dependeDe });
  });
  return { backlog: result, warnings };
}

async function reviewBacklog(io: ReviewIO, backlog: BirthItem[], offset: number): Promise<BirthItem[]> {
  io.write('');
  const head = `Backlog (${backlog.length} ${backlog.length === 1 ? 'item' : 'itens'}${offset > 0 ? `; "${TEST_BASE_TITLE}" entra antes, como item 1` : ''})`;
  io.write(style.bold(head));
  for (const [i, item] of backlog.entries()) for (const line of itemLines(item, i + 1, offset)) io.write(line);
  for (;;) {
    const answer = await choice(io, 'enter aceita · v detalha · e edita · - descarta', ['', 'v', 'e', '-']);
    if (answer === '') return backlog;
    if (answer === '-') return [];
    if (answer === 'v') {
      for (const [i, item] of backlog.entries()) {
        const fields = itemFields(item);
        const deps = fields.dependsOn.map((dep) => itemNumber(dep, offset));
        const block = renderItemBlock({ ...fields, number: itemNumber(i + 1, offset), dependsOn: offset > 0 && deps.length === 0 ? [1] : deps });
        io.write('');
        for (const line of block.trimEnd().split('\n')) io.write(`${INDENT}${line}`);
      }
      io.write('');
      continue;
    }
    const edited: BirthItem[] = [];
    const keep: boolean[] = [];
    for (const [i, item] of backlog.entries()) {
      io.write(`${INDENT}${itemNumber(i + 1, offset)}. ${item.titulo}`);
      const action = await choice(io, 'enter mantém · - descarta · e edita', ['', '-', 'e']);
      keep.push(action !== '-');
      edited.push(action === 'e' ? await editItem(io, item) : item);
    }
    const { backlog: kept, warnings } = dropItems(edited, keep);
    for (const warning of warnings) io.write(style.dim(`${INDENT}aviso: ${warning}`));
    return kept;
  }
}

/** Itens só citam conceitos que ficaram nas regras críticas (com os renomeados trocados). */
function relinkConcepts(backlog: BirthItem[], concepts: string[], renamed: Map<string, string>, io: ReviewIO): BirthItem[] {
  const present = new Set(concepts.map(normalize));
  return backlog.map((item) => {
    const regrasCriticas: string[] = [];
    for (const concept of item.regrasCriticas) {
      const current = renamed.get(normalize(concept)) ?? concept;
      if (present.has(normalize(current))) regrasCriticas.push(current);
      else io.write(style.dim(`${INDENT}aviso: "${item.titulo}" deixa de citar a regra crítica "${concept}", que saiu`));
    }
    return { ...item, regrasCriticas };
  });
}

/**
 * Revisão no terminal, parte a parte: stack, `CLAUDE.md`, regras críticas e backlog, e a
 * gravação. `n` deixa a proposta pendente; `d` a descarta.
 */
export async function reviewBirth(io: BirthIO, birth: Birth, site: BirthSite): Promise<BirthReview> {
  const output = birth.output as BirthOutput;
  const proposal = output.proposta;
  io.write(style.bold(`Proposta para ${basename(birth.root)}`));
  io.write('');
  for (const line of understandingLines(output)) io.write(line);

  const stack = await reviewStack(io, proposal, Boolean(birth.options.stack));
  const claudeMd = await reviewClaudeMd(io, proposal, site.claudeMd);
  const { rules, renamed } = await reviewRules(io, proposal);
  const offset = missingTests(site.root) ? 1 : 0;
  let backlog = relinkConcepts(proposal.backlog, rules.conceitos, renamed, io);
  backlog = await reviewBacklog(io, backlog, offset);

  io.write('');
  for (;;) {
    const answer = (await io.ask('Gravar? [S/n/d] (n deixa a proposta pendente · d descarta) ')).trim().toLowerCase();
    if (!answer || answer.startsWith('s') || answer.startsWith('y')) {
      return { kind: 'accept', proposal: { ...proposal, ...stack, claudeMd, regrasCriticas: rules, backlog } };
    }
    if (answer.startsWith('n')) return { kind: 'keep' };
    if (answer.startsWith('d')) return { kind: 'discard' };
  }
}

// Gravação -------------------------------------------------------------------------------

export interface BirthSaved {
  project: { id: string; name: string; root: string };
  /** Arquivos criados, relativos à raiz. */
  files: string[];
  gitInit: boolean;
  items: number;
  noTests: boolean;
  /** Números dos itens com regra crítica. */
  criticalItems: number[];
  rules: { paths: number; concepts: number };
  /** Branch do commit "mabel nascer", ou o motivo de ele não ter saído. */
  commit: { branch: string } | { error: string };
  costUsd: number;
}

export const BIRTH_COMMIT = 'mabel nascer';

/**
 * Grava a proposta aceita pelo caminho do `init` (com a stack aceita), o `CLAUDE.md` só se
 * ainda não existir, e commita na branch atual só o `.mabel/` e o `CLAUDE.md` criado (G10).
 * Num diretório vazio sem git, roda `git init -b main` antes.
 */
export function saveBirth(db: DatabaseSync, birth: Birth, proposal: BirthProposal): BirthSaved {
  if (birth.status !== 'proposed') throw new BirthError(`O nascimento ${shortId(birth.id)} não tem proposta pendente.`);
  const problems = proposalProblems(proposal, { allowEmptyBacklog: true });
  if (problems.length > 0) throw new BirthError(`Proposta inválida: ${problems.join('; ')}.`);
  const { root } = birth;
  if (!existsSync(root)) throw new BirthError(`${root} não existe mais.`);
  let gitInit = false;
  const repo = gitRoot(root);
  if (repo && readConfig(repo)) throw new BirthError(`${basename(repo)} já é um projeto Mabel; nada foi gravado.`);
  if (repo !== root) {
    if (repo) throw new BirthError(`${root} passou a ficar dentro do repositório ${repo}; nada foi gravado.`);
    if (readdirSync(root).some((name) => !IGNORED_ENTRIES.has(name))) {
      throw new BirthError(`${root} ganhou arquivos e continua sem git; rode \`git init\` e depois \`mabel nascer\`.`);
    }
    git(root, 'init', '-q', '-b', 'main');
    gitInit = true;
  }

  const stack = findStack(proposal.stack);
  const { setup, verify } = detectCommands(root);
  const created = createProject(db, root, {
    ...(stack ? { stack } : { other: '' }),
    setup,
    verify,
    criticalRules: { paths: proposal.regrasCriticas.caminhos, concepts: proposal.regrasCriticas.conceitos },
    items: proposal.backlog.map(itemFields),
  });
  const files = [...created.files];
  // Conferido de novo agora: o `CLAUDE.md` do humano nunca é sobrescrito.
  const claudePath = join(root, 'CLAUDE.md');
  if (proposal.claudeMd.trim() && !existsSync(claudePath)) {
    writeFileSync(claudePath, `${proposal.claudeMd.trimEnd()}\n`);
    files.push('CLAUDE.md');
  }
  decideBirth(db, birth.id, 'accepted', proposal, created.config.projectId);

  const branch = currentBranch(root);
  const paths = [MABEL_DIR, ...(files.includes('CLAUDE.md') ? ['CLAUDE.md'] : [])];
  let commit: BirthSaved['commit'];
  try {
    git(root, 'add', '--', ...paths);
    git(root, 'commit', '-q', '-m', BIRTH_COMMIT, '--', ...paths);
    commit = { branch };
  } catch (error) {
    commit = { error: (error as Error).message.split('\n')[0] ?? 'git commit falhou' };
  }

  const offset = created.noTests ? 1 : 0;
  return {
    project: { id: created.config.projectId, name: basename(root), root },
    files,
    gitInit,
    items: proposal.backlog.length + offset,
    noTests: created.noTests,
    criticalItems: proposal.backlog.flatMap((item, i) => (item.regrasCriticas.length > 0 ? [i + 1 + offset] : [])),
    rules: { paths: proposal.regrasCriticas.caminhos.length, concepts: proposal.regrasCriticas.conceitos.length },
    commit,
    costUsd: birthCost(db, birth),
  };
}

export function savedLines(saved: BirthSaved): string[] {
  const lines = [`✓ ${style.bold(saved.project.name)} nasceu no Mabel · ${saved.project.root}`];
  if (saved.gitInit) lines.push(`${INDENT}git init -b main: o diretório era vazio e não tinha git`);
  lines.push(`${INDENT}arquivos: ${saved.files.join(', ')}`);
  lines.push(`${INDENT}backlog: ${saved.items} ${saved.items === 1 ? 'item' : 'itens'}${saved.noTests ? ` (o 1 é "${TEST_BASE_TITLE}")` : ''}`);
  lines.push(`${INDENT}regras críticas: ${saved.rules.paths} ${saved.rules.paths === 1 ? 'caminho' : 'caminhos'} · ${saved.rules.concepts} ${saved.rules.concepts === 1 ? 'conceito' : 'conceitos'}`);
  if ('branch' in saved.commit) lines.push(`${INDENT}commit "${BIRTH_COMMIT}" na branch ${saved.commit.branch}`);
  else {
    lines.push(`${INDENT}aviso: o commit não saiu (${saved.commit.error})`);
    lines.push(`${INDENT}commite com \`git add .mabel CLAUDE.md && git commit -m "${BIRTH_COMMIT}" -- .mabel CLAUDE.md\` antes do \`mabel run\``);
  }
  lines.push(`${INDENT}custo das rodadas: ${formatCost(saved.costUsd)}`);
  lines.push('');
  lines.push(
    saved.criticalItems.length > 0
      ? `Próximo passo: \`mabel refinar\` nos itens com regra crítica (${saved.criticalItems.map((n) => `#${n}`).join(', ')}), depois \`mabel run\`.`
      : 'Próximo passo: `mabel refinar` nos itens que pedirem detalhe, depois `mabel run`.',
  );
  return lines;
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
export async function converse(env: BirthEnv, io: BirthIO, start: Birth): Promise<number> {
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
  let review: BirthReview;
  try {
    review = await reviewBirth(io, birth, siteOf(birth));
  } catch (error) {
    if (!(error instanceof Interrupted)) throw error;
    io.write('');
    io.write(style.dim(`interrompido: a proposta ${shortId(birth.id)} continua pendente (mabel nascer --lista)`));
    return 130;
  }
  if (review.kind === 'keep') {
    io.write(style.dim(`Proposta ${shortId(birth.id)} mantida pendente; nada gravado. Custo das rodadas: ${formatCost(birthCost(env.db, birth))}.`));
    return 0;
  }
  if (review.kind === 'discard') {
    decideBirth(env.db, birth.id, 'discarded', { motivo: 'descartada na revisão' });
    io.write(`Proposta ${shortId(birth.id)} descartada; nada gravado.`);
    return 0;
  }
  const saved = saveBirth(env.db, birth, review.proposal);
  io.write('');
  for (const line of savedLines(saved)) io.write(line);
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
    const io = interactive() ? terminalBirthIO : undefined;
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
