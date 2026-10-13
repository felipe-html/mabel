/**
 * Interpretação das linhas do `claude -p --output-format stream-json --verbose`.
 * O formato não é uma API documentada: campos ausentes e tipos novos nunca são erro.
 */

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  isError: boolean;
}

export interface RateLimitReading {
  window: string;
  utilization: number;
  resetsAt: Date;
}

export interface ResultTotals {
  subtype?: string;
  isError: boolean;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  text?: string;
  /** Objeto validado pelo `--json-schema`, de `result.structured_output`. */
  structuredOutput?: unknown;
  /** Mensagens de erro do `result` (por exemplo, limite de uso). */
  errors?: string[];
  /** Ações negadas na run (`result.permission_denials`): hook, permissões ou `--restricted`. */
  denials?: number;
}

export type StreamEvent =
  | { kind: 'init'; sessionId?: string; model?: string; claudeVersion?: string; raw: Record<string, unknown> }
  | { kind: 'tool_uses'; calls: ToolUse[] }
  | { kind: 'tool_results'; results: ToolResult[] }
  | { kind: 'rate_limits'; status?: string; readings: RateLimitReading[] }
  | { kind: 'result'; totals: ResultTotals }
  | { kind: 'other' };

export interface ParsedLine {
  /** `invalid` quando a linha não é um objeto JSON. */
  type: string;
  subtype: string | null;
  event: StreamEvent;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function contentOf(message: unknown): Json[] {
  const content = isObject(message) ? message.content : undefined;
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function interpret(type: string, subtype: string | null, obj: Json): StreamEvent {
  if (type === 'system' && subtype === 'init') {
    return {
      kind: 'init',
      sessionId: str(obj.session_id),
      model: str(obj.model),
      claudeVersion: str(obj.claude_code_version),
      raw: obj,
    };
  }
  if (type === 'assistant') {
    const calls = contentOf(obj.message)
      .filter((item) => item.type === 'tool_use' && str(item.id) && str(item.name))
      .map((item) => ({ id: item.id as string, name: item.name as string, input: item.input ?? {} }));
    return calls.length > 0 ? { kind: 'tool_uses', calls } : { kind: 'other' };
  }
  if (type === 'user') {
    const results = contentOf(obj.message)
      .filter((item) => item.type === 'tool_result' && str(item.tool_use_id))
      .map((item) => ({ id: item.tool_use_id as string, isError: item.is_error === true }));
    return results.length > 0 ? { kind: 'tool_results', results } : { kind: 'other' };
  }
  if (type === 'rate_limit_event') {
    const info = isObject(obj.rate_limit_info) ? obj.rate_limit_info : {};
    const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
    const readings: RateLimitReading[] = [];
    for (const [window, value] of Object.entries(windows)) {
      if (!isObject(value)) continue;
      const utilization = num(value.utilization);
      const resetsAt = num(value.resetsAt);
      if (utilization === undefined || resetsAt === undefined) continue;
      readings.push({ window, utilization, resetsAt: new Date(resetsAt * 1000) });
    }
    return { kind: 'rate_limits', status: str(info.status), readings };
  }
  if (type === 'result') {
    const usage = isObject(obj.usage) ? obj.usage : {};
    return {
      kind: 'result',
      totals: {
        subtype: subtype ?? undefined,
        isError: obj.is_error === true,
        numTurns: num(obj.num_turns),
        durationMs: num(obj.duration_ms),
        costUsd: num(obj.total_cost_usd),
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheReadTokens: num(usage.cache_read_input_tokens),
        cacheCreationTokens: num(usage.cache_creation_input_tokens),
        text: str(obj.result),
        structuredOutput: obj.structured_output ?? undefined,
        errors: Array.isArray(obj.errors) ? obj.errors.filter((e): e is string => typeof e === 'string') : undefined,
        denials: Array.isArray(obj.permission_denials) ? obj.permission_denials.length : undefined,
      },
    };
  }
  return { kind: 'other' };
}

export function parseLine(line: string): ParsedLine {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { type: 'invalid', subtype: null, event: { kind: 'other' } };
  }
  if (!isObject(obj)) return { type: 'invalid', subtype: null, event: { kind: 'other' } };
  const type = str(obj.type) ?? 'unknown';
  const subtype = str(obj.subtype) ?? null;
  return { type, subtype, event: interpret(type, subtype, obj) };
}

/** Alvo principal de uma chamada de ferramenta, para exibição. */
export function toolTarget(input: unknown): string {
  if (!isObject(input)) return '';
  for (const key of ['file_path', 'command', 'pattern', 'url']) {
    const value = str(input[key]);
    if (value) return value;
  }
  return '';
}
