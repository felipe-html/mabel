import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  paceOf,
  renderBalanceFooter,
  renderBalanceHeader,
  stageEstimate,
} from '../src/balance.ts';
import { openDb } from '../src/db.ts';

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

test('checkBalance: leitura de mais de 30 min pede atualização', () => {
  const old = new Date(2026, 9, 14, 9, 29);
  const readings = [reading('five_hour', 0.1, LATER_TODAY, old), reading('seven_day', 0.1)];
  assert.deepEqual(checkBalance(readings, NOW), { action: 'refresh', reason: 'stale' });
  const recent = [reading('five_hour', 0.1, LATER_TODAY, new Date(2026, 9, 14, 9, 31)), reading('seven_day', 0.1)];
  assert.deepEqual(checkBalance(recent, NOW), { action: 'proceed' });
});

test('checkBalance: com estimativa, vale o saldo projetado contra o piso de 10%', () => {
  const sevenDay = reading('seven_day', 0.2);
  assert.deepEqual(checkBalance([reading('five_hour', 0.85), sevenDay], NOW, { five_hour: 0.02 }), {
    action: 'proceed',
  });
  const decision = checkBalance([reading('five_hour', 0.89), sevenDay], NOW, { five_hour: 0.02 });
  assert.ok(decision.action === 'ask' && decision.window === 'five_hour' && decision.estimate === 0.02);
  // Sem estimativa, o limiar de 30% continua valendo.
  assert.equal(checkBalance([reading('five_hour', 0.85), sevenDay], NOW).action, 'ask');
});

test('checkBalance: janela de 7 dias acima do ritmo pede pausa até o ritmo alcançar', () => {
  // Um dia de sete decorrido (ritmo de 14%) com 40% usados.
  const resetsAt = new Date(NOW.getTime() + 6 * 86_400_000);
  const decision = checkBalance([reading('five_hour', 0.1), reading('seven_day', 0.4, resetsAt)], NOW);
  assert.equal(decision.action, 'pace');
  assert.ok(decision.action === 'pace');
  assert.equal(Math.round(decision.expected * 100), 14);
  // Alcança quando o ritmo chega a 40% − 10% = 30% da janela: 2,1 dias depois do início.
  assert.equal(decision.caughtUpAt.getTime(), resetsAt.getTime() - 7 * 86_400_000 + 0.3 * 7 * 86_400_000);
  // A estimativa da etapa entra no uso: 30% sozinho está no ritmo, com a etapa não.
  assert.equal(checkBalance([reading('five_hour', 0.1), reading('seven_day', 0.2, resetsAt)], NOW).action, 'proceed');
  assert.equal(
    checkBalance([reading('five_hour', 0.1), reading('seven_day', 0.2, resetsAt)], NOW, { seven_day: 0.1 }).action,
    'pace',
  );
});

test('paceOf: com folga, no ritmo e acima do ritmo', () => {
  const resetsAt = new Date(NOW.getTime() + 3.5 * 86_400_000); // metade da janela
  assert.equal(paceOf(reading('seven_day', 0.3, resetsAt), NOW).state, 'behind');
  assert.equal(paceOf(reading('seven_day', 0.55, resetsAt), NOW).state, 'on');
  assert.equal(paceOf(reading('seven_day', 0.65, resetsAt), NOW).state, 'ahead');
});

test('stageEstimate: média das 10 runs mais recentes, só com leituras da mesma janela', () => {
  const db = openDb(mkdtempSync(join(tmpdir(), 'mabel-estimate-')));
  const insertRun = db.prepare(
    `INSERT INTO runs (id, kind, stage, prompt, cwd, status, started_at) VALUES (?, 'stage', ?, '', '', 'succeeded', ?)`,
  );
  const insertReading = db.prepare(
    'INSERT INTO rate_limits (run_id, observed_at, window, utilization, resets_at) VALUES (?, ?, ?, ?, ?)',
  );
  let n = 0;
  const run = (stage: string, used: number, resets: [string, string] = ['r1', 'r1']) => {
    const id = `run-${++n}`;
    const at = new Date(2026, 9, 1, 0, n).toISOString();
    insertRun.run(id, stage, at);
    insertReading.run(id, at, 'five_hour', 0.2, resets[0]);
    insertReading.run(id, at, 'five_hour', 0.2 + used, resets[1]);
  };
  try {
    run('execute', 0.04);
    run('execute', 0.06);
    assert.deepEqual(stageEstimate(db, 'execute'), {});
    run('execute', 0.5, ['r1', 'r2']); // atravessou um reset: fora da conta
    assert.deepEqual(stageEstimate(db, 'execute'), {});
    run('execute', 0.05);
    assert.equal(Math.round((stageEstimate(db, 'execute').five_hour ?? 0) * 1000), 50);
    for (let i = 0; i < 10; i++) run('execute', 0.01);
    assert.equal(Math.round((stageEstimate(db, 'execute').five_hour ?? 0) * 1000), 10);
    assert.deepEqual(stageEstimate(db, 'review'), {});
  } finally {
    db.close();
  }
});

test('rodapé de saldo cabe na largura e perde detalhes quando falta espaço', () => {
  const readings = [
    reading('five_hour', 0.28, LATER_TODAY, new Date(2026, 9, 14, 9, 57)),
    reading('seven_day', 0.11, FRIDAY, new Date(2026, 9, 14, 9, 57)),
  ];
  assert.equal(
    renderBalanceFooter(readings, NOW, 120),
    ' 5h ███████░░░ 72% · hoje 16:40 │ 7d █████████░ 89% · sex 09:00 · com folga │ leitura de 3 min atrás',
  );
  assert.equal(renderBalanceFooter(readings, NOW, 60), ' 5h ███████░░░ 72% │ 7d █████████░ 89% · com folga');
  assert.equal(renderBalanceFooter(readings, NOW, 20), ' 5h 72% 7d 89%');
  for (const width of [20, 40, 60, 80, 100]) assert.ok(renderBalanceFooter(readings, NOW, width).length <= width);
  const expired = [reading('five_hour', 0.5, new Date(2026, 9, 14, 9, 0)), reading('seven_day', 0.1)];
  assert.match(renderBalanceFooter(expired, NOW, 120), /5h █████░░░░░ 50% · hoje 09:00 \(vencida\)/);
  assert.equal(renderBalanceFooter([], NOW, 80), ' saldo desconhecido · /status --atualizar');
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
    ' 7d  █████████░  91% livre · reset sex 09:00 · com folga        leitura de 4 min atrás',
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
  // Probe hermético: o cenário emite o `init` com as ferramentas pedidas (nenhuma).
  const scenario = join(root, 'cenario.json');
  writeFileSync(scenario, JSON.stringify({ responses: [], probe: { rate_limit: { five_hour: 0.05, seven_day: 0.2 } } }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MABEL_HOME: home,
    MABEL_CLAUDE_BIN: FAKE,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    FAKE_CLAUDE_MARKER: marker,
    FAKE_CLAUDE_SCENARIO: scenario,
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
  const at = argv.indexOf('--model');
  assert.deepEqual(argv.slice(at, at + 4), ['--model', 'haiku', '--max-turns', '1']);
  assert.deepEqual(argv.slice(4, 9), ['--restricted', '--strict-mcp-config', '--disable-slash-commands', '--tools', '']);
});
