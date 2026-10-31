import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.ts';
import { eventCursor, pollEvents } from '../src/events.ts';
import { getItem, syncBacklog, transition } from '../src/items.ts';
import { isoLocal } from '../src/json.ts';
import { lockPath } from '../src/lock.ts';
import { writeConfig } from '../src/project.ts';
import { recordQueueEvent } from '../src/run.ts';
import type { BirthOutput, BirthProposal } from '../src/schemas/stages.ts';
import { CLI, EXECUTION, EXECUTION_FILES, FAKE_CLAUDE, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

/*
 * Exemplos reais de cada saída `--json` e de cada tipo de evento, em `docs/specs/exemplos/`
 * (`docs/specs/integracao-externa.md`). O `mabel-ui` copia os arquivos e confere a cópia.
 * Saída que muda sem o exemplo regravado falha aqui; para regravar:
 *
 *   MABEL_GRAVAR_EXEMPLOS=1 npm test
 *
 * Os valores voláteis viram fixos: ids, raízes e nomes de projeto são trocados; os horários
 * são deslocados para `BASE` e arredondados a 10 minutos (o cenário grava os seus em
 * múltiplos de 10 minutos a partir de `t0`); o que depende do relógio do CLI é arredondado.
 */

// Fuso fixo: `isoLocal` sai igual em qualquer máquina. Vale também para os CLIs filhos.
process.env.TZ = 'America/Sao_Paulo';
// O commit do `nascer` num repositório recém-criado precisa de autor.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Teste',
  GIT_AUTHOR_EMAIL: 'teste@example.com',
  GIT_COMMITTER_NAME: 'Teste',
  GIT_COMMITTER_EMAIL: 'teste@example.com',
});

const DIR = join(import.meta.dirname, '..', 'docs', 'specs', 'exemplos');
const RECORD = process.env.MABEL_GRAVAR_EXEMPLOS === '1';
const BASE = Date.parse('2026-10-24T15:00:00Z');
const STEP = 10 * 60_000;
const MINUTE = 60_000;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const PROJECT_ID = '3f0c2a9e-5b7d-4e1a-9c8f-2d6b4a1e7c30';
const PROJECT_ROOT = '/Users/voce/projetos/loja-online';
const BIRTH_ROOT = '/Users/voce/projetos/ferias-do-time';

/** Troca os valores voláteis de uma saída pelos fixos. */
function normalizer(t0: number, swaps: Record<string, string>) {
  const pairs = Object.entries(swaps).sort((a, b) => b[0].length - a[0].length);
  const fix = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) return value.map((child) => fix(child));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, child]) => [k, fix(child, k)]));
    }
    if (typeof value === 'number') {
      if (key === 'idade_leitura_s') return Math.round(value / 60) * 60;
      if (key === 'esperado') return Number(value.toFixed(3));
      return value;
    }
    if (typeof value !== 'string') return value;
    let text = value;
    for (const [from, to] of pairs) text = text.split(from).join(to);
    const match = DATE.exec(text);
    if (!match) return text;
    const shifted = new Date(Math.round((BASE + Date.parse(text) - t0) / STEP) * STEP);
    return match[2] === 'Z' ? shifted.toISOString() : isoLocal(shifted);
  };
  return fix;
}

/** Grava o exemplo (com `MABEL_GRAVAR_EXEMPLOS=1`) ou confere com o gravado. */
function example(name: string, content: string): void {
  const path = join(DIR, name);
  if (RECORD) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path, content);
    return;
  }
  assert.ok(existsSync(path), `falta o exemplo ${name}: rode MABEL_GRAVAR_EXEMPLOS=1 npm test`);
  assert.equal(readFileSync(path, 'utf8'), content, `a saída mudou; confira e regrave com MABEL_GRAVAR_EXEMPLOS=1 npm test (${name})`);
}

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Raiz como aparece nas saídas: a do banco e a real, com `/private` no macOS. */
const rootSwaps = (root: string, to: string): Record<string, string> => ({ [realpathSync(root)]: to, [root]: to, [basename(root)]: basename(to) });

