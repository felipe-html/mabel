import { parseArgs } from 'node:util';
import { dataDir, openDb } from './db.ts';
import { listItems } from './items.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';
import { ProjectError, resolveProject } from './project.ts';
import { SLUG, getSpecRecord, listSpecFiles, readSpec, setSpecStatus, specPath, validateSpec } from './specs.ts';

// `mabel especificar` (S.3: lista e aceite de spec escrita à mão; o motor entra no S.4).

export const specifyUsage = 'mabel especificar [<slug>] [--aceitar]';

export const specifyOptions = {
  aceitar: { type: 'boolean', description: 'Aceita a spec como está no arquivo, se ela passar na validação' },
} satisfies OptionSpecs;

export const specifyArgs: ArgSpec[] = [
  { name: '<slug>', description: 'Nome da spec em .mabel/specs/<slug>.md; sem ele, a lista das specs', values: 'spec' },
];

export function specifyCommand(args: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args, options: specifyOptions, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${specifyUsage}\n`);
    return 1;
  }
  const [slug] = parsed.positionals;
  const db = openDb(dataDir());
  try {
    const project = resolveProject(db);
    if (!slug) {
      const slugs = listSpecFiles(project.root);
      if (slugs.length === 0) {
        process.stdout.write('Nenhuma spec em .mabel/specs/. Escreva uma (pode ser só a história) e rode mabel especificar <slug>.\n');
        return 0;
      }
      const items = listItems(db, project.id);
      for (const name of slugs) {
        const status = getSpecRecord(db, project.id, name)?.status ?? 'rascunho';
        const found = readSpec(project.root, name);
        const errors = found ? validateSpec(found) : ['arquivo não encontrado'];
        const tasks = items.filter((item) => item.spec === name && item.status !== 'cancelled');
        const done = tasks.filter((item) => item.status === 'awaiting_merge' || item.status === 'done').length;
        process.stdout.write(`${name} · ${status} · ${tasks.length > 0 ? `${done}/${tasks.length} tarefas` : 'sem tarefas'}${errors.length > 0 ? ' · inválida' : ''}\n`);
      }
      return 0;
    }
    if (!SLUG.test(slug)) {
      process.stderr.write(`"${slug}" não é um nome de spec: use letras minúsculas, dígitos e -.\n`);
      return 1;
    }
    const spec = readSpec(project.root, slug);
    if (!spec) {
      process.stderr.write(`${specPath(project.root, slug)} não existe.\n`);
      return 1;
    }
    const errors = validateSpec(spec);
    const status = getSpecRecord(db, project.id, slug)?.status ?? 'rascunho';
    if (!parsed.values.aceitar) {
      process.stdout.write(`${slug} · ${status}\n${errors.length > 0 ? `Falta para ser válida:\n${errors.map((e) => `- ${e}`).join('\n')}\n` : 'Válida.\n'}`);
      return 0;
    }
    if (errors.length > 0) {
      process.stderr.write(`A spec ${slug} não passa na validação:\n${errors.map((e) => `- ${e}`).join('\n')}\n`);
      return 1;
    }
    if (status === 'entregue') {
      process.stdout.write(`A spec ${slug} já foi entregue.\n`);
      return 0;
    }
    setSpecStatus(db, project.id, slug, 'aceita');
    process.stdout.write(`Spec ${slug} aceita. As tarefas com "Spec: ${slug}" podem ir a ready no próximo mabel run.\n`);
    return 0;
  } catch (error) {
    if (error instanceof ProjectError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}
