import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseArgs } from 'node:util';
import { commands, findCommand } from '../src/commands.ts';
import { resume } from '../src/decisions.ts';
import { EMPTY_DATA, FORMS, type ScreenData, commandScreen, stopForm } from '../src/forms.ts';
import { bodyRows, captureRun, frame, outputLines, pendingChoice, renderResult, type HomeContext } from '../src/home.ts';
import { getItem, syncBacklog, transition, updateItem } from '../src/items.ts';
import type { Item } from '../src/items.ts';
import { type FormConfig, type FormState, type FormValues, formBody, formState, formStep, missingFields, plainStyle, renderForm, wrapLine } from '../src/screens.ts';
import { guidedProblems, setupProject } from './helpers.ts';

const NOW = new Date('2026-11-01T12:00:00Z');
const CONTEXT: HomeContext = { project: 'loja-api', path: '~/Pessoal/loja-api', version: '2.1.0', instance: true, ready: 2, pending: 1, units: 0, readings: [], now: NOW };

const item = (number: number, status: Item['status'], extra: Partial<Item> = {}): Item =>
  ({ number, title: `Item ${number}`, status, statusReason: null, pendingKind: null, integratedCommit: null, ...extra }) as Item;

const DATA: ScreenData = {
  ...EMPTY_DATA,
  project: true,
  items: [item(1, 'ready'), item(2, 'backlog'), item(3, 'failed', { statusReason: 'run de executar falhou: timeout' }), item(4, 'awaiting_merge', { integratedCommit: 'abc' })],
  refinable: [item(2, 'backlog')],
  specs: [{ slug: 'frete-gratis', hint: 'aceita · 3 tarefas' }],
  projects: [{ id: 'p', name: 'loja-api', root: '/x', runs: 3, costUsd: 1.2, lastActivity: '', states: [], items: 4 }],
  queueRunning: true,
};

/** Valores de exemplo de cada formulário, com os campos obrigatórios e algumas opções. */
const SAMPLES: Record<string, FormValues> = {
  preparar: { stack: 'node' },
  criar: { desc: 'Uma loja de bairro', stack: 'python', modelo: 'opus' },
  adicionar: { title: 'Exportar pedidos', intent: 'Abrir no Excel', criteria: ['Uma linha por pedido', 'Com "aspas"'], dependsOn: ['1'], restrictions: 'sem libs' },
  especificar: { spec: 'frete-gratis', acao: '--aceitar' },
  refinar: { item: '2', acao: '--refazer' },
  capturar: { tipo: 'tela', nome: 'checkout', origem: 'https://www.figma.com/design/abc/x?node-id=1-2', escala: '3' },
  credenciar: { cred: 'figma', expira: '2027-01-31' },
  rodar: { modo: '--sem-lote', limite: '2', fundo: true },
  cancelar: { item: '1' },
  retomar: { item: '3', orientacao: 'a API voltou; tente de novo' },
  entregar: { unidade: 'frete-gratis', com: ['cupom'], parcial: true, rascunho: true },
  rejeitar: { item: '4', motivo: 'faltou o caso do zero', cancelar: true },
  detalhar: { item: '3' },
  auditar: { projeto: 'loja-api', remover: true, confirma: 'loja-api' },
  pedir: { prompt: 'liste os TODOs', model: 'haiku', turnos: '5', cwd: '/tmp' },
};

