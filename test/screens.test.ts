import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addForm, addShell, fieldsFromForm } from '../src/add.ts';
import { cancelForm, rejectForm } from '../src/decide.ts';
import { answerQuestion, confirmAction, reviewEntries } from '../src/guided.ts';
import type { Key } from '../src/menu.ts';
import { removalForm } from '../src/projects.ts';
import {
  type ChoiceConfig,
  type ChoiceStep,
  type FormConfig,
  type FormState,
  type ListState,
  type TextState,
  choiceState,
  choiceStep,
  formState,
  formStep,
  listState,
  listStep,
  plainStyle,
  renderChoice,
  renderForm,
  renderKeys,
  renderList,
  renderText,
  renderView,
  shellLine,
  textState,
  textStep,
  viewStep,
} from '../src/screens.ts';
import { scriptedGuided } from './helpers.ts';

const keys = (...names: string[]): Key[] => names.map((name) => (name.length === 1 && name !== ' ' ? { sequence: name } : { name }));
const typing = (text: string): Key[] => [...text].map((sequence) => ({ sequence }));

// Escolha --------------------------------------------------------------------------------

const MENU: ChoiceConfig = {
  options: [{ label: 'Aceitar tudo' }, { label: 'Revisar um a um' }, { label: 'Descartar', danger: true }, { label: 'Outra', disabledReason: 'indisponível agora' }],
};

function cursorOf(step: ChoiceStep): number {
  assert.ok('state' in step);
  return step.state.cursor;
}

test('escolha: setas movem e dão a volta, enter escolhe, opção indisponível mostra o motivo', () => {
  assert.equal(cursorOf(choiceStep(MENU, choiceState(0), { name: 'down' })), 1);
  assert.equal(cursorOf(choiceStep(MENU, choiceState(0), { name: 'up' })), 3);
  assert.equal(cursorOf(choiceStep(MENU, choiceState(3), { name: 'down' })), 0);
  assert.deepEqual(choiceStep(MENU, choiceState(1), { name: 'return' }), { chosen: 1 });
  const blocked = choiceStep(MENU, choiceState(3), { name: 'return' });
  assert.ok('state' in blocked);
  assert.equal(blocked.state.message, 'indisponível agora');
});

test('escolha: só teclas universais; letras, números, q e esc sem "voltar" não fazem nada', () => {
  for (const key of [...typing('q2jk'), { name: 'escape' }, { name: 'space' }]) {
    const step = choiceStep(MENU, choiceState(1), key);
    assert.ok('state' in step, JSON.stringify(key));
    assert.equal(step.state.cursor, 1);
  }
  assert.deepEqual(choiceStep({ ...MENU, back: true }, choiceState(1), { name: 'escape' }), { back: true });
});

