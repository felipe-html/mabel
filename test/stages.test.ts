import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getItem, syncBacklog } from '../src/items.ts';
import { planSchema } from '../src/schemas/stages.ts';
import { validate } from '../src/schemas/validate.ts';
import {
  EXECUTE_DISALLOWED,
  type StageContext,
  itemDir,
  runExecute,
  runPlan,
  runReview,
  stageRequest,
  systemPrompt,
} from '../src/stages.ts';
import { prepareWorktree } from '../src/worktree.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

function stageContext(): StageContext & { ctx: ReturnType<typeof setupProject> } {
  const ctx = setupProject('\n## Soma\nQuero uma função soma.\n');
  syncBacklog(ctx.db, ctx.project);
  const item = getItem(ctx.db, ctx.project.id, 1)!;
  const { path } = prepareWorktree(ctx.db, ctx.home, ctx.project, item);
  return { ctx, home: ctx.home, project: ctx.project, item, worktree: path };
}

test('cada etapa monta ferramentas, modo, modelo, limites, esquema e sessão', () => {
  const stage = stageContext();
  const plan = stageRequest(stage, 'plan', 'p');
  assert.deepEqual(
    { ...plan, appendSystemPrompt: undefined, jsonSchema: undefined, settings: undefined },
    {
      kind: 'stage', stage: 'plan', itemId: stage.item.id, prompt: 'p', cwd: stage.worktree, model: 'opus',
      maxTurns: 40, maxBudgetUsd: 3, permissionMode: 'dontAsk', tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep'], appendSystemPrompt: undefined, jsonSchema: undefined, settings: undefined,
    },
  );
  assert.ok(plan.appendSystemPrompt?.startsWith(systemPrompt('plan').trimEnd()));
  assert.match(plan.appendSystemPrompt ?? '', /## Regras críticas do projeto\n\nNenhuma\./);
  assert.equal(plan.jsonSchema, planSchema);
  assert.equal(plan.disallowedTools, undefined);

  const execute = stageRequest(stage, 'execute', 'e', { model: 'opus', resumeSessionId: 's-1' });
  assert.deepEqual(execute.tools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  assert.deepEqual(execute.allowedTools, ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash']);
  assert.equal(execute.disallowedTools, EXECUTE_DISALLOWED);
  assert.deepEqual([execute.model, execute.maxTurns, execute.maxBudgetUsd, execute.resumeSessionId], ['opus', 120, 8, 's-1']);

  const review = stageRequest(stage, 'review', 'r');
  assert.deepEqual(review.tools, ['Read', 'Glob', 'Grep', 'Bash']);
  assert.deepEqual(review.allowedTools, ['Read', 'Glob', 'Grep', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)']);
  assert.equal(review.model, 'opus');
  assert.equal(review.resumeSessionId, undefined);
});

test('prompts de sistema têm o conteúdo mínimo obrigatório', () => {
  assert.match(systemPrompt('plan'), /menor plano/);
  assert.match(systemPrompt('plan'), /escopo/);
  assert.match(systemPrompt('plan'), /Pergunte só o que \*\*bloqueia/);
  assert.match(systemPrompt('plan'), /No máximo \*\*3 perguntas/);
  assert.match(systemPrompt('execute'), /só o plano/);
  assert.match(systemPrompt('execute'), /testes de caracterização/);
  assert.match(systemPrompt('execute'), /Não use git/);
  assert.match(systemPrompt('review'), /não\*\* atende/);
  assert.match(systemPrompt('review'), /Não edite nada/);
});

test('saída estruturada ausente ou fora do esquema é falha da etapa, não exceção', async () => {
  const stage = stageContext();
  useScenario(stage.ctx.root, [{}, { structured_output: { resumo: 1 } }, { is_error: true, subtype: 'error_max_turns' }]);
  const missing = await runPlan(stage.ctx.db, stage, {});
  assert.equal(missing.output, undefined);
  assert.equal(missing.invalid, 'saída estruturada ausente');
  const wrong = await runPlan(stage.ctx.db, stage, {});
  assert.match(wrong.invalid ?? '', /^saída fora do esquema: \$\.criterios: obrigatório;.*\$\.resumo: esperado string/);
  const failed = await runPlan(stage.ctx.db, stage, {});
  assert.equal(failed.outcome.status, 'failed');
  assert.equal(failed.outcome.error, 'error_max_turns');
  assert.equal(existsSync(join(itemDir(stage.home, stage.item.id), 'plano.json')), false);
});

test('artefatos gravados por etapa e tentativa; execução altera o worktree', async () => {
  const stage = stageContext();
  const { log } = useScenario(stage.ctx.root, [
    { structured_output: PLAN },
    { structured_output: EXECUTION, files: EXECUTION_FILES },
    { structured_output: REVIEW_OK },
  ]);
  const plan = await runPlan(stage.ctx.db, stage, {});
  assert.deepEqual(plan.output, PLAN);
  const execution = await runExecute(stage.ctx.db, stage, { plan: PLAN as never, attempt: 1 });
  assert.deepEqual(execution.output, EXECUTION);
  const review = await runReview(stage.ctx.db, stage, { plan: PLAN as never, execution: EXECUTION, attempt: 1 });
  assert.deepEqual(review.output, REVIEW_OK);

  const dir = itemDir(stage.home, stage.item.id);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'plano.json'), 'utf8')), PLAN);
  assert.match(readFileSync(join(dir, 'plano.md'), 'utf8'), /^# Plano do item #1: Soma\n[\s\S]*\*\*C1\*\* \(teste, novo\): soma\(2, 3\) devolve 5/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'execucao-1.json'), 'utf8')), EXECUTION);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'revisao-1.json'), 'utf8')), REVIEW_OK);
  assert.equal(readFileSync(join(stage.worktree, 'src/soma.js'), 'utf8'), EXECUTION_FILES['src/soma.js']);

  const calls = log();
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.cwd === stage.worktree || call.cwd.endsWith(stage.worktree)));
  const runs = stage.ctx.db.prepare('SELECT stage, item_id, status FROM runs ORDER BY started_at').all();
  assert.deepEqual(runs.map((row) => ({ ...row })), [
    { stage: 'plan', item_id: stage.item.id, status: 'succeeded' },
    { stage: 'execute', item_id: stage.item.id, status: 'succeeded' },
    { stage: 'review', item_id: stage.item.id, status: 'succeeded' },
  ]);
});

test('validador: tipos, obrigatórios, enum e campos não previstos', () => {
  assert.deepEqual(validate(planSchema, PLAN), []);
  const errors = validate(planSchema, {
    ...PLAN,
    criterios: [{ id: 'C1', texto: 'x', verificacao: 'talvez' }],
    extra: true,
    perguntas: undefined,
  });
  assert.deepEqual(errors, [
    '$.criterios[0].comportamento: obrigatório',
    '$.criterios[0].verificacao: valor "talvez" fora de ["teste","humano"]',
    '$.perguntas: esperado array, veio undefined',
    '$.extra: campo não previsto',
  ]);
});
