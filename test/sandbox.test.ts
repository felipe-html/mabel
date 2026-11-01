import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getItem, syncBacklog } from '../src/items.ts';
import { writeConfig } from '../src/project.ts';
import { runPlan } from '../src/stages.ts';
import { commitAll, prepareWorktree } from '../src/worktree.ts';
import { PLAN, setupProject, useScenario } from './helpers.ts';

function planContext() {
  const ctx = setupProject('\n## Soma\nQuero uma função soma.\n');
  syncBacklog(ctx.db, ctx.project);
  const item = getItem(ctx.db, ctx.project.id, 1)!;
  const { path } = prepareWorktree(ctx.db, ctx.home, ctx.project, item);
  return { ctx, stage: { home: ctx.home, project: ctx.project, item, worktree: path } };
}

function runSettings(ctx: ReturnType<typeof setupProject>, runId: string) {
  return JSON.parse(readFileSync(join(ctx.home, 'runs', runId, 'settings.json'), 'utf8'));
}

test('5.2: settings.json da run com sandbox estrito, rede da stack e do projeto e o .git fechado', async () => {
  const { ctx, stage } = planContext();
  useScenario(ctx.root, [{ structured_output: PLAN }, { structured_output: PLAN }]);

  // Config sem `rede` (anterior ao 5.2): domínios das stacks detectadas (package.json → npm).
  ctx.project.config.rede = null;
  const detected = await runPlan(ctx.db, stage, {});
  const settings = runSettings(ctx, detected.outcome.runId);
  assert.deepEqual(settings.sandbox, {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true, allowLocalBinding: true },
    filesystem: { allowWrite: ['~/.npm'], denyWrite: [join(realpathSync(ctx.root), '.git')] },
  });

  ctx.project.config.rede = ['registry.npmjs.org', 'api.exemplo.com'];
  const configured = await runPlan(ctx.db, stage, {});
  assert.deepEqual(runSettings(ctx, configured.outcome.runId).sandbox.network.allowedDomains, [
    'registry.npmjs.org',
    'api.exemplo.com',
  ]);
});

test('5.2: "sandbox": false roda sem sandbox e registra em cada run', async () => {
  const { ctx, stage } = planContext();
  useScenario(ctx.root, [{ structured_output: PLAN }]);
  ctx.project.config.sandbox = false;
  const result = await runPlan(ctx.db, stage, {});
  assert.equal(runSettings(ctx, result.outcome.runId).sandbox, undefined);
  const event = ctx.db
    .prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'mabel' AND subtype = 'sandbox_disabled'")
    .get(result.outcome.runId);
  assert.ok(event);
});

test('5.2: commits do Mabel não incluem .claude/', () => {
  const { stage } = planContext();
  writeFileSync(join(stage.worktree, 'novo.js'), 'x\n');
  spawnSync('mkdir', ['-p', join(stage.worktree, '.claude')]);
  writeFileSync(join(stage.worktree, '.claude', '.cc-writes'), 'y\n');
  assert.equal(commitAll(stage.worktree, 'teste'), true);
  const files = spawnSync('git', ['show', '--name-only', '--format=', 'HEAD'], { cwd: stage.worktree, encoding: 'utf8' }).stdout;
  const committed = files.trim().split('\n');
  assert.ok(committed.includes('novo.js'));
  assert.ok(!committed.some((file) => file.startsWith('.claude')));
});

test('5.2: run recusa iniciar sem sandbox, salvo "sandbox": false com aviso', () => {
  const ctx = setupProject('');
  const env = ctx.env;
  const run = () =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.ts'), 'rodar'], {
      cwd: ctx.root,
      encoding: 'utf8',
      env: { ...env(), MABEL_SANDBOX_INDISPONIVEL: 'sandbox-exec não encontrado' },
    });
  const refused = run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Sandbox indisponível: sandbox-exec não encontrado\. O Mabel não roda etapas sem ele\./);
  assert.match(refused.stderr, /"sandbox": false/);

  writeConfig(ctx.root, { ...ctx.project.config, sandbox: false });
  spawnSync('git', ['commit', '-qam', 'sem sandbox'], { cwd: ctx.root });
  const allowed = run();
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /Aviso: "sandbox": false/);
});
