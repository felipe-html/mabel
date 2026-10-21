import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ask, confirm, interactive } from './ask.ts';
import { type ItemFields, appendBlocks, parseBacklog, renderItemBlock } from './backlog.ts';
import { dataDir, openDb } from './db.ts';
import { backlogPath, getItem, nextNumber, syncBacklog } from './items.ts';
import { ProjectError, resolveProject } from './project.ts';
import { refineCommand } from './refine.ts';
import { style } from './style.ts';

export const addUsage =
  'mabel add "<título>" [--intencao <texto>] [--criterio <texto>]... [--fora-do-escopo <texto>]... [--depende <n>]... [--restricoes <texto>]';

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
      options: {
        intencao: { type: 'string' },
        criterio: { type: 'string', multiple: true },
        'fora-do-escopo': { type: 'string', multiple: true },
        depende: { type: 'string', multiple: true },
        restricoes: { type: 'string' },
      },
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

/** Perguntas em sequência no TTY: título, intenção, critérios, fora do escopo, dependências e restrições. */
async function askFields(partial: Partial<ItemFields>): Promise<ItemFields | string> {
  const title = partial.title ?? (await ask('Título: '));
  if (!title) return 'O título é obrigatório.';
  const intent = partial.intent ?? (await ask('Intenção (o que você quer e por quê): '));
  if (!intent) return 'A intenção é obrigatória.';
  let criteria = partial.criteria ?? [];
  if (criteria.length === 0) criteria = await askList('Critérios de aceite');
  let outOfScope = partial.outOfScope ?? [];
  if (outOfScope.length === 0) outOfScope = await askList('Fora do escopo (o que o item não faz)');
  let dependsOn = partial.dependsOn ?? [];
  if (dependsOn.length === 0) {
    const answer = parseNumbers([await ask('Depende de (ex.: 2, 3; enter para nenhum): ')]);
    if (typeof answer === 'string') return answer;
    dependsOn = answer;
  }
  const restrictions = partial.restrictions ?? ((await ask('Restrições (enter para nenhuma): ')) || null);
  return { title, intent, criteria, dependsOn, restrictions, outOfScope, decisions: [], criticalConcepts: [] };
}

export async function add(args: string[]): Promise<number> {
  const partial = parseAddArgs(args);
  if (typeof partial === 'string') {
    process.stderr.write(`${partial}\nUso: ${addUsage}\n`);
    return 1;
  }

  let fields: ItemFields | string;
  if (interactive() && !partial.intent) {
    fields = await askFields(partial);
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
    };
  }
  if (typeof fields === 'string') {
    process.stderr.write(`${fields}\nUso: ${addUsage}\n`);
    return 1;
  }

  const db = openDb(dataDir());
  let number: number;
  try {
    const project = resolveProject(db);
    // Sincroniza antes para que ids pendentes no arquivo não colidam com o novo.
    const before = syncBacklog(db, project);
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
