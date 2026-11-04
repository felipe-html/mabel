#!/usr/bin/env node
// `claude` falso para os testes. Dois modos:
//
// Fixture (padrão): reproduz um stream-json gravado no stdout e grava o transcript.
//   FAKE_CLAUDE_FIXTURE     arquivo reproduzido no stdout (padrão: stream-read-file.jsonl)
//   FAKE_CLAUDE_EXIT        código de saída (padrão: 0)
//   FAKE_CLAUDE_STDERR      texto escrito no stderr
//   FAKE_CLAUDE_HANG=1      depois de reproduzir o stream, espera um SIGINT (sai com 130)
//   FAKE_CLAUDE_TRANSCRIPT=0  não grava o transcript
//
// Cenário: FAKE_CLAUDE_SCENARIO aponta um JSON { "responses": [...] }; cada chamada de etapa
// (com --json-schema) consome a próxima resposta (o índice fica em <cenário>.state). Chamadas
// sem esquema (probe, exec) recebem uma resposta de sucesso padrão. Campos de uma resposta:
//   structured_output   objeto devolvido em result.structured_output
//   files               { "caminho": "conteúdo" | null } gravados (ou apagados) no cwd
//   is_error, subtype, result, errors   campos do result (padrão: sucesso)
//   exit                código de saída (padrão: 0)
//   hang                true: emite init e espera um SIGINT (sai com 130)
//   delay_ms            espera antes de responder (etapa demorada que termina sozinha)
//   wait_for            caminho: espera o arquivo existir antes de responder (etapa que o teste libera)
//   cost                total_cost_usd (padrão: 0.01)
//   rate_limit          { five_hour, seven_day, status } (utilização 0–1)
//   session_id          id da sessão nova (padrão: aleatório); com --resume, usa o retomado
//   init                campos que substituem os do evento init (ex.: { "skills": ["x"] })
//   mcp_calls           [{ tool, arguments }] chamadas às ferramentas do MCP (`--mcp-config`)
//                       antes do result; o servidor roda de verdade
//
// Com `--mcp-config`, o falso sobe cada servidor do arquivo, faz o `initialize` e o
// `tools/list`, e o init lista os servidores (`connected`) e as ferramentas `mcp__<s>__<t>`.
//
// O init do cenário imita o de uma run hermética: `tools` igual ao `--tools` pedido, sem MCP,
// skills nem comandos, com os plugins e agentes internos.
//
// Em ambos: FAKE_CLAUDE_MARKER grava { pid, argv, cwd } da última chamada e FAKE_CLAUDE_LOG
// acrescenta uma linha JSON por chamada com { argv, cwd, session_id, response }.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const env = process.env;
const argv = process.argv.slice(2);

if (env.FAKE_CLAUDE_MARKER) {
  writeFileSync(env.FAKE_CLAUDE_MARKER, JSON.stringify({ pid: process.pid, argv, cwd: process.cwd() }));
}

function writeTranscript(sessionId) {
  if (!sessionId || !env.CLAUDE_CONFIG_DIR || env.FAKE_CLAUDE_TRANSCRIPT === '0') return;
  const dir = join(env.CLAUDE_CONFIG_DIR, 'projects', '-fake-projeto');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user","message":"transcript falso"}\n');
}

function waitForSigint() {
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
}

/** Sobe os servidores do `--mcp-config` como o `claude` faz: stdio, JSON-RPC por linha. */
async function connectMcp(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const servers = [];
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    const child = spawn(server.command, server.args ?? [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...server.env } });
    const waiting = new Map();
    let buffer = '';
    let next = 0;
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    });
    const request = (method, params) =>
      new Promise((done) => {
        const id = ++next;
        waiting.set(id, done);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await request('tools/list', {});
    servers.push({ name, child, request, ok: Boolean(init.result), tools: (list.result?.tools ?? []).map((tool) => tool.name) });
  }
  return servers;
}

function log(entry) {
  if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
}

