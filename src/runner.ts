import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { balanceChanged } from './balance.ts';
import { runDir } from './db.ts';
import { initViolation } from './hermetic.ts';
import { type ResultTotals, type ToolResult, type ToolUse, parseLine } from './stream.ts';

export type RunKind = 'exec' | 'probe' | 'stage';
export type RunStage = 'plan' | 'execute' | 'review';
export type RunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface RunRequest {
  kind: RunKind;
  prompt: string;
  /** Caminho absoluto onde o `claude` roda. */
  cwd: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  itemId?: string;
  stage?: RunStage;
  permissionMode?: string;
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  /** Esquema da saída estruturada; serializado em `--json-schema`. */
  jsonSchema?: object;
  resumeSessionId?: string;
  /**
   * Ferramentas disponíveis (`--tools`) nas runs herméticas (etapa e probe); vazio desliga
   * todas. O `init` precisa listar exatamente estas.
   */
  tools?: string[];
  /** Conteúdo do `settings.json` da run (`--settings`), gravado no diretório dela. */
  settings?: object;
  /** Etapa sem sandbox (`"sandbox": false` no config): fica registrado na run. */
  sandboxDisabled?: boolean;
}

/** Etapa e probe rodam isoladas da configuração pessoal (G8); o `exec` avulso, não. */
export function isHermetic(request: Pick<RunRequest, 'kind'>): boolean {
  return request.kind !== 'exec';
}

/** Notificações ao vivo, para quem exibe a run. Disparadas depois da gravação no banco. */
export interface RunObserver {
  onInit?: (info: { model?: string }) => void;
  onToolUse?: (call: ToolUse) => void;
  onToolResult?: (result: ToolResult) => void;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  exitCode: number | null;
  error: string | null;
  model: string | null;
  sessionId: string | null;
  /** Último `status` de `rate_limit_event` visto na run (`allowed` quando há saldo). */
  rateLimitStatus: string | null;
  totals: ResultTotals | null;
  /** Duração da run: a do `result` ou, sem ele, o tempo de relógio. */
  durationMs: number;
  transcriptPath: string | null;
}

export interface RunHandle {
  runId: string;
  /** Primeira chamada repassa `SIGINT` ao `claude`; as seguintes forçam `SIGKILL`. */
  interrupt: () => void;
  done: Promise<RunOutcome>;
}

export function claudeBin(): string {
  return process.env.MABEL_CLAUDE_BIN || 'claude';
}

export function claudeArgs(request: RunRequest, settingsPath?: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (isHermetic(request)) {
    args.push('--restricted', '--strict-mcp-config', '--disable-slash-commands');
    args.push('--tools', (request.tools ?? []).join(','));
    if (settingsPath) args.push('--settings', settingsPath);
  }
  if (request.model) args.push('--model', request.model);
  if (request.maxTurns !== undefined) args.push('--max-turns', String(request.maxTurns));
  if (request.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(request.maxBudgetUsd));
  if (request.permissionMode) args.push('--permission-mode', request.permissionMode);
  if (request.allowedTools?.length) args.push('--allowedTools', request.allowedTools.join(','));
  if (request.disallowedTools?.length) args.push('--disallowedTools', request.disallowedTools.join(','));
  if (request.appendSystemPrompt) args.push('--append-system-prompt', request.appendSystemPrompt);
  if (request.jsonSchema) args.push('--json-schema', JSON.stringify(request.jsonSchema));
  if (request.resumeSessionId) args.push('--resume', request.resumeSessionId);
  // `--` encerra as opções: o prompt nunca é lido como flag nem consumido por opção variádica.
  args.push('--', request.prompt);
  return args;
}

