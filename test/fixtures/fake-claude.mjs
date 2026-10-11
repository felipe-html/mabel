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
// Cenário: FAKE_CLAUDE_SCENARIO aponta um JSON { "responses": [...] }; cada chamada consome
// a próxima resposta (o índice fica em <cenário>.state). Campos de uma resposta:
//   structured_output   objeto devolvido em result.structured_output
//   files               { "caminho": "conteúdo" | null } gravados (ou apagados) no cwd
//   is_error, subtype, result, errors   campos do result (padrão: sucesso)
//   exit                código de saída (padrão: 0)
//   hang                true: emite init e espera um SIGINT (sai com 130)
//   cost                total_cost_usd (padrão: 0.01)
//   rate_limit          { five_hour, seven_day, status } (utilização 0–1)
//   session_id          id da sessão nova (padrão: aleatório); com --resume, usa o retomado
//
// Em ambos: FAKE_CLAUDE_MARKER grava { pid, argv, cwd } da última chamada e FAKE_CLAUDE_LOG
// acrescenta uma linha JSON por chamada com { argv, cwd, session_id, response }.
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

function log(entry) {
  if (env.FAKE_CLAUDE_LOG) appendFileSync(env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
}

if (env.FAKE_CLAUDE_SCENARIO) {
  const scenario = JSON.parse(readFileSync(env.FAKE_CLAUDE_SCENARIO, 'utf8'));
  const statePath = `${env.FAKE_CLAUDE_SCENARIO}.state`;
  const index = existsSync(statePath) ? Number(readFileSync(statePath, 'utf8')) : 0;
  writeFileSync(statePath, String(index + 1));
  const response = scenario.responses[index];
  if (!response) {
    process.stderr.write(`cenário sem resposta para a chamada ${index + 1}\n`);
    process.exit(3);
  }

  const resumeAt = argv.indexOf('--resume');
  const sessionId = resumeAt >= 0 ? argv[resumeAt + 1] : (response.session_id ?? randomUUID());
  const modelAt = argv.indexOf('--model');
  const model = modelAt >= 0 ? argv[modelAt + 1] : 'claude-default';
  log({ argv, cwd: process.cwd(), session_id: sessionId, response: index });
  writeTranscript(sessionId);

  const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model, cwd: process.cwd(), claude_code_version: 'fake' });
  if (response.hang) {
    waitForSigint();
  } else {
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
  }
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
