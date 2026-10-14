import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { respond } from '../src/decisions.ts';
import { git, tryGit } from '../src/git.ts';
import { getItem, listItems, syncBacklog } from '../src/items.ts';
import { type PipelineEnv, advanceItem } from '../src/pipeline.ts';
import { DEFAULT_INTEGRATION, readConfig } from '../src/project.ts';
import { type QueueOptions, startQueue } from '../src/run.ts';
import { PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const INTEGRATION = 'mabel/integracao';
const PLAN_OK = { structured_output: PLAN };
const REVIEW = { structured_output: REVIEW_OK };

/** Execução do item `n`: cria `src/item<n>.js` e o teste dele. */
const execFor = (n: number, content = `export const item${n} = ${n};\n`) => ({
  structured_output: {
    resumo: `item ${n}`,
    criterios: [{ id: 'C1', testes: [{ arquivo: `test/item${n}.test.js`, nome: `item ${n} existe` }] }],
    suposicoes: [],
    perguntas: [],
    escopoAdicional: [],
  },
  files: { [`src/item${n}.js`]: content, [`test/item${n}.test.js`]: `test('item ${n} existe', () => {});\n` },
});

function project(backlog: string, responses: unknown[], verify = 'test -f src/item1.js') {
  const ctx = setupProject(backlog, { integracao: INTEGRATION });
  Object.assign(ctx.project.config, { setup: null, verify: [{ name: 'existe', command: verify }] });
  syncBacklog(ctx.db, ctx.project);
  const scenario = useScenario(ctx.root, responses);
  const states = () => listItems(ctx.db, ctx.project.id).map((item) => [item.number, item.status]);
  const start = (options: Partial<QueueOptions> = {}) =>
    startQueue({ db: ctx.db, home: ctx.home, project: ctx.project, ...options }).done;
  const ref = (name: string) => tryGit(ctx.root, 'rev-parse', `refs/heads/${name}`);
  const merges = () => git(ctx.root, 'log', '--format=%s', '--first-parent', '--reverse', `main..${INTEGRATION}`);
  const show = (path: string, branch = INTEGRATION) => tryGit(ctx.root, 'show', `${branch}:${path}`);
  return { ...ctx, scenario, states, start, ref, merges, show };
}

/** Commit de fora do Mabel numa branch, sem mexer no checkout do humano. */
function commitTo(root: string, branch: string, files: Record<string, string>, message = 'fora do Mabel'): void {
  const path = join(mkdtempSync(join(tmpdir(), 'mabel-fora-')), 'w');
  git(root, 'worktree', 'add', '-q', '--detach', path, branch);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    writeFileSync(join(path, file), content);
  }
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', message);
  git(root, 'update-ref', `refs/heads/${branch}`, git(path, 'rev-parse', 'HEAD'));
  git(root, 'worktree', 'remove', '--force', path);
}

/** O humano commita na base, no próprio checkout. */
function commitOnMain(root: string, file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
  git(root, 'add', file);
  git(root, 'commit', '-q', '-m', `humano: ${file}`, '--', file);
}

test('P.4 critério 7: config sem o campo vale integração ligada; null desliga', () => {
  const ctx = setupProject();
  const path = join(ctx.root, '.mabel', 'config.json');
  const { integracao: _, ...raw } = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(raw));
  assert.equal(readConfig(ctx.root)?.integracao, DEFAULT_INTEGRATION);
  writeFileSync(path, JSON.stringify({ ...raw, integracao: null }));
  assert.equal(readConfig(ctx.root)?.integracao, null);
});

