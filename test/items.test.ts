import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BalanceReading } from '../src/balance.ts';
import { type BoardItem, renderBoard, renderBoardSummary } from '../src/board.ts';
import { ITEM_STATES, type ItemStatus, TRANSITIONS, TransitionError, transition } from '../src/items.ts';
import { setupProject } from './helpers.ts';

function insertItem(ctx: ReturnType<typeof setupProject>, status: ItemStatus): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const number = (ctx.db.prepare('SELECT coalesce(max(number), 0) + 1 AS n FROM items').get() as { n: number }).n;
  ctx.db
    .prepare(
      `INSERT INTO items (id, project_id, number, position, title, intent, criteria, depends_on, content_hash,
         status, created_at, updated_at) VALUES (?, ?, ?, ?, 'Item', 'i', '[]', '[]', 'h', ?, ?, ?)`,
    )
    .run(id, ctx.project.id, number, number, status, now, now);
  return id;
}

function transitionsOf(ctx: ReturnType<typeof setupProject>, itemId: string) {
  return ctx.db
    .prepare('SELECT from_state, to_state, reason FROM item_transitions WHERE item_id = ?')
    .all(itemId)
    .map((row) => ({ ...row }));
}

test('toda transição da tabela é aceita, auditada e regenera o quadro', () => {
  const ctx = setupProject();
  const board = join(ctx.root, '.mabel', 'quadro.md');
  let count = 0;
  for (const from of ITEM_STATES) {
    for (const to of TRANSITIONS[from]) {
      const itemId = insertItem(ctx, from);
      rmSync(board, { force: true });
      transition(ctx.db, ctx.project, itemId, to, `motivo ${from}→${to}`);
      assert.deepEqual(transitionsOf(ctx, itemId), [{ from_state: from, to_state: to, reason: `motivo ${from}→${to}` }]);
      const row = ctx.db.prepare('SELECT status, status_reason FROM items WHERE id = ?').get(itemId);
      assert.deepEqual({ ...row }, { status: to, status_reason: `motivo ${from}→${to}` });
      assert.ok(existsSync(board), `quadro regenerado em ${from} → ${to}`);
      count++;
    }
  }
  assert.equal(count, 38);
});

test('transição fora da tabela lança e não grava nada', () => {
  const ctx = setupProject();
  for (const [from, to] of [['backlog', 'done'], ['done', 'executing'], ['cancelled', 'backlog'], ['planning', 'reviewing'], ['planning', 'executing'], ['planned', 'verifying']] as const) {
    const itemId = insertItem(ctx, from);
    assert.throws(() => transition(ctx.db, ctx.project, itemId, to, null), TransitionError);
    assert.deepEqual(transitionsOf(ctx, itemId), []);
    const row = ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(itemId) as { status: string };
    assert.equal(row.status, from);
  }
});

const ITEMS: BoardItem[] = [
  { number: 1, title: 'Estabelecer base de testes', status: 'done', statusReason: null, attempts: 1, branch: 'mabel/1-x', costUsd: 3.1, pendingDeps: [] },
  { number: 2, title: 'Listagem de pedidos', status: 'awaiting_merge', statusReason: null, attempts: 1, branch: 'mabel/2-listagem-de-pedidos', costUsd: 2, pendingDeps: [] },
  { number: 3, title: 'Exportar pedidos em CSV', status: 'executing', statusReason: null, attempts: 2, branch: null, costUsd: 1.84, pendingDeps: [] },
  { number: 4, title: 'Permissões por perfil', status: 'needs_human', statusReason: 'Quem pode ver relatórios?', attempts: 0, branch: null, costUsd: 0.5, pendingDeps: [] },
  { number: 5, title: 'Filtro por data', status: 'ready', statusReason: null, attempts: 0, branch: null, costUsd: 0, pendingDeps: [] },
  { number: 6, title: 'Relatório mensal', status: 'backlog', statusReason: null, attempts: 0, branch: null, costUsd: 0, pendingDeps: [5] },
  { number: 7, title: '', status: 'blocked', statusReason: 'formato: item sem título', attempts: 0, branch: null, costUsd: 0, pendingDeps: [] },
  { number: 8, title: 'Ideia descartada', status: 'cancelled', statusReason: null, attempts: 0, branch: null, costUsd: 0, pendingDeps: [] },
];

const NOW = new Date(2026, 9, 11, 14, 32);
const READINGS: BalanceReading[] = [
  { window: 'five_hour', utilization: 0.22, resetsAt: new Date(2026, 9, 11, 16, 40), observedAt: NOW },
  { window: 'seven_day', utilization: 0.09, resetsAt: new Date(2026, 9, 16, 9, 0), observedAt: NOW },
];

test('quadro: snapshot em texto', () => {
  assert.equal(
    renderBoard('meu-app', ITEMS, READINGS, NOW),
    `<!-- Gerado pelo Mabel. Edições aqui são descartadas. -->
# Quadro · meu-app
Atualizado 11/10 14:32 · saldo 5h 78% · 7d 91%

## Aguardando você
- #2 Listagem de pedidos — **awaiting_merge** · branch \`mabel/2-listagem-de-pedidos\`
- #4 Permissões por perfil — **needs_human**: Quem pode ver relatórios?

## Em andamento
- #3 Exportar pedidos em CSV — executing · tentativa 2 · US$ 1,84

## Na fila
- #5 Filtro por data — ready
- #6 Relatório mensal — backlog · depende de #5

## Bloqueados e falhos
- #7  — blocked: formato: item sem título

## Concluídos
- #1 Estabelecer base de testes — done · US$ 3,10
`,
  );
  assert.equal(
    renderBoard('vazio', [], [], NOW),
    '<!-- Gerado pelo Mabel. Edições aqui são descartadas. -->\n# Quadro · vazio\nAtualizado 11/10 14:32 · saldo desconhecido\n\nBacklog vazio.\n',
  );
});

test('resumo do quadro para o status', () => {
  assert.deepEqual(renderBoardSummary('meu-app', ITEMS), [
    'Projeto meu-app · aguardando você 2 · em andamento 1 · na fila 2 · bloqueados e falhos 1 · concluídos 1',
    '',
    'Aguardando você',
    '- #2 Listagem de pedidos — **awaiting_merge** · branch `mabel/2-listagem-de-pedidos`',
    '- #4 Permissões por perfil — **needs_human**: Quem pode ver relatórios?',
    '',
    'Em andamento',
    '- #3 Exportar pedidos em CSV — executing · tentativa 2 · US$ 1,84',
  ]);
});

test('status dentro do projeto sincroniza o backlog e mostra o resumo', () => {
  const ctx = setupProject('\n## A\nprimeiro item\n');
  const result = ctx.cli('status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Projeto mabel-repo-\w+ · na fila 1/);
  assert.match(readFileSync(join(ctx.root, '.mabel', 'quadro.md'), 'utf8'), /- #1 A — ready/);
});
