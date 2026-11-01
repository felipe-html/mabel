import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { type Server, type Socket, connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dataDir, openDb, processAlive } from './db.ts';
import { fail } from './errors.ts';
import { writeJson } from './json.ts';
import { lockHolder } from './lock.ts';
import { ProjectError, resolveProject } from './project.ts';
import { style } from './style.ts';
import { type ArgSpec, type OptionSpecs, jsonOption } from './options.ts';

/**
 * Supervisor (`docs/specs/integracao-externa.md`): um processo por máquina que inicia as
 * filas em segundo plano. Cada fila é um `mabel rodar` destacado, com a saída num log por
 * projeto e a trava de sempre; o supervisor pode cair e voltar sem levar as filas junto.
 */

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const NODE_ARGS = ['--disable-warning=ExperimentalWarning'];

export function socketPath(home: string): string {
  return join(home, 'supervisor.sock');
}

/** `~/.mabel/filas/`: o log e o estado da fila em segundo plano de cada projeto. */
export function queuesDir(home: string): string {
  return join(home, 'filas');
}

export function queueLogPath(home: string, projectId: string): string {
  return join(queuesDir(home), `${projectId}.log`);
}

export function queueStatePath(home: string, projectId: string): string {
  return join(queuesDir(home), `${projectId}.json`);
}

/** Fila em segundo plano: `rodando` enquanto o supervisor deve mantê-la. */
export interface BackgroundQueue {
  projectId: string;
  root: string;
  args: string[];
  pid: number;
  startedAt: string;
  desired: 'rodando' | 'parada';
}

export function readQueueState(home: string, projectId: string): BackgroundQueue | undefined {
  try {
    return JSON.parse(readFileSync(queueStatePath(home, projectId), 'utf8')) as BackgroundQueue;
  } catch {
    return undefined;
  }
}

function writeQueueState(home: string, queue: BackgroundQueue): void {
  mkdirSync(queuesDir(home), { recursive: true });
  writeFileSync(queueStatePath(home, queue.projectId), `${JSON.stringify(queue, null, 2)}\n`);
}

/** Marca a fila como parada: o supervisor não a retoma quando voltar. */
export function markQueueStopped(home: string, projectId: string, pid?: number): void {
  const state = readQueueState(home, projectId);
  if (state && state.desired === 'rodando' && (pid === undefined || state.pid === pid)) {
    writeQueueState(home, { ...state, desired: 'parada' });
  }
}

/** Cabeçalho que separa as execuções no log; o `anexar` começa pelo último. */
export const LOG_HEADER = '── mabel rodar';

// Protocolo ------------------------------------------------------------------------------

export type SupervisorRequest = { acao: 'rodar'; raiz: string; args: string[] } | { acao: 'estado' };

export type SupervisorResponse =
  | { ok: true; pid?: number; filas?: { projeto_id: string; raiz: string; pid: number; desde: string }[] }
  | { ok: false; erro: string };

export class SupervisorUnavailable extends Error {}

/** Um pedido por conexão: uma linha de JSON em cada sentido. */
export function request(home: string, message: SupervisorRequest, timeoutMs = 20_000): Promise<SupervisorResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath(home));
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('o supervisor não respondeu a tempo'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data) as SupervisorResponse);
      } catch {
        reject(new Error(`resposta inválida do supervisor: ${data}`));
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
        reject(new SupervisorUnavailable('O supervisor não está rodando. Instale com `mabel supervisor instalar` ou rode `mabel supervisor` num terminal.'));
      } else reject(error);
    });
  });
}

// Filas ----------------------------------------------------------------------------------

/** Última execução registrada no `queue_events` do projeto terminou (`stop`)? */
function queueFinished(db: DatabaseSync, projectId: string): boolean {
  const row = db
    .prepare("SELECT kind FROM queue_events WHERE project_id = ? AND kind IN ('start', 'stop') ORDER BY id DESC LIMIT 1")
    .get(projectId) as { kind: string } | undefined;
  return row?.kind !== 'start';
}

/** Texto do log desde o último cabeçalho. */
export function lastSection(path: string): string {
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  const at = text.lastIndexOf(LOG_HEADER);
  return at < 0 ? text : text.slice(at);
}

interface Supervisor {
  server: Server;
  close: () => Promise<void>;
}

/**
 * Inicia uma fila em segundo plano e espera ela pegar a trava (ou sair, com o fim do log
 * como erro). O filho é destacado, com a saída no arquivo: não depende do supervisor.
 */