/** Desfaz o `shellLine`: palavras separadas por espaço, com aspas e escapes. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (char === '\\' && quoted) {
      current += line[++i];
    } else if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (char === ' ' && !quoted) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

test('todo comando do menu tem a sua tela: formulário, vista ou fluxo', () => {
  const kinds = Object.fromEntries(commands.filter((command) => command.menu).map((command) => [command.name, commandScreen(command.name, { ...DATA, integration: true }).kind]));
  assert.deepEqual(kinds, {
    preparar: 'form',
    criar: 'form',
    adicionar: 'form',
    especificar: 'form',
    refinar: 'form',
    capturar: 'form',
    credenciar: 'form',
    rodar: 'form',
    acompanhar: 'message',
    parar: 'form',
    decidir: 'decide',
    retomar: 'form',
    cancelar: 'form',
    entregar: 'form',
    rejeitar: 'form',
    conferir: 'view',
    detalhar: 'form',
    consultar: 'view',
    listar: 'view',
    auditar: 'form',
    pedir: 'form',
  });
  assert.equal(commandScreen('parar', { ...DATA, queueRunning: false }).kind, 'message');
  assert.equal(commandScreen('acompanhar', { ...DATA, background: true }).kind, 'terminal');
});

test('a linha de shell de cada formulário é o comando que o botão roda, aceito pelas opções dele', () => {
  for (const [name, build] of Object.entries(FORMS)) {
    const form = build(DATA);
    const values = { ...formState(form.config).values, ...SAMPLES[name] };
    assert.deepEqual(missingFields(form.config, values), [], `${name}: exemplo incompleto`);
    assert.equal(form.config.check?.(values) ?? null, null, name);
    const args = form.args(values);
    const line = form.config.shell?.(values) ?? '';
    assert.deepEqual(shellWords(line), ['mabel', name, ...args], `${name}: ${line}`);
    const command = findCommand(name);
    assert.ok(command, name);
    assert.doesNotThrow(() => parseArgs({ args, options: command.options ?? {}, allowPositionals: true }), `${name}: ${line}`);
    // A linha aparece na tela, quebrada quando não cabe.
    const screen = renderForm(form.config, formState(form.config, values), plainStyle, 60).join('\n');
    assert.match(screen, /\$ mabel /, name);
  }
});

test('linhas de shell do protótipo: campos vazios somem, condicionais seguem o que foi escolhido', () => {
  const shell = (name: string, values: FormValues) => {
    const form = (FORMS[name] as (data: ScreenData) => ReturnType<NonNullable<(typeof FORMS)[string]>>)(DATA);
    return form.config.shell?.({ ...formState(form.config).values, ...values });
  };
  assert.equal(shell('rodar', {}), 'mabel rodar');
  assert.equal(shell('rodar', { limite: '3', fundo: true }), 'mabel rodar --limite 3 --fundo');
  assert.equal(shell('rodar', { modo: 'item', limite: '3', item: '1' }), 'mabel rodar --item 1');
  assert.equal(shell('rodar', { modo: '--sem-lote' }), 'mabel rodar --sem-lote');
  assert.equal(shell('capturar', { tipo: 'api', nome: 'pedidos', url: 'https://x/openapi.json', escala: '3' }), 'mabel capturar api pedidos https://x/openapi.json');
  assert.equal(shell('capturar', { tipo: 'tela', nome: 'checkout', origem: 'https://www.figma.com/x', escala: '3' }), 'mabel capturar tela checkout https://www.figma.com/x --escala 3');
  assert.equal(shell('capturar', { tipo: 'tela', nome: 'checkout', origem: 'tela.png', escala: '3' }), 'mabel capturar tela checkout tela.png');
  assert.equal(shell('auditar', { projeto: 'loja-api' }), 'mabel auditar loja-api');
  assert.equal(shell('retomar', { item: '3' }), 'mabel retomar 3');
  assert.equal(shell('adicionar', { title: 'Exportar', intent: 'Abrir no Excel' }), 'mabel adicionar Exportar --intencao "Abrir no Excel"');
});

test('formulários: campos e botões do protótipo, condicionais e vermelho no que apaga', () => {
  const labels = (name: string, values: FormValues = {}) => {
    const config = (FORMS[name] as NonNullable<(typeof FORMS)[string]>)(DATA).config;
    return renderForm(config, formState(config, values), plainStyle, 100).join('\n');
  };
  const run = labels('rodar');
  assert.match(run, /Modo +◂ fila inteira: planeja todos, depois executa ▸/);
  assert.match(run, /Quantos itens +todos os prontos/);
  assert.doesNotMatch(run, /Item +escolher/);
  assert.match(run, /Em segundo plano +\[ \] não/);
  assert.match(run, /\[ Rodar \]/);
  assert.match(labels('rodar', { modo: 'item' }), /Item +escolher \(obrigatório\)[\s\S]*falta: Item/);
  assert.match(labels('retomar', { item: '3' }), /motivo: run de executar falhou: timeout/);
  assert.match(labels('retomar'), /Orientação +opcional: o que mudou ou o que tentar agora/);
  assert.match(labels('adicionar'), /falta: Título, Intenção/);
  assert.match(labels('auditar', { remover: true }), /Confirme o nome +digite o nome do projeto/);
  assert.doesNotMatch(labels('auditar'), /Confirme o nome/);
  assert.match(labels('capturar', { tipo: 'api' }), /Endereço/);
  assert.doesNotMatch(labels('capturar', { tipo: 'api' }), /Escala da imagem|Link do Figma/);
  assert.match(labels('capturar'), /Link do Figma ou arquivo PNG/);
  assert.doesNotMatch(labels('capturar', { origem: 'tela.png' }), /Escala da imagem/);
  assert.match(labels('capturar', { origem: 'https://www.figma.com/x' }), /Escala da imagem/);
  const red = { ...plainStyle, red: (text: string) => `<r>${text}</r>` };
  const button = (name: string, values: FormValues) => {
    const config = (FORMS[name] as NonNullable<(typeof FORMS)[string]>)(DATA).config;
    return renderForm(config, formState(config, values), red, 100).join('\n');
  };
  assert.match(button('cancelar', { item: '1' }), /<r>\[ Cancelar o item \]<\/r>/);
  assert.match(button('rejeitar', { item: '4', motivo: 'x' }), /<r>\[ Rejeitar \]<\/r>/);
  assert.match(button('auditar', { projeto: 'loja-api', remover: true, confirma: 'loja-api' }), /<r>\[ Auditar \]<\/r>/);
  assert.doesNotMatch(button('auditar', { projeto: 'loja-api' }), /<r>/);
  // Parar a fila: o botão "Parar depois da etapa", com a etapa em andamento.
  const stop = stopForm({ ...DATA, items: [item(14, 'executing')] }).config;
  assert.match(renderForm(stop, formState(stop), plainStyle, 100).join('\n'), /termina a etapa em andamento \(#14 executar\)[\s\S]*\[ Parar depois da etapa \]/);
});

test('telas emolduradas: as duas linhas do topo, o título e o rodapé com teclas e saldo', () => {
  const config = (FORMS.retomar as NonNullable<(typeof FORMS)[string]>)(DATA).config;
  const lines = frame(CONTEXT, renderForm(config, formState(config), plainStyle, 100).slice(0, -2), [['↑↓', 'campos']], plainStyle, 100, 30);
  assert.equal(lines.length, 30);
  assert.match(lines[1] ?? '', /mabel v2\.1\.0 {2}loja-api · ~\/Pessoal\/loja-api/);
  assert.match(lines[2] ?? '', /2 prontos · 1 esperando você/);
  assert.match(lines[4] ?? '', /‹ Retomar um item +mabel retomar/);
  assert.match(lines[5] ?? '', /Devolve à fila um item parado/);
  assert.match(lines.at(-2) ?? '', /↑↓ campos/);
  assert.match(lines.at(-1) ?? '', /saldo/);

  const result = renderResult(CONTEXT, { title: '✓ Retomar', lines: outputLines('#3 voltou para pronto.\n'), shell: 'mabel retomar 3' }, 0, plainStyle, 100, 30);
  const text = result.lines.join('\n');
  assert.match(text, /‹ ✓ Retomar/);
  assert.match(text, / {2}#3 voltou para pronto\./);
  assert.match(text, /\$ mabel retomar 3/);
  assert.match(result.lines.at(-2) ?? '', /enter volta ao menu {2}esc volta ao menu/);
  assert.equal(result.overflow, 0);
  const long = renderResult(CONTEXT, { title: 'Consultar as runs', command: 'consultar', lines: Array.from({ length: 60 }, (_, i) => `  run ${i}`) }, 0, plainStyle, 100, 30);
  assert.ok(long.overflow > 0);
  assert.match(long.lines.join('\n'), /↓ mais \d+/);
  assert.match(long.lines.at(-2) ?? '', /↑↓ rola/);
  assert.deepEqual([...long.lines, ...text.split('\n')].flatMap(guidedProblems), []);
});

test('Decidir as pendências abre com "Passar por todas" e as pendências com o estado à direita', () => {
  const choice = pendingChoice([item(13, 'needs_human', { pendingKind: 'question_plan' }), item(17, 'needs_human', { pendingKind: 'critical_approval' })]);
  assert.deepEqual(
    choice.options.map((option) => [option.label, option.chip?.text]),
    [
      ['Passar por todas (2)', undefined],
      ['#13  Item 13', 'esperando você'],
      ['#17  Item 17', 'aguardando aprovação'],
    ],
  );
});

test('linha longa quebra sem partir a cor', () => {
  assert.deepEqual(wrapLine('abcdef', 4), ['abcd', 'ef']);
  assert.deepEqual(wrapLine('\x1b[2mabcdef\x1b[0m', 4), ['\x1b[2mabcd\x1b[0m', '\x1b[2mef\x1b[0m']);
});

/** O mesmo comando pelo botão (no processo, sem perguntas) e pela linha de shell (outro processo, sem TTY). */
async function buttonAndShell(backlog: string, prepare: (p: ReturnType<typeof setupProject>) => void, name: string, values: FormValues) {
  const button = setupProject(backlog);
  const shell = setupProject(backlog);
  syncBacklog(button.db, button.project);
  syncBacklog(shell.db, shell.project);
  prepare(button);
  prepare(shell);
  const form = (FORMS[name] as NonNullable<(typeof FORMS)[string]>)(DATA);
  const args = form.args({ ...formState(form.config).values, ...values });
  const words = shellWords(form.config.shell?.({ ...formState(form.config).values, ...values }) ?? '');
  const cwd = process.cwd();
  const home = process.env.MABEL_HOME;
  process.chdir(button.root);
  process.env.MABEL_HOME = button.home;
  let pressed;
  try {
    pressed = await captureRun(findCommand(name) as NonNullable<ReturnType<typeof findCommand>>, args);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.MABEL_HOME;
    else process.env.MABEL_HOME = home;
  }
  const typed = shell.cli(...words.slice(1));
  return { button, shell, pressed, typed };
}

