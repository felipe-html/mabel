import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { BACKLOG_TEMPLATE, parseBacklog, renderItemBlock, replaceItemBlock } from '../src/backlog.ts';
import { contentHash, getItem, syncBacklog, transition } from '../src/items.ts';
import { startGate } from '../src/pipeline.ts';
import { readCriticalRules } from '../src/project.ts';
import {
  type ReviewIO,
  additionsFrom,
  applyRefinement,
  latestRefinement,
  refineItem,
  refinePrompt,
  signals,
  situation,
} from '../src/refine.ts';
import type { PlanOutput, SpecifyOutput } from '../src/schemas/stages.ts';
import { executePrompt, planPrompt, reviewPrompt } from '../src/stages.ts';
import { EXECUTION, type GuidedAnswer, PLAN as PLAN_FIXTURE, scriptedGuided, setupProject, useScenario } from './helpers.ts';

const PLAN = PLAN_FIXTURE as PlanOutput;

const R1 = { id: 'R1', texto: 'Uma linha por pedido', exemplos: [{ situacao: 'Lista vazia', resultado: 'Só o cabeçalho', borda: true }] };
const NO_REPRODUCTION = { passos: '', esperado: '', obtido: '' };

/** Primeira rodada: dois exemplos sem resultado, cada um com a sua pergunta. */
const ROUND1: SpecifyOutput = {
  historia: 'O financeiro abre os pedidos no Excel.',
  regras: [
    R1,
    { id: 'R2', texto: 'Cancelados', exemplos: [{ situacao: 'Pedido cancelado', resultado: '', borda: false }] },
    { id: 'R3', texto: 'Separador', exemplos: [{ situacao: 'Valor 1,5', resultado: '', borda: false }] },
  ],
  perguntas: [
    { texto: 'Pedidos cancelados entram?', sugestao: 'Não', regraCritica: false, regra: 'R2' },
    { texto: 'Qual separador?', sugestao: '', regraCritica: false, regra: 'R3' },
  ],
  decisoes: [],
  foraDoEscopo: ['Exportar itens do pedido'],
  conceitosCriticos: [],
  alteracoesRegrasVigentes: [],
  tarefas: [{ titulo: 'Exportar pedidos', intencao: '', regras: ['R1', 'R2', 'R3'], dependeDe: [] }],
  sugestaoQuebra: [],
  reproducao: NO_REPRODUCTION,
};

