import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { respond } from '../src/decisions.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { startQueue } from '../src/run.ts';
import { parseSpec, renderSpec, setSpecStatus, validateSpec } from '../src/specs.ts';
import { PLAN, setupProject, useScenario } from './helpers.ts';

const SPEC = `# Exportar pedidos em CSV

## História
O financeiro exporta os pedidos do período para conciliar no ERP.

## Regras

### R1 Só pedidos do período escolhido
- Pedido de 31/10 às 23h59, período até 31/10 → entra.
- Pedido de 01/11 às 00h00, período até 31/10 → não entra. (borda)

### R2 Pedido cancelado não entra
- Pedido cancelado dentro do período → não entra.

## Decisões
- Pedido cancelado entra? → Não. (refino, 2026-10-29)

## Fora do escopo
- Agendar a exportação.

## Regras críticas
- Valores financeiros

## Alterações nas regras vigentes
- pedidos: incluir "Exportação considera só pedidos não cancelados do período."
`;

const BACKLOG = `
## Exportar filtrados por período
Spec: exportar-csv
Regras: R1

## Exportar sem cancelados
Spec: exportar-csv
Regras: R2, R9
`;

function project(spec = SPEC, backlog = BACKLOG) {
  const ctx = setupProject(backlog);
  Object.assign(ctx.project.config, { setup: null, verify: [{ name: 'existe', command: 'true' }] });
  mkdirSync(join(ctx.root, '.mabel', 'specs'), { recursive: true });
  const specFile = join(ctx.root, '.mabel', 'specs', 'exportar-csv.md');
  writeFileSync(specFile, spec);
  const item = (n: number) => getItem(ctx.db, ctx.project.id, n)!;
  return { ...ctx, specFile, item, sync: () => syncBacklog(ctx.db, ctx.project) };
}

test('spec: parser lê regras, exemplos de borda, decisões, fora do escopo e alterações; render volta igual', () => {
  const spec = parseSpec(SPEC);
  assert.equal(spec.titulo, 'Exportar pedidos em CSV');
  assert.equal(spec.historia, 'O financeiro exporta os pedidos do período para conciliar no ERP.');
  assert.deepEqual(spec.regras.map((r) => [r.id, r.texto, r.exemplos.length]), [['R1', 'Só pedidos do período escolhido', 2], ['R2', 'Pedido cancelado não entra', 1]]);
  assert.deepEqual(spec.regras[0]?.exemplos[1], { situacao: 'Pedido de 01/11 às 00h00, período até 31/10', resultado: 'não entra.', borda: true });
  assert.deepEqual(spec.foraDoEscopo, ['Agendar a exportação.']);
  assert.deepEqual(spec.alteracoesRegrasVigentes, [{ assunto: 'pedidos', acao: 'incluir', texto: 'Exportação considera só pedidos não cancelados do período.' }]);
  assert.deepEqual(validateSpec(spec), []);
  assert.deepEqual(parseSpec(renderSpec(spec)), spec);
});

test('spec válida: regra sem exemplo, exemplo sem resultado, sem borda e sem fora do escopo', () => {
  const errors = validateSpec(parseSpec(`# T

## História
h

## Regras

### R1 a
- caso → ?

### R2 b
`));
  assert.deepEqual(errors, [
    'R1: exemplo sem resultado ("caso")',
    'R2 sem exemplo',
    'nenhum exemplo de borda (marque com (borda) no fim da linha)',
    'fora do escopo não declarado (pode ser "Nada.")',
  ]);
  assert.deepEqual(parseSpec('# T\n\n## Fora do escopo\nNada.\n').foraDoEscopo, []);
});

test('S.3 critério 5: spec não aceita segura a tarefa; aceita, vai a ready; regra inexistente também segura', () => {
  const q = project();
  q.sync();
  assert.equal(q.item(1).status, 'backlog');
  assert.equal(q.item(1).statusReason, 'spec exportar-csv não aceita: rode mabel especificar exportar-csv');

  const accepted = q.cli('especificar', 'exportar-csv', '--aceitar');
  assert.equal(accepted.status, 0, accepted.stderr);
  q.sync();
  assert.equal(q.item(1).status, 'ready');
  assert.equal(q.item(2).status, 'backlog');
  assert.equal(q.item(2).statusReason, 'regra R9 não existe na spec exportar-csv');

  // Spec que deixa de ser válida segura de novo.
  writeFileSync(q.specFile, SPEC.replace(' (borda)', ''));
  q.sync();
  assert.match(q.item(1).statusReason ?? '', /^spec exportar-csv inválida: nenhum exemplo de borda/);

  // Aceitar spec inválida é recusado.
  const refused = q.cli('especificar', 'exportar-csv', '--aceitar');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /não passa na validação:\n- nenhum exemplo de borda/);
  const list = q.cli('especificar');
  assert.match(list.stdout, /^exportar-csv · aceita · 2 tarefas|^exportar-csv · aceita · 0\/2 tarefas · inválida/);
});

