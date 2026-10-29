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
import { setSpecStatus } from '../src/specs.ts';
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
    impedimento: '',
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
  const runReportText = () => readFileSync(join(ctx.root, '.mabel', 'run.md'), 'utf8');
  return { ...ctx, scenario, states, start, ref, merges, show, runReportText };
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

const SPEC_FILE = (title: string) => `# ${title}\n\n## História\nHistória.\n\n## Regras\n\n### R1 Regra\n- caso → resultado (borda)\n\n## Fora do escopo\nNada.\n`;

/** Projeto com as specs dadas, já aceitas. */
function withSpecs(backlog: string, responses: unknown[], specs: string[], verify = 'true') {
  const q = project(backlog, responses, verify);
  mkdirSync(join(q.root, '.mabel', 'specs'), { recursive: true });
  for (const slug of specs) {
    writeFileSync(join(q.root, '.mabel', 'specs', `${slug}.md`), SPEC_FILE(slug));
    setSpecStatus(q.db, q.project.id, slug, 'aceita');
  }
  git(q.root, 'add', '.mabel');
  git(q.root, 'commit', '-q', '-m', 'specs');
  syncBacklog(q.db, q.project);
  const runReport = () => readFileSync(join(q.root, '.mabel', 'run.md'), 'utf8');
  const firstParents = (branch: string) => git(q.root, 'log', '--format=%s', '--first-parent', '--reverse', `main..${branch}`);
  return { ...q, runReport, firstParents };
}

const task = (title: string, slug: string) => `\n## ${title}\nSpec: ${slug}\nRegras: R1\n`;

