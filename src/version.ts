import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pastas do Mabel lidas em tempo de execução: o código, os prompts e o hook de escopo. */
const CODE_DIRS = ['src', 'prompts', 'hooks'];

/** Modificação mais recente entre os arquivos das pastas do Mabel em `root`. */
function newestChange(root: string): number {
  let newest = 0;
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Pasta ausente: nada a comparar.
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) newest = Math.max(newest, statSync(path).mtimeMs);
    }
  };
  for (const dir of CODE_DIRS) visit(join(root, dir));
  return newest;
}

/**
 * O Node carrega o código uma vez, mas os prompts são relidos a cada run: um processo aberto
 * antes de atualizar o Mabel mistura código antigo com prompts novos. Devolve a verificação
 * de que algo mudou desde a criação.
 */
export function codeWatcher(root: string): () => boolean {
  const start = newestChange(root);
  return () => newestChange(root) > start;
}

/** Vigia do próprio Mabel, criado quando o processo carrega este módulo. */
export const mabelCodeChanged = codeWatcher(fileURLToPath(new URL('..', import.meta.url)));
