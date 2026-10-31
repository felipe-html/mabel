import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tryGit } from '../src/git.ts';
import { syncBacklog } from '../src/items.ts';
import { type QueueOptions, startQueue } from '../src/run.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const PLAN_OK = { structured_output: PLAN };
const EXEC = { structured_output: EXECUTION, files: EXECUTION_FILES };
const REVIEW = { structured_output: REVIEW_OK };
const QUESTION = { structured_output: { ...PLAN, perguntas: [{ texto: 'Qual banco?', sugestao: '', regraCritica: false }] } };
const BROKEN = { is_error: true, result: 'quebrou', exit: 1 };

function queue(backlog: string) {
  const ctx = setupProject(backlog);
  Object.assign(ctx.project.config, { setup: null, verify: [{ name: 'existe', command: 'true' }] });
  syncBacklog(ctx.db, ctx.project);
  const start = (responses: unknown[], options: Partial<QueueOptions> = {}) => {
    useScenario(ctx.root, responses);
    return startQueue({ db: ctx.db, home: ctx.home, project: ctx.project, notify: () => {}, ...options }).done;
  };
  const report = () => readFileSync(join(ctx.root, '.mabel', 'run.md'), 'utf8');
  return { ...ctx, start, report };
}

const SECTIONS = ['## Precisa de você', '## Prontas para entregar', '## Em andamento', '## Integração', '## Tarefas deste run'];

test('S.1 critério 1: run.md com as seções na ordem; tarefa concluída, em needs_human e com falha', async () => {
  const q = queue('\n## A\nprimeiro\n\n## B\nsegundo\n\n## C\nterceiro\n');
  assert.equal(existsSync(join(q.root, '.mabel', 'run.md')), false);
  await q.start([PLAN_OK, QUESTION, BROKEN, EXEC, REVIEW]);
  const report = q.report();
  const positions = SECTIONS.map((section) => report.indexOf(`\n${section}\n`));
  assert.ok(positions.every((p) => p > 0), `seções presentes:\n${report}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'seções na ordem');
  assert.match(report, /^<!-- Gerado pelo Mabel[^\n]*\n# Run de \d{4}-\d{2}-\d{2} · \d{2}:\d{2} → \d{2}:\d{2} \([^)]+\)\n\nFim: fila vazia · US\$ /);
  assert.match(report, /## Precisa de você\n- Inbox \(mabel decidir\): pergunta: #2\n- #3 C falhou: run de plan falhou: [^\n]+\n/);
  assert.match(report, /## Prontas para entregar\n- #1 A · mabel\/1-a\n/);
  assert.match(report, /\| 1 \| avulso-1 \| concluída \| planejar, executar, revisar \| US\$ [\d,]+ \|/);
  assert.match(report, /\| 2 \| avulso-2 \| precisa de você \| planejar \| US\$ [\d,]+ \|/);
  assert.match(report, /\| 3 \| avulso-\d \| falhou \| planejar \| US\$ [\d,]+ \|/);
});

test('S.1 critério 1: o arquivo é reescrito ao fim de cada tarefa, com o run em andamento', async () => {
  const q = queue('\n## A\nprimeiro\n\n## B\nsegundo\n');
  const seen: string[] = [];
  // O vigia do código roda antes de cada etapa: na primeira etapa de B, A já terminou.
  const codeChanged = () => {
    seen.push(q.report());
    return false;
  };
  await q.start([PLAN_OK, EXEC, REVIEW, PLAN_OK, EXEC, REVIEW], { batch: false, codeChanged });
  // Algum retrato tirado durante B já mostra A concluída e o run em andamento.
  const beforeB = seen.find((report) => /\| 1 \| avulso-1 \| concluída/.test(report)) ?? '';
  assert.match(beforeB, /→ em andamento\n\nFim: em andamento/);
  assert.doesNotMatch(beforeB, /\| 2 \| avulso-2 \| concluída/);
});

test('S.1 critério 2: o segundo run sobrescreve o arquivo; run.md fica fora do git', async () => {
  const q = queue('\n## A\nprimeiro\n\n## B\nsegundo\n');
  await q.start([PLAN_OK, EXEC, REVIEW], { once: true, batch: false });
  const first = q.report();
  assert.match(first, /Fim: concluído/);
  assert.match(first, /\| 1 \| avulso-1 \| concluída/);

  await q.start([PLAN_OK, EXEC, REVIEW]);
  const second = q.report();
  assert.match(second, /Fim: fila vazia/);
  assert.match(second, /\| 2 \| avulso-2 \| concluída/);
  assert.doesNotMatch(second, /\| 1 \| avulso-1/, 'só as tarefas deste run');
  assert.ok(tryGit(q.root, 'check-ignore', '-q', '.mabel/run.md') !== undefined);
  assert.equal(readFileSync(join(q.root, '.mabel', '.gitignore'), 'utf8'), 'quadro.md\nrun.md\n');
});
