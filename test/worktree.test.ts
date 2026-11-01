import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { LockError, acquireLock, lockPath } from '../src/lock.ts';
import { claudeArgs, startRun } from '../src/runner.ts';
import { branchName, commitAll, commitMessage, isMerged, prepareWorktree, removeWorktree, slugify } from '../src/worktree.ts';
import { FAKE_CLAUDE, setupProject } from './helpers.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/stream-read-file.jsonl', import.meta.url));

test('claudeArgs monta as flags de etapa', () => {
  assert.deepEqual(
    claudeArgs({
      kind: 'stage',
      prompt: 'faça',
      cwd: '/',
      model: 'sonnet',
      maxTurns: 10,
      maxBudgetUsd: 2,
      permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Bash(git diff:*)'],
      disallowedTools: ['Bash(git push:*)', 'Bash(sudo:*)'],
      appendSystemPrompt: 'Você é o executor.',
      jsonSchema: { type: 'object' },
      resumeSessionId: 'abc',
      itemId: 'x',
      stage: 'execute',
    }),
    [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--restricted', '--strict-mcp-config', '--disable-slash-commands', '--tools', '',
      '--model', 'sonnet', '--max-turns', '10', '--max-budget-usd', '2',
      '--permission-mode', 'dontAsk',
      '--allowedTools', 'Read,Bash(git diff:*)',
      '--disallowedTools', 'Bash(git push:*),Bash(sudo:*)',
      '--append-system-prompt', 'Você é o executor.',
      '--json-schema', '{"type":"object"}',
      '--resume', 'abc',
      '--', 'faça',
    ],
  );
});

test('structured_output, item e etapa gravados na run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mabel-structured-'));
  const fixture = join(root, 'stream.jsonl');
  const lines = readFileSync(FIXTURE, 'utf8').trimEnd().split('\n').map((line) => {
    const event = JSON.parse(line);
    if (event.type === 'result') event.structured_output = { resumo: 'ok', passos: ['a'] };
    return JSON.stringify(event);
  });
  writeFileSync(fixture, `${lines.join('\n')}\n`);
  Object.assign(process.env, { MABEL_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_FIXTURE: fixture, CLAUDE_CONFIG_DIR: root });

  const home = join(root, 'home');
  const db = openDb(home);
  db.prepare("INSERT INTO projects (id, root, name, created_at) VALUES ('p', '/', 'p', '')").run();
  db.prepare(
    `INSERT INTO items (id, project_id, number, position, title, intent, criteria, depends_on, content_hash, status,
       created_at, updated_at) VALUES ('item-1', 'p', 1, 0, 't', 'i', '[]', '[]', 'h', 'planning', '', '')`,
  ).run();
  const outcome = await startRun(db, home, { kind: 'stage', stage: 'plan', itemId: 'item-1', prompt: 'p', cwd: root }).done;
  assert.deepEqual(outcome.totals?.structuredOutput, { resumo: 'ok', passos: ['a'] });
  assert.equal(outcome.sessionId, '76abb708-6eea-4fda-8e7e-37138ceb22fc');
  const row = db.prepare('SELECT kind, stage, item_id, structured_output FROM runs').get();
  assert.deepEqual({ ...row }, {
    kind: 'stage',
    stage: 'plan',
    item_id: 'item-1',
    structured_output: '{"resumo":"ok","passos":["a"]}',
  });
  db.close();
  delete process.env.FAKE_CLAUDE_FIXTURE;
});

test('slug e branch do item', () => {
  assert.equal(slugify('Exportar pedidos em CSV (versão 2)!'), 'exportar-pedidos-em-csv-versao-2');
  assert.equal(slugify('Ação'.repeat(20)).length <= 40, true);
  assert.equal(branchName({ number: 3, title: 'Permissões por perfil' }), 'mabel/3-permissoes-por-perfil');
});

