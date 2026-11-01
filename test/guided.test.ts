import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ruleChangeForm } from '../src/engine.ts';
import { EMPTY_DATA, FORMS, stopForm } from '../src/forms.ts';
import { removalForm } from '../src/projects.ts';
import {
  type FormConfig,
  type Hint,
  UNIVERSAL_KEYS,
  choiceHints,
  choiceState,
  formHints,
  formState,
  listHints,
  listState,
  plainStyle,
  renderChoice,
  renderForm,
  renderList,
  renderText,
  renderView,
  TEXT_HINTS,
  textState,
  VIEW_HINTS,
} from '../src/screens.ts';
import { guidedProblems } from './helpers.ts';

/**
 * Critério de aceite de `docs/specs/terminal.md`: nenhuma mensagem do modo interativo pede
 * tecla com significado próprio, `[s/N]` ou texto com sintaxe, e o rodapé só cita as teclas
 * universais.
 */

const SRC = join(import.meta.dirname, '..', 'src');

/** Textos entre aspas de um arquivo, sem os comentários. */
function literals(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)].map((match) => match[0]);
}

test('nenhum texto do código pede tecla com significado próprio, [s/N] ou sintaxe', () => {
  const problems: string[] = [];
  for (const file of readdirSync(SRC).filter((name) => name.endsWith('.ts'))) {
    for (const text of literals(readFileSync(join(SRC, file), 'utf8'))) {
      for (const problem of guidedProblems(text)) problems.push(`${file}: ${problem}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('o teste acha os padrões antigos', () => {
  for (const old of [
    'Cancelar o item #3? [s/N] ',
    'Retomar a esteira agora? [S/n] ',
    'Gravar? [S/n/d] (n deixa a proposta pendente · d descarta) ',
    'enter aceita · e edita um a um · - descarta',
    'enter mantém · - remove · texto novo substitui',
    'acrescente outros, um por linha (linha vazia encerra)',
    'enter aceita · texto responde · d decide você · p pula o item',
    '↑/↓ navegar · enter escolher · q sair',
    'Número do item: ',
    'Continue a conversa; sair ou Ctrl+D encerra.',
  ]) {
    assert.notDeepEqual(guidedProblems(old), [], old);
  }
});

const ALL_FORMS: FormConfig[] = [
  ...Object.values(FORMS).map((build) => build(EMPTY_DATA).config),
  stopForm(EMPTY_DATA).config,
  removalForm('loja-api'),
  ruleChangeForm('Nova alteração nas regras vigentes'),
];

function assertUniversal(hints: Hint[]) {
  for (const [key] of hints) assert.ok((UNIVERSAL_KEYS as readonly string[]).includes(key), `tecla fora das universais: ${key}`);
}

test('rodapé de toda tela: só teclas universais, cada uma com o que faz', () => {
  assertUniversal(TEXT_HINTS);
  assertUniversal(VIEW_HINTS);
  for (const config of [{ options: [] }, { options: [], multi: true, filter: true, back: true }]) assertUniversal(choiceHints(config));
  const list = listState(['um']);
  for (const state of [list, { ...list, actions: 0 }, { ...list, edit: { index: 0, text: textState('um') } }]) {
    assertUniversal(listHints({ entryActions: true }, state));
  }
  for (const form of ALL_FORMS) {
    const state = formState(form);
    assertUniversal(formHints(form, state));
    assertUniversal(formHints(form, { ...state, edit: { key: 'x', text: textState() } }));
  }
});

test('telas desenhadas: sem padrões proibidos', () => {
  const screens = [
    ...ALL_FORMS.map((form) => renderForm(form, formState(form), plainStyle)),
    renderChoice({ options: [{ label: 'Gravar' }, { label: 'Descartar a proposta', danger: true }], back: true }, choiceState(), plainStyle),
    renderChoice({ options: [], multi: true, filter: true }, choiceState(), plainStyle),
    renderList({ entryActions: true }, { ...listState(['um']), actions: 1 }, plainStyle),
    renderText({ label: 'Resposta', placeholder: 'sua resposta' }, textState(), plainStyle),
    renderView('Conferir o estado', ['  Fila  parada'], plainStyle),
  ];
  assert.deepEqual(screens.flat().flatMap(guidedProblems), []);
});
