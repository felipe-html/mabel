import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interrupted } from '../src/ask.ts';
import { DELEGATE, type InboxIO, answerText, inboxSession, runInbox } from '../src/inbox.ts';
import { getItem, listItems } from '../src/items.ts';
import { writeConfig } from '../src/project.ts';
import { EXECUTION, EXECUTION_FILES, PLAN, setupProject, useScenario } from './helpers.ts';

function inboxProject(backlog: string, responses: unknown[]) {
  const ctx = setupProject(backlog);
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  useScenario(ctx.root, responses);
  const run = ctx.cli('run');
  assert.equal(run.status, 0, run.stderr);
  const item = (number: number) => getItem(ctx.db, ctx.project.id, number)!;
  const reasons = (number: number) =>
    (
      ctx.db
        .prepare("SELECT reason FROM item_transitions WHERE item_id = ? AND reason LIKE 'humano:%' ORDER BY id")
        .all(item(number).id) as { reason: string }[]
    ).map((r) => r.reason);
  return { ...ctx, item, reasons };
}

/** Terminal falso: devolve as entradas na ordem; sem entradas, simula o ctrl+c. */
function scripted(inputs: string[]): { io: InboxIO; out: string[]; prompts: string[] } {
  const out: string[] = [];
  const prompts: string[] = [];
  const io: InboxIO = {
    ask: async (prompt) => {
      prompts.push(prompt);
      const next = inputs.shift();
      if (next === undefined) throw new Interrupted();
      return next;
    },
    write: (line) => out.push(line),
  };
  return { io, out, prompts };
}

const QUESTIONS = {
  structured_output: {
    ...PLAN,
    perguntas: [
      { texto: 'Quais cômodos aparecem?', sugestao: 'Sala e Cozinha' },
      { texto: 'Qual moeda?', sugestao: '' },
      { texto: 'Qual cor do botão?', sugestao: 'Azul' },
    ],
  },
  session_id: 'plan-q',
};
const CRITICAL = { structured_output: { ...PLAN, conceitosCriticos: ['Desconto'] }, session_id: 'plan-c' };

test('perguntas do planejamento: enter aceita, texto responde, d delega; uma resposta só por item', async () => {
  const p = inboxProject('\n## Casa\ncômodos\n', [QUESTIONS]);
  assert.equal(p.item(1).status, 'needs_human');
  // Sem sugestão, enter vazio repete a pergunta.
  const { io, out } = scripted(['', '', 'Real', 'd']);
  const result = await runInbox(p.db, p.home, p.project, io);

  assert.deepEqual(result, { answered: 1, skipped: 0, interrupted: false });
  assert.ok(out.includes('      sugestão: Sala e Cozinha'));
  assert.ok(out.some((line) => line.includes('Sem sugestão')));
  const expected = answerText([
    { question: 'Quais cômodos aparecem?', answer: 'Sala e Cozinha' },
    { question: 'Qual moeda?', answer: 'Real' },
    { question: 'Qual cor do botão?', answer: DELEGATE },
  ]);
  assert.equal(p.item(1).status, 'planning');
  assert.equal(p.item(1).nextInput?.answer, expected);
  assert.equal(p.item(1).nextInput?.resumeSessionId, 'plan-q');
  assert.equal(p.reasons(1).length, 1);
  assert.match(p.reasons(1)[0] ?? '', /^humano: inbox responder: P1: Quais cômodos aparecem\? R1: Sala e Cozinha/);
});

test('item crítico: sem "decide você"; a aprova e segue para a execução', async () => {
  const p = inboxProject('\n## Desconto\naplica desconto\n', [CRITICAL]);
  const { io, out } = scripted(['d', 'a']);
  await runInbox(p.db, p.home, p.project, io);
  assert.ok(out.some((line) => line.includes('motivo: conceito crítico: Desconto')));
  assert.ok(out.some((line) => line.includes('C1 (teste) soma(2, 3) devolve 5')));
  assert.ok(out.some((line) => line.includes('a aprovação é sua')));
  assert.ok(!out.some((line) => line.includes('d decide você')));
  assert.equal(p.item(1).status, 'executing');
  assert.deepEqual(p.reasons(1), ['humano: inbox critérios aprovados']);
});