test('worktree criado da branch base, reutilizado na retomada e removido no fim', () => {
  const ctx = setupProject('\n## Primeiro item\nfazer algo\n\n## Segundo\noutra coisa\n');
  syncBacklog(ctx.db, ctx.project);
  const item = getItem(ctx.db, ctx.project.id, 1)!;
  ctx.project.config.setup = 'echo preparado > .setup-ok';

  const first = prepareWorktree(ctx.db, ctx.home, ctx.project, item);
  assert.equal(first.created, true);
  assert.equal(first.setupError, undefined);
  assert.equal(first.branch, 'mabel/1-primeiro-item');
  assert.ok(first.path.startsWith(join(ctx.home, 'worktrees', ctx.project.id)));
  assert.ok(existsSync(join(first.path, 'README.md')));
  assert.ok(existsSync(join(first.path, '.setup-ok')));
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
  assert.equal(git(first.path, 'rev-parse', 'HEAD'), git(ctx.root, 'rev-parse', 'main'));
  const saved = getItem(ctx.db, ctx.project.id, 1)!;
  assert.deepEqual([saved.branch, saved.worktree], [first.branch, first.path]);

  const again = prepareWorktree(ctx.db, ctx.home, ctx.project, saved);
  assert.deepEqual(again, { path: first.path, branch: first.branch, created: false });

  writeFileSync(join(first.path, 'novo.txt'), 'x');
  assert.equal(commitAll(first.path, commitMessage(saved, 1)), true);
  assert.equal(commitAll(first.path, commitMessage(saved, 2)), false);
  assert.equal(git(first.path, 'log', '-1', '--format=%s %an'), 'mabel(#1): Primeiro item — execução 1 Teste');

  assert.equal(isMerged(ctx.project, first.branch), false);
  spawnSync('git', ['merge', '-q', '--no-edit', first.branch], { cwd: ctx.root });
  assert.equal(isMerged(ctx.project, first.branch), true);

  removeWorktree(ctx.db, ctx.project, saved);
  assert.equal(existsSync(first.path), false);
  assert.notEqual(git(ctx.root, 'rev-parse', '--verify', first.branch), '');
  assert.equal(getItem(ctx.db, ctx.project.id, 1)?.worktree, null);

  // Branch existente sem worktree (retomada depois de remover): reutiliza a branch.
  const resumed = prepareWorktree(ctx.db, ctx.home, ctx.project, getItem(ctx.db, ctx.project.id, 1)!);
  assert.equal(resumed.created, true);
  assert.ok(existsSync(join(resumed.path, 'novo.txt')));

  ctx.project.config.setup = 'echo quebrou; exit 3';
  const broken = prepareWorktree(ctx.db, ctx.home, ctx.project, getItem(ctx.db, ctx.project.id, 2)!);
  assert.match(broken.setupError ?? '', /saiu com 3: quebrou/);
});

test('worktree reutilizado sem commits próprios avança até a branch base', () => {
  const ctx = setupProject('\n## Primeiro item\nfazer algo\n');
  syncBacklog(ctx.db, ctx.project);
  const first = prepareWorktree(ctx.db, ctx.home, ctx.project, getItem(ctx.db, ctx.project.id, 1)!);
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(first.path, 'rascunho.txt'), 'não rastreado');

  writeFileSync(join(ctx.root, 'depois.txt'), 'x');
  git(ctx.root, 'add', 'depois.txt');
  git(ctx.root, 'commit', '-q', '-m', 'depois do worktree');
  prepareWorktree(ctx.db, ctx.home, ctx.project, getItem(ctx.db, ctx.project.id, 1)!);
  assert.equal(git(first.path, 'rev-parse', 'HEAD'), git(ctx.root, 'rev-parse', 'main'));

  // Com commit próprio, o worktree não é tocado.
  writeFileSync(join(first.path, 'novo.txt'), 'y');
  commitAll(first.path, 'próprio');
  const own = git(first.path, 'rev-parse', 'HEAD');
  writeFileSync(join(ctx.root, 'mais.txt'), 'z');
  git(ctx.root, 'add', 'mais.txt');
  git(ctx.root, 'commit', '-q', '-m', 'mais um');
  prepareWorktree(ctx.db, ctx.home, ctx.project, getItem(ctx.db, ctx.project.id, 1)!);
  assert.equal(git(first.path, 'rev-parse', 'HEAD'), own);
});

test('trava: segundo processo no mesmo projeto falha com mensagem clara; lock órfão é descartado', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mabel-lock-'));
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await new Promise((resolve) => holder.once('spawn', resolve));
  mkdirSync(join(home, 'locks'));
  writeFileSync(lockPath(home, 'p'), `${holder.pid}\n`);
  assert.throws(() => acquireLock(home, 'p'), (error: Error) => {
    assert.ok(error instanceof LockError);
    assert.match(error.message, new RegExp(`Já há um \`mabel rodar\` neste projeto \\(pid ${holder.pid}\\)`));
    return true;
  });

  holder.kill();
  await new Promise((resolve) => holder.once('exit', resolve));
  const release = acquireLock(home, 'p');
  assert.equal(readFileSync(lockPath(home, 'p'), 'utf8').trim(), String(process.pid));
  release();
  assert.equal(existsSync(lockPath(home, 'p')), false);
});
