import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Interrupted } from '../src/ask.ts';
import { type InboxIO, runInbox } from '../src/inbox.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { type PipelineEnv, advanceItem, autonomousAnswers } from '../src/pipeline.ts';
import { readConfig, writeConfig } from '../src/project.ts';
import type { ExecuteOutput, PlanOutput, Question } from '../src/schemas/stages.ts';
import { readArtifact } from '../src/stages.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const q = (texto: string, sugestao: string, regraCritica = false): Question => ({ texto, sugestao, regraCritica });
const ROOMS = q('Quais cômodos aparecem?', 'Sala, Cozinha, Quarto, Banheiro');
const COLOR = q('Qual cor do botão?', 'Azul');
const EXEC = { structured_output: EXECUTION, files: EXECUTION_FILES };
const REVIEW = { structured_output: REVIEW_OK };

function project(responses: unknown[], autonomia?: 'sugestoes' | 'perguntar') {
  const ctx = setupProject('\n## Casa\nplanta da casa\n');
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  if (autonomia) ctx.project.config.autonomia = autonomia;
  writeConfig(ctx.root, ctx.project.config);
  syncBacklog(ctx.db, ctx.project);
  useScenario(ctx.root, responses);
  const lines: string[] = [];
  const env: PipelineEnv = { db: ctx.db, home: ctx.home, project: ctx.project, log: (line) => lines.push(line) };
  const item = () => getItem(ctx.db, ctx.project.id, 1)!;
  const advance = () => advanceItem(env, item().id);
  const gates = (gate: string) =>
    ctx.db
      .prepare('SELECT attempt, passed, detail FROM gate_results WHERE item_id = ? AND gate = ? ORDER BY id')
      .all(item().id, gate)
      .map((row) => ({ ...row }));
  return { ...ctx, lines, item, advance, gates };
}

test('autonomia: só com todas as perguntas não críticas e com sugestão', () => {
  const config = { autonomia: 'sugestoes' } as Parameters<typeof autonomousAnswers>[0];
  assert.equal(autonomousAnswers(config, []), undefined);
  assert.deepEqual(autonomousAnswers(config, [COLOR]), [
    { texto: 'P: Qual cor do botão? → R: Azul (autônomo)', regraCritica: false },
  ]);
  assert.equal(autonomousAnswers(config, [COLOR, q('Desconto?', '10%', true)]), undefined);
  assert.equal(autonomousAnswers(config, [COLOR, q('Qual moeda?', ' ')]), undefined);
  assert.equal(autonomousAnswers({ ...config, autonomia: 'perguntar' }, [COLOR]), undefined);
});

test('planejamento com perguntas não críticas e sugestão segue sem needs_human', async () => {
  const p = project([{ structured_output: { ...PLAN, perguntas: [ROOMS, COLOR] } }, EXEC, REVIEW]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const plan = readArtifact<PlanOutput>(p.home, p.item().id, 'plano.json')!;
  assert.deepEqual(plan.perguntas, []);
  assert.deepEqual(plan.suposicoes, [
    { texto: 'P: Quais cômodos aparecem? → R: Sala, Cozinha, Quarto, Banheiro (autônomo)', regraCritica: false },
    { texto: 'P: Qual cor do botão? → R: Azul (autônomo)', regraCritica: false },
  ]);
  const planMd = readFileSync(join(p.home, 'items', p.item().id, 'plano.md'), 'utf8');
  assert.match(planMd, /## Suposições\n- P: Quais cômodos aparecem\? → R: Sala/);
  assert.deepEqual(p.gates('autonomy'), [
    { attempt: 0, passed: 1, detail: 'Quais cômodos aparecem? → Sala, Cozinha, Quarto, Banheiro | Qual cor do botão? → Azul' },
  ]);
  assert.ok(p.lines.includes('#1 Casa: 2 perguntas respondidas pela sugestão (autônomo)'));
  assert.equal(p.gates('start')[0]?.passed, 1);
  // As decisões autônomas chegam ao humano nas notas do merge.
  assert.match(p.item().statusReason ?? '', /suposições: P: Quais cômodos aparecem\?/);
});

test('uma pergunta crítica ou sem sugestão para o item com todas as perguntas', async () => {
  for (const other of [q('Qual o desconto máximo?', '10%', true), q('Qual moeda?', '')]) {
    const p = project([{ structured_output: { ...PLAN, perguntas: [COLOR, other] } }]);
    assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'needs_human' });
    assert.equal(p.item().pendingKind, 'question_plan');
    assert.deepEqual(p.item().pending?.questions, [COLOR, other]);
    assert.deepEqual(p.gates('autonomy'), []);
  }
});