async function launch(db: DatabaseSync, home: string, root: string, args: string[], log: (line: string) => void): Promise<SupervisorResponse> {
  let project;
  try {
    project = resolveProject(db, root);
  } catch (error) {
    if (error instanceof ProjectError) return { ok: false, erro: error.message };
    throw error;
  }
  const holder = lockHolder(home, project.id);
  if (holder !== undefined) return { ok: false, erro: `Já há um \`mabel rodar\` neste projeto (pid ${holder}).` };

  mkdirSync(queuesDir(home), { recursive: true });
  const logPath = queueLogPath(home, project.id);
  const fd = openSync(logPath, 'a');
  writeFileSync(fd, `\n${LOG_HEADER} ${args.join(' ')} · ${new Date().toISOString()} ──\n`);
  const child = spawn(process.execPath, [...NODE_ARGS, CLI, 'rodar', ...args], {
    cwd: project.root,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: process.env,
  });
  closeSync(fd);
  const pid = child.pid as number;
  child.unref();
  writeQueueState(home, { projectId: project.id, root: project.root, args, pid, startedAt: new Date().toISOString(), desired: 'rodando' });
  log(`fila de ${project.name} iniciada (pid ${pid})`);

  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  child.on('exit', (code) => {
    markQueueStopped(home, project.id, pid);
    log(`fila de ${project.name} terminou (pid ${pid}, código ${code})`);
  });
  const started = new Promise<'started'>((resolve) => {
    const timer = setInterval(() => {
      if (lockHolder(home, project.id) === pid) {
        clearInterval(timer);
        resolve('started');
      }
    }, 50);
    exited.then(() => clearInterval(timer));
  });
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000).unref());
  const outcome = await Promise.race([started, exited, timeout]);
  if (outcome === 'started' || outcome === 'timeout') return { ok: true, pid };
  const tail = lastSection(logPath).split('\n').slice(1).join('\n').trim();
  return { ok: false, erro: tail || `o \`mabel rodar\` saiu com código ${outcome}` };
}

/** Filas que o supervisor mantém: as `rodando` cujo processo segue vivo. */
function backgroundQueues(home: string): BackgroundQueue[] {
  return queueIds(queuesDir(home)).flatMap((projectId) => {
    const state = readQueueState(home, projectId);
    return state && state.desired === 'rodando' && processAlive(state.pid) ? [state] : [];
  });
}

/** Ids dos projetos com estado em `filas/`. */
function queueIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
}

/**
 * Retomada na abertura: fila marcada `rodando` cujo processo morreu sem gravar o `stop`
 * (reinício da máquina, processo morto) volta com os mesmos argumentos; a que terminou
 * enquanto o supervisor estava fora só é marcada como parada.
 */
async function resume(db: DatabaseSync, home: string, log: (line: string) => void): Promise<void> {
  for (const projectId of queueIds(queuesDir(home))) {
    const state = readQueueState(home, projectId);
    if (!state || state.desired !== 'rodando') continue;
    if (processAlive(state.pid) && lockHolder(home, projectId) === state.pid) {
      log(`fila ${projectId.slice(0, 8)} segue rodando (pid ${state.pid})`);
      continue;
    }
    if (queueFinished(db, projectId)) {
      markQueueStopped(home, projectId);
      continue;
    }
    log(`retomando a fila ${projectId.slice(0, 8)} em ${state.root}`);
    const result = await launch(db, home, state.root, state.args, log);
    if (!result.ok) {
      markQueueStopped(home, projectId);
      log(`não foi possível retomar: ${result.erro}`);
    }
  }
}

