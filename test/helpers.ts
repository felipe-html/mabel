import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKLOG_TEMPLATE } from '../src/backlog.ts';
import { openDb } from '../src/db.ts';
import { resolveProject } from '../src/project.ts';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

/** Repositório git temporário, na branch `main`, com os arquivos dados e um commit inicial. */
export function makeRepo(files: Record<string, string> = {}, { commit = true } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'mabel-repo-'));
  const run = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Teste');
  run('config', 'user.email', 'teste@example.com');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (commit) {
    writeFileSync(join(root, 'README.md'), '# teste\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'inicial');
  }
  return root;
}

/** Projeto Mabel num repositório temporário, com `MABEL_HOME` próprio e o banco aberto. */
export function setupProject(backlog?: string) {
  const root = makeRepo({ 'src/index.js': '', 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const env = { ...process.env, MABEL_HOME: home, NO_COLOR: '1' };
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { cwd: root, encoding: 'utf8', env });
  assert.equal(cli('init').status, 0);
  const path = join(root, '.mabel', 'backlog.md');
  if (backlog !== undefined) writeFileSync(path, BACKLOG_TEMPLATE + backlog);
  const db = openDb(home);
  const project = resolveProject(db, root);
  return { root, home, cli, path, db, project };
}
