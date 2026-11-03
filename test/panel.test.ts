import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ItemStatus } from '../src/items.ts';
import {
  type PanelBase,
  type PanelEvent,
  type PanelFrame,
  type PanelItem,
  type PanelRun,
  type PanelState,
  type PanelTool,
  type PanelView,
  PANEL_HINTS,
  panelHints,
  loadPanel,
  panelActions,
  panelState,
  panelStep,
  panelView,
  reducePanel,
  renderPanel,
  standardPhrase,
} from '../src/panel.ts';
import { writeConfig } from '../src/project.ts';
import { startQueue } from '../src/run.ts';
import { UNIVERSAL_KEYS, plainStyle } from '../src/screens.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, guidedProblems, setupProject, useScenario } from './helpers.ts';

const T0 = Date.parse('2026-11-01T17:02:00Z');
const s = (seconds: number) => T0 + seconds * 1000;
const NOW = s(600);

function item(number: number, title: string, status: ItemStatus = 'ready'): PanelBase['items'][number] {
  return { number, title, status, reason: null, attempts: 0, integrationBranch: 'mabel/integracao' };
}

function state(items: PanelBase['items'], events: PanelEvent[], extra: Partial<PanelBase> = {}): PanelState {
  const base = panelState({ project: 'loja-api', items, integration: true, verify: [{ name: 'test', command: 'npm test' }], scope: {}, ...extra });
  return events.reduce(reducePanel, base);
}

const start = (at = s(0)): PanelEvent => ({ kind: 'queue', at, event: 'start', detail: '' });
const tr = (at: number, number: number, from: ItemStatus, to: ItemStatus, reason: string | null = null): PanelEvent => ({ kind: 'transition', at, item: number, from, to, reason });
function run(at: number, number: number, id: string, stage: PanelRun['stage'], extra: Partial<PanelRun> = {}): PanelEvent {
  return { kind: 'run', at, item: number, run: { id, stage, model: stage === 'execute' ? 'opus' : 'sonnet', status: 'running', startedAt: at, endedAt: null, cost: 0, turns: 0, tools: [], ...extra } };
}
const ended = (at: number, number: number, id: string, stage: PanelRun['stage'], endAt: number, cost: number, turns = 7): PanelEvent =>
  run(at, number, id, stage, { status: 'succeeded', endedAt: endAt, cost, turns });
const gate = (at: number, number: number, attempt: number, name: string, passed = true, detail: string | null = null): PanelEvent => ({
  kind: 'gate',
  at,
  item: number,
  gate: { attempt, gate: name, passed, detail, at },
});
const tool = (name: string, target: string, ok: boolean | null = true): PanelTool => ({ name, target, ok });

const FRAME: PanelFrame = { readings: [], log: [], now: NOW };
const view = (extra: Partial<PanelView> = {}): PanelView => ({ ...panelView('rodar', 'menu'), ...extra });
const draw = (panel: PanelState, v: PanelView = view(), height = 40, frame: Partial<PanelFrame> = {}) =>
  renderPanel(panel, v, { ...FRAME, ...frame }, plainStyle, 88, height);
const has = (lines: string[], pattern: RegExp) => lines.some((line) => pattern.test(line));

/** #13 planejado e em execução, com ferramentas; #14 planejado esperando. */
function executing(tools: PanelTool[] = [tool('Read', 'src/shipping/rules.ts'), tool('Edit', 'src/shipping/rules.ts'), tool('Edit', 'src/checkout/total.ts', null)]) {
  return state(
    [item(13, 'Frete grátis acima de R$ 200'), item(14, 'Histórico de pedidos na conta do cliente')],
    [
      start(),
      tr(s(1), 13, 'ready', 'planning'),
      ended(s(2), 13, 'p13', 'plan', s(60), 0.18),
      gate(s(61), 13, 0, 'start'),
      tr(s(61), 13, 'planning', 'planned'),
      tr(s(62), 14, 'ready', 'planning'),
      ended(s(63), 14, 'p14', 'plan', s(100), 0.12),
      gate(s(101), 14, 0, 'start'),
      tr(s(101), 14, 'planning', 'planned'),
      tr(s(102), 13, 'planned', 'executing', 'início da execução'),
      run(s(103), 13, 'e13', 'execute', { turns: 5, tools }),
    ],
  );
}

