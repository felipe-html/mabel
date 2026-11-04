import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DecisionError, reject } from '../src/decisions.ts';
import { git, tryGit } from '../src/git.ts';
import { getItem, listItems, syncBacklog } from '../src/items.ts';
import { type QueueOptions, startQueue } from '../src/run.ts';
import { setSpecStatus } from '../src/specs.ts';
import { PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const INTEGRATION = 'mabel/integracao';
const REVIEW = { structured_output: REVIEW_OK };
const PLAN_OK = { structured_output: PLAN };

const execFor = (n: number, file = `src/item${n}.js`, content = `export const item${n} = ${n};\n`) => ({
  structured_output: {
    resumo: `item ${n}`,
    criterios: [{ id: 'C1', testes: [{ arquivo: `test/item${n}.test.js`, nome: `item ${n} existe` }] }],
    suposicoes: [],
    perguntas: [],
    escopoAdicional: [],
    impedimento: '',
  },
  files: { [file]: content, [`test/item${n}.test.js`]: `test('item ${n} existe', () => {});\n` },
});

function project(backlog: string, responses: unknown[]) {
  const ctx = setupProject(backlog, { integracao: INTEGRATION });
  Object.assign(ctx.project.config, { setup: null, verify: [{ name: 'existe', command: 'true' }] });
  syncBacklog(ctx.db, ctx.project);
  const scenario = useScenario(ctx.root, responses);
  const start = (options: Partial<QueueOptions> = {}) =>
    startQueue({ db: ctx.db, home: ctx.home, project: ctx.project, ...options }).done;
  const item = (n: number) => getItem(ctx.db, ctx.project.id, n)!;
  const show = (path: string) => tryGit(ctx.root, 'show', `${INTEGRATION}:${path}`);
  const report = () => readFileSync(join(ctx.root, '.mabel', 'run.md'), 'utf8');
  return { ...ctx, scenario, start, item, show, report };
}

const PLAN_RICH = {
  structured_output: {
    ...PLAN,
    criterios: [
      { id: 'C1', texto: 'soma(2, 3) devolve 5', verificacao: 'teste', comportamento: 'novo' },
      { id: 'C2', texto: 'o botão aparece na tela', verificacao: 'humano', comportamento: 'novo' },
    ],
    suposicoes: [{ texto: 'arredonda para baixo', regraCritica: false }],
  },
};

test('P.5 critério 1: relatório com as seções, regenerado a cada integração', async () => {
  const review2 = { structured_output: { ...REVIEW_OK, criterios: [...REVIEW_OK.criterios, { id: 'C2', atendido: true, evidencia: 'tela' }] } };
  const q = project('\n## A\nprimeiro\n\n## B\nsegundo\n', [PLAN_RICH, execFor(1), review2]);
  const first = await q.start({ limit: 1, batch: false });
  assert.equal(first.end, 'once');
  assert.match(q.report(), /\n## Integração\nmain \([0-9a-f]+\) \+ 1 tarefa na fila \(avulso-1\) · base em dia\n/);

  useScenario(q.root, [PLAN_OK, execFor(2), REVIEW]);
  await q.start();
  const report = q.report();
  assert.match(report, /main \([0-9a-f]+\) \+ 2 tarefas na fila \(avulso-1, avulso-2\) · base em dia/);
  const look = report.slice(report.indexOf('### Olhe primeiro'), report.indexOf('### #1'));
  assert.match(look, /- #1 A: C1 sem prova \(sem `testeUnico` nem comando de teste no `verify`\)/);
  assert.match(look, /- #1 A: 1 suposição/);
  assert.match(look, /- #1 A: valide C2 — o botão aparece na tela/);
  assert.ok(report.indexOf('### #1 A') < report.indexOf('### #2 B'), 'ordem de integração');
  assert.match(
    report,
    /### #1 A · sem prova · 1 tentativa · US\$ [\d,]+\nCritérios\n {2}C1 novo {5}soma\(2, 3\) devolve 5 · test\/item1\.test\.js › item 1 existe · sem_prova\n {2}C2 humano {3}o botão aparece na tela · validação humana\nValidação humana: C2 o botão aparece na tela\nSuposições: arredonda para baixo\nDevoluções: —\nArquivos: 2 alterados, \+2 −0/,
  );
  // Não versionado: ignorado no repositório (projeto novo, pelo .gitignore do init).
  assert.ok(tryGit(q.root, 'check-ignore', '-q', '.mabel/run.md') !== undefined);
  // `mabel entregar` sem unidade mostra as seções de unidade do run.md.
  const cli = q.cli('entregar');
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^## Prontas para entregar\n- avulso #1 A · mabel entregar #1\n- avulso #2 B · mabel entregar #2\n/);
  assert.match(cli.stdout, /main \([0-9a-f]+\) \+ 2 tarefas na fila/);
  assert.doesNotMatch(cli.stdout, /## Tarefas deste run/);
});

test('S.1: projeto antigo, sem o run.md no .gitignore, o ignora pelo info/exclude', async () => {
  const q = project('\n## A\nprimeiro\n', [PLAN_OK, execFor(1), REVIEW]);
  writeFileSync(join(q.root, '.mabel', '.gitignore'), 'quadro.md\n');
  git(q.root, 'commit', '-q', '-m', 'gitignore antigo', '--', '.mabel/.gitignore');
  await q.start();
  assert.ok(existsSync(join(q.root, '.mabel', 'run.md')));
  assert.doesNotMatch(git(q.root, 'status', '--porcelain'), /run\.md/);
  assert.match(readFileSync(join(q.root, '.git', 'info', 'exclude'), 'utf8'), /^\/\.mabel\/run\.md$/m);
});

const SPEC = '# X\n\n## História\nH.\n\n## Regras\n\n### R1 Regra\n- caso → resultado (borda)\n\n## Fora do escopo\nNada.\n';

/** Tarefas da mesma spec `x`, em fila na integração. */
function specProject(titles: string[], responses: unknown[], depends: Record<number, number> = {}) {
  const backlog = titles.map((title, i) => `\n## ${title}\nSpec: x\nRegras: R1\n${depends[i + 1] ? `Depende de: ${depends[i + 1]}\n` : ''}`).join('');
  const q = project(backlog, responses);
  mkdirSync(join(q.root, '.mabel', 'specs'), { recursive: true });
  writeFileSync(join(q.root, '.mabel', 'specs', 'x.md'), SPEC);
  setSpecStatus(q.db, q.project.id, 'x', 'aceita');
  git(q.root, 'add', '.mabel');
  git(q.root, 'commit', '-q', '-m', 'spec');
  syncBacklog(q.db, q.project);
  return q;
}

test('F.1 (F10): rejeitar reverte o merge da tarefa na integração e a leva a planning; --cancelar cancela', async () => {
  const q = specProject(['A', 'B', 'C'], [
    PLAN_OK, PLAN_OK, PLAN_OK,
    execFor(1), REVIEW,
    execFor(2), REVIEW,
    execFor(3), REVIEW,
  ]);
  await q.start();
  const before = git(q.root, 'rev-parse', INTEGRATION);
  const result = reject(q.db, q.home, q.project, q.item(1), 'o total precisa considerar frete');
  assert.deepEqual(result, { to: 'planning', dependents: [] });
  assert.equal(q.show('src/item1.js'), undefined);
  assert.ok(q.show('src/item2.js'));
  assert.equal(git(q.root, 'rev-parse', `${INTEGRATION}^`), before, 'um commit de revert sobre a integração');
  assert.match(git(q.root, 'log', '-1', '--format=%B', INTEGRATION), /mabel: rejeita #1 A\n\nMabel-Item: #1\nMabel-Unidade: x/);
  const item = q.item(1);
  assert.equal(item.status, 'planning');
  assert.equal(item.integratedCommit, null);
  assert.equal(item.statusReason, 'humano: rejeitado — o total precisa considerar frete');
  assert.match(item.nextInput?.answer ?? '', /rejeitou a entrega anterior deste item: o total precisa considerar frete/);
  assert.equal(item.nextInput?.previousPlan, true);

  const cancelled = q.cli('rejeitar', '2', 'não', 'precisa', 'mais', '--cancelar');
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /#2 revertido na mabel\/integracao e cancelado/);
  assert.equal(q.item(2).status, 'cancelled');
  assert.equal(q.show('src/item2.js'), undefined);
  assert.ok(q.show('src/item3.js'));
  assert.doesNotMatch(readFileSync(join(q.root, '.mabel', 'run.md'), 'utf8'), /### #2/);

  // A tarefa rejeitada é replanejada e volta à fila no próximo run.
  useScenario(q.root, [PLAN_OK, execFor(1, 'src/item1.js', 'export const item1 = "com frete";\n'), REVIEW]);
  await q.start();
  assert.equal(q.item(1).status, 'awaiting_merge');
  assert.equal(q.show('src/item1.js'), 'export const item1 = "com frete";');
});

test('F.1 (F10): rejeitar um avulso também reverte o merge dele na integração', async () => {
  const q = project('\n## A\nprimeiro\n', [PLAN_OK, execFor(1), REVIEW]);
  await q.start();
  assert.ok(q.show('src/item1.js'));
  const before = git(q.root, 'rev-parse', INTEGRATION);
  const out = q.cli('rejeitar', '1', 'refazer');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /#1 revertido na mabel\/integracao: volta ao planejamento/);
  assert.equal(q.show('src/item1.js'), undefined);
  assert.equal(git(q.root, 'rev-parse', `${INTEGRATION}^`), before, 'a fila só anda para frente');
  assert.equal(q.item(1).status, 'planning');
});

test('P.5 critério 3: revert com conflito não altera a integração e aponta as tarefas que o impedem', async () => {
  const q = specProject(['A', 'B'], [
    PLAN_OK, PLAN_OK,
    execFor(1), REVIEW,
    execFor(2, 'src/item1.js', 'export const item1 = "mudado por B";\n'), REVIEW,
  ]);
  await q.start();
  const before = git(q.root, 'rev-parse', INTEGRATION);
  assert.throws(
    () => reject(q.db, q.home, q.project, q.item(1), 'errado'),
    (error: Error) =>
      error instanceof DecisionError &&
      /conflito em src\/item1\.js\. Rejeite antes #2, concluídas depois dela nos mesmos arquivos\. A mabel\/integracao não mudou\./.test(error.message),
  );
  assert.equal(git(q.root, 'rev-parse', INTEGRATION), before);
  assert.equal(q.item(1).status, 'awaiting_merge');
  assert.equal(existsSync(join(q.home, 'worktrees', q.project.id, '_integracao')), false);
});

test('P.5 critério 4: dependentes concluídos geram aviso', async () => {
  const q = project('\n## A\nprimeiro\n\n## B\ndepende\nDepende de: 1\n', [PLAN_OK, execFor(1), REVIEW, PLAN_OK, execFor(2), REVIEW]);
  await q.start();
  assert.deepEqual(listItems(q.db, q.project.id).map((i) => i.status), ['awaiting_merge', 'awaiting_merge']);
  const out = q.cli('rejeitar', '1', 'refazer');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Atenção: #2 depende\(m\) de #1 e continua\(m\) concluído\(s\)/);
  assert.equal(q.item(1).status, 'planning');
  // Fora da integração, nada a rejeitar.
  const again = q.cli('rejeitar', '1', 'de novo');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /#1 não está concluída na integração \(estado: planning\)/);
});