/** Procura o transcript em cada `<config>/projects/<slug>`, sem reconstruir o slug do cwd. */
export function findTranscript(sessionId: string): string | undefined {
  const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const projects = join(config, 'projects');
  let entries;
  try {
    entries = readdirSync(projects, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = lines.slice(-3).join(' · ');
  return summary.length > 500 ? `…${summary.slice(-499)}` : summary;
}

/**
 * Registra a run no banco e inicia o `claude`. Lança, sem iniciar o processo, se o registro
 * ou o diretório da run não puderem ser gravados (G1).
 */
export function startRun(
  db: DatabaseSync,
  home: string,
  request: RunRequest,
  observer: RunObserver = {},
): RunHandle {
  const runId = randomUUID();
  const startedAt = new Date();
  const now = () => new Date().toISOString();

  db.prepare(
    `INSERT INTO runs (id, kind, item_id, stage, prompt, cwd, model_requested, status, started_at, pid)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    runId,
    request.kind,
    request.itemId ?? null,
    request.stage ?? null,
    request.prompt,
    request.cwd,
    request.model ?? null,
    startedAt.toISOString(),
    process.pid,
  );

  const dir = runDir(home, runId);
  let streamFd: number;
  let stderrFd: number;
  let settingsPath: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    if (isHermetic(request)) {
      settingsPath = join(dir, 'settings.json');
      writeFileSync(settingsPath, `${JSON.stringify(request.settings ?? {}, null, 2)}\n`);
    }
    streamFd = openSync(join(dir, 'stream.jsonl'), 'a');
    stderrFd = openSync(join(dir, 'stderr.log'), 'a');
  } catch (error) {
    db.prepare("UPDATE runs SET status = 'failed', error = ?, ended_at = ? WHERE id = ?").run(
      `diretório da run não gravável: ${(error as Error).message}`,
      now(),
      runId,
    );
    throw error;
  }

  const insertEvent = db.prepare(
    'INSERT INTO events (run_id, seq, received_at, type, subtype, payload) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertToolCall = db.prepare(
    'INSERT OR IGNORE INTO tool_calls (run_id, tool_use_id, name, input, started_at) VALUES (?, ?, ?, ?, ?)',
  );
  const closeToolCall = db.prepare(
    'UPDATE tool_calls SET ended_at = ?, is_error = ? WHERE run_id = ? AND tool_use_id = ?',
  );
  const insertRateLimit = db.prepare(
    `INSERT INTO rate_limits (run_id, observed_at, window, utilization, resets_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let seq = 0;
  let model: string | null = null;
  let sessionId: string | null = null;
  let totals: ResultTotals | null = null;
  let rateLimitStatus: string | null = null;
  let interrupted = false;
  let auditError: Error | null = null;
  let hermeticError: string | null = null;
  let stderrTail = '';

  const recordEvent = (type: string, subtype: string | null, payload: string) => {
    insertEvent.run(runId, ++seq, now(), type, subtype, payload);
  };
  if (request.sandboxDisabled) {
    recordEvent('mabel', 'sandbox_disabled', JSON.stringify({ reason: '"sandbox": false no .mabel/config.json' }));
  }

  const handleLine = (line: string) => {
    const parsed = parseLine(line);
    recordEvent(parsed.type, parsed.subtype, line);
    const { event } = parsed;
    switch (event.kind) {
      case 'init':
        model = event.model ?? model;
        sessionId = event.sessionId ?? sessionId;
        db.prepare(
          `UPDATE runs SET session_id = coalesce(?, session_id), model = coalesce(?, model),
             claude_version = coalesce(?, claude_version) WHERE id = ?`,
        ).run(event.sessionId ?? null, event.model ?? null, event.claudeVersion ?? null, runId);
        if (isHermetic(request) && !hermeticError) {
          const violation = initViolation(event.raw, request.tools ?? []);
          if (violation) {
            // O `init` já está em `events`: a evidência fica gravada antes de encerrar.
            hermeticError = `contexto não hermético: ${violation}`;
            killed = true;
            child.kill('SIGTERM');
            break;
          }
        }
        observer.onInit?.({ model: event.model });
        break;
      case 'tool_uses':
        for (const call of event.calls) {
          insertToolCall.run(runId, call.id, call.name, JSON.stringify(call.input), now());
          observer.onToolUse?.(call);
        }
        break;
      case 'tool_results':
        for (const result of event.results) {
          closeToolCall.run(now(), result.isError ? 1 : 0, runId, result.id);
          observer.onToolResult?.(result);
        }
        break;
      case 'rate_limits':
        rateLimitStatus = event.status ?? rateLimitStatus;
        for (const reading of event.readings) {
          insertRateLimit.run(
            runId,
            now(),
            reading.window,
            reading.utilization,
            reading.resetsAt.toISOString(),
            event.status ?? null,
          );
        }
        if (event.readings.length > 0) balanceChanged();
        break;
      case 'result':
        totals = event.totals;
        db.prepare(
          `UPDATE runs SET num_turns = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?,
             cache_read_tokens = ?, cache_creation_tokens = ?, result_text = ?, duration_ms = ?,
             structured_output = ?
           WHERE id = ?`,
        ).run(
          totals.numTurns ?? null,
          totals.costUsd ?? null,
          totals.inputTokens ?? null,
          totals.outputTokens ?? null,
          totals.cacheReadTokens ?? null,
          totals.cacheCreationTokens ?? null,
          totals.text ?? null,
          totals.durationMs ?? null,
          totals.structuredOutput === undefined ? null : JSON.stringify(totals.structuredOutput),
          runId,
        );
        break;
    }
  };

  let child: ChildProcess;
  let killed = false;
  const interrupt = () => {
    if (killed) {
      child.kill('SIGKILL');
      return;
    }
    interrupted = true;
    killed = true;
    child.kill('SIGINT');
  };

  const done = new Promise<RunOutcome>((resolve) => {
    child = spawn(claudeBin(), claudeArgs(request, settingsPath), {
      cwd: request.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const decoder = new StringDecoder('utf8');
    let pending = '';
    const consume = (text: string) => {
      pending += text;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line.trim()) handleLine(line);
        newline = pending.indexOf('\n');
      }
    };
    const guard = (action: () => void) => {
      if (auditError) return;
      try {
        action();
      } catch (error) {
        // Sem registro não há run auditada: encerra o claude em vez de seguir às cegas.
        auditError = error as Error;
        killed = true;
        child.kill('SIGTERM');
      }
    };

    child.stdout?.on('data', (chunk: Buffer) =>
      guard(() => {
        writeSync(streamFd, chunk);
        consume(decoder.write(chunk));
      }),
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      writeSync(stderrFd, chunk);
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
    });

    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      guard(() => {
        consume(decoder.end());
        if (pending.trim()) handleLine(pending.replace(/\r$/, ''));
        pending = '';
      });
      closeSync(streamFd);
      closeSync(stderrFd);

      let transcriptPath: string | null = null;
      const source = sessionId ? findTranscript(sessionId) : undefined;
      let missingReason = sessionId ? 'não encontrado' : 'sem session_id';
      if (source) {
        try {
          transcriptPath = join(dir, 'transcript.jsonl');
          copyFileSync(source, transcriptPath);
        } catch (error) {
          transcriptPath = null;
          missingReason = `falha ao copiar: ${(error as Error).message}`;
        }
      }

      let status: RunStatus;
      let error: string | null = null;
      if (auditError) {
        status = 'failed';
        error = `falha ao gravar a auditoria: ${(auditError as Error).message}`;
      } else if (hermeticError) {
        status = 'failed';
        error = hermeticError;
      } else if (interrupted) {
        status = 'interrupted';
      } else if (spawnError) {
        status = 'failed';
        error = `não foi possível iniciar ${claudeBin()}: ${spawnError.message}`;
      } else if (exitCode === 0 && totals && !totals.isError) {
        status = 'succeeded';
      } else {
        status = 'failed';
        if (exitCode !== 0) {
          error =
            summarizeStderr(stderrTail) ||
            totals?.subtype ||
            (signal ? `claude encerrado por ${signal}` : `claude saiu com código ${exitCode}`);
        } else {
          error = totals ? (totals.subtype ?? 'result com is_error') : 'stream terminou sem evento result';
        }
      }

      const durationMs = totals?.durationMs ?? Date.now() - startedAt.getTime();
      try {
        if (!transcriptPath) {
          recordEvent('mabel', 'transcript_missing', JSON.stringify({ session_id: sessionId, reason: missingReason }));
        }
        db.prepare(
          `UPDATE runs SET status = ?, exit_code = ?, error = ?, ended_at = ?, duration_ms = ?,
             transcript_path = ? WHERE id = ?`,
        ).run(status, exitCode, error, now(), durationMs, transcriptPath, runId);
      } catch (dbError) {
        status = 'failed';
        error = `falha ao gravar a auditoria: ${(dbError as Error).message}`;
      }

      resolve({ runId, status, exitCode, error, model, sessionId, rateLimitStatus, totals, durationMs, transcriptPath });
    };

    child.on('error', (spawnError) => {
      // Sem pid o processo nem chegou a existir; outros erros esperam o 'close'.
      if (child.pid === undefined) finish(null, null, spawnError);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });

  return { runId, interrupt, done };
}

const USAGE_LIMIT_TEXT = /usage limit|rate limit|limit reached|limite de uso|out of (?:usage|credits)/i;

/**
 * A run parou por falta de saldo? Heurística: `rate_limit_event` com status fora da família
 * `allowed` (`allowed_warning` ainda é saldo), ou erro do `result` falando de limite de uso.
 * Ainda não confirmada com uma run real que esgote o saldo.
 */
export function isUsageLimit(outcome: RunOutcome): boolean {
  if (outcome.status !== 'failed') return false;
  if (outcome.rateLimitStatus && !outcome.rateLimitStatus.startsWith('allowed')) return true;
  const texts = [outcome.error, outcome.totals?.text, ...(outcome.totals?.errors ?? [])];
  return texts.some((text) => typeof text === 'string' && USAGE_LIMIT_TEXT.test(text));
}
