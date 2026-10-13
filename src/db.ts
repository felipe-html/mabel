import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Diretório de dados do Mabel: `$MABEL_HOME` ou `~/.mabel`. */
export function dataDir(): string {
  return process.env.MABEL_HOME || join(homedir(), '.mabel');
}

export function runDir(home: string, runId: string): string {
  return join(home, 'runs', runId);
}

/**
 * Migrações em ordem; a posição + 1 é o `user_version` depois de aplicada. Tabela nova
 * precisa ser classificada em `tableScope` (`src/projects.ts`).
 */
const migrations: string[] = [
  `
  CREATE TABLE runs (
    id                    TEXT PRIMARY KEY,
    kind                  TEXT NOT NULL,
    item_id               TEXT,
    stage                 TEXT,
    prompt                TEXT NOT NULL,
    cwd                   TEXT NOT NULL,
    model_requested       TEXT,
    model                 TEXT,
    session_id            TEXT,
    claude_version        TEXT,
    status                TEXT NOT NULL,
    exit_code             INTEGER,
    error                 TEXT,
    started_at            TEXT NOT NULL,
    ended_at              TEXT,
    duration_ms           INTEGER,
    num_turns             INTEGER,
    cost_usd              REAL,
    input_tokens          INTEGER,
    output_tokens         INTEGER,
    cache_read_tokens     INTEGER,
    cache_creation_tokens INTEGER,
    result_text           TEXT,
    transcript_path       TEXT,
    pid                   INTEGER
  );

  CREATE TABLE events (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    seq         INTEGER NOT NULL,
    received_at TEXT NOT NULL,
    type        TEXT NOT NULL,
    subtype     TEXT,
    payload     TEXT NOT NULL
  );
  CREATE INDEX events_run ON events(run_id, seq);

  CREATE TABLE tool_calls (
    run_id      TEXT NOT NULL REFERENCES runs(id),
    tool_use_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    input       TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    is_error    INTEGER,
    PRIMARY KEY (run_id, tool_use_id)
  );

  CREATE TABLE rate_limits (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT REFERENCES runs(id),
    observed_at TEXT NOT NULL,
    window      TEXT NOT NULL,
    utilization REAL NOT NULL,
    resets_at   TEXT NOT NULL,
    status      TEXT
  );
  CREATE INDEX rate_limits_window ON rate_limits(window, observed_at);
  `,
  `
  CREATE TABLE projects (
    id         TEXT PRIMARY KEY,
    root       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE items (
    id             TEXT PRIMARY KEY,
    project_id     TEXT NOT NULL REFERENCES projects(id),
    number         INTEGER NOT NULL,
    position       INTEGER NOT NULL,
    title          TEXT NOT NULL,
    intent         TEXT NOT NULL,
    criteria       TEXT NOT NULL,
    depends_on     TEXT NOT NULL,
    restrictions   TEXT,
    content_hash   TEXT NOT NULL,
    status         TEXT NOT NULL,
    status_reason  TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    branch         TEXT,
    worktree       TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    UNIQUE (project_id, number)
  );

  CREATE TABLE item_transitions (
    id         INTEGER PRIMARY KEY,
    item_id    TEXT NOT NULL REFERENCES items(id),
    from_state TEXT NOT NULL,
    to_state   TEXT NOT NULL,
    reason     TEXT,
    run_id     TEXT REFERENCES runs(id),
    at         TEXT NOT NULL
  );
  CREATE INDEX item_transitions_item ON item_transitions(item_id, id);
  `,
  `
  ALTER TABLE runs ADD COLUMN structured_output TEXT;
  CREATE INDEX runs_item ON runs(item_id, started_at);
  `,
  `
  ALTER TABLE items ADD COLUMN pending_kind TEXT;
  ALTER TABLE items ADD COLUMN pending TEXT;
  ALTER TABLE items ADD COLUMN approved_at TEXT;
  ALTER TABLE items ADD COLUMN escalated_cycle INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN plan_retries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE items ADD COLUMN next_input TEXT;

  CREATE TABLE gate_results (
    id        INTEGER PRIMARY KEY,
    item_id   TEXT NOT NULL REFERENCES items(id),
    attempt   INTEGER NOT NULL,
    gate      TEXT NOT NULL,
    passed    INTEGER NOT NULL,
    detail    TEXT,
    log_path  TEXT,
    at        TEXT NOT NULL
  );
  CREATE INDEX gate_results_item ON gate_results(item_id, id);
  `,
  `
  ALTER TABLE items ADD COLUMN integrated_commit TEXT;
  `,
  `
  CREATE TABLE removals (
    id          INTEGER PRIMARY KEY,
    project_id  TEXT NOT NULL,
    name        TEXT NOT NULL,
    root        TEXT NOT NULL,
    items       INTEGER NOT NULL,
    runs        INTEGER NOT NULL,
    cost_usd    REAL NOT NULL,
    removed_at  TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE runs ADD COLUMN denials INTEGER;
  `,
];

function migrate(db: DatabaseSync): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = current; version < migrations.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[version] ?? '');
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: o processo existe, mas pertence a outro usuário.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Marca como `failed`/`abandoned` as runs `running` cujo processo do Mabel já não existe. */
function abandonOrphans(db: DatabaseSync): void {
  const running = db.prepare("SELECT id, pid FROM runs WHERE status = 'running'").all() as {
    id: string;
    pid: number | null;
  }[];
  const abandon = db.prepare(
    "UPDATE runs SET status = 'failed', error = 'abandoned', ended_at = ? WHERE id = ? AND status = 'running'",
  );
  for (const run of running) {
    if (run.pid === null || !processAlive(run.pid)) abandon.run(new Date().toISOString(), run.id);
  }
}

/** Abre (e cria, se preciso) o banco do Mabel, aplicando migrações e fechando runs órfãs. */
export function openDb(home: string = dataDir()): DatabaseSync {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'mabel.db'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    abandonOrphans(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
