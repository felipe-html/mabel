import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKLOG_TEMPLATE, insertIds, parseBacklog, renderItemBlock, validateBacklog } from '../src/backlog.ts';
import { getItem, listItems, syncBacklog, transition } from '../src/items.ts';
import { setupProject } from './helpers.ts';

/** Campos do item, sem as posições no texto e sem os campos de spec e de regras vigentes quando vazios (S.3, S.4). */
function fields(text: string) {
  return parseBacklog(text).map(({ headingEnd: _, start: __, contentEnd: ___, spec, rules, kind, ruleChanges, ...item }) => ({
    ...item,
    ...(spec ? { spec } : {}),
    ...(rules.length > 0 ? { rules } : {}),
    ...(kind ? { kind } : {}),
    ...(ruleChanges.length > 0 ? { ruleChanges } : {}),
  }));
}

test('parser: item mínimo, recomendado e completo, na ordem do arquivo', () => {
  const text = `# Backlog

<!-- comentário com um falso item:
## Não é item
-->

## Mínimo
id: 1
Só a intenção.

## Recomendado
Quero baixar a lista.
Em duas linhas.

Critérios:
- Uma linha por pedido
- Vírgula decimal <!-- comentário no fim da linha -->

## Completo
id: 3
Intenção completa.

Critérios:
- C1

Depende de: 1, #2
Restrições: sem bibliotecas novas
`;
  assert.deepEqual(fields(text), [
    {
      title: 'Mínimo', number: 1, intent: 'Só a intenção.', criteria: [], dependsOn: [], restrictions: null,
      outOfScope: [], decisions: [], criticalConcepts: [], references: [], position: 0, errors: [],
    },
    {
      title: 'Recomendado', intent: 'Quero baixar a lista.\nEm duas linhas.',
      criteria: ['Uma linha por pedido', 'Vírgula decimal'], dependsOn: [], restrictions: null,
      outOfScope: [], decisions: [], criticalConcepts: [], references: [], position: 1, errors: [],
    },
    {
      title: 'Completo', number: 3, intent: 'Intenção completa.', criteria: ['C1'], dependsOn: [1, 2],
      restrictions: 'sem bibliotecas novas', outOfScope: [], decisions: [], criticalConcepts: [], references: [], position: 2, errors: [],
    },
  ]);
});

test('parser: cada erro de formato fica no item, sem derrubar o resto', () => {
  const items = parseBacklog(`## A
id: 1
a
Depende de: 2

## B
id: 2
b
Depende de: 1

##
id: 3
sem título

## D
id: 1
duplicado

## E
id: 5
Depende de: 9, x

## F
id: 6
ok
`);
  validateBacklog(items);
  assert.deepEqual(
    items.map((item) => item.errors),
    [
      ['id 1 duplicado no backlog', 'dependência circular: #1 → #2 → #1'],
      ['dependência circular: #1 → #2 → #1'],
      ['item sem título'],
      ['id 1 duplicado no backlog'],
      ['dependência inválida: "x"', 'depende de #9, que não existe'],
      [],
    ],
  );
});

test('atribuição de id não altera nenhum outro byte do arquivo', () => {
  const text = '# Backlog\r\n\n## Um\nintenção  \n\n\n## Dois\n## Três';
  const items = parseBacklog(text);
  const result = insertIds(text, items.map((item, i) => ({ headingEnd: item.headingEnd, number: i + 7 })));
  assert.equal(result, '# Backlog\r\n\n## Um\nid: 7\nintenção  \n\n\n## Dois\nid: 8\n## Três\nid: 9');
  assert.deepEqual(
    parseBacklog(result).map((item) => [item.title, item.number]),
    [['Um', 7], ['Dois', 8], ['Três', 9]],
  );
});

test('renderItemBlock gera um bloco que o parser lê de volta', () => {
  const item = {
    number: 4, title: 'Filtro por data', intent: 'Filtrar pedidos.', criteria: ['De e até'], dependsOn: [2, 3],
    restrictions: 'sem SQL novo', outOfScope: ['Filtro por hora'], decisions: ['Fuso? → o da loja'],
    criticalConcepts: ['Preço de venda'], references: ['tela: cadastro', 'api: acessos POST /v1/acessos'],
  };
  const [parsed] = fields(renderItemBlock(item));
  assert.deepEqual(parsed, { ...item, position: 0, errors: [] });
});