test('S.5 critério 13: tarefas de duas specs nascem da branch de cada uma; a integração é refeita no run com as duas', async () => {
  const q = withSpecs(task('A1', 'a') + task('B1', 'b') + task('A2', 'a'), [
    PLAN_OK, PLAN_OK, PLAN_OK,
    execFor(1), REVIEW,
    execFor(2), REVIEW,
    execFor(3), REVIEW,
  ], ['a', 'b']);
  const result = await q.start();
  assert.equal(result.end, 'empty', result.message);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge'], [3, 'awaiting_merge']]);
  assert.equal(q.firstParents('mabel/spec/a'), 'mabel: merge #1 A1 na mabel/spec/a\nmabel: merge #3 A2 na mabel/spec/a');
  assert.equal(q.firstParents('mabel/spec/b'), 'mabel: merge #2 B1 na mabel/spec/b');
  assert.ok(q.show('src/item1.js', 'mabel/spec/a'));
  assert.equal(q.show('src/item2.js', 'mabel/spec/a'), undefined, 'a spec a não vê a tarefa da b');
  // A2 nasceu da branch da spec: o merge dela tem a A1 no primeiro pai.
  const a2 = getItem(q.db, q.project.id, 3)!;
  assert.equal(git(q.root, 'rev-parse', `${a2.integratedCommit}^1`), getItem(q.db, q.project.id, 1)!.integratedCommit);
  for (const n of [1, 2, 3]) assert.ok(q.show(`src/item${n}.js`), `#${n} na integração`);
  assert.equal(q.ref(`mabel/1-a1`), undefined, 'branch da tarefa apagada');

  // Novo run: a integração é refeita a partir da base, com as duas specs na ordem da primeira integração.
  assert.equal((await q.start()).end, 'empty');
  assert.equal(q.firstParents(INTEGRATION), 'mabel: integra a\nmabel: integra b');
  assert.match(q.runReport(), /## Integração\nmain \([0-9a-f]+\) \+ 2 unidades \(a, b\) · verificação: verde/);
  assert.equal(q.ref('main'), git(q.root, 'rev-parse', 'HEAD'), 'a main não muda');
  // Trailers no merge da tarefa na unidade.
  assert.match(git(q.root, 'log', '-1', '--format=%B', a2.integratedCommit!), /Mabel-Item: #3\nMabel-Unidade: a/);
});

test('S.5 critério 14: specs que conflitam na integração geram aviso no run.md com a tarefa; as duas seguem', async () => {
  const shared = (n: number, content: string) => ({ ...execFor(n), files: { ...execFor(n).files, 'src/shared.js': content } });
  const q = withSpecs(task('A1', 'a') + task('B1', 'b'), [PLAN_OK, PLAN_OK, shared(1, 'a\n'), REVIEW, shared(2, 'b\n'), REVIEW], ['a', 'b']);
  assert.equal((await q.start()).end, 'empty');
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge']]);
  assert.equal(q.show('src/shared.js', 'mabel/spec/b'), 'b', 'a tarefa segue concluída na branch da spec');
  assert.equal(q.show('src/shared.js'), 'a', 'a integração ficou sem a b');
  assert.match(q.runReport(), /## Precisa de você\n[\s\S]*- Integração: mabel\/spec\/b × mabel\/spec\/a conflitam em src\/shared\.js \(desde #2\)/);
  // O próximo run refaz a integração e deixa a b de fora, com aviso.
  assert.equal((await q.start()).end, 'empty');
  assert.match(q.runReport(), /- Integração: mabel\/spec\/b × mabel\/spec\/a conflitam em src\/shared\.js\n/);
  assert.match(q.runReport(), /main \([0-9a-f]+\) \+ 1 unidade \(a\) · 1 de fora \(b\)/);
});

test('S.5 critério 15: conflito da base com uma spec a pausa; a outra segue', async () => {
  const q = withSpecs(task('A1', 'a') + task('B1', 'b') + task('A2', 'a'), [PLAN_OK, execFor(1), REVIEW, PLAN_OK, execFor(2), REVIEW], ['a', 'b']);
  assert.equal((await q.start({ itemNumber: 1 })).end, 'once');
  commitOnMain(q.root, 'src/item1.js', 'export const item1 = "main";\n');
  const before = q.ref('mabel/spec/a');
  const result = await q.start();
  assert.equal(result.end, 'empty', result.message);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge'], [3, 'ready']]);
  assert.equal(q.ref('mabel/spec/a'), before, 'a spec pausada não muda');
  assert.match(q.runReport(), /- Unidade a pausada: conflito da main em src\/item1\.js \(resolva o merge da main na mabel\/spec\/a\)/);
  assert.match(git(q.root, 'worktree', 'list'), /^[^\n]+$/, 'worktree temporário removido');
});

test('S.5 critério 16: avulso mantém mabel/avulso/<n>-<slug> até a entrega; o merge na base o leva a done', async () => {
  const q = project('\n## Corrige total\nprimeiro\n', [PLAN_OK, execFor(1), REVIEW], 'true');
  assert.equal((await q.start()).end, 'empty');
  assert.deepEqual(q.states(), [[1, 'awaiting_merge']]);
  assert.ok(q.show('src/item1.js', 'mabel/avulso/1-corrige-total'));
  assert.equal(q.ref('mabel/1-corrige-total'), undefined, 'branch da tarefa apagada');
  assert.equal((await q.start()).end, 'empty');
  assert.ok(q.ref('mabel/avulso/1-corrige-total'), 'a branch do avulso fica até a entrega');

  git(q.root, 'merge', '-q', '--no-ff', '--no-edit', 'mabel/avulso/1-corrige-total');
  assert.equal((await q.start()).end, 'empty');
  assert.deepEqual(q.states(), [[1, 'done']]);
  assert.equal(q.ref('mabel/avulso/1-corrige-total'), undefined, 'branch entregue apagada');
  assert.equal(q.ref(INTEGRATION), q.ref('main'));
});

test('S.5 critério 17: tarefas na integração antiga viram a unidade legado no primeiro run', async () => {
  const q = project('\n## A\nprimeiro\n\n## B\nsegundo\n', [], 'true');
  git(q.root, 'branch', INTEGRATION, 'main');
  commitTo(q.root, INTEGRATION, { 'src/item1.js': 'um\n' }, 'mabel: integra #1 A');
  const old = q.ref(INTEGRATION)!;
  q.db.prepare("UPDATE items SET status = 'awaiting_merge', integrated_commit = ? WHERE number = 1 AND project_id = ?").run(old, q.project.id);
  // Só a abertura: o #1 não está em ready, e a fila termina sem rodar agente.
  assert.equal((await q.start({ itemNumber: 1 })).end, 'not_found');
  assert.equal(getItem(q.db, q.project.id, 1)?.unit, 'legado');
  assert.equal(q.ref('mabel/spec/legado'), old);
  assert.equal(q.merges(), 'mabel: integra legado');
  assert.ok(q.show('src/item1.js'));
  assert.match(q.runReportText(), /## Prontas para entregar\n- legado \(1\/1\) · mabel entregar legado/);
});

test('dependência entre unidades: o avulso que depende de outra unidade concluída a recebe antes de começar', async () => {
  const q = project('\n## A\nprimeiro\n\n## B\ndepende\nDepende de: 1\n', [PLAN_OK, execFor(1), REVIEW, PLAN_OK, execFor(2), REVIEW]);
  assert.equal((await q.start()).end, 'empty');
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge']]);
  // `verify` exige o arquivo do item 1: o B só passa vendo o código do A, trazido para a branch dele.
  assert.ok(q.show('src/item1.js', 'mabel/avulso/2-b'));
  assert.match(git(q.root, 'log', '--format=%s', 'main..mabel/avulso/2-b'), /mabel: traz avulso-1 para a mabel\/avulso\/2-b/);
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

const UNIT = 'mabel/avulso/1-a';

test('branch da unidade que andou durante a tarefa: merge limpo antes da verificação', async () => {
  const p = pipeline([PLAN_OK, execFor(1), REVIEW], (root) => commitTo(root, UNIT, { 'src/outro.js': 'outro\n' }));
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  assert.equal(p.show('src/outro.js', UNIT), 'outro');
  assert.ok(p.show('src/item1.js', UNIT));
  assert.equal(git(p.root, 'log', '--format=%s', '--first-parent', '--reverse', `main..${UNIT}`), 'fora do Mabel\nmabel: merge #1 A na mabel/avulso/1-a');
});

test('conflito com a branch da unidade leva a integration_conflict; responder resolve', async () => {
  const p = pipeline([PLAN_OK, execFor(1), execFor(1, 'export const item1 = "resolvido";\n'), REVIEW], (root) =>
    commitTo(root, UNIT, { 'src/item1.js': 'export const item1 = "da unidade";\n' }),
  );
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.equal(p.item().pendingKind, 'integration_conflict');
  assert.deepEqual(p.item().pending?.files, ['src/item1.js']);
  assert.equal(git(p.item().worktree!, 'status', '--porcelain'), '', 'merge abortado');

  assert.equal(respond(p.db, p.project, p.item(), 'fique com a versão do item'), 'executing');
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const prompt = p.scenario.log()[2]?.argv.at(-1) ?? '';
  assert.match(prompt, /tem conflitos[\s\S]*- src\/item1\.js[\s\S]*fique com a versão do item/);
  assert.equal(p.show('src/item1.js', UNIT), 'export const item1 = "resolvido";');
});

test('rerere: a resolução do humano no merge da base na unidade é reaplicada quando o conflito volta', async () => {
  const q = project('\n## A\nprimeiro\n', [PLAN_OK, execFor(1), REVIEW], 'true');
  assert.equal((await q.start()).end, 'empty');
  commitOnMain(q.root, 'src/item1.js', 'export const item1 = "main";\n');
  assert.equal((await q.start()).end, 'empty');
  assert.match(q.runReportText(), /Unidade avulso-1 pausada/);
  // O humano resolve o merge da base na unidade com o rerere ligado, e desfaz (a resolução fica gravada).
  const path = join(mkdtempSync(join(tmpdir(), 'mabel-humano-')), 'w');
  git(q.root, 'worktree', 'add', '-q', path, UNIT);
  tryGit(path, '-c', 'rerere.enabled=true', 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(path, 'src/item1.js'), 'export const item1 = "juntos";\n');
  git(path, '-c', 'rerere.enabled=true', 'add', 'src/item1.js');
  git(path, '-c', 'rerere.enabled=true', 'commit', '-q', '--no-edit');
  git(path, 'reset', '-q', '--hard', 'HEAD^1');
  git(q.root, 'worktree', 'remove', '--force', path);
  // O próximo run refaz o merge e o rerere aplica a resolução: a unidade não pausa.
  assert.equal((await q.start()).end, 'empty');
  assert.doesNotMatch(q.runReportText(), /pausada/);
  assert.equal(q.show('src/item1.js', UNIT), 'export const item1 = "juntos";');
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
