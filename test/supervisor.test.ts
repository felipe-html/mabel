import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKLOG_TEMPLATE } from '../src/backlog.ts';
import { processAlive } from '../src/db.ts';
import { eventCursor, pollEvents } from '../src/events.ts';
import { commitMabelDir } from '../src/init.ts';
import { listItems, syncBacklog } from '../src/items.ts';
import { lockHolder } from '../src/lock.ts';
import { type Project, readConfig, resolveProject, writeConfig } from '../src/project.ts';
import { listQueueEvents, recordQueueEvent, startQueue } from '../src/run.ts';
import { agentPath, queueLogPath, queueStatePath, readQueueState, socketPath } from '../src/supervisor.ts';
import { CLI, PLAN, makeRepo, setupProject, useScenario } from './helpers.ts';

const node = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { cwd, encoding: 'utf8', env });

/** Ajustes dos testes da fila: sem setup, verificação trivial, sem prova nem integração. */
function prepare(root: string): void {
  const config = readConfig(root)!;
  writeConfig(root, { ...config, setup: null, verify: [{ name: 'existe', command: 'true' }], testeUnico: null, integracao: null });
  commitMabelDir(root);
}

/** Dois projetos no mesmo `MABEL_HOME`, cada um com um item. */
function twoProjects() {
  const a = setupProject('\n## A\nprimeiro\n');
  prepare(a.root);
  const rootB = makeRepo({ 'src/index.js': '', 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  assert.equal(node(['preparar'], rootB, a.env()).status, 0);
  writeFileSync(join(rootB, '.mabel', 'backlog.md'), `${BACKLOG_TEMPLATE}\n## B\nsegundo\n`);
  prepare(rootB);
  const b = resolveProject(a.db, rootB);
  syncBacklog(a.db, a.project);
  syncBacklog(a.db, b);
  return { ...a, a: a.project, b, cliIn: (project: Project, ...args: string[]) => node(args, project.root, a.env()) };
}

/** Último `start`/`stop` do projeto no `queue_events`: `[tipo, detalhe]`. */
function lastStartStop(db: ReturnType<typeof setupProject>['db'], projectId: string): [string, string] | undefined {
  const row = db
    .prepare("SELECT kind, detail FROM queue_events WHERE project_id = ? AND kind IN ('start', 'stop') ORDER BY id DESC LIMIT 1")
    .get(projectId) as { kind: string; detail: string } | undefined;
  return row ? [row.kind, row.detail] : undefined;
}

async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, `não aconteceu a tempo: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** `mabel supervisor` num processo próprio, como o launchd o roda. */
async function startSupervisor(home: string, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; output: () => string; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'supervisor'], { cwd: home, env });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  await until(() => output.includes('supervisor ouvindo'), 'supervisor ouvindo');
  return {
    child,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        child.on('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

/** Interrompe a fila (ctrl+c) e espera a trava sair. */
async function interruptQueue(home: string, project: Project): Promise<void> {
  const pid = lockHolder(home, project.id);
  if (pid !== undefined) process.kill(pid, 'SIGINT');
  await until(() => lockHolder(home, project.id) === undefined, 'fila interrompida');
}

test('stop: a etapa em andamento termina e a fila encerra antes da próxima', async () => {
  const p = setupProject('\n## A\nprimeiro\n\n## B\nsegundo\n');
  prepare(p.root);
  const project = resolveProject(p.db, p.root);
  syncBacklog(p.db, project);
  useScenario(p.root, [{ structured_output: PLAN, delay_ms: 400 }, { structured_output: PLAN }]);
  // Leituras frescas: sem probe, a primeira chamada ao `claude` é a etapa.
  const now = Date.now();
  const insert = p.db.prepare('INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)');
  insert.run(new Date(now).toISOString(), 'five_hour', 0.1, new Date(now + 3600_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.1, new Date(now + 3 * 86_400_000).toISOString(), 'allowed');
  const marker = join(p.root, 'claude-iniciou.json');
  process.env.FAKE_CLAUDE_MARKER = marker;
  const queue = startQueue({ db: p.db, home: p.home, project, interactive: false });
  try {
    await until(() => existsSync(marker), 'etapa iniciada');
  } finally {
    delete process.env.FAKE_CLAUDE_MARKER;
  }
  queue.stop();
  const result = await queue.done;
  assert.equal(result.end, 'stopped');
  assert.deepEqual(
    listItems(p.db, project.id).map((item) => [item.number, item.status]),
    [
      [1, 'planned'],
      [2, 'ready'],
    ],
  );
  assert.deepEqual(lastStartStop(p.db, project.id), ['stop', 'stopped']);
});

test('mabel parar num run em primeiro plano; sem fila, avisa que não está rodando', async () => {
  const p = setupProject('\n## A\nprimeiro\n\n## B\nsegundo\n');
  prepare(p.root);
  // A etapa só termina quando o teste cria o arquivo, depois de o `parar` voltar.
  const release = join(p.root, '..', `liberar-${Math.random().toString(36).slice(2)}`);
  useScenario(p.root, [{ structured_output: PLAN, wait_for: release }, { structured_output: PLAN }]);
  const idle = p.cli('parar');
  assert.equal(idle.status, 0);
  assert.match(idle.stdout, /não está rodando/);

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'rodar'], { cwd: p.root, env: p.env() });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  await until(() => stdout.includes('▸ planejar'), 'etapa iniciada');
  const stop = p.cli('parar');
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /para depois da etapa em andamento/);
  const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
  writeFileSync(release, '');
  const code = await closed;
  assert.equal(code, 0);
  assert.match(stdout, /■ parado/);
  const project = resolveProject(p.db, p.root);
  assert.deepEqual(
    listItems(p.db, project.id).map((item) => item.status),
    ['planned', 'ready'],
  );
});

test('run --fundo sem supervisor diz como iniciá-lo', () => {
  const p = setupProject('\n## A\nprimeiro\n');
  const result = p.cli('rodar', '--fundo');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /supervisor não está rodando.*mabel supervisor instalar/);
});

test('supervisor: duas filas seguem depois que o terminal sai; anexar mostra ao vivo e solta sem parar', async () => {
  const p = twoProjects();
  useScenario(p.root, [{ hang: true, session_id: 'h1' }, { hang: true, session_id: 'h2' }]);
  const supervisor = await startSupervisor(p.home, p.env());
  try {
    for (const project of [p.a, p.b]) {
      const result = p.cliIn(project, 'rodar', '--fundo');
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /em segundo plano \(pid \d+\)/);
    }
    for (const project of [p.a, p.b]) {
      await until(() => existsSync(queueLogPath(p.home, project.id)) && readFileSync(queueLogPath(p.home, project.id), 'utf8').includes('▸ planejar'), `planejar em ${project.name}`);
      assert.ok(lockHolder(p.home, project.id) !== undefined);
    }
    const json = JSON.parse(p.cliIn(p.a, 'listar', '--json').stdout);
    assert.deepEqual(json.projetos.map((project: { fila: string }) => project.fila), ['rodando', 'rodando']);
    const state = p.cliIn(p.a, 'supervisor', 'estado');
    assert.equal(state.status, 0, state.stderr);
    assert.equal(state.stdout.match(/pid \d+ · desde/g)?.length, 2);

    for (const project of [p.a, p.b]) {
      const attach = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'acompanhar'], { cwd: project.root, env: p.env() });
      let out = '';
      attach.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      await until(() => out.includes('▸ planejar'), `anexar em ${project.name}`);
      attach.kill('SIGINT');
      const code = await new Promise<number | null>((resolve) => attach.on('close', resolve));
      assert.equal(code, 0);
      assert.match(out, /Solto; a fila continua/);
      assert.ok(lockHolder(p.home, project.id) !== undefined, 'a fila continua depois de soltar');
    }
  } finally {
    await interruptQueue(p.home, p.a);
    await interruptQueue(p.home, p.b);
    await supervisor.stop();
  }
  assert.equal(existsSync(socketPath(p.home)), false);
  await until(() => readQueueState(p.home, p.a.id)?.desired === 'parada', 'estado parado');
});

test('supervisor: saldo abaixo do piso pausa as duas filas, com o evento fila de cada uma', async () => {
  const p = twoProjects();
  useScenario(p.root, []);
  const now = Date.now();
  const insert = p.db.prepare('INSERT INTO rate_limits (observed_at, window, utilization, resets_at, status) VALUES (?, ?, ?, ?, ?)');
  insert.run(new Date(now).toISOString(), 'five_hour', 0.1, new Date(now + 3600_000).toISOString(), 'allowed');
  insert.run(new Date(now).toISOString(), 'seven_day', 0.85, new Date(now + 86_400_000).toISOString(), 'allowed');
  const cursor = eventCursor(p.db);
  const supervisor = await startSupervisor(p.home, p.env());
  try {
    for (const project of [p.a, p.b]) assert.equal(p.cliIn(project, 'rodar', '--fundo').status, 0);
    for (const project of [p.a, p.b]) {
      await until(() => lastStartStop(p.db, project.id)?.[0] === 'stop', `fim da fila de ${project.name}`);
      assert.ok(listQueueEvents(p.db, project.id).some((e) => e.kind === 'pause' && e.cause === 'seven_day'));
    }
  } finally {
    await supervisor.stop();
  }
  const paused = pollEvents(p.db, cursor)
    .filter((e) => e.tipo === 'fila' && e.estado === 'pausada_por_saldo')
    .map((e) => e.projeto)
    .sort();
  assert.deepEqual(paused, [p.a.name, p.b.name].sort());
  const json = JSON.parse(p.cliIn(p.a, 'listar', '--json').stdout);
  assert.deepEqual(json.projetos.map((project: { fila: string }) => project.fila), ['pausada_por_saldo', 'pausada_por_saldo']);
});

test('supervisor retoma a fila que morreu sem terminar; a que terminou fica parada', async () => {
  const p = twoProjects();
  useScenario(p.root, [{ hang: true }]);
  const dead = spawnSync('true').pid as number;
  assert.equal(processAlive(dead), false);
  mkdirSync(join(p.home, 'filas'), { recursive: true });
  for (const project of [p.a, p.b]) {
    writeFileSync(
      queueStatePath(p.home, project.id),
      JSON.stringify({ projectId: project.id, root: project.root, args: [], pid: dead, startedAt: new Date().toISOString(), desired: 'rodando' }),
    );
    recordQueueEvent(p.db, project.id, { at: new Date(), kind: 'start', cause: 'queue', detail: '' });
  }
  // A fila de B terminou enquanto o supervisor estava fora.
  recordQueueEvent(p.db, p.b.id, { at: new Date(), kind: 'stop', cause: 'queue', detail: 'empty' });

  const supervisor = await startSupervisor(p.home, p.env());
  try {
    await until(() => lockHolder(p.home, p.a.id) !== undefined, 'fila de A retomada');
    assert.match(supervisor.output(), /retomando a fila/);
    await until(() => readQueueState(p.home, p.b.id)?.desired === 'parada', 'fila de B marcada como parada');
    assert.equal(lockHolder(p.home, p.b.id), undefined);
  } finally {
    await interruptQueue(p.home, p.a);
    await supervisor.stop();
  }
});

test('supervisor instalar e remover gravam o LaunchAgent e chamam o launchctl', () => {
  const p = setupProject();
  const dir = mkdtempSync(join(tmpdir(), 'mabel-agents-'));
  const calls = join(dir, 'launchctl.log');
  const launchctl = join(dir, 'launchctl');
  writeFileSync(launchctl, `#!/bin/sh\necho "$@" >> '${calls}'\n`);
  chmodSync(launchctl, 0o755);
  const env = { ...p.env(), MABEL_LAUNCH_AGENTS: dir, MABEL_LAUNCHCTL: launchctl };

  const install = node(['supervisor', 'instalar'], p.root, env);
  assert.equal(install.status, 0, install.stderr);
  const plist = readFileSync(join(dir, 'dev.mabel.supervisor.plist'), 'utf8');
  assert.match(plist, /<string>dev\.mabel\.supervisor<\/string>/);
  assert.match(plist, /<string>supervisor<\/string>\n {2}<\/array>/);
  assert.match(plist, new RegExp(`<key>MABEL_HOME</key>\\n\\s*<string>${p.home}</string>`));
  assert.match(plist, /<key>KeepAlive<\/key>\n {2}<true\/>/);
  assert.match(readFileSync(calls, 'utf8'), /^bootout gui\/\d+\/dev\.mabel\.supervisor\nbootstrap gui\/\d+ .*dev\.mabel\.supervisor\.plist\n$/);

  const remove = node(['supervisor', 'remover'], p.root, env);
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal(existsSync(join(dir, 'dev.mabel.supervisor.plist')), false);
  assert.match(remove.stdout, /filas em andamento continuam/);
  assert.equal(agentPath().endsWith('dev.mabel.supervisor.plist'), true);
});

test('sem TTY, nenhum comando de cliente espera resposta; o que falta vira código 1 com o argumento', async () => {
  const p = setupProject('\n## A\nprimeiro\n');
  syncBacklog(p.db, p.project);
  const empty = makeRepo();
  /** Roda com o stdin aberto e sem terminal: um comando que perguntasse ficaria preso. */
  const run = (cwd: string, ...args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { cwd, env: p.env(), stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`mabel ${args.join(' ')} ficou esperando: ${stdout}${stderr}`));
      }, 15_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });

  const cases: [string, string[], number, RegExp][] = [
    [p.root, ['rodar', '--fundo'], 1, /mabel supervisor instalar/],
    [p.root, ['parar'], 0, /não está rodando/],
    [p.root, ['aprovar'], 1, /Informe o número do item/],
    [p.root, ['responder', '1'], 1, /Informe a resposta/],
    [p.root, ['auditar', 'remover', p.project.name], 1, /--confirmar/],
    [empty, ['preparar'], 0, /\.mabel\/ criado/],
  ];
  for (const [cwd, args, code, output] of cases) {
    const result = await run(cwd, ...args);
    assert.equal(result.code, code, `mabel ${args.join(' ')}: ${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, output, `mabel ${args.join(' ')}`);
  }
});
