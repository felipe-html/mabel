import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { Interrupted } from '../src/ask.ts';
import { RULES_BUDGET, type ReviewIO, currentRules, outputProblems } from '../src/engine.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import type { SpecifyOutput } from '../src/schemas/stages.ts';
import { latestSpecProposal, specifySpec } from '../src/specify.ts';
import { getSpecMetrics, getSpecRecord, readSpec } from '../src/specs.ts';
import { setupProject, useScenario } from './helpers.ts';

const DRAFT = '# Exportar pedidos em CSV\n\n## História\nO financeiro exporta os pedidos do período.\n';

const NONE = { passos: '', esperado: '', obtido: '' };

/** Primeira rodada: R1 resolvida; R2 e R3 com um exemplo sem resultado e a pergunta de cada uma. */
const ROUND1: SpecifyOutput = {
  historia: 'O financeiro exporta os pedidos do período para conciliar no ERP.',
  regras: [
    { id: 'R1', texto: 'Só pedidos do período', exemplos: [{ situacao: 'Pedido de 01/11 00h00, período até 31/10', resultado: 'não entra', borda: true }] },
    { id: 'R2', texto: 'Cancelados', exemplos: [{ situacao: 'Pedido cancelado no período', resultado: '', borda: false }] },
    { id: 'R3', texto: 'Fuso', exemplos: [{ situacao: 'Pedido às 23h30 em Manaus', resultado: '', borda: true }] },
  ],
  perguntas: [
    { texto: 'Pedido cancelado entra?', sugestao: 'Não', regraCritica: false, regra: 'R2' },
    { texto: 'Qual fuso vale para o período?', sugestao: 'America/Sao_Paulo', regraCritica: false, regra: 'R3' },
  ],
  decisoes: [],
  foraDoEscopo: ['Agendar a exportação.'],
  conceitosCriticos: [],
  alteracoesRegrasVigentes: [{ assunto: 'pedidos', acao: 'incluir', texto: 'Exportação considera só pedidos não cancelados.' }],
  tarefas: [
    { titulo: 'Exportar filtrados por período', intencao: 'Filtrar pelo período.', regras: ['R1', 'R3'], dependeDe: [] },
    { titulo: 'Exportar sem cancelados', intencao: '', regras: ['R2'], dependeDe: [1] },
  ],
  sugestaoQuebra: [{ titulo: 'Agendamento', historia: 'O financeiro agenda a exportação.' }],
  reproducao: NONE,
};

const ROUND2: SpecifyOutput = {
  ...ROUND1,
  regras: [
    ROUND1.regras[0] as SpecifyOutput['regras'][number],
    { id: 'R2', texto: 'Cancelados', exemplos: [{ situacao: 'Pedido cancelado no período', resultado: 'não entra', borda: false }] },
    { id: 'R3', texto: 'Fuso', exemplos: [{ situacao: 'Pedido às 23h30 em Manaus', resultado: 'entra pelo horário de Brasília', borda: true }] },
  ],
  perguntas: [],
  decisoes: ['Pedido cancelado entra? → Não'],
};