test('P.4 critério 1: três itens nascem da integração, um vê o código do outro, três merges', async () => {
  const q = project('\n## A\nprimeiro\n\n## B\nsegundo\n\n## C\nterceiro\n', [
    PLAN_OK, PLAN_OK, PLAN_OK,
    execFor(1), REVIEW,
    execFor(2), REVIEW,
    execFor(3), REVIEW,
  ]);
  assert.equal(q.ref(INTEGRATION), undefined);
  const result = await q.start();
  assert.equal(result.end, 'empty', result.message);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge'], [3, 'awaiting_merge']]);
  assert.equal(q.merges(), ['mabel: integra #1 A', 'mabel: integra #2 B', 'mabel: integra #3 C'].join('\n'));
  // `verify` exige o arquivo do item 1: os itens 2 e 3 só passam vendo o código dele.
  for (const n of [1, 2, 3]) assert.ok(q.show(`src/item${n}.js`));
  for (const item of listItems(q.db, q.project.id)) {
    assert.ok(item.integratedCommit);
    assert.equal(item.worktree, null);
    assert.equal(q.ref(item.branch!), undefined, `branch ${item.branch} apagada`);
    assert.equal(git(q.root, 'rev-list', '--parents', '-n', '1', item.integratedCommit!).split(' ').length, 3);
  }
  assert.equal(q.ref('main'), git(q.root, 'rev-parse', 'HEAD'), 'a main não muda');
  assert.match(readFileSync(join(q.root, '.mabel', 'quadro.md'), 'utf8'), /#1 A — \*\*awaiting_merge\*\* · na integração/);
});

test('P.4 critério 2: item que depende de outro integrado inicia sem merge do humano', async () => {
  const q = project('\n## A\nprimeiro\n\n## B\ndepende\nDepende de: 1\n', [PLAN_OK, execFor(1), REVIEW, PLAN_OK, execFor(2), REVIEW]);
  assert.equal((await q.start()).end, 'empty');
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge']]);
});

function pipeline(responses: unknown[], onExecute: (root: string) => void) {
  const q = project('\n## A\nprimeiro\n', responses);
  let moved = false;
  const env: PipelineEnv = {
    db: q.db,
    home: q.home,
    project: q.project,
    beforeAgentStage: async (stage) => {
      if (stage === 'execute' && !moved) {
        moved = true;
        onExecute(q.root);
      }
      return true;
    },
  };
  const item = () => getItem(q.db, q.project.id, 1)!;
  return { ...q, item, advance: () => advanceItem(env, item().id) };
}

test('P.4 critério 3: integração que andou durante o item; merge limpo antes da verificação', async () => {
  const p = pipeline([PLAN_OK, execFor(1), REVIEW], (root) => commitTo(root, INTEGRATION, { 'src/outro.js': 'outro\n' }));
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  assert.equal(p.show('src/outro.js'), 'outro');
  assert.ok(p.show('src/item1.js'));
  assert.equal(p.merges(), 'fora do Mabel\nmabel: integra #1 A');
});

test('P.4 critério 3: conflito com a integração leva a integration_conflict; responder resolve', async () => {
  const p = pipeline([PLAN_OK, execFor(1), execFor(1, 'export const item1 = "resolvido";\n'), REVIEW], (root) =>
    commitTo(root, INTEGRATION, { 'src/item1.js': 'export const item1 = "da integração";\n' }),
  );
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.equal(p.item().pendingKind, 'integration_conflict');
  assert.deepEqual(p.item().pending?.files, ['src/item1.js']);
  assert.equal(git(p.item().worktree!, 'status', '--porcelain'), '', 'merge abortado');

  assert.equal(respond(p.db, p.project, p.item(), 'fique com a versão do item'), 'executing');
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const prompt = p.scenario.log()[2]?.argv.at(-1) ?? '';
  assert.match(prompt, /tem conflitos[\s\S]*- src\/item1\.js[\s\S]*fique com a versão do item/);
  assert.equal(p.show('src/item1.js'), 'export const item1 = "resolvido";');
});

test('P.4 critério 4: merge da integração na base leva os itens a done e avança a integração', async () => {
  const q = project('\n## A\nprimeiro\n', [PLAN_OK, execFor(1), REVIEW]);
  await q.start();
  git(q.root, 'merge', '-q', '--no-ff', '--no-edit', INTEGRATION);
  const result = await q.start();
  assert.equal(result.end, 'empty');
  assert.deepEqual(q.states(), [[1, 'done']]);
  assert.equal(q.ref(INTEGRATION), q.ref('main'));
});

test('P.4 critério 5: base e integração divergentes; merge limpo segue, conflito pausa', async () => {
  const q = project('\n## A\nprimeiro\n', [PLAN_OK, execFor(1), REVIEW]);
  await q.start();
  commitOnMain(q.root, 'docs/nota.md', 'nota\n');
  assert.equal((await q.start()).end, 'empty');
  assert.equal(q.show('docs/nota.md'), 'nota');
  assert.ok(q.show('src/item1.js'));
  assert.equal(q.states()[0]?.[1], 'awaiting_merge');

  commitOnMain(q.root, 'src/item1.js', 'export const item1 = "main";\n');
  const before = q.ref(INTEGRATION);
  const paused = await q.start();
  assert.equal(paused.end, 'paused');
  assert.match(paused.message ?? '', /divergiram com conflito em: src\/item1\.js/);
  assert.equal(q.ref(INTEGRATION), before);
  assert.match(git(q.root, 'worktree', 'list'), /^[^\n]+$/, 'worktree temporário removido');
});

test('P.4 critério 6: integração aberta no checkout do humano pausa sem escrever nada', async () => {
  const q = project('\n## A\nprimeiro\n', [PLAN_OK, execFor(1), REVIEW]);
  git(q.root, 'branch', INTEGRATION, 'main');
  git(q.root, 'checkout', '-q', INTEGRATION);
  const result = await q.start();
  assert.equal(result.end, 'paused');
  assert.match(result.message ?? '', /a branch mabel\/integracao está aberta em .+; feche-a para o Mabel continuar/);
  assert.deepEqual(q.states(), [[1, 'ready']]);
  assert.equal(q.scenario.log().length, 0);
});