test('S.3 critérios 6 e 7: o planejamento recebe a spec; regra citada alterada muda o hash só da tarefa não iniciada', async () => {
  const q = project(SPEC, '\n## Exportar filtrados por período\nSpec: exportar-csv\nRegras: R1\n\n## Exportar sem cancelados\nSpec: exportar-csv\nRegras: R2\n');
  setSpecStatus(q.db, q.project.id, 'exportar-csv', 'aceita');
  q.sync();
  const scenario = useScenario(q.root, [{ structured_output: { ...PLAN, perguntas: [{ texto: 'Qual separador?', sugestao: '', regraCritica: false }] } }]);
  await startQueue({ db: q.db, home: q.home, project: q.project, notify: () => {}, itemNumber: 1 }).done;
  const prompt = scenario.log().map((call) => call.argv.at(-1) ?? '').find((p) => p.startsWith('# Item #1')) ?? '';
  assert.match(prompt, /## Spec: Exportar pedidos em CSV \(exportar-csv\)\n\n### História\nO financeiro exporta/);
  assert.match(prompt, /### R1 Só pedidos do período escolhido\n- Pedido de 31\/10 às 23h59, período até 31\/10 → entra\.\n- Pedido de 01\/11 às 00h00, período até 31\/10 → não entra\. \(borda\)/);
  assert.doesNotMatch(prompt, /### R2/, 'só as regras citadas');
  assert.match(prompt, /### Decisões da spec\n- Pedido cancelado entra\? → Não\./);
  assert.match(prompt, /### Fora do escopo da spec\n- Agendar a exportação\./);
  assert.match(prompt, /### Regras críticas da spec\n- Valores financeiros/);
  assert.match(prompt, /Cada exemplo das regras acima é um critério de aceite/);
  assert.equal(q.item(1).status, 'needs_human');

  const started = q.item(1);
  const notStarted = q.item(2);
  // R1 e R2 mudam: #1 (iniciada) segue com a cópia; #2 (não iniciada) é atualizada.
  writeFileSync(q.specFile, SPEC.replace('→ entra.', '→ entra, com o horário do servidor.').replace('Pedido cancelado dentro do período → não entra.', 'Pedido cancelado dentro do período → não entra, nem estornado.'));
  const { warnings } = q.sync();
  assert.ok(warnings.some((w) => /#1 mudou no backlog depois de iniciado/.test(w)));
  assert.equal(q.item(1).contentHash, started.contentHash);
  assert.match(JSON.stringify(q.item(1).specContext), /→ entra\.?"|"resultado":"entra\."/);
  assert.notEqual(q.item(2).contentHash, notStarted.contentHash);
  assert.equal(q.item(2).specContext?.regras[0]?.exemplos[0]?.resultado, 'não entra, nem estornado.');

  // Mudança fora do trecho citado (outra regra) não muda o hash.
  const before = q.item(2).contentHash;
  writeFileSync(q.specFile, readFileSync(q.specFile, 'utf8').replace('com o horário do servidor', 'com o horário da loja'));
  q.sync();
  assert.equal(q.item(2).contentHash, before);
});

test('S.3 critério 8: resposta da inbox de uma tarefa de spec vai para as Decisões da spec; no avulso, para o backlog', async () => {
  const q = project(SPEC, '\n## Exportar filtrados por período\nSpec: exportar-csv\nRegras: R1\n\n## Avulso\nCorrige o total.\n');
  setSpecStatus(q.db, q.project.id, 'exportar-csv', 'aceita');
  q.sync();
  const asking = { structured_output: { ...PLAN, perguntas: [{ texto: 'Qual fuso do período?', sugestao: '', regraCritica: false }] } };
  useScenario(q.root, [asking, asking]);
  await startQueue({ db: q.db, home: q.home, project: q.project, notify: () => {} }).done;
  assert.equal(q.item(1).status, 'needs_human');
  respond(q.db, q.project, q.item(1), 'America/Sao_Paulo', { via: 'inbox' });
  assert.match(readFileSync(q.specFile, 'utf8'), /## Decisões\n- Pedido cancelado entra\? → Não\. \(refino, 2026-10-29\)\n- Qual fuso do período\? → America\/Sao_Paulo \(inbox, #1, \d{4}-\d{2}-\d{2}\)\n\n## Fora do escopo/);

  const avulso = q.item(2);
  respond(q.db, q.project, avulso, 'O da loja', { via: 'inbox' });
  assert.match(readFileSync(q.path, 'utf8'), /Corrige o total\.\n\nDecisões:\n- Qual fuso do período\? → O da loja \(inbox, #2, \d{4}-\d{2}-\d{2}\)/);
  assert.deepEqual(q.item(2).decisions, [`Qual fuso do período? → O da loja (inbox, #2, ${new Date().toISOString().slice(0, 10)})`]);
  // A decisão gravada não conta como edição do item iniciado.
  assert.deepEqual(q.sync().warnings, []);
});
