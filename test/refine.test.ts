import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Interrupted } from '../src/ask.ts';
import { BACKLOG_TEMPLATE, parseBacklog, renderItemBlock, replaceItemBlock } from '../src/backlog.ts';
import { contentHash, getItem, syncBacklog, transition } from '../src/items.ts';
import { startGate } from '../src/pipeline.ts';
import { readCriticalRules } from '../src/project.ts';
import {
  type ReviewIO,
  acceptAll,
  applyRefinement,
  latestRefinement,
  refineItem,
  refinePrompt,
  reviewProposal,
  signals,
  situation,
} from '../src/refine.ts';
import type { PlanOutput, RefineOutput } from '../src/schemas/stages.ts';
import { executePrompt, planPrompt, reviewPrompt } from '../src/stages.ts';
import { EXECUTION, PLAN as PLAN_FIXTURE, setupProject, useScenario } from './helpers.ts';

const PLAN = PLAN_FIXTURE as PlanOutput;

const PROPOSAL: RefineOutput = {
  entendimento: 'Exportar os pedidos em CSV para abrir no Excel.',
  criterios: ['Arquivo vazio tem só o cabeçalho'],
  foraDoEscopo: ['Exportar itens do pedido'],
  perguntas: [
    { texto: 'Pedidos cancelados entram?', sugestao: 'Não', regraCritica: false },
    { texto: 'Qual separador?', sugestao: '', regraCritica: false },
  ],
  conceitosCriticos: [],
  quebra: [],
};

const ITEM = `
## Exportar pedidos
Quero abrir a lista de pedidos no Excel.

Critérios:
- Uma linha por pedido
<!-- nota minha, fora do bloco -->

## Outro item
Intenção do outro.
`;