test('execução com perguntas não críticas e sugestão commita e segue; suposição crítica para', async () => {
  const p = project([
    { structured_output: PLAN },
    { structured_output: { ...EXECUTION, perguntas: [COLOR] }, files: EXECUTION_FILES },
    REVIEW,
  ]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'awaiting_merge' });
  const execution = readArtifact<ExecuteOutput>(p.home, p.item().id, 'execucao-1.json')!;
  assert.deepEqual(execution.perguntas, []);
  assert.deepEqual(execution.suposicoes, [{ texto: 'P: Qual cor do botão? → R: Azul (autônomo)', regraCritica: false }]);
  assert.deepEqual(p.gates('autonomy'), [{ attempt: 1, passed: 1, detail: 'Qual cor do botão? → Azul' }]);
  const log = spawnSync('git', ['log', '--format=%s', `main..${p.item().branch}`], { cwd: p.root, encoding: 'utf8' });
  assert.equal(log.stdout.trim(), 'mabel(#1): Casa — execução 1');

  const critical = project([
    { structured_output: PLAN },
    {
      structured_output: { ...EXECUTION, perguntas: [COLOR], suposicoes: [{ texto: 'taxa zero', regraCritica: true }] },
      files: EXECUTION_FILES,
    },
  ]);
  assert.deepEqual(await critical.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.equal(critical.item().pendingKind, 'question_execute');
  assert.deepEqual(critical.item().pending?.questions, [COLOR]);
  assert.deepEqual(critical.item().pending?.criticalAssumptions, ['taxa zero']);
  assert.deepEqual(critical.gates('autonomy'), []);
});

test('autonomia "perguntar" para o item como antes', async () => {
  const plan = project([{ structured_output: { ...PLAN, perguntas: [COLOR] } }], 'perguntar');
  assert.deepEqual(await plan.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.equal(plan.item().pendingKind, 'question_plan');

  const exec = project(
    [{ structured_output: PLAN }, { structured_output: { ...EXECUTION, perguntas: [COLOR] }, files: EXECUTION_FILES }],
    'perguntar',
  );
  assert.deepEqual(await exec.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.equal(exec.item().pendingKind, 'question_execute');
});

test('config sem autonomia vale "sugestoes"; init grava o campo', () => {
  const ctx = setupProject();
  const path = join(ctx.root, '.mabel', 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.autonomia, 'sugestoes');
  delete raw.autonomia;
  writeFileSync(path, JSON.stringify(raw));
  assert.equal(readConfig(ctx.root)?.autonomia, 'sugestoes');
  writeFileSync(path, JSON.stringify({ ...raw, autonomia: 'perguntar' }));
  assert.equal(readConfig(ctx.root)?.autonomia, 'perguntar');
});

test('resumo do run e mabel item listam as decisões autônomas', () => {
  const ctx = setupProject('\n## Casa\nplanta\n\n## Botão\nbotão\n');
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  useScenario(ctx.root, [
    { structured_output: { ...PLAN, perguntas: [ROOMS] } },
    { structured_output: PLAN },
    EXEC,
    REVIEW,
    { structured_output: { ...EXECUTION, perguntas: [COLOR] }, files: EXECUTION_FILES },
    REVIEW,
  ]);
  const run = ctx.cli('run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /■ fila vazia[^\n]*\n\nDecididas pela sugestão \(revise no merge\):\n {2}#1 Quais cômodos aparecem\? → Sala, Cozinha, Quarto, Banheiro\n {2}#2 Qual cor do botão\? → Azul\n/,
  );
  const item = ctx.cli('item', '2');
  assert.match(item.stdout, /Decididas pela sugestão\n {2}Qual cor do botão\? → Azul/);
  assert.doesNotMatch(ctx.cli('item', '1').stdout, /Qual cor/);
});

test('item crítico mostra na inbox as suposições autônomas junto dos critérios', async () => {
  const p = project([{ structured_output: { ...PLAN, perguntas: [COLOR], conceitosCriticos: ['Desconto'] } }]);
  assert.deepEqual(await p.advance(), { kind: 'stopped', status: 'needs_human' });
  assert.equal(p.item().pendingKind, 'critical_approval');
  const out: string[] = [];
  const io: InboxIO = {
    ask: async () => {
      throw new Interrupted();
    },
    write: (line) => out.push(line),
  };
  await runInbox(p.db, p.home, p.project, io);
  const criteria = out.indexOf('      critérios:');
  const assumptions = out.indexOf('      suposições:');
  assert.ok(criteria > 0 && assumptions > criteria, out.join('\n'));
  assert.equal(out[assumptions + 1], '        - P: Qual cor do botão? → R: Azul (autônomo)');
});
