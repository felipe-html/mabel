import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderDenials } from '../src/decide.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { type PipelineEnv, advanceItem } from '../src/pipeline.ts';
import type { PlanOutput } from '../src/schemas/stages.ts';
import { SCOPE_HOOK, readArtifact } from '../src/stages.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

function hookEnv(overrides: Record<string, unknown> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mabel-hook-')));
  const worktree = join(dir, 'wt');
  mkdirSync(join(worktree, 'src', 'billing'), { recursive: true });
  const log = join(dir, 'hook.jsonl');
  const context = join(dir, 'escopo.json');
  writeFileSync(
    context,
    JSON.stringify({
      worktree,
      stage: 'execute',
      escopo: ['src/**', 'test/**'],
      criticos: ['src/billing/**'],
      criticosAprovados: false,
      log,
      ...overrides,
    }),
  );
  const call = (input: object, env: Record<string, string | undefined> = { MABEL_ESCOPO: context }) => {
    const result = spawnSync(process.execPath, [SCOPE_HOOK], {
      input: JSON.stringify({ cwd: worktree, ...input }),
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });
    assert.equal(result.status, 0, result.stderr);
    const out = result.stdout.trim();
    return out ? (JSON.parse(out).hookSpecificOutput as { permissionDecision: string; permissionDecisionReason: string }) : undefined;
  };
  const entries = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { decision: string; tool: string; path?: string; reason?: string });
  return { dir, worktree, context, call, entries };
}

const write = (file_path: string, tool = 'Write') => ({ tool_name: tool, tool_input: { file_path, content: 'x' } });

test('5.3: cada regra do hook, na ordem, com o script e stdin simulado', () => {
  const h = hookEnv();
  // 1. Fora do worktree (absoluto e relativo que sobe).
  assert.equal(h.call(write(join(h.dir, 'fora.txt')))?.permissionDecisionReason, 'fora do worktree do item');
  assert.equal(h.call(write('../fora.txt'))?.permissionDecisionReason, 'fora do worktree do item');
  // 2. Arquivo do git ou do Mabel, mesmo dentro do escopo.
  assert.equal(h.call(write('.git/config', 'Edit'))?.permissionDecisionReason, 'arquivo do Mabel ou do git');
  assert.equal(h.call(write(join(h.worktree, '.mabel/backlog.md')))?.permissionDecisionReason, 'arquivo do Mabel ou do git');
  // 3. Caminho crítico sem aprovação, mesmo casando com o escopo.
  assert.equal(
    h.call(write('src/billing/preco.ts', 'MultiEdit'))?.permissionDecisionReason,
    'caminho crítico sem aprovação: src/billing/**',
  );
  // 4. Fora do escopo do plano.
  assert.equal(
    h.call({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'docs/x.ipynb' } })?.permissionDecisionReason,
    'fora do escopo do plano; declare em escopoAdicional se for necessário',
  );
  // 5. No escopo: sai sem saída (nunca `allow`, que passaria por cima das permissões).
  assert.equal(h.call(write('src/novo/soma.ts')), undefined);
  assert.equal(h.call(write(join(h.worktree, 'test/soma.test.ts'), 'Edit')), undefined);
  // Bash só registra.
  assert.equal(h.call({ tool_name: 'Bash', tool_input: { command: 'npm test' } }), undefined);

  const entries = h.entries();
  assert.deepEqual(
    entries.map((e) => e.decision),
    ['deny', 'deny', 'deny', 'deny', 'deny', 'deny', 'allow', 'allow', 'allow'],
  );
  assert.equal(entries[6]?.path, 'src/novo/soma.ts');
  assert.equal((entries[8] as { command?: string }).command, 'npm test');
});

test('5.3: caminho crítico aprovado passa pela regra do escopo', () => {
  const h = hookEnv({ criticosAprovados: true });
  assert.equal(h.call(write('src/billing/preco.ts')), undefined);
});

