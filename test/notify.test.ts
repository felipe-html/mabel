import assert from 'node:assert/strict';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { syncBacklog } from '../src/items.ts';
import { notify } from '../src/notify.ts';
import { writeConfig } from '../src/project.ts';
import { type QueueOptions, startQueue } from '../src/run.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

/** `spawn` falso: registra a chamada e devolve um processo que não faz nada. */
function fakeSpawn() {
  const calls: { command: string; args: string[]; options: unknown; unref: boolean }[] = [];
  const fn = ((command: string, args: string[], options: unknown) => {
    const call = { command, args, options, unref: false };
    calls.push(call);
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {
      call.unref = true;
    };
    return child;
  }) as unknown as typeof spawn;
  return { fn, calls };
}

test('notify monta o osascript com o texto em argv, desacoplado', () => {
  const { fn, calls } = fakeSpawn();
  notify('Mabel · app', 'fila "vazia"; rm -rf /', { spawn: fn, platform: 'darwin', env: {} });
  assert.deepEqual(calls, [
    {
      command: 'osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        'Mabel · app',
        'fila "vazia"; rm -rf /',
      ],
      options: { detached: true, stdio: 'ignore' },
      unref: true,
    },
  ]);
});

test('notify desligado com MABEL_NOTIFICAR=0, fora do macOS, e falha ignorada', () => {
  const { fn, calls } = fakeSpawn();
  notify('t', 'm', { spawn: fn, platform: 'darwin', env: { MABEL_NOTIFICAR: '0' } });
  notify('t', 'm', { spawn: fn, platform: 'linux', env: {} });
  assert.equal(calls.length, 0);
  const failing = (() => {
    throw new Error('sem osascript');
  }) as unknown as typeof spawn;
  assert.doesNotThrow(() => notify('t', 'm', { spawn: failing, platform: 'darwin', env: {} }));
});

function queue(backlog: string, responses: unknown[]) {
  const ctx = setupProject(backlog);
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  syncBacklog(ctx.db, ctx.project);
  useScenario(ctx.root, responses);
  const notices: [string, string][] = [];
  const start = (options: Partial<QueueOptions> = {}) =>
    startQueue({
      db: ctx.db,
      home: ctx.home,
      project: ctx.project,
      notify: (title, message) => notices.push([title, message]),
      ...options,
    }).done;
  const lowBalance = (window: 'five_hour' | 'seven_day') => {
    const insert = ctx.db.prepare(
      'INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)',
    );
    const now = Date.now();
    insert.run(new Date(now).toISOString(), 'five_hour', window === 'five_hour' ? 0.8 : 0.1, new Date(now + 3600_000).toISOString(), 'allowed');
    insert.run(new Date(now).toISOString(), 'seven_day', window === 'seven_day' ? 0.85 : 0.1, new Date(now + 86400_000).toISOString(), 'allowed');
  };
  return { ...ctx, notices, start, lowBalance };
}

const QUESTION = {
  structured_output: { ...PLAN, perguntas: [{ texto: 'Qual banco?', sugestao: '', regraCritica: false }] },
};
const DONE = [{ structured_output: PLAN }, { structured_output: EXECUTION, files: EXECUTION_FILES }, { structured_output: REVIEW_OK }];

test('aviso no fim da fila, com o resumo sem custo e tempo', async () => {
  const q = queue('\n## A\nprimeiro\n\n## B\nsegundo\n', [...DONE.slice(0, 1), QUESTION, ...DONE.slice(1)]);
  assert.equal((await q.start()).end, 'empty');
  const name = q.project.name;
  assert.deepEqual(q.notices, [[`Mabel · ${name}`, 'fila vazia · awaiting_merge 1 · needs_human 1 · veja .mabel/run.md']]);

  const once = queue('\n## A\nprimeiro\n', DONE);
  await once.start({ limit: 1 });
  assert.deepEqual(once.notices.map(([, message]) => message), ['concluído · awaiting_merge 1 · veja .mabel/run.md']);
});

test('aviso na pausa, com o motivo', async () => {
  const q = queue('\n## A\nprimeiro\n', DONE);
  q.lowBalance('seven_day');
  assert.equal((await q.start({ interactive: false })).end, 'paused');
  assert.equal(q.notices.length, 1);
  assert.match(q.notices[0]?.[1] ?? '', /^saldo da janela de 7 dias em 15%; fila pausada/);
});

test('aviso antes de cada pergunta no terminal: saldo e inbox', async () => {
  const balance = queue('\n## A\nprimeiro\n', DONE);
  balance.lowBalance('five_hour');
  await balance.start({ interactive: true, confirm: async () => true });
  assert.deepEqual(balance.notices[0]?.[1], 'aguardando você: saldo de 5h em 20%; continuar mesmo assim?');

  const offer = queue('\n## A\nprimeiro\n', [QUESTION]);
  await offer.start({ interactive: true, confirm: async () => false, inbox: async () => {} });
  assert.deepEqual(offer.notices.map(([, message]) => message), [
    'aguardando você: 1 item aguarda você. Abrir a inbox agora?',
    'fila vazia · needs_human 1 · veja .mabel/run.md',
  ]);
});
