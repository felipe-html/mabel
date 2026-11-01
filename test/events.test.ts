import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { eventCursor, pollEvents } from '../src/events.ts';
import { getItem, syncBacklog, transition } from '../src/items.ts';
import { isoLocal } from '../src/json.ts';
import { writeConfig } from '../src/project.ts';
import { type QueueEventCause, type QueueEventKind, listQueueEvents, recordQueueEvent } from '../src/run.ts';
import { CLI, EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

type Event = Record<string, unknown>;

/** `mabel eventos --json` aberto em segundo plano, com as linhas lidas até agora. */
function openStream(env: NodeJS.ProcessEnv, cwd: string) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'eventos', '--json'], {
    cwd,
    env: { ...env, MABEL_EVENTOS_INTERVALO_MS: '20' },
  });
  const lines: string[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    lines.push(...parts);
  });
  const events = () => lines.map((line) => JSON.parse(line) as Event);
  /** Espera um evento que satisfaça `match`, repetindo `poke` enquanto não chega. */
  const waitFor = async (match: (event: Event) => boolean, poke?: () => void) => {
    const deadline = Date.now() + 10_000;
    while (!events().some(match)) {
      assert.ok(Date.now() < deadline, `evento não chegou; recebidos: ${lines.join('\n')}`);
      poke?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const close = () =>
    new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
      child.kill('SIGTERM');
    });
  return { events, waitFor, close };
}

test('critério 2: um run produz etapa iniciou, ferramenta, gate e etapa terminou no mabel eventos', async () => {
  const ctx = setupProject('\n## A\nprimeiro\n');
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  useScenario(ctx.root, [{ structured_output: PLAN }, { structured_output: EXECUTION, files: EXECUTION_FILES }, { structured_output: REVIEW_OK }]);

  const stream = openStream(ctx.env(), ctx.root);
  // O fluxo só envia o que entra depois de aberto: uma leitura de saldo confirma que já leu o banco.
  const reset = '2026-10-24T18:00:00.000Z';
  await stream.waitFor(
    (event) => event.tipo === 'saldo',
    () =>
      ctx.db
        .prepare("INSERT INTO rate_limits (observed_at, window, utilization, resets_at) VALUES (?, 'five_hour', 0.22, ?)")
        .run(new Date().toISOString(), reset),
  );

  const run = ctx.cli('rodar');
  assert.equal(run.status, 0, run.stderr);
  await stream.waitFor((event) => event.tipo === 'fila' && event.estado === 'parada');
  assert.equal(await stream.close(), 0);

  const events = stream.events();
  assert.ok(events.every((event) => event.versao === 1));
  assert.deepEqual(
    events.find((event) => event.tipo === 'saldo'),
    { versao: 1, tipo: 'saldo', janela: '5h', uso: 0.22, reset: isoLocal(new Date(reset)) },
  );

  // Campos e ordem: a run da execução, com a ferramenta, os gates da verificação e a revisão.
  const projeto = ctx.project.name;
  const projeto_id = ctx.project.id;
  const flow = events.filter((event) => event.tipo !== 'saldo');
  const executing = flow.findIndex((event) => event.tipo === 'etapa' && event.etapa === 'executar');
  assert.deepEqual(flow[executing], { versao: 1, tipo: 'etapa', projeto, projeto_id, item: 1, etapa: 'executar', estado: 'iniciou' });
  assert.deepEqual(flow[executing + 1], { versao: 1, tipo: 'ferramenta', projeto, projeto_id, item: 1, nome: 'Write' });
  const [tool, gate, review, ended] = [
    flow.findIndex((event, i) => i > executing && event.tipo === 'ferramenta'),
    flow.findIndex((event) => event.tipo === 'gate' && event.gate === 'existe'),
    flow.findIndex((event) => event.tipo === 'revisao'),
    flow.findIndex((event) => event.tipo === 'etapa' && event.etapa === 'revisar' && event.estado === 'terminou'),
  ];
  assert.ok(executing < tool && tool < gate && gate < ended, JSON.stringify(flow, null, 1));
  assert.deepEqual(flow[gate], { versao: 1, tipo: 'gate', projeto, projeto_id, item: 1, gate: 'existe', resultado: 'verde' });
  assert.deepEqual(flow[review], { versao: 1, tipo: 'revisao', projeto, projeto_id, item: 1, resultado: 'aprovada' });
  assert.ok(ended < review);

  // A sequência completa, sem as ferramentas (uma por arquivo escrito).
  const summary = flow
    .filter((event) => event.tipo !== 'ferramenta')
    .map((event) =>
      event.tipo === 'etapa'
        ? `etapa ${event.etapa} ${event.estado}`
        : event.tipo === 'gate'
          ? `gate ${event.gate} ${event.resultado}`
          : event.tipo === 'item'
            ? `item ${event.de} → ${event.para}`
            : event.tipo === 'revisao'
              ? `revisao ${event.resultado}`
              : `${event.tipo} ${event.estado ?? event.pendencias}`,
    );
  assert.deepEqual(summary, [
    'fila rodando',
    'item backlog → ready',
    'item ready → planning',
    'etapa planejar iniciou',
    'etapa planejar terminou',
    'gate start verde',
    'item planning → planned',
    'item planned → executing',
    'etapa executar iniciou',
    'etapa executar terminou',
    'item executing → verifying',
    'gate scope verde',
    'gate existe verde',
    'gate criteria_tests verde',
    'gate proof verde',
    'item verifying → reviewing',
    'etapa revisar iniciou',
    'etapa revisar terminou',
    'revisao aprovada',
    'item reviewing → awaiting_merge',
    'fila parada',
  ]);
  assert.deepEqual(
    flow.find((event) => event.tipo === 'item'),
    { versao: 1, tipo: 'item', projeto, projeto_id, item: 1, de: 'backlog', para: 'ready', motivo: null },
  );
  assert.deepEqual(flow[0], { versao: 1, tipo: 'fila', projeto, projeto_id, estado: 'rodando' });
});

