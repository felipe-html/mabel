import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { confirmPartial, deliver, listDeliveries } from '../src/delivery.ts';
import { git, tryGit } from '../src/git.ts';
import { getItem, listItems, syncBacklog } from '../src/items.ts';
import { type QueueOptions, startQueue } from '../src/run.ts';
import { applyRuleChanges, getSpecRecord, setSpecStatus } from '../src/specs.ts';
import { PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

// S.6: `mabel entregar <unidade>` (critérios 18 a 21 de `docs/specs/specs-e-entrega.md`).

const PLAN_OK = { structured_output: PLAN };
const REVIEW = { structured_output: REVIEW_OK };

const execFor = (n: number) => ({
  structured_output: {
    resumo: `item ${n}`,
    criterios: [{ id: 'C1', testes: [{ arquivo: `test/item${n}.test.js`, nome: `item ${n} existe` }] }],
    suposicoes: [],
    perguntas: [],
    escopoAdicional: [],
    impedimento: '',
  },
  files: { [`src/item${n}.js`]: `export const item${n} = ${n};\n`, [`test/item${n}.test.js`]: `test('item ${n} existe', () => {});\n` },
});

const specFile = (title: string, changes = '') =>
  `# ${title}\n\n## História\nH.\n\n## Regras\n\n### R1 Regra\n- caso → resultado (borda)\n\n## Fora do escopo\nNada.\n${changes}`;

const CHANGES = `
## Alterações nas regras vigentes
- pedidos: incluir "Cancelado não entra."
- pedidos: alterar "Período exclusivo. → Período inclusivo."
- pedidos: remover "Regra antiga."
`;

const RULES = '# Regras vigentes\n\n## pedidos\n- Período exclusivo.\n- Regra antiga.\n';

const task = (title: string, slug: string, depends?: number) => `\n## ${title}\nSpec: ${slug}\nRegras: R1\n${depends ? `Depende de: ${depends}\n` : ''}`;

/** Projeto com integração, sem remoto, com as specs dadas aceitas e o `regras.md` na base. */
function project(backlog: string, specs: Record<string, string>) {
  const q = setupProject(backlog, { integracao: 'mabel/integracao' });
  Object.assign(q.project.config, { setup: null, verify: [{ name: 'existe', command: 'true' }] });
  mkdirSync(join(q.root, '.mabel', 'specs'), { recursive: true });
  for (const [slug, text] of Object.entries(specs)) {
    writeFileSync(join(q.root, '.mabel', 'specs', `${slug}.md`), text);
    setSpecStatus(q.db, q.project.id, slug, 'aceita');
  }
  writeFileSync(join(q.root, '.mabel', 'regras.md'), RULES);
  git(q.root, 'add', '.mabel');
  git(q.root, 'commit', '-q', '-m', 'specs e regras');
  syncBacklog(q.db, q.project);
  const start = (responses: unknown[], options: Partial<QueueOptions> = {}) => {
    useScenario(q.root, responses);
    return startQueue({ db: q.db, home: q.home, project: q.project, notify: () => {}, ...options }).done;
  };
  const deliveryBranches = () => tryGit(q.root, 'branch', '--list', 'mabel/entrega/*') ?? '';
  return { ...q, start, deliveryBranches };
}

test('regras vigentes: incluir, alterar "antigo → novo" e remover; o que não confere vira nota', () => {
  const applied = applyRuleChanges(RULES, [
    { assunto: 'pedidos', acao: 'incluir', texto: 'Cancelado não entra.' },
    { assunto: 'pedidos', acao: 'alterar', texto: 'Período exclusivo. → Período inclusivo.' },
    { assunto: 'pedidos', acao: 'remover', texto: 'Regra antiga.' },
    { assunto: 'frete', acao: 'incluir', texto: 'Frete grátis acima de R$ 200.' },
    { assunto: 'frete', acao: 'remover', texto: 'Não existe.' },
    { assunto: 'frete', acao: 'alterar', texto: 'Sem seta.' },
  ]);
  assert.equal(
    applied.text,
    '# Regras vigentes\n\n## pedidos\n- Período inclusivo.\n- Cancelado não entra.\n\n## frete\n- Frete grátis acima de R$ 200.\n- Sem seta.\n',
  );
  assert.deepEqual(applied.notes, [
    'pedidos: incluído "Cancelado não entra."',
    'pedidos: alterado "Período exclusivo." → "Período inclusivo."',
    'pedidos: removido "Regra antiga."',
    'frete: incluído "Frete grátis acima de R$ 200."',
    'frete: "Não existe." não estava nas regras vigentes; nada removido',
    'frete: incluído "Sem seta." (alteração sem a regra antiga)',
  ]);
  assert.equal(applyRuleChanges('', [{ assunto: 'a', acao: 'incluir', texto: 'x' }]).text, '# Regras vigentes\n\n## a\n- x\n');
});

test('S.6 critério 18: verificação vermelha em base + spec recusa sem criar branch', async () => {
  const q = project(task('A1', 'a'), { a: specFile('A') });
  await q.start([PLAN_OK, execFor(1), REVIEW]);
  assert.equal(getItem(q.db, q.project.id, 1)?.status, 'awaiting_merge');
  Object.assign(q.project.config, { verify: [{ name: 'falha', command: 'false' }] });
  const result = deliver(q.db, q.home, q.project, { unit: 'a' });
  assert.equal(result.code, 1);
  assert.match(result.lines.join('\n'), /A verificação de main \+ a falhou em `false`; nada foi criado\./);
  assert.equal(q.deliveryBranches(), '');
  assert.equal(listDeliveries(q.db, q.project.id).length, 0);
  assert.match(git(q.root, 'worktree', 'list'), /^[^\n]+$/, 'worktree da prova removido');
});

test('S.6 critério 19: spec que depende de outra não entregue é recusada; --com entrega as duas', async () => {
  const q = project(task('A1', 'a') + task('B1', 'b', 1), { a: specFile('A'), b: specFile('B') });
  await q.start([PLAN_OK, execFor(1), REVIEW, PLAN_OK, execFor(2), REVIEW]);
  assert.deepEqual(listItems(q.db, q.project.id).map((item) => item.status), ['awaiting_merge', 'awaiting_merge']);

  const refused = deliver(q.db, q.home, q.project, { unit: 'b' });
  assert.equal(refused.code, 1);
  assert.match(refused.lines.join('\n'), /b depende de a, ainda fora da main\. .*mabel entregar b --com a/);
  assert.equal(q.deliveryBranches(), '');

  const both = deliver(q.db, q.home, q.project, { unit: 'b', with: ['a'] });
  assert.equal(both.code, 0, both.lines.join('\n'));
  assert.equal(both.delivery?.branch, 'mabel/entrega/b+a');
  assert.deepEqual(both.delivery?.items, [2, 1]);
  for (const n of [1, 2]) assert.ok(tryGit(q.root, 'show', `${both.delivery?.branch}:src/item${n}.js`), `#${n} na entrega`);
  // A spec sem dependência vai sozinha.
  assert.equal(deliver(q.db, q.home, q.project, { unit: 'a' }).code, 0);
});

test('S.6 critério 20: entrega parcial pede --parcial fora do TTY e confirmação no terminal', async () => {
  const q = project(task('A1', 'a') + task('A2', 'a'), { a: specFile('A') });
  await q.start([PLAN_OK, execFor(1), REVIEW], { itemNumber: 1 });
  assert.equal(getItem(q.db, q.project.id, 2)?.status, 'ready');

  const refused = deliver(q.db, q.home, q.project, { unit: 'a' });
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.missing, [2]);
  assert.match(refused.lines.join('\n'), /Entrega parcial: a ainda tem #2 por concluir\. Rode com --parcial/);
  assert.equal(q.deliveryBranches(), '');

  const prompts: string[] = [];
  const scripted = (answer: string) => async (prompt: string) => {
    prompts.push(prompt);
    return answer;
  };
  assert.equal(await confirmPartial(scripted('s'), [2]), true);
  assert.equal(await confirmPartial(scripted(''), [2]), false);
  assert.match(prompts[0] ?? '', /Faltam #2\. Entregar só o que está pronto\? \[s\/N\]/);

  const partial = deliver(q.db, q.home, q.project, { unit: 'a', partial: true });
  assert.equal(partial.code, 0, partial.lines.join('\n'));
  assert.deepEqual(partial.delivery?.items, [1]);
  const doc = git(q.root, 'show', `${partial.delivery?.branch}:${/Documento: (\S+)/.exec(partial.lines.join('\n'))?.[1]}`);
  assert.match(doc, /## Olhe primeiro\n- Entrega parcial: faltam #2\./);
});

test('S.6 critério 21: o merge da entrega na base leva as tarefas a done, a spec a entregue e o regras.md alterado', async () => {
  const q = project(task('A1', 'a'), { a: specFile('A', CHANGES) });
  await q.start([PLAN_OK, execFor(1), REVIEW]);
  const mainBefore = git(q.root, 'rev-parse', 'main');
  const result = deliver(q.db, q.home, q.project, { unit: 'a' });
  assert.equal(result.code, 0, result.lines.join('\n'));
  const branch = result.delivery?.branch as string;
  assert.equal(branch, 'mabel/entrega/a');
  assert.equal(git(q.root, 'rev-parse', 'main'), mainBefore, 'a base não recebe commit do Mabel');
  // Commit da entrega: o documento e o regras.md, nada mais.
  const files = git(q.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', branch).split('\n').sort();
  assert.equal(files.length, 2);
  assert.equal(files[1], '.mabel/regras.md');
  assert.match(files[0] ?? '', /^\.mabel\/entregas\/\d{4}-\d{2}-\d{2}-a\.md$/);
  const doc = git(q.root, 'show', `${branch}:${files[0]}`);
  assert.match(doc, /^Resumo: a · \d{4}-\d{2}-\d{2} · pedidos · /);
  assert.match(doc, /## Regras vigentes alteradas\n- pedidos: incluído "Cancelado não entra\."\n- pedidos: alterado "Período exclusivo\." → "Período inclusivo\."\n- pedidos: removido "Regra antiga\."$/);
  assert.equal(readFileSync(join(q.root, '.mabel', 'regras.md'), 'utf8'), RULES, 'o regras.md da base só muda pelo merge');

  git(q.root, 'merge', '-q', '--no-ff', '--no-edit', branch);
  assert.equal((await q.start([])).end, 'empty');
  assert.equal(getItem(q.db, q.project.id, 1)?.status, 'done');
  assert.equal(getSpecRecord(q.db, q.project.id, 'a')?.status, 'entregue');
  assert.equal(listDeliveries(q.db, q.project.id)[0]?.status, 'merged');
  assert.equal(tryGit(q.root, 'rev-parse', '--verify', '--quiet', 'refs/heads/mabel/spec/a'), undefined, 'branch da spec entregue apagada');
  assert.equal(
    readFileSync(join(q.root, '.mabel', 'regras.md'), 'utf8'),
    '# Regras vigentes\n\n## pedidos\n- Período inclusivo.\n- Cancelado não entra.\n',
  );
});