/** Proposta pronta: as respostas preenchem os exemplos. */
const FINAL: SpecifyOutput = {
  ...ROUND1,
  regras: [
    R1,
    { id: 'R2', texto: 'Cancelados', exemplos: [{ situacao: 'Pedido cancelado', resultado: 'Não entra', borda: false }] },
    { id: 'R3', texto: 'Separador', exemplos: [{ situacao: 'Valor 1,5', resultado: 'Ponto e vírgula', borda: false }] },
  ],
  perguntas: [],
  decisoes: ['Pedidos cancelados entram? → Não'],
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

/** Respostas roteirizadas da interface guiada; sem respostas, simula o ctrl+c. */
function scriptedIO(answers: GuidedAnswer[]): ReviewIO & { lines: string[]; prompts: string[] } {
  return scriptedGuided(answers);
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

test('refinar: roda a etapa specify só leitura na raiz; perguntas ficam pendentes fora do TTY até --refazer', async () => {
  const { db, home, project, root } = setup();
  const { log } = useScenario(root, [{ structured_output: ROUND1 }, { structured_output: FINAL }]);
  const item = getItem(db, project.id, 1);
  assert.ok(item);

  assert.equal(await refineItem(db, home, project, item, {}, undefined), 0);
  assert.equal(log().length, 1);
  const argv = log()[0]?.argv ?? [];
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok(argv.includes('--restricted'));
  assert.equal(log()[0]?.cwd, project.root);
  const run = db.prepare("SELECT kind, stage, item_id FROM runs WHERE stage = 'specify'").get() as Record<string, string>;
  assert.deepEqual({ ...run }, { kind: 'stage', stage: 'specify', item_id: item.id });
  assert.equal(situation(db, item), 'perguntas pendentes');

  // Segunda chamada fora do TTY: as perguntas continuam pendentes, sem run nova.
  assert.equal(await refineItem(db, home, project, item, {}, undefined), 0);
  assert.equal(log().length, 1);

  assert.equal(await refineItem(db, home, project, item, { redo: true }, undefined), 0);
  assert.equal(log().length, 2);
  assert.equal(situation(db, item), 'proposta pendente');
  assert.deepEqual(latestRefinement(db, item.id)?.conversation?.output.perguntas, []);
  const statuses = db.prepare('SELECT status FROM refinements ORDER BY id').all() as { status: string }[];
  assert.deepEqual(statuses.map((s) => s.status), ['discarded', 'proposed']);
});

test('S.4 critério 11: refinar responde em rodadas, grava critérios e decisões no backlog e o item vai a ready', async () => {
  const { db, home, project, root, path } = setup();
  const scenario = useScenario(root, [{ structured_output: ROUND1, session_id: 'sessao-refino' }, { structured_output: FINAL }]);
  const item = getItem(db, project.id, 1);
  assert.ok(item);
  const io = scriptedIO([
    'Aceitar a sugestão', // pergunta 1
    'Responder', // pergunta 2
    'Ponto e vírgula',
    'Aceitar', // história
    'Aceitar tudo', // regras
    'Aceitar tudo', // decisões
    'Descartar', // fora do escopo
    'Gravar',
  ]);
  assert.equal(await refineItem(db, home, project, item, {}, io), 0);

  const second = scenario.log()[1];
  assert.equal(second?.argv[(second?.argv.indexOf('--resume') ?? 0) + 1], 'sessao-refino');
  assert.match(second?.argv.at(-1) ?? '', /P \(R2\): Pedidos cancelados entram\?\nR: Não\n\nP \(R3\): Qual separador\?\nR: Ponto e vírgula/);
  assert.match(second?.argv.at(-1) ?? '', /Regras a retrabalhar: R2, R3\./);

  const text = readFileSync(path, 'utf8');
  assert.match(
    text,
    /## Exportar pedidos\nid: 1\nQuero abrir a lista de pedidos no Excel\.\n\nCritérios:\n- Uma linha por pedido\n- Uma linha por pedido: Lista vazia → Só o cabeçalho\n- Cancelados: Pedido cancelado → Não entra\n- Separador: Valor 1,5 → Ponto e vírgula\n\nDecisões:\n- Pedidos cancelados entram\? → Não\n- Qual separador\? → Ponto e vírgula\n<!-- nota minha, fora do bloco -->\n\n## Outro item\nid: 2\n/,
  );
  const updated = getItem(db, project.id, 1);
  assert.equal(updated?.status, 'ready');
  assert.equal(updated && situation(db, updated), 'refinado');
  // Já refinado: no terminal, pergunta antes de gastar outra run.
  assert.equal(await refineItem(db, home, project, updated as NonNullable<typeof updated>, {}, scriptedIO(['Voltar'])), 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM runs WHERE stage = 'specify'").get()?.n, 2);
  assert.match(io.lines.join('\n'), /✓ #1 refinado: 3 critérios · 2 decisões · ready/);
});

test('S.4 critério 11: bug exige o critério de reprodução, pedido na mesma sessão quando falta', async () => {
  const { db, home, project, root, path } = setupProject('\n## Total errado\nTipo: bug\nO total do carrinho soma o frete duas vezes.\n');
  syncBacklog(db, project);
  seedBalance(db);
  let item = getItem(db, project.id, 1);
  assert.equal(item?.status, 'backlog');
  assert.match(item?.statusReason ?? '', /^bug sem critério de reprodução/);

  const rule = { id: 'R1', texto: 'Frete uma vez', exemplos: [{ situacao: 'Carrinho de R$ 10 com frete de R$ 5', resultado: 'Total R$ 15', borda: false }] };
  const bug: SpecifyOutput = { ...FINAL, regras: [rule], decisoes: [], tarefas: [{ ...FINAL.tarefas[0], regras: ['R1'] } as SpecifyOutput['tarefas'][number]] };
  const reproducao = { passos: 'Carrinho de R$ 10, frete de R$ 5', esperado: 'Total R$ 15', obtido: 'Total R$ 20' };
  const scenario = useScenario(root, [{ structured_output: bug, session_id: 'sessao-bug' }, { structured_output: { ...bug, reproducao } }]);
  assert.equal(await refineItem(db, home, project, item as NonNullable<typeof item>, { accept: true }, undefined), 0);
  const correction = scenario.log()[1];
  assert.equal(correction?.argv[(correction?.argv.indexOf('--resume') ?? 0) + 1], 'sessao-bug');
  assert.match(correction?.argv.at(-1) ?? '', /bug sem reprodução/);

  assert.match(readFileSync(path, 'utf8'), /Critérios:\n- Reprodução: Carrinho de R\$ 10, frete de R\$ 5 → Total R\$ 15 \(hoje: Total R\$ 20\)\n- Frete uma vez: /);
  item = getItem(db, project.id, 1);
  assert.equal(item?.status, 'ready');
  assert.equal(item?.kind, 'bug');
});

test('refinar: deixar pendente mantém a proposta, descartar a descarta, ctrl+c a deixa pendente', async () => {
  const { db, home, project, root, path } = setup();
  useScenario(root, [{ structured_output: FINAL }]);
  const before = readFileSync(path, 'utf8');
  const item = getItem(db, project.id, 1);
  assert.ok(item);

  assert.equal(await refineItem(db, home, project, item, {}, scriptedIO(['Aceitar', 'Aceitar tudo', 'Aceitar tudo', 'Aceitar tudo', 'Deixar a proposta pendente'])), 0);
  assert.equal(situation(db, item), 'proposta pendente');
  assert.equal(await refineItem(db, home, project, item, {}, scriptedIO(['Aceitar'])), 130);
  assert.equal(situation(db, item), 'proposta pendente');
  assert.equal(await refineItem(db, home, project, item, {}, scriptedIO(['Aceitar', 'Aceitar tudo', 'Aceitar tudo', 'Aceitar tudo', 'Descartar a proposta'])), 0);
  assert.equal(situation(db, item), 'descartado');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('refinar: proposta desatualizada quando o item muda; item iniciado é recusado', async () => {
  const { db, home, project, root, path } = setup();
  const { log } = useScenario(root, [{ structured_output: FINAL }, { structured_output: FINAL }]);
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
  const refinement = latestRefinement(db, item.id) as NonNullable<ReturnType<typeof latestRefinement>>;
  assert.throws(() => applyRefinement(db, project, item, refinement, additionsFrom(item, FINAL, refinement.conversation?.answers ?? { decisoes: [], adiadas: [] })), /já entrou em planejamento/);
});

test('CLI: refinar lista, --aceitar responde com as sugestões fora do TTY e --descartar descarta', () => {
  const { cli, db, root, path } = setup();
  useScenario(root, [{ structured_output: ROUND1 }, { structured_output: { ...FINAL, regras: [R1, FINAL.regras[1] as typeof R1], tarefas: [{ ...(FINAL.tarefas[0] as SpecifyOutput['tarefas'][number]), regras: ['R1', 'R2'] }] } }, { structured_output: FINAL }]);

  const list = cli('refinar');
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /#\s+título\s+estado\s+refinamento/);
  assert.match(list.stdout, /#1\s+Exportar pedidos\s+ready\s+não refinado/);

  const proposal = cli('refinar', '1');
  assert.equal(proposal.status, 0, proposal.stderr);
  assert.match(proposal.stdout, /Perguntas\n {2}1\. Pedidos cancelados entram\? \(R2\)\n {5}sugestão: Não/);
  assert.match(proposal.stdout, /mabel refinar 1 --aceitar/);

  const accepted = cli('refinar', '1', '--aceitar');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /✓ #1 refinado: 2 critérios · 1 fora do escopo · 1 decisão/);
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
