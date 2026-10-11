import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type BalanceReading,
  checkBalance,
  formatAge,
  formatReset,
  renderBalanceHeader,
} from '../src/balance.ts';

// Datas no fuso local, para os testes não dependerem do TZ da máquina.
const NOW = new Date(2026, 9, 14, 10, 0); // quarta, 14/10/2026 10:00
const LATER_TODAY = new Date(2026, 9, 14, 16, 40);
const FRIDAY = new Date(2026, 9, 16, 9, 0);

function reading(window: string, utilization: number, resetsAt = FRIDAY, observedAt = NOW): BalanceReading {
  return { window, utilization, resetsAt, observedAt };
}

test('checkBalance: ambas acima do limiar seguem', () => {
  assert.deepEqual(checkBalance([reading('five_hour', 0.5), reading('seven_day', 0.2)], NOW), { action: 'proceed' });
});

test('checkBalance: 5h abaixo do limiar pergunta pela janela de 5h', () => {
  assert.deepEqual(checkBalance([reading('five_hour', 0.8), reading('seven_day', 0.2)], NOW), {
    action: 'ask',
    window: 'five_hour',
    balance: 0.19999999999999996,
  });
});

test('checkBalance: 7d abaixo do limiar pergunta pela janela de 7d', () => {
  const decision = checkBalance([reading('five_hour', 0.1), reading('seven_day', 0.75)], NOW);
  assert.equal(decision.action, 'ask');
  assert.ok(decision.action === 'ask' && decision.window === 'seven_day');
});

test('checkBalance: ambas abaixo citam a de 7 dias', () => {
  const decision = checkBalance([reading('five_hour', 0.9), reading('seven_day', 0.95)], NOW);
  assert.ok(decision.action === 'ask' && decision.window === 'seven_day');
});

test('checkBalance: leitura ausente pede atualização', () => {
  assert.deepEqual(checkBalance([], NOW), { action: 'refresh', reason: 'missing' });
  assert.deepEqual(checkBalance([reading('five_hour', 0.1)], NOW), { action: 'refresh', reason: 'missing' });
});

test('checkBalance: leitura vencida pede atualização', () => {
  const expired = reading('five_hour', 0.1, new Date(2026, 9, 14, 9, 0));
  assert.deepEqual(checkBalance([expired, reading('seven_day', 0.1)], NOW), { action: 'refresh', reason: 'expired' });
});

test('cabeçalho de saldo renderizado sem cores', () => {
  const lines = renderBalanceHeader(
    [
      reading('five_hour', 0.22, LATER_TODAY, new Date(2026, 9, 14, 9, 56)),
      reading('seven_day', 0.09, FRIDAY, new Date(2026, 9, 14, 9, 56)),
    ],
    NOW,
  );
  assert.deepEqual(lines, [
    ' 5h  ████████░░  78% livre · reset hoje 16:40',
    ' 7d  █████████░  91% livre · reset sex 09:00        leitura de 4 min atrás',
  ]);
});

test('cabeçalho sem leitura e com leitura vencida', () => {
  assert.deepEqual(renderBalanceHeader([], NOW), [' saldo desconhecido · mabel status --atualizar']);
  const lines = renderBalanceHeader(
    [reading('five_hour', 0.5, new Date(2026, 9, 14, 9, 0)), reading('seven_day', 0.5)],
    NOW,
  );
  assert.equal(lines[0], ' 5h  █████░░░░░  50% livre · reset hoje 09:00 (vencida)');
});

test('horário de reset e idade da leitura', () => {
  assert.equal(formatReset(new Date(2026, 9, 15, 9, 5), NOW), 'amanhã 09:05');
  assert.equal(formatReset(new Date(2026, 9, 25, 9, 5), NOW), '25/10 09:05');
  assert.equal(formatAge(NOW, NOW), 'leitura de agora');
  assert.equal(formatAge(new Date(2026, 9, 14, 7, 0), NOW), 'leitura de 3h atrás');
  assert.equal(formatAge(new Date(2026, 9, 12, 10, 0), NOW), 'leitura de 2 dias atrás');
});

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

test('status --atualizar roda o probe auditado e mostra saldo e runs sem cores', () => {
  const root = mkdtempSync(join(tmpdir(), 'mabel-status-'));
  const home = join(root, 'home');
  const marker = join(root, 'marker.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MABEL_HOME: home,
    MABEL_CLAUDE_BIN: FAKE,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    FAKE_CLAUDE_MARKER: marker,
  };
  delete env.NO_COLOR;
  const mabel = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'status', ...args], {
      encoding: 'utf8',
      env,
    });

  const before = mabel();
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /saldo desconhecido/);
  assert.match(before.stdout, /nenhuma run registrada/);

  const result = mabel('--atualizar');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\x1b\[/);
  assert.match(result.stdout, / 5h {2}██████████ {2}95% livre/);
  assert.match(result.stdout, /✓ .{4} {2}\d\d\/\d\d \d\d:\d\d {2}probe/);

  const db = new DatabaseSync(join(home, 'mabel.db'), { readOnly: true });
  try {
    const runs = db.prepare('SELECT kind, model_requested, status FROM runs').all();
    assert.deepEqual(runs.map((row) => ({ ...row })), [{ kind: 'probe', model_requested: 'haiku', status: 'succeeded' }]);
    assert.equal(db.prepare('SELECT * FROM rate_limits').all().length, 2);
  } finally {
    db.close();
  }
  const { argv } = JSON.parse(readFileSync(marker, 'utf8')) as { argv: string[] };
  assert.deepEqual(argv.slice(4, 8), ['--model', 'haiku', '--max-turns', '1']);
});