test('escolha: digitar filtra, sem acento e sem caixa; esc limpa o filtro antes de voltar', () => {
  const config: ChoiceConfig = { options: [{ label: '#3  Exportação' }, { label: '#4  Login', chip: { text: 'pronto' } }], filter: true, back: true };
  let state = choiceState();
  for (const key of typing('EXPORTA')) {
    const step = choiceStep(config, state, key);
    assert.ok('state' in step);
    state = step.state;
  }
  assert.deepEqual(choiceStep(config, state, { name: 'return' }), { chosen: 0 });
  const cleared = choiceStep(config, state, { name: 'escape' });
  assert.ok('state' in cleared);
  assert.equal(cleared.state.filter, '');
  const lines = renderChoice(config, choiceState(1), plainStyle, 40);
  assert.match(lines.join('\n'), /› #4 {2}Login +pronto/);
});

test('escolha: lista vazia diz que não há item no estado', () => {
  assert.match(renderChoice({ options: [] }, choiceState(), plainStyle).join('\n'), /Nenhum item nesse estado agora\./);
});

test('escolha: rodapé com as teclas que funcionam, sem "q sair" nem números', () => {
  const lines = renderChoice(MENU, choiceState(0), plainStyle, 50);
  assert.equal(lines.at(-1), ' ↑↓ navegar  enter escolher ');
  assert.match(lines[0] ?? '', /^ {2}› Aceitar tudo/);
  assert.equal(lines[1], '    Revisar um a um');
  assert.equal(renderChoice({ ...MENU, back: true }, choiceState(0), plainStyle).at(-1), ' ↑↓ navegar  enter escolher  esc volta ');
});

// Campo de texto -------------------------------------------------------------------------

function typeInto(state: TextState, keyList: Key[]) {
  let current = state;
  for (const key of keyList) {
    const step = textStep(current, key);
    if (!('state' in step)) return step;
    current = step.state;
  }
  return current;
}

test('campo de texto: já preenchido, edita no cursor, enter confirma sem espaços nas pontas, esc cancela', () => {
  const state = typeInto(textState('Ponto'), [...typing(' e vírgula  ')]);
  assert.deepEqual(textStep(state as TextState, { name: 'return' }), { done: 'Ponto e vírgula' });
  const moved = typeInto(textState('abc'), [{ name: 'left' }, { name: 'backspace' }, ...typing('X')]);
  assert.deepEqual(moved, { text: 'aXc', cursor: 2 });
  assert.deepEqual(textStep(textState('abc'), { name: 'escape' }), { cancel: true });
  assert.deepEqual(typeInto(textState(''), [{ sequence: 'colado de uma vez' }]), { text: 'colado de uma vez', cursor: 17 });
  const lines = renderText({ label: 'Resposta', placeholder: 'sua resposta' }, textState(), plainStyle);
  assert.match(lines[0] ?? '', /› Resposta +▏sua resposta/);
  assert.equal(lines.at(-1), ' enter confirma  esc cancela ');
});

// Lista repetível ------------------------------------------------------------------------

function listRun(config: { entryActions?: boolean }, entries: string[], keyList: Key[]): ListState | string[] {
  let state = listState(entries);
  for (const key of keyList) {
    const step = listStep(config, state, key);
    if ('done' in step) return step.done;
    state = step.state;
  }
  return state;
}

test('lista repetível: "+ adicionar" acrescenta, enter edita a entrada, vazia a remove, esc conclui', () => {
  assert.deepEqual(listRun({}, ['um'], [{ name: 'down' }, { name: 'return' }, ...typing('dois'), { name: 'return' }, { name: 'escape' }]), ['um', 'dois']);
  const emptied = [{ name: 'return' }, ...Array.from({ length: 2 }, () => ({ name: 'backspace' })), { name: 'return' }, { name: 'escape' }];
  assert.deepEqual(listRun({}, ['um', 'dois'], emptied), ['dois']);
  assert.deepEqual(listRun({}, ['um'], [{ name: 'return' }, ...typing('!'), { name: 'escape' }, { name: 'escape' }]), ['um']);
  const lines = renderList({}, listState(['um']), plainStyle, 40);
  assert.deepEqual(lines.slice(0, 2), ['  › um                                  ', '    + adicionar']);
  assert.equal(lines.at(-1), ' ↑↓ navegar  enter editar  esc conclui ');
});

test('lista repetível na revisão: enter abre Manter, Editar, Remover; Editar abre o campo preenchido', () => {
  const opened = listRun({ entryActions: true }, ['um', 'dois'], [{ name: 'return' }]);
  assert.ok(!Array.isArray(opened));
  assert.equal(opened.actions, 0);
  assert.match(renderList({ entryActions: true }, opened, plainStyle).join('\n'), /um\n {2}› {5}Manter *\n {8}Editar\n {8}Remover/);
  assert.deepEqual(listRun({ entryActions: true }, ['um', 'dois'], keys('return', 'down', 'down', 'return', 'escape')), ['dois']);
  const edited = listRun({ entryActions: true }, ['um'], [...keys('return', 'down', 'return'), ...typing('!'), ...keys('return', 'escape')]);
  assert.deepEqual(edited, ['um!']);
});

// Formulário -----------------------------------------------------------------------------

const FORM: FormConfig = {
  title: 'Rodar a fila',
  description: 'Planeja os itens prontos e depois executa um por um.',
  command: 'rodar',
  fields: [
    { type: 'choice', key: 'modo', label: 'Modo', options: [['', 'fila inteira'], ['item', 'só um item']] },
    { type: 'text', key: 'limite', label: 'Quantos itens', placeholder: 'todos os prontos', when: (v) => v.modo !== 'item' },
    {
      type: 'pick',
      key: 'item',
      label: 'Item',
      required: true,
      when: (v) => v.modo === 'item',
      options: () => [{ value: '14', label: '#14  Histórico', chip: { text: 'pronto', tone: 'green' } }],
    },
    { type: 'bool', key: 'fundo', label: 'Em segundo plano' },
  ],
  action: 'Rodar',
  shell: (v) => shellLine(['mabel', 'rodar', ...(v.item ? ['--item', String(v.item)] : []), ...(v.fundo ? ['--fundo'] : [])]),
};

function formRun(config: FormConfig, keyList: Key[], start: FormState = formState(config)) {
  let state = start;
  for (const key of keyList) {
    const step = formStep(config, state, key);
    if (!('state' in step)) return step;
    state = step.state;
  }
  return state;
}

test('formulário: ← → trocam a escolha, campo condicional aparece, espaço marca, item escolhido na lista', () => {
  const state = formRun(FORM, [{ name: 'right' }, { name: 'down' }, { name: 'return' }, { name: 'return' }, { name: 'down' }, { name: 'space' }]) as FormState;
  assert.deepEqual(state.values, { modo: 'item', fundo: true, item: '14' });
  const text = renderForm(FORM, state, plainStyle, 88).join('\n');
  assert.match(text, /‹ Rodar a fila +mabel rodar/);
  assert.match(text, /Modo +◂ só um item ▸/);
  assert.doesNotMatch(text, /Quantos itens/);
  assert.match(text, /Item +#14 {2}Histórico +▸/);
  assert.match(text, /› Em segundo plano +\[x\] sim/);
  assert.match(text, /\$ mabel rodar --item 14 --fundo/);
  assert.match(text, / ↑↓ campos {2}enter editar {2}←→ opções {2}espaço marca {2}esc volta $/);
});

test('formulário: botão esmaecido com "falta:", enter nele avisa; preenchido, envia os valores', () => {
  const start = formState(FORM, { modo: 'item' });
  const atButton = formRun(FORM, [{ name: 'up' }], start) as FormState;
  assert.match(renderForm(FORM, atButton, plainStyle).join('\n'), /› \[ Rodar \] +falta: Item/);
  const warned = formRun(FORM, [{ name: 'return' }], atButton) as FormState;
  assert.equal(warned.message, 'Preencha antes: Item.');
  assert.deepEqual(formRun(FORM, [{ name: 'return' }], { ...atButton, values: { ...atButton.values, item: '14' } }), {
    submit: { modo: 'item', fundo: false, item: '14' },
  });
  assert.deepEqual(formRun(FORM, [{ name: 'escape' }]), { back: true });
});

test('formulário: digitar num campo de texto já começa a editar; esc cancela a edição sem perder o valor', () => {
  const typed = formRun(FORM, [{ name: 'down' }, ...typing('3'), { name: 'return' }]) as FormState;
  assert.equal(typed.values.limite, '3');
  const cancelled = formRun(FORM, [{ name: 'return' }, ...typing('9'), { name: 'escape' }], typed) as FormState;
  assert.equal(cancelled.values.limite, '3');
});

test('formulário: lista repetível abre as entradas com "+ adicionar" e volta com esc', () => {
  const form = addForm([], []);
  const state = formRun(form, [...keys('down', 'down', 'return', 'return'), ...typing('Uma linha por pedido'), ...keys('return')]) as FormState;
  const sub = renderForm(form, state, plainStyle).join('\n');
  assert.match(sub, /‹ Adicionar um item › Critérios de aceite/);
  assert.match(sub, /enter edita; deixe vazio para remover/);
  // Como no protótipo, o cursor fica na entrada que acabou de entrar.
  assert.match(sub, /› Uma linha por pedido *\n {4}\+ adicionar/);
  const back = formRun(form, [{ name: 'escape' }], state) as FormState;
  assert.deepEqual(back.values.criteria, ['Uma linha por pedido']);
  assert.match(renderForm(form, back, plainStyle).join('\n'), /Critérios de aceite +1 critério/);
});

test('Adicionar um item: campos do protótipo, linha de shell e os campos do backlog', () => {
  const form = addForm([], []);
  assert.deepEqual(
    form.fields.map((field) => (field.type === 'info' ? '' : field.label)),
    ['Título', 'Intenção', 'Critérios de aceite', 'Fora do escopo', 'Depende de', 'Restrições'],
  );
  const values = { title: 'Exportar pedidos', intent: 'Abrir no Excel', criteria: ['Uma linha por pedido'], dependsOn: ['2'], restrictions: '' };
  assert.equal(addShell(values), 'mabel adicionar "Exportar pedidos" --intencao "Abrir no Excel" --criterio "Uma linha por pedido" --depende 2');
  assert.deepEqual(fieldsFromForm(values), {
    title: 'Exportar pedidos',
    intent: 'Abrir no Excel',
    criteria: ['Uma linha por pedido'],
    dependsOn: [2],
    restrictions: null,
    outOfScope: [],
    decisions: [],
    criticalConcepts: [],
    references: [],
  });
});

test('ações que apagam: botão vermelho em cancelar e rejeitar; remover projeto confere o nome digitado', () => {
  const red = { ...plainStyle, red: (text: string) => `<r>${text}</r>` };
  const filled = (form: FormConfig, values: Record<string, string>) => renderForm(form, { ...formState(form, values), cursor: 9 }, red, 88).join('\n');
  assert.match(filled(cancelForm([]), { item: '3' }), /<r>\[ Cancelar o item \]<\/r>/);
  assert.match(filled(rejectForm([]), { item: '3', motivo: 'quebrou' }), /<r>\[ Rejeitar \]<\/r>/);
  const removal = removalForm('loja-api');
  const wrong = formRun(removal, [{ name: 'return' }, ...typing('loja'), { name: 'return' }, { name: 'down' }, { name: 'return' }]) as FormState;
  assert.equal(wrong.message, 'O nome digitado não confere com o projeto escolhido.');
  assert.deepEqual(formRun(removal, [...typing('-api'), { name: 'return' }, { name: 'down' }, { name: 'return' }], { ...wrong, cursor: 0 }), { submit: { confirma: 'loja-api' } });
  assert.match(renderForm(removal, wrong, plainStyle).join('\n'), /\$ mabel auditar remover loja-api --confirmar loja/);
});

// Vista e rodapé -------------------------------------------------------------------------

test('vista: só leitura, enter ou esc voltam', () => {
  assert.deepEqual(viewStep({ name: 'return' }), { done: true });
  assert.deepEqual(viewStep({ name: 'escape' }), { done: true });
  assert.deepEqual(viewStep({ sequence: 'q' }), { state: null });
  const lines = renderView('Conferir o estado', ['  Fila    parada'], plainStyle, 60, 'conferir');
  assert.match(lines[0] ?? '', /^ {2}‹ Conferir o estado +mabel conferir {2}$/);
  assert.equal(lines.at(-1), ' enter volta  esc volta ');
});

test('rodapé: separador e as teclas, cada uma com o que faz', () => {
  assert.deepEqual(renderKeys([['↑↓', 'navegar'], ['enter', 'abrir']], plainStyle, 10), ['─────────', ' ↑↓ navegar  enter abrir ']);
});

// Padrões de conversão -------------------------------------------------------------------

test('[s/N] vira dois itens com o seguro selecionado; esc escolhe "Voltar"', async () => {
  const chosen: { initial?: number; back?: number }[] = [];
  const io = { ...scriptedGuided(['Voltar']) };
  const original = io.choose;
  io.choose = async (options, settings) => {
    chosen.push(settings ?? {});
    return original(options, settings);
  };
  assert.equal(await confirmAction(io, 'Cancelar o item', { danger: true }), false);
  assert.deepEqual(chosen, [{ initial: 1, back: 1 }]);
  assert.equal(await confirmAction(scriptedGuided(['Retomar']), 'Retomar a esteira agora', { actionFirst: true }), true);
});

test('pergunta com sugestão: menu de quatro opções; "Responder" cancelado volta ao menu', async () => {
  const io = scriptedGuided(['Responder', null, 'Responder', 'Não', 'Pular por agora']);
  assert.deepEqual(await answerQuestion(io, { sugestao: 'Sim', delegate: true, skip: 'Pular por agora' }), { answer: 'Não' });
  assert.equal(io.prompts[0], 'Aceitar a sugestão | Responder com outro texto | Deixar o agente decidir | Pular por agora');
  assert.deepEqual(await answerQuestion(io, { skip: 'Pular por agora' }), { skip: true });
});

test('revisão um a um: Manter, Editar (campo preenchido), Remover; depois a lista para acrescentar', async () => {
  const io = scriptedGuided(['Manter', 'Editar', 'dois!', 'Remover', ['quatro']]);
  assert.deepEqual(await reviewEntries(io, ['um', 'dois', 'três']), { kept: ['um', 'dois!', 'quatro'], renamed: new Map([['dois', 'dois!']]) });
  assert.deepEqual(io.prompts, ['Manter | Editar | Remover', 'Manter | Editar | Remover', 'Novo texto', 'Manter | Editar | Remover', 'Acrescentar outros']);
});
