import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, tryGit } from '../src/git.ts';
import { getItem, listItems, syncBacklog, transition } from '../src/items.ts';
import { lockPath } from '../src/lock.ts';
import { writeConfig } from '../src/project.ts';
import { CODE_CHANGED, type Clock, listQueueEvents, startQueue } from '../src/run.ts';
import { codeWatcher } from '../src/version.ts';
import { deleteBranch, prepareWorktree, worktreePath } from '../src/worktree.ts';
import { CLI, EXECUTION, EXECUTION_FILES, PLAN, REVIEW_OK, setupProject, useScenario } from './helpers.ts';

const EXEC = { structured_output: EXECUTION, files: EXECUTION_FILES };
const PLAN_OK = { structured_output: PLAN };
const REVIEW = { structured_output: REVIEW_OK };

function queueProject(backlog: string, responses: unknown[]) {
  const ctx = setupProject(backlog);
  ctx.project.config.setup = null;
  ctx.project.config.verify = [{ name: 'existe', command: 'test -f src/soma.js' }];
  writeConfig(ctx.root, ctx.project.config);
  const scenario = useScenario(ctx.root, responses);
  const states = () => listItems(ctx.db, ctx.project.id).map((item) => [item.number, item.status]);
  const calls = () =>
    scenario.log().map((call) => ({
      resume: call.argv.includes('--resume') ? call.argv[call.argv.indexOf('--resume') + 1] : undefined,
      prompt: call.argv.at(-1) as string,
      schema: call.argv.includes('--json-schema'),
    }));
  const merge = (number: number) => {
    const branch = getItem(ctx.db, ctx.project.id, number)?.branch as string;
    const result = spawnSync('git', ['merge', '-q', '--no-edit', branch], { cwd: ctx.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  /** Eventos da fila sem o horário: `[tipo, causa, aprovado?]`. */
  const events = () =>
    listQueueEvents(ctx.db, ctx.project.id).map((e) => (e.approved === undefined ? [e.kind, e.cause] : [e.kind, e.cause, e.approved]));
  return { ...ctx, states, calls, merge, events };
}

test('fila de três itens: dois em awaiting_merge, um em needs_human; responder e novo run concluem', () => {
  const q = queueProject('\n## A\nprimeiro\n\n## B\nsegundo\n\n## C\nterceiro\n', [
    PLAN_OK,
    { structured_output: { ...PLAN, perguntas: [{ texto: 'Qual banco usar?', sugestao: 'SQLite', regraCritica: true }] }, session_id: 'plan-b' },
    PLAN_OK,
    EXEC, REVIEW,
    EXEC, REVIEW,
    PLAN_OK, EXEC, REVIEW,
  ]);
  const first = q.cli('run');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'needs_human'], [3, 'awaiting_merge']]);
  assert.match(first.stdout, /#2 B: planning → needs_human · perguntas do planejamento: Qual banco usar\?/);
  assert.match(first.stdout, /■ fila vazia · awaiting_merge 2 · needs_human 1 · US\$ /);
  assert.match(first.stdout, / {4}→ Write/);

  const detail = q.cli('item', '2');
  assert.match(detail.stdout, /\? Qual banco usar\?/);
  assert.match(detail.stdout, /mabel responder 2 "<resposta>"/);

  assert.equal(q.cli('responder', '2', 'Use o SQLite.').status, 0);
  const second = q.cli('run');
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'awaiting_merge'], [3, 'awaiting_merge']]);
  const resumed = q.calls().filter((c) => c.schema)[7];
  assert.equal(resumed?.resume, 'plan-b');
  assert.match(resumed?.prompt ?? '', /Use o SQLite\./);
  const reasons = q.db.prepare("SELECT reason FROM item_transitions WHERE reason LIKE 'humano:%'").all() as { reason: string }[];
  assert.deepEqual(reasons.map((r) => r.reason), ['humano: responder: Use o SQLite.']);
});

