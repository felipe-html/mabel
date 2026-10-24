import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Interrupted } from '../src/ask.ts';
import {
  type BirthEnv,
  BirthError,
  answerBirth,
  answerPairs,
  birthSite,
  converse,
  findBirth,
  openBirths,
  outputProblems,
  proposalProblems,
  startBirth,
} from '../src/birth.ts';
import { openDb } from '../src/db.ts';
import { tableScope } from '../src/projects.ts';
import type { ReviewIO } from '../src/refine.ts';
import type { BirthOutput, BirthProposal } from '../src/schemas/stages.ts';
import { CLI, makeRepo, setupProject, useScenario } from './helpers.ts';

const PROPOSAL: BirthProposal = {
  stack: 'node',
  stackMotivo: 'o time já usa TypeScript',
  claudeMd: '# Férias do time\n\nApp de controle de férias.\n',
  acrescimosClaudeMd: [],
  regrasCriticas: { caminhos: ['src/aprovacoes/**'], conceitos: ['Saldo de férias nunca fica negativo'] },
  backlog: [
    {
      titulo: 'Cadastro de pessoas do time',
      intencao: 'Cadastrar quem tira férias.',
      criterios: ['Pessoa cadastrada aparece na lista'],
      foraDoEscopo: [],
      decisoes: [],
      regrasCriticas: [],
      dependeDe: [],
    },
    {
      titulo: 'Pedido de férias',
      intencao: 'A pessoa pede um período de férias.',
      criterios: ['Pedido acima do saldo é recusado'],
      foraDoEscopo: ['Aprovação pelo gestor'],
      decisoes: [],
      regrasCriticas: ['Saldo de férias nunca fica negativo'],
      dependeDe: [1],
    },
  ],
};

const QUESTIONS: BirthOutput = {
  entendimento: 'Um app para o time controlar férias.',
  perguntas: [
    { texto: 'Quem aprova as férias?', sugestao: 'O gestor direto', regraCritica: false },
    { texto: 'Pode tirar férias com saldo negativo?', sugestao: 'Não', regraCritica: true },
    { texto: 'Qual o login?', sugestao: '', regraCritica: false },
  ],
  suposicoes: [],
  proposta: { ...PROPOSAL, backlog: [] },
};

const PROPOSED: BirthOutput = {
  entendimento: 'Um app para o time controlar férias.',
  perguntas: [],
  suposicoes: ['Login pelo Google Workspace da empresa'],
  proposta: PROPOSAL,
};

/** Leitura de saldo recente e folgada: a rodada não faz a chamada mínima. */
function seedBalance(db: DatabaseSync) {
  const now = Date.now();
  const insert = db.prepare('INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)');
  insert.run(new Date(now).toISOString(), 'five_hour', 0.1, new Date(now + 3 * 3600_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.1, new Date(now + 6 * 86400_000).toISOString(), 'allowed');
}

/** Respostas roteirizadas, na ordem; `null` simula ctrl+c. */
function scriptedIO(answers: (string | null)[]): ReviewIO & { lines: string[]; prompts: string[] } {
  const lines: string[] = [];
  const prompts: string[] = [];
  return {
    lines,
    prompts,
    write: (line) => lines.push(line),
    ask: async (prompt) => {
      prompts.push(prompt);
      if (answers.length === 0) throw new Error(`pergunta sem resposta roteirizada: ${prompt}`);
      const answer = answers.shift() as string | null;
      if (answer === null) throw new Interrupted();
      return answer;
    },
  };
}

/** Diretório vazio, sem git, com `MABEL_HOME` próprio e o banco aberto. */
function emptyDir() {
  const root = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const db = openDb(home);
  seedBalance(db);
  const env: BirthEnv = { db, home, view: {} };
  return { root, home, db, env };
}

/** Diretório dos cenários, fora da raiz do nascimento (que precisa estar vazia). */
const scratch = () => mkdtempSync(join(tmpdir(), 'mabel-cenario-'));

const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test('birthSite: diretório vazio sem git, repositório com código, recusas', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  writeFileSync(join(empty, '.DS_Store'), '');
  assert.deepEqual({ ...birthSite(empty), root: '' }, { root: '', git: false, hasCode: false, claudeMd: false });

  const loose = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  writeFileSync(join(loose, 'notas.txt'), 'x');
  assert.throws(() => birthSite(loose), (error: Error) => error instanceof BirthError && /com arquivos e sem git/.test(error.message));

  const repo = makeRepo({ 'src/index.ts': 'export {};\n', 'CLAUDE.md': '# Regras\n' });
  assert.deepEqual({ ...birthSite(repo), root: '' }, { root: '', git: true, hasCode: true, claudeMd: true });

  const { root } = setupProject();
  assert.throws(() => birthSite(root), /já é um projeto Mabel; use `mabel add` ou `mabel refinar`/);
});

