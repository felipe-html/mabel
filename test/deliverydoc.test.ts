import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reject, respond } from '../src/decisions.ts';
import { deliver } from '../src/delivery.ts';
import { git } from '../src/git.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { startQueue } from '../src/run.ts';
import { PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const INTEGRATION = 'mabel/integracao';
const REVIEW = { structured_output: REVIEW_OK };
const PLAN_ASSUMING = { structured_output: { ...PLAN, suposicoes: [{ texto: 'o total arredonda para baixo', regraCritica: false }] } };
const PLAN_ASKING = { structured_output: { ...PLAN, perguntas: [{ texto: 'Qual banco?', sugestao: '', regraCritica: false }] } };

const execFor = (n: number, content = `export const item${n} = ${n};\n`) => ({
  structured_output: {
    resumo: `item ${n}`,
    criterios: [{ id: 'C1', testes: [{ arquivo: `test/item${n}.test.js`, nome: `item ${n} existe` }] }],
    suposicoes: [],
    perguntas: [],
    escopoAdicional: [],
    impedimento: '',
  },
  files: { [`src/item${n}.js`]: content, [`test/item${n}.test.js`]: `test('item ${n} existe', () => {});\n` },
});

const BACKLOG = `
## Total do carrinho
Soma os itens.

Decisões:
- Frete entra no total? → Não

## Exportar
Exporta pedidos.
`;

test('S.2 critérios 3 e 4: documento na branch de entrega, base sem commit do Mabel, trailers nos merges', async () => {
  const q = setupProject(BACKLOG, { integracao: INTEGRATION });
  Object.assign(q.project.config, { setup: null, verify: [{ name: 'existe', command: 'true' }] });
  syncBacklog(q.db, q.project);
  const start = (responses: unknown[]) => {
    useScenario(q.root, responses);
    return startQueue({ db: q.db, home: q.home, project: q.project, notify: () => {} }).done;
  };
  // #1 integra com uma suposição; #2 pergunta e espera a inbox.
  await start([PLAN_ASSUMING, PLAN_ASKING, execFor(1), REVIEW]);
  respond(q.db, q.project, getItem(q.db, q.project.id, 2)!, 'Postgres', { via: 'inbox' });
  await start([{ structured_output: PLAN }, execFor(2), REVIEW]);
  // #1 rejeitado e refeito: vira desvio.
  reject(q.db, q.home, q.project, getItem(q.db, q.project.id, 1)!, 'faltou o desconto');
  await start([PLAN_ASSUMING, execFor(1, 'export const item1 = "com desconto";\n'), REVIEW]);

  const mainBefore = git(q.root, 'rev-parse', 'main');
  const scenario = join(q.home, 'gh.json');
  writeFileSync(scenario, JSON.stringify({ 'auth status': {}, 'repo view': { stdout: '{"mergeCommitAllowed":true}' } }));
  Object.assign(process.env, { MABEL_GH_BIN: join(q.home, 'sem-gh'), FAKE_GH_SCENARIO: scenario, FAKE_GH_LOG: `${scenario}.log` });
  const result = deliver(q.db, q.home, q.project);
  assert.equal(result.code, 0, result.lines.join('\n'));
  const delivery = result.delivery!;

  // A base não recebe commit do Mabel (G10).
  assert.equal(git(q.root, 'rev-parse', 'main'), mainBefore);
  const name = `${delivery.branch.slice('mabel/entrega/'.length)}-integracao`;
  const path = `.mabel/entregas/${name}.md`;
  assert.equal(git(q.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', delivery.branch), path, 'commit só com o documento');
  assert.match(git(q.root, 'log', '-1', '--format=%B', delivery.branch), new RegExp(`^mabel: entrega integracao\\n\\nMabel-Entrega: ${name}\\n?$`));
  assert.match(result.lines.join('\n'), new RegExp(`Documento: ${path.replace(/\./g, '\\.')}`));

  const doc = git(q.root, 'show', `${delivery.branch}:${path}`);
  assert.match(doc, /^Resumo: integracao · \d{4}-\d{2}-\d{2} · — · Postgres; Frete entra no total\? → Não\n\n# Entrega: integracao\n\nBase: main \([0-9a-f]+\) · 2 tarefas · US\$ /);
  const at = (title: string) => doc.indexOf(`\n## ${title}\n`);
  const order = ['Olhe primeiro', 'Decisões', 'Suposições do agente', 'Critérios e prova', 'Desvios', 'Tarefas'].map(at);
  assert.ok(order.every((p) => p > 0), doc);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(doc, /## Decisões\n- #2: Postgres \(inbox, \d{4}-\d{2}-\d{2}\)\n- #1: Frete entra no total\? → Não\n/);
  assert.match(doc, /## Suposições do agente\n- #1: o total arredonda para baixo\n/);
  assert.match(doc, /\| #1 \| C1 [^|]+ \| test\/item1\.test\.js › item 1 existe \| sem prova[^|]* \|/);
  assert.match(doc, /## Desvios\n- #1 rejeitado em \d{4}-\d{2}-\d{2}: faltou o desconto\n/);
  assert.match(doc, /## Tarefas\n- #2 Exportar · merge [0-9a-f]{7} · US\$ [\d,]+\n- #1 Total do carrinho · merge [0-9a-f]{7}/);

  // Trailers: todo merge do Mabel diz a tarefa e a unidade; a rejeição também.
  const merges = git(q.root, 'log', '--merges', '--format=%B%x00', `main..${INTEGRATION}`).split('\0').map((m) => m.trim()).filter(Boolean);
  assert.equal(merges.length, 3);
  for (const message of merges) assert.match(message, /\n\nMabel-Item: #\d\nMabel-Unidade: avulso-\d$/);
  assert.match(git(q.root, 'log', '--format=%s', '--grep', 'Mabel-Unidade: avulso-1', INTEGRATION), /^mabel: integra #1 Total do carrinho\nmabel: rejeita #1 Total do carrinho\nmabel: integra #1 Total do carrinho$/);
});
