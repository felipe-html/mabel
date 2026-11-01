import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DELEGATE, type InboxIO, answerText, runInbox } from '../src/inbox.ts';
import { getItem, listItems } from '../src/items.ts';
import { writeConfig } from '../src/project.ts';
import { EXECUTION, EXECUTION_FILES, type GuidedAnswer, PLAN, guidedProblems, scriptedGuided, setupProject, useScenario } from './helpers.ts';

function inboxProject(backlog: string, responses: unknown[]) {
  const ctx = setupProject(backlog);
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  useScenario(ctx.root, responses);
  const run = ctx.cli('rodar');
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

/** Terminal falso da interface guiada; sem respostas, simula o ctrl+c. */
function scripted(answers: GuidedAnswer[]): { io: InboxIO; out: string[]; prompts: string[] } {
  const io = scriptedGuided(answers);
  return { io, out: io.lines, prompts: io.prompts };
}

const QUESTIONS = {
  structured_output: {
    ...PLAN,
    perguntas: [
      { texto: 'Quais cômodos aparecem?', sugestao: 'Sala e Cozinha', regraCritica: false },
      { texto: 'Qual moeda?', sugestao: '', regraCritica: false },
      { texto: 'Qual cor do botão?', sugestao: 'Azul', regraCritica: false },
    ],
  },
  session_id: 'plan-q',
};
const CRITICAL = { structured_output: { ...PLAN, conceitosCriticos: ['Desconto'] }, session_id: 'plan-c' };

test('perguntas do planejamento: aceitar a sugestão, responder, deixar o agente decidir; uma resposta só por item', async () => {
  const p = inboxProject('\n## Casa\ncômodos\n', [QUESTIONS]);
  assert.equal(p.item(1).status, 'needs_human');
  // Sem sugestão, o menu não oferece aceitá-la; o campo cancelado volta ao menu.
  const { io, out, prompts } = scripted(['Aceitar a sugestão', 'Responder', null, 'Responder', 'Real', 'Deixar o agente decidir']);
  const result = await runInbox(p.db, p.home, p.project, io);

  assert.deepEqual(result, { answered: 1, skipped: 0, interrupted: false });
  assert.ok(out.includes('      sugestão: Sala e Cozinha'));
  assert.equal(prompts[0], 'Aceitar a sugestão | Responder com outro texto | Deixar o agente decidir | Pular por agora');
  assert.equal(prompts[1], 'Responder com outro texto | Deixar o agente decidir | Pular por agora');
  assert.deepEqual([...out, ...prompts].flatMap(guidedProblems), []);
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

test('item crítico: sem "deixar o agente decidir"; aprovar leva o item a planned', async () => {
  const p = inboxProject('\n## Desconto\naplica desconto\n', [CRITICAL]);
  const { io, out, prompts } = scripted(['Aprovar os critérios']);
  await runInbox(p.db, p.home, p.project, io);
  assert.ok(out.some((line) => line.includes('motivo: conceito crítico: Desconto')));
  assert.ok(out.some((line) => line.includes('C1 (teste) soma(2, 3) devolve 5')));
  assert.deepEqual(prompts, ['Aprovar os critérios | Ajustar os critérios | Cancelar o item | Pular por agora']);
  assert.equal(p.item(1).status, 'planned');
  assert.deepEqual(p.reasons(1), ['humano: inbox critérios aprovados']);
});

test('pergunta de regra crítica: sem "deixar o agente decidir" na inbox (G7)', async () => {
  const p = setupProject('\n## Desconto\naplica desconto\n');
  assert.equal(p.cli('conferir').status, 0);
  const item = getItem(p.db, p.project.id, 1)!;
  const pending = { questions: [{ texto: 'Desconto máximo?', sugestao: '10%', regraCritica: true }] };
  p.db.prepare("UPDATE items SET status = 'needs_human', pending_kind = 'question_plan', pending = ? WHERE id = ?").run(JSON.stringify(pending), item.id);
  const { io, out, prompts } = scripted(['Responder', '15%']);
  await runInbox(p.db, p.home, p.project, io);
  assert.ok(out.some((line) => line.includes('Desconto máximo? (regra crítica)')));
  assert.equal(prompts[0], 'Aceitar a sugestão | Responder com outro texto | Pular por agora');
  assert.equal(getItem(p.db, p.project.id, 1)!.nextInput?.answer, answerText([{ question: 'Desconto máximo?', answer: '15%' }]));
});

test('pular o item, ctrl+c descarta só o item em andamento, plano incompleto e cancelamento', async () => {
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
  // #1 pulado na 2ª pergunta; #2 cancelado sem confirmação (o botão vermelho basta); #3 ajustado; #4 interrompido.
  const { io } = scripted([
    'Aceitar a sugestão',
    'Pular por agora',
    'Cancelar o item',
    'Ajustar os critérios',
    'Sem desconto acima de 10%.',
    'Aceitar a sugestão',
  ]);
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

test('perguntas da execução: suposição crítica confirmada e replanejar com as respostas', async () => {
  const p = inboxProject('\n## Soma\nsoma\n', [
    { structured_output: PLAN },
    {
      structured_output: {
        ...EXECUTION,
        perguntas: [{ texto: 'Arredondar?', sugestao: 'Para cima', regraCritica: false }],
        suposicoes: [{ texto: 'taxa zero', regraCritica: true }],
      },
      files: EXECUTION_FILES,
    },
  ]);
  assert.equal(p.item(1).pendingKind, 'question_execute');
  const { io, out } = scripted(['Aceitar a sugestão', 'Confirmar as suposições', 'Replanejar com as respostas']);
  await runInbox(p.db, p.home, p.project, io);
  assert.ok(out.includes('  ! suposição crítica: taxa zero'));
  assert.equal(p.item(1).status, 'planning');
  assert.equal(p.item(1).nextInput?.previousPlan, true);
  assert.match(p.item(1).nextInput?.answer ?? '', /R1: Para cima\nP2: Suposições críticas: taxa zero\nR2: Confirmo/);
  assert.match(p.reasons(1)[0] ?? '', /^humano: inbox responder --replanejar:/);
});

test('impedimento de ambiente: mostra o motivo e a orientação retoma a execução', async () => {
  const blocked = { ...EXECUTION, impedimento: 'o build baixa fontes de fonts.googleapis.com, fora da rede' };
  // Sem nenhuma alteração, não há o que verificar: o impedimento vai direto ao humano.
  const p = inboxProject('\n## Soma\nsoma\n', [{ structured_output: PLAN }, { structured_output: blocked, files: {}, session_id: 'exec-1' }]);
  assert.equal(p.item(1).pendingKind, 'environment_block');
  const { io, out, prompts } = scripted(['Dizer o que mudou', 'Liberei fonts.googleapis.com na rede.']);
  await runInbox(p.db, p.home, p.project, io);
  assert.ok(out.some((line) => line.includes('impedimento de ambiente')));
  assert.ok(out.some((line) => line.startsWith(`      ${blocked.impedimento}`)));
  assert.equal(prompts[0], 'Dizer o que mudou no ambiente e retomar | Replanejar com uma orientação | Cancelar o item | Pular por agora');
  assert.equal(p.item(1).status, 'executing');
  assert.equal(p.item(1).nextInput?.resumeSessionId, 'exec-1');
});

test('pendência antiga com perguntas em texto continua legível', () => {
  const p = inboxProject('\n## A\nprimeiro\n', [QUESTIONS]);
  p.db.prepare('UPDATE items SET pending = ? WHERE id = ?').run(JSON.stringify({ questions: ['Qual banco?'] }), p.item(1).id);
  assert.deepEqual(p.item(1).pending?.questions, [{ texto: 'Qual banco?', sugestao: '', regraCritica: false }]);
});

test('fora do TTY, mabel decidir só lista as pendências', () => {
  const p = inboxProject('\n## A\nprimeiro\n', [QUESTIONS]);
  const result = p.cli('decidir');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /#1 A — needs_human/);
  assert.match(result.stdout, /\? Quais cômodos aparecem\?\n {4}sugestão: Sala e Cozinha/);
  assert.match(result.stdout, /mabel decidir/);
  assert.equal(p.item(1).status, 'needs_human');
});
