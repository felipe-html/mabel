import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Interrupted } from '../src/ask.ts';
import {
  type BirthEnv,
  BirthError,
  type BirthIO,
  answerBirth,
  dropItems,
  reviewBirth,
  saveBirth,
  savedLines,
  siteOf,
  answerPairs,
  birthSite,
  converse,
  findBirth,
  getBirth,
  openBirths,
  outputProblems,
  proposalProblems,
  startBirth,
} from '../src/birth.ts';
import { openDb } from '../src/db.ts';
import { tableScope } from '../src/projects.ts';
import type { ReviewIO } from '../src/refine.ts';
import type { BirthOutput, BirthProposal } from '../src/schemas/stages.ts';
import { parseBacklog } from '../src/backlog.ts';
import { readConfig, readCriticalRules } from '../src/project.ts';
import { CLI, makeRepo, setupProject, useScenario } from './helpers.ts';

// O commit do `nascer` num repositório recém-criado precisa de autor.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Teste',
  GIT_AUTHOR_EMAIL: 'teste@example.com',
  GIT_COMMITTER_NAME: 'Teste',
  GIT_COMMITTER_EMAIL: 'teste@example.com',
});

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

  // Depois das perguntas, a revisão: enter em cada parte e `n` deixa a proposta pendente.
  const io = scriptedIO(['', 'Nunca', 'd', '', '', '', '', 'n']);
  assert.equal(await converse({ ...env, io }, io, first.birth), 0);
  assert.match(scenario.log()[1]?.argv.at(-1) ?? '', /R: O gestor direto\n\nP: Pode tirar férias com saldo negativo\?\nR: Nunca\n\nP: Qual o login\?\nR: decida e registre como suposição\./);
  const text = io.lines.join('\n');
  assert.match(text, /Proposta para/);
  assert.match(text, /Login pelo Google Workspace/);
  assert.match(text, /Stack:.*node \(Node\/TypeScript\) — o time já usa TypeScript/);
  assert.match(text, /CLAUDE\.md \(novo, 3 linhas\)/);
  assert.match(text, /Conceitos: Saldo de férias nunca fica negativo/);
  assert.match(text, /Backlog \(2 itens; "Estabelecer base de testes" entra antes, como item 1\)/);
  assert.match(text, /3\. Pedido de férias[\s\S]*depende de: 2/);
  assert.match(text, /mantida pendente; nada gravado/);
  assert.equal((db.prepare('SELECT status FROM births').get() as { status: string }).status, 'proposed');
  assert.equal(existsSync(join(root, '.mabel')), false);
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

const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();

/** Nascimento com a proposta pronta, num diretório vazio sem git. */
async function proposed(output: BirthOutput = PROPOSED, dir?: string) {
  const ctx = emptyDir();
  const root = dir ?? ctx.root;
  useScenario(scratch(), [{ structured_output: output, cost: 0.25 }]);
  const result = await startBirth(ctx.env, birthSite(root), 'férias', {});
  assert.ok('birth' in result, JSON.stringify(result));
  return { ...ctx, root, birth: result.birth };
}

