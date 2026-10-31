import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Interrupted, interactive } from './ask.ts';
import { type ItemFields, appendBlocks, parseBacklog, renderItemBlock } from './backlog.ts';
import { type CatalogEntry, catalogHint, referenceCatalog } from './capture.ts';
import { dataDir, openDb } from './db.ts';
import { confirmAction, fillForm, itemOptions, terminalGuided } from './guided.ts';
import { type Item, backlogPath, getItem, listItems, nextNumber, syncBacklog } from './items.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';
import { ProjectError, resolveProject } from './project.ts';
import { referenceProblem } from './references.ts';
import { refineCommand } from './refine.ts';
import { type FormConfig, type FormField, type FormValues, shellLine } from './screens.ts';
import { style } from './style.ts';

export const addUsage =
  'mabel add "<título>" [--intencao <texto>] [--criterio <texto>]... [--fora-do-escopo <texto>]... [--referencia <entrada>]... [--depende <n>]... [--restricoes <texto>]';

export const addOptions = {
  intencao: { type: 'string', value: '<texto>', description: 'O que você quer e por quê; sem ela, no terminal, o Mabel abre o formulário' },
  criterio: { type: 'string', multiple: true, value: '<texto>', description: 'Critério de aceite' },
  'fora-do-escopo': { type: 'string', multiple: true, value: '<texto>', description: 'O que o item não faz' },
  referencia: {
    type: 'string',
    multiple: true,
    value: '<entrada>',
    values: 'referencia',
    description: 'Tela, operação de API ou arquivo de .mabel/referencias/ (veja `mabel referencia`)',
  },
  depende: { type: 'string', multiple: true, value: '<n>', values: 'item', description: 'Item que precisa ser entregue antes deste' },
  restricoes: { type: 'string', value: '<texto>', description: 'Limites de implementação (bibliotecas, arquivos, padrões)' },
} satisfies OptionSpecs;

export const addArgs: ArgSpec[] = [{ name: '"<título>"', description: 'Título do item' }];

function parseNumbers(values: string[]): number[] | string {
  const numbers: number[] = [];
  for (const value of values.flatMap((part) => part.split(','))) {
    const token = value.trim().replace(/^#/, '');
    if (!token) continue;
    if (!/^[1-9]\d*$/.test(token)) return `Dependência inválida: "${value.trim()}".`;
    numbers.push(Number(token));
  }
  return numbers;
}

/** Converte os argumentos em campos do item; `string` é mensagem de erro. */
export function parseAddArgs(args: string[]): Partial<ItemFields> | string {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: addOptions,
    });
  } catch (error) {
    return (error as Error).message;
  }
  const { values, positionals } = parsed;
  const dependsOn = parseNumbers(values.depende ?? []);
  if (typeof dependsOn === 'string') return dependsOn;
  const list = (entries: string[] | undefined) => (entries ?? []).map((entry) => entry.trim()).filter(Boolean);
  const fields: Partial<ItemFields> = {
    dependsOn,
    criteria: list(values.criterio),
    outOfScope: list(values['fora-do-escopo']),
    references: list(values.referencia),
  };
  const title = positionals.join(' ').trim();
  if (title) fields.title = title;
  if (values.intencao?.trim()) fields.intent = values.intencao.trim();
  if (values.restricoes?.trim()) fields.restrictions = values.restricoes.trim();
  return fields;
}

const text = (values: FormValues, key: string) => (typeof values[key] === 'string' ? (values[key] as string).trim() : '');
const list = (values: FormValues, key: string) => (Array.isArray(values[key]) ? (values[key] as string[]) : []);

/** O comando de shell que faz o mesmo que o formulário. */
export function addShell(values: FormValues): string {
  const words = ['mabel', 'add', text(values, 'title') || '<título>'];
  if (text(values, 'intent')) words.push('--intencao', text(values, 'intent'));
  for (const entry of list(values, 'criteria')) words.push('--criterio', entry);
  for (const entry of list(values, 'outOfScope')) words.push('--fora-do-escopo', entry);
  for (const entry of list(values, 'references')) words.push('--referencia', entry);
  for (const entry of list(values, 'dependsOn')) words.push('--depende', entry);
  if (text(values, 'restrictions')) words.push('--restricoes', text(values, 'restrictions'));
  return shellLine(words);
}

