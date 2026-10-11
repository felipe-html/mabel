import { createInterface } from 'node:readline/promises';

export const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Lê uma linha do terminal. Devolve o texto sem espaços nas pontas. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = (await ask(`${question} ${defaultYes ? '[S/n]' : '[s/N]'} `)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('s') || answer.startsWith('y');
}
