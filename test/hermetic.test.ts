import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initViolation, projectContext } from '../src/hermetic.ts';
import { getItem, getItemById, syncBacklog } from '../src/items.ts';
import { advanceItem } from '../src/pipeline.ts';
import { claudeArgs } from '../src/runner.ts';
import { runPlan, stageRequest } from '../src/stages.ts';
import { probeRequest } from '../src/status.ts';
import { prepareWorktree } from '../src/worktree.ts';
import { PLAN, setupProject, useScenario } from './helpers.ts';

const HERMETIC = ['--restricted', '--strict-mcp-config', '--disable-slash-commands'];

test('5.1: flags herméticas na etapa e no probe, não no exec', () => {
  const stage = claudeArgs({ kind: 'stage', prompt: 'p', cwd: '/', tools: ['Read', 'Glob'] }, '/runs/1/settings.json');
  assert.deepEqual(stage.slice(4, 11), [...HERMETIC, '--tools', 'Read,Glob', '--settings', '/runs/1/settings.json']);

  const probe = claudeArgs(probeRequest('/home'), '/runs/2/settings.json');
  assert.deepEqual(probe.slice(4, 9), [...HERMETIC, '--tools', '']);

  const exec = claudeArgs({ kind: 'exec', prompt: 'p', cwd: '/', tools: ['Read'] }, '/x.json');
  for (const flag of [...HERMETIC, '--tools', '--settings']) assert.ok(!exec.includes(flag), flag);
});

function itemWithWorktree(files: Record<string, string>) {
  const ctx = setupProject('\n## Soma\nQuero uma função soma.\n');
  for (const [path, content] of Object.entries(files)) writeFileSync(join(ctx.root, path), content);
  spawnSync('git', ['add', '-A'], { cwd: ctx.root });
  spawnSync('git', ['commit', '-q', '-m', 'contexto'], { cwd: ctx.root });
  syncBacklog(ctx.db, ctx.project);
  const item = getItem(ctx.db, ctx.project.id, 1)!;
  const { path } = prepareWorktree(ctx.db, ctx.home, ctx.project, item);
  return { ctx, item, worktree: path };
}

test('5.1: contexto do projeto com CLAUDE.md, AGENTS.md e regras críticas, na ordem, uma vez cada', () => {
  const { ctx, item, worktree } = itemWithWorktree({
    'CLAUDE.md': '# Projeto\nUse tabs.\n',
    'AGENTS.md': 'Responda em português.\n',
    '.mabel/regras-criticas.md': '## Caminhos\n- src/billing/**\n\n## Conceitos\n- Desconto máximo de 10%\n',
  });
  const request = stageRequest({ home: ctx.home, project: ctx.project, item, worktree }, 'plan', 'p');
  const prompt = request.appendSystemPrompt ?? '';
  const marks = ['## Contexto do projeto', '### CLAUDE.md', 'Use tabs.', '### AGENTS.md', 'Responda em português.',
    '## Regras críticas do projeto', '`src/billing/**`', 'Desconto máximo de 10%'];
  let last = -1;
  for (const mark of marks) {
    const at = prompt.indexOf(mark);
    assert.ok(at > last, `${mark} fora de ordem`);
    assert.equal(prompt.indexOf(mark, at + 1), -1, `${mark} repetido`);
    last = at;
  }
  // As regras saem do prompt do usuário: só o prompt de sistema as carrega.
  assert.equal(request.prompt, 'p');
});

test('5.1: sem CLAUDE.md nem AGENTS.md, só as regras críticas', () => {
  const { worktree } = itemWithWorktree({});
  const context = projectContext(worktree);
  assert.equal(context.kind, 'ok');
  assert.ok(context.kind === 'ok' && !context.text.includes('## Contexto do projeto'));
  assert.ok(context.kind === 'ok' && context.text.includes('## Regras críticas do projeto'));
});