test('5.3: erro ao ler o contexto nega a ação (falha fechado)', () => {
  const h = hookEnv();
  const missing = h.call(write('src/a.ts'), { MABEL_ESCOPO: undefined });
  assert.equal(missing?.permissionDecision, 'deny');
  assert.match(missing?.permissionDecisionReason ?? '', /hook de escopo do Mabel falhou: MABEL_ESCOPO ausente/);
  writeFileSync(h.context, '{ quebrado');
  assert.equal(h.call(write('src/a.ts'))?.permissionDecision, 'deny');
  assert.equal(h.call({ tool_name: 'Bash', tool_input: { command: 'ls' } })?.permissionDecision, 'deny');
});

function scopeProject(responses: unknown[], rules = '') {
  const ctx = setupProject('\n## Soma\nQuero uma função soma.\n');
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  if (rules) {
    writeFileSync(join(ctx.root, '.mabel', 'regras-criticas.md'), rules);
    spawnSync('git', ['commit', '-qam', 'regras'], { cwd: ctx.root });
  }
  const scenario = useScenario(ctx.root, responses);
  const lines: string[] = [];
  const env: PipelineEnv = { db: ctx.db, home: ctx.home, project: ctx.project, log: (line) => lines.push(line) };
  const item = () => getItem(ctx.db, ctx.project.id, 1)!;
  const gates = (gate: string) =>
    ctx.db.prepare('SELECT attempt, passed, detail FROM gate_results WHERE gate = ? ORDER BY id').all(gate).map((r) => ({ ...r }));
  return { ...ctx, scenario, lines, env, item, gates };
}

const PLAN_OK = { structured_output: { ...PLAN, escopo: ['src/**', 'test/**'] } };
const REVIEW = { structured_output: REVIEW_OK };

test('5.3: escopoAdicional não crítico amplia o escopo e retoma a mesma sessão, sem contar tentativa', async () => {
  const p = scopeProject([
    PLAN_OK,
    {
      structured_output: { ...EXECUTION, escopoAdicional: [{ glob: 'docs/soma.md', motivo: 'documentar a função' }] },
      session_id: 'exec-1',
    },
    { structured_output: EXECUTION, files: { ...EXECUTION_FILES, 'docs/soma.md': '# soma\n' } },
    REVIEW,
  ]);
  syncBacklog(p.db, p.project);
  assert.deepEqual(await advanceItem(p.env, p.item().id), { kind: 'stopped', status: 'awaiting_merge' });
  const plan = readArtifact<PlanOutput>(p.home, p.item().id, 'plano.json')!;
  assert.deepEqual(plan.escopo, ['src/**', 'test/**', 'docs/soma.md']);
  assert.deepEqual(p.gates('scope_extension'), [{ attempt: 1, passed: 1, detail: '`docs/soma.md` — documentar a função' }]);
  assert.deepEqual(p.gates('autonomy'), [{ attempt: 1, passed: 1, detail: 'ampliar o escopo para `docs/soma.md` → documentar a função' }]);

  const executions = p.scenario.log().filter((call) => call.argv.includes('--json-schema')).slice(1, 3);
  const resumed = executions[1]!.argv;
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'exec-1');
  assert.match(resumed.at(-1) as string, /^# Tentativa 1\n[\s\S]*## Escopo ampliado[\s\S]*`docs\/soma\.md`/);
  assert.equal(p.item().attemptNo, 1);
  // O hook da retomada já enxerga o escopo novo.
  const runs = p.db.prepare("SELECT id FROM runs WHERE stage = 'execute' ORDER BY started_at, rowid").all() as { id: string }[];
  const scope = JSON.parse(readFileSync(join(p.home, 'runs', runs[1]!.id, 'escopo.json'), 'utf8'));
  assert.deepEqual(scope.escopo, ['src/**', 'test/**', 'docs/soma.md']);
  assert.equal(scope.stage, 'execute');
  assert.ok(p.lines.some((line) => line.includes('escopo ampliado (autônomo): docs/soma.md')));
});

