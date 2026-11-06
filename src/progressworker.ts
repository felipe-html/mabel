import { writeSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { type TickerMessage, stepLine } from './progress.ts';
import { screenStyle } from './style.ts';

// Cronômetro da etapa em andamento (`progressView`, no TTY). Roda fora da thread principal,
// que fica presa no `spawnSync` das etapas longas, e escreve direto no descritor da saída.

const fd = (workerData as { fd: number }).fd;
const TICK_MS = 100;
let timer: NodeJS.Timeout | undefined;
let frame = 0;

function write(text: string): void {
  try {
    writeSync(fd, text);
  } catch {
    // Saída cheia ou fechada: o quadro seguinte tenta de novo.
  }
}

function stop(): void {
  clearInterval(timer);
  timer = undefined;
}

parentPort?.on('message', (message: TickerMessage) => {
  if (message.kind === 'start') {
    stop();
    const style = screenStyle(message.color);
    const draw = () => write(`\r${stepLine('running', message.label, Date.now() - message.at, style, message.width, frame++)}\x1b[K`);
    draw();
    timer = setInterval(draw, TICK_MS);
    return;
  }
  stop();
  if (message.line !== undefined) write(`\r${message.line}\x1b[K\n`);
  if (message.kind === 'close') parentPort?.close();
});