/** Formulário "Adicionar um item", como no protótipo: um campo por opção do comando. */
export function addForm(catalog: CatalogEntry[], items: Item[]): FormConfig {
  const references: FormField[] =
    catalog.length > 0
      ? [
          {
            type: 'pick',
            key: 'references',
            label: 'Referências',
            multi: true,
            noun: ['referência', 'referências'],
            options: () => catalog.map((entry) => ({ value: entry.entry, label: entry.entry, hint: catalogHint(entry) })),
          },
        ]
      : [];
  const candidates = items.filter((item) => item.status !== 'cancelled' && item.status !== 'done');
  return {
    title: 'Adicionar um item',
    description: 'Cria um item no backlog do projeto.',
    command: 'add',
    fields: [
      { type: 'text', key: 'title', label: 'Título', required: true, placeholder: 'nome curto do item' },
      { type: 'text', key: 'intent', label: 'Intenção', required: true, placeholder: 'o que você quer e por quê' },
      { type: 'list', key: 'criteria', label: 'Critérios de aceite', noun: ['critério', 'critérios'] },
      { type: 'list', key: 'outOfScope', label: 'Fora do escopo', noun: ['limite', 'limites'] },
      ...references,
      { type: 'pick', key: 'dependsOn', label: 'Depende de', multi: true, noun: ['item', 'itens'], options: () => itemOptions(candidates) },
      { type: 'text', key: 'restrictions', label: 'Restrições', placeholder: 'bibliotecas, arquivos, padrões' },
    ],
    action: 'Adicionar ao backlog',
    shell: addShell,
  };
}

/** Campos do item a partir do formulário. */
export function fieldsFromForm(values: FormValues): ItemFields {
  return {
    title: text(values, 'title'),
    intent: text(values, 'intent'),
    criteria: list(values, 'criteria'),
    dependsOn: list(values, 'dependsOn').map(Number),
    restrictions: text(values, 'restrictions') || null,
    outOfScope: list(values, 'outOfScope'),
    decisions: [],
    criticalConcepts: [],
    references: list(values, 'references'),
  };
}

/** No TTY: o formulário, já preenchido com o que veio nos argumentos. `null` quando o usuário volta. */
async function askFields(partial: Partial<ItemFields>, catalog: CatalogEntry[], items: Item[]): Promise<ItemFields | null> {
  const values = await fillForm(addForm(catalog, items), {
    title: partial.title ?? '',
    criteria: partial.criteria ?? [],
    outOfScope: partial.outOfScope ?? [],
    references: partial.references ?? [],
    dependsOn: (partial.dependsOn ?? []).map(String),
    restrictions: partial.restrictions ?? '',
  });
  return values && fieldsFromForm(values);
}

export async function add(args: string[]): Promise<number> {
  const partial = parseAddArgs(args);
  if (typeof partial === 'string') {
    process.stderr.write(`${partial}\nUso: ${addUsage}\n`);
    return 1;
  }

  const db = openDb(dataDir());
  let number: number;
  try {
    const project = resolveProject(db);
    // Sincroniza antes para que ids pendentes no arquivo não colidam com o novo.
    const before = syncBacklog(db, project);

    let fields: ItemFields | string;
    if (interactive() && !partial.intent) {
      const items = listItems(db, project.id);
      let filled: ItemFields | null;
      try {
        filled = await askFields(partial, referenceCatalog(project.root, items), items);
      } catch (error) {
        if (error instanceof Interrupted) return 130;
        throw error;
      }
      if (!filled) {
        process.stdout.write('Nada foi adicionado.\n');
        return 0;
      }
      fields = filled;
    } else if (!partial.title || !partial.intent) {
      fields = `Informe o título e a intenção (--intencao).`;
    } else {
      fields = {
        title: partial.title,
        intent: partial.intent,
        criteria: partial.criteria ?? [],
        dependsOn: partial.dependsOn ?? [],
        restrictions: partial.restrictions ?? null,
        outOfScope: partial.outOfScope ?? [],
        decisions: [],
        criticalConcepts: [],
        references: partial.references ?? [],
      };
    }
    if (typeof fields === 'string') {
      process.stderr.write(`${fields}\nUso: ${addUsage}\n`);
      return 1;
    }

    const path = backlogPath(project);
    const text = readFileSync(path, 'utf8');
    const numbers = parseBacklog(text).flatMap((item) => (item.number === undefined ? [] : [item.number]));
    number = nextNumber(db, project.id, numbers);
    writeFileSync(path, appendBlocks(text, [renderItemBlock({ ...fields, number })]));
    const after = syncBacklog(db, project);

    const item = getItem(db, project.id, number);
    process.stdout.write(`Item #${number} adicionado: ${fields.title} · ${item?.status ?? '?'}\n`);
    for (const warning of [...before.warnings, ...after.warnings]) process.stdout.write(style.dim(`${warning}\n`));
    if (item?.status === 'blocked') process.stdout.write(`Bloqueado: ${item.statusReason}\n`);
    const problem = referenceProblem(project.root, fields.references ?? []);
    if (problem) process.stdout.write(`Fica no backlog até corrigir: ${problem}. Veja as referências com \`mabel referencia\`.\n`);
    if (!interactive()) return 0;
  } catch (error) {
    if (error instanceof ProjectError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
  // Só no terminal: o refinamento custa uma run e espera a sua revisão.
  if (!(await confirmAction(terminalGuided, 'Refinar o item agora com um agente', { back: 'Agora não' }))) return 0;
  return refineCommand([String(number)]);
}