test('rodadas: etapa birth hermética e só leitura; a segunda retoma a sessão com as respostas', async () => {
  const { root, db, env } = emptyDir();
  const scenario = useScenario(scratch(), [
    { structured_output: QUESTIONS, session_id: 'sessao-nascer', cost: 0.12 },
    { structured_output: PROPOSED, cost: 0.2 },
  ]);
  const site = birthSite(root);
  const first = await startBirth(env, site, 'um app de controle de férias do time', {});
  assert.ok('birth' in first, JSON.stringify(first));
  assert.equal(first.birth.status, 'asking');
  assert.equal(first.birth.rounds, 1);
  assert.equal(first.birth.sessionId, 'sessao-nascer');

  const [call] = scenario.log();
  assert.ok(call);
  assert.equal(call.cwd, site.root);
  assert.equal(arg(call.argv, '--tools'), 'Read,Glob,Grep');
  assert.equal(arg(call.argv, '--allowedTools'), 'Read,Glob,Grep');
  assert.equal(arg(call.argv, '--model'), 'sonnet');
  assert.equal(arg(call.argv, '--max-turns'), '40');
  assert.equal(arg(call.argv, '--max-budget-usd'), '2');
  assert.equal(arg(call.argv, '--permission-mode'), 'dontAsk');
  for (const flag of ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--json-schema']) assert.ok(call.argv.includes(flag), flag);
  const settings = JSON.parse(readFileSync(arg(call.argv, '--settings') as string, 'utf8'));
  assert.equal(settings.sandbox.enabled, true);
  assert.deepEqual(settings.sandbox.network.allowedDomains, []);
  assert.ok(settings.hooks.PreToolUse);
  assert.match(call.argv.at(-1) as string, /um app de controle de férias do time/);
  assert.match(call.argv.at(-1) as string, /Diretório vazio/);
  assert.match(call.argv.at(-1) as string, /`node`: Node\/TypeScript/);
  assert.match(arg(call.argv, '--append-system-prompt') as string, /Papel: nascimento/);

  // Auditada (G1): run de etapa sem item, ligada ao nascimento pela sessão.
  const run = db.prepare("SELECT * FROM runs WHERE stage = 'birth'").get() as { kind: string; item_id: string | null; session_id: string; status: string };
  assert.deepEqual([run.kind, run.item_id, run.session_id, run.status], ['stage', null, 'sessao-nascer', 'succeeded']);

  const pairs = answerPairs(QUESTIONS.perguntas, [null, 'Nunca', null]);
  assert.deepEqual(
    pairs.map((pair) => pair.answer),
    ['O gestor direto', 'Nunca', 'decida e registre como suposição.'],
  );
  const second = await answerBirth(env, first.birth, pairs);
  assert.ok('birth' in second, JSON.stringify(second));
  assert.equal(second.birth.status, 'proposed');
  assert.equal(second.birth.rounds, 2);
  const resumed = scenario.log()[1];
  assert.equal(arg(resumed?.argv ?? [], '--resume'), 'sessao-nascer');
  assert.match(resumed?.argv.at(-1) ?? '', /P: Quem aprova as férias\?\nR: O gestor direto/);
  assert.match(resumed?.argv.at(-1) ?? '', /Rodada 2 de 3/);
  assert.equal(openBirths(db, site.root)[0]?.id, first.birth.id);
  const found = findBirth(db, first.birth.id.slice(0, 6));
  assert.ok(typeof found !== 'string' && found.id === first.birth.id);
});

test('validação: conceito inexistente, dependência para frente, stack e glob', () => {
  const bad: BirthProposal = {
    ...PROPOSAL,
    stack: 'elixir',
    regrasCriticas: { caminhos: ['/etc/**', '../fora/**'], conceitos: [] },
    backlog: [{ ...(PROPOSAL.backlog[1] as BirthProposal['backlog'][number]), dependeDe: [1] }],
  };
  const problems = proposalProblems(bad);
  assert.equal(problems.length, 5, problems.join('\n'));
  assert.match(problems.join('\n'), /stack "elixir" fora do catálogo/);
  assert.match(problems.join('\n'), /"\/etc\/\*\*" não é um glob relativo/);
  assert.match(problems.join('\n'), /"\.\.\/fora\/\*\*" não é um glob relativo/);
  assert.match(problems.join('\n'), /cita a regra crítica "Saldo de férias nunca fica negativo"/);
  assert.match(problems.join('\n'), /item 1 depende de 1: dependeDe só aponta para posições anteriores/);
  assert.deepEqual(proposalProblems(PROPOSAL), []);
  assert.deepEqual(proposalProblems({ ...PROPOSAL, stack: 'outra' }), []);

  assert.deepEqual(outputProblems(QUESTIONS, 2), []);
  assert.match(outputProblems(QUESTIONS, 3).join(), /última rodada não há perguntas/);
  const many = { ...QUESTIONS, perguntas: Array.from({ length: 6 }, () => QUESTIONS.perguntas[0]) };
  assert.match(outputProblems(many, 1).join(), /6 perguntas; o máximo é 5/);
  assert.match(outputProblems({ ...PROPOSED, extra: 1 }, 1).join(), /fora do esquema/);
});

test('terceira rodada: perguntas e proposta inválida pedem correção na mesma sessão, uma vez', async () => {
  const { root, db, env } = emptyDir();
  const scenario = useScenario(scratch(), [
    { structured_output: QUESTIONS, session_id: 'sessao-3' },
    { structured_output: QUESTIONS },
    { structured_output: QUESTIONS },
    { structured_output: PROPOSED },
  ]);
  const site = birthSite(root);
  const first = await startBirth(env, site, 'férias', {});
  assert.ok('birth' in first);
  const second = await answerBirth(env, first.birth, answerPairs(QUESTIONS.perguntas, []));
  assert.ok('birth' in second && second.birth.status === 'asking');
  const third = await answerBirth(env, second.birth, answerPairs(QUESTIONS.perguntas, []));
  assert.ok('birth' in third, JSON.stringify(third));
  assert.equal(third.birth.status, 'proposed');
  assert.equal(third.birth.rounds, 3);

  const calls = scenario.log();
  assert.equal(calls.length, 4);
  assert.ok(calls.slice(1).every((call) => arg(call.argv, '--resume') === 'sessao-3'));
  assert.match(calls[2]?.argv.at(-1) ?? '', /a última: não faça perguntas/);
  assert.match(calls[3]?.argv.at(-1) ?? '', /Saída recusada pelo Mabel[\s\S]*última rodada não há perguntas/);

  // Dependência para frente na primeira rodada: a correção também é na mesma sessão.
  const forward = { ...PROPOSAL, backlog: [{ ...(PROPOSAL.backlog[0] as BirthProposal['backlog'][number]), dependeDe: [2] }, PROPOSAL.backlog[1]] };
  const other = useScenario(scratch(), [{ structured_output: { ...PROPOSED, proposta: forward }, session_id: 'sessao-f' }, { structured_output: PROPOSED }]);
  const fixed = await startBirth(env, birthSite(mkdtempSync(join(tmpdir(), 'mabel-nascer-'))), 'férias', {});
  assert.ok('birth' in fixed && fixed.birth.status === 'proposed', JSON.stringify(fixed));
  assert.equal(arg(other.log()[1]?.argv ?? [], '--resume'), 'sessao-f');
  assert.match(other.log()[1]?.argv.at(-1) ?? '', /item 1 depende de 2: dependeDe só aponta para posições anteriores\n/);
  assert.equal((db.prepare("SELECT count(*) AS n FROM runs WHERE stage = 'birth'").get() as { n: number }).n, 6);
});

test('correção que falha de novo: a rodada falha com o motivo e nada é gravado', async () => {
  const { root, db, env } = emptyDir();
  const bad = { ...PROPOSED, proposta: { ...PROPOSAL, stack: 'elixir' } };
  useScenario(scratch(), [{ structured_output: bad }, { structured_output: bad }]);
  const result = await startBirth(env, birthSite(root), 'férias', {});
  assert.ok('error' in result);
  assert.match(result.error, /proposta inválida: stack "elixir" fora do catálogo/);
  assert.equal((db.prepare('SELECT count(*) AS n FROM births').get() as { n: number }).n, 0);
});

test('repositório com código: detecção do init e CLAUDE.md existente no contexto; --modelo e --stack', async () => {
  const root = makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'src/a.ts': '', 'CLAUDE.md': '# Regras da casa\n\nNada de any.\n' });
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const db = openDb(home);
  seedBalance(db);
  const scenario = useScenario(scratch(), [{ structured_output: { ...PROPOSED, proposta: { ...PROPOSAL, stack: 'python' } } }]);
  const result = await startBirth({ db, home, view: {} }, birthSite(root), '', { model: 'opus', stack: 'node' });
  assert.ok('birth' in result, JSON.stringify(result));
  const [call] = scenario.log();
  const prompt = call?.argv.at(-1) ?? '';
  assert.match(prompt, /Repositório com código/);
  assert.match(prompt, /Stacks detectadas: Node\/TypeScript/);
  assert.match(prompt, /`npm test` \(test\)/);
  assert.match(prompt, /parta do código/);
  assert.match(prompt, /`node` \(Node\/TypeScript\), escolhida pelo humano/);
  assert.match(prompt, /deixe `claudeMd` vazio/);
  assert.match(arg(call?.argv ?? [], '--append-system-prompt') ?? '', /Nada de any\./);
  assert.equal(arg(call?.argv ?? [], '--model'), 'opus');
  // A stack fixada vale sobre a proposta.
  assert.equal(result.birth.output?.proposta.stack, 'node');
});

