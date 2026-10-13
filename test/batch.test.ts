import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBoard, renderBoardSummary } from '../src/board.ts';
import { respond } from '../src/decisions.ts';
import { boardItems, getItem, listItems, syncBacklog } from '../src/items.ts';
import { writeConfig } from '../src/project.ts';
import { type QueueOptions, startQueue } from '../src/run.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const PLAN_OK = { structured_output: PLAN };
const PLAN_Q = {
  structured_output: { ...PLAN, perguntas: [{ texto: 'Qual banco usar?', sugestao: 'SQLite', regraCritica: true }] },
  session_id: 'plan-b',
};
const EXEC = { structured_output: EXECUTION, files: EXECUTION_FILES };
const REVIEW = { structured_output: REVIEW_OK };
const THREE = '\n## A\nprimeiro\n\n## B\nsegundo\n\n## C\nterceiro\n';

function queue(responses: unknown[], backlog = THREE) {
  const ctx = setupProject(backlog);
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  syncBacklog(ctx.db, ctx.project);
  useScenario(ctx.root, responses);
  const states = () => listItems(ctx.db, ctx.project.id).map((item) => [item.number, item.status]);
  /** Etapas na ordem em que rodaram: `plan#1`, `execute#3`… */
  const stages = () =>
    (
      ctx.db
        .prepare(
          `SELECT r.stage, i.number FROM runs r JOIN items i ON i.id = r.item_id
           WHERE r.kind = 'stage' ORDER BY r.started_at, r.rowid`,
        )
        .all() as { stage: string; number: number }[]
    ).map((row) => `${row.stage}#${row.number}`);
  const start = (options: Partial<QueueOptions> = {}) =>
    startQueue({ db: ctx.db, home: ctx.home, project: ctx.project, ...options }).done;
  return { ...ctx, states, stages, start };
}

test('lote: os três planejamentos antes da primeira execução; a pergunta não segura os outros', () => {
  const q = queue([PLAN_OK, PLAN_Q, PLAN_OK, EXEC, REVIEW, EXEC, REVIEW]);
  const run = q.cli('run');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(q.stages(), ['plan#1', 'plan#2', 'plan#3', 'execute#1', 'review#1', 'execute#3', 'review#3']);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'needs_human'], [3, 'awaiting_merge']]);
  const planning = run.stdout.indexOf('── planejamento (3 itens) ──');
  const execution = run.stdout.indexOf('── execução (2 itens) ──');
  assert.ok(planning >= 0 && execution > planning, run.stdout);
  assert.match(run.stdout, /#1 A: planning → planned · plano aprovado pelo gate de início/);
  assert.match(run.stdout, /#1 A: planned → executing · início da execução/);
  // Fora do TTY não há oferta de inbox.
  assert.doesNotMatch(run.stdout, /Abrir a inbox/);
});

test('oferta da inbox no fim do planejamento, uma vez; o item respondido é replanejado antes das execuções', async () => {
  const q = queue([PLAN_OK, PLAN_Q, PLAN_OK, PLAN_OK, EXEC, REVIEW, EXEC, REVIEW, EXEC, REVIEW]);
  const asked: string[] = [];
  const result = await q.start({
    interactive: true,
    confirm: async (question) => {
      asked.push(question);
      return true;
    },
    inbox: async () => {
      const item = getItem(q.db, q.project.id, 2)!;
      respond(q.db, q.project, item, 'Use o SQLite.', { via: 'inbox' });
    },
  });
  assert.equal(result.end, 'empty');
  assert.deepEqual(asked, ['\n1 item aguarda você. Abrir a inbox agora?']);
  assert.deepEqual(q.stages(), [
    'plan#1', 'plan#2', 'plan#3', 'plan#2',
    'execute#1', 'review#1', 'execute#2', 'review#2', 'execute#3', 'review#3',
  ]);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge'], [3, 'awaiting_merge']]);
});

test('oferta recusada: a fila segue sem esperar e não pergunta de novo; fora do TTY não pergunta', async () => {
  const declined = queue([PLAN_OK, PLAN_Q, PLAN_OK, EXEC, REVIEW, EXEC, REVIEW]);
  let offers = 0;
  let opened = false;
  await declined.start({
    interactive: true,
    confirm: async () => {
      offers++;
      return false;
    },
    inbox: async () => {
      opened = true;
    },
  });
  assert.equal(offers, 1);
  assert.equal(opened, false);
  assert.deepEqual(declined.states(), [[1, 'awaiting_merge'], [2, 'needs_human'], [3, 'awaiting_merge']]);

  const headless = queue([PLAN_OK, PLAN_Q, PLAN_OK, EXEC, REVIEW, EXEC, REVIEW]);
  await headless.start({
    interactive: false,
    confirm: async () => assert.fail('não pergunta fora do TTY'),
    inbox: async () => assert.fail('não abre a inbox fora do TTY'),
  });
  assert.deepEqual(headless.states(), [[1, 'awaiting_merge'], [2, 'needs_human'], [3, 'awaiting_merge']]);
});

test('--sem-lote, --item e --uma mantêm o item a item', async () => {
  const noBatch = queue([PLAN_OK, EXEC, REVIEW, PLAN_Q, PLAN_OK, EXEC, REVIEW]);
  const run = noBatch.cli('run', '--sem-lote');
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(noBatch.stages(), ['plan#1', 'execute#1', 'review#1', 'plan#2', 'plan#3', 'execute#3', 'review#3']);
  assert.doesNotMatch(run.stdout, /── planejamento/);

  const single = queue([PLAN_OK, EXEC, REVIEW]);
  assert.equal((await single.start({ itemNumber: 2 })).end, 'once');
  assert.deepEqual(single.stages(), ['plan#2', 'execute#2', 'review#2']);
  assert.deepEqual(single.states(), [[1, 'ready'], [2, 'awaiting_merge'], [3, 'ready']]);

  const once = queue([PLAN_OK, EXEC, REVIEW]);
  assert.equal((await once.start({ once: true })).end, 'once');
  assert.deepEqual(once.stages(), ['plan#1', 'execute#1', 'review#1']);
});

test('item aprovado em planned executa no próximo run, também item a item', async () => {
  const q = queue([{ structured_output: { ...PLAN, conceitosCriticos: ['Desconto'] } }, EXEC, REVIEW], '\n## A\nprimeiro\n');
  await q.start();
  assert.deepEqual(q.states(), [[1, 'needs_human']]);
  assert.equal(q.cli('aprovar', '1').status, 0);
  assert.deepEqual(q.states(), [[1, 'planned']]);
  assert.equal((await q.start({ batch: false })).end, 'empty');
  assert.deepEqual(q.states(), [[1, 'awaiting_merge']]);
});

test('quadro e mabel status mostram planned', () => {
  const q = queue([]);
  q.db.prepare("UPDATE items SET status = 'planned' WHERE number = 2").run();
  const items = boardItems(q.db, q.project);
  const board = renderBoard('app', items, [], new Date(2026, 9, 12, 9, 0));
  assert.match(board, /## Na fila\n- #1 A — ready\n- #2 B — planned\n- #3 C — ready/);
  assert.match(renderBoardSummary('app', items)[0] ?? '', /na fila 3 \(planned 1\)/);
  assert.match(q.cli('status').stdout, /na fila 3 \(planned 1\)/);
});
