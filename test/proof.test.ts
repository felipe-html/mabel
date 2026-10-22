import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { git } from '../src/git.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { type PipelineEnv, advanceItem } from '../src/pipeline.ts';
import { DEFAULT_TEST_GLOBS, readConfig } from '../src/project.ts';
import { type ProofInput, proofDetail, runProof, singleTestCommand, withBaseCode } from '../src/proof.ts';
import type { ExecuteOutput, PlanOutput } from '../src/schemas/stages.ts';
import { STACKS, findStack, proofTestCommand } from '../src/stacks.ts';
import { CLI, PLAN, REVIEW_OK, makeRepo, setupProject, useScenario } from './helpers.ts';

const NODE_TEST = 'node --test --test-name-pattern={padrao} {arquivo}';
const NAME = 'soma(2, 3) devolve 5';
const SOMA = 'export const soma = (a, b) => a + b;\n';
const STRONG_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { soma } from '../src/soma.mjs';",
  `test('${NAME}', () => assert.equal(soma(2, 3), 5));`,
  '',
].join('\n');
const WEAK_TEST = ["import { test } from 'node:test';", `test('${NAME}', () => {});`, ''].join('\n');

const plan = (comportamento: 'novo' | 'mantido' | undefined, id = 'C1'): PlanOutput => ({
  ...(PLAN as PlanOutput),
  criterios: [{ id, texto: 'critério', verificacao: 'teste', ...(comportamento ? { comportamento } : {}) }],
});
const execution = (arquivo: string, nome: string, id = 'C1'): ExecuteOutput => ({
  resumo: 'feito',
  criterios: [{ id, testes: [{ arquivo, nome }] }],
  suposicoes: [],
  perguntas: [],
  escopoAdicional: [],
  impedimento: '',
});

