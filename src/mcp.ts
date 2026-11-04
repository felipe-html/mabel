import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { VerifyCommand } from './project.ts';
import { singleTestCommand } from './proof.ts';
import { proofTestCommand } from './stacks.ts';

/**
 * Servidor MCP do Mabel (`docs/specs/ferramentas.md`): ferramentas que o agente chama e que
 * rodam fora do sandbox do Claude Code, porque o processo do MCP não passa por ele. Hoje só
 * a `verificar`, na execução. JSON-RPC 2.0 por linha no stdio, escrito à mão.
 */

export const MABEL_MCP = 'mabel';
export const VERIFY_TOOL = 'verificar';
/** Chamadas de `verificar` por run (V8). */
export const MAX_VERIFY_CALLS = 8;
/** Tempo máximo de uma chamada de `verificar`, somados os comandos (V8). */
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
/** Linhas e caracteres do log devolvidos ao agente (V9). */
const TAIL_LINES = 200;
const TAIL_CHARS = 30_000;
const MAX_ARG_CHARS = 500;

/** Nome da ferramenta como o agente a vê (`mcp__mabel__verificar`). */
export function mcpToolName(tool: string): string {
  return `mcp__${MABEL_MCP}__${tool}`;
}

/** Configuração da run, gravada pelo Mabel em `<run>/ferramentas.json`; o agente não a escolhe. */
export interface ToolsConfig {
  /** Worktree do item: cwd dos comandos (V6). */
  worktree: string;
  verify: VerifyCommand[];
  testeUnico: string | null;
  /** Registro das chamadas (`verificar.jsonl`), importado como eventos no fim da run. */
  log: string;
  /** Diretório dos logs completos (`verificar-<n>.log`). */
  logDir: string;
  maxCalls: number;
  timeoutMs: number;
}

export interface VerifyArgs {
  arquivo?: unknown;
  nome?: unknown;
}

/** Comando a rodar, com o nome do `verify` ou `teste`. */
export interface PlannedCommand {
  name: string;
  command: string;
}

export const VERIFY_TOOL_SCHEMA = {
  name: VERIFY_TOOL,
  description: [
    'Roda a verificação do projeto fora do sandbox, no worktree do item, e devolve o código de saída e o fim do log.',
    'Sem argumentos: os comandos do `verify` do projeto, em ordem, parando no primeiro que falha.',
    'Com `arquivo` e `nome`: só esse teste, pelo comando de teste único do projeto.',
    `Use quando o sandbox impedir os testes (Docker, rede, portas). Limite de ${MAX_VERIFY_CALLS} chamadas por tentativa e ${VERIFY_TIMEOUT_MS / 60000} minutos por chamada.`,
    'Não substitui a verificação do Mabel depois da execução.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      arquivo: { type: 'string', description: 'Caminho do arquivo de teste, relativo ao worktree.' },
      nome: { type: 'string', description: 'Nome do teste, como declarado no arquivo.' },
    },
    additionalProperties: false,
  },
};

function badText(field: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return `\`${field}\` precisa ser um texto não vazio`;
  if (value.length > MAX_ARG_CHARS) return `\`${field}\` com mais de ${MAX_ARG_CHARS} caracteres`;
  if (/[\n\r\0]/.test(value)) return `\`${field}\` com quebra de linha ou NUL`;
  if (value.startsWith('-')) return `\`${field}\` não pode começar com "-" (seria lido como opção)`;
  return undefined;
}

/**
 * Argumentos do teste único (V5): `arquivo` relativo, dentro do worktree e existente;
 * nenhum valor começando com `-`, com quebra de linha ou longo demais. Devolve a recusa.
 */
export function validateTestArgs(worktree: string, args: { arquivo: unknown; nome: unknown }): string | undefined {
  const problem = badText('arquivo', args.arquivo) ?? badText('nome', args.nome);
  if (problem) return problem;
  const file = args.arquivo as string;
  if (isAbsolute(file)) return '`arquivo` precisa ser relativo ao worktree';
  if (file.split(/[\\/]/).includes('..')) return '`arquivo` não pode conter ".."';
  const full = resolve(worktree, file);
  if (!existsSync(full) || !statSync(full).isFile()) return `\`${file}\` não existe no worktree`;
  // Link simbólico para fora do worktree também é recusado.
  const real = relative(realpathSync(worktree), realpathSync(full));
  if (real.startsWith(`..${sep}`) || real === '..' || isAbsolute(real)) return `\`${file}\` aponta para fora do worktree`;
  return undefined;
}

/** Comandos de uma chamada (V4), ou a recusa. Nenhum campo além de `arquivo` e `nome`. */
export function plannedCommands(config: Pick<ToolsConfig, 'worktree' | 'verify' | 'testeUnico'>, args: VerifyArgs): PlannedCommand[] | { error: string } {
  const extra = Object.keys(args ?? {}).filter((key) => key !== 'arquivo' && key !== 'nome');
  if (extra.length > 0) return { error: `argumento desconhecido: ${extra.join(', ')}` };
  const hasFile = args?.arquivo !== undefined;
  const hasName = args?.nome !== undefined;
  if (!hasFile && !hasName) {
    if (config.verify.length === 0) return { error: 'o projeto não tem comando de verificação (`verify`)' };
    return config.verify.map((command) => ({ name: command.name, command: command.command }));
  }
  if (hasFile !== hasName) return { error: 'informe `arquivo` e `nome` juntos, ou nenhum dos dois' };
  const template = proofTestCommand(config.testeUnico, config.worktree);
  if (!template) return { error: 'o projeto não tem comando de teste único (`testeUnico`); chame `verificar` sem argumentos' };
  const problem = validateTestArgs(config.worktree, { arquivo: args.arquivo, nome: args.nome });
  if (problem) return { error: problem };
  return [{ name: 'teste', command: singleTestCommand(template, { arquivo: args.arquivo as string, nome: args.nome as string }) }];
}