test('terminal: perguntas uma a uma, rodada seguinte e a proposta mostrada sem gravar; ctrl+c deixa em aberto', async () => {
  const { root, db, env } = emptyDir();
  const scenario = useScenario(scratch(), [{ structured_output: QUESTIONS, session_id: 's-tty' }, { structured_output: PROPOSED }]);
  const first = await startBirth(env, birthSite(root), 'férias', {});
  assert.ok('birth' in first);

  // `d` em regra crítica não vale: a resposta é do humano.
  const interrupted = scriptedIO(['', 'd', null]);
  assert.equal(await converse({ ...env, io: interrupted }, interrupted, first.birth), 130);
  assert.ok(interrupted.lines.some((line) => /regra crítica: a resposta é sua/.test(line)));
  assert.ok(interrupted.lines.some((line) => /continua em aberto/.test(line)));
  assert.equal(scenario.log().length, 1);

  const io = scriptedIO(['', 'Nunca', 'd']);
  assert.equal(await converse({ ...env, io }, io, first.birth), 0);
  assert.match(scenario.log()[1]?.argv.at(-1) ?? '', /R: O gestor direto\n\nP: Pode tirar férias com saldo negativo\?\nR: Nunca\n\nP: Qual o login\?\nR: decida e registre como suposição\./);
  const text = io.lines.join('\n');
  assert.match(text, /Proposta para/);
  assert.match(text, /Login pelo Google Workspace/);
  assert.match(text, /Stack:.*node \(Node\/TypeScript\) — o time já usa TypeScript/);
  assert.match(text, /CLAUDE\.md \(novo, 3 linhas\)/);
  assert.match(text, /Conceitos: Saldo de férias nunca fica negativo/);
  assert.match(text, /2\. Pedido de férias[\s\S]*depende de: 1/);
  assert.equal((db.prepare('SELECT status FROM births').get() as { status: string }).status, 'proposed');
});

test('cli sem TTY: diretório vazio sem descrição sai com 1; com descrição, escreve as perguntas e o id', () => {
  const root = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  seedBalance(openDb(home));
  const scenario = join(root, '..', `cenario-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(scenario, JSON.stringify({ responses: [{ structured_output: QUESTIONS }] }));
  const env = { ...process.env, MABEL_HOME: home, NO_COLOR: '1', MABEL_CLAUDE_BIN: join(import.meta.dirname, 'fixtures', 'fake-claude.mjs'), FAKE_CLAUDE_SCENARIO: scenario };
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'nascer', ...args], { cwd: root, encoding: 'utf8', env });

  const missing = cli();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Diga o que é o projeto/);

  const result = cli('um app de férias');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Perguntas \(rodada 1 de 3\)/);
  assert.match(result.stdout, /1\. Quem aprova as férias\?\n {5}sugestão: O gestor direto/);
  assert.match(result.stdout, /Nascimento [0-9a-f-]{36}/);
});

test('births classificada para a remoção de projeto', () => {
  assert.deepEqual(tableScope.births, { scope: 'project', where: 'project_id = ?' });
  const order = Object.keys(tableScope);
  assert.ok(order.indexOf('births') < order.indexOf('projects'));
});
