import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { approve, respond } from '../src/decisions.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { type PipelineEnv, advanceItem, criteriaWithoutTests, escalate, startGate } from '../src/pipeline.ts';
import type { PlanOutput } from '../src/schemas/stages.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const plan = (over: Partial<PlanOutput> = {}): PlanOutput => ({ ...(PLAN as PlanOutput), ...over });
const NO_RULES = { paths: [], concepts: [] };

test('G2: cada condição do gate de início', () => {
  assert.deepEqual(startGate(undefined, 'saída estruturada ausente', NO_RULES, false), {
    kind: 'incomplete',
    reason: 'saída estruturada ausente',
  });
  assert.deepEqual(startGate(plan({ perguntas: [{ texto: 'Qual banco?', sugestao: 'SQLite' }] }), undefined, NO_RULES, false), {
    kind: 'questions',
    questions: [{ texto: 'Qual banco?', sugestao: 'SQLite' }],
  });
  assert.deepEqual(startGate(plan({ criterios: [] }), undefined, NO_RULES, false), {
    kind: 'incomplete',
    reason: 'plano sem critérios de aceite',
  });
  assert.deepEqual(
    startGate(plan({ criterios: [{ id: 'C1', texto: 't', verificacao: '' as never }] }), undefined, NO_RULES, false),
    { kind: 'incomplete', reason: 'critérios sem verificação: C1' },
  );
  assert.deepEqual(startGate(plan({ escopo: [] }), undefined, NO_RULES, false), {
    kind: 'incomplete',
    reason: 'plano sem escopo de arquivos',
  });
  assert.deepEqual(startGate(plan(), undefined, NO_RULES, false), { kind: 'pass' });
});

test('G2: regra crítica por caminho, conceito ou suposição; aprovação libera', () => {
  const rules = { paths: ['src/billing/**', 'migrations/*.sql'], concepts: ['Desconto máximo'] };
  assert.deepEqual(startGate(plan({ escopo: ['src/**'] }), undefined, rules, false), {
    kind: 'critical',
    reasons: ['escopo `src/**` toca o caminho crítico `src/billing/**`'],
  });
  assert.deepEqual(startGate(plan({ escopo: ['src/pedidos/*.ts', 'test/**'] }), undefined, rules, false), { kind: 'pass' });
  assert.deepEqual(startGate(plan({ escopo: ['migrations/002.sql'] }), undefined, rules, false).kind, 'critical');
  assert.deepEqual(startGate(plan({ escopo: ['lib/x.ts'], conceitosCriticos: ['Desconto máximo'] }), undefined, rules, false), {
    kind: 'critical',
    reasons: ['conceito crítico: Desconto máximo'],
  });
  assert.deepEqual(
    startGate(plan({ suposicoes: [{ texto: 'frete grátis', regraCritica: true }] }), undefined, NO_RULES, false),
    { kind: 'critical', reasons: ['suposição sobre regra crítica: frete grátis'] },
  );
  assert.deepEqual(startGate(plan({ escopo: ['src/**'] }), undefined, rules, true), { kind: 'pass' });
});

test('escada de modelos', () => {
  assert.deepEqual(['haiku', 'sonnet', 'opus', 'claude-sonnet-5-5'].map(escalate), ['sonnet', 'opus', 'opus', 'opus']);
});

// Cenários -------------------------------------------------------------------------------

const VERIFY = [{ name: 'existe', command: 'test -f src/soma.js' }];

function pipeline(responses: unknown[], options: { verify?: { name: string; command: string }[]; execute?: string } = {}) {
  const ctx = setupProject('\n## Soma\nQuero uma função soma.\n');
  ctx.project.config.setup = null;
  ctx.project.config.verify = options.verify ?? VERIFY;
  if (options.execute) ctx.project.config.models.execute = options.execute;
  syncBacklog(ctx.db, ctx.project);
  const { log } = useScenario(ctx.root, responses);
  const lines: string[] = [];
  const env: PipelineEnv = { db: ctx.db, home: ctx.home, project: ctx.project, log: (line) => lines.push(line) };
  const item = () => getItem(ctx.db, ctx.project.id, 1)!;
  const calls = () =>
    log().map((call) => {
      const at = (flag: string) => (call.argv.includes(flag) ? call.argv[call.argv.indexOf(flag) + 1] : undefined);
      return { model: at('--model'), resume: at('--resume'), session: call.session_id, prompt: call.argv.at(-1) as string };
    });
  const gates = () =>
    ctx.db
      .prepare('SELECT attempt, gate, passed FROM gate_results WHERE item_id = ? ORDER BY id')
      .all(item().id)
      .map((row) => ({ ...row }));
  const advance = () => advanceItem(env, item().id);
  const branchLog = () =>
    spawnSync('git', ['log', '--format=%s', `main..${item().branch}`], { cwd: ctx.root, encoding: 'utf8' }).stdout.trim();
  return { ctx, env, item, calls, gates, advance, lines, branchLog };
}

