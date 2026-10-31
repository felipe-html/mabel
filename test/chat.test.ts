import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interrupted } from '../src/ask.ts';
import { chat, type ChatIO } from '../src/exec.ts';
import type { RunOutcome, RunRequest } from '../src/runner.ts';

process.env.NO_COLOR = '1';

function outcome(fields: Partial<RunOutcome> = {}, cost = 0.1): RunOutcome {
  return {
    runId: 'run',
    status: 'succeeded',
    exitCode: 0,
    error: null,
    model: 'claude-haiku',
    sessionId: 'sess-1',
    rateLimitStatus: null,
    totals: { isError: false, costUsd: cost, inputTokens: 10, outputTokens: 5 },
    durationMs: 1000,
    transcriptPath: null,
    ...fields,
  };
}

/** IO roteirizada: cada leitura consome um item; `Interrupted` simula o Ctrl+C. */
function scripted(inputs: (string | null | Interrupted)[], results: RunOutcome[] = []) {
  const requests: RunRequest[] = [];
  const output: string[] = [];
  const io: ChatIO = {
    turn: async (request) => {
      requests.push(request);
      return results.shift() ?? outcome();
    },
    read: async () => {
      const next = inputs.shift();
      if (next === undefined) throw new Error('leitura além do roteiro');
      if (next instanceof Interrupted) throw next;
      return next;
    },
    write: (text) => output.push(text),
  };
  return { io, requests, output: () => output.join('\n') };
}

const base: RunRequest = { kind: 'exec', prompt: 'explique o runner', cwd: '/tmp/projeto', model: 'haiku' };

test('cada mensagem retoma a sessão até o usuário sair do campo com esc', async () => {
  const { io, requests, output } = scripted(['e o stream?', '', 'obrigado', null]);
  const outcomes = await chat(base, outcome(), io);

  assert.equal(outcomes.length, 3);
  assert.deepEqual(
    requests.map((r) => [r.prompt, r.resumeSessionId, r.model]),
    [
      ['e o stream?', 'sess-1', 'haiku'],
      ['obrigado', 'sess-1', 'haiku'],
    ],
  );
  assert.match(output(), /Continue a conversa; esc encerra\./);
  assert.match(output(), /■ sessão encerrada · 3 mensagens · 3,0s · US\$ 0,30/);
});

test('esc encerra; Ctrl+C na pergunta só lembra como encerrar', async () => {
  const { io, requests, output } = scripted([new Interrupted(), null]);
  await chat(base, outcome(), io);
  assert.equal(requests.length, 0);
  assert.equal(output().match(/esc encerra/g)?.length, 2);
  assert.match(output(), /1 mensagem ·/);
});

test('resposta interrompida mantém a sessão; sem sessão, a próxima mensagem abre uma nova', async () => {
  const { io, requests, output } = scripted(
    ['primeira', 'segunda', 'terceira', null],
    [outcome({ status: 'interrupted', sessionId: null }), outcome({ sessionId: 'sess-2' }), outcome({ sessionId: 'sess-2' })],
  );
  await chat(base, outcome({ status: 'interrupted', sessionId: null, totals: null }), io);

  assert.deepEqual(
    requests.map((r) => r.resumeSessionId),
    [undefined, undefined, 'sess-2'],
  );
  assert.equal(output().match(/a próxima mensagem abre uma nova/g)?.length, 2);
  assert.match(output(), /■ interrompida/);
});

test('o orçamento vale para a sessão: cada mensagem recebe o que resta e o fim encerra', async () => {
  const { io, requests, output } = scripted(['mais', 'de novo'], [outcome({}, 0.6)]);
  await chat({ ...base, maxBudgetUsd: 1 }, outcome({}, 0.5), io);

  assert.equal(requests.length, 1);
  assert.ok(Math.abs((requests[0]?.maxBudgetUsd ?? 0) - 0.5) < 1e-9);
  assert.match(output(), /Orçamento da sessão esgotado \(US\$ 1,00\)/);
});