test('o botão faz o mesmo que a linha de shell fora do TTY: adicionar, cancelar e retomar', async () => {
  const added = await buttonAndShell('', () => {}, 'adicionar', SAMPLES.adicionar as FormValues);
  assert.equal(added.pressed.code, added.typed.status, added.pressed.output);
  assert.equal(added.pressed.output, added.typed.stdout + added.typed.stderr);
  assert.match(added.pressed.output, /Item #1 adicionado: Exportar pedidos/);
  assert.equal(readFileSync(added.button.path, 'utf8'), readFileSync(added.shell.path, 'utf8'));

  const backlog = '\n## A\nprimeiro\n\n## B\nsegundo\n';
  const cancelled = await buttonAndShell(backlog, () => {}, 'cancelar', { item: '2' });
  assert.equal(cancelled.pressed.code, 0);
  assert.equal(cancelled.pressed.output, cancelled.typed.stdout);
  assert.equal(getItem(cancelled.button.db, cancelled.button.project.id, 2)?.status, 'cancelled');
  assert.equal(getItem(cancelled.shell.db, cancelled.shell.project.id, 2)?.status, 'cancelled');

  const fail = (p: ReturnType<typeof setupProject>) => {
    const target = getItem(p.db, p.project.id, 1) as Item;
    transition(p.db, p.project, target.id, 'planning', 'teste');
    transition(p.db, p.project, target.id, 'failed', 'run de planejar falhou: timeout');
  };
  const resumed = await buttonAndShell(backlog, fail, 'retomar', { item: '1', orientacao: 'tente de novo' });
  assert.equal(resumed.pressed.code, 0, resumed.pressed.output);
  assert.equal(resumed.pressed.output, resumed.typed.stdout);
  assert.match(resumed.pressed.output, /#1 voltou para pronto/);
  for (const p of [resumed.button, resumed.shell]) assert.equal(getItem(p.db, p.project.id, 1)?.status, 'ready');
});

test('retomar: falha volta a pronto com o motivo e a orientação para o planejamento; formato no backlog não se retoma', () => {
  const p = setupProject('\n## A\nprimeiro\n\n## B\nsegundo\n');
  syncBacklog(p.db, p.project);
  const first = getItem(p.db, p.project.id, 1) as Item;
  transition(p.db, p.project, first.id, 'planning', 'teste');
  updateItem(p.db, first.id, { attempts: 2 });
  transition(p.db, p.project, first.id, 'failed', 'plano.json não encontrado');
  assert.equal(resume(p.db, p.project, getItem(p.db, p.project.id, 1) as Item, 'confira o esquema'), 'ready');
  const after = getItem(p.db, p.project.id, 1) as Item;
  assert.equal(after.attempts, 0);
  assert.equal(after.nextInput?.resumed, true);
  assert.match(after.nextInput?.answer ?? '', /O item parou \(falha\): plano\.json não encontrado\.\nOrientação do humano: confira o esquema/);
  assert.throws(() => resume(p.db, p.project, after), /não está parado por falha ou bloqueio/);

  const second = getItem(p.db, p.project.id, 2) as Item;
  transition(p.db, p.project, second.id, 'blocked', 'formato: falta a intenção');
  assert.throws(() => resume(p.db, p.project, getItem(p.db, p.project.id, 2) as Item), /formato no backlog/);
  updateItem(p.db, second.id, {});
  p.db.prepare('UPDATE items SET status_reason = ? WHERE id = ?').run('worktree: não foi possível criar', second.id);
  assert.equal(resume(p.db, p.project, getItem(p.db, p.project.id, 2) as Item), 'ready');
  assert.deepEqual(
    (p.db.prepare("SELECT reason FROM item_transitions WHERE reason LIKE 'humano:%' ORDER BY rowid").all() as { reason: string }[]).map((row) => row.reason),
    ['humano: retomar: confira o esquema', 'humano: retomar'],
  );
});

test('rodar --limite: valida o número e não combina com --item', () => {
  const p = setupProject('\n## A\nprimeiro\n');
  const zero = p.cli('rodar', '--limite', '0');
  assert.equal(zero.status, 1);
  assert.match(zero.stderr, /--limite precisa ser um número inteiro maior que zero/);
  const both = p.cli('rodar', '--limite', '1', '--item', '1');
  assert.equal(both.status, 1);
  assert.match(both.stderr, /Use --item ou --limite, não os dois/);
  assert.equal(p.cli('rodar', '--uma').status, 1, 'o --uma saiu');
});

test('campo de escolha longo: a lista rola dentro da tela cheia e filtra ao digitar, sem perder as marcadas', () => {
  const config: FormConfig = {
    title: 'Adicionar um item',
    fields: [
      {
        type: 'pick',
        key: 'references',
        label: 'Referências',
        multi: true,
        options: () => Array.from({ length: 40 }, (_, i) => ({ value: `tela-${i + 1}`, label: `tela-${i + 1}` })),
      },
    ],
    action: 'Adicionar',
  };
  let state: FormState = formState(config);
  const press = (...keys: { name?: string; sequence?: string }[]) => {
    for (const key of keys) {
      const step = formStep(config, state, key);
      assert.ok('state' in step);
      state = step.state;
    }
  };
  const screen = () => frame(CONTEXT, formBody(config, state, plainStyle, 100, bodyRows(20)), [], plainStyle, 100, 20);

  press({ name: 'return' }, { name: 'space' }, ...Array.from({ length: 29 }, () => ({ name: 'down' })));
  const scrolled = screen();
  assert.equal(scrolled.length, 20);
  assert.ok(scrolled.some((line) => /› \[ \] tela-30\b/.test(line)), 'o cursor continua à vista');
  assert.ok(scrolled.some((line) => /↑ mais \d+/.test(line)));
  assert.ok(scrolled.some((line) => /↓ mais \d+/.test(line)));

  press(...[...'tela-4'].map((sequence) => ({ sequence })));
  const filtered = screen().join('\n');
  assert.match(filtered, /› tela-4▏/);
  assert.match(filtered, /› \[ \] tela-4\b/);
  assert.doesNotMatch(filtered, /tela-30/);
  press({ name: 'space' }, { name: 'escape' }, { name: 'return' });
  assert.deepEqual(state.values.references, ['tela-1', 'tela-4']);
});