test('p pula o item, ctrl+c descarta só o item em andamento, plano incompleto e cancelamento', async () => {
  const p = inboxProject('\n## A\nprimeiro\n\n## B\nsegundo\n\n## C\nterceiro\n\n## D\nquarto\n', [
    QUESTIONS,
    {},
    {},
    CRITICAL,
    QUESTIONS,
  ]);
  assert.deepEqual(
    listItems(p.db, p.project.id).map((item) => item.pendingKind),
    ['question_plan', 'plan_incomplete', 'critical_approval', 'question_plan'],
  );
  // #1 pulado na 2ª pergunta; #2 cancelado depois de desistir uma vez; #3 ajustado; #4 interrompido.
  const { io } = scripted(['', 'p', 'c', 'n', 'c', 's', 'Sem desconto acima de 10%.', '']);
  const result = await runInbox(p.db, p.home, p.project, io);

  assert.deepEqual(result, { answered: 2, skipped: 1, interrupted: true });
  assert.equal(p.item(1).status, 'needs_human');
  assert.equal(p.item(2).status, 'cancelled');
  assert.deepEqual(p.reasons(2), ['humano: inbox cancelado']);
  assert.equal(p.item(3).status, 'planning');
  assert.equal(p.item(3).nextInput?.answer, 'Sem desconto acima de 10%.');
  assert.equal(p.item(4).status, 'needs_human');
  assert.equal(p.item(4).pendingKind, 'question_plan');
});

test('perguntas da execução: suposição crítica confirmada e r replaneja com as respostas', async () => {
  const p = inboxProject('\n## Soma\nsoma\n', [
    { structured_output: PLAN },
    {
      structured_output: {
        ...EXECUTION,
        perguntas: [{ texto: 'Arredondar?', sugestao: 'Para cima' }],
        suposicoes: [{ texto: 'taxa zero', regraCritica: true }],
      },
      files: EXECUTION_FILES,
    },
  ]);
  assert.equal(p.item(1).pendingKind, 'question_execute');
  const { io, out } = scripted(['', '', 'r']);
  await runInbox(p.db, p.home, p.project, io);
  assert.ok(out.includes('  ! suposição crítica: taxa zero'));
  assert.equal(p.item(1).status, 'planning');
  assert.equal(p.item(1).nextInput?.previousPlan, true);
  assert.match(p.item(1).nextInput?.answer ?? '', /R1: Para cima\nP2: Suposições críticas: taxa zero\nR2: Confirmo/);
  assert.match(p.reasons(1)[0] ?? '', /^humano: inbox responder --replanejar:/);
});

test('fim da inbox pergunta se retoma a esteira; sem respostas não pergunta', async () => {
  const p = inboxProject('\n## A\nprimeiro\n\n## B\nsegundo\n', [QUESTIONS, QUESTIONS]);
  const yes = scripted(['', 'x', 'y', 'p', '']);
  assert.equal(await inboxSession(p.db, p.home, p.project, yes.io), true);
  assert.equal(yes.prompts.at(-1), 'Retomar a esteira agora? [S/n] ');

  const none = scripted(['p']);
  assert.equal(await inboxSession(p.db, p.home, p.project, none.io), false);
  assert.ok(!none.prompts.some((prompt) => prompt.startsWith('Retomar')));
});

test('pendência antiga com perguntas em texto continua legível', () => {
  const p = inboxProject('\n## A\nprimeiro\n', [QUESTIONS]);
  p.db.prepare('UPDATE items SET pending = ? WHERE id = ?').run(JSON.stringify({ questions: ['Qual banco?'] }), p.item(1).id);
  assert.deepEqual(p.item(1).pending?.questions, [{ texto: 'Qual banco?', sugestao: '' }]);
});

test('fora do TTY, mabel inbox só lista as pendências', () => {
  const p = inboxProject('\n## A\nprimeiro\n', [QUESTIONS]);
  const result = p.cli('inbox');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /#1 A — needs_human/);
  assert.match(result.stdout, /\? Quais cômodos aparecem\?\n {4}sugestão: Sala e Cozinha/);
  assert.match(result.stdout, /mabel inbox/);
  assert.equal(p.item(1).status, 'needs_human');
});
