import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatCost, formatDuration, formatTokens } from '../src/format.ts';
import { claudeArgs } from '../src/runner.ts';
import { parseLine, toolTarget } from '../src/stream.ts';

test('linha que não é objeto JSON vira invalid', () => {
  for (const line of ['isto não é json', '[1,2]', '42']) {
    assert.deepEqual(parseLine(line), { type: 'invalid', subtype: null, event: { kind: 'other' } });
  }
});

test('tipo desconhecido e campos ausentes não são erro', () => {
  assert.deepEqual(parseLine('{"type":"novo_evento","subtype":"x"}'), {
    type: 'novo_evento',
    subtype: 'x',
    event: { kind: 'other' },
  });
  assert.equal(parseLine('{"sem":"tipo"}').type, 'unknown');
  const result = parseLine('{"type":"result"}').event;
  assert.ok(result.kind === 'result');
  assert.equal(result.totals.isError, false);
  assert.equal(result.totals.costUsd, undefined);
  assert.deepEqual(parseLine('{"type":"assistant","message":{}}').event, { kind: 'other' });
});

test('rate_limit_event ignora janela sem utilização', () => {
  const line = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 10 }, seven_day: {} } },
  });
  assert.deepEqual(parseLine(line).event, {
    kind: 'rate_limits',
    status: undefined,
    readings: [{ window: 'five_hour', utilization: 0.5, resetsAt: new Date(10_000) }],
  });
});

test('toolTarget usa o primeiro campo conhecido do input', () => {
  assert.equal(toolTarget({ file_path: 'a.ts', pattern: 'x' }), 'a.ts');
  assert.equal(toolTarget({ command: 'npm test' }), 'npm test');
  assert.equal(toolTarget({ outro: 1 }), '');
  assert.equal(toolTarget(null), '');
});

test('claudeArgs põe o prompt depois de --, mesmo começando com hífen', () => {
  assert.deepEqual(claudeArgs({ kind: 'exec', prompt: '--help', cwd: '/' }), [
    '-p', '--output-format', 'stream-json', '--verbose', '--', '--help',
  ]);
});

test('formatação de duração, custo e tokens', () => {
  assert.equal(formatDuration(4590), '4,6s');
  assert.equal(formatDuration(81_000), '1m21s');
  assert.equal(formatDuration(3_720_000), '1h02m');
  assert.equal(formatCost(0.42), 'US$ 0,42');
  assert.equal(formatCost(0.00318), 'US$ 0,0032');
  assert.equal(formatTokens(233), '233');
  assert.equal(formatTokens(18_300), '18,3k');
  assert.equal(formatTokens(2_100_000), '2,1M');
});
