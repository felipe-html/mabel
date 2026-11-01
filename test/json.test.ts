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
  assert.equal(ctx.cli('conferir').status, 0);
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
  let out = p.json('listar');
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
  out = p.json('listar');
  assert.equal(out.projetos[0].fila, 'aguardando_humano');
  assert.equal(out.projetos[0].inbox, 1);

  // Trava de um processo vivo, com uma run aberta.
  p.holdLock();
  p.db.prepare("UPDATE items SET status = 'executing' WHERE id = ?").run(p.item(2).id);
  const runId = insertRun(p.db, p.item(2).id, 'execute', 'sonnet', 0, 'running');
  out = p.json('listar');
  assert.equal(out.projetos[0].fila, 'rodando');
  assert.deepEqual(out.projetos[0].em_andamento, {
    item: 2,
    titulo: 'Moeda',
    etapa: 'executar',
    papel: 'executor',
    modelo: 'sonnet',
    run: runId,
    inicio: out.projetos[0].em_andamento.inicio,
    tentativa: 1,
    reprovacoes: 0,
    ultima_revisao: null,
  });

  // Espera por saldo gravada pelo `run` que segura a trava.
  recordQueueEvent(p.db, p.project.id, {
    at: new Date(),
    kind: 'wait',
    cause: 'pace',
    detail: 'ritmo de 7 dias acima do esperado',
    until: new Date(Date.now() + 3600_000),
  });
  out = p.json('listar');
  assert.equal(out.projetos[0].fila, 'pausada_por_saldo');
  assert.equal(out.projetos[0].pausa.tipo, 'espera');
  assert.equal(out.projetos[0].pausa.causa, 'ritmo_7d');
  assert.deepEqual(Object.keys(out.projetos[0].pausa), ['tipo', 'causa', 'motivo', 'desde', 'ate']);
});

test('pausa por saldo vale até a fila voltar a rodar', () => {
  const p = jsonProject();
  recordQueueEvent(p.db, p.project.id, { at: new Date(Date.now() - 1000), kind: 'pause', cause: 'seven_day', detail: 'saldo de 7 dias abaixo do piso' });
  assert.equal(p.json('listar').projetos[0].fila, 'pausada_por_saldo');
  const saldo = p.json('saldo');
  assert.equal(saldo.pausa.projeto, p.project.name);
  assert.equal(saldo.pausa.causa, 'saldo_7d');

  insertRun(p.db, p.item(1).id, 'plan', 'sonnet', 0.1);
  assert.equal(p.json('listar').projetos[0].fila, 'parada');
  assert.equal(p.json('saldo').pausa, null);
});

test('um run novo encerra a pausa por saldo, mesmo sem etapa', () => {
  const p = jsonProject();
  recordQueueEvent(p.db, p.project.id, { at: new Date(Date.now() - 2000), kind: 'pause', cause: 'five_hour', detail: 'saldo de 5h abaixo do piso' });
  recordQueueEvent(p.db, p.project.id, { at: new Date(Date.now() - 1000), kind: 'start', cause: 'queue', detail: '' });
  recordQueueEvent(p.db, p.project.id, { at: new Date(), kind: 'stop', cause: 'queue', detail: 'empty' });
  assert.equal(p.json('listar').projetos[0].fila, 'parada');
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
  const out = p.json('conferir');
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
  const outside = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'conferir', '--json'], {
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

  const out = p.json('decidir');
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

  const out = p.json('auditar', p.project.name);
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

  const missing = p.cli('auditar', '--json');
  assert.equal(missing.status, 1);
});

test('projetos --json: tentativa e revisões do item em andamento desde o plano aprovado', () => {
  const p = jsonProject();
  p.holdLock();
  const item = p.item(2);
  const gate = (attempt: number, name: string, passed: boolean) =>
    p.db
      .prepare('INSERT INTO gate_results (item_id, attempt, gate, passed, at) VALUES (?, ?, ?, ?, ?)')
      .run(item.id, attempt, name, passed ? 1 : 0, new Date().toISOString());
  // Reprovação de um plano anterior não conta.
  gate(1, 'review', false);
  gate(0, 'start', true);
  gate(2, 'review', false);
  p.db.prepare("UPDATE items SET status = 'executing', attempts = 1 WHERE id = ?").run(item.id);
  insertRun(p.db, item.id, 'execute', 'sonnet', 0, 'running');

  const running = p.json('listar').projetos[0].em_andamento;
  assert.equal(running.tentativa, 2);
  assert.equal(running.reprovacoes, 1);
  assert.equal(running.ultima_revisao.resultado, 'reprovada');
  assert.match(running.ultima_revisao.em, /^\d{4}-\d{2}-\d{2}T/);
});

