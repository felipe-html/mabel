export const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Ctrl+C durante uma pergunta. */
export class Interrupted extends Error {
  constructor() {
    super('interrompido');
  }
}