test('5.3: escopoAdicional em caminho crítico vai para critical_approval', async () => {
  // O plano não toca o caminho crítico (passa no G2); a execução pede um arquivo dele.
  const planned = { structured_output: { ...PLAN, escopo: ['src/soma.js', 'test/**'] }, session_id: 'plan-1' };
  const p = scopeProject(
    [planned, { structured_output: { ...EXECUTION, escopoAdicional: [{ glob: 'src/billing/taxa.js', motivo: 'reusar a taxa' }] } }],
    '## Caminhos\n- src/billing/**\n',
  );
  syncBacklog(p.db, p.project);
  assert.deepEqual(await advanceItem(p.env, p.item().id), { kind: 'stopped', status: 'needs_human' });
  const item = p.item();
  assert.equal(item.pendingKind, 'critical_approval');
  // `responder` retoma o planejamento: a sessão pendente é a do plano, não a da execução.
  assert.equal(item.pending?.sessionId, 'plan-1');
  assert.match(item.pending?.reason ?? '', /escopo pedido pela execução: `src\/billing\/taxa\.js` toca o caminho crítico `src\/billing\/\*\*`/);
  assert.deepEqual(p.gates('scope_extension').map((g) => (g as { passed: number }).passed), [0]);
  assert.deepEqual(p.gates('autonomy'), []);
});

test('5.3: decisões do hook viram eventos da run, runs.denials preenchido e mabel item mostra as negações', async () => {
  const p = scopeProject([]);
  syncBacklog(p.db, p.project);
  const { startRun } = await import('../src/runner.ts');
  const worktree = mkdtempSync(join(tmpdir(), 'mabel-wt-'));
  // O `claude` falso não roda hooks: o log é escrito como o hook escreveria.
  const fixture = join(worktree, 'stream.jsonl');
  const original = readFileSync(join(import.meta.dirname, 'fixtures', 'stream-read-file.jsonl'), 'utf8').trimEnd().split('\n');
  const stream = original.map((line) => {
    const event = JSON.parse(line);
    if (event.type === 'system' && event.subtype === 'init') Object.assign(event, { tools: ['Read'], plugins: [], agents: [], memory_paths: {} });
    if (event.type === 'result') event.permission_denials = [{ tool_name: 'Write' }, { tool_name: 'Write' }];
    return JSON.stringify(event);
  });
  writeFileSync(fixture, `${stream.join('\n')}\n`);
  delete process.env.FAKE_CLAUDE_SCENARIO;
  process.env.FAKE_CLAUDE_FIXTURE = fixture;
  const handle = startRun(p.db, p.home, {
    kind: 'stage',
    stage: 'execute',
    itemId: p.item().id,
    prompt: 'p',
    cwd: worktree,
    tools: ['Read'],
    scope: { worktree, stage: 'execute', escopo: ['src/**'], criticos: [], criticosAprovados: false },
  });
  const scopePath = join(p.home, 'runs', handle.runId, 'escopo.json');
  const log = JSON.parse(readFileSync(scopePath, 'utf8')).log as string;
  writeFileSync(
    log,
    [
      { decision: 'allow', tool: 'Write', path: 'src/a.js' },
      { decision: 'deny', tool: 'Write', path: 'docs/x.md', reason: 'fora do escopo do plano; declare em escopoAdicional se for necessário' },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );
  const outcome = await handle.done;
  delete process.env.FAKE_CLAUDE_FIXTURE;
  assert.equal(outcome.status, 'succeeded', outcome.error ?? '');
  const hooks = p.db.prepare("SELECT subtype FROM events WHERE run_id = ? AND type = 'hook' ORDER BY seq").all(handle.runId);
  assert.deepEqual(hooks.map((row) => (row as { subtype: string }).subtype), ['allow', 'deny']);
  const run = p.db.prepare('SELECT denials FROM runs WHERE id = ?').get(handle.runId) as { denials: number };
  assert.equal(run.denials, 2);
  const lines = renderDenials(p.db, p.item().id).join('\n');
  assert.match(lines, /execute · run .{4}: 2 negações/);
  assert.match(lines, /Write docs\/x\.md — fora do escopo do plano/);
});
