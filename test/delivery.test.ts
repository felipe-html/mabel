import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BODY_LIMIT, checkDeliveries, deliver, deliveryBody, deliveryBodyPath, deliveryTitle, type RemoteRepo, listDeliveries, newPrUrl, remoteRepo, updateBaseAfterMerge } from '../src/delivery.ts';
import { git, tryGit } from '../src/git.ts';
import type { StepEvent } from '../src/progress.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { integrationSection } from '../src/report.ts';
import { type QueueOptions, startQueue } from '../src/run.ts';
import { setSpecStatus } from '../src/specs.ts';
import { PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const FAKE_CURL = fileURLToPath(new URL('./fixtures/fake-curl.mjs', import.meta.url));
// O token do Bitbucket do shell de quem roda os testes nunca chega à API de verdade.
delete process.env.BITBUCKET_TOKEN;
delete process.env.BITBUCKET_EMAIL;
const INTEGRATION = 'mabel/integracao';
const PLAN_OK = { structured_output: PLAN };
const REVIEW = { structured_output: REVIEW_OK };
const PR = 'https://github.com/dono/app/pull/42';
const UNIT = { unit: 'pedidos' };
const SPEC_FILE = '# Pedidos\n\n## História\nH.\n\n## Regras\n\n### R1 Regra\n- caso → resultado (borda)\n\n## Fora do escopo\nNada.\n';
const task = (n: number) => `\n## Item ${n}\ndescrição ${n}\nSpec: pedidos\nRegras: R1\n`;

const execFor = (n: number) => ({
  structured_output: {
    resumo: `item ${n}`,
    criterios: [{ id: 'C1', testes: [{ arquivo: `test/item${n}.test.js`, nome: `item ${n} existe` }] }],
    suposicoes: [],
    perguntas: [],
    escopoAdicional: [],
    impedimento: '',
  },
  files: { [`src/item${n}.js`]: `export const item${n} = ${n};\n`, [`test/item${n}.test.js`]: `test('item ${n} existe', () => {});\n` },
});

const GH_OK = {
  'auth status': {},
  'repo view': { stdout: '{"mergeCommitAllowed":true}' },
  'pr create': { stdout: `${PR}\n` },
};

/** Aponta o `gh` falso para as respostas dadas; `null` simula o `gh` não instalado. */
function useGh(dir: string, responses: Record<string, unknown> | null) {
  const scenario = join(dir, `gh-${Math.random().toString(36).slice(2)}.json`);
  const log = `${scenario}.log`;
  writeFileSync(scenario, JSON.stringify(responses ?? {}));
  Object.assign(process.env, {
    MABEL_GH_BIN: responses === null ? join(dir, 'gh-inexistente') : FAKE_GH,
    FAKE_GH_SCENARIO: scenario,
    FAKE_GH_LOG: log,
  });
  return () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; body?: string });
    } catch {
      return [];
    }
  };
}

type CurlCall = { method: string; path: string; config: string; argv: string[]; body?: Record<string, unknown> };

/** Aponta o `curl` falso para as respostas do Bitbucket e define a credencial; devolve as chamadas. */
function useBitbucket(dir: string, responses: Record<string, unknown>, env: Record<string, string> = { BITBUCKET_TOKEN: 'tok-de-teste', BITBUCKET_EMAIL: 'eu@exemplo.com' }) {
  const scenario = join(dir, `curl-${Math.random().toString(36).slice(2)}.json`);
  const log = `${scenario}.log`;
  writeFileSync(scenario, JSON.stringify(responses));
  Object.assign(process.env, { MABEL_CURL_BIN: FAKE_CURL, FAKE_CURL_SCENARIO: scenario, FAKE_CURL_LOG: log, ...env });
  return () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as CurlCall);
    } catch {
      return [];
    }
  };
}

function withoutBitbucket() {
  delete process.env.BITBUCKET_TOKEN;
  delete process.env.BITBUCKET_EMAIL;
}

const BB_REPO = '/repositories/seasolutions/app';
const BB_PR = 'https://bitbucket.org/seasolutions/app/pull-requests/7';
const BB_OK = {
  [`GET ${BB_REPO}`]: { status: 200, body: { full_name: 'seasolutions/app' } },
  [`POST ${BB_REPO}/pullrequests`]: { status: 201, body: { id: 7, links: { html: { href: BB_PR } } } },
};

