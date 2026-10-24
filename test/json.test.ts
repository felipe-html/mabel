import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getItem } from '../src/items.ts';
import { isoLocal } from '../src/json.ts';
import { lockPath } from '../src/lock.ts';
import { recordQueueEvent } from '../src/run.ts';
import { CLI, setupProject } from './helpers.ts';

const BACKLOG = '\n## Casa\ncômodos\n\n## Moeda\nreal\n';

function jsonProject() {
  const ctx = setupProject(BACKLOG);
  assert.equal(ctx.cli('status').status, 0);
  const item = (number: number) => getItem(ctx.db, ctx.project.id, number)!;
  /** Roda o comando com `--json` e devolve a linha parseada. */
  const json = (...args: string[]) => {
    const result = ctx.cli(...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1, 'uma linha só');
    return JSON.parse(result.stdout) as Record<string, any>;
  };
  const holdLock = () => {
    mkdirSync(join(ctx.home, 'locks'), { recursive: true });
    writeFileSync(lockPath(ctx.home, ctx.project.id), `${process.pid}\n`);
  };
  return { ...ctx, item, json, holdLock };
}

function reading(db: ReturnType<typeof setupProject>['db'], window: string, utilization: number, resetsAt: Date, runId: string | null = null, observedAt = new Date()) {
  db.prepare('INSERT INTO rate_limits (run_id, observed_at, window, utilization, resets_at) VALUES (?, ?, ?, ?, ?)').run(
    runId,
    observedAt.toISOString(),
    window,
    utilization,
    resetsAt.toISOString(),
  );
}

