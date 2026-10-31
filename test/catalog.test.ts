import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { referenceCatalog } from '../src/capture.ts';
import { getItem, listItems, syncBacklog } from '../src/items.ts';
import { type ChoiceConfig, type ChoiceState, choiceStep, plainStyle, renderChoice } from '../src/screens.ts';
import { type ReviewIO, applyReferences, merge, reviewReferences } from '../src/refine.ts';
import { referencesRoot, screenDir, snapshotPath } from '../src/references.ts';
import { scriptedGuided, setupProject } from './helpers.ts';

const BACKLOG = `
## Cadastro de acesso
Quero cadastrar acessos.

Referências:
- tela: cadastro
- api: acessos POST /v1/acessos

## Lista de acessos
Quero listar.
`;

function withReferences() {
  const ctx = setupProject(BACKLOG);
  mkdirSync(screenDir(ctx.root, 'cadastro'), { recursive: true });
  writeFileSync(join(screenDir(ctx.root, 'cadastro'), 'tela.md'), '# Cadastro\n');
  writeFileSync(join(screenDir(ctx.root, 'cadastro'), 'tela.png'), 'png');
  mkdirSync(screenDir(ctx.root, 'vazia'), { recursive: true });
  mkdirSync(join(referencesRoot(ctx.root), 'api'), { recursive: true });
  const paths = { '/v1/acessos': { get: { summary: 'Lista acessos' }, post: { operationId: 'criarAcesso' } } };
  writeFileSync(snapshotPath(ctx.root, 'acessos'), JSON.stringify({ openapi: '3.0.3', paths }));
  writeFileSync(join(referencesRoot(ctx.root), 'api', 'acessos.md'), 'notas');
  mkdirSync(join(referencesRoot(ctx.root), 'docs'), { recursive: true });
  writeFileSync(join(referencesRoot(ctx.root), 'docs', 'regras-de-cpf.md'), 'CPF');
  syncBacklog(ctx.db, ctx.project);
  return ctx;
}

test('catálogo: telas com arquivos, cada operação dos snapshots e arquivos avulsos, com os itens que citam', () => {
  const { db, project, root } = withReferences();
  const catalog = referenceCatalog(root, listItems(db, project.id));
  assert.deepEqual(
    catalog.map((entry) => [entry.entry, entry.detail, entry.items]),
    [
      ['tela: cadastro', 'tela.md, tela.png', [1]],
      ['api: acessos GET /v1/acessos', 'Lista acessos', []],
      ['api: acessos POST /v1/acessos', 'criarAcesso', [1]],
      ['docs/regras-de-cpf.md', '', []],
    ],
  );
});

test('referencia --json: o catálogo para outros programas', () => {
  const { cli } = withReferences();
  const result = cli('capturar', '--json');
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.equal(json.versao, 1);
  assert.deepEqual(json.referencias[0], { entrada: 'tela: cadastro', tipo: 'tela', nome: 'cadastro', detalhe: 'tela.md, tela.png', itens: [1] });
  assert.equal(cli('capturar', 'tela', 'x', '--png', 'a.png', '--json').status, 1);
});

