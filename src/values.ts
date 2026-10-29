import { referenceCatalog, catalogHint } from './capture.ts';
import { CREDENTIALS } from './credentials.ts';
import { dataDir, openDb } from './db.ts';
import { truncate } from './format.ts';
import { listItems } from './items.ts';
import type { ValueOption, ValueSource } from './options.ts';
import { resolveProject } from './project.ts';
import { listProjects } from './projects.ts';
import { getSpecRecord, listSpecFiles } from './specs.ts';
import { STACKS } from './stacks.ts';

/**
 * Valores que uma fonte oferece agora, para o autocompletar do zsh e a lista do modo Mabel.
 * Falha (fora de projeto, banco ausente) vira lista vazia: sugerir é conveniência.
 * `arquivo` e `diretorio` ficam com o shell.
 */
export function valuesFor(source: ValueSource, cwd: string = process.cwd()): ValueOption[] {
  try {
    if (source === 'stack') return STACKS.map((stack) => ({ value: stack.id, description: stack.label }));
    if (source === 'credencial') return Object.keys(CREDENTIALS).map((name) => ({ value: name, description: `token ${CREDENTIALS[name]?.env}` }));
    if (source === 'arquivo' || source === 'diretorio') return [];
    const db = openDb(dataDir());
    try {
      if (source === 'projeto') {
        return listProjects(db).map((project) => ({ value: project.name, description: `${project.items} itens · ${project.root}` }));
      }
      const project = resolveProject(db, cwd);
      if (source === 'spec') {
        return listSpecFiles(project.root).map((slug) => ({ value: slug, description: getSpecRecord(db, project.id, slug)?.status ?? 'rascunho' }));
      }
      const items = listItems(db, project.id);
      if (source === 'item') {
        return items
          .filter((item) => item.status !== 'cancelled' && item.status !== 'done')
          .map((item) => ({ value: String(item.number), description: `${truncate(item.title, 50)} · ${item.status}` }));
      }
      return referenceCatalog(project.root, items).map((entry) => ({ value: entry.entry, description: catalogHint(entry) || entry.kind }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
