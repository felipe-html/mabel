import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ask, confirm, interactive } from './ask.ts';
import { type ItemFields, appendBlocks, parseBacklog, renderItemBlock } from './backlog.ts';
import { type CatalogEntry, chooseReferences, referenceCatalog } from './capture.ts';
import { dataDir, openDb } from './db.ts';
import { backlogPath, getItem, listItems, nextNumber, syncBacklog } from './items.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';
import { ProjectError, resolveProject } from './project.ts';
import { referenceProblem } from './references.ts';
import { refineCommand } from './refine.ts';
import { style } from './style.ts';

export const addUsage =
  'mabel add "<título>" [--intencao <texto>] [--criterio <texto>]... [--fora-do-escopo <texto>]... [--referencia <entrada>]... [--depende <n>]... [--restricoes <texto>]';

export const addOptions = {
  intencao: { type: 'string', value: '<texto>', description: 'O que você quer e por quê; sem ela, no terminal, o Mabel pergunta campo a campo' },
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

/** Lê uma lista no terminal, uma entrada por linha, até uma linha vazia. */
async function askList(label: string): Promise<string[]> {
  process.stdout.write(style.dim(`${label}, um por linha (linha vazia encerra):\n`));
  const entries: string[] = [];
  for (;;) {
    const entry = await ask('  - ');
    if (!entry) return entries;
    entries.push(entry);
  }
}

/** Perguntas em sequência no TTY: título, intenção, critérios, fora do escopo, referências, dependências e restrições. */
async function askFields(partial: Partial<ItemFields>, catalog: CatalogEntry[]): Promise<ItemFields | string> {
  const title = partial.title ?? (await ask('Título: '));
  if (!title) return 'O título é obrigatório.';
  const intent = partial.intent ?? (await ask('Intenção (o que você quer e por quê): '));
  if (!intent) return 'A intenção é obrigatória.';
  let criteria = partial.criteria ?? [];
  if (criteria.length === 0) criteria = await askList('Critérios de aceite');
  let outOfScope = partial.outOfScope ?? [];
  if (outOfScope.length === 0) outOfScope = await askList('Fora do escopo (o que o item não faz)');
  let references = partial.references ?? [];
  if (references.length === 0 && catalog.length > 0) {
    process.stdout.write(style.dim('Referências (telas, operações de API e arquivos já capturados):\n'));
    references = (await chooseReferences(catalog, references)) ?? [];
  }
  let dependsOn = partial.dependsOn ?? [];
  if (dependsOn.length === 0) {
    const answer = parseNumbers([await ask('Depende de (ex.: 2, 3; enter para nenhum): ')]);
    if (typeof answer === 'string') return answer;
    dependsOn = answer;
  }
  const restrictions = partial.restrictions ?? ((await ask('Restrições (enter para nenhuma): ')) || null);
  return { title, intent, criteria, dependsOn, restrictions, outOfScope, decisions: [], criticalConcepts: [], references };
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
      fields = await askFields(partial, referenceCatalog(project.root, listItems(db, project.id)));
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
  if (!(await confirm('Refinar o item agora com um agente?', false))) return 0;
  return refineCommand([String(number)]);
}
