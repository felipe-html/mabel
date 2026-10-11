#!/usr/bin/env node
// `claude` falso para os testes: reproduz um stream-json no stdout e grava o transcript.
//
// FAKE_CLAUDE_FIXTURE     arquivo reproduzido no stdout (padrão: stream-read-file.jsonl)
// FAKE_CLAUDE_MARKER      arquivo onde grava { pid, argv, cwd } ao iniciar
// FAKE_CLAUDE_EXIT        código de saída (padrão: 0)
// FAKE_CLAUDE_STDERR      texto escrito no stderr
// FAKE_CLAUDE_HANG=1      depois de reproduzir o stream, espera um SIGINT (sai com 130)
// FAKE_CLAUDE_TRANSCRIPT=0  não grava o transcript
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const fixture = env.FAKE_CLAUDE_FIXTURE ?? new URL('./stream-read-file.jsonl', import.meta.url);
const stream = readFileSync(fixture, 'utf8');

if (env.FAKE_CLAUDE_MARKER) {
  writeFileSync(env.FAKE_CLAUDE_MARKER, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() }));
}

let sessionId;
for (const line of stream.split('\n')) {
  try {
    const event = JSON.parse(line);
    if (event.type === 'system' && event.subtype === 'init') sessionId = event.session_id;
  } catch {}
}
if (sessionId && env.CLAUDE_CONFIG_DIR && env.FAKE_CLAUDE_TRANSCRIPT !== '0') {
  const dir = join(env.CLAUDE_CONFIG_DIR, 'projects', '-fake-projeto');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), '{"type":"user","message":"transcript falso"}\n');
}

if (env.FAKE_CLAUDE_STDERR) process.stderr.write(env.FAKE_CLAUDE_STDERR);
process.stdout.write(stream, () => {
  if (env.FAKE_CLAUDE_HANG === '1') {
    process.on('SIGINT', () => process.exit(130));
    setInterval(() => {}, 1000);
    return;
  }
  process.exitCode = Number(env.FAKE_CLAUDE_EXIT ?? 0);
});