test('erros com --json: uma linha no stderr com código e mensagem, saída diferente de 0', () => {
  const p = jsonProject();
  const error = (...args: string[]) => {
    const result = p.cli(...args, '--json');
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length, 1, result.stderr);
    const out = JSON.parse(lines[0] as string);
    assert.deepEqual(Object.keys(out), ['versao', 'erro']);
    assert.equal(out.versao, 1);
    assert.deepEqual(Object.keys(out.erro), ['codigo', 'mensagem']);
    return out.erro as { codigo: string; mensagem: string };
  };
  assert.equal(error('responder').codigo, 'argumento_faltando');
  assert.equal(error('aprovar', '99').codigo, 'nao_encontrado');
  assert.equal(error('aprovar', '1').codigo, 'estado_invalido');
  assert.equal(error('auditar', 'nenhum').codigo, 'nao_encontrado');
  assert.equal(error('auditar', 'remover', p.project.name).codigo, 'argumento_faltando');
  assert.equal(error('decidir', '--outra').codigo, 'argumento_invalido');
  assert.equal(error('rodar').codigo, 'argumento_invalido');

  const outside = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'decidir', '--json'], {
    cwd: p.home,
    encoding: 'utf8',
    env: p.env(),
  });
  assert.equal(JSON.parse(outside.stderr).erro.codigo, 'nao_e_projeto');
  // Sem --json, o erro continua em texto.
  assert.match(p.cli('aprovar', '99').stderr, /^Item #99 não existe\.\n$/);
});

test('aprovar e parar com --json', () => {
  const p = jsonProject();
  p.db
    .prepare("UPDATE items SET status = 'needs_human', pending_kind = 'critical_approval', pending = '{}' WHERE id = ?")
    .run(p.item(1).id);
  assert.deepEqual(p.json('aprovar', '1'), { versao: 1, item: { numero: 1, titulo: 'Casa', estado: 'planned' } });
  assert.deepEqual(p.json('parar'), { versao: 1, parada_pedida: false, pid: null });
});

test('responder --respostas: uma resposta por pergunta, sugestão, delegação e suposições críticas', () => {
  const p = jsonProject();
  const pending = (value: unknown) =>
    p.db
      .prepare("UPDATE items SET status = 'needs_human', pending_kind = 'question_plan', pending = ? WHERE id = ?")
      .run(JSON.stringify(value), p.item(1).id);
  const file = (name: string, value: unknown) => {
    const path = join(p.home, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const refused = (value: unknown) => {
    const result = p.cli('responder', '1', '--respostas', file('recusa.json', value), '--json');
    assert.equal(result.status, 1);
    const { erro } = JSON.parse(result.stderr);
    assert.equal(erro.codigo, 'argumento_invalido');
    return erro.mensagem as string;
  };
  const questions = [
    { texto: 'Qual moeda?', sugestao: 'Real', regraCritica: false },
    { texto: 'Desconto máximo?', sugestao: '10%', regraCritica: true },
    { texto: 'Cor do botão?', sugestao: '', regraCritica: false },
  ];
  pending({ questions });
  assert.match(refused([null, null]), /2 respostas para 3 perguntas/);
  assert.match(refused([null, 'decida e registre como suposição.', 'Azul']), /resposta 2: pergunta de regra crítica/);
  assert.match(refused([null, null, null]), /resposta 3: a pergunta não tem sugestão/);
  assert.match(refused({ perguntas: [null, null, 'Azul'], suposicoes_criticas: null }), /não tem suposições críticas/);

  const out = p.json('responder', '1', '--respostas', file('ok.json', [null, '15%', 'decida e registre como suposição.']));
  assert.deepEqual(out, { versao: 1, item: { numero: 1, titulo: 'Casa', estado: 'planning' } });
  assert.equal(
    p.item(1).nextInput?.answer,
    'P1: Qual moeda?\nR1: Real\nP2: Desconto máximo?\nR2: 15%\nP3: Cor do botão?\nR3: decida e registre como suposição.',
  );

  // Com suposições críticas, só o objeto, e a confirmação é explícita.
  pending({ questions: [questions[0]], criticalAssumptions: ['desconto só no Pix'] });
  assert.match(refused([null]), /o item tem suposições críticas/);
  assert.match(refused({ perguntas: [null] }), /confirme \(null\) ou corrija/);
  assert.match(refused({ perguntas: [null], suposicoes_criticas: 'decida e registre como suposição.' }), /a decisão é sua/);
  p.json('responder', '1', '--respostas', file('sup.json', { perguntas: [null], suposicoes_criticas: null }));
  assert.equal(p.item(1).nextInput?.answer, 'P1: Qual moeda?\nR1: Real\nP2: Suposições críticas: desconto só no Pix\nR2: Confirmo as suposições.');

  // Texto e arquivo juntos, ou arquivo num item sem perguntas, são recusados.
  assert.equal(p.cli('responder', '1', 'texto', '--respostas', file('x.json', [])).status, 1);
  p.db.prepare("UPDATE items SET status = 'needs_human', pending_kind = 'plan_incomplete', pending = '{}' WHERE id = ?").run(p.item(1).id);
  assert.match(refused([]), /não tem perguntas/);
});
