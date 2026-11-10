import { Worker } from 'node:worker_threads';
import { type ScreenStyle, fit } from './screens.ts';
import { color, style } from './style.ts';

// Acompanhamento de um comando longo em etapas (o `entregar`): quem executa avisa o começo e
// o fim de cada etapa por `onStep`, sem saber de terminal; o desenho fica no comando.

export type StepEvent = { kind: 'start'; label: string } | { kind: 'end'; label: string; ok: boolean; ms: number };

export type OnStep = (event: StepEvent) => void;

/**
 * Roda `fn` como uma etapa: avisa o começo e o fim, com a duração. A etapa falha quando `ok`
 * recusa o resultado ou `fn` lança (o erro segue). Sem `onStep`, só roda.
 */
export function timed<T>(onStep: OnStep | undefined, label: string, fn: () => T, ok: (result: T) => boolean = () => true): T {
  if (!onStep) return fn();
  onStep({ kind: 'start', label });
  const start = performance.now();
  let passed = false;
  try {
    const result = fn();
    passed = ok(result);
    return result;
  } finally {
    onStep({ kind: 'end', label, ok: passed, ms: Math.round(performance.now() - start) });
  }
}

/** `850 ms`, `12,4 s`, `2 min 05 s`, `1 h 03 min`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const tenths = Math.floor(ms / 100);
  if (tenths < 600) return `${Math.floor(tenths / 10)},${tenths % 10} s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export type StepState = 'running' | 'ok' | 'failed';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Linha da etapa: marca, nome (cortado para caber em `width`) e duração. */
export function stepLine(state: StepState, label: string, ms: number, style: ScreenStyle, width = 80, frame = 0): string {
  const mark =
    state === 'ok' ? style.green('✓') : state === 'failed' ? style.red('✗') : style.accent(SPINNER[frame % SPINNER.length] as string);
  const time = formatDuration(ms);
  const room = Math.max(8, width - 4 - 2 - time.length - 1);
  const name = fit(label, room);
  return `  ${mark} ${state === 'failed' ? style.red(name) : name}  ${style.dim(time)}`;
}

/** Linha do total, depois das etapas. */
export function totalLine(ms: number, style: ScreenStyle): string {
  return `  ${style.bold('Total')}  ${formatDuration(ms)}`;
}

export interface ProgressView {
  onStep: OnStep;
  /** Fecha o acompanhamento; com `total`, escreve a linha do total. Espera o desenho acabar. */
  finish: (total: boolean) => Promise<void>;
}

/** Mensagens da thread principal para o worker que desenha o cronômetro. */
export type TickerMessage =
  | { kind: 'start'; label: string; at: number; width: number; color: boolean }
  | { kind: 'line'; line: string }
  | { kind: 'close'; line?: string };

/**
 * Acompanhamento no terminal. No TTY, a etapa em andamento tem um cronômetro: quem o desenha
 * é um worker, que escreve direto no descritor da saída, porque as etapas longas (`npm ci`,
 * testes, build) rodam com `spawnSync` e prendem a thread principal. Fora do TTY, uma linha
 * por etapa concluída, sem códigos de cursor.
 */
export function progressView(stream: NodeJS.WriteStream = process.stdout): ProgressView {
  const started = Date.now();
  let steps = 0;
  if (!stream.isTTY) {
    return {
      onStep: (event) => {
        if (event.kind !== 'end') return;
        steps++;
        stream.write(`${stepLine(event.ok ? 'ok' : 'failed', event.label, event.ms, style, Infinity)}\n`);
      },
      finish: async (total) => {
        if (total && steps > 0) stream.write(`${totalLine(Date.now() - started, style)}\n`);
      },
    };
  }
  const worker = new Worker(new URL('./progressworker.ts', import.meta.url), { workerData: { fd: (stream as { fd?: number }).fd ?? 1 } });
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  const send = (message: TickerMessage) => worker.postMessage(message);
  return {
    onStep: (event) => {
      const width = stream.columns || 80;
      if (event.kind === 'start') return send({ kind: 'start', label: event.label, at: Date.now(), width, color });
      steps++;
      send({ kind: 'line', line: stepLine(event.ok ? 'ok' : 'failed', event.label, event.ms, style, width) });
    },
    finish: async (total) => {
      send({ kind: 'close', line: total && steps > 0 ? totalLine(Date.now() - started, style) : undefined });
      await exited;
    },
  };
}