test('5.1: contexto acima do orçamento pausa a fila sem iniciar a run', async () => {
  const { ctx, item } = itemWithWorktree({ 'CLAUDE.md': 'x'.repeat(41_000) });
  const { log } = useScenario(ctx.root, [{ structured_output: PLAN }]);
  const lines: string[] = [];
  const result = await advanceItem({ db: ctx.db, home: ctx.home, project: ctx.project, log: (line) => lines.push(line) }, item.id);
  assert.equal(result.kind, 'paused');
  assert.match(result.kind === 'paused' ? (result.reason ?? '') : '', /acima do orçamento de 40000 \(CLAUDE\.md 41\d{3}, \.mabel\/regras-criticas\.md \d+\)/);
  assert.equal(log().length, 0);
  assert.equal(getItemById(ctx.db, item.id).status, 'planning');
  assert.equal((ctx.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n, 0);

  // Orçamento configurável: com espaço, a etapa roda.
  const configPath = join(ctx.root, '.mabel', 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), contexto: { maxCaracteres: 50_000 } }));
  ctx.project.config.contexto.maxCaracteres = 50_000;
  await advanceItem({ db: ctx.db, home: ctx.home, project: ctx.project }, item.id, { until: 'planned' });
  assert.equal(log().length, 1);
});

test('5.1: init com memória, MCP, skills, comandos ou ferramenta extra viola o contexto', () => {
  const clean = { tools: ['Read', 'Glob'], mcp_servers: [], skills: [], slash_commands: [], memory_paths: {}, plugins: [], agents: ['Explore'] };
  assert.equal(initViolation(clean, ['Glob', 'Read']), undefined);
  assert.equal(initViolation({ ...clean, memory_paths: undefined }, ['Read', 'Glob']), undefined);
  assert.equal(initViolation({ ...clean, memory_paths: { auto: '/m' } }, ['Read', 'Glob']), 'memory_paths');
  assert.equal(initViolation({ ...clean, mcp_servers: [{ name: 'm', status: 'connected' }] }, ['Read', 'Glob']), 'mcp_servers');
  assert.equal(initViolation({ ...clean, skills: ['deploy'] }, ['Read', 'Glob']), 'skills');
  assert.equal(initViolation({ ...clean, slash_commands: ['x'] }, ['Read', 'Glob']), 'slash_commands');
  assert.equal(initViolation({ ...clean, tools: ['Read', 'Glob', 'WebFetch'] }, ['Read', 'Glob']), 'tools (+WebFetch)');
  assert.equal(initViolation({ ...clean, tools: ['Read'] }, ['Read', 'Glob']), 'tools (-Glob)');
  assert.equal(initViolation({ ...clean, tools: undefined }, ['Read']), 'tools ausente');
  assert.equal(initViolation({ ...clean, plugins: [{ name: 'meu-plugin' }] }, ['Read', 'Glob']), 'plugins (meu-plugin)');
  assert.equal(initViolation({ ...clean, agents: ['Explore', 'revisor-pessoal'] }, ['Read', 'Glob']), 'agents (revisor-pessoal)');
});

test('5.1: o runner interrompe a run não hermética como failed e guarda o init', async () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ memory_paths: { auto: '/m' } }, 'memory_paths'],
    [{ mcp_servers: [{ name: 'm' }] }, 'mcp_servers'],
    [{ skills: ['deploy'] }, 'skills'],
    [{ tools: ['Read', 'Glob', 'Grep', 'WebFetch'] }, 'tools (+WebFetch)'],
  ];
  const { ctx, item, worktree } = itemWithWorktree({});
  useScenario(ctx.root, cases.map(([init]) => ({ init, structured_output: PLAN })));
  for (const [, field] of cases) {
    const result = await runPlan(ctx.db, { home: ctx.home, project: ctx.project, item, worktree }, {});
    assert.equal(result.outcome.status, 'failed');
    assert.equal(result.outcome.error, `contexto não hermético: ${field}`);
    const init = ctx.db
      .prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'system' AND subtype = 'init'")
      .get(result.outcome.runId) as { payload: string };
    assert.ok(init.payload.includes('"subtype":"init"'));
    assert.ok(existsSync(join(ctx.home, 'runs', result.outcome.runId, 'settings.json')));
  }
});