test('frase padronizada: montada pelo Mabel a partir das ferramentas, nunca do texto do agente', () => {
  assert.equal(standardPhrase([]), 'iniciando a sessão…');
  assert.equal(standardPhrase([tool('Read', 'src/x.ts')]), 'lendo src/x.ts');
  assert.equal(standardPhrase([tool('Grep', 'freeShipping')]), 'procurando "freeShipping"');
  assert.equal(
    standardPhrase([tool('Edit', 'src/x.ts'), tool('Edit', 'src/x.ts'), tool('Write', 'test/x.test.ts')]),
    'criando test/x.test.ts · 2 arquivos alterados',
  );
  assert.equal(standardPhrase([tool('Edit', 'src/x.ts'), tool('Bash', 'npm test -- shipping')]), 'rodando os testes (npm test -- shipping) · 1 arquivo alterado');
  assert.equal(standardPhrase([tool('Bash', 'git diff')]), 'executando git diff');
  // Edição recusada (✗) não conta como arquivo alterado.
  assert.equal(standardPhrase([tool('Edit', 'src/x.ts', false)]), 'editando src/x.ts');
});

test('planejamento: fase no cabeçalho, planejar girando, G2 em linha própria, pendente "a planejar"', () => {
  const panel = state(
    [item(13, 'Frete grátis acima de R$ 200'), item(14, 'Histórico de pedidos na conta do cliente')],
    [start(), tr(s(1), 13, 'ready', 'planning'), run(s(2), 13, 'p13', 'plan', { turns: 3, tools: [tool('Read', '.mabel/specs/frete-gratis.md')] })],
  );
  const lines = draw(panel);
  assert.match(lines[0] ?? '', /^ mabel · loja-api · planejamento +fila 0\/2 · \d\d:\d\d$/);
  assert.ok(has(lines, /^ ● #13 {2}Frete grátis acima de R\$ 200 +9m59s · US\$ 0,00$/));
  assert.ok(has(lines, /^ {4}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] planejar {11}sonnet · turno 3 +9m58s$/));
  assert.ok(has(lines, /^ {6}lendo \.mabel\/specs\/frete-gratis\.md +1 ferramenta ▸$/));
  assert.ok(has(lines, /^ {4}◌ critério de início critérios, escopo, regra crítica +G2$/));
  assert.ok(has(lines, /^ ◌ #14 {2}Histórico de pedidos na conta do cliente +a planejar$/));
  assert.deepEqual(lines.flatMap(guidedProblems), []);
});

test('sem item em andamento: a abertura da fila gira com a última linha do log', () => {
  // Item já planejado numa fila anterior: a fila abre (integração, branches) e vai direto à execução.
  const panel = state([item(4, 'Moldura e CSS', 'planned')], [start(s(0))], { phase: 'execute' });
  const log = ['── mabel rodar  · 2026-11-01T17:02:00.000Z · neste terminal ──', 'main trazida para a mabel/integracao', ''];
  const lines = draw(panel, view(), 40, { log, now: s(24) });
  assert.match(lines[0] ?? '', / execução +fila 0\/1/);
  assert.ok(has(lines, /^ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] abrindo a fila {8}main trazida para a mabel\/integracao +24s$/));
  assert.ok(has(lines, /^ ◌ #4 {2}Moldura e CSS +planejado$/));

  // Entre um item e outro, a linha volta como "próximo item"; com um item ativo, some.
  const between = reducePanel(reducePanel(panel, tr(s(30), 4, 'planned', 'executing')), tr(s(40), 4, 'executing', 'needs_human'));
  assert.ok(has(draw(between, view(), 40, { now: s(52) }), /^ . próximo item +12s$/));
  assert.ok(!has(draw(reducePanel(panel, tr(s(30), 4, 'planned', 'executing'))), /abrindo a fila|próximo item/));
  assert.ok(!has(draw(reducePanel(panel, { kind: 'queue', at: s(50), event: 'stop', detail: 'empty' })), /abrindo a fila/));
});

test('execução: plano aceito numa linha, executar com modelo e turno, gates e merge na fila', () => {
  const lines = draw(executing());
  assert.match(lines[0] ?? '', / execução +fila 0\/2/);
  assert.ok(has(lines, /^ {4}✓ planejar {11}plano aceito · sonnet +58s · US\$ 0,18$/));
  assert.ok(has(lines, /^ {4}. executar {11}opus · turno 5 +8m17s$/));
  assert.ok(has(lines, /^ {6}editando src\/checkout\/total\.ts · 2 arquivos alterados +3 ferramentas ▸$/));
  const order = ['escopo', 'verificação', 'prova', 'revisar', 'merge na fila'].map((label) => lines.findIndex((line) => line.includes(`◌ ${label}`)));
  assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > (order[i - 1] as number))), `ordem das etapas: ${order}`);
  assert.ok(has(lines, /◌ verificação {8}npm test +G3$/));
  assert.ok(has(lines, /◌ merge na fila {6}mabel\/integracao +G10$/));
  assert.ok(has(lines, /^ ◌ #14 {2}Histórico de pedidos na conta do cliente +planejado$/));

  // Ferramentas abertas: as seis últimas, com ✓, ✗ e a que está rodando.
  const many = Array.from({ length: 8 }, (_, i) => tool('Read', `src/f${i}.ts`, i === 7 ? null : i !== 6));
  const open = draw(executing(many), view({ tools: true }));
  assert.ok(has(open, /8 ferramentas ▾$/));
  assert.ok(has(open, /^ {8}… 2 anteriores$/));
  assert.ok(has(open, /^ {8}✗ Read {3}src\/f6\.ts$/));
  assert.ok(!has(open, /src\/f1\.ts/));
});

test('gate rodando depois da execução; ao concluir, o item recolhe numa linha', () => {
  const after = [
    ended(s(103), 13, 'e13', 'execute', s(300), 0.97, 21),
    tr(s(300), 13, 'executing', 'verifying', 'execução 1 commitada'),
    gate(s(301), 13, 1, 'scope'),
  ];
  const verifying = after.reduce(reducePanel, executing());
  const lines = draw(verifying);
  assert.ok(has(lines, /✓ executar {11}opus · 21 turnos +3m17s · US\$ 0,97$/));
  assert.ok(has(lines, /✓ escopo {13}arquivos no escopo +G4 · 1,0s$/));
  assert.ok(has(lines, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] verificação {8}npm test +G3 · 4m59s$/));

  const done = [
    gate(s(320), 13, 1, 'test'),
    gate(s(322), 13, 1, 'criteria_tests'),
    gate(s(325), 13, 1, 'proof', true, '1 critério ligado a teste'),
    tr(s(325), 13, 'verifying', 'reviewing'),
    ended(s(326), 13, 'r13', 'review', s(420), 0.21, 6),
    gate(s(421), 13, 1, 'review', true, '1 de 1 critério atendido'),
    gate(s(422), 13, 1, 'integration', true, 'abc123'),
    tr(s(422), 13, 'reviewing', 'awaiting_merge'),
  ].reduce(reducePanel, verifying);
  const final = draw(done);
  assert.match(final[0] ?? '', /fila 1\/2/);
  assert.ok(has(final, /^ ✓ #13 {2}Frete grátis acima de R\$ 200 +6m20s · US\$ 1,36$/));
  assert.ok(!has(final, /verificação/), 'o concluído não mostra as etapas');

  // "Mostrar concluídos" abre as etapas dele.
  const opened = draw(done, view({ done: true }));
  assert.ok(has(opened, /✓ verificação {8}test verde +G3 · 19s$/));
  assert.ok(has(opened, /✓ revisar {12}sonnet · 6 turnos · 1 de 1 critério atendido +1m34s · US\$ 0,21$/));
  assert.ok(has(opened, /✓ merge na fila {6}mabel\/integracao +G10/));
});

test('prova: segue rodando até o gate proof, com o teste da vez; revisar sem sessão prepara', () => {
  const proving = [
    ended(s(103), 13, 'e13', 'execute', s(300), 0.97, 21),
    tr(s(300), 13, 'executing', 'verifying', 'execução 1 commitada'),
    gate(s(301), 13, 1, 'scope'),
    gate(s(320), 13, 1, 'test'),
    gate(s(321), 13, 1, 'criteria_tests'),
  ].reduce(reducePanel, executing());
  const withProgress: PanelState = {
    ...proving,
    items: proving.items.map((entry) => (entry.number === 13 ? { ...entry, proof: { criterio: 'R7-2', lado: 'base', feitos: 13, total: 16 } } : entry)),
  };
  const lines = draw(withProgress);
  assert.ok(has(lines, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] prova {14}R7-2 na base · teste 14 de 16 +G3 · 4m40s$/));
  assert.ok(has(lines, /◌ revisar/));
  // Sem o progresso ainda: a dica de sempre.
  assert.ok(has(draw(proving), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] prova {14}cada critério ligado a um teste +G3/));

  // Prova gravada, revisor ainda sem run: nada de "0 ferramentas".
  const reviewing = [gate(s(500), 13, 1, 'proof', true, '1 critério provado'), tr(s(500), 13, 'verifying', 'reviewing')].reduce(reducePanel, proving);
  const next = draw(reviewing);
  assert.ok(has(next, /✓ prova {14}1 critério provado +G3 · 3m00s$/));
  assert.ok(has(next, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] revisar {12}preparando a sessão +1m40s$/));
  assert.ok(!has(next, /\d ferramentas? [▸▾]$/));
});

test('nova tentativa: ↻ com a causa mecânica da anterior e "tentativa 2/3"', () => {
  const retry = [
    ended(s(103), 13, 'e13', 'execute', s(300), 0.71),
    tr(s(300), 13, 'executing', 'verifying'),
    gate(s(301), 13, 1, 'scope'),
    gate(s(310), 13, 1, 'test', false, '`npm test` saiu com 1'),
    tr(s(310), 13, 'verifying', 'executing', 'tentativa 1 reprovada'),
    run(s(312), 13, 'e13b', 'execute', { turns: 2, tools: [tool('Read', 'test/shipping/free-threshold.test.ts')] }),
  ].reduce(reducePanel, executing());
  const lines = draw(retry);
  assert.ok(has(lines, /executar {11}opus · turno 2 · tentativa 2\/3 +4m48s$/));
  assert.ok(has(lines, /^ {6}↻ tentativa 1 reprovada na verificação: `npm test` saiu com 1$/));
  // Os gates voltam a pendentes na tentativa nova.
  assert.ok(has(lines, /◌ verificação/));
  assert.ok(!has(lines, /✗/));
});

test('pausa por saldo: aviso com a janela, o limite e "faltam"; a etapa espera o saldo', () => {
  const paused = [
    ended(s(103), 13, 'e13', 'execute', s(300), 0.97),
    tr(s(300), 13, 'executing', 'verifying'),
    gate(s(301), 13, 1, 'scope'),
    gate(s(310), 13, 1, 'test'),
    gate(s(312), 13, 1, 'criteria_tests'),
    gate(s(315), 13, 1, 'proof'),
    tr(s(315), 13, 'verifying', 'reviewing'),
    { kind: 'queue', at: s(316), event: 'wait', detail: 'saldo da janela de 5h em 25% (abaixo de 30%)', until: NOW + 41 * 60_000 } satisfies PanelEvent,
  ].reduce(reducePanel, executing());
  const lines = draw(paused);
  assert.ok(has(lines, /^ {4}⏸ revisar {12}espera o saldo$/));
  assert.ok(has(lines, /^ ⏸ Saldo da janela de 5h em 25% \(abaixo de 30%\)\. Retoma às \d\d:\d\d +faltam 41m00s$/));

  // A espera acaba quando a etapa começa.
  const resumed = reducePanel(paused, run(NOW + 41 * 60_000, 13, 'r13', 'review'));
  assert.equal(resumed.wait, null);
});

test('item esperando você: ⏸ com a pendência e "Decidir agora" na barra', () => {
  const panel = state(
    [item(13, 'Frete grátis acima de R$ 200'), item(14, 'Histórico de pedidos')],
    [
      start(),
      tr(s(1), 13, 'ready', 'planning'),
      ended(s(2), 13, 'p13', 'plan', s(50), 0.14),
      gate(s(51), 13, 0, 'start', false, 'perguntas: Frete grátis vale para itens em promoção?'),
      tr(s(51), 13, 'planning', 'needs_human', 'perguntas do planejamento: Frete grátis vale para itens em promoção?'),
      tr(s(52), 14, 'ready', 'planning'),
    ],
  );
  const lines = draw(panel);
  assert.ok(has(lines, /^ ⏸ #13 {2}Frete grátis acima de R\$ 200 +aguardando você$/));
  assert.ok(has(lines, /^ {6}perguntas do planejamento: Frete grátis vale para itens em promoção\?$/));
  assert.ok(has(lines, /"Decidir agora", na barra abaixo, responde e devolve o item à fila/));
  assert.deepEqual(
    panelActions(panel, view()).map((action) => action.label),
    ['Mostrar ferramentas', 'Mostrar concluídos', 'Decidir agora', 'Parar depois da etapa'],
  );
});

test('barra de ações: ← → escolhem, enter executa; pergunta do saldo e fila encerrada', () => {
  const panel = executing();
  const v = view();
  const right = panelStep(panel, v, { name: 'right' });
  assert.ok('view' in right && right.view.selected === 1);
  const left = panelStep(panel, v, { name: 'left' });
  assert.ok('view' in left && left.view.selected === 2);
  assert.deepEqual(panelStep(panel, { ...v, selected: 2 }, { name: 'return' }), { act: 'stop' });
  // Nenhuma tecla de letra faz nada.
  assert.deepEqual(panelStep(panel, v, { name: 'q', sequence: 'q' }), { view: v });

  const asking = view({ question: { notice: 'saldo de 5h em 20%; continuar mesmo assim?', action: 'Continuar mesmo assim', back: 'Esperar o saldo' } });
  assert.deepEqual(panelActions(panel, asking).map((action) => action.label), ['Esperar o saldo', 'Continuar mesmo assim']);
  const lines = draw(panel, asking);
  assert.ok(has(lines, /^ ⏸ Saldo de 5h em 20%; continuar mesmo assim\?$/));
  assert.ok(has(lines, /^ \[Esperar o saldo\] {2}Continuar mesmo assim $/));

  assert.ok(panelActions(panel, view({ mode: 'acompanhar' })).some((action) => action.label === 'Voltar ao menu'));
  const stopped = draw(panel, view({ stopRequested: true, selected: 2 }));
  assert.ok(has(stopped, /^ ■ Parada pedida: a fila encerra depois da etapa em andamento\.$/));
  assert.ok(has(stopped, /\[Parada pedida\]/));

  const closed = reducePanel(panel, { kind: 'queue', at: s(700), event: 'stop', detail: 'interrupted' });
  assert.deepEqual(panelActions(closed, view()).map((action) => action.label), ['Voltar ao menu']);
  assert.deepEqual(panelActions(closed, view({ origin: 'shell' })).map((action) => action.label), ['Sair do painel']);
  assert.deepEqual(panelStep(closed, view(), { name: 'escape' }), { act: 'leave' });
  const end = draw(closed);
  assert.ok(has(end, /^ Fila encerrada · 0 concluídos · US\$ 0,30$/));
  assert.ok(has(end, /^ {3}interrompido$/));
  assert.ok(!has(end, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/), 'nada gira com a fila encerrada');
});

/** Fila longa: cinco concluídos, #20 executando, quatro na fila. */
function longQueue(): PanelState {
  const items = Array.from({ length: 10 }, (_, i) => item(11 + i, `Item ${11 + i}`));
  const events: PanelEvent[] = [start()];
  for (let i = 0; i < 5; i++) {
    const n = 11 + i;
    const at = s(10 + i * 60);
    events.push(tr(at, n, 'planned', 'executing'), tr(at + 30_000, n, 'reviewing', 'awaiting_merge'));
  }
  events.push(tr(s(400), 16, 'planned', 'executing'), run(s(401), 16, 'e16', 'execute', { turns: 4, tools: [tool('Read', 'a.ts'), tool('Read', 'b.ts')] }));
  return state(items, events, { phase: 'execute' });
}

test('terminal baixo recolhe: ferramentas, depois pendentes, depois concluídos; ativo e rodapé ficam', () => {
  const panel = longQueue();
  const tall = draw(panel, view({ tools: true }), 40);
  assert.equal(tall.length, 40);
  assert.ok(has(tall, /^ {3}\+2 concluídos$/));
  assert.equal(tall.filter((line) => /^ ✓ #/.test(line)).length, 3);
  assert.ok(has(tall, /✓ Read {3}b\.ts/));
  assert.equal(tall.filter((line) => /^ ◌ #/.test(line)).length, 4);

  // Sem espaço para as ferramentas abertas: elas recolhem primeiro.
  const noTools = draw(panel, view({ tools: true }), 26);
  assert.ok(!has(noTools, /✓ Read {3}b\.ts/));
  assert.equal(noTools.filter((line) => /^ ◌ #/.test(line)).length, 4);

  // Depois os pendentes viram "+N na fila".
  const fewPending = draw(panel, view(), 24);
  assert.ok(has(fewPending, /^ {3}\+\d na fila$/));
  assert.equal(fewPending.filter((line) => /^ ✓ #/.test(line)).length, 3);

  // Por fim, os concluídos.
  const short = draw(panel, view(), 21);
  assert.ok(has(short, /^ {3}\+4 na fila$/));
  assert.ok(short.filter((line) => /^ ✓ #/.test(line)).length < 3);

  for (const lines of [tall, noTools, fewPending, short]) {
    assert.ok(has(lines, /^ ● #16 {2}Item 16/), 'o item ativo nunca é cortado');
    assert.ok(has(lines, /executar/));
    assert.ok(has(lines, /merge na fila/));
    assert.match(lines.at(-2) ?? '', /←→ escolher {2}enter executar/);
  }
});

test('abaixo do mínimo de linhas, volta o log de hoje com a barra de ações', () => {
  const log = Array.from({ length: 30 }, (_, i) => `  → Read   src/f${i}.ts ✓`);
  const lines = draw(longQueue(), view(), 12, { log });
  assert.equal(lines.length, 12);
  assert.ok(!has(lines, /● #16/));
  assert.equal(lines[0], '  → Read   src/f21.ts ✓');
  assert.match(lines.at(-1) ?? '', /←→ escolher/);
  assert.match(lines.at(-2) ?? '', /\[Mostrar ferramentas\]/);
});

test('rodapé do painel: só teclas universais', () => {
  const closed = reducePanel(executing(), { kind: 'queue', at: s(700), event: 'stop', detail: 'empty' });
  for (const hints of [PANEL_HINTS, panelHints(closed, view()), panelHints(closed, view({ origin: 'shell' }))]) {
    for (const [key] of hints) assert.ok((UNIVERSAL_KEYS as readonly string[]).includes(key), key);
  }
  assert.match(draw(closed).at(-2) ?? '', /esc volta ao menu/);
});

test('lê do banco: a fila rodada vira o painel com o item concluído, custo e etapas', async () => {
  const ctx = setupProject('\n## Soma\nsoma de dois números\n');
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  useScenario(ctx.root, [{ structured_output: PLAN }, { structured_output: EXECUTION, files: EXECUTION_FILES }, { structured_output: REVIEW_OK }]);
  const since = new Date(Date.now() - 1000).toISOString();
  const result = await startQueue({ db: ctx.db, home: ctx.home, project: ctx.project, interactive: false }).done;
  assert.equal(result.end, 'empty');

  const panel = loadPanel(ctx.db, ctx.home, ctx.project, {}, since);
  assert.ok(panel.started !== null && panel.ended?.end === 'empty');
  const soma = panel.items.find((entry) => entry.number === 1) as PanelItem;
  assert.equal(soma.status, 'awaiting_merge');
  assert.deepEqual(soma.runs.map((entry) => entry.stage), ['plan', 'execute', 'review']);
  assert.ok(soma.gates.some((entry) => entry.gate === 'existe' && entry.passed));
  assert.equal(soma.planNote, '1 critério, escopo de 2 caminhos');
  const lines = renderPanel(panel, view({ done: true }), { readings: [], log: [], now: Date.now() }, plainStyle, 88, 30);
  assert.ok(has(lines, /^ ✓ #1 {2}Soma/));
  assert.ok(has(lines, /✓ verificação {8}existe verde/));
  assert.ok(has(lines, /^ Fila encerrada · 1 concluído · US\$/));
});
