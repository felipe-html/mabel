import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { CLI } from './helpers.ts';

const BASE = Date.parse('2026-10-14T12:00:00Z');
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();

function insertRun(db: DatabaseSync, id: string, fields: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    id,
    kind: 'exec',
    prompt: 'leia   o arquivo\nnota.txt',
    cwd: '/tmp/projeto',
    model_requested: 'haiku',
    model: 'claude-haiku',
    status: 'succeeded',
    started_at: at(0),
    ended_at: at(12),
    duration_ms: 12_000,
    num_turns: 3,
    cost_usd: 0.25,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 1000,
    cache_creation_tokens: 500,
    ...fields,
  };
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO runs (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...(Object.values(row) as (string | number | null)[]),
  );
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const db = openDb(home);
  insertRun(db, 'aaaa1111-0000-0000-0000-000000000001');
  insertRun(db, 'aaaa2222-0000-0000-0000-000000000002', {
    started_at: at(60),
    status: 'failed',
    error: 'max_turns',
    cost_usd: 1.5,
    transcript_path: '/tmp/transcript.jsonl',
  });
  insertRun(db, 'bbbb3333-0000-0000-0000-000000000003', { started_at: at(120), status: 'running', ended_at: null, duration_ms: null, num_turns: null, cost_usd: null });
  const call = db.prepare(
    'INSERT INTO tool_calls (run_id, tool_use_id, name, input, started_at, ended_at, is_error) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  call.run('aaaa2222-0000-0000-0000-000000000002', 't1', 'Read', JSON.stringify({ file_path: 'src/nota.txt' }), at(62), at(63), 0);
  call.run('aaaa2222-0000-0000-0000-000000000002', 't2', 'Bash', JSON.stringify({ command: 'npm test' }), at(65), at(70), 1);
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'consultar', ...args], {
      encoding: 'utf8',
      env: { ...process.env, MABEL_HOME: home, NO_COLOR: '1', MABEL_NOTIFICAR: '0' },
    });
  return { home, db, cli };
}

test('runs lista em texto simples, mais recentes primeiro, com o total de custo', () => {
  const { cli } = setup();
  const result = cli();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /id\s+início\s+status\s+tipo\s+modelo\s+turnos\s+duração\s+custo\s+prompt/);
  const ids = [...result.stdout.matchAll(/^ {2}(\w{4}\d{4}) /gm)].map((m) => m[1]);
  assert.deepEqual(ids, ['bbbb3333', 'aaaa2222', 'aaaa1111']);
  assert.match(result.stdout, /aaaa1111 .+succeeded\s+exec\s+claude-haiku\s+3\s+12s\s+US\$ 0,25\s+leia o arquivo nota\.txt/);
  assert.match(result.stdout, /3 runs · US\$ 1,75/);
  assert.doesNotMatch(result.stdout, /\x1b\[/);

  const limited = cli('--limite', '1');
  assert.match(limited.stdout, /1 run · US\$ 0,00/);
  assert.equal(cli('--limite', '0').status, 1);
});

test('runs <prefixo> mostra o resumo, as ferramentas e os arquivos', () => {
  const { cli, home } = setup();
  const result = cli('aaaa2');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Run aaaa2222-0000-0000-0000-000000000002/);
  assert.match(result.stdout, /status\s+failed · max_turns/);
  assert.match(result.stdout, /modelo\s+claude-haiku \(pedido: haiku\)/);
  assert.match(result.stdout, /custo\s+3 turnos · US\$ 1,50/);
  assert.match(result.stdout, /tokens\s+entrada 100 · saída 50 · cache 1,5k/);
  assert.match(result.stdout, /Ferramentas \(2\)/);
  assert.match(result.stdout, /\+2,0s\s+Read\s+src\/nota\.txt · 1,0s\n/);
  assert.match(result.stdout, /\+5,0s\s+Bash\s+npm test · 5,0s · erro/);
  assert.ok(result.stdout.includes(join(home, 'runs', 'aaaa2222-0000-0000-0000-000000000002', 'stream.jsonl')));
  assert.match(result.stdout, /transcript\s+\/tmp\/transcript\.jsonl/);

  const full = cli('aaaa1111-0000-0000-0000-000000000001');
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /Ferramentas \(0\)\n {2}nenhuma chamada/);
  assert.match(full.stdout, /transcript\s+não copiado/);
});

test('prefixo ambíguo lista as candidatas e encerra com erro; prefixo desconhecido também falha', () => {
  const { cli } = setup();
  const ambiguous = cli('aaaa');
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /O prefixo aaaa é ambíguo/);
  assert.match(ambiguous.stderr, /aaaa1111-0000-0000-0000-000000000001/);
  assert.match(ambiguous.stderr, /aaaa2222-0000-0000-0000-000000000002/);
  assert.equal(ambiguous.stdout, '');

  const missing = cli('zzzz');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Run não encontrada: zzzz/);
});

test('run de etapa mostra a etapa, o item e o projeto', () => {
  const { cli, db } = setup();
  db.prepare("INSERT INTO projects (id, root, name, created_at) VALUES ('p1', '/tmp/ferias', 'ferias', ?)").run(at(0));
  db.prepare(
    `INSERT INTO items (id, project_id, number, position, title, intent, criteria, depends_on, content_hash, status, created_at, updated_at)
     VALUES ('i1', 'p1', 3, 3, 'Cadastro de viagens', 'intenção', '[]', '[]', 'h', 'planning', ?, ?)`,
  ).run(at(0), at(0));
  insertRun(db, 'cccc4444-0000-0000-0000-000000000004', { kind: 'stage', stage: 'plan', item_id: 'i1', started_at: at(180) });
  assert.match(cli().stdout, /cccc4444 .+succeeded\s+plan #3\s+claude-haiku/);
  assert.match(cli('cccc').stdout, /tipo\s+plan #3 · Cadastro de viagens \(ferias\)/);
});

test('run do exec mostra a posição na conversa quando a sessão tem mais de uma mensagem', () => {
  const { db, cli } = setup();
  insertRun(db, 'cccc0001-0000-0000-0000-000000000001', { session_id: 'sess-1', started_at: at(200) });
  insertRun(db, 'cccc0002-0000-0000-0000-000000000002', { session_id: 'sess-1', started_at: at(260) });
  insertRun(db, 'dddd0001-0000-0000-0000-000000000001', { session_id: 'sess-2', started_at: at(300) });

  assert.match(cli('cccc0002').stdout, /sessão\s+sess-1 · mensagem 2 de 2/);
  assert.match(cli('cccc0001').stdout, /sessão\s+sess-1 · mensagem 1 de 2/);
  const single = cli('dddd0001').stdout;
  assert.match(single, /sessão\s+sess-2\n/);
});