test('merge manual da branch na base leva o item a done no próximo run e apaga a branch (P.3)', () => {
  const q = queueProject('\n## A\nprimeiro\n', [PLAN_OK, EXEC, REVIEW]);
  assert.equal(q.cli('run').status, 0);
  const item = getItem(q.db, q.project.id, 1)!;
  assert.equal(item.worktree, null);
  assert.equal(existsSync(worktreePath(q.home, q.project.id, item)), false);
  q.merge(1);
  const result = q.cli('run');
  assert.match(result.stdout, /#1 A: awaiting_merge → done/);
  assert.deepEqual(q.states(), [[1, 'done']]);
  assert.equal(tryGit(q.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${item.branch}`), undefined);
  assert.match(q.cli('status').stdout, /concluídos 1/);
});

test('P.3: branch fora da base não é apagada; worktrees órfãos saem na abertura do run', () => {
  const q = queueProject('\n## A\nprimeiro\n\n## B\nsegundo\n', [PLAN_OK, PLAN_OK, EXEC, REVIEW, EXEC, REVIEW]);
  assert.equal(q.cli('run').status, 0);
  const [a, b] = [getItem(q.db, q.project.id, 1)!, getItem(q.db, q.project.id, 2)!];
  assert.equal(deleteBranch(q.project, a.branch!), `branch ${a.branch} não está contida na main; não foi apagada`);
  assert.ok(tryGit(q.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${a.branch}`));

  // Worktree esquecido (ex.: run antigo interrompido depois do awaiting_merge).
  const orphan = worktreePath(q.home, q.project.id, b);
  spawnSync('git', ['worktree', 'add', '-q', orphan, b.branch!], { cwd: q.root });
  assert.ok(existsSync(orphan));
  const out = q.cli('run');
  assert.match(out.stdout, /worktrees removidos: #2/);
  assert.equal(existsSync(orphan), false);
  assert.doesNotMatch(spawnSync('git', ['worktree', 'list'], { cwd: q.root, encoding: 'utf8' }).stdout, new RegExp(orphan));
});

test('P.3: retrabalho em awaiting_merge recria o worktree a partir da branch', () => {
  const q = queueProject('\n## A\nprimeiro\n', [PLAN_OK, EXEC, REVIEW]);
  assert.equal(q.cli('run').status, 0);
  const item = getItem(q.db, q.project.id, 1)!;
  transition(q.db, q.project, item.id, 'executing', 'retrabalho');
  const prepared = prepareWorktree(q.db, q.home, q.project, getItem(q.db, q.project.id, 1)!);
  assert.equal(prepared.created, true);
  assert.equal(git(prepared.path, 'rev-parse', '--abbrev-ref', 'HEAD'), item.branch);
  assert.ok(existsSync(join(prepared.path, 'src/soma.js')));
});

test('item com dependência só inicia depois que a dependência fica done', () => {
  const execD = { ...EXEC, files: { ...EXECUTION_FILES, 'src/soma.js': 'export const soma = (a, b) => b + a;\n' } };
  const q = queueProject('\n## A\nprimeiro\n\n## D\ndepende\nDepende de: 1\n', [PLAN_OK, EXEC, REVIEW, PLAN_OK, execD, REVIEW]);
  q.cli('run');
  assert.deepEqual(q.states(), [[1, 'awaiting_merge'], [2, 'backlog']]);
  q.merge(1);
  const out = q.cli('run');
  assert.deepEqual(q.states(), [[1, 'done'], [2, 'awaiting_merge']], out.stdout + out.stderr);
});

test('ctrl+c no meio de uma etapa; novo run retoma pela mesma sessão; trava enquanto roda', async () => {
  const q = queueProject('\n## A\nprimeiro\n', [
    PLAN_OK,
    { hang: true, session_id: 'exec-h' },
    EXEC,
    REVIEW,
  ]);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'run'], {
    cwd: q.root,
    env: q.env(),
  });
  let stdout = '';
  await new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('▸ executar')) resolve();
    });
  });

  const second = q.cli('run');
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Já há um `mabel run` neste projeto \(pid \d+\)/);

  child.kill('SIGINT');
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  assert.equal(code, 130);
  assert.match(stdout, /■ interrompido/);
  assert.deepEqual(q.states(), [[1, 'executing']]);
  assert.equal(existsSync(lockPath(q.home, q.project.id)), false);

  const again = q.cli('run');
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(q.states(), [[1, 'awaiting_merge']]);
  const resumed = q.calls().filter((c) => c.schema)[2];
  assert.equal(resumed?.resume, 'exec-h');
  assert.match(resumed?.prompt ?? '', /foi interrompida antes de terminar/);
});

