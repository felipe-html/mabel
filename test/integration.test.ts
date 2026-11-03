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
import { inboxJson } from '../src/inbox.ts';
import { setSpecStatus } from '../src/specs.ts';
import { readIntegrationState } from '../src/units.ts';
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

/** A integração só andou para frente: cada valor do reflog é ancestral do seguinte (F.1 critério 2). */
function assertForwardOnly(root: string): void {
  const values = git(root, 'reflog', 'show', '--format=%H', `refs/heads/${INTEGRATION}`).split('\n').filter(Boolean).reverse();
  assert.ok(values.length > 0);
  for (const [i, value] of values.entries()) {
    const previous = values[i - 1];
    if (previous) assert.ok(tryGit(root, 'merge-base', '--is-ancestor', previous, value) !== undefined, `${previous} → ${value} reescreveu a integração`);
  }
}

/** Branches de unidade do S.5 que ainda existem. */
const legacyBranches = (root: string) => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/mabel/spec/', 'refs/heads/mabel/avulso/');

test('F.1 critérios 1 e 2: a tarefa de uma spec nasce da ponta da fila e enxerga o package.json do avulso anterior', async () => {
  const pkg = '{ "name": "base-de-testes" }\n';
  const base = { ...execFor(1), files: { ...execFor(1).files, 'package.json': pkg } };
  const q = withSpecs(
    '\n## Estabelecer base de testes\nprimeiro\n' + task('Tela de login', 'tema-login'),
    // Em lote: os dois planejamentos antes das execuções.
    [{ structured_output: { ...PLAN, escopo: [...PLAN.escopo, 'package.json'] } }, PLAN_OK, base, REVIEW, execFor(2), REVIEW],
    ['tema-login'],
    // A tarefa da spec só passa vendo a base de testes do avulso.
    'test ! -f src/item2.js || grep -q base-de-testes package.json',
  );
  const result = await q.start();
  assert.equal(result.end, 'empty', result.message);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge']]);
  const [first, second] = [getItem(q.db, q.project.id, 1)!, getItem(q.db, q.project.id, 2)!];
  // O merge da #2 tem o da #1 no primeiro pai: ela nasceu da ponta.
  assert.equal(git(q.root, 'rev-parse', `${second.integratedCommit}^1`), first.integratedCommit);
  assert.equal(git(q.root, 'show', `${second.integratedCommit}^2:package.json`), pkg.trimEnd());
  assert.equal(q.firstParents(INTEGRATION), 'mabel: merge #1 Estabelecer base de testes na mabel/integracao\nmabel: merge #2 Tela de login na mabel/integracao');
  assert.match(git(q.root, 'log', '-1', '--format=%B', second.integratedCommit!), /Mabel-Item: #2\nMabel-Unidade: tema-login/);
  assert.equal(legacyBranches(q.root), '', 'nenhuma branch de unidade');
  assert.equal(q.ref('mabel/2-tela-de-login'), undefined, 'branch da tarefa apagada');
  assert.equal(q.ref('main'), git(q.root, 'rev-parse', 'HEAD'), 'a main não muda');
  assert.match(q.runReport(), /## Prontas para entregar\n- avulso #1 Estabelecer base de testes · mabel entregar #1\n- tema-login \(1\/1\) · mabel entregar tema-login/);
  assert.match(q.runReport(), /## Integração\nmain \([0-9a-f]+\) \+ 2 tarefas na fila \(avulso-1, tema-login\) · base em dia/);
  // Outro run não refaz nada: a fila fica como está.
  const tip = q.ref(INTEGRATION);
  assert.equal((await q.start()).end, 'empty');
  assert.equal(q.ref(INTEGRATION), tip);
  assertForwardOnly(q.root);
});

test('F.1 critério 6: integracao null continua com uma branch por item, da base', async () => {
  const ctx = setupProject('\n## A\nprimeiro\n');
  Object.assign(ctx.project.config, { setup: null, verify: [{ name: 'existe', command: 'true' }] });
  syncBacklog(ctx.db, ctx.project);
  useScenario(ctx.root, [PLAN_OK, execFor(1), REVIEW]);
  assert.equal((await startQueue({ db: ctx.db, home: ctx.home, project: ctx.project }).done).end, 'empty');
  const item = getItem(ctx.db, ctx.project.id, 1)!;
  assert.equal(item.status, 'awaiting_merge');
  assert.equal(item.integratedCommit, null);
  assert.equal(item.branch, 'mabel/1-a');
  assert.equal(git(ctx.root, 'merge-base', 'main', 'mabel/1-a'), git(ctx.root, 'rev-parse', 'main'), 'a branch nasce da base');
  assert.equal(tryGit(ctx.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${INTEGRATION}`), undefined);
});

test('F.1 critério 4: a base entra na integração na abertura; conflito pausa a fila com base_conflict até o humano resolver', async () => {
  const q = project('\n## A\nprimeiro\n\n## B\nsegundo\n', [PLAN_OK, execFor(1), REVIEW, PLAN_OK, execFor(2), REVIEW], 'true');
  assert.equal((await q.start({ itemNumber: 1 })).end, 'once');
  commitOnMain(q.root, 'docs/nota.md', 'nota\n');
  assert.equal((await q.start({ itemNumber: 9 })).end, 'not_found');
  assert.equal(q.show('docs/nota.md'), 'nota', 'base trazida para a integração');
  assert.match(q.merges(), /mabel: traz a main para a mabel\/integracao$/);

  commitOnMain(q.root, 'src/item1.js', 'export const item1 = "main";\n');
  const tip = q.ref(INTEGRATION);
  const paused = await q.start();
  assert.equal(paused.end, 'paused');
  assert.match(paused.message ?? '', /conflito entre a main e a mabel\/integracao em src\/item1\.js; resolva com `git switch mabel\/integracao && git merge main`/);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'ready']], 'nada novo entra');
  assert.equal(q.ref(INTEGRATION), tip, 'a integração não muda');
  assert.match(q.runReportText(), /## Precisa de você\n- Conflito da base \(base_conflict\): conflito entre a main e a mabel\/integracao em src\/item1\.js/);
  assert.deepEqual(inboxJson(q.db, q.project).conflito_base, {
    pendencia: 'conflito_base',
    origem: 'main',
    unidade: null,
    arquivos: ['src/item1.js'],
    comando: 'git switch mabel/integracao && git merge main',
  });
  assert.match(git(q.root, 'worktree', 'list'), /^[^\n]+$/, 'worktree temporário removido');

  // O humano resolve com o comando da pendência e volta à base.
  git(q.root, 'switch', '-q', INTEGRATION);
  tryGit(q.root, 'merge', '-q', '--no-edit', 'main');
  writeFileSync(join(q.root, 'src/item1.js'), 'export const item1 = "juntos";\n');
  git(q.root, 'add', 'src/item1.js');
  git(q.root, 'commit', '-q', '--no-edit');
  git(q.root, 'switch', '-q', 'main');
  const result = await q.start();
  assert.equal(result.end, 'empty', result.message);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge']]);
  assert.equal(inboxJson(q.db, q.project).conflito_base, null);
  assert.doesNotMatch(q.runReportText(), /base_conflict/);
  assertForwardOnly(q.root);
});

/** Estado do S.5: tarefa concluída numa branch de unidade nascida da base. */
function legacyUnit(q: ReturnType<typeof project>, n: number, branch: string, files: Record<string, string>, at: string): string {
  git(q.root, 'branch', branch, 'main');
  commitTo(q.root, branch, files, `mabel: merge #${n} na ${branch}`);
  const commit = q.ref(branch)!;
  const id = getItem(q.db, q.project.id, n)!.id;
  q.db.prepare("UPDATE items SET status = 'awaiting_merge', integrated_commit = ? WHERE id = ?").run(commit, id);
  q.db.prepare("INSERT INTO item_transitions (item_id, from_state, to_state, reason, at) VALUES (?, 'reviewing', 'awaiting_merge', null, ?)").run(id, at);
  return commit;
}

test('F.1 critério 5: unidades abertas do S.5 entram na integração em ordem; as branches migradas são apagadas', async () => {
  const q = project('\n## A\nprimeiro\n\n## B\nsegundo\n\n## C\nterceiro\n', [], 'true');
  git(q.root, 'branch', INTEGRATION, 'main');
  q.db.prepare("INSERT INTO integration_state (project_id, state, updated_at) VALUES (?, ?, '')").run(
    q.project.id,
    JSON.stringify({ base: 'x', builtAt: '', included: [], conflicts: [], paused: [], verify: null }),
  );
  const one = legacyUnit(q, 1, 'mabel/avulso/1-a', { 'src/item1.js': 'um\n' }, '2026-11-02T10:00:00.000Z');
  const two = legacyUnit(q, 2, 'mabel/avulso/2-b', { 'src/item2.js': 'dois\n' }, '2026-11-01T10:00:00.000Z');
  // Só a abertura: o #9 não existe, e a fila termina sem rodar agente.
  assert.equal((await q.start({ itemNumber: 9 })).end, 'not_found');
  assert.equal(
    q.merges(),
    'mabel: integra avulso-2 na mabel/integracao (migração)\nmabel: integra avulso-1 na mabel/integracao (migração)',
    'na ordem da primeira tarefa concluída',
  );
  assert.equal(legacyBranches(q.root), '', 'branches migradas apagadas');
  for (const commit of [one, two]) assert.ok(tryGit(q.root, 'merge-base', '--is-ancestor', commit, INTEGRATION) !== undefined, 'o commit antigo segue alcançável');
  assert.match(q.runReportText(), /## Prontas para entregar\n- avulso #2 B · mabel entregar #2\n- avulso #1 A · mabel entregar #1/);
  assert.equal(readIntegrationState(q.db, q.project.id)?.conflict, null);
  assertForwardOnly(q.root);
});

test('F.1 critério 5: unidade do S.5 que conflita na migração pausa a fila com base_conflict sobre a unidade', async () => {
  const q = project('\n## A\nprimeiro\n\n## B\nsegundo\n', [], 'true');
  git(q.root, 'branch', INTEGRATION, 'main');
  legacyUnit(q, 1, 'mabel/avulso/1-a', { 'package.json': '{ "name": "a" }\n' }, '2026-11-01T10:00:00.000Z');
  legacyUnit(q, 2, 'mabel/avulso/2-b', { 'package.json': '{ "name": "b" }\n' }, '2026-11-02T10:00:00.000Z');
  const result = await q.start();
  assert.equal(result.end, 'paused');
  assert.match(result.message ?? '', /conflito entre a unidade avulso-2 \(mabel\/avulso\/2-b\) e a mabel\/integracao em package\.json; resolva com `git switch mabel\/integracao && git merge mabel\/avulso\/2-b`/);
  assert.equal(legacyBranches(q.root), 'mabel/avulso/2-b', 'a que entrou é apagada; a outra espera o humano');
  assert.equal(readIntegrationState(q.db, q.project.id)?.conflict?.unit, 'avulso-2');
  assert.equal(q.scenario.log().length, 0);
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

test('integração que andou durante a tarefa: merge limpo antes da verificação', async () => {
  const p = pipeline([PLAN_OK, execFor(1), REVIEW], (root) => commitTo(root, INTEGRATION, { 'src/outro.js': 'outro\n' }));
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  assert.equal(p.show('src/outro.js'), 'outro');
  assert.ok(p.show('src/item1.js'));
  assert.equal(p.merges(), 'fora do Mabel\nmabel: merge #1 A na mabel/integracao');
  assertForwardOnly(p.root);
});

const MARKERS = '<<<<<<< HEAD\nexport const item1 = 1;\n=======\nexport const item1 = "da fila";\n>>>>>>> mabel/integracao\n';

test('F.1 critério 3: conflito com a ponta volta ao executor com o merge em andamento; resolvido, a tarefa integra', async () => {
  const p = pipeline([PLAN_OK, execFor(1), execFor(1, 'export const item1 = "resolvido";\n'), REVIEW], (root) =>
    commitTo(root, INTEGRATION, { 'src/item1.js': 'export const item1 = "da fila";\n' }),
  );
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const prompt = p.scenario.log()[2]?.argv.at(-1) ?? '';
  assert.match(prompt, /merge dela no item tem conflitos[\s\S]*merge em andamento[\s\S]*- src\/item1\.js/);
  assert.equal(p.show('src/item1.js'), 'export const item1 = "resolvido";');
  assert.equal(p.item().attempts, 2, 'o conflito contou como tentativa');
  assert.equal(p.item().pendingKind, null);
  assertForwardOnly(p.root);
});

test('F.1 critério 3: conflito que persiste nas três tentativas vai a integration_conflict; responder resolve', async () => {
  const marked = execFor(1, MARKERS);
  const p = pipeline([PLAN_OK, execFor(1), marked, marked, execFor(1, 'export const item1 = "resolvido";\n'), REVIEW], (root) =>
    commitTo(root, INTEGRATION, { 'src/item1.js': 'export const item1 = "da fila";\n' }),
  );
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.equal(p.item().pendingKind, 'integration_conflict');
  assert.deepEqual(p.item().pending?.files, ['src/item1.js']);
  assert.match(p.scenario.log()[3]?.argv.at(-1) ?? '', /continua com marcadores de conflito[\s\S]*- src\/item1\.js/);
  assert.equal(p.show('src/item1.js'), 'export const item1 = "da fila";', 'nada entrou na integração');

  assert.equal(respond(p.db, p.project, p.item(), 'fique com a versão do item'), 'executing');
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  assert.match(p.scenario.log()[4]?.argv.at(-1) ?? '', /tem conflitos[\s\S]*- src\/item1\.js[\s\S]*fique com a versão do item/);
  assert.equal(p.show('src/item1.js'), 'export const item1 = "resolvido";');
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
