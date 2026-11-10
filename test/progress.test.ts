import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type StepEvent, formatDuration, stepLine, timed, totalLine } from '../src/progress.ts';
import { screenStyle } from '../src/style.ts';

const plain = screenStyle(false);

test('progresso: duração em ms, segundos com vírgula, minutos e horas', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(850), '850 ms');
  assert.equal(formatDuration(999), '999 ms');
  assert.equal(formatDuration(1000), '1,0 s');
  assert.equal(formatDuration(12_449), '12,4 s');
  assert.equal(formatDuration(59_999), '59,9 s');
  assert.equal(formatDuration(60_000), '1 min 00 s');
  assert.equal(formatDuration(125_000), '2 min 05 s');
  assert.equal(formatDuration(3_725_000), '1 h 02 min');
});

test('progresso: linha da etapa com a marca, o nome cortado na largura e a duração', () => {
  assert.equal(stepLine('ok', 'preparar a cópia da base', 1234, plain), '  ✓ preparar a cópia da base  1,2 s');
  assert.equal(stepLine('failed', 'verificar build · npm run build', 125_000, plain), '  ✗ verificar build · npm run build  2 min 05 s');
  assert.equal(stepLine('running', 'juntar a unidade', 850, plain, 80, 0), '  ⠋ juntar a unidade  850 ms');
  assert.equal(stepLine('running', 'juntar a unidade', 850, plain, 80, 1), '  ⠙ juntar a unidade  850 ms');
  const narrow = stepLine('ok', 'verificar build · npm run build -- --profile', 850, plain, 30);
  assert.equal(narrow, '  ✓ verificar build …  850 ms');
  assert.ok([...narrow].length < 30);
  assert.equal(totalLine(125_000, plain), '  Total  2 min 05 s');
});

test('progresso: timed avisa começo e fim; falha pelo resultado ou por exceção', () => {
  const events: StepEvent[] = [];
  const onStep = (event: StepEvent) => events.push(event);
  assert.equal(timed(onStep, 'a', () => 1), 1);
  assert.equal(timed(onStep, 'b', () => 2, (n) => n > 2), 2);
  assert.throws(() => timed(onStep, 'c', () => {
    throw new Error('x');
  }));
  assert.deepEqual(
    events.map((event) => (event.kind === 'start' ? `> ${event.label}` : `${event.ok ? '✓' : '✗'} ${event.label}`)),
    ['> a', '✓ a', '> b', '✗ b', '> c', '✗ c'],
  );
  assert.ok(events.every((event) => event.kind === 'start' || event.ms >= 0));
  assert.equal(timed(undefined, 'd', () => 3), 3, 'sem onStep, só roda');
});