/** Repositório com a base em `main` e o item commitado numa branch, como no worktree. */
function itemRepo(base: Record<string, string>, change: Record<string, string | null>) {
  const root = makeRepo({ 'package.json': '{}', ...base });
  git(root, 'checkout', '-q', '-b', 'item');
  for (const [path, content] of Object.entries(change)) {
    if (content === null) git(root, 'rm', '-q', path);
    else {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'item');
  const logDir = mkdtempSync(join(tmpdir(), 'mabel-prova-'));
  const input = (over: Partial<ProofInput> & Pick<ProofInput, 'plan' | 'execution'>): ProofInput => ({
    worktree: root,
    base: git(root, 'merge-base', 'HEAD', 'main'),
    config: { testeUnico: NODE_TEST, arquivosDeTeste: DEFAULT_TEST_GLOBS, verify: [{ name: 'test', command: 'node --test' }] },
    logDir,
    ...over,
  });
  const status = () => git(root, 'status', '--porcelain', '--untracked-files=all');
  return { root, logDir, input, status };
}

test('comando de um teste só: aspas de shell e nome escapado para regex', () => {
  assert.equal(
    singleTestCommand(NODE_TEST, { arquivo: 'test/a b.test.mjs', nome: "soma(2, 3) é 5's" }),
    "node --test --test-name-pattern='soma\\(2, 3\\) é 5'\\''s' 'test/a b.test.mjs'",
  );
  assert.equal(singleTestCommand('go test -run {padrao} ./{pasta}', { arquivo: 'pkg/x/x_test.go', nome: 'TestX' }), "go test -run 'TestX' ./'pkg/x'");
  assert.equal(singleTestCommand('pytest {arquivo} -k {nome}', { arquivo: 'tests/t.py', nome: 'test_a' }), "pytest 'tests/t.py' -k 'test_a'");
});

test('P.2 critério 3: mantido passa nos dois → provado; falha na base → nao_provado', () => {
  const kept = itemRepo(
    { 'src/dobro.mjs': 'export const dobro = (x) => x * 2;\n' },
    {
      'src/dobro.mjs': 'export const dobro = (x) => x + x;\n',
      'test/dobro.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dobro } from '../src/dobro.mjs';\ntest('dobro de 4', () => assert.equal(dobro(4), 8));\n",
    },
  );
  const ok = runProof(kept.input({ plan: plan('mantido'), execution: execution('test/dobro.test.mjs', 'dobro de 4') }));
  assert.equal(proofDetail(ok), 'C1 provado');
  assert.deepEqual(ok.criteria[0]?.tests, [{ arquivo: 'test/dobro.test.mjs', nome: 'dobro de 4', item: true, base: true }]);
  assert.equal(kept.status(), '');

  const changed = itemRepo(
    { 'src/dobro.mjs': 'export const dobro = (x) => x * 2;\n' },
    {
      'src/dobro.mjs': 'export const dobro = (x) => x * 3;\n',
      'test/dobro.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { dobro } from '../src/dobro.mjs';\ntest('dobro de 4', () => assert.equal(dobro(4), 12));\n",
    },
  );
  const gap = runProof(changed.input({ plan: plan('mantido'), execution: execution('test/dobro.test.mjs', 'dobro de 4') }));
  assert.equal(
    proofDetail(gap),
    'C1 nao_provado: o teste `dobro de 4` falha no código anterior; ele não descreve o comportamento mantido',
  );
  assert.equal(readFileSync(join(changed.root, 'src/dobro.mjs'), 'utf8'), 'export const dobro = (x) => x * 3;\n');
  assert.match(readFileSync(join(changed.logDir, 'C1-base.log'), 'utf8'), /\[saída 1\]/);
});

test('P.2 critério 4: teste no código alterado e plano sem comportamento → sem_prova', () => {
  const inline = itemRepo({}, { 'src/soma.mjs': `${SOMA}// teste: soma de dois\n` });
  const result = runProof(inline.input({ plan: plan('novo'), execution: execution('src/soma.mjs', 'soma de dois') }));
  assert.equal(proofDetail(result), 'C1 sem_prova: o teste mora no código alterado (`src/soma.mjs`)');
  assert.equal(existsSync(join(inline.logDir, 'C1-item.log')), false);

  const legacy = itemRepo({}, { 'src/soma.mjs': SOMA, 'test/soma.test.mjs': STRONG_TEST });
  const old = runProof(legacy.input({ plan: plan(undefined), execution: execution('test/soma.test.mjs', NAME) }));
  assert.equal(proofDetail(old), 'C1 sem_prova: plano sem comportamento declarado');
});

test('P.2 critério 5: worktree restaurado mesmo quando o comando lança erro; sujeira é detectada', () => {
  const repo = itemRepo(
    { 'src/a.mjs': 'base\n', 'src/apagado.mjs': 'base\n' },
    { 'src/a.mjs': 'item\n', 'src/novo.mjs': 'item\n', 'src/apagado.mjs': null },
  );
  const base = git(repo.root, 'merge-base', 'HEAD', 'main');
  const files = ['src/a.mjs', 'src/apagado.mjs', 'src/novo.mjs'];
  const seen = withBaseCode(repo.root, base, files, () => {
    assert.equal(readFileSync(join(repo.root, 'src/a.mjs'), 'utf8'), 'base\n');
    assert.equal(existsSync(join(repo.root, 'src/novo.mjs')), false);
    assert.equal(existsSync(join(repo.root, 'src/apagado.mjs')), true);
    throw new Error('runner explodiu');
  });
  assert.deepEqual(seen, { value: undefined, restored: true, error: 'runner explodiu' });
  assert.equal(repo.status(), '');
  assert.equal(readFileSync(join(repo.root, 'src/a.mjs'), 'utf8'), 'item\n');
  assert.equal(existsSync(join(repo.root, 'src/apagado.mjs')), false);

  const dirty = withBaseCode(repo.root, base, files, () => writeFileSync(join(repo.root, 'README.md'), 'mexido\n'));
  assert.equal(dirty.restored, false);
});

test('P.2 critério 6: modo por item, sem testeUnico, roda o comando de teste uma vez', () => {
  const strong = itemRepo({}, { 'src/soma.mjs': SOMA, 'test/soma.test.mjs': STRONG_TEST });
  const config = { testeUnico: null, arquivosDeTeste: DEFAULT_TEST_GLOBS, verify: [{ name: 'test', command: 'node --test' }] };
  const ok = runProof(strong.input({ config, plan: plan('novo'), execution: execution('test/soma.test.mjs', NAME) }));
  assert.equal(ok.mode, 'item');
  assert.equal(proofDetail(ok), 'C1 provado (por item)');
  assert.ok(existsSync(join(strong.logDir, 'base.log')));

  const weak = itemRepo({}, { 'src/soma.mjs': SOMA, 'test/soma.test.mjs': WEAK_TEST });
  const gap = runProof(weak.input({ config, plan: plan('novo'), execution: execution('test/soma.test.mjs', NAME) }));
  assert.match(proofDetail(gap), /^C1 nao_provado: o comando `node --test` já passava sem a mudança/);

  const none = runProof(weak.input({ config: { ...config, verify: [] }, plan: plan('novo'), execution: execution('test/soma.test.mjs', NAME) }));
  assert.equal(proofDetail(none), 'C1 sem_prova: sem `testeUnico` nem comando de teste no `verify`');
});

// Pelo pipeline, num projeto Node mínimo com node:test (critérios 1, 2, 5 e 8) ----------------

function proofPipeline(responses: unknown[], testeUnico = NODE_TEST) {
  const ctx = setupProject('\n## Soma\nQuero uma função soma.\n');
  Object.assign(ctx.project.config, { setup: null, testeUnico, verify: [{ name: 'test', command: 'node --test' }] });
  syncBacklog(ctx.db, ctx.project);
  const { log } = useScenario(ctx.root, responses);
  const env: PipelineEnv = { db: ctx.db, home: ctx.home, project: ctx.project };
  const item = () => getItem(ctx.db, ctx.project.id, 1)!;
  const gates = () =>
    (ctx.db.prepare("SELECT attempt, passed, detail FROM gate_results WHERE gate = 'proof' ORDER BY id").all() as object[]).map(
      (row) => ({ ...row }),
    );
  return { ctx, item, gates, log, advance: () => advanceItem(env, item().id) };
}

const PLAN_NOVO = { structured_output: { ...PLAN, criterios: [{ id: 'C1', texto: NAME, verificacao: 'teste', comportamento: 'novo' }] } };
const executeWith = (testFile: string) => ({
  structured_output: execution('test/soma.test.mjs', NAME),
  files: { 'src/soma.mjs': SOMA, 'test/soma.test.mjs': testFile },
});

test('P.2 critério 1: teste novo que falha na base e passa no item → provado, com logs', async () => {
  const p = proofPipeline([PLAN_NOVO, executeWith(STRONG_TEST), { structured_output: REVIEW_OK }]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const dir = join(p.ctx.home, 'items', p.item().id);
  assert.deepEqual(p.gates(), [{ attempt: 1, passed: 1, detail: 'C1 provado' }]);
  assert.match(readFileSync(join(dir, 'prova-1', 'C1-base.log'), 'utf8'), /ERR_MODULE_NOT_FOUND[\s\S]*\[saída 1\]/);
  assert.match(readFileSync(join(dir, 'prova-1', 'C1-item.log'), 'utf8'), /# pass 1[\s\S]*\[saída 0\]/);
  const saved = JSON.parse(readFileSync(join(dir, 'prova-1.json'), 'utf8'));
  assert.equal(saved.criteria[0].status, 'provado');
});

test('P.2 critério 2: teste novo que já passava na base → nao_provado e nova tentativa com a lacuna', async () => {
  const p = proofPipeline([PLAN_NOVO, executeWith(WEAK_TEST), executeWith(STRONG_TEST), { structured_output: REVIEW_OK }]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  assert.deepEqual(p.gates(), [
    { attempt: 1, passed: 0, detail: `C1 nao_provado: o teste \`${NAME}\` já passava sem a mudança; ele não protege o critério` },
    { attempt: 2, passed: 1, detail: 'C1 provado' },
  ]);
  const retry = p.log()[2]?.argv.at(-1) ?? '';
  assert.match(retry, /A prova reprovou testes que não protegem os critérios:\n- C1: o teste `soma\(2, 3\) devolve 5` já passava/);
});

test('P.2 critério 5: worktree sujo depois da prova leva o item a failed', async () => {
  const p = proofPipeline([PLAN_NOVO, executeWith(STRONG_TEST)], `test -f src/soma.mjs || echo x > sujo.txt; ${NODE_TEST}`);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'failed' });
  assert.equal(p.item().statusReason, 'worktree não restaurado após a prova');
  assert.deepEqual(p.gates(), [{ attempt: 1, passed: 0, detail: 'worktree não restaurado após a prova' }]);
});

// Catálogo e init (critério 7) -------------------------------------------------------------

test('P.2 critério 7: catálogo com testeUnico e arquivosDeTeste por stack', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mabel-stack-'));
  assert.deepEqual(
    Object.fromEntries(STACKS.map((stack) => [stack.id, stack.proof(empty, false).testeUnico])),
    {
      node: NODE_TEST,
      python: 'pytest {arquivo} -k {nome}',
      go: 'go test -run {padrao} ./{pasta}',
      rust: 'cargo test {nome}',
    },
  );
  assert.ok(STACKS.every((stack) => stack.proof(empty, false).arquivosDeTeste.length > 0));
  const node = findStack('node')!;
  assert.equal(node.proof(empty, true).testeUnico, 'npx vitest run {arquivo} -t {padrao}');
  writeFileSync(join(empty, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3' } }));
  assert.equal(node.proof(empty, false).testeUnico, 'npx vitest run {arquivo} -t {padrao}');
});

test('prova usa o Vitest quando o item troca o node --test padrão pelo Vitest', () => {
  const vitest = makeRepo({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^4' } }) });
  const plain = makeRepo({ 'package.json': '{}' });
  assert.equal(proofTestCommand(NODE_TEST, vitest), 'npx vitest run {arquivo} -t {padrao}');
  assert.equal(proofTestCommand(NODE_TEST, plain), NODE_TEST, 'sem Vitest, o config vale');
  // Comando escrito pelo humano não é trocado.
  assert.equal(proofTestCommand('node --test {arquivo}', vitest), 'node --test {arquivo}');
  assert.equal(proofTestCommand(null, vitest), null);
  assert.match(
    proofDetail({ mode: 'teste', criteria: [], restored: true, testeUnico: 'npx vitest run {arquivo} -t {padrao}' }),
    /testes rodados com `npx vitest run/,
  );
});

test('P.2 critério 7: init grava os campos da prova; config sem eles vale modo por item', () => {
  const init = (files: Record<string, string>) => {
    const root = makeRepo(files);
    const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'init'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MABEL_HOME: home, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    return { root, raw: JSON.parse(readFileSync(join(root, '.mabel', 'config.json'), 'utf8')) };
  };
  const vitest = init({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'src/a.ts': '' });
  assert.equal(vitest.raw.testeUnico, 'npx vitest run {arquivo} -t {padrao}');
  assert.ok(vitest.raw.arquivosDeTeste.includes('**/*.test.*'));
  const python = init({ 'pyproject.toml': '', 'app.py': '' });
  assert.equal(python.raw.testeUnico, 'pytest {arquivo} -k {nome}');

  const { testeUnico: _, arquivosDeTeste: __, ...legacy } = python.raw;
  writeFileSync(join(python.root, '.mabel', 'config.json'), JSON.stringify(legacy));
  const config = readConfig(python.root)!;
  assert.equal(config.testeUnico, null);
  assert.deepEqual(config.arquivosDeTeste, DEFAULT_TEST_GLOBS);
});
