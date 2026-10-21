import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDb, runDir } from '../src/db.ts';
import { lockPath } from '../src/lock.ts';
import { findProject, tableScope, unclassifiedEntries, unclassifiedTables } from '../src/projects.ts';
import { ProjectError, registerProject } from '../src/project.ts';
import { itemDir } from '../src/stages.ts';
import { CLI, makeRepo, setupProject } from './helpers.ts';

// Horários crescentes: a ordem das runs não depende de empate no relógio.
let clock = Date.now();
const now = () => new Date((clock += 1000)).toISOString();

function insertRun(db: DatabaseSync, itemId: string | null, extra: { status?: string; pid?: number; model?: string; stage?: string } = {}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO runs (id, kind, item_id, stage, prompt, cwd, model_requested, model, status, started_at, cost_usd,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, pid)
     VALUES (?, ?, ?, ?, 'p', '/tmp', ?, ?, ?, ?, 0.5, 100, 50, 1000, 10, ?)`,
  ).run(
    id,
    itemId ? 'stage' : 'exec',
    itemId,
    itemId ? (extra.stage ?? 'execute') : null,
    extra.model ?? 'sonnet',
    extra.model ?? 'sonnet',
    extra.status ?? 'succeeded',
    now(),
    extra.pid ?? null,
  );
  db.prepare("INSERT INTO events (run_id, seq, received_at, type, payload) VALUES (?, 1, ?, 'system', '{}')").run(id, now());
  db.prepare("INSERT INTO tool_calls (run_id, tool_use_id, name, input, started_at) VALUES (?, 't1', 'Read', '{}', ?)").run(id, now());
  db.prepare("INSERT INTO rate_limits (run_id, observed_at, window, utilization, resets_at) VALUES (?, ?, 'five_hour', 0.1, ?)").run(
    id,
    now(),
    now(),
  );
  return id;
}

/** Item com run, gate reprovado, transição e diretórios em disco. */
function seedItem(db: DatabaseSync, home: string, projectId: string, number: number): { itemId: string; runIds: string[] } {
  const itemId = randomUUID();
  db.prepare(
    `INSERT INTO items (id, project_id, number, position, title, intent, criteria, depends_on, content_hash, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'intenção', '[]', '[]', 'h', 'executing', 2, ?, ?)`,
  ).run(itemId, projectId, number, number, `Item ${number}`, now(), now());
  const runIds = [insertRun(db, itemId), insertRun(db, itemId, { model: 'opus' })];
  db.prepare("INSERT INTO gate_results (item_id, attempt, gate, passed, detail, at) VALUES (?, 1, 'verify', 0, 'teste falhou', ?)").run(
    itemId,
    now(),
  );
  db.prepare(
    "INSERT INTO item_transitions (item_id, from_state, to_state, reason, run_id, at) VALUES (?, 'planned', 'executing', 'início', ?, ?)",
  ).run(itemId, runIds[0] ?? null, now());
  db.prepare(
    "INSERT INTO refinements (item_id, run_id, content_hash, proposal, status, created_at) VALUES (?, ?, 'h', '{}', 'discarded', ?)",
  ).run(itemId, runIds[0] ?? null, now());
  db.prepare(
    "INSERT INTO queue_events (project_id, at, kind, cause, detail, until) VALUES (?, ?, 'wait', 'five_hour', 'saldo da janela de 5h em 20% (abaixo de 30%)', ?)",
  ).run(projectId, now(), now());
  for (const id of runIds) mkdirSync(runDir(home, id), { recursive: true });
  mkdirSync(itemDir(home, itemId), { recursive: true });
  return { itemId, runIds };
}

/** Dois projetos no mesmo `MABEL_HOME`, cada um com itens e runs, e uma run de `exec`. */
function twoProjects() {
  const a = setupProject();
  const rootB = makeRepo();
  const cli = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: a.env(),
    });
  assert.equal(cli(rootB, 'init').status, 0);
  const db = a.db;
  const idB = (db.prepare('SELECT id FROM projects WHERE root <> ?').get(a.project.root) as { id: string }).id;
  const seededA = [seedItem(db, a.home, a.project.id, 11), seedItem(db, a.home, a.project.id, 12)];
  const seededB = [seedItem(db, a.home, idB, 21)];
  const execRun = insertRun(db, null);
  mkdirSync(runDir(a.home, execRun), { recursive: true });
  mkdirSync(join(a.home, 'worktrees', a.project.id, '1-item-1'), { recursive: true });
  mkdirSync(join(a.home, 'locks'), { recursive: true });
  // Pid que não existe: trava velha, não impede a remoção.
  writeFileSync(lockPath(a.home, a.project.id), '999999\n');
  return { a, rootB, idB, db, seededA, seededB, execRun, cli: (...args: string[]) => cli(a.root, ...args) };
}

const count = (db: DatabaseSync, sql: string, ...params: string[]) =>
  (db.prepare(sql).get(...params) as { n: number }).n;

test('toda tabela do banco está classificada e uma tabela nova falha a classificação', () => {
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const db = openDb(home);
  try {
    assert.deepEqual(unclassifiedTables(db), []);
    db.exec('CREATE TABLE novidade (id INTEGER PRIMARY KEY)');
    assert.deepEqual(unclassifiedTables(db), ['novidade']);
  } finally {
    db.close();
  }
});

test('toda entrada do diretório de dados está classificada', () => {
  const { a } = twoProjects();
  writeFileSync(join(a.home, 'historico'), '/status\n');
  assert.deepEqual(unclassifiedEntries(a.home), []);
  mkdirSync(join(a.home, 'novo'));
  assert.deepEqual(unclassifiedEntries(a.home), ['novo']);
});

test('projetos e projeto mostram texto simples fora do TTY', () => {
  const { a, cli, rootB } = twoProjects();
  const list = cli('projetos');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /nome\s+raiz\s+itens\s+runs\s+custo\s+última atividade/);
  assert.match(list.stdout, new RegExp(`${a.project.name}\\s+\\S+\\s+2 executing\\s+4\\s+US\\$ 2,00`));
  assert.match(list.stdout, new RegExp(basename(rootB)));
  assert.doesNotMatch(list.stdout, /\x1b\[/);

  const detail = cli('projeto', a.project.name);
  assert.equal(detail.status, 0, detail.stderr);
  for (const section of ['Totais', 'Por etapa', 'Por modelo', 'Itens', 'Gates reprovados', 'Escalonamentos de modelo', 'Pausas da fila e decisões de saldo', 'Últimas transições']) {
    assert.match(detail.stdout, new RegExp(section));
  }
  assert.match(detail.stdout, /4 runs · US\$ 2,00/);
  assert.match(detail.stdout, /entrada 400 · saída 200 · cache 4,0k/);
  assert.match(detail.stdout, /#11 execute: sonnet → opus/);
  assert.match(detail.stdout, /#12 tentativa 1 · verify — teste falhou/);
  assert.match(detail.stdout, /espera até \d\d\/\d\d \d\d:\d\d · saldo de 5h — saldo da janela de 5h em 20% \(abaixo de 30%\)/);

  const byPrefix = cli('projeto', a.project.id.slice(0, 6));
  assert.equal(byPrefix.status, 0);
  assert.match(byPrefix.stdout, new RegExp(a.project.name));
});

test('nome repetido lista os candidatos e falha', () => {
  const { a, db } = twoProjects();
  registerProject(db, '/outro/lugar', randomUUID());
  db.prepare('UPDATE projects SET name = ? WHERE root = ?').run(a.project.name, '/outro/lugar');
  assert.throws(() => findProject(db, a.project.name), (error: Error) => {
    assert.ok(error instanceof ProjectError);
    assert.match(error.message, /Há 2 projetos com o nome/);
    assert.match(error.message, /\/outro\/lugar/);
    return true;
  });
  const result = a.cli('projeto', a.project.name);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Há 2 projetos/);
});

test('remoção apaga só o projeto e preserva o outro e as runs sem item', () => {
  const { a, db, idB, seededA, seededB, execRun, cli } = twoProjects();
  const name = a.project.name;
  // Integrado na branch de integração, mas fora da base.
  db.prepare("UPDATE items SET status = 'awaiting_merge', integrated_commit = ? WHERE id = ?").run(
    'f'.repeat(40),
    seededA[1]?.itemId ?? '',
  );

  const summary = cli('projeto', 'remover', name);
  assert.equal(summary.status, 1);
  assert.match(summary.stdout, /2 itens · 4 runs · US\$ 2,00/);
  assert.match(summary.stdout, /banco: events, tool_calls, rate_limits, gate_results, refinements, item_transitions, runs, items, queue_events, projects/);
  assert.match(summary.stdout, /disco: runs\/ \(4\), items\/ \(2\), worktrees\/.{8}…, locks\//);
  assert.match(summary.stdout, /aviso: 1 item integrado \(#12\) ainda não chegou a main; o trabalho só existe na branch mabel\/integracao/);
  assert.match(summary.stderr, /--confirmar/);
  assert.equal(count(db, 'SELECT count(*) AS n FROM items WHERE project_id = ?', a.project.id), 2);

  assert.equal(cli('projeto', 'remover', name, '--confirmar', 'outro').status, 1);
  assert.equal(count(db, 'SELECT count(*) AS n FROM items WHERE project_id = ?', a.project.id), 2);

  const result = cli('projeto', 'remover', name, '--confirmar', name);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Projeto removido\. Registro em removals\./);
  assert.match(result.stdout, /git -C .+ worktree prune/);

  for (const [table, scope] of Object.entries(tableScope)) {
    if (scope.scope === 'project') {
      assert.equal(count(db, `SELECT count(*) AS n FROM ${table} WHERE ${scope.where}`, a.project.id), 0, table);
      assert.ok(count(db, `SELECT count(*) AS n FROM ${table} WHERE ${scope.where}`, idB) > 0, `${table} do outro projeto`);
    }
  }
  assert.equal(count(db, 'SELECT count(*) AS n FROM runs WHERE id = ?', execRun), 1);
  for (const table of ['events', 'tool_calls', 'rate_limits']) {
    assert.equal(count(db, `SELECT count(*) AS n FROM ${table} WHERE run_id = ?`, execRun), 1, table);
  }

  const removal = db.prepare('SELECT * FROM removals').get() as Record<string, unknown>;
  assert.equal(removal.project_id, a.project.id);
  assert.equal(removal.name, name);
  assert.equal(removal.items, 2);
  assert.equal(removal.runs, 4);
  assert.equal(removal.cost_usd, 2);

  for (const { itemId, runIds } of seededA) {
    assert.equal(existsSync(itemDir(a.home, itemId)), false);
    for (const id of runIds) assert.equal(existsSync(runDir(a.home, id)), false);
  }
  assert.equal(existsSync(join(a.home, 'worktrees', a.project.id)), false);
  assert.equal(existsSync(lockPath(a.home, a.project.id)), false);
  for (const { itemId, runIds } of seededB) {
    assert.equal(existsSync(itemDir(a.home, itemId)), true);
    for (const id of runIds) assert.equal(existsSync(runDir(a.home, id)), true);
  }
  assert.equal(existsSync(runDir(a.home, execRun)), true);
  assert.equal(existsSync(join(a.root, '.mabel', 'config.json')), true, 'repositório intocado');

  const removed = cli('projetos', '--removidos');
  assert.equal(removed.status, 0);
  assert.match(removed.stdout, new RegExp(`${name}\\s+\\S+\\s+${a.project.id.slice(0, 8)}\\s+2\\s+4\\s+US\\$ 2,00`));
});

test('remoção recusada com run em andamento, trava ativa ou worktree sujo', () => {
  const refused = (setup: (ctx: ReturnType<typeof twoProjects>) => void, pattern: RegExp) => {
    const ctx = twoProjects();
    setup(ctx);
    const name = ctx.a.project.name;
    const result = ctx.cli('projeto', 'remover', name, '--confirmar', name);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.match(result.stderr, /Nada foi removido/);
    assert.equal(count(ctx.db, 'SELECT count(*) AS n FROM projects WHERE id = ?', ctx.a.project.id), 1);
  };

  // O pid do processo de teste está vivo: a run não é tratada como órfã.
  refused(
    ({ db, seededA }) => insertRun(db, seededA[0]?.itemId ?? null, { status: 'running', pid: process.pid }),
    /do item #11 em andamento/,
  );
  refused(({ a }) => writeFileSync(lockPath(a.home, a.project.id), `${process.pid}\n`), /`mabel run` ativo neste projeto/);
  refused(({ a }) => {
    const path = join(a.home, 'worktrees', a.project.id, '2-item-2');
    const add = spawnSync('git', ['worktree', 'add', '-q', '-b', 'mabel/2-item-2', path], { cwd: a.root, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    writeFileSync(join(path, 'rascunho.txt'), 'sem commit\n');
  }, /Worktrees com alterações sem commit:\n\s+.*2-item-2/);
});