/** Remoto `origin` com endereço do Bitbucket, publicando no repositório nu do teste. */
function onBitbucket(q: { root: string; origin: string }) {
  git(q.root, 'remote', 'set-url', 'origin', 'git@ssh.bitbucket.org:seasolutions/app.git');
  git(q.root, 'remote', 'set-url', '--push', 'origin', q.origin);
}

/** Projeto com integração, remoto `origin` (repositório nu) e `n` tarefas da spec `pedidos` concluídas. */
async function integrated(n: number, { remote = true } = {}) {
  const backlog = Array.from({ length: n }, (_, i) => task(i + 1)).join('');
  const ctx = setupProject(backlog, { integracao: INTEGRATION });
  Object.assign(ctx.project.config, { setup: null, verify: [{ name: 'existe', command: 'true' }] });
  mkdirSync(join(ctx.root, '.mabel', 'specs'), { recursive: true });
  writeFileSync(join(ctx.root, '.mabel', 'specs', 'pedidos.md'), SPEC_FILE);
  setSpecStatus(ctx.db, ctx.project.id, 'pedidos', 'aceita');
  git(ctx.root, 'add', '.mabel');
  git(ctx.root, 'commit', '-q', '-m', 'spec');
  syncBacklog(ctx.db, ctx.project);
  const origin = mkdtempSync(join(tmpdir(), 'mabel-origin-'));
  if (remote) {
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    git(ctx.root, 'remote', 'add', 'origin', origin);
    git(ctx.root, 'push', '-q', '-u', 'origin', 'main');
  }
  const start = (options: Partial<QueueOptions> = {}) => startQueue({ db: ctx.db, home: ctx.home, project: ctx.project, ...options }).done;
  useScenario(ctx.root, [
    ...Array.from({ length: n }, () => PLAN_OK),
    ...Array.from({ length: n }, (_, i) => [execFor(i + 1), REVIEW]).flat(),
  ]);
  await start();
  const ref = (name: string) => tryGit(ctx.root, 'rev-parse', `refs/heads/${name}`);
  const remoteRef = (name: string) => tryGit(origin, 'rev-parse', `refs/heads/${name}`);
  const status = (number: number) => getItem(ctx.db, ctx.project.id, number)?.status;
  return { ...ctx, origin, start, ref, remoteRef, status };
}

/** Item a mais, integrado depois da entrega. */
async function integrateAnother(q: Awaited<ReturnType<typeof integrated>>, n: number) {
  writeFileSync(q.path, `${readFileSync(q.path, 'utf8')}${task(n)}`);
  syncBacklog(q.db, q.project);
  useScenario(q.root, [PLAN_OK, execFor(n), REVIEW]);
  await q.start();
}