test('fila: espera por saldo, retomada na próxima etapa e fim pausado por saldo', () => {
  const ctx = setupProject('\n## A\nprimeiro\n');
  syncBacklog(ctx.db, ctx.project);
  const cursor = eventCursor(ctx.db);
  const at = (s: number) => new Date(Date.UTC(2026, 9, 24, 12, 0, s));
  const queue = (s: number, kind: QueueEventKind, cause: QueueEventCause, detail = '') =>
    recordQueueEvent(ctx.db, ctx.project.id, { at: at(s), kind, cause, detail });
  queue(1, 'start', 'queue');
  queue(2, 'wait', 'five_hour', 'saldo da janela de 5h em 20%');
  const item = getItem(ctx.db, ctx.project.id, 1)!;
  ctx.db
    .prepare(
      "INSERT INTO runs (id, kind, item_id, stage, prompt, cwd, status, started_at) VALUES ('r1', 'stage', ?, 'plan', '', '', 'running', ?)",
    )
    .run(item.id, at(3).toISOString());
  queue(4, 'answer', 'seven_day', 'continuar?');
  const states = (events: Record<string, unknown>[]) => events.map((e) => (e.tipo === 'fila' ? `fila ${e.estado}` : `${e.tipo} ${e.estado}`));
  assert.deepEqual(states(pollEvents(ctx.db, cursor)), ['fila rodando', 'fila pausada_por_saldo', 'fila rodando', 'etapa iniciou']);

  ctx.db.prepare("UPDATE runs SET status = 'failed', ended_at = ? WHERE id = 'r1'").run(at(5).toISOString());
  queue(6, 'pause', 'seven_day', 'saldo de 7 dias');
  queue(7, 'stop', 'queue', 'paused');
  const failed = pollEvents(ctx.db, cursor);
  assert.deepEqual(states(failed), ['etapa falhou', 'fila pausada_por_saldo']);
  assert.equal(failed[0]?.motivo, 'erro');

  assert.deepEqual(pollEvents(ctx.db, cursor), []);

  // Pausa que não é de saldo: a fila encerra `parada`.
  queue(8, 'start', 'queue');
  queue(9, 'pause', 'integration', 'integração em conflito');
  queue(10, 'stop', 'queue', 'paused');
  assert.deepEqual(states(pollEvents(ctx.db, cursor)), ['fila rodando', 'fila parada']);
  // O início e o fim não entram na auditoria do `mabel auditar`.
  assert.deepEqual(listQueueEvents(ctx.db, ctx.project.id).map((e) => e.kind), ['wait', 'answer', 'pause', 'pause']);

  // Motivo da falha: ctrl+c e limite de uso.
  const ended = ctx.db.prepare(
    "INSERT INTO runs (id, kind, item_id, stage, prompt, cwd, status, error, started_at, ended_at) VALUES (?, 'stage', ?, 'execute', '', '', ?, ?, ?, ?)",
  );
  ended.run('r2', item.id, 'interrupted', null, at(11).toISOString(), at(11).toISOString());
  ended.run('r3', item.id, 'failed', 'Claude AI usage limit reached', at(11).toISOString(), at(11).toISOString());
  const reasons = pollEvents(ctx.db, cursor).filter((e) => e.estado === 'falhou').map((e) => e.motivo);
  assert.deepEqual(reasons, ['interrompida', 'saldo']);
});

test('inbox: pendências do projeto quando um item para esperando o humano', () => {
  const ctx = setupProject('\n## A\nprimeiro\n');
  syncBacklog(ctx.db, ctx.project);
  const cursor = eventCursor(ctx.db);
  const item = getItem(ctx.db, ctx.project.id, 1)!;
  transition(ctx.db, ctx.project, item.id, 'planning', 'teste');
  ctx.db.prepare("UPDATE items SET pending_kind = 'question_plan' WHERE id = ?").run(item.id);
  transition(ctx.db, ctx.project, item.id, 'needs_human', 'perguntas');
  const events = pollEvents(ctx.db, cursor);
  assert.deepEqual(events.at(-1), { versao: 1, tipo: 'inbox', projeto: ctx.project.name, projeto_id: ctx.project.id, pendencias: 1 });
  assert.deepEqual(events.filter((e) => e.tipo === 'item').map((e) => e.para), ['planning', 'needs_human']);
});
