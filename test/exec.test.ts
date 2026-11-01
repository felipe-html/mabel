import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/stream-read-file.jsonl', import.meta.url));
const FIXTURE_LINES = readFileSync(FIXTURE, 'utf8').trimEnd().split('\n');
const NODE_ARGS = ['--disable-warning=ExperimentalWarning', CLI];

function setup(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mabel-exec-'));
  const home = join(root, 'home');
  const marker = join(root, 'marker.json');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MABEL_HOME: home,
    MABEL_CLAUDE_BIN: FAKE,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    FAKE_CLAUDE_MARKER: marker,
    NO_COLOR: '1',
    ...extra,
  };
  const exec = (...args: string[]) =>
    spawnSync(process.execPath, [...NODE_ARGS, 'pedir', ...args], { encoding: 'utf8', env, cwd: root });
  return { root, home, marker, env, exec };
}

function query<T>(home: string, sql: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(join(home, 'mabel.db'), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

interface RunRow {
  id: string;
  status: string;
  error: string | null;
  exit_code: number | null;
  [column: string]: unknown;
}

function onlyRun(home: string): RunRow {
  const runs = query<RunRow>(home, 'SELECT * FROM runs');
  assert.equal(runs.length, 1);
  return runs[0] as RunRow;
}

test('run de fixture grava run, eventos, chamada de ferramenta, saldo e transcript', () => {
  const { home, marker, exec } = setup();
  const result = exec('leia nota.txt', '--model', 'haiku', '--max-turns', '3', '--allowed-tools', 'Read,Bash');
  assert.equal(result.status, 0, result.stderr);

  const run = onlyRun(home);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.kind, 'exec');
  assert.equal(run.exit_code, 0);
  assert.equal(run.error, null);
  assert.equal(run.model_requested, 'haiku');
  assert.equal(run.model, 'claude-haiku-5-5');
  assert.equal(run.session_id, '76abb708-6eea-4fda-8e7e-37138ceb22fc');
  assert.equal(run.claude_version, '2.1.296');
  assert.equal(run.num_turns, 2);
  assert.equal(run.cost_usd, 0.0031784900000000004);
  assert.equal(run.input_tokens, 4);
  assert.equal(run.output_tokens, 233);
  assert.equal(run.cache_read_tokens, 50819);
  assert.equal(run.cache_creation_tokens, 12767);
  assert.equal(run.duration_ms, 4590);
  assert.equal(run.result_text, 'olá');
  assert.ok(run.ended_at);

  const events = query<{ seq: number; type: string; subtype: string | null; payload: string }>(
    home,
    'SELECT seq, type, subtype, payload FROM events WHERE run_id = ? ORDER BY seq',
    run.id,
  );
  assert.deepEqual(
    events.map((event) => event.payload),
    FIXTURE_LINES,
  );
  // Eventos depois do `result` também são gravados.
  assert.deepEqual({ ...events.at(-1) }, { seq: 12, type: 'system', subtype: 'task_summary', payload: FIXTURE_LINES[11] });

  const calls = query<{ name: string; is_error: number; ended_at: string | null }>(
    home,
    'SELECT name, is_error, ended_at FROM tool_calls WHERE run_id = ?',
    run.id,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, 'Read');
  assert.equal(calls[0]?.is_error, 0);
  assert.ok(calls[0]?.ended_at);

  const limits = query<{ window: string; utilization: number; resets_at: string; status: string }>(
    home,
    'SELECT window, utilization, resets_at, status FROM rate_limits WHERE run_id = ? ORDER BY window',
    run.id,
  );
  assert.deepEqual(
    limits.map((row) => ({ ...row })),
    [
      { window: 'five_hour', utilization: 0.05, resets_at: new Date(1791766800 * 1000).toISOString(), status: 'allowed' },
      { window: 'seven_day', utilization: 0.02, resets_at: new Date(1791892800 * 1000).toISOString(), status: 'allowed' },
    ],
  );

  const dir = join(home, 'runs', run.id);
  assert.equal(readFileSync(join(dir, 'stream.jsonl'), 'utf8'), readFileSync(FIXTURE, 'utf8'));
  assert.equal(run.transcript_path, join(dir, 'transcript.jsonl'));
  assert.match(readFileSync(join(dir, 'transcript.jsonl'), 'utf8'), /transcript falso/);

  const { argv } = JSON.parse(readFileSync(marker, 'utf8')) as { argv: string[] };
  assert.deepEqual(argv, [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', 'haiku', '--max-turns', '3', '--allowedTools', 'Read,Bash',
    '--', 'leia nota.txt',
  ]);

  assert.match(result.stdout, /▸ run .{4}…  ·  claude-haiku-5-5/);
  assert.match(result.stdout, /→ Read\s+\/projeto\/nota\.txt\s+✓/);
  assert.match(result.stdout, /\nolá\n/);
  assert.match(result.stdout, /✓ concluída · 2 turnos · 4,6s · US\$ 0,0032 · 63,6k tokens de entrada · 233 de saída/);
});

test('linha inválida no meio do stream não interrompe a leitura', () => {
  const { root, home, env, exec } = setup();
  const fixture = join(root, 'com-lixo.jsonl');
  writeFileSync(fixture, [...FIXTURE_LINES.slice(0, 4), 'isto não é json', ...FIXTURE_LINES.slice(4)].join('\n') + '\n');
  env.FAKE_CLAUDE_FIXTURE = fixture;
  const result = exec('oi');
  assert.equal(result.status, 0, result.stderr);

  const run = onlyRun(home);
  assert.equal(run.status, 'succeeded');
  const types = query<{ type: string }>(home, 'SELECT type FROM events ORDER BY seq').map((row) => row.type);
  assert.equal(types.length, FIXTURE_LINES.length + 1);
  assert.equal(types[4], 'invalid');
  assert.equal(query(home, 'SELECT * FROM tool_calls WHERE ended_at IS NOT NULL').length, 1);
});

test('banco não gravável: o claude não é iniciado e o código de saída é de erro', () => {
  const { root, marker, env, exec } = setup();
  env.MABEL_HOME = join(root, 'arquivo-no-lugar-do-diretorio');
  writeFileSync(env.MABEL_HOME, '');
  const result = exec('oi');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Não foi possível gravar o registro da run/);
  assert.equal(existsSync(marker), false);
});

