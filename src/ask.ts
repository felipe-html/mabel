/**
 * Sem perguntas mesmo no terminal: o botão de um formulário roda o comando como a linha de
 * shell rodaria fora do TTY (`src/forms.ts`).
 */
export const headless = { on: false };

export const interactive = (): boolean => !headless.on && Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Ctrl+C durante uma pergunta. */
export class Interrupted extends Error {
  constructor() {
    super('interrompido');
  }
}