test('saldo de 5h abaixo de 30% fora do TTY espera o reset e retoma sozinho', async () => {
  const q = queueProject('\n## A\nprimeiro\n', [PLAN_OK, EXEC, REVIEW]);
  syncBacklog(q.db, q.project);
  // Relógio duas horas atrás: a leitura de 5h ainda vale para ele e reseta em 30 min.
  let now = Date.now() - 2 * 3600_000;
  const clock: Clock = {
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
  };
  const insert = q.db.prepare(
    'INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(new Date(now).toISOString(), 'five_hour', 0.8, new Date(now + 30 * 60_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.1, new Date(now + 5 * 86400_000).toISOString(), 'allowed');
  const start = now;

  const result = await startQueue({ db: q.db, home: q.home, project: q.project, clock, interactive: false }).done;
  assert.equal(result.end, 'empty');
  assert.deepEqual([...result.finalStates], [[1, 'awaiting_merge']]);
  assert.ok(now - start >= 30 * 60_000, 'esperou o reset');
  const probes = q.db.prepare("SELECT count(*) AS n FROM runs WHERE kind = 'probe'").get() as { n: number };
  assert.equal(probes.n, 1);
  assert.deepEqual(q.events(), [['wait', 'five_hour']]);
  const [wait] = listQueueEvents(q.db, q.project.id);
  assert.equal(wait?.until?.getTime(), start + 30 * 60_000);
  assert.match(wait?.detail ?? '', /janela de 5h em 20% \(abaixo de 30%\)/);
});

test('respostas às perguntas de saldo ficam gravadas: recusa espera, autorização segue', async () => {
  const q = queueProject('\n## A\nprimeiro\n', [PLAN_OK, EXEC, REVIEW]);
  syncBacklog(q.db, q.project);
  let now = Date.now() - 2 * 3600_000;
  const clock: Clock = {
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
  };
  const insert = q.db.prepare(
    'INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run(new Date(now).toISOString(), 'five_hour', 0.8, new Date(now + 30 * 60_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.1, new Date(now + 5 * 86400_000).toISOString(), 'allowed');
  const answers = [false];
  const result = await startQueue({
    db: q.db,
    home: q.home,
    project: q.project,
    clock,
    interactive: true,
    notify: () => {},
    confirm: async () => answers.shift() ?? assert.fail('pergunta a mais'),
  }).done;
  assert.equal(result.end, 'empty');
  assert.deepEqual(q.events(), [['answer', 'five_hour', false], ['wait', 'five_hour']]);
  assert.match(listQueueEvents(q.db, q.project.id)[0]?.detail ?? '', /saldo de 5h em 20%; continuar mesmo assim\?/);

  const yes = queueProject('\n## A\nprimeiro\n', [PLAN_OK]);
  syncBacklog(yes.db, yes.project);
  const at = Date.now();
  const add = yes.db.prepare(
    'INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)',
  );
  add.run(new Date(at).toISOString(), 'five_hour', 0.1, new Date(at + 3600_000).toISOString(), 'allowed');
  add.run(new Date(at).toISOString(), 'seven_day', 0.85, new Date(at + 86400_000).toISOString(), 'allowed');
  await startQueue({
    db: yes.db,
    home: yes.home,
    project: yes.project,
    interactive: true,
    once: true,
    notify: () => {},
    confirm: async () => true,
  }).done;
  assert.deepEqual(yes.events(), [['answer', 'seven_day', true]]);
});

test('janela de 7 dias acima do ritmo fora do TTY espera o ritmo alcançar e retoma sozinha', async () => {
  const q = queueProject('\n## A\nprimeiro\n', [PLAN_OK, EXEC, REVIEW]);
  syncBacklog(q.db, q.project);
  // Relógio 30 h atrás: a espera de ~26 h termina antes do horário real das leituras do claude falso.
  let now = Date.now() - 30 * 3600_000;
  const clock: Clock = {
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
  };
  const insert = q.db.prepare(
    'INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)',
  );
  // Um dia de sete decorrido (ritmo de 14%) com 40% usados: alcança em 2,1 dias desde o início.
  insert.run(new Date(now).toISOString(), 'five_hour', 0.1, new Date(now + 3600_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.4, new Date(now + 6 * 86400_000).toISOString(), 'allowed');
  const start = now;

  const result = await startQueue({ db: q.db, home: q.home, project: q.project, clock, interactive: false }).done;
  assert.equal(result.end, 'empty');
  assert.deepEqual([...result.finalStates], [[1, 'awaiting_merge']]);
  assert.ok(now - start >= 1.1 * 86400_000 - 1000, 'esperou o ritmo');
  assert.deepEqual(q.events(), [['wait', 'pace']]);
});

test('saldo de 7 dias abaixo de 30% fora do TTY pausa a fila com o motivo', async () => {
  const q = queueProject('\n## A\nprimeiro\n', [PLAN_OK]);
  syncBacklog(q.db, q.project);
  const insert = q.db.prepare(
    'INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)',
  );
  const now = Date.now();
  insert.run(new Date(now).toISOString(), 'five_hour', 0.1, new Date(now + 3600_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.85, new Date(now + 86400_000).toISOString(), 'allowed');
  const result = await startQueue({ db: q.db, home: q.home, project: q.project, interactive: false }).done;
  assert.equal(result.end, 'paused');
  assert.match(result.message ?? '', /janela de 7 dias em 15%/);
  assert.deepEqual(q.states(), [[1, 'planning']]);
  assert.deepEqual(q.events(), [['pause', 'seven_day']]);
  assert.match(listQueueEvents(q.db, q.project.id)[0]?.detail ?? '', /fila pausada até sua decisão \(abaixo de 30%\)/);
});

test('contexto acima do orçamento pausa a fila e a pausa fica gravada', async () => {
  const q = queueProject('\n## A\nprimeiro\n', [PLAN_OK]);
  writeFileSync(join(q.root, 'CLAUDE.md'), 'x'.repeat(41_000));
  git(q.root, 'add', 'CLAUDE.md');
  git(q.root, 'commit', '-q', '-m', 'contexto grande');
  syncBacklog(q.db, q.project);
  const result = await startQueue({ db: q.db, home: q.home, project: q.project, interactive: false }).done;
  assert.equal(result.end, 'paused');
  assert.deepEqual(q.events(), [['pause', 'context']]);
  assert.equal(listQueueEvents(q.db, q.project.id)[0]?.detail, result.message);
});

test('Mabel atualizado com o processo aberto pausa a fila antes da próxima etapa', async () => {
  const q = queueProject('\n## A\nprimeiro\n', [PLAN_OK]);
  syncBacklog(q.db, q.project);
  const result = await startQueue({ db: q.db, home: q.home, project: q.project, interactive: false, codeChanged: () => true }).done;
  assert.equal(result.end, 'paused');
  assert.equal(result.message, CODE_CHANGED);
  assert.deepEqual(q.calls(), [], 'nenhuma run começa com código misturado');
  assert.deepEqual(q.events(), [['pause', 'code']]);
});

test('vigia do código: arquivo novo ou alterado em src, prompts ou hooks', () => {
  const root = mkdtempSync(join(tmpdir(), 'mabel-codigo-'));
  for (const dir of ['src', 'prompts']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'src', 'a.ts'), 'x');
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(root, 'src', 'a.ts'), old, old);
  const changed = codeWatcher(root);
  assert.equal(changed(), false);
  writeFileSync(join(root, 'README.md'), 'fora das pastas do Mabel');
  assert.equal(changed(), false);
  writeFileSync(join(root, 'prompts', 'executar.md'), 'novo');
  assert.equal(changed(), true);
});

test('aprovar e cancelar pela linha de comando', () => {
  const q = queueProject('\n## A\nprimeiro\n\n## B\nsegundo\n', [
    { structured_output: { ...PLAN, conceitosCriticos: ['Desconto'] } },
    { structured_output: { ...PLAN, perguntas: [{ texto: '?', sugestao: '', regraCritica: false }] } },
  ]);
  q.cli('run');
  assert.deepEqual(q.states(), [[1, 'needs_human'], [2, 'needs_human']]);
  assert.match(q.cli('item', '1').stdout, /mabel aprovar 1/);
  assert.equal(q.cli('aprovar', '1').status, 0);
  assert.equal(q.cli('aprovar', '2').status, 1);
  assert.equal(q.cli('cancelar', '2').status, 0);
  assert.deepEqual(q.states(), [[1, 'planned'], [2, 'cancelled']]);
  assert.equal(q.cli('responder', '9', 'x').status, 1);
});

test('run commita na base o que está pendente no .mabel/, sem levar o resto do índice', () => {
  const ctx = setupProject();
  mkdirSync(join(ctx.root, '.mabel', 'specs'));
  writeFileSync(join(ctx.root, '.mabel', 'specs', 'a.md'), '# spec a\n');
  git(ctx.root, 'add', '.mabel/specs/a.md');
  writeFileSync(join(ctx.root, '.mabel', 'specs', 'b.md'), '# spec b\n');
  writeFileSync(join(ctx.root, 'outro.md'), 'staged do humano\n');
  git(ctx.root, 'add', 'outro.md');

  const result = ctx.cli('run');
  assert.match(result.stdout, /\.mabel\/ commitado na main: \.mabel\/specs\/a\.md, \.mabel\/specs\/b\.md/);
  assert.equal(git(ctx.root, 'show', 'main:.mabel/specs/b.md'), '# spec b');
  assert.equal(git(ctx.root, 'show', '--name-only', '--format=', 'main'), '.mabel/specs/a.md\n.mabel/specs/b.md');
  assert.equal(git(ctx.root, 'status', '--porcelain'), 'A  outro.md');
});

test('run com a raiz fora da base não commita o .mabel/ e avisa', () => {
  const ctx = setupProject();
  git(ctx.root, 'switch', '-q', '-c', 'outra');
  writeFileSync(join(ctx.root, '.mabel', 'spec.md'), '# spec\n');
  const result = ctx.cli('run');
  assert.match(result.stdout, /Aviso: o \.mabel\/ tem alterações sem commit .*a raiz está na branch outra, não na main/);
  assert.equal(tryGit(ctx.root, 'cat-file', '-e', 'main:.mabel/spec.md'), undefined);
  assert.equal(git(ctx.root, 'status', '--porcelain'), '?? .mabel/spec.md');
});

test('run recusa começar com o .mabel/ fora da branch base', () => {
  const ctx = setupProject('\n## Item\nfazer algo\n');
  spawnSync('git', ['rm', '-q', '-r', '--cached', '.mabel'], { cwd: ctx.root });
  spawnSync('git', ['commit', '-q', '-m', 'tira o .mabel'], { cwd: ctx.root });
  git(ctx.root, 'switch', '-q', '-c', 'outra');
  const result = ctx.cli('run');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /não está commitado na branch main/);
  assert.equal(existsSync(lockPath(ctx.home, ctx.project.id)), false);
});
