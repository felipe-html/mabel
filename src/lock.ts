import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive } from './db.ts';

export class LockError extends Error {}

export function lockPath(home: string, projectId: string): string {
  return join(home, 'locks', `${projectId}.lock`);
}

/**
 * Trava de um `mabel run` por projeto: arquivo com o pid. Lock de processo morto é
 * descartado. Devolve a função que libera a trava.
 */
export function acquireLock(home: string, projectId: string): () => void {
  const path = lockPath(home, projectId);
  mkdirSync(join(home, 'locks'), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: 'wx' });
      return () => {
        try {
          if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path);
        } catch {
          // Já removida.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
        throw new LockError(`Já há um \`mabel run\` neste projeto (pid ${pid}). Espere terminar ou interrompa-o.`);
      }
      rmSync(path, { force: true });
    }
  }
  throw new LockError(`Não foi possível obter a trava ${path}.`);
}