test('claude saindo com código diferente de 0 resulta em failed com error', () => {
  const { home, exec } = setup({ FAKE_CLAUDE_EXIT: '2', FAKE_CLAUDE_STDERR: 'falha de autenticação\n' });
  const result = exec('oi');
  assert.equal(result.status, 1);
  const run = onlyRun(home);
  assert.equal(run.status, 'failed');
  assert.equal(run.exit_code, 2);
  assert.equal(run.error, 'falha de autenticação');
  assert.match(result.stdout, /✗ falhou: falha de autenticação/);
});

test('SIGINT marca a run como interrupted e encerra o claude', async () => {
  const { home, marker, env, root } = setup({ FAKE_CLAUDE_HANG: '1' });
  const child = spawn(process.execPath, [...NODE_ARGS, 'pedir', 'oi'], { env, cwd: root });
  let stdout = '';
  await new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('✓')) resolve();
    });
  });
  child.kill('SIGINT');
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));

  assert.equal(code, 130);
  const run = onlyRun(home);
  assert.equal(run.status, 'interrupted');
  assert.match(stdout, /■ interrompida/);
  const { pid } = JSON.parse(readFileSync(marker, 'utf8')) as { pid: number };
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('transcript ausente não falha a run e gera o evento transcript_missing', () => {
  const { home, exec } = setup({ FAKE_CLAUDE_TRANSCRIPT: '0' });
  assert.equal(exec('oi').status, 0);
  const run = onlyRun(home);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.transcript_path, null);
  const missing = query(home, "SELECT * FROM events WHERE type = 'mabel' AND subtype = 'transcript_missing'");
  assert.equal(missing.length, 1);
});

test('run running órfã vira failed/abandoned ao reabrir o banco', () => {
  const { home } = setup();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const db = openDb(home);
  const insert = db.prepare(
    "INSERT INTO runs (id, kind, prompt, cwd, status, started_at, pid) VALUES (?, 'exec', 'p', '/', 'running', ?, ?)",
  );
  insert.run('orfa', new Date().toISOString(), dead);
  insert.run('viva', new Date().toISOString(), process.pid);
  db.close();

  openDb(home).close();
  const rows = query<{ id: string; status: string; error: string | null }>(
    home,
    'SELECT id, status, error FROM runs ORDER BY id',
  );
  assert.deepEqual(
    rows.map((row) => ({ ...row })),
    [
      { id: 'orfa', status: 'failed', error: 'abandoned' },
      { id: 'viva', status: 'running', error: null },
    ],
  );
});

test('exec sem prompt falha com o uso', () => {
  const result = setup().exec();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Informe o prompt/);
});