test('entregar critério 1: snapshot da integração, push, PR com o relatório e a entrega gravada', async () => {
  const q = await integrated(3);
  const calls = useGh(q.root, GH_OK);
  const result = deliver(q.db, q.home, q.project, UNIT);
  assert.equal(result.code, 0, result.lines.join('\n'));
  const delivery = result.delivery!;
  assert.equal(delivery.branch, 'mabel/entrega/pedidos');
  assert.equal(delivery.unit, 'pedidos');
  assert.equal(git(q.root, 'rev-parse', `${delivery.branch}^`), q.ref(INTEGRATION), 'ponta da unidade na fila + o commit do documento');
  assert.equal(delivery.snapshot, q.ref(INTEGRATION));
  assert.equal(q.remoteRef(delivery.branch), q.ref(delivery.branch));
  assert.deepEqual(delivery.items, [1, 2, 3]);
  assert.equal(delivery.prUrl, PR);

  const create = calls().find((call) => call.argv[0] === 'pr' && call.argv[1] === 'create')!;
  assert.deepEqual(create.argv.slice(2, 8), ['--base', 'main', '--head', delivery.branch, '--title', 'Mabel: pedidos (#1, #2, #3)']);
  assert.ok(!create.argv.includes('--draft'));
  assert.match(create.body ?? '', /^Faça o merge com merge commit \("Create a merge commit"[^\n]*\n\nResumo: pedidos · \d{4}-\d{2}-\d{2} · /);
  assert.match(create.body ?? '', /\n# Entrega: pedidos\n\nSpec: \.mabel\/specs\/pedidos\.md \([0-9a-f]+\) · Base: main/);
  assert.match(create.body ?? '', /## Olhe primeiro/);
  assert.match(create.body ?? '', /- #3 Item 3 · merge [0-9a-f]{7}/);
  assert.doesNotMatch(create.body ?? '', /git merge --no-ff/);
  assert.equal(readFileSync(deliveryBodyPath(q.home, q.project.id, delivery.branch), 'utf8'), create.body);

  const [row] = listDeliveries(q.db, q.project.id);
  assert.equal(row?.status, 'open');
  assert.equal(row?.remote, 'origin');
  assert.match(result.lines.join('\n'), /PR aberto: https:\/\/github\.com\/dono\/app\/pull\/42/);
  assert.match(result.lines.join('\n'), /Faça o merge com merge commit, sem squash nem rebase\. Depois, na main: git pull/);

  // O relatório da integração aponta a entrega aberta.
  assert.match(integrationSection(q.db, q.home, q.project).join('\n'), new RegExp(`Para entregar: mabel entregar <unidade>[^\n]*\nEntrega aberta: pedidos · ${delivery.branch} · ${PR}`));
});

test('entregar critérios 2 e 5: a entrega fica no snapshot; aberta, recusa sem flag e --substituir abre outra', async () => {
  const q = await integrated(1);
  useGh(q.root, GH_OK);
  const first = deliver(q.db, q.home, q.project, UNIT).delivery!;
  await integrateAnother(q, 2);
  assert.notEqual(q.ref(INTEGRATION), first.snapshot);
  assert.equal(q.ref(first.branch), first.commit, 'a unidade andou, a entrega não');
  assert.deepEqual(listDeliveries(q.db, q.project.id)[0]?.items, [1]);

  const again = deliver(q.db, q.home, q.project, UNIT);
  assert.equal(again.code, 1);
  assert.match(again.lines.join('\n'), /Já há uma entrega aberta.+--substituir/);

  const second = 'https://github.com/dono/app/pull/43';
  const replacing = useGh(q.root, { ...GH_OK, 'pr create': { stdout: second } });
  const replaced = deliver(q.db, q.home, q.project, { ...UNIT, replace: true, draft: true });
  assert.equal(replaced.code, 0, replaced.lines.join('\n'));
  assert.equal(replaced.delivery!.branch, 'mabel/entrega/pedidos-2');
  assert.deepEqual(replaced.delivery!.items, [1, 2]);
  const [old, current] = listDeliveries(q.db, q.project.id);
  assert.equal(old?.status, 'replaced');
  assert.equal(current?.status, 'open');
  assert.equal(q.ref(first.branch), undefined, 'a branch local anterior sai: a nova a contém');
  const log = replacing();
  assert.ok(log.some((call) => call.argv.join(' ') === `pr close ${PR} --comment Substituído por ${second}`));
  assert.ok(log.some((call) => call.argv[1] === 'create' && call.argv.includes('--draft')));

  // Nada novo na integração: --substituir não troca.
  const same = deliver(q.db, q.home, q.project, { ...UNIT, replace: true });
  assert.equal(same.code, 0);
  assert.match(same.lines.join('\n'), /já tem tudo o que está na unidade/);
  assert.equal(listDeliveries(q.db, q.project.id).length, 2);
});

test('entregar critério 3: repositório sem merge commit recusa antes de criar a branch', async () => {
  const q = await integrated(1);
  const calls = useGh(q.root, { ...GH_OK, 'repo view': { stdout: '{"mergeCommitAllowed":false}' } });
  const result = deliver(q.db, q.home, q.project, UNIT);
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /não permite merge commit[\s\S]+Allow merge commits/);
  assert.equal(tryGit(q.root, 'branch', '--list', 'mabel/entrega/*'), '');
  assert.equal(listDeliveries(q.db, q.project.id).length, 0);
  assert.ok(!calls().some((call) => call.argv[1] === 'create'));
});

test('entregar critério 4: sem gh publica e mostra o corpo; sem remoto, só a branch e o git merge', async () => {
  const q = await integrated(1);
  useGh(q.root, null);
  const result = deliver(q.db, q.home, q.project, UNIT);
  assert.equal(result.code, 0, result.lines.join('\n'));
  const branch = result.delivery!.branch;
  assert.equal(q.remoteRef(branch), q.ref(branch));
  const out = result.lines.join('\n');
  assert.match(out, /sem PR automático \(gh não instalado\)/);
  assert.match(out, new RegExp(`Corpo do PR: ${deliveryBodyPath(q.home, q.project.id, branch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(result.delivery!.prUrl, null);

  // Entrega aberta sem PR: rodar de novo retoma (com o gh agora), com a mesma entrega.
  useGh(q.root, GH_OK);
  const resumed = deliver(q.db, q.home, q.project, UNIT);
  assert.equal(resumed.code, 0, resumed.lines.join('\n'));
  assert.equal(resumed.delivery!.id, result.delivery!.id);
  assert.equal(listDeliveries(q.db, q.project.id)[0]?.prUrl, PR);

  const local = await integrated(1, { remote: false });
  useGh(local.root, GH_OK);
  const offline = deliver(local.db, local.home, local.project, UNIT);
  assert.equal(offline.code, 0, offline.lines.join('\n'));
  assert.match(offline.lines.join('\n'), new RegExp(`sem remoto: para levar à main, git merge --no-ff ${offline.delivery!.branch}`));
  assert.equal(git(local.root, 'rev-parse', `${offline.delivery!.branch}^`), local.ref(INTEGRATION));
});

test('entregar: Bitbucket sem BITBUCKET_TOKEN publica, mostra o link do PR e não chama o gh', async () => {
  const q = await integrated(1);
  onBitbucket(q);
  withoutBitbucket();
  const calls = useGh(q.root, GH_OK);
  const result = deliver(q.db, q.home, q.project, UNIT);
  assert.equal(result.code, 0, result.lines.join('\n'));
  const branch = result.delivery!.branch;
  assert.equal(q.remoteRef(branch), q.ref(branch));
  const out = result.lines.join('\n');
  assert.match(out, /sem PR automático \(defina BITBUCKET_TOKEN para o Mabel abrir o PR no Bitbucket; veja o README\)/);
  assert.match(out, new RegExp(`Abra o PR: https://bitbucket\\.org/seasolutions/app/pull-requests/new\\?source=${encodeURIComponent(branch)}&dest=main`));
  assert.match(out, /Corpo do PR: /);
  assert.match(out, /no merge, escolha "Merge commit"/);
  assert.deepEqual(calls(), []);
});

test('entregar: Bitbucket com BITBUCKET_TOKEN abre o PR pela API, com o token fora da linha de comando', async () => {
  const q = await integrated(2);
  onBitbucket(q);
  const gh = useGh(q.root, GH_OK);
  const calls = useBitbucket(q.root, BB_OK);
  try {
    const result = deliver(q.db, q.home, q.project, { ...UNIT, draft: true });
    assert.equal(result.code, 0, result.lines.join('\n'));
    const delivery = result.delivery!;
    assert.equal(delivery.prUrl, BB_PR);
    assert.equal(q.remoteRef(delivery.branch), q.ref(delivery.branch));
    const out = result.lines.join('\n');
    assert.match(out, new RegExp(`PR aberto: ${BB_PR}`));
    assert.match(out, /no merge, escolha "Merge commit"/);
    assert.deepEqual(gh(), []);

    const log = calls();
    assert.deepEqual(log.map((call) => `${call.method} ${call.path}`), [`GET ${BB_REPO}`, `POST ${BB_REPO}/pullrequests`]);
    for (const call of log) {
      assert.equal(call.config, 'user = "eu@exemplo.com:tok-de-teste"\n');
      assert.ok(!call.argv.some((arg) => arg.includes('tok-de-teste')), 'o token não aparece nos argumentos');
    }
    const body = log[1]!.body!;
    assert.equal(body.title, 'Mabel: pedidos (#1, #2)');
    assert.deepEqual(body.source, { branch: { name: delivery.branch } });
    assert.deepEqual(body.destination, { branch: { name: 'main' } });
    assert.equal(body.close_source_branch, false);
    assert.equal(body.draft, true);
    assert.equal(body.description, readFileSync(deliveryBodyPath(q.home, q.project.id, delivery.branch), 'utf8'));

    // Sem e-mail: access token do repositório, como Bearer. O estado vem pelo endereço do PR;
    // o remoto volta ao repositório nu para o fetch do acompanhamento não sair da máquina.
    git(q.root, 'remote', 'set-url', 'origin', q.origin);
    delete process.env.BITBUCKET_EMAIL;
    const state = useBitbucket(q.root, { [`GET ${BB_REPO}/pullrequests/7`]: { status: 200, body: { state: 'MERGED' } } }, { BITBUCKET_TOKEN: 'tok-repo' });
    const notes = checkDeliveries(q.db, q.project).join('\n');
    assert.match(notes, /sem merge commit \(squash ou rebase\)/);
    assert.deepEqual(state().map((call) => call.config), ['header = "Authorization: Bearer tok-repo"\n']);
  } finally {
    withoutBitbucket();
  }
});

test('entregar: Bitbucket --substituir recusa o PR anterior com comentário', async () => {
  const q = await integrated(1);
  onBitbucket(q);
  useGh(q.root, GH_OK);
  useBitbucket(q.root, BB_OK);
  try {
    const first = deliver(q.db, q.home, q.project, UNIT);
    assert.equal(first.code, 0, first.lines.join('\n'));
    git(q.root, 'remote', 'set-url', 'origin', q.origin);
    await integrateAnother(q, 2);
    onBitbucket(q);
    const second = 'https://bitbucket.org/seasolutions/app/pull-requests/8';
    const calls = useBitbucket(q.root, {
      ...BB_OK,
      [`POST ${BB_REPO}/pullrequests`]: { status: 201, body: { id: 8, links: { html: { href: second } } } },
      [`POST ${BB_REPO}/pullrequests/7/comments`]: { status: 201, body: {} },
      [`POST ${BB_REPO}/pullrequests/7/decline`]: { status: 200, body: { state: 'DECLINED' } },
    });
    const replaced = deliver(q.db, q.home, q.project, { ...UNIT, replace: true });
    assert.equal(replaced.code, 0, replaced.lines.join('\n'));
    assert.match(replaced.lines.join('\n'), new RegExp(`PR anterior fechado: ${BB_PR}`));
    const log = calls();
    const comment = log.find((call) => call.path.endsWith('/7/comments'));
    assert.deepEqual(comment?.body, { content: { raw: `Substituído por ${second}` } });
    assert.ok(log.some((call) => call.method === 'POST' && call.path.endsWith('/7/decline')));
  } finally {
    withoutBitbucket();
  }
});

test('entregar: Bitbucket recusando o token mostra o motivo e o link', async () => {
  const q = await integrated(1);
  onBitbucket(q);
  useGh(q.root, GH_OK);
  useBitbucket(q.root, { [`GET ${BB_REPO}`]: { status: 401, body: { type: 'error', error: { message: 'Token is invalid or expired' } } } });
  try {
    const result = deliver(q.db, q.home, q.project, UNIT);
    assert.equal(result.code, 0, result.lines.join('\n'));
    const out = result.lines.join('\n');
    assert.match(out, /sem PR automático \(o Bitbucket recusou o BITBUCKET_TOKEN \(HTTP 401: Token is invalid or expired\)\)/);
    assert.match(out, /Abra o PR: https:\/\/bitbucket\.org\/seasolutions\/app\/pull-requests\/new/);
    assert.equal(result.delivery!.prUrl, null);
  } finally {
    withoutBitbucket();
  }
});

test('entregar: token do Bitbucket sem escopo de PR diz quais escopos faltam', async () => {
  const q = await integrated(1);
  onBitbucket(q);
  useGh(q.root, GH_OK);
  useBitbucket(q.root, {
    ...BB_OK,
    [`POST ${BB_REPO}/pullrequests`]: { status: 403, body: { type: 'error', error: { message: 'Your credentials lack one or more required privilege scopes.' } } },
  });
  try {
    const result = deliver(q.db, q.home, q.project, UNIT);
    assert.equal(result.code, 1);
    const out = result.lines.join('\n');
    assert.match(out, /o Bitbucket não abriu o PR: Your credentials lack .* O token precisa dos escopos read:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket; .*crie outro/);
    assert.match(out, /Abra o PR: https:\/\/bitbucket\.org\/seasolutions\/app\/pull-requests\/new/);
    assert.equal(result.delivery!.prUrl, null);
  } finally {
    withoutBitbucket();
  }
});

test('entregar: URL do PR e repositório pelo remoto', () => {
  const github: RemoteRepo = { host: 'github', repo: 'dono/app' };
  const bitbucket: RemoteRepo = { host: 'bitbucket', repo: 'seasolutions/app' };
  assert.deepEqual(remoteRepo('https://github.com/dono/app.git'), github);
  assert.deepEqual(remoteRepo('git@github.com:dono/app.git'), github);
  assert.deepEqual(remoteRepo('ssh://git@github.com/dono/app'), github);
  assert.deepEqual(remoteRepo('git@ssh.bitbucket.org:seasolutions/app.git'), bitbucket);
  assert.deepEqual(remoteRepo('git@bitbucket.org:seasolutions/app.git'), bitbucket);
  assert.deepEqual(remoteRepo('https://felipe@bitbucket.org/seasolutions/app.git'), bitbucket);
  assert.equal(remoteRepo('/tmp/origin'), undefined);
  assert.equal(newPrUrl(github, 'mabel/entrega/2026-10-22', 'main'), 'https://github.com/dono/app/compare/main...mabel/entrega/2026-10-22?expand=1');
  assert.equal(
    newPrUrl(bitbucket, 'mabel/entrega/2026-10-22', 'main'),
    'https://bitbucket.org/seasolutions/app/pull-requests/new?source=mabel%2Fentrega%2F2026-10-22&dest=main',
  );
  assert.equal(deliveryTitle('avulso-3', [3]), 'Mabel: avulso-3 (#3)');
  const long = deliveryTitle('pedidos', Array.from({ length: 30 }, (_, i) => i + 100));
  assert.ok(long.length <= 70, long);
  assert.match(long, /^Mabel: pedidos \(#100, #101, .+, …\)$/);
});

test('entregar critério 6: checkout da raiz volta à base só se estiver na integração e limpo', async () => {
  const q = await integrated(1);
  useGh(q.root, GH_OK);
  git(q.root, 'switch', '-q', INTEGRATION);
  writeFileSync(join(q.root, 'README.md'), 'alterado\n');
  const dirty = deliver(q.db, q.home, q.project, UNIT);
  assert.equal(dirty.code, 0);
  assert.match(dirty.lines.join('\n'), /Checkout da raiz em mabel\/integracao com alterações; não troquei para a main\./);
  assert.equal(git(q.root, 'branch', '--show-current'), INTEGRATION);

  // Com a integração aberta no checkout, o `run` pausa: o item novo entra com a raiz na base.
  git(q.root, 'checkout', '-q', '--', 'README.md');
  git(q.root, 'switch', '-q', 'main');
  await integrateAnother(q, 2);
  git(q.root, 'commit', '-q', '-m', 'backlog', '--', '.mabel/backlog.md');
  git(q.root, 'switch', '-q', INTEGRATION);
  const clean = deliver(q.db, q.home, q.project, { ...UNIT, replace: true });
  assert.equal(clean.code, 0, clean.lines.join('\n'));
  assert.match(clean.lines.join('\n'), /checkout da raiz: mabel\/integracao → main/);
  assert.equal(git(q.root, 'branch', '--show-current'), 'main');

  git(q.root, 'switch', '-q', '-c', 'outra');
  await integrateAnother(q, 3);
  const other = deliver(q.db, q.home, q.project, { ...UNIT, replace: true });
  assert.equal(other.code, 0, other.lines.join('\n'));
  assert.doesNotMatch(other.lines.join('\n'), /checkout da raiz|não troquei/);
  assert.equal(git(q.root, 'branch', '--show-current'), 'outra');
});

test('entregar critérios 7 e 8: merge só no remoto avisa; merge na base leva a merged e os itens a done', async () => {
  const q = await integrated(2);
  useGh(q.root, GH_OK);
  const delivery = deliver(q.db, q.home, q.project, UNIT).delivery!;

  // O PR foi integrado no GitHub: merge commit na main do remoto, a main local parada.
  const tree = git(q.root, 'rev-parse', `${delivery.commit}^{tree}`);
  const merge = git(q.root, 'commit-tree', tree, '-p', 'main', '-p', delivery.commit, '-m', 'Merge pull request #42');
  git(q.root, 'push', '-q', 'origin', `${merge}:refs/heads/main`);
  assert.deepEqual(checkDeliveries(q.db, q.project), [
    'O PR da entrega foi integrado no origin; atualize a main local (git pull) para os itens irem a done.',
  ]);
  assert.equal(listDeliveries(q.db, q.project.id)[0]?.status, 'open');

  git(q.root, 'pull', '-q', '--ff-only');
  // Sem `run` no meio: a próxima entrega já vê a anterior na base e não recusa.
  const next = deliver(q.db, q.home, q.project, UNIT);
  assert.equal(next.code, 0, next.lines.join('\n'));
  assert.deepEqual(next.lines, [
    `entrega ${delivery.branch} na main; branch local apagada`,
    'Nada a entregar: a unidade pedidos não tem tarefa concluída fora da main.',
  ]);
  useScenario(q.root, []);
  await q.start();
  assert.equal(listDeliveries(q.db, q.project.id)[0]?.status, 'merged');
  assert.equal(q.ref(delivery.branch), undefined);
  assert.equal(q.status(1), 'done');
  assert.equal(q.status(2), 'done');
});

test('entregar critério 9: PR integrado por squash explica e mostra o conserto', async () => {
  const q = await integrated(1);
  useGh(q.root, GH_OK);
  const delivery = deliver(q.db, q.home, q.project, UNIT).delivery!;
  useGh(q.root, { 'pr view': { stdout: '{"state":"MERGED"}' } });
  const notes = checkDeliveries(q.db, q.project).join('\n');
  assert.match(notes, /sem merge commit \(squash ou rebase\)/);
  assert.match(notes, new RegExp(`git merge --no-ff ${delivery.branch}`));
  assert.equal(listDeliveries(q.db, q.project.id)[0]?.status, 'open');

  useGh(q.root, { 'pr view': { stdout: '{"state":"OPEN"}' } });
  assert.deepEqual(checkDeliveries(q.db, q.project), []);
});

test('entregar critério 10: rejeitar item da entrega aberta avisa sobre o --substituir', async () => {
  const q = await integrated(2);
  useGh(q.root, GH_OK);
  deliver(q.db, q.home, q.project, UNIT);
  const out = q.cli('rejeitar', '2', 'refazer');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`O #2 está na entrega aberta \\(${PR.replace(/[.?/]/g, '\\$&')}\\)\\. Rode mabel entregar pedidos --substituir`));
});

test('entregar critério 11: remoção do projeto leva as entregas e o corpo do PR', async () => {
  const q = await integrated(1);
  useGh(q.root, GH_OK);
  const delivery = deliver(q.db, q.home, q.project, UNIT).delivery!;
  const summary = q.cli('auditar', 'remover', q.project.name);
  assert.match(summary.stdout, /banco: .*deliveries/);
  assert.match(summary.stdout, /entregas\//);
  const removed = q.cli('auditar', 'remover', q.project.name, '--confirmar', q.project.name);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(listDeliveries(q.db, q.project.id).length, 0);
  assert.ok(!existsSync(deliveryBodyPath(q.home, q.project.id, delivery.branch)));
});

test('entregar: corpo acima do limite corta o documento na última linha inteira e aponta o arquivo', async () => {
  const q = await integrated(3);
  useGh(q.root, GH_OK);
  const delivery = deliver(q.db, q.home, q.project, UNIT).delivery!;
  const full = deliveryBody(q.project, delivery);
  assert.ok(full.length < BODY_LIMIT);
  const limit = full.indexOf('## Tarefas');
  const cut = deliveryBody(q.project, delivery, limit);
  assert.ok(cut.length <= limit, `${cut.length}`);
  assert.match(cut, /^Faça o merge[\s\S]*## Olhe primeiro/);
  assert.doesNotMatch(cut, /## Tarefas/);
  assert.match(cut, /\n\n… documento cortado; a íntegra está em \.mabel\/entregas\/[\d-]+-pedidos\.md na branch mabel\/entrega\/pedidos\.\n$/);
});

test('entregar: integração desligada e nada a entregar', async () => {
  const off = setupProject();
  assert.equal(deliver(off.db, off.home, off.project).code, 1);
  const empty = setupProject('', { integracao: INTEGRATION });
  git(empty.root, 'branch', INTEGRATION);
  const result = deliver(empty.db, empty.home, empty.project);
  assert.equal(result.code, 0);
  assert.equal(result.lines[0], 'Nada a entregar: nenhuma unidade com tarefa concluída fora da base.');
  assert.deepEqual(result.lines.slice(2, 4), ['## Em andamento', 'Nada.']);
  const cli = empty.cli('entregar');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Nada a entregar/);
});

test('entregar: onStep inclui publicar a branch e abrir o PR; o PR recusado fica com ✗', async () => {
  const q = await integrated(1);
  useGh(q.root, { ...GH_OK, 'pr create': { code: 1, stderr: 'sem permissão' } });
  const done: string[] = [];
  const onStep = (event: StepEvent) => {
    if (event.kind === 'end') done.push(`${event.ok ? '✓' : '✗'} ${event.label}`);
  };
  const failed = deliver(q.db, q.home, q.project, { ...UNIT, onStep });
  assert.equal(failed.code, 1);
  assert.match(failed.lines.join('\n'), /o gh não abriu o PR: sem permissão/);
  assert.deepEqual(done, [
    '✓ conferir entregas abertas',
    '✓ preparar a cópia da base',
    '✓ juntar a unidade',
    '✓ verificar existe · true',
    '✓ apagar a cópia',
    '✓ gravar o documento',
    '✓ publicar a branch',
    '✗ abrir o PR',
  ]);

  // A retomada só publica e abre o PR.
  useGh(q.root, GH_OK);
  done.length = 0;
  assert.equal(deliver(q.db, q.home, q.project, { ...UNIT, onStep }).code, 0);
  assert.deepEqual(done.filter((line) => line !== '✓ voltar à base'), ['✓ conferir entregas abertas', '✓ publicar a branch', '✓ abrir o PR']);
});

test('entregar: "já fiz o merge" só atualiza a base depois do merge do PR, por fast-forward', async () => {
  const q = await integrated(1);
  useGh(q.root, GH_OK);
  const delivery = deliver(q.db, q.home, q.project, UNIT).delivery!;
  const before = q.ref('main');

  const early = updateBaseAfterMerge(q.db, q.project, delivery);
  assert.equal(early.done, false);
  assert.match(early.lines.join('\n'), /O merge da entrega \(https:\/\/github\.com\/dono\/app\/pull\/42\) ainda não está na main do origin/);
  assert.equal(q.ref('main'), before, 'nada muda antes do merge');

  // O humano faz o merge do PR no remoto.
  const human = mkdtempSync(join(tmpdir(), 'mabel-humano-'));
  git(human, 'clone', '-q', q.origin, '.');
  // Identidade própria: no CI não há `user.name`/`user.email` globais.
  git(human, 'config', 'user.name', 'Humano');
  git(human, 'config', 'user.email', 'humano@example.com');
  git(human, 'merge', '-q', '--no-ff', '-m', 'Merge do PR', `origin/${delivery.branch}`);
  git(human, 'push', '-q', 'origin', 'main');

  const updated = updateBaseAfterMerge(q.db, q.project, delivery);
  assert.equal(updated.done, true, updated.lines.join('\n'));
  assert.equal(q.ref('main'), q.remoteRef('main'));
  assert.equal(tryGit(q.root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.match(updated.lines.join('\n'), new RegExp(`^main atualizada com o origin\\nentrega ${delivery.branch} na main; branch local apagada`));
  assert.equal(listDeliveries(q.db, q.project.id)[0]?.status, 'merged');
});