interface CommandResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/** Roda o comando no worktree, stdout e stderr juntos; o prazo encerra o grupo de processos. */
export function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  // Sem NODE_TEST_CONTEXT, como o `shell` da verificação do Mabel.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const started = Date.now();
  return new Promise((done) => {
    const child = spawn('sh', ['-c', `${command} 2>&1`], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), 'SIGKILL');
      } catch {}
    }, timeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      done({ code, output: Buffer.concat(chunks).toString('utf8'), timedOut, durationMs: Date.now() - started });
    };
    child.on('error', (error) => {
      chunks.push(Buffer.from(String(error.message)));
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function tail(text: string): string {
  const lines = text.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
  return lines.length > TAIL_CHARS ? `…${lines.slice(-TAIL_CHARS)}` : lines;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

export interface ToolResult {
  isError: boolean;
  text: string;
}

/** Estado das chamadas de uma run: quantas rodaram e o registro (G1). */
export class VerifyTool {
  calls = 0;
  private config: ToolsConfig;

  constructor(config: ToolsConfig) {
    this.config = config;
  }

  private record(entry: object): void {
    appendFileSync(this.config.log, `${JSON.stringify({ em: new Date().toISOString(), ...entry })}\n`);
  }

  /** Recusa registrada; se nem o registro grava, a resposta diz isso. */
  private refuse(reason: string, args: VerifyArgs): ToolResult {
    try {
      this.record({ recusa: reason, argumentos: args });
    } catch {}
    return { isError: true, text: `verificar recusado: ${reason}` };
  }

  async call(args: VerifyArgs): Promise<ToolResult> {
    const planned = plannedCommands(this.config, args ?? {});
    if (!Array.isArray(planned)) return this.refuse(planned.error, args);
    if (this.calls >= this.config.maxCalls) {
      return this.refuse(`limite de ${this.config.maxCalls} verificações nesta tentativa; termine e deixe a verificação do Mabel conferir`, args);
    }
    const seq = this.calls + 1;
    try {
      // Sem registro, não roda (G1).
      this.record({ seq, inicio: true, argumentos: args, comandos: planned.map((p) => p.command) });
    } catch (error) {
      return { isError: true, text: `verificar recusado: o Mabel não conseguiu gravar o registro da chamada (${(error as Error).message})` };
    }
    this.calls = seq;
    const deadline = Date.now() + this.config.timeoutMs;
    const parts: string[] = [];
    for (const [index, step] of planned.entries()) {
      const remaining = deadline - Date.now();
      const result = remaining > 0 ? await runCommand(step.command, this.config.worktree, remaining) : { code: null, output: '', timedOut: true, durationMs: 0 };
      const logPath = join(this.config.logDir, `verificar-${seq}-${index + 1}.log`);
      let logError: string | undefined;
      try {
        writeFileSync(logPath, result.output);
      } catch (error) {
        logError = (error as Error).message;
      }
      try {
        this.record({ seq, comando: step.command, codigo: result.code, duracaoMs: result.durationMs, tempoEsgotado: result.timedOut, log: logError ? null : logPath });
      } catch {}
      const status = result.timedOut
        ? `passou do tempo máximo de ${this.config.timeoutMs / 60000} minutos e foi encerrado`
        : `saiu com ${result.code ?? 'erro'}`;
      parts.push(`\`${step.command}\` (${step.name}) ${status} em ${seconds(result.durationMs)}.`);
      if (result.output.trim()) parts.push(`Últimas linhas do log:\n${tail(result.output)}`);
      if (result.timedOut || result.code !== 0) break;
    }
    parts.push(`Chamada ${seq} de ${this.config.maxCalls} nesta tentativa. O resultado não conta como verificação do item: o Mabel verifica de novo depois da execução.`);
    return { isError: false, text: parts.join('\n\n') };
  }
}

// Protocolo --------------------------------------------------------------------------------

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: VerifyArgs };
}

/** Responde a uma mensagem JSON-RPC; `undefined` para notificações. */
export async function handleMessage(tool: VerifyTool, message: Message): Promise<object | undefined> {
  const { id, method } = message;
  if (id === undefined || id === null) return undefined;
  const reply = (result: object) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: MABEL_MCP, version: '1' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: [VERIFY_TOOL_SCHEMA] });
    case 'tools/call': {
      if (message.params?.name !== VERIFY_TOOL) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `ferramenta desconhecida: ${message.params?.name}` } };
      }
      const result = await tool.call(message.params.arguments ?? {});
      return reply({ content: [{ type: 'text', text: result.text }], isError: result.isError });
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `método não suportado: ${method}` } };
  }
}

/** Atende o stdio até o fim da entrada. Uma chamada por vez: a seguinte espera a anterior. */
export function serve(configPath: string): void {
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as ToolsConfig;
  const tool = new VerifyTool(config);
  const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let queue = Promise.resolve();
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let message: Message;
    try {
      message = JSON.parse(line) as Message;
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
      return;
    }
    const answer = async () => {
      const response = await handleMessage(tool, message);
      if (response) send(response);
    };
    // Só as chamadas de ferramenta esperam a anterior; `ping` e o resto respondem na hora.
    if (message.method === 'tools/call') queue = queue.then(answer);
    else void answer();
  });
}

export const MCP_SERVER = fileURLToPath(import.meta.url);

if (process.argv[1] && resolve(process.argv[1]) === MCP_SERVER) {
  const configPath = process.argv[2];
  if (!configPath) {
    process.stderr.write('uso: mcp.ts <ferramentas.json>\n');
    process.exit(2);
  }
  serve(configPath);
}