test('revisão aceita tudo: git init, .mabel/ pelo init, base de testes como item 1, CLAUDE.md e commit', async () => {
  const { root, db, birth } = await proposed();
  const io = scriptedIO(['', '', '', 'v', '', '']) as BirthIO & ReturnType<typeof scriptedIO>;
  const review = await reviewBirth(io, birth, siteOf(birth));
  assert.equal(review.kind, 'accept');
  assert.ok(review.kind === 'accept');
  const saved = saveBirth(db, birth, review.proposal);

  assert.equal(saved.gitInit, true);
  assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.deepEqual(saved.files.sort(), ['.mabel/.gitignore', '.mabel/backlog.md', '.mabel/config.json', '.mabel/regras-criticas.md', 'CLAUDE.md']);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), PROPOSAL.claudeMd);
  assert.deepEqual(readCriticalRules(root), { paths: ['src/aprovacoes/**'], concepts: ['Saldo de férias nunca fica negativo'] });
  assert.equal(readConfig(root)?.projectId, saved.project.id);
  assert.ok(readConfig(root)?.rede?.includes('registry.npmjs.org'));

  const items = parseBacklog(readFileSync(join(root, '.mabel', 'backlog.md'), 'utf8'));
  assert.deepEqual(
    items.map((item) => [item.number, item.title, item.dependsOn]),
    [
      [1, 'Estabelecer base de testes', []],
      [2, 'Cadastro de pessoas do time', [1]],
      [3, 'Pedido de férias', [2]],
    ],
  );
  assert.deepEqual(items[2]?.criticalConcepts, ['Saldo de férias nunca fica negativo']);
  assert.deepEqual(items[2]?.outOfScope, ['Aprovação pelo gestor']);

  // Só o `.mabel/` e o `CLAUDE.md` no commit.
  assert.equal(git(root, 'log', '--format=%s'), 'mabel nascer');
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    '.mabel/.gitignore',
    '.mabel/backlog.md',
    '.mabel/config.json',
    '.mabel/regras-criticas.md',
    'CLAUDE.md',
  ]);
  assert.deepEqual(saved.commit, { branch: 'main' });
  const row = getBirth(db, birth.id);
  assert.equal(row?.status, 'accepted');
  assert.equal(row?.projectId, saved.project.id);
  assert.deepEqual((row?.decision as BirthProposal).backlog.length, 2);
  assert.equal(saved.costUsd, 0.25);
  assert.deepEqual(saved.criticalItems, [3]);
  const summary = savedLines(saved).join('\n');
  assert.match(summary, /git init -b main: o diretório era vazio/);
  assert.match(summary, /backlog: 3 itens \(o 1 é "Estabelecer base de testes"\)/);
  assert.match(summary, /regras críticas: 1 caminho · 1 conceito/);
  assert.match(summary, /commit "mabel nascer" na branch main/);
  assert.match(summary, /mabel refinar` nos itens com regra crítica \(#3\), depois `mabel run`/);
  // `v` mostrou o bloco de cada item como ele vai para o backlog.
  assert.match(io.lines.join('\n'), /## Pedido de férias\n {2}id: 3[\s\S]*Depende de: 2/);
});

test('revisão edita: outra stack, CLAUDE.md no editor, conceito renomeado e item descartado sai das dependências', async () => {
  const { root, db, birth } = await proposed();
  const answers = [
    's', '2', // stack: python
    'e', '', // CLAUDE.md: edita e aceita
    'e', '', '', 'Saldo nunca negativo', 'Só o gestor aprova', '', // regras: caminho mantido, conceito trocado, um novo
    'e', '-', 'e', 'Pedir férias', '', 'Pedido sem saldo é recusado', '', // backlog: descarta o 1, edita o 2
    's',
  ];
  const io = Object.assign(scriptedIO(answers), { edit: async (text: string) => `${text}\nEditado no editor.\n` });
  const review = await reviewBirth(io, birth, siteOf(birth));
  assert.ok(review.kind === 'accept');
  assert.equal(review.proposal.stack, 'python');
  assert.match(review.proposal.claudeMd, /Editado no editor\./);
  assert.deepEqual(review.proposal.regrasCriticas.conceitos, ['Saldo nunca negativo', 'Só o gestor aprova']);
  assert.deepEqual(review.proposal.backlog.map((item) => [item.titulo, item.dependeDe, item.regrasCriticas, item.criterios]), [
    ['Pedir férias', [], ['Saldo nunca negativo'], ['Pedido sem saldo é recusado']],
  ]);
  assert.match(io.lines.join('\n'), /aviso: "Pedir férias" dependia de "Cadastro de pessoas do time", descartado; a dependência saiu/);

  const saved = saveBirth(db, birth, review.proposal);
  const items = parseBacklog(readFileSync(join(root, '.mabel', 'backlog.md'), 'utf8'));
  assert.deepEqual(items.map((item) => [item.number, item.title, item.dependsOn]), [
    [1, 'Estabelecer base de testes', []],
    [2, 'Pedir férias', [1]],
  ]);
  assert.match(items[0]?.intent ?? '', /pytest/);
  assert.ok(readConfig(root)?.rede?.includes('pypi.org'));
  assert.equal(saved.items, 2);
});

test('revisão: - no CLAUDE.md não o cria; d descarta; n deixa pendente', async () => {
  const { root, db, birth } = await proposed();
  const kept = await reviewBirth(scriptedIO(['', '-', '-', '', 'n']), birth, siteOf(birth));
  assert.equal(kept.kind, 'keep');
  const io = scriptedIO(['', '-', '-', '-', '']);
  const review = await reviewBirth(io, birth, siteOf(birth));
  assert.ok(review.kind === 'accept');
  assert.equal(review.proposal.claudeMd, '');
  assert.deepEqual(review.proposal.backlog, []);
  const saved = saveBirth(db, birth, review.proposal);
  assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
  assert.equal(saved.items, 1);
  assert.deepEqual(readCriticalRules(root), { paths: [], concepts: [] });

  const other = await proposed();
  assert.equal((await reviewBirth(scriptedIO(['', '', '', '', 'd']), other.birth, siteOf(other.birth))).kind, 'discard');
});

test('repositório com testes e CLAUDE.md: sem base de testes, CLAUDE.md preservado e índice do usuário fora do commit', async () => {
  const root = makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'src/a.js': '', 'CLAUDE.md': '# Meu CLAUDE\n' });
  writeFileSync(join(root, 'rascunho.txt'), 'meu');
  spawnSync('git', ['add', 'rascunho.txt'], { cwd: root });
  const output = { ...PROPOSED, proposta: { ...PROPOSAL, acrescimosClaudeMd: ['Comandos: npm test'] } };
  const { db, birth } = await proposed(output, root);
  const io = scriptedIO(['', '', '', '']);
  const review = await reviewBirth(io, birth, siteOf(birth));
  assert.ok(review.kind === 'accept');
  const text = io.lines.join('\n');
  assert.match(text, /CLAUDE\.md \(existente, não é alterado\)[\s\S]*acréscimos sugeridos, que não serão gravados:\n {2}- Comandos: npm test/);
  assert.match(text, /Backlog \(2 itens\)/);
  assert.equal(review.proposal.claudeMd, '');

  // Mesmo com um claudeMd vindo de fora, o existente não é sobrescrito.
  const saved = saveBirth(db, birth, { ...review.proposal, claudeMd: '# Outro\n' });
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '# Meu CLAUDE\n');
  assert.equal(saved.gitInit, false);
  assert.equal(saved.noTests, false);
  const items = parseBacklog(readFileSync(join(root, '.mabel', 'backlog.md'), 'utf8'));
  assert.deepEqual(items.map((item) => [item.number, item.dependsOn]), [[1, []], [2, [1]]]);
  assert.ok(!git(root, 'show', '--name-only', '--format=', 'HEAD').includes('rascunho.txt'));
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'rascunho.txt');
});

test('gravação recusa diretório que ganhou arquivos sem git e proposta já decidida', async () => {
  const { root, db, birth } = await proposed();
  writeFileSync(join(root, 'notas.txt'), 'x');
  assert.throws(() => saveBirth(db, birth, PROPOSAL), /ganhou arquivos e continua sem git/);
  assert.equal(existsSync(join(root, '.mabel')), false);

  const other = await proposed();
  saveBirth(other.db, other.birth, PROPOSAL);
  assert.throws(() => saveBirth(other.db, getBirth(other.db, other.birth.id) as typeof other.birth, PROPOSAL), /não tem proposta pendente/);
});

test('dropItems refaz as posições das dependências', () => {
  const item = (titulo: string, dependeDe: number[]) => ({ ...(PROPOSAL.backlog[0] as BirthProposal['backlog'][number]), titulo, dependeDe });
  const { backlog, warnings } = dropItems([item('a', []), item('b', [1]), item('c', [1, 2])], [false, true, true]);
  assert.deepEqual(backlog.map((entry) => [entry.titulo, entry.dependeDe]), [['b', []], ['c', [1]]]);
  assert.equal(warnings.length, 2);
});

/** CLI do `nascer` sem TTY, com o `claude` falso num cenário próprio. */
function birthCli(responses: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const db = openDb(home);
  seedBalance(db);
  db.close();
  const dir = scratch();
  const scenario = join(dir, 'cenario.json');
  writeFileSync(scenario, JSON.stringify({ responses }));
  const env = {
    ...process.env,
    MABEL_HOME: home,
    NO_COLOR: '1',
    MABEL_CLAUDE_BIN: join(import.meta.dirname, 'fixtures', 'fake-claude.mjs'),
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_CLAUDE_LOG: join(dir, 'log.jsonl'),
  };
  const run = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'nascer', ...args], { cwd, encoding: 'utf8', env, input: '', timeout: 20_000 });
  const file = (name: string, content: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(content));
    return path;
  };
  return { root, home, dir, cli: (...args: string[]) => run(root, ...args), run, file };
}

/** A única linha do stdout, como JSON. */
function oneLine(result: ReturnType<typeof spawnSync>): Record<string, unknown> {
  assert.equal(result.status, 0, String(result.stderr));
  const lines = String(result.stdout).trim().split('\n');
  assert.equal(lines.length, 1, String(result.stdout));
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

test('sem TTY, --json: perguntas, --responder, --lista e --aceitar com a proposta editada pelo cliente', () => {
  const { root, cli, file } = birthCli([{ structured_output: QUESTIONS, session_id: 's-json', cost: 0.12 }, { structured_output: PROPOSED, cost: 0.2 }]);
  const asking = oneLine(cli('um app de férias', '--json'));
  assert.equal(asking.versao, 1);
  assert.equal(asking.estado, 'perguntas');
  assert.equal(asking.rodada, 1);
  assert.equal(asking.proposta, null);
  assert.equal(asking.custo_usd, 0.12);
  assert.deepEqual((asking.perguntas as unknown[])[1], { texto: 'Pode tirar férias com saldo negativo?', sugestao: 'Não', regra_critica: true });
  const id = asking.nascimento as string;

  assert.match(cli('--responder', id).stderr, /Falta --respostas/);
  assert.equal(cli('--responder', id, '--respostas', file('poucas.json', [null])).status, 1);
  assert.match(cli('--responder', id, '--respostas', file('sem.json', [null, null, null])).stderr, /resposta 3: a pergunta não tem sugestão/);
  assert.match(cli('--aceitar', id).stderr, /está em perguntas; este passo vale para proposta/);

  const proposal = oneLine(cli('--responder', id.slice(0, 8), '--respostas', file('respostas.json', [null, 'Nunca', 'Google']), '--json'));
  assert.equal(proposal.estado, 'proposta');
  assert.equal(proposal.rodada, 2);
  assert.deepEqual(proposal.perguntas, []);
  const snake = proposal.proposta as Record<string, unknown>;
  assert.deepEqual(Object.keys(snake), ['stack', 'stack_motivo', 'claude_md', 'acrescimos_claude_md', 'regras_criticas', 'backlog']);
  assert.deepEqual(Object.keys((snake.backlog as Record<string, unknown>[])[0] ?? {}), [
    'titulo', 'intencao', 'criterios', 'fora_do_escopo', 'decisoes', 'regras_criticas', 'depende_de',
  ]);
  assert.ok(Math.abs((proposal.custo_usd as number) - 0.32) < 1e-9);

  const list = oneLine(cli('--lista', '--json'));
  assert.deepEqual((list.nascimentos as Record<string, unknown>[]).map((entry) => [entry.id, entry.estado, entry.rodada]), [[id, 'proposta', 2]]);
  assert.match(cli('--lista').stdout, /proposta\s+2\/3/);

  // O cliente devolve a proposta em cobra, sem o primeiro item: o segundo perde a dependência.
  const edited = { ...snake, backlog: (snake.backlog as Record<string, unknown>[]).slice(1).map((item) => ({ ...item, depende_de: [] })) };
  assert.match(cli('--aceitar', id, '--proposta', file('ruim.json', { ...edited, extra: 1 })).stderr, /proposta fora do esquema/);
  const saved = oneLine(cli('--aceitar', id, '--proposta', file('editada.json', edited), '--json'));
  assert.equal(saved.estado, 'gravado');
  assert.equal((saved.projeto as Record<string, unknown>).raiz, realpathSync(root));
  assert.ok((saved.arquivos as string[]).includes('CLAUDE.md'));
  assert.equal(saved.git_init, true);
  assert.deepEqual(saved.commit, { branch: 'main' });
  const items = parseBacklog(readFileSync(join(root, '.mabel', 'backlog.md'), 'utf8'));
  assert.deepEqual(items.map((item) => [item.number, item.title, item.dependsOn]), [
    [1, 'Estabelecer base de testes', []],
    [2, 'Pedido de férias', [1]],
  ]);
  assert.match(cli('--descartar', id).stderr, /está em gravado/);
  assert.match(cli('--lista').stdout, /Nenhum nascimento em aberto/);
});

test('sem TTY: o que falta sai com código 1; --descartar; recusas de raiz', () => {
  const { root, cli, run, file } = birthCli([{ structured_output: PROPOSED }]);
  const missing = cli('--json');
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Diga o que é o projeto/);
  assert.match(cli('--aceitar', 'x', '--descartar', 'y').stderr, /um passo por vez/);
  assert.match(cli('--proposta', file('p.json', {})).stderr, /--proposta vale com --aceitar/);
  assert.match(cli('--lista', 'descrição').stderr, /valem só para começar/);
  assert.match(cli('--stack', 'cobol', 'x').stderr, /Stack desconhecida: cobol/);
  assert.match(cli('--aceitar', 'nao-existe').stderr, /Nenhum nascimento com o id nao-existe/);

  const started = oneLine(cli('férias', '--json'));
  assert.equal(started.estado, 'proposta');
  const discarded = oneLine(cli('--descartar', started.nascimento as string, '--json'));
  assert.deepEqual(discarded, { versao: 1, nascimento: started.nascimento, estado: 'descartado' });
  assert.equal(existsSync(join(root, '.mabel')), false);

  const loose = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  writeFileSync(join(loose, 'notas.txt'), 'x');
  const refused = run(loose, 'férias');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /com arquivos e sem git/);
  const { root: mabelRoot } = setupProject();
  assert.match(run(mabelRoot, 'férias').stderr, /já é um projeto Mabel/);
});

test('sem TTY, repositório com código: roda sem descrição e o texto diz o passo seguinte', () => {
  const { run } = birthCli([{ structured_output: PROPOSED }]);
  const repo = makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'src/a.js': '' });
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nascimento de .* · repositório com código/);
  assert.match(result.stdout, /Proposta para/);
  assert.match(result.stdout, /mabel nascer --aceitar <id>/);
});