/** Sobe o servidor no socket; recusa se outro supervisor responde nele. */
export async function startSupervisor(home: string, log: (line: string) => void = () => {}): Promise<Supervisor> {
  mkdirSync(home, { recursive: true });
  const path = socketPath(home);
  if (existsSync(path)) {
    try {
      await request(home, { acao: 'estado' }, 2000);
      throw new Error(`Já há um supervisor rodando em ${path}.`);
    } catch (error) {
      if (!(error instanceof SupervisorUnavailable)) throw error;
      rmSync(path, { force: true });
    }
  }
  const db = openDb(home);
  const handle = async (message: SupervisorRequest): Promise<SupervisorResponse> => {
    if (message.acao === 'estado') {
      return {
        ok: true,
        pid: process.pid,
        filas: backgroundQueues(home).map((q) => ({ projeto_id: q.projectId, raiz: q.root, pid: q.pid, desde: q.startedAt })),
      };
    }
    if (message.acao === 'rodar') return launch(db, home, message.raiz, message.args ?? [], log);
    return { ok: false, erro: `ação desconhecida: ${(message as { acao: string }).acao}` };
  };
  const server = createServer((socket: Socket) => {
    let data = '';
    socket.on('data', async (chunk) => {
      data += chunk.toString('utf8');
      const end = data.indexOf('\n');
      if (end < 0) return;
      let response: SupervisorResponse;
      try {
        response = await handle(JSON.parse(data.slice(0, end)) as SupervisorRequest);
      } catch (error) {
        response = { ok: false, erro: (error as Error).message };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
  log(`supervisor ouvindo em ${path} (pid ${process.pid})`);
  await resume(db, home, log);
  // Filas cujo processo saiu sem o supervisor ver (adotadas depois de um reinício dele).
  const sweep = setInterval(() => {
    for (const projectId of queueIds(queuesDir(home))) {
      const state = readQueueState(home, projectId);
      if (state?.desired === 'rodando' && !processAlive(state.pid)) markQueueStopped(home, projectId, state.pid);
    }
  }, 5000);
  sweep.unref();
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        server.close(() => {
          db.close();
          resolve();
        });
        rmSync(path, { force: true });
      }),
  };
}

// LaunchAgent ----------------------------------------------------------------------------

export const AGENT_LABEL = 'dev.mabel.supervisor';

function agentsDir(): string {
  return process.env.MABEL_LAUNCH_AGENTS || join(homedir(), 'Library', 'LaunchAgents');
}

export function agentPath(): string {
  return join(agentsDir(), `${AGENT_LABEL}.plist`);
}

/** Variáveis que o supervisor herda do terminal que o instalou: o `claude`, o `git` e o banco. */
const AGENT_ENV = ['PATH', 'MABEL_HOME', 'CLAUDE_CONFIG_DIR', 'MABEL_CLAUDE_BIN', 'LANG'];

const xml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function agentPlist(home: string): string {
  const args = [process.execPath, ...NODE_ARGS, CLI, 'supervisor'];
  const env = AGENT_ENV.filter((name) => process.env[name]).map(
    (name) => `      <key>${name}</key>\n      <string>${xml(process.env[name] as string)}</string>`,
  );
  const log = xml(join(home, 'supervisor.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.join('\n')}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(homedir())}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function launchctl(...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.env.MABEL_LAUNCHCTL || 'launchctl', args, { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

const domain = () => `gui/${process.getuid?.() ?? 0}`;

// Comandos -------------------------------------------------------------------------------

export const supervisorUsage = 'mabel supervisor [instalar | remover | estado]';

export async function supervisorCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (rest.length > 0 || (action !== undefined && !['instalar', 'remover', 'estado'].includes(action))) {
    process.stderr.write(`Uso: ${supervisorUsage}\n`);
    return 1;
  }
  const home = dataDir();
  if (action === 'instalar') return install(home);
  if (action === 'remover') return uninstall();
  if (action === 'estado') return state(home);

  const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
  let supervisor: Supervisor;
  try {
    supervisor = await startSupervisor(home, log);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await supervisor.close();
  log('supervisor encerrado; as filas em andamento continuam');
  return 0;
}

function install(home: string): number {
  if (process.platform !== 'darwin' && !process.env.MABEL_LAUNCHCTL) {
    process.stderr.write('O LaunchAgent é do macOS. Em outro sistema, rode `mabel supervisor` pelo gerenciador de serviços.\n');
    return 1;
  }
  const path = agentPath();
  mkdirSync(agentsDir(), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path, agentPlist(home));
  launchctl('bootout', `${domain()}/${AGENT_LABEL}`);
  const result = launchctl('bootstrap', domain(), path);
  if (result.status !== 0) {
    process.stderr.write(`LaunchAgent gravado em ${path}, mas o launchctl recusou: ${result.output}\n`);
    return 1;
  }
  process.stdout.write(
    `Supervisor instalado: ${path}\nEle sobe com a sessão do macOS; o log fica em ${join(home, 'supervisor.log')}.\n`,
  );
  return 0;
}

function uninstall(): number {
  const path = agentPath();
  launchctl('bootout', `${domain()}/${AGENT_LABEL}`);
  if (!existsSync(path)) {
    process.stdout.write('O supervisor não estava instalado.\n');
    return 0;
  }
  rmSync(path);
  process.stdout.write(`Supervisor removido (${path}). As filas em andamento continuam até terminar.\n`);
  return 0;
}

async function state(home: string): Promise<number> {
  try {
    const response = await request(home, { acao: 'estado' });
    if (!response.ok) throw new Error(response.erro);
    const filas = response.filas ?? [];
    process.stdout.write(`Supervisor rodando (pid ${response.pid}).\n`);
    if (filas.length === 0) process.stdout.write(style.dim('Nenhuma fila em segundo plano.\n'));
    for (const fila of filas) process.stdout.write(`  ${fila.raiz} · pid ${fila.pid} · desde ${fila.desde}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

// anexar e parar -------------------------------------------------------------------------

export const attachUsage = 'mabel acompanhar';
export const stopUsage = 'mabel parar [--json]';

export const stopOptions = { json: jsonOption } satisfies OptionSpecs;

export const supervisorArgs: ArgSpec[] = [
  {
    name: 'instalar | remover | estado',
    description: 'Sem nada, roda o supervisor neste terminal',
    choices: [
      { name: 'instalar', description: 'Instala o supervisor no launchd, para subir com o login' },
      { name: 'remover', description: 'Tira o supervisor do launchd' },
      { name: 'estado', description: 'Mostra se o supervisor está instalado e rodando' },
    ],
  },
];

/** Lê o que o arquivo ganhou desde `offset`. */
function readFrom(path: string, offset: number): { text: string; offset: number } {
  const size = statSync(path).size;
  if (size <= offset) return { text: '', offset: size < offset ? 0 : offset };
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    return { text: buffer.toString('utf8'), offset: size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Mostra a execução atual da fila em segundo plano e acompanha o log até a fila terminar.
 * Ctrl+C solta o terminal sem parar a fila.
 */
export async function attachCommand(args: string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write(`Uso: ${attachUsage}\n`);
    return 1;
  }
  const home = dataDir();
  const db = openDb(home);
  let project;
  try {
    project = resolveProject(db);
  } catch (error) {
    if (error instanceof ProjectError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
  const path = queueLogPath(home, project.id);
  if (!existsSync(path)) {
    process.stdout.write('Nenhuma fila em segundo plano neste projeto. Inicie com `mabel rodar --fundo`.\n');
    return 0;
  }
  const section = lastSection(path);
  process.stdout.write(section);
  let offset = statSync(path).size;
  const running = () => {
    const state = readQueueState(home, project.id);
    return state !== undefined && state.desired === 'rodando' && processAlive(state.pid);
  };
  if (!running()) {
    process.stdout.write(style.dim('\nA fila não está rodando em segundo plano.\n'));
    return 0;
  }
  const detached = await new Promise<boolean>((resolve) => {
    const onSigint = () => {
      clearInterval(timer);
      resolve(true);
    };
    process.once('SIGINT', onSigint);
    const timer = setInterval(() => {
      const chunk = readFrom(path, offset);
      offset = chunk.offset;
      if (chunk.text) process.stdout.write(chunk.text);
      if (!running()) {
        const rest = readFrom(path, offset);
        if (rest.text) process.stdout.write(rest.text);
        clearInterval(timer);
        process.off('SIGINT', onSigint);
        resolve(false);
      }
    }, 200);
  });
  if (detached) process.stdout.write(style.dim('\nSolto; a fila continua. `mabel acompanhar` volta a acompanhar.\n'));
  return 0;
}

/** Pede ao `mabel rodar` do projeto (em segundo plano ou num terminal) que pare depois da etapa. */
export function stopCommand(args: string[]): number {
  const json = args.length === 1 && args[0] === '--json';
  if (args.length > 0 && !json) return fail('argumento_invalido', `Argumento inesperado: ${args.join(' ')}.`, stopUsage);
  const home = dataDir();
  const db = openDb(home);
  try {
    const project = resolveProject(db);
    const pid = lockHolder(home, project.id);
    // A trava também é usada pela remoção do projeto: só a fila iniciada recebe o pedido.
    if (pid === undefined || queueFinished(db, project.id)) {
      markQueueStopped(home, project.id);
      if (json) writeJson({ parada_pedida: false, pid: null });
      else process.stdout.write('A fila deste projeto não está rodando.\n');
      return 0;
    }
    markQueueStopped(home, project.id, pid);
    process.kill(pid, 'SIGUSR2');
    if (json) writeJson({ parada_pedida: true, pid });
    else process.stdout.write(`Pedido enviado (pid ${pid}): a fila para depois da etapa em andamento.\n`);
    return 0;
  } catch (error) {
    if (error instanceof ProjectError) return fail(error.code, error.message);
    throw error;
  } finally {
    db.close();
  }
}