const exec = (n: number, extra: object = {}) => ({
  structured_output: EXECUTION,
  files: { ...EXECUTION_FILES, 'src/soma.js': `export const soma = (a, b) => a + b; // versao ${n}\n` },
  ...extra,
});

test('fluxo feliz: planejar, executar, verificar, revisar e awaiting_merge com commit', async () => {
  const p = pipeline([{ structured_output: PLAN }, exec(1), { structured_output: REVIEW_OK }]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  assert.equal(p.branchLog(), 'mabel(#1): Soma — execução 1');
  assert.deepEqual(p.gates(), [
    { attempt: 0, gate: 'start', passed: 1 },
    { attempt: 1, gate: 'existe', passed: 1 },
    { attempt: 1, gate: 'criteria_tests', passed: 1 },
    { attempt: 1, gate: 'review', passed: 1 },
  ]);
  assert.ok(existsSync(join(p.ctx.home, 'items', p.item().id, 'verificacao-1', 'existe.log')));
  assert.deepEqual(p.lines.map((line) => line.split(': ')[1]?.split(' · ')[0]), [
    'ready → planning',
    'planning → executing',
    'executing → verifying',
    'verifying → reviewing',
    'reviewing → awaiting_merge',
  ]);
});

test('plano incompleto: refeito uma vez pela mesma sessão; segunda falha → needs_human', async () => {
  const p = pipeline([{ session_id: 'plan-1' }, { structured_output: plan({ escopo: [] }) }]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'needs_human' });
  const calls = p.calls();
  assert.deepEqual(calls.map((c) => c.resume), [undefined, 'plan-1']);
  assert.match(calls[1]?.prompt ?? '', /## Plano incompleto\n\nsaída estruturada ausente/);
  assert.equal(p.item().pendingKind, 'plan_incomplete');
  assert.match(p.item().statusReason ?? '', /plano incompleto duas vezes: plano sem escopo/);
  assert.equal(p.item().attempts, 0);

  const ok = pipeline([{ session_id: 'plan-1' }, { structured_output: PLAN }, exec(1), { structured_output: REVIEW_OK }]);
  assert.deepEqual(await ok.advance(), { kind: 'stopped', status: 'awaiting_merge' });
});

test('G7: pergunta na execução para sem commit; responder retoma a sessão da execução', async () => {
  const p = pipeline([
    { structured_output: PLAN },
    { session_id: 'exec-1', structured_output: { ...EXECUTION, perguntas: [{ texto: 'Arredondar para cima?', sugestao: 'Sim' }] }, files: EXECUTION_FILES },
    exec(1),
    { structured_output: REVIEW_OK },
  ]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.equal(p.item().pendingKind, 'question_execute');
  assert.deepEqual(p.item().pending?.questions, [{ texto: 'Arredondar para cima?', sugestao: 'Sim' }]);
  assert.equal(p.branchLog(), '');
  assert.ok(existsSync(join(p.item().worktree!, 'src/soma.js')));
  assert.equal(p.item().attempts, 0);

  assert.equal(respond(p.ctx.db, p.ctx.project, p.item(), 'Sim, para cima.'), 'executing');
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const resumed = p.calls()[2];
  assert.equal(resumed?.resume, 'exec-1');
  assert.match(resumed?.prompt ?? '', /## Resposta do humano\n\nSim, para cima\./);
  assert.equal(p.branchLog(), 'mabel(#1): Soma — execução 1');
  const reasons = p.ctx.db
    .prepare("SELECT reason FROM item_transitions WHERE item_id = ? AND reason LIKE 'humano:%'")
    .all(p.item().id) as { reason: string }[];
  assert.deepEqual(reasons.map((r) => r.reason), ['humano: responder: Sim, para cima.']);
});

test('G7: suposição crítica na execução também para', async () => {
  const p = pipeline([
    { structured_output: PLAN },
    { structured_output: { ...EXECUTION, suposicoes: [{ texto: 'taxa zero', regraCritica: true }] }, files: EXECUTION_FILES },
  ]);
  await p.advance();
  assert.equal(p.item().pendingKind, 'question_execute');
  assert.deepEqual(p.item().pending?.criticalAssumptions, ['taxa zero']);
});

test('G3 reprova por comando com erro e por critério sem teste encontrado', async () => {
  const failing = pipeline([{ structured_output: PLAN }, exec(1), exec(2), exec(3)], {
    verify: [{ name: 'lint', command: 'echo "erro de lint na linha 3"; exit 2' }],
  });
  assert.deepEqual(await failing.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.deepEqual(
    failing.gates().slice(1),
    [1, 2, 3].map((attempt) => ({ attempt, gate: 'lint', passed: 0 })),
  );
  assert.match(failing.calls()[2]?.prompt ?? '', /falhou \(código 2\)\. Últimas linhas:\nerro de lint na linha 3/);

  const noTest = pipeline([
    { structured_output: PLAN },
    { structured_output: EXECUTION, files: { 'src/soma.js': 'x', 'test/soma.test.js': 'outro nome' } },
  ]);
  await noTest.advance();
  assert.deepEqual(noTest.gates().slice(1, 3), [
    { attempt: 1, gate: 'existe', passed: 1 },
    { attempt: 1, gate: 'criteria_tests', passed: 0 },
  ]);
  assert.deepEqual(
    criteriaWithoutTests(PLAN as PlanOutput, { ...EXECUTION, criterios: [] }, noTest.item().worktree!),
    ['C1: nenhum teste declarado'],
  );
});

const VERSION_3 = [{ name: 'versao', command: 'grep -q "versao 3" src/soma.js' }];

test('falha, falha, sucesso: 2ª retoma a sessão, 3ª escalona o modelo em sessão nova', async () => {
  const p = pipeline(
    [
      { structured_output: PLAN },
      exec(1, { session_id: 'exec-1' }),
      exec(2),
      exec(3, { session_id: 'exec-3' }),
      { structured_output: REVIEW_OK },
    ],
    { verify: VERSION_3, execute: 'haiku' },
  );
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const executions = p.calls().slice(1, 4);
  assert.deepEqual(
    executions.map((c) => [c.model, c.resume ?? null]),
    [['haiku', null], ['haiku', 'exec-1'], ['sonnet', null]],
  );
  assert.match(executions[1]?.prompt ?? '', /## Falha da tentativa anterior\n\nO comando de verificação `grep/);
  assert.match(executions[2]?.prompt ?? '', /## Tentativas anteriores\n\n- Tentativa 1: versao[\s\S]*- Tentativa 2: versao/);
  assert.equal(p.item().attempts, 3);
  assert.equal(p.branchLog().split('\n').length, 3);
});

async function exhausted() {
  const p = pipeline(
    [
      { structured_output: PLAN, session_id: 'plan-1' },
      exec(1, { session_id: 'exec-1' }),
      exec(2),
      exec(4),
      exec(3, { session_id: 'novo-ciclo' }),
      { structured_output: REVIEW_OK },
    ],
    { verify: VERSION_3, execute: 'haiku' },
  );
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'needs_human' });
  return p;
}

test('três falhas levam a needs_human com o resumo das tentativas', async () => {
  const p = await exhausted();
  assert.equal(p.item().pendingKind, 'attempts_exhausted');
  assert.match(p.item().statusReason ?? '', /três tentativas reprovadas:\n- Tentativa 1: versao[\s\S]*Tentativa 3: versao/);
  assert.match(p.item().pending?.summary ?? '', /Tentativa 3/);
  assert.deepEqual(
    p.gates().filter((g) => g.passed === 0).map((g) => g.attempt),
    [1, 2, 3],
  );
});

test('responder em attempts_exhausted abre novo ciclo escalonado em sessão nova', async () => {
  const p = await exhausted();
  assert.equal(respond(p.ctx.db, p.ctx.project, p.item(), 'Use a versão 3.'), 'executing');
  assert.equal(p.item().attempts, 0);
  assert.equal(p.item().escalatedCycle, true);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const call = p.calls()[4];
  assert.deepEqual([call?.model, call?.resume], ['sonnet', undefined]);
  assert.match(call?.prompt ?? '', /## Tentativas anteriores[\s\S]*## Resposta do humano\n\nUse a versão 3\./);
  assert.equal(p.item().attemptNo, 4);
});

test('responder --replanejar em attempts_exhausted volta ao planejamento em sessão nova', async () => {
  const p = await exhausted();
  assert.equal(respond(p.ctx.db, p.ctx.project, p.item(), 'Mude a abordagem.', { replan: true }), 'planning');
  assert.equal(p.item().escalatedCycle, false);
  assert.deepEqual(p.item().nextInput, {
    answer: 'Mude a abordagem.',
    previousPlan: true,
    attemptsSummary: p.item().nextInput?.attemptsSummary,
  });
});

test('responder em cada pending_kind leva ao estado e à sessão da tabela', async () => {
  const kinds = [
    ['question_plan', { structured_output: plan({ perguntas: [{ texto: 'Qual?', sugestao: '' }] }), session_id: 'plan-q' }],
    ['critical_approval', { structured_output: plan({ conceitosCriticos: ['Desconto'] }), session_id: 'plan-c' }],
  ] as const;
  for (const [kind, response] of kinds) {
    const p = pipeline([response, { structured_output: PLAN }, exec(1), { structured_output: REVIEW_OK }]);
    await p.advance();
    assert.equal(p.item().pendingKind, kind);
    assert.equal(respond(p.ctx.db, p.ctx.project, p.item(), 'resposta'), 'planning');
    assert.equal(p.item().pendingKind, null);
    assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
    assert.equal(p.calls()[1]?.resume, response.session_id);
  }

  const incomplete = pipeline([{ session_id: 'plan-i' }, {}, { structured_output: PLAN }]);
  await incomplete.advance();
  assert.equal(respond(incomplete.ctx.db, incomplete.ctx.project, incomplete.item(), 'r'), 'planning');
  assert.equal(incomplete.item().nextInput?.resumeSessionId, 'plan-i');

  const executeQuestion = pipeline([
    { structured_output: PLAN },
    { session_id: 'exec-q', structured_output: { ...EXECUTION, perguntas: [{ texto: '?', sugestao: '' }] }, files: EXECUTION_FILES },
  ]);
  await executeQuestion.advance();
  assert.equal(respond(executeQuestion.ctx.db, executeQuestion.ctx.project, executeQuestion.item(), 'r', { replan: true }), 'planning');
  assert.equal(executeQuestion.item().nextInput?.resumeSessionId, undefined);
  assert.equal(executeQuestion.item().nextInput?.previousPlan, true);

  assert.throws(() => respond(executeQuestion.ctx.db, executeQuestion.ctx.project, executeQuestion.item(), 'r'), /não está aguardando resposta/);
});

test('aprovar libera o item crítico para a execução com o plano atual', async () => {
  const p = pipeline([
    { structured_output: plan({ conceitosCriticos: ['Desconto'] }) },
    exec(1),
    { structured_output: REVIEW_OK },
  ]);
  await p.advance();
  approve(p.ctx.db, p.ctx.project, p.item());
  assert.equal(p.item().status, 'executing');
  assert.ok(p.item().approvedAt);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
});

test('revisão reprovada volta à execução com os problemas no prompt', async () => {
  const p = pipeline([
    { structured_output: PLAN },
    exec(1, { session_id: 'exec-1' }),
    { structured_output: { aprovado: false, criterios: [], problemas: [{ gravidade: 'bloqueante', descricao: 'soma ignora negativos' }] } },
    exec(2),
    { structured_output: REVIEW_OK },
  ]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const retry = p.calls()[3];
  assert.equal(retry?.resume, 'exec-1');
  assert.match(retry?.prompt ?? '', /bloqueante: soma ignora negativos/);
  assert.deepEqual(
    p.gates().filter((g) => g.gate === 'review').map((g) => g.passed),
    [0, 1],
  );
});