if (env.FAKE_CLAUDE_SCENARIO) {
  const scenario = JSON.parse(readFileSync(env.FAKE_CLAUDE_SCENARIO, 'utf8'));
  const statePath = `${env.FAKE_CLAUDE_SCENARIO}.state`;
  const stage = argv.includes('--json-schema');
  const index = !stage ? -1 : existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0;
  if (stage) writeFileSync(statePath, String(index + 1));
  const response = stage ? scenario.responses[index] : (scenario.probe ?? {});
  if (!response) {
    process.stderr.write(`cenário sem resposta para a chamada ${index + 1}\n`);
    process.exit(3);
  }

  const resumeAt = argv.indexOf('--resume');
  const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : (response.session_id ?? randomUUID());
  const modelAt = argv.indexOf('--model');
  const model = modelAt >= 0 ? argv[modelAt + 1] : 'claude-default';
  log({ argv, cwd: process.cwd(), session_id: sessionId, response: index, figmaToken: 'FIGMA_TOKEN' in env });
  writeTranscript(sessionId);

  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const toolsAt = argv.indexOf('--tools');
  const tools = toolsAt >= 0 ? argv[toolsAt + 1].split(',').filter(Boolean) : ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'WebFetch'];
  if (stage) tools.push('StructuredOutput');
  const mcpAt = argv.indexOf('--mcp-config');
  const mcp = mcpAt >= 0 ? await connectMcp(argv[mcpAt + 1]) : [];
  for (const server of mcp) tools.push(...server.tools.map((tool) => `mcp__${server.name}__${tool}`));
  emit({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    cwd: process.cwd(),
    claude_code_version: 'fake',
    tools,
    mcp_servers: mcp.map((server) => ({ name: server.name, status: server.ok ? 'connected' : 'failed' })),
    slash_commands: [],
    skills: [],
    plugins: [{ name: 'cc-plugin-telemetry', path: 'builtin', source: 'cc-plugin-telemetry@builtin' }],
    agents: ['Explore', 'general-purpose', 'Plan'],
    ...response.init,
  });
  const respond = async () => {
    for (const [n, call] of (response.mcp_calls ?? []).entries()) {
      const server = mcp.find((s) => s.tools.includes(call.tool));
      const id = `mcp-${index}-${n}`;
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__${server?.name}__${call.tool}`, input: call.arguments ?? {} }] } });
      const answer = server ? await server.request('tools/call', { name: call.tool, arguments: call.arguments ?? {} }) : { error: { message: 'sem servidor' } };
      const text = answer.result?.content?.map((c) => c.text).join('\n') ?? answer.error?.message;
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: Boolean(answer.result?.isError || answer.error) }] } });
    }
    for (const [path, content] of Object.entries(response.files ?? {})) {
      const target = join(process.cwd(), path);
      if (content === null) {
        rmSync(target, { force: true });
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      emit({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: `tu-${index}-${path}`, name: 'Write', input: { file_path: target } }] },
      });
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `tu-${index}-${path}` }] } });
    }
    const limits = response.rate_limit ?? {};
    const reset = Math.floor(Date.now() / 1000) + 3600;
    emit({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: limits.status ?? 'allowed',
        unifiedWindows: {
          five_hour: { utilization: limits.five_hour ?? 0.1, resetsAt: reset },
          seven_day: { utilization: limits.seven_day ?? 0.1, resetsAt: reset + 86400 },
        },
      },
    });
    emit({
      type: 'result',
      subtype: response.subtype ?? (response.is_error ? 'error_during_execution' : 'success'),
      is_error: response.is_error ?? false,
      num_turns: 1,
      duration_ms: 10,
      total_cost_usd: response.cost ?? 0.01,
      usage: { input_tokens: 10, output_tokens: 5 },
      result: response.result ?? (response.structured_output ? JSON.stringify(response.structured_output) : 'ok'),
      ...(response.structured_output ? { structured_output: response.structured_output } : {}),
      ...(response.errors ? { errors: response.errors } : {}),
    });
    process.exitCode = response.exit ?? 0;
    for (const server of mcp) server.child.stdin.end();
  };
  if (response.hang) waitForSigint();
  else if (response.wait_for) {
    const timer = setInterval(() => {
      if (!existsSync(response.wait_for)) return;
      clearInterval(timer);
      respond();
    }, 20);
  } else if (response.delay_ms) setTimeout(respond, response.delay_ms);
  else respond();
} else {
  const fixture = env.FAKE_CLAUDE_FIXTURE ?? new URL('./stream-read-file.jsonl', import.meta.url);
  const stream = readFileSync(fixture, 'utf8');

  let sessionId;
  for (const line of stream.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'system' && event.subtype === 'init') sessionId = event.session_id;
    } catch {}
  }
  log({ argv, cwd: process.cwd(), session_id: sessionId });
  writeTranscript(sessionId);

  if (env.FAKE_CLAUDE_STDERR) process.stderr.write(env.FAKE_CLAUDE_STDERR);
  process.stdout.write(stream, () => {
    if (env.FAKE_CLAUDE_HANG === '1') return waitForSigint();
    process.exitCode = Number(env.FAKE_CLAUDE_EXIT ?? 0);
  });
}