function insertRun(db: ReturnType<typeof setupProject>['db'], itemId: string, stage: string, model: string, cost: number, status = 'succeeded'): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO runs (id, kind, item_id, stage, prompt, cwd, model_requested, model, status, started_at, cost_usd,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, pid)
     VALUES (?, 'stage', ?, ?, 'p', '/tmp', ?, ?, ?, ?, ?, 100, 50, 1000, 10, ?)`,
  ).run(id, itemId, stage, model, model, status, new Date().toISOString(), cost, process.pid);
  return id;
}

test('isoLocal escreve o horário local com o deslocamento', () => {
  const date = new Date('2026-10-23T19:40:00Z');
  const text = isoLocal(date);
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(text).getTime(), date.getTime());
});

test('projetos --json: campos, versão e estados da fila', () => {
  const p = jsonProject();
  let out = p.json('projetos');
  assert.equal(out.versao, 1);
  assert.equal(out.projetos.length, 1);
  const project = out.projetos[0];
  assert.deepEqual(Object.keys(project), [
    'id',
    'nome',
    'raiz',
    'fila',
    'pausa',
    'em_andamento',
    'inbox',
    'itens',
    'runs',
    'custo_usd',
    'ultima_atividade',
  ]);
  assert.equal(project.id, p.project.id);
  assert.equal(project.fila, 'parada');
  assert.equal(project.pausa, null);
  assert.equal(project.em_andamento, null);
  assert.equal(project.inbox, 0);
  assert.deepEqual(project.itens, { ready: 2 });

  // Item parado esperando o humano.
  p.db.prepare("UPDATE items SET status = 'needs_human', pending_kind = 'question_plan', pending = '{}' WHERE id = ?").run(p.item(1).id);
  out = p.json('projetos');
  assert.equal(out.projetos[0].fila, 'aguardando_humano');
  assert.equal(out.projetos[0].inbox, 1);

  // Trava de um processo vivo, com uma run aberta.
  p.holdLock();
  p.db.prepare("UPDATE items SET status = 'executing' WHERE id = ?").run(p.item(2).id);
  const runId = insertRun(p.db, p.item(2).id, 'execute', 'sonnet', 0, 'running');
  out = p.json('projetos');
  assert.equal(out.projetos[0].fila, 'rodando');
  assert.deepEqual(out.projetos[0].em_andamento, {
    item: 2,
    titulo: 'Moeda',
    etapa: 'executar',
    papel: 'executor',
    modelo: 'sonnet',
    run: runId,
    inicio: out.projetos[0].em_andamento.inicio,
  });

  // Espera por saldo gravada pelo `run` que segura a trava.
  recordQueueEvent(p.db, p.project.id, {
    at: new Date(),
    kind: 'wait',
    cause: 'pace',
    detail: 'ritmo de 7 dias acima do esperado',
    until: new Date(Date.now() + 3600_000),
  });
  out = p.json('projetos');
  assert.equal(out.projetos[0].fila, 'pausada_por_saldo');
  assert.equal(out.projetos[0].pausa.tipo, 'espera');
  assert.equal(out.projetos[0].pausa.causa, 'ritmo_7d');
  assert.deepEqual(Object.keys(out.projetos[0].pausa), ['tipo', 'causa', 'motivo', 'desde', 'ate']);
});

test('pausa por saldo vale até a fila voltar a rodar', () => {
  const p = jsonProject();
  recordQueueEvent(p.db, p.project.id, { at: new Date(Date.now() - 1000), kind: 'pause', cause: 'seven_day', detail: 'saldo de 7 dias abaixo do piso' });
  assert.equal(p.json('projetos').projetos[0].fila, 'pausada_por_saldo');
  const saldo = p.json('saldo');
  assert.equal(saldo.pausa.projeto, p.project.name);
  assert.equal(saldo.pausa.causa, 'saldo_7d');

  insertRun(p.db, p.item(1).id, 'plan', 'sonnet', 0.1);
  assert.equal(p.json('projetos').projetos[0].fila, 'parada');
  assert.equal(p.json('saldo').pausa, null);
});

test('saldo --json: as duas janelas, com ritmo só na de 7 dias', () => {
  const p = jsonProject();
  let out = p.json('saldo');
  assert.deepEqual(out, { versao: 1, janelas: { '5h': null, '7d': null }, pausa: null });

  const now = Date.now();
  reading(p.db, 'five_hour', 0.22, new Date(now + 2 * 3600_000), null, new Date(now - 60_000));
  reading(p.db, 'seven_day', 0.4, new Date(now + 3 * 86_400_000), null, new Date(now - 60_000));
  out = p.json('saldo');
  assert.deepEqual(Object.keys(out), ['versao', 'janelas', 'pausa']);
  assert.deepEqual(Object.keys(out.janelas['5h']), ['uso', 'reset', 'idade_leitura_s', 'vencida']);
  assert.deepEqual(Object.keys(out.janelas['7d']), ['uso', 'reset', 'idade_leitura_s', 'vencida', 'ritmo']);
  assert.equal(out.janelas['5h'].uso, 0.22);
  assert.equal(out.janelas['5h'].vencida, false);
  assert.ok(out.janelas['5h'].idade_leitura_s >= 60);
  assert.equal(new Date(out.janelas['5h'].reset).getTime(), Math.floor((now + 2 * 3600_000) / 1000) * 1000);
  // 4 de 7 dias decorridos: esperado ~0,57, uso 0,4 → com folga.
  assert.equal(out.janelas['7d'].ritmo.estado, 'com_folga');
  assert.ok(Math.abs(out.janelas['7d'].ritmo.esperado - 4 / 7) < 0.01);

  // Sem --json, o comando mostra as janelas como o status.
  const text = p.cli('saldo');
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /5h .*78% livre/);
});

test('status --json: fila por estado, etapas em andamento e saldo', () => {
  const p = jsonProject();
  p.db.prepare("UPDATE items SET status = 'planned' WHERE id = ?").run(p.item(2).id);
  const out = p.json('status');
  assert.deepEqual(Object.keys(out), ['versao', 'projeto', 'fila', 'pausa', 'por_estado', 'itens', 'etapas', 'saldo', 'avisos']);
  assert.deepEqual(out.projeto, { id: p.project.id, nome: p.project.name, raiz: p.project.root });
  assert.equal(out.fila, 'parada');
  assert.deepEqual(out.por_estado, { ready: 1, planned: 1 });
  assert.deepEqual(Object.keys(out.itens[0]), [
    'numero',
    'titulo',
    'estado',
    'motivo',
    'tentativas',
    'custo_usd',
    'dependencias_pendentes',
    'integrado',
  ]);
  assert.deepEqual(out.etapas, []);
  assert.deepEqual(Object.keys(out.saldo), ['janelas', 'pausa']);
  assert.deepEqual(out.avisos, []);
});

test('status --json fora de um projeto: só o saldo', () => {
  const p = jsonProject();
  const outside = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'status', '--json'], {
    cwd: p.home,
    encoding: 'utf8',
    env: p.env(),
  });
  assert.equal(outside.status, 0, outside.stderr);
  const out = JSON.parse(outside.stdout);
  assert.equal(out.projeto, null);
  assert.deepEqual(Object.keys(out), ['versao', 'projeto', 'saldo']);
});

test('inbox --json: perguntas, sugestões e opções de cada pendência', () => {
  const p = jsonProject();
  const pending = {
    questions: [{ texto: 'Qual moeda?', sugestao: 'Real', regraCritica: false }, 'pergunta antiga'],
  };
  p.db
    .prepare("UPDATE items SET status = 'needs_human', pending_kind = 'question_plan', pending = ?, status_reason = 'perguntas' WHERE id = ?")
    .run(JSON.stringify(pending), p.item(1).id);
  p.db
    .prepare("UPDATE items SET status = 'needs_human', pending_kind = 'critical_approval', pending = ? WHERE id = ?")
    .run(JSON.stringify({ reason: 'regra crítica: Desconto' }), p.item(2).id);

  const out = p.json('inbox');
  assert.deepEqual(Object.keys(out), ['versao', 'projeto', 'resposta_decidir', 'pendencias']);
  assert.equal(out.pendencias.length, 2);
  const [questions, critical] = out.pendencias;
  assert.deepEqual(questions, {
    item: 1,
    titulo: 'Casa',
    tipo: 'responder',
    pendencia: 'perguntas_planejamento',
    motivo: 'perguntas',
    perguntas: [
      { texto: 'Qual moeda?', sugestao: 'Real', regra_critica: false },
      { texto: 'pergunta antiga', sugestao: '', regra_critica: false },
    ],
    suposicoes_criticas: [],
    arquivos: [],
    opcoes: ['responder', 'decidir', 'cancelar'],
  });
  assert.equal(critical.tipo, 'aprovar');
  assert.equal(critical.motivo, 'regra crítica: Desconto');
  assert.deepEqual(critical.opcoes, ['aprovar', 'responder', 'cancelar']);
});

test('projeto <nome> --json: custo e uso das janelas por etapa, modelo e item', () => {
  const p = jsonProject();
  const reset = new Date(Date.now() + 3600_000);
  const plan = insertRun(p.db, p.item(1).id, 'plan', 'opus', 0.5);
  reading(p.db, 'five_hour', 0.1, reset, plan);
  reading(p.db, 'five_hour', 0.15, reset, plan);
  const execute = insertRun(p.db, p.item(1).id, 'execute', 'sonnet', 1.5);
  reading(p.db, 'five_hour', 0.15, reset, execute);
  reading(p.db, 'five_hour', 0.35, reset, execute);
  reading(p.db, 'seven_day', 0.3, reset, execute);
  reading(p.db, 'seven_day', 0.32, reset, execute);

  const out = p.json('projeto', p.project.name);
  assert.deepEqual(Object.keys(out), ['versao', 'projeto', 'total', 'por_etapa', 'por_modelo', 'por_item']);
  assert.deepEqual(Object.keys(out.total), ['runs', 'custo_usd', 'tokens', 'uso']);
  assert.equal(out.total.runs, 2);
  assert.equal(out.total.custo_usd, 2);
  assert.deepEqual(out.total.tokens, { entrada: 200, saida: 100, cache_leitura: 2000, cache_criacao: 20 });
  assert.ok(Math.abs(out.total.uso['5h'] - 0.25) < 1e-9);
  assert.ok(Math.abs(out.total.uso['7d'] - 0.02) < 1e-9);
  assert.deepEqual(
    out.por_etapa.map((s: any) => [s.etapa, s.runs, s.custo_usd]),
    [
      ['executar', 1, 1.5],
      ['planejar', 1, 0.5],
    ],
  );
  assert.deepEqual(out.por_modelo.map((m: any) => m.modelo), ['sonnet', 'opus']);
  assert.deepEqual(
    out.por_item.map((i: any) => [i.item, i.runs, i.custo_usd]),
    [
      [1, 2, 2],
      [2, 0, 0],
    ],
  );

  const missing = p.cli('projeto', '--json');
  assert.equal(missing.status, 1);
});