/** Leitura de saldo recente e folgada: o refinamento não faz a chamada mínima. */
function seedBalance(db: DatabaseSync) {
  const now = Date.now();
  const insert = db.prepare('INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)');
  insert.run(new Date(now).toISOString(), 'five_hour', 0.1, new Date(now + 3 * 3600_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.1, new Date(now + 6 * 86400_000).toISOString(), 'allowed');
}

/** Respostas roteirizadas, na ordem; `null` simula ctrl+c. */
function scriptedIO(answers: (string | null)[]): ReviewIO & { lines: string[]; prompts: string[] } {
  const lines: string[] = [];
  const prompts: string[] = [];
  return {
    lines,
    prompts,
    write: (line) => lines.push(line),
    ask: async (prompt) => {
      prompts.push(prompt);
      if (answers.length === 0) throw new Error(`pergunta sem resposta roteirizada: ${prompt}`);
      const answer = answers.shift() as string | null;
      if (answer === null) throw new Interrupted();
      return answer;
    },
  };
}

function setup() {
  const ctx = setupProject(ITEM);
  syncBacklog(ctx.db, ctx.project);
  seedBalance(ctx.db);
  return ctx;
}

test('backlog: campos novos lidos em lista ou na linha e gravados pelo renderItemBlock', () => {
  const [item] = parseBacklog(`## A
id: 1
Intenção.

Fora do escopo: filtros
- importação

Decisões:
- Cancelados entram? → Não

Regras críticas:
- Preço de venda
Restrições: nada novo
`);
  assert.deepEqual(item?.outOfScope, ['filtros', 'importação']);
  assert.deepEqual(item?.decisions, ['Cancelados entram? → Não']);
  assert.deepEqual(item?.criticalConcepts, ['Preço de venda']);
  assert.equal(item?.restrictions, 'nada novo');
  assert.equal(item?.intent, 'Intenção.');

  const block = renderItemBlock({ ...(item as NonNullable<typeof item>), number: 1 });
  assert.match(block, /Fora do escopo:\n- filtros\n- importação\n\nDecisões:\n- Cancelados entram\? → Não\n\nRegras críticas:\n- Preço de venda/);
});

test('hash: backlog sem os campos novos mantém o hash de antes', () => {
  const base = { title: 'T', intent: 'I', criteria: ['C'], dependsOn: [], restrictions: null };
  const before = contentHash({ ...base, outOfScope: [], decisions: [], criticalConcepts: [] });
  // O hash anterior aos campos do refinamento: só os cinco campos originais.
  const legacy = createHash('sha256').update(JSON.stringify(['T', 'I', ['C'], [], null])).digest('hex');
  assert.equal(before, legacy);
  assert.notEqual(contentHash({ ...base, outOfScope: ['x'], decisions: [], criticalConcepts: [] }), legacy);
});

test('replaceItemBlock troca só o item e preserva o comentário e o item seguinte', () => {
  const text = BACKLOG_TEMPLATE + ITEM;
  const [first] = parseBacklog(text);
  const result = replaceItemBlock(text, first as NonNullable<typeof first>, '## Exportar pedidos\nNova intenção.\n');
  assert.ok(result.startsWith(BACKLOG_TEMPLATE));
  assert.match(result, /## Exportar pedidos\nNova intenção\.\n<!-- nota minha, fora do bloco -->\n\n## Outro item\nIntenção do outro\.\n$/);
});

test('ready: regra crítica sem critérios fica no backlog; com critérios, fica pronto', () => {
  const { db, project, path } = setupProject(`
## Desconto
Aplicar desconto no carrinho.

Regras críticas:
- Preço de venda
`);
  syncBacklog(db, project);
  let item = getItem(db, project.id, 1);
  assert.equal(item?.status, 'backlog');
  assert.match(item?.statusReason ?? '', /regra crítica sem critérios: .*mabel refinar 1/);

  writeFileSync(path, readFileSync(path, 'utf8').replace('Regras críticas:\n- Preço', 'Critérios:\n- 10% acima de R$ 100\n\nRegras críticas:\n- Preço'));
  syncBacklog(db, project);
  item = getItem(db, project.id, 1);
  assert.equal(item?.status, 'ready');
});

test('gate de início: conceito declarado no backlog exige aprovação mesmo sem conceito no plano', () => {
  const rules = { paths: [], concepts: [] } as unknown as ReturnType<typeof readCriticalRules>;
  assert.deepEqual(startGate(PLAN, undefined, rules, false), { kind: 'pass' });
  assert.deepEqual(startGate(PLAN, undefined, rules, false, ['Preço de venda']), {
    kind: 'critical',
    reasons: ['conceito crítico: Preço de venda'],
  });
  assert.deepEqual(startGate(PLAN, undefined, rules, true, ['Preço de venda']), { kind: 'pass' });
});

test('prompts: planejamento recebe fora do escopo, decisões e regras críticas; execução e revisão, fora do escopo', () => {
  const { db, project, root } = setupProject(`
## Exportar
Abrir no Excel.

Critérios:
- C1

Fora do escopo:
- Itens do pedido

Decisões:
- Cancelados? → Não

Regras críticas:
- Preço de venda
`);
  syncBacklog(db, project);
  const item = getItem(db, project.id, 1);
  assert.ok(item);
  const ctx = { home: '', project, item, worktree: root };
  const plan = planPrompt(ctx);
  assert.match(plan, /## Fora do escopo\n\n- Itens do pedido/);
  assert.match(plan, /## Decisões já tomadas pelo humano\n\n- Cancelados\? → Não/);
  assert.match(plan, /## Regras críticas declaradas no backlog\n\n- Preço de venda/);
  assert.match(executePrompt(ctx, { plan: PLAN, attempt: 1 }), /## Fora do escopo\n\n- Itens do pedido/);
  assert.match(reviewPrompt(ctx, { plan: PLAN, execution: EXECUTION }), /## Fora do escopo do item\n\n- Itens do pedido/);
  assert.match(refinePrompt(item), /## Critérios de aceite atuais\n\n- C1/);
});

test('refinar: roda a etapa refine só leitura na raiz, grava a proposta e a reusa até --refazer', async () => {
  const { db, home, project, root } = setup();
  const { log } = useScenario(root, [{ structured_output: PROPOSAL }, { structured_output: { ...PROPOSAL, criterios: ['Outro'] } }]);
  const item = getItem(db, project.id, 1);
  assert.ok(item);

  assert.equal(await refineItem(db, home, project, item, {}, undefined), 0);
  assert.equal(log().length, 1);
  const argv = log()[0]?.argv ?? [];
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(argv.includes('--restricted'));
  assert.equal(log()[0]?.cwd, project.root);
  const run = db.prepare("SELECT kind, stage, item_id FROM runs WHERE stage = 'refine'").get() as Record<string, string>;
  assert.deepEqual({ ...run }, { kind: 'stage', stage: 'refine', item_id: item.id });
  assert.equal(situation(db, item), 'proposta pendente');

  // Segunda chamada: mesma proposta, sem run nova.
  assert.equal(await refineItem(db, home, project, item, {}, undefined), 0);
  assert.equal(log().length, 1);

  assert.equal(await refineItem(db, home, project, item, { redo: true }, undefined), 0);
  assert.equal(log().length, 2);
  assert.deepEqual(latestRefinement(db, item.id)?.proposal.criterios, ['Outro']);
  const statuses = db.prepare('SELECT status FROM refinements ORDER BY id').all() as { status: string }[];
  assert.deepEqual(statuses.map((s) => s.status), ['discarded', 'proposed']);
});

test('refinar: revisão responde, edita e grava só o bloco do item', async () => {
  const { db, home, project, root, path } = setup();
  useScenario(root, [{ structured_output: PROPOSAL }]);
  const item = getItem(db, project.id, 1);
  assert.ok(item);
  const io = scriptedIO([
    '', // pergunta 1: aceita a sugestão
    'Ponto e vírgula', // pergunta 2: responde
    'e', // critérios: edita
    '', // mantém o proposto
    'Datas em dd/mm/aaaa', // acrescenta
    '', // encerra
    '-', // fora do escopo: descarta
    '', // grava
  ]);
  assert.equal(await refineItem(db, home, project, item, {}, io), 0);

  const text = readFileSync(path, 'utf8');
  assert.match(
    text,
    /## Exportar pedidos\nid: 1\nQuero abrir a lista de pedidos no Excel\.\n\nCritérios:\n- Uma linha por pedido\n- Arquivo vazio tem só o cabeçalho\n- Datas em dd\/mm\/aaaa\n\nDecisões:\n- Pedidos cancelados entram\? → Não\n- Qual separador\? → Ponto e vírgula\n<!-- nota minha, fora do bloco -->\n\n## Outro item\nid: 2\n/,
  );
  const updated = getItem(db, project.id, 1);
  assert.deepEqual(updated?.decisions, ['Pedidos cancelados entram? → Não', 'Qual separador? → Ponto e vírgula']);
  assert.equal(updated && situation(db, updated), 'refinado');
  // Já refinado: no terminal, pergunta antes de gastar outra run.
  assert.equal(await refineItem(db, home, project, updated as NonNullable<typeof updated>, {}, scriptedIO(['n'])), 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM runs WHERE stage = 'refine'").get()?.n, 1);
  assert.match(io.lines.join('\n'), /✓ #1 refinado: 2 critérios · 2 decisões · ready/);
});

test('refinar: n mantém a proposta, d descarta, ctrl+c a deixa pendente', async () => {
  const { db, home, project, root, path } = setup();
  useScenario(root, [{ structured_output: PROPOSAL }]);
  const before = readFileSync(path, 'utf8');
  const item = getItem(db, project.id, 1);
  assert.ok(item);

  assert.equal(await refineItem(db, home, project, item, {}, scriptedIO(['p', 'p', '', '', 'n'])), 0);
  assert.equal(situation(db, item), 'proposta pendente');
  assert.equal(await refineItem(db, home, project, item, {}, scriptedIO(['', null])), 130);
  assert.equal(situation(db, item), 'proposta pendente');
  assert.equal(await refineItem(db, home, project, item, {}, scriptedIO(['p', 'p', '', '', 'd'])), 0);
  assert.equal(situation(db, item), 'descartado');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('refinar: proposta desatualizada quando o item muda; item iniciado é recusado', async () => {
  const { db, home, project, root, path } = setup();
  const { log } = useScenario(root, [{ structured_output: PROPOSAL }, { structured_output: PROPOSAL }]);
  let item = getItem(db, project.id, 1);
  assert.ok(item);
  await refineItem(db, home, project, item, {}, undefined);

  writeFileSync(path, readFileSync(path, 'utf8').replace('pedidos no Excel.', 'pedidos no Excel e no Numbers.'));
  syncBacklog(db, project);
  item = getItem(db, project.id, 1);
  assert.ok(item);
  assert.equal(situation(db, item), 'proposta desatualizada');
  await refineItem(db, home, project, item, {}, undefined);
  assert.equal(log().length, 2, 'proposta desatualizada roda o agente de novo');

  transition(db, project, item.id, 'planning', 'teste');
  assert.equal(await refineItem(db, home, project, item, {}, undefined), 1);
  assert.throws(
    () => applyRefinement(db, project, item, latestRefinement(db, item.id) as NonNullable<ReturnType<typeof latestRefinement>>, acceptAll(PROPOSAL).additions),
    /já entrou em planejamento/,
  );
});

test('revisão: proposta sem nada novo marca o item como refinado', async () => {
  const { db, project } = setup();
  const item = getItem(db, project.id, 1);
  assert.ok(item);
  const empty: RefineOutput = { ...PROPOSAL, criterios: [], foraDoEscopo: [], perguntas: [] };
  const io = scriptedIO(['']);
  assert.deepEqual(await reviewProposal(io, item, empty), {
    kind: 'accept',
    additions: { criteria: [], outOfScope: [], decisions: [], criticalConcepts: [] },
  });
  assert.match(io.prompts[0] ?? '', /Nada a acrescentar/);
});

test('CLI: refinar lista, --aceitar grava fora do TTY e --descartar descarta', () => {
  const { cli, db, root, path } = setup();
  useScenario(root, [{ structured_output: PROPOSAL }, { structured_output: PROPOSAL }]);

  const list = cli('refinar');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /#\s+título\s+estado\s+refinamento/);
  assert.match(list.stdout, /#1\s+Exportar pedidos\s+ready\s+não refinado/);

  const proposal = cli('refinar', '1');
  assert.equal(proposal.status, 0, proposal.stderr);
  assert.match(proposal.stdout, /Critérios propostos\n {2}1\. Arquivo vazio tem só o cabeçalho/);
  assert.match(proposal.stdout, /mabel refinar 1 --aceitar/);

  const accepted = cli('refinar', '1', '--aceitar');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /✓ #1 refinado: 1 critério · 1 fora do escopo · 1 decisão/);
  assert.match(accepted.stdout, /pergunta sem sugestão, deixada para o planejamento: Qual separador\?/);
  assert.match(readFileSync(path, 'utf8'), /Fora do escopo:\n- Exportar itens do pedido\n\nDecisões:\n- Pedidos cancelados entram\? → Não/);

  assert.equal(cli('refinar', '2').status, 0);
  assert.equal(cli('refinar', '2', '--descartar').status, 0);
  const statuses = db.prepare('SELECT status FROM refinements ORDER BY id').all() as { status: string }[];
  assert.deepEqual(statuses.map((s) => s.status), ['accepted', 'discarded']);

  assert.equal(cli('refinar', '9').status, 1);
  assert.equal(cli('refinar', '--aceitar').status, 1);
  assert.equal(cli('refinar', '1', '--aceitar', '--descartar').status, 1);
});

test('medição: perguntas somadas, suposições das últimas runs e replanejamentos', () => {
  const { db, project } = setup();
  const item = getItem(db, project.id, 1);
  assert.ok(item);
  const insert = db.prepare(
    `INSERT INTO runs (id, kind, item_id, stage, prompt, cwd, status, started_at, structured_output)
     VALUES (?, 'stage', ?, ?, 'p', '/', 'succeeded', ?, ?)`,
  );
  const output = (perguntas: number, suposicoes: number) =>
    JSON.stringify({ perguntas: Array(perguntas).fill({ texto: 'q' }), suposicoes: Array(suposicoes).fill({ texto: 's' }) });
  insert.run('r1', item.id, 'plan', '2026-10-21T10:00:00Z', output(2, 3));
  insert.run('r2', item.id, 'plan', '2026-10-21T10:05:00Z', output(0, 4));
  insert.run('r3', item.id, 'execute', '2026-10-21T10:10:00Z', output(1, 1));
  transition(db, project, item.id, 'planning', 'início');
  transition(db, project, item.id, 'needs_human', 'pergunta');
  transition(db, project, item.id, 'planning', 'resposta');

  assert.deepEqual(signals(db, item.id), { planned: true, refined: false, questions: 3, assumptions: 5, replans: 1 });
});