test('exemplos: projetos, status, inbox, projeto e saldo --json', () => {
  const ctx = setupProject('\n## Carrinho\nadicionar produtos ao carrinho\n\n## Frete\ncalcular o frete pelo CEP\n');
  assert.equal(ctx.cli('conferir').status, 0);
  const t0 = Date.now();
  const at = (steps: number) => new Date(t0 + steps * STEP).toISOString();
  const fix = normalizer(t0, { ...rootSwaps(ctx.root, PROJECT_ROOT), [ctx.project.id]: PROJECT_ID });
  const json = (...args: string[]) => {
    const result = ctx.cli(...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    return fix(JSON.parse(result.stdout));
  };
  const item = (number: number) => getItem(ctx.db, ctx.project.id, number)!;

  // Item 1 parado com perguntas do planejamento; item 2 executando, com a run aberta e a trava viva.
  const pending = {
    questions: [
      { texto: 'O carrinho guarda os produtos depois do logout?', sugestao: 'Sim, por 30 dias', regraCritica: false },
      { texto: 'Produto sem estoque pode entrar no carrinho?', sugestao: 'Não', regraCritica: true },
    ],
  };
  ctx.db
    .prepare("UPDATE items SET status = 'needs_human', pending_kind = 'question_plan', pending = ?, status_reason = 'perguntas do planejamento' WHERE id = ?")
    .run(JSON.stringify(pending), item(1).id);
  ctx.db.prepare("UPDATE items SET status = 'executing' WHERE id = ?").run(item(2).id);
  const insertRun = ctx.db.prepare(
    `INSERT INTO runs (id, kind, item_id, stage, prompt, cwd, model_requested, model, status, started_at, ended_at, cost_usd,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, pid)
     VALUES (?, 'stage', ?, ?, 'p', '/tmp', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertRun.run('a1b2c3d4-0001-4000-8000-000000000001', item(1).id, 'plan', 'opus', 'opus', 'succeeded', at(-3), at(-2), 0.42, 1200, 800, 15000, 300, process.pid);
  insertRun.run('a1b2c3d4-0002-4000-8000-000000000002', item(2).id, 'plan', 'opus', 'opus', 'succeeded', at(-2), at(-1), 0.38, 1100, 700, 14000, 250, process.pid);
  insertRun.run('a1b2c3d4-0003-4000-8000-000000000003', item(2).id, 'execute', 'sonnet', 'sonnet', 'running', at(-1), null, 1.25, 4000, 2500, 90000, 1200, process.pid);
  const observed = new Date(t0 - 2 * MINUTE).toISOString();
  const reading = ctx.db.prepare('INSERT INTO rate_limits (run_id, observed_at, window, utilization, resets_at) VALUES (?, ?, ?, ?, ?)');
  reading.run('a1b2c3d4-0001-4000-8000-000000000001', observed, 'five_hour', 0.1, at(12));
  reading.run('a1b2c3d4-0001-4000-8000-000000000001', observed, 'five_hour', 0.14, at(12));
  reading.run('a1b2c3d4-0003-4000-8000-000000000003', observed, 'seven_day', 0.38, at(3 * 144));
  reading.run('a1b2c3d4-0003-4000-8000-000000000003', observed, 'seven_day', 0.4, at(3 * 144));
  reading.run('a1b2c3d4-0003-4000-8000-000000000003', observed, 'five_hour', 0.14, at(12));
  reading.run('a1b2c3d4-0003-4000-8000-000000000003', observed, 'five_hour', 0.22, at(12));
  mkdirSync(join(ctx.home, 'locks'), { recursive: true });
  writeFileSync(lockPath(ctx.home, ctx.project.id), `${process.pid}\n`);

  example('projetos.json', pretty(json('listar')));
  example('status.json', pretty(json('conferir')));
  example('inbox.json', pretty(json('decidir')));
  example('projeto.json', pretty(json('auditar', ctx.project.name)));

  // Espera por saldo gravada pelo `run` que segura a trava: aparece no `saldo`.
  recordQueueEvent(ctx.db, ctx.project.id, {
    at: new Date(t0),
    kind: 'wait',
    cause: 'pace',
    detail: 'ritmo de 7 dias acima do esperado',
    until: new Date(t0 + 6 * STEP),
  });
  example('saldo.json', pretty(json('saldo')));
});

/** Ordem dos tipos no `eventos.ndjson`, a da spec. */
const EVENT_TYPES = ['etapa', 'ferramenta', 'gate', 'revisao', 'inbox', 'saldo', 'fila', 'item'];

test('exemplos: um evento de cada tipo do mabel eventos', () => {
  const ctx = setupProject('\n## Carrinho\nadicionar produtos ao carrinho\n');
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  useScenario(ctx.root, [{ structured_output: PLAN }, { structured_output: EXECUTION, files: EXECUTION_FILES }, { structured_output: REVIEW_OK }]);
  const cursor = eventCursor(ctx.db);
  const t0 = Date.now();
  const fix = normalizer(t0, { ...rootSwaps(ctx.root, PROJECT_ROOT), [ctx.project.id]: PROJECT_ID });
  ctx.db
    .prepare("INSERT INTO rate_limits (observed_at, window, utilization, resets_at) VALUES (?, 'five_hour', 0.22, ?)")
    .run(new Date(t0).toISOString(), new Date(t0 + 12 * STEP).toISOString());

  const run = ctx.cli('rodar');
  assert.equal(run.status, 0, run.stderr);

  // Um item novo para esperando o humano: a inbox do projeto muda.
  writeFileSync(ctx.path, `${readFileSync(ctx.path, 'utf8')}\n## Frete\ncalcular o frete pelo CEP\n`);
  syncBacklog(ctx.db, ctx.project);
  const item = getItem(ctx.db, ctx.project.id, 2)!;
  transition(ctx.db, ctx.project, item.id, 'planning', 'fila');
  ctx.db.prepare("UPDATE items SET pending_kind = 'question_plan' WHERE id = ?").run(item.id);
  transition(ctx.db, ctx.project, item.id, 'needs_human', 'perguntas do planejamento');

  const events = pollEvents(ctx.db, cursor);
  const lines = EVENT_TYPES.map((tipo) => {
    const event = events.find((candidate) => candidate.tipo === tipo);
    assert.ok(event, `nenhum evento ${tipo}`);
    return JSON.stringify(fix(event));
  });
  example('eventos.ndjson', `${lines.join('\n')}\n`);
});

const PROPOSAL: BirthProposal = {
  stack: 'node',
  stackMotivo: 'o time já usa TypeScript',
  claudeMd: '# Férias do time\n\nApp de controle de férias.\n',
  acrescimosClaudeMd: [],
  regrasCriticas: { caminhos: ['src/aprovacoes/**'], conceitos: ['Saldo de férias nunca fica negativo'] },
  backlog: [
    {
      titulo: 'Pedido de férias',
      intencao: 'A pessoa pede um período de férias.',
      criterios: ['Pedido acima do saldo é recusado'],
      foraDoEscopo: ['Aprovação pelo gestor'],
      decisoes: [],
      regrasCriticas: ['Saldo de férias nunca fica negativo'],
      dependeDe: [],
    },
  ],
};

const QUESTIONS: BirthOutput = {
  entendimento: 'Um app para o time controlar férias.',
  perguntas: [
    { texto: 'Quem aprova as férias?', sugestao: 'O gestor direto', regraCritica: false },
    { texto: 'Pode tirar férias com saldo negativo?', sugestao: 'Não', regraCritica: true },
  ],
  suposicoes: ['Login pelo Google Workspace da empresa'],
  proposta: { ...PROPOSAL, backlog: [] },
};

const PROPOSED: BirthOutput = { ...QUESTIONS, perguntas: [], proposta: PROPOSAL };

test('exemplos: os passos do mabel criar --json', () => {
  const root = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  const other = mkdtempSync(join(tmpdir(), 'mabel-nascer-'));
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  const dir = mkdtempSync(join(tmpdir(), 'mabel-cenario-'));
  const t0 = Date.now();
  // Saldo recente e folgado: a rodada não faz a chamada mínima.
  const db = openDb(home);
  const insert = db.prepare("INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, 'allowed')");
  insert.run(new Date(t0).toISOString(), 'five_hour', 0.1, new Date(t0 + 18 * STEP).toISOString());
  insert.run(new Date(t0).toISOString(), 'seven_day', 0.1, new Date(t0 + 6 * 144 * STEP).toISOString());
  const scenario = join(dir, 'cenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({ responses: [{ structured_output: QUESTIONS, cost: 0.12 }, { structured_output: PROPOSED, cost: 0.2 }, { structured_output: PROPOSED, cost: 0.15 }] }),
  );
  const env = { ...process.env, MABEL_HOME: home, NO_COLOR: '1', MABEL_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_SCENARIO: scenario };
  const swaps: Record<string, string> = { ...rootSwaps(root, BIRTH_ROOT), ...rootSwaps(other, '/Users/voce/projetos/outro-app') };
  const fixed = (key: string, value: string) => {
    swaps[key] = value;
  };
  const step = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'criar', ...args, '--json'], {
      cwd,
      encoding: 'utf8',
      env,
      input: '',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  };
  const show = (value: Record<string, unknown>) => pretty(normalizer(t0, swaps)(value));

  const asking = step(root, 'um app de férias do time');
  const id = asking.nascimento as string;
  fixed(id, '7e5d1c3b-9a2f-4b8e-a6d0-1f3c5e7a9b20');
  example('nascer-perguntas.json', show(asking));

  const answers = join(dir, 'respostas.json');
  writeFileSync(answers, JSON.stringify([null, 'Nunca']));
  example('nascer-proposta.json', show(step(root, '--responder', id, '--respostas', answers)));
  example('nascer-lista.json', show(step(root, '--lista')));

  const saved = step(root, '--aceitar', id);
  fixed((saved.projeto as { id: string }).id, '9b4e6f1a-2c3d-4e5f-8a7b-6c5d4e3f2a10');
  example('nascer-gravado.json', show(saved));

  const started = step(other, 'outro app');
  fixed(started.nascimento as string, 'c2d4e6f8-1a3b-4c5d-9e7f-0a1b2c3d4e50');
  example('nascer-descartado.json', show(step(other, '--descartar', started.nascimento as string)));
});