test('add --referencia grava o campo; referência que não existe avisa que o item fica no backlog', () => {
  const { cli, path, db, project } = withReferences();
  const ok = cli('adicionar', 'Editar acesso', '--intencao', 'Editar.', '--referencia', 'tela: cadastro', '--referencia', 'docs/regras-de-cpf.md');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(readFileSync(path, 'utf8'), /## Editar acesso\nid: 3\nEditar\.\n\nReferências:\n- tela: cadastro\n- docs\/regras-de-cpf\.md\n/);
  assert.equal(getItem(db, project.id, 3)?.status, 'ready');

  const typo = cli('adicionar', 'Remover acesso', '--intencao', 'Remover.', '--referencia', 'tela: cadastr');
  assert.equal(typo.status, 0, typo.stderr);
  assert.match(typo.stdout, /Fica no backlog até corrigir: referência inválida: tela: cadastr/);
});

test('referências no refinar: a lista nova substitui a do item; sem mudança, nada muda; item iniciado é recusado', async () => {
  const { db, project, root, path } = withReferences();
  const item = getItem(db, project.id, 1);
  assert.ok(item);
  const catalog = referenceCatalog(root, listItems(db, project.id));
  const io = (answer: string[] | null): ReviewIO => ({ ...scriptedGuided([]), pickReferences: async () => answer });

  assert.equal(await reviewReferences(io(['api: acessos POST /v1/acessos', 'tela: cadastro']), item, catalog), undefined);
  assert.equal(await reviewReferences(io(null), item, catalog), undefined);
  assert.equal(await reviewReferences(scriptedGuided([]), item, catalog), undefined);
  const chosen = await reviewReferences(io(['tela: cadastro', 'docs/regras-de-cpf.md']), item, catalog);
  assert.deepEqual(chosen, ['tela: cadastro', 'docs/regras-de-cpf.md']);
  assert.deepEqual(merge(item, { criteria: [], outOfScope: [], decisions: [], criticalConcepts: [], references: chosen }).references, chosen);

  applyReferences(db, project, item, chosen ?? []);
  assert.match(readFileSync(path, 'utf8'), /Referências:\n- tela: cadastro\n- docs\/regras-de-cpf\.md\n\n## Lista de acessos/);
  assert.deepEqual(getItem(db, project.id, 1)?.references, chosen);

  db.prepare("INSERT INTO item_transitions (item_id, from_state, to_state, at) VALUES (?, 'ready', 'planning', '2026-10-28')").run(item.id);
  assert.throws(() => applyReferences(db, project, item, []), /congelado/);
});

test('refinar --referencias fora do terminal explica a alternativa', () => {
  const { cli } = withReferences();
  const result = cli('refinar', '2', '--referencias');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /precisa do terminal/);
  assert.equal(cli('refinar', '2', '--referencias', '--aceitar').status, 1);
});

// Múltipla escolha ------------------------------------------------------------------------

const CONFIG: ChoiceConfig = {
  options: [
    { label: 'tela: cadastro', hint: 'itens #1' },
    { label: 'api: acessos GET /v1/acessos', hint: 'Lista acessos' },
    { label: 'api: acessos POST /v1/acessos', hint: '' },
  ],
  multi: true,
  filter: true,
  back: true,
};

function press(keys: { name?: string; sequence?: string }[], start: ChoiceState = { cursor: 0, chosen: [0], filter: '' }) {
  let state = start;
  for (const key of keys) {
    const step = choiceStep(CONFIG, state, key);
    if ('marked' in step) return step.marked;
    if ('back' in step) return null;
    if (!('state' in step)) throw new Error('escolha de uma só');
    state = step.state;
  }
  return state;
}

test('múltipla escolha: espaço marca e desmarca, letras filtram, enter confirma em ordem, esc limpa o filtro e depois volta', () => {
  assert.deepEqual(press([{ name: 'space' }, { name: 'down' }, { name: 'down' }, { name: 'space' }, { name: 'return' }]), [2]);
  assert.deepEqual(press([...[...'post'].map((sequence) => ({ sequence })), { name: 'space' }, { name: 'return' }]), [0, 2]);
  assert.equal(press([{ name: 'escape' }]), null);
  const filtered = press([...'lista'].map((sequence) => ({ sequence })));
  assert.ok(!Array.isArray(filtered) && filtered !== null);
  assert.deepEqual(press([{ name: 'escape' }], filtered as ChoiceState), { cursor: 0, chosen: [0], filter: '', message: undefined });
  const lines = renderChoice(CONFIG, filtered as ChoiceState, plainStyle, 60);
  assert.equal(lines[0], '  › lista▏');
  assert.match(lines[2] ?? '', /^ {2}› \[ \] api: acessos GET \/v1\/acessos +Lista acessos {2}$/);
  assert.equal(lines.at(-1), ' ↑↓ navegar  espaço marca  enter confirma  digite filtra  esc volta ');
});
