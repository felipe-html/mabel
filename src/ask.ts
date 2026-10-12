import { createInterface } from 'node:readline/promises';

export const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Ctrl+C durante uma pergunta. */
export class Interrupted extends Error {
  constructor() {
    super('interrompido');
  }
}

/** Lê uma linha do terminal. Devolve o texto sem espaços nas pontas; ctrl+c lança `Interrupted`. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  rl.on('SIGINT', () => abort.abort());
  try {
    return (await rl.question(question, { signal: abort.signal })).trim();
  } catch (error) {
    if (abort.signal.aborted) {
      throw new Interrupted();
    }
    throw error;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await ask(`${question} ${defaultYes ? '[S/n]' : '[s/N]'} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('s') || answer.startsWith('y');
}
