import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDeliveries, deliver, deliveryBodyPath, deliveryTitle, type RemoteRepo, listDeliveries, newPrUrl, remoteRepo } from '../src/delivery.ts';
import { git, tryGit } from '../src/git.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { renderIntegrationReport } from '../src/report.ts';
import { type QueueOptions, startQueue } from '../src/run.ts';
import { PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const INTEGRATION = 'mabel/integracao';
const PLAN_OK = { structured_output: PLAN };
const REVIEW = { structured_output: REVIEW_OK };
const PR = 'https://github.com/dono/app/pull/42';
const BRANCH = /^mabel\/entrega\/\d{4}-\d{2}-\d{2}$/;

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

/** Projeto com integração, remoto `origin` (repositório nu) e `n` itens integrados. */
async function integrated(n: number, { remote = true } = {}) {
  const backlog = Array.from({ length: n }, (_, i) => `\n## Item ${i + 1}\ndescrição ${i + 1}\n`).join('');
  const ctx = setupProject(backlog, { integracao: INTEGRATION });
  Object.assign(ctx.project.config, { setup: null, verify: [{ name: 'existe', command: 'true' }] });
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
  writeFileSync(q.path, `${readFileSync(q.path, 'utf8')}\n## Item ${n}\ndescrição ${n}\n`);
  syncBacklog(q.db, q.project);
  useScenario(q.root, [PLAN_OK, execFor(n), REVIEW]);
  await q.start();
}

test('entregar critério 1: snapshot da integração, push, PR com o relatório e a entrega gravada', async () => {
  const q = await integrated(3);
  const calls = useGh(q.root, GH_OK);
  const result = deliver(q.db, q.home, q.project);
  assert.equal(result.code, 0, result.lines.join('\n'));
  const delivery = result.delivery!;
  assert.match(delivery.branch, BRANCH);
  assert.equal(q.ref(delivery.branch), q.ref(INTEGRATION));
  assert.equal(q.remoteRef(delivery.branch), q.ref(INTEGRATION));
  assert.deepEqual(delivery.items, [1, 2, 3]);
  assert.equal(delivery.prUrl, PR);

  const create = calls().find((call) => call.argv[0] === 'pr' && call.argv[1] === 'create')!;
  assert.deepEqual(create.argv.slice(2, 8), ['--base', 'main', '--head', delivery.branch, '--title', 'Mabel: 3 itens (#1, #2, #3)']);
  assert.ok(!create.argv.includes('--draft'));
  assert.match(create.body ?? '', new RegExp(`^# Entrega · ${delivery.branch} · 3 itens desde a main\n`));
  assert.match(create.body ?? '', /Create a merge commit/);
  assert.match(create.body ?? '', /## Olhe primeiro/);
  assert.match(create.body ?? '', /## #3 Item 3/);
  assert.doesNotMatch(create.body ?? '', /git merge --no-ff/);
  assert.equal(readFileSync(deliveryBodyPath(q.home, q.project.id, delivery.branch), 'utf8'), create.body);

  const [row] = listDeliveries(q.db, q.project.id);
  assert.equal(row?.status, 'open');
  assert.equal(row?.remote, 'origin');
  assert.match(result.lines.join('\n'), /PR aberto: https:\/\/github\.com\/dono\/app\/pull\/42/);
  assert.match(result.lines.join('\n'), /Faça o merge com merge commit, sem squash nem rebase\. Depois, na main: git pull/);

  // O relatório da integração aponta a entrega aberta.
  assert.match(renderIntegrationReport(q.db, q.home, q.project), new RegExp(`ou: mabel entregar\nEntrega aberta: ${delivery.branch} · ${PR}`));
});

test('entregar critérios 2 e 5: a entrega fica no snapshot; aberta, recusa sem flag e --substituir abre outra', async () => {
  const q = await integrated(1);
  useGh(q.root, GH_OK);
  const first = deliver(q.db, q.home, q.project).delivery!;
  await integrateAnother(q, 2);
  assert.notEqual(q.ref(INTEGRATION), first.commit);
  assert.equal(q.ref(first.branch), first.commit, 'a integração andou, a entrega não');
  assert.deepEqual(listDeliveries(q.db, q.project.id)[0]?.items, [1]);

  const again = deliver(q.db, q.home, q.project);
  assert.equal(again.code, 1);
  assert.match(again.lines.join('\n'), /Já há uma entrega aberta.+--substituir/);

  const second = 'https://github.com/dono/app/pull/43';
  const replacing = useGh(q.root, { ...GH_OK, 'pr create': { stdout: second } });
  const replaced = deliver(q.db, q.home, q.project, { replace: true, draft: true });
  assert.equal(replaced.code, 0, replaced.lines.join('\n'));
  assert.match(replaced.delivery!.branch, /^mabel\/entrega\/\d{4}-\d{2}-\d{2}-2$/);
  assert.deepEqual(replaced.delivery!.items, [1, 2]);
  const [old, current] = listDeliveries(q.db, q.project.id);
  assert.equal(old?.status, 'replaced');
  assert.equal(current?.status, 'open');
  assert.equal(q.ref(first.branch), undefined, 'a branch local anterior sai: a nova a contém');
  const log = replacing();
  assert.ok(log.some((call) => call.argv.join(' ') === `pr close ${PR} --comment Substituído por ${second}`));
  assert.ok(log.some((call) => call.argv[1] === 'create' && call.argv.includes('--draft')));

  // Nada novo na integração: --substituir não troca.
  const same = deliver(q.db, q.home, q.project, { replace: true });
  assert.equal(same.code, 0);
  assert.match(same.lines.join('\n'), /já tem tudo o que está na integração/);
  assert.equal(listDeliveries(q.db, q.project.id).length, 2);
});

test('entregar critério 3: repositório sem merge commit recusa antes de criar a branch', async () => {
  const q = await integrated(1);
  const calls = useGh(q.root, { ...GH_OK, 'repo view': { stdout: '{"mergeCommitAllowed":false}' } });
  const result = deliver(q.db, q.home, q.project);
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /não permite merge commit[\s\S]+Allow merge commits/);
  assert.equal(tryGit(q.root, 'branch', '--list', 'mabel/entrega/*'), '');
  assert.equal(listDeliveries(q.db, q.project.id).length, 0);
  assert.ok(!calls().some((call) => call.argv[1] === 'create'));
});

test('entregar critério 4: sem gh publica e mostra o corpo; sem remoto, só a branch e o git merge', async () => {
  const q = await integrated(1);
  useGh(q.root, null);
  const result = deliver(q.db, q.home, q.project);
  assert.equal(result.code, 0, result.lines.join('\n'));
  const branch = result.delivery!.branch;
  assert.equal(q.remoteRef(branch), q.ref(INTEGRATION));
  const out = result.lines.join('\n');
  assert.match(out, /sem PR automático \(gh não instalado\)/);
  assert.match(out, new RegExp(`Corpo do PR: ${deliveryBodyPath(q.home, q.project.id, branch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(result.delivery!.prUrl, null);

  // Entrega aberta sem PR: rodar de novo retoma (com o gh agora), com a mesma entrega.
  useGh(q.root, GH_OK);
  const resumed = deliver(q.db, q.home, q.project);
  assert.equal(resumed.code, 0, resumed.lines.join('\n'));
  assert.equal(resumed.delivery!.id, result.delivery!.id);
  assert.equal(listDeliveries(q.db, q.project.id)[0]?.prUrl, PR);

  const local = await integrated(1, { remote: false });
  useGh(local.root, GH_OK);
  const offline = deliver(local.db, local.home, local.project);
  assert.equal(offline.code, 0, offline.lines.join('\n'));
  assert.match(offline.lines.join('\n'), new RegExp(`sem remoto: para levar à main, git merge --no-ff ${offline.delivery!.branch}`));
  assert.equal(local.ref(offline.delivery!.branch), local.ref(INTEGRATION));
});

test('entregar: remoto no Bitbucket publica, mostra o link do PR e não chama o gh', async () => {
  const q = await integrated(1);
  git(q.root, 'remote', 'set-url', 'origin', 'git@ssh.bitbucket.org:seasolutions/app.git');
  git(q.root, 'remote', 'set-url', '--push', 'origin', q.origin);
  const calls = useGh(q.root, GH_OK);
  const result = deliver(q.db, q.home, q.project);
  assert.equal(result.code, 0, result.lines.join('\n'));
  const branch = result.delivery!.branch;
  assert.equal(q.remoteRef(branch), q.ref(INTEGRATION));
  const out = result.lines.join('\n');
  assert.match(out, /sem PR automático \(o remoto origin está no Bitbucket; o gh só abre PR no GitHub\)/);
  assert.match(out, new RegExp(`Abra o PR: https://bitbucket\\.org/seasolutions/app/pull-requests/new\\?source=${encodeURIComponent(branch)}&dest=main`));
  assert.match(out, /Corpo do PR: /);
  assert.match(out, /no merge, escolha "Merge commit"/);
  assert.deepEqual(calls(), []);
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
  assert.equal(deliveryTitle([3]), 'Mabel: 1 item (#3)');
  const long = deliveryTitle(Array.from({ length: 30 }, (_, i) => i + 100));
  assert.ok(long.length <= 70, long);
  assert.match(long, /^Mabel: 30 itens \(#100, #101, .+, …\)$/);
});

test('entregar critério 6: checkout da raiz volta à base só se estiver na integração e limpo', async () => {
  const q = await integrated(1);
  useGh(q.root, GH_OK);
  git(q.root, 'switch', '-q', INTEGRATION);
  writeFileSync(join(q.root, 'README.md'), 'alterado\n');
  const dirty = deliver(q.db, q.home, q.project);
  assert.equal(dirty.code, 0);
  assert.match(dirty.lines.join('\n'), /Checkout da raiz em mabel\/integracao com alterações; não troquei para a main\./);
  assert.equal(git(q.root, 'branch', '--show-current'), INTEGRATION);

  // Com a integração aberta no checkout, o `run` pausa: o item novo entra com a raiz na base.
  git(q.root, 'checkout', '-q', '--', 'README.md');
  git(q.root, 'switch', '-q', 'main');
  await integrateAnother(q, 2);
  git(q.root, 'commit', '-q', '-m', 'backlog', '--', '.mabel/backlog.md');
  git(q.root, 'switch', '-q', INTEGRATION);
  const clean = deliver(q.db, q.home, q.project, { replace: true });
  assert.equal(clean.code, 0, clean.lines.join('\n'));
  assert.match(clean.lines.join('\n'), /checkout da raiz: mabel\/integracao → main/);
  assert.equal(git(q.root, 'branch', '--show-current'), 'main');

  git(q.root, 'switch', '-q', '-c', 'outra');
  await integrateAnother(q, 3);
  const other = deliver(q.db, q.home, q.project, { replace: true });
  assert.equal(other.code, 0, other.lines.join('\n'));
  assert.doesNotMatch(other.lines.join('\n'), /checkout da raiz|não troquei/);
  assert.equal(git(q.root, 'branch', '--show-current'), 'outra');
});

test('entregar critérios 7 e 8: merge só no remoto avisa; merge na base leva a merged e os itens a done', async () => {
  const q = await integrated(2);
  useGh(q.root, GH_OK);
  const delivery = deliver(q.db, q.home, q.project).delivery!;

  // O PR foi integrado no GitHub: merge commit na main do remoto, a main local parada.
  const tree = git(q.root, 'rev-parse', `${delivery.commit}^{tree}`);
  const merge = git(q.root, 'commit-tree', tree, '-p', 'main', '-p', delivery.commit, '-m', 'Merge pull request #42');
  git(q.root, 'push', '-q', 'origin', `${merge}:refs/heads/main`);
  assert.deepEqual(checkDeliveries(q.db, q.project), [
    'O PR da entrega foi integrado no origin; atualize a main local (git pull) para os itens irem a done.',
  ]);
  assert.equal(listDeliveries(q.db, q.project.id)[0]?.status, 'open');

  git(q.root, 'pull', '-q', '--ff-only');
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
  const delivery = deliver(q.db, q.home, q.project).delivery!;
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
  deliver(q.db, q.home, q.project);
  const out = q.cli('rejeitar', '2', 'refazer');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`O #2 está na entrega aberta \\(${PR.replace(/[.?/]/g, '\\$&')}\\)\\. Rode mabel entregar --substituir`));
});

test('entregar critério 11: remoção do projeto leva as entregas e o corpo do PR', async () => {
  const q = await integrated(1);
  useGh(q.root, GH_OK);
  const delivery = deliver(q.db, q.home, q.project).delivery!;
  const summary = q.cli('projeto', 'remover', q.project.name);
  assert.match(summary.stdout, /banco: .*deliveries/);
  assert.match(summary.stdout, /entregas\//);
  const removed = q.cli('projeto', 'remover', q.project.name, '--confirmar', q.project.name);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(listDeliveries(q.db, q.project.id).length, 0);
  assert.ok(!existsSync(deliveryBodyPath(q.home, q.project.id, delivery.branch)));
});

test('entregar: corpo acima do limite corta os itens do fim, nunca o "Olhe primeiro"', async () => {
  const q = await integrated(3);
  const full = renderIntegrationReport(q.db, q.home, q.project);
  const head = full.slice(0, full.indexOf('\n\n## #1'));
  const cut = renderIntegrationReport(q.db, q.home, q.project, { maxChars: head.length + 200 });
  assert.ok(cut.length <= head.length + 200, `${cut.length}`);
  assert.match(cut, /## Olhe primeiro/);
  assert.doesNotMatch(cut, /## #3/);
  assert.match(cut, /… \d itens? sem detalhe aqui; rode mabel integracao\.\n$/);
  assert.equal(renderIntegrationReport(q.db, q.home, q.project, { maxChars: 1_000_000 }), full);
});

test('entregar: integração desligada e nada a entregar', async () => {
  const off = setupProject();
  assert.equal(deliver(off.db, off.home, off.project).code, 1);
  const empty = setupProject('', { integracao: INTEGRATION });
  git(empty.root, 'branch', INTEGRATION);
  const result = deliver(empty.db, empty.home, empty.project);
  assert.equal(result.code, 0);
  assert.deepEqual(result.lines, ['Nada a entregar: a mabel/integracao não tem itens fora da main.']);
  const cli = empty.cli('entregar');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Nada a entregar/);
});