function seedBalance(db: DatabaseSync) {
  const now = Date.now();
  const insert = db.prepare('INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)');
  insert.run(new Date(now).toISOString(), 'five_hour', 0.1, new Date(now + 3 * 3600_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.1, new Date(now + 6 * 86400_000).toISOString(), 'allowed');
}

function scriptedIO(answers: (string | null)[]): ReviewIO & { lines: string[]; prompts: string[] } {
  const lines: string[] = [];
  const prompts: string[] = [];
  return {
    lines,
    prompts,
    write: (line) => lines.push(line),
    ask: async (prompt) => {
      prompts.push(prompt);
      if (answers.length === 0) throw new Error(`pergunta sem resposta roteirizada: ${prompt}`);
      const answer = answers.shift() as string | null;
      if (answer === null) throw new Interrupted();
      return answer;
    },
  };
}

function project(draft = DRAFT) {
  const ctx = setupProject('\n## Outro item\nIntenção do outro.\n');
  syncBacklog(ctx.db, ctx.project);
  seedBalance(ctx.db);
  mkdirSync(join(ctx.root, '.mabel', 'specs'), { recursive: true });
  const specFile = join(ctx.root, '.mabel', 'specs', 'exportar-csv.md');
  writeFileSync(specFile, draft);
  return { ...ctx, specFile };
}

const resumeOf = (argv: string[] | undefined) => argv?.[(argv?.indexOf('--resume') ?? -2) + 1];

test('S.4 critérios 9 e 12: duas rodadas, respostas viram decisões e exemplos, aceite grava spec, tarefas e métricas', async () => {
  const q = project();
  writeFileSync(join(q.root, '.mabel', 'regras.md'), '# Regras vigentes\n\n## pedidos\n- Pedido excluído some de todas as listas.\n');
  const scenario = useScenario(q.root, [{ structured_output: ROUND1, session_id: 'sessao-spec' }, { structured_output: ROUND2 }]);
  const io = scriptedIO([
    '', // R2: aceita a sugestão
    'Horário de Brasília', // R3: responde
    '', // história
    '', // regras
    '', // decisões
    '', // fora do escopo
    '', // alterações nas regras vigentes
    '', // tarefas
    '', // grava
  ]);
  assert.equal(await specifySpec(q.db, q.home, q.project, 'exportar-csv', {}, io), 0);

  const [first, second] = scenario.log();
  const firstArgv = first?.argv ?? [];
  assert.equal(firstArgv[firstArgv.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.match(firstArgv.at(-1) ?? '', /## Rascunho \(\.mabel\/specs\/exportar-csv\.md\)\n\n# Exportar pedidos em CSV/);
  assert.match(firstArgv.at(-1) ?? '', /## Regras vigentes \(\.mabel\/regras\.md\)\n\n# Regras vigentes\n\n## pedidos\n- Pedido excluído some/);
  // A segunda rodada é a mesma sessão e retrabalha só as regras que as respostas mexeram.
  assert.equal(resumeOf(second?.argv), 'sessao-spec');
  const prompt2 = second?.argv.at(-1) ?? '';
  assert.match(prompt2, /P \(R2\): Pedido cancelado entra\?\nR: Não\n\nP \(R3\): Qual fuso vale para o período\?\nR: Horário de Brasília/);
  assert.match(prompt2, /Regras a retrabalhar: R2, R3\. As outras voltam como estavam\./);
  assert.doesNotMatch(prompt2, /R1/);

  // Revisão: a sugestão de quebra e o tamanho aparecem.
  const shown = io.lines.join('\n');
  assert.match(shown, /Sugestão de quebra.*\n {2}- Agendamento: O financeiro agenda a exportação\./);
  assert.match(shown, /Tamanho: 3 regras · 3 exemplos · 2 rodadas · 2 perguntas · 2 tarefas/);

  const spec = readSpec(q.root, 'exportar-csv');
  assert.ok(spec);
  assert.equal(spec.titulo, 'Exportar pedidos em CSV');
  assert.deepEqual(spec.decisoes, ['Pedido cancelado entra? → Não', 'Qual fuso vale para o período? → Horário de Brasília']);
  assert.deepEqual(spec.regras.map((rule) => rule.exemplos.map((e) => e.resultado)), [['não entra'], ['não entra'], ['entra pelo horário de Brasília']]);
  assert.deepEqual(spec.alteracoesRegrasVigentes, [{ assunto: 'pedidos', acao: 'incluir', texto: 'Exportação considera só pedidos não cancelados.' }]);
  assert.equal(getSpecRecord(q.db, q.project.id, 'exportar-csv')?.status, 'aceita');
  assert.deepEqual(getSpecMetrics(q.db, q.project.id, 'exportar-csv'), { regras: 3, exemplos: 3, rodadas: 2, perguntas: 2, tarefas: 2 });

  const backlog = readFileSync(q.path, 'utf8');
  assert.match(backlog, /## Exportar filtrados por período\nid: 2\nFiltrar pelo período\.\n\nSpec: exportar-csv\nRegras: R1, R3\n\n## Exportar sem cancelados\nid: 3\n\nSpec: exportar-csv\nRegras: R2\nDepende de: 2\n$/);
  assert.equal(getItem(q.db, q.project.id, 2)?.status, 'ready');
  assert.equal(getItem(q.db, q.project.id, 3)?.statusReason, 'dependências pendentes');
  assert.equal(latestSpecProposal(q.db, q.project.id, 'exportar-csv')?.status, 'accepted');
});

test('S.4 critério 10: exemplo sem resultado e sem pergunta é corrigido na mesma sessão', async () => {
  const q = project();
  const broken: SpecifyOutput = { ...ROUND1, perguntas: [ROUND1.perguntas[0] as SpecifyOutput['perguntas'][number]] };
  const scenario = useScenario(q.root, [{ structured_output: broken, session_id: 'sessao-10' }, { structured_output: ROUND2 }]);
  // Fora do TTY: a primeira rodada (corrigida) fica pendente com a proposta pronta.
  assert.equal(await specifySpec(q.db, q.home, q.project, 'exportar-csv', {}, undefined), 0);
  const [, correction] = scenario.log();
  assert.equal(resumeOf(correction?.argv), 'sessao-10');
  assert.match(correction?.argv.at(-1) ?? '', /## Saída recusada pelo Mabel\n\n- R3: exemplo sem resultado e sem pergunta \("Pedido às 23h30 em Manaus"\)/);
  const pending = latestSpecProposal(q.db, q.project.id, 'exportar-csv');
  assert.equal(pending?.status, 'proposed');
  assert.deepEqual(pending?.conversation.output.perguntas, []);

  // Validação pura: o limite de 5 deixa as outras perguntas para a próxima rodada.
  const ctx = { target: { kind: 'spec', slug: 'x', title: 'X', draft: '' } as const, round: 1, concepts: [], rules: '' };
  assert.deepEqual(outputProblems(broken, ctx), ['R3: exemplo sem resultado e sem pergunta ("Pedido às 23h30 em Manaus"): preencha o resultado ou pergunte']);
  const six = Array.from({ length: 6 }, (_, i) => ({ texto: `P${i}`, sugestao: '', regraCritica: false, regra: 'R2' }));
  assert.match(outputProblems({ ...ROUND1, perguntas: six }, ctx)[0] ?? '', /6 perguntas; o máximo é 5/);
  assert.match(outputProblems(ROUND1, { ...ctx, round: 5 }).join(';'), /na última rodada não há perguntas/);

  // Alterar nas regras vigentes: com a seta e a regra antiga no assunto, ou a saída volta.
  const rules = '# Regras vigentes\n\n## Frete\n- Frete grátis acima de R$ 200\n';
  const withChanges = (texto: string): SpecifyOutput => ({ ...ROUND2, alteracoesRegrasVigentes: [{ assunto: 'Frete', acao: 'alterar', texto }] });
  assert.deepEqual(outputProblems(withChanges('frete grátis acima de R$ 200 → Frete grátis acima de R$ 150'), { ...ctx, rules }), []);
  assert.match(outputProblems(withChanges('Frete grátis acima de R$ 150'), { ...ctx, rules }).join(), /sem a seta/);
  assert.match(outputProblems(withChanges('Frete grátis acima de R$ 300 → Frete grátis acima de R$ 150'), { ...ctx, rules }).join(), /não está nesse assunto/);
});

test('especificar fora do TTY: perguntas pendentes; --aceitar responde com as sugestões e grava; --descartar', async () => {
  const q = project();
  const scenario = useScenario(q.root, [{ structured_output: ROUND1, session_id: 's' }, { structured_output: ROUND2 }]);
  const pending = q.cli('especificar', 'exportar-csv');
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.stdout, /Perguntas\n {2}1\. Pedido cancelado entra\? \(R2\)\n {5}sugestão: Não/);
  assert.match(q.cli('especificar').stdout, /^exportar-csv · rascunho · sem tarefas · inválida · perguntas pendentes/);

  const accepted = q.cli('especificar', 'exportar-csv', '--aceitar');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /✓ Spec exportar-csv aceita · 3 regras · 3 exemplos · 2 rodadas · 2 perguntas · 2 tarefas\n {2}tarefas no backlog: #2, #3/);
  assert.match(scenario.log()[1]?.argv.at(-1) ?? '', /R: America\/Sao_Paulo/);
  assert.match(q.cli('especificar').stdout, /^exportar-csv · aceita · 0\/2 tarefas/);

  // Reespecificar a spec aceita não duplica as tarefas.
  useScenario(q.root, [{ structured_output: ROUND2 }]);
  assert.equal(q.cli('especificar', 'exportar-csv', '--refazer').status, 0);
  const again = q.cli('especificar', 'exportar-csv', '--aceitar');
  assert.match(again.stdout, /a spec já tinha as tarefas #2, #3: nenhuma acrescentada/);
  assert.equal((readFileSync(q.path, 'utf8').match(/Spec: exportar-csv/g) ?? []).length, 2);

  assert.equal(q.cli('especificar', 'exportar-csv', '--descartar').status, 1);
  assert.equal(q.cli('especificar', 'nao-existe').status, 1);
});

test('regras.md acima do orçamento: aviso de consolidar e o agente recebe só o começo', () => {
  const q = project();
  writeFileSync(join(q.root, '.mabel', 'regras.md'), 'x'.repeat(RULES_BUDGET + 10));
  const rules = currentRules(q.root);
  assert.match(rules.warning ?? '', /acima do orçamento de 20000: o agente lê só o começo\. Consolide/);
  assert.ok(rules.text.length < RULES_BUDGET + 200);
  assert.deepEqual(currentRules(join(q.root, 'nada')), { text: '' });
});