test('add não interativo gera um bloco que o parser lê de volta com os mesmos campos', () => {
  const { cli, path, db, project } = setupProject();
  const result = cli('add', 'Exportar CSV', '--intencao', 'Abrir no Excel.', '--criterio', 'Uma linha por pedido',
    '--criterio', 'Vírgula decimal', '--fora-do-escopo', 'Itens do pedido', '--restricoes', 'sem bibliotecas');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Item #1 adicionado: Exportar CSV · ready/);

  const second = cli('add', 'Filtro', '--intencao', 'Por data.', '--depende', '1');
  assert.match(second.stdout, /Item #2 adicionado: Filtro · backlog/);

  assert.deepEqual(fields(readFileSync(path, 'utf8')), [
    { title: 'Exportar CSV', number: 1, intent: 'Abrir no Excel.', criteria: ['Uma linha por pedido', 'Vírgula decimal'],
      dependsOn: [], restrictions: 'sem bibliotecas', outOfScope: ['Itens do pedido'], decisions: [], criticalConcepts: [],
      references: [], position: 0, errors: [] },
    { title: 'Filtro', number: 2, intent: 'Por data.', criteria: [], dependsOn: [1], restrictions: null, outOfScope: [],
      decisions: [], criticalConcepts: [], references: [], position: 1, errors: [] },
  ]);
  assert.deepEqual(listItems(db, project.id).map((item) => [item.number, item.status]), [[1, 'ready'], [2, 'backlog']]);

  assert.equal(cli('add', 'Sem intenção').status, 1);
});

test('sincronização: ids novos, mudança de conteúdo antes e depois do início e remoção', () => {
  const { path, db, project } = setupProject('\n## A\nprimeiro\n\n## B\nsegundo\n');
  const first = syncBacklog(db, project);
  assert.deepEqual(first.assigned, [1, 2]);
  assert.match(readFileSync(path, 'utf8'), /## A\nid: 1\nprimeiro\n\n## B\nid: 2\nsegundo\n$/);

  // Antes do início: a mudança atualiza o banco.
  writeFileSync(path, readFileSync(path, 'utf8').replace('\nprimeiro\n', '\nprimeiro, revisto\n'));
  syncBacklog(db, project);
  assert.equal(getItem(db, project.id, 1)?.intent, 'primeiro, revisto');

  // Depois do início: ignorada, com aviso.
  transition(db, project, getItem(db, project.id, 1)!.id, 'planning', null);
  writeFileSync(path, readFileSync(path, 'utf8').replace('\nprimeiro, revisto\n', '\noutra coisa\n'));
  const after = syncBacklog(db, project);
  assert.equal(getItem(db, project.id, 1)?.intent, 'primeiro, revisto');
  assert.match(after.warnings.join('\n'), /#1 mudou no backlog depois de iniciado/);

  // Remoção: não iniciado → cancelled; iniciado → permanece, com aviso.
  writeFileSync(path, BACKLOG_TEMPLATE);
  const removed = syncBacklog(db, project);
  assert.equal(getItem(db, project.id, 2)?.status, 'cancelled');
  assert.equal(getItem(db, project.id, 1)?.status, 'planning');
  assert.match(removed.warnings.join('\n'), /#1 saiu do backlog/);
});

test('sincronização: erro de formato bloqueia só o item e é desfeito quando corrigido', () => {
  const { path, db, project } = setupProject('\n## A\nid: 1\na\nDepende de: 7\n\n## B\nid: 2\nb\n');
  syncBacklog(db, project);
  assert.equal(getItem(db, project.id, 1)?.status, 'blocked');
  assert.equal(getItem(db, project.id, 1)?.statusReason, 'formato: depende de #7, que não existe');
  assert.equal(getItem(db, project.id, 2)?.status, 'ready');

  writeFileSync(path, readFileSync(path, 'utf8').replace('Depende de: 7\n', ''));
  syncBacklog(db, project);
  assert.equal(getItem(db, project.id, 1)?.status, 'ready');
});
