import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { dataDir, openDb } from './db.ts';
import { type Item, isStarted, listItems, syncBacklog } from './items.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import {
  NAME,
  type OpenApi,
  asOpenApi,
  operationLabel,
  operations,
  parseReference,
  readSnapshot,
  referencesRoot,
  snapshotPath,
} from './references.ts';
import { style } from './style.ts';

/** `mabel referencia`: captura e lista as referências do projeto (`docs/specs/referencias.md`). */

export const referenceUsage = ['mabel referencia', 'mabel referencia api <nome> <url>'].join('\n       ');

export class CaptureError extends Error {}

const NOTES_MARK = '<!-- notas -->';

/** URL do JSON: a do swagger-ui do Quarkus vira a do `/q/openapi?format=json`; outra fica como está. */
export function openApiUrl(url: string): string {
  const parsed = new URL(url);
  if (/\/q\/swagger-ui\/?$/.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(/\/q\/swagger-ui\/?$/, '/q/openapi');
    parsed.search = '?format=json';
    parsed.hash = '';
  }
  return parsed.toString();
}

/** Notas do humano no `.md` da referência, abaixo da marca; mantidas na recaptura. */
function keptNotes(path: string): string {
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8');
  const index = text.indexOf(NOTES_MARK);
  return index < 0 ? '' : text.slice(index + NOTES_MARK.length).replace(/^\n+/, '');
}

function writeWithNotes(path: string, header: string[]): void {
  const notes = keptNotes(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${[...header, '', NOTES_MARK, ''].join('\n')}${notes}`);
}

/** Itens (não cancelados) que citam a referência dada, com a entrada usada. */
export function citingItems(items: Item[], matches: (entry: string) => boolean): { item: Item; entry: string }[] {
  return items.flatMap((item) =>
    item.status === 'cancelled' ? [] : item.references.filter(matches).map((entry) => ({ item, entry })),
  );
}

function citesApi(name: string) {
  return (entry: string) => {
    const ref = parseReference(entry);
    return !('error' in ref) && ref.kind === 'api' && ref.name === name;
  };
}

export interface ApiCapture {
  path: string;
  url: string;
  spec: OpenApi;
  added: string[];
  removed: string[];
  /** Entradas de itens não iniciados que apontam para uma operação que saiu. */
  broken: { item: Item; entry: string }[];
}

/** Baixa o OpenAPI, grava o snapshot e o `.md` e compara com o snapshot anterior. */
export async function captureApi(db: DatabaseSync, project: Project, name: string, url: string, now = new Date()): Promise<ApiCapture> {
  if (!NAME.test(name)) throw new CaptureError(`Nome "${name}" inválido: use letras minúsculas, dígitos e -.`);
  const source = openApiUrl(url);
  let response: Response;
  try {
    response = await fetch(source, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new CaptureError(`Não foi possível baixar ${source}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new CaptureError(`${source} respondeu ${response.status} ${response.statusText}.`);
  const body = await response.text();
  let spec: OpenApi | undefined;
  try {
    spec = asOpenApi(JSON.parse(body));
  } catch {
    spec = undefined;
  }
  if (!spec) {
    throw new CaptureError(
      `${source} não devolveu OpenAPI em JSON (com \`openapi\` e \`paths\`). Aponte para a versão JSON do documento (no Quarkus, /q/openapi?format=json).`,
    );
  }

  const previous = readSnapshot(project.root, name);
  const before = new Set(typeof previous === 'string' ? [] : operations(previous).map(operationLabel));
  const after = new Set(operations(spec).map(operationLabel));
  const added = typeof previous === 'string' ? [] : [...after].filter((label) => !before.has(label));
  const removed = [...before].filter((label) => !after.has(label));

  const path = snapshotPath(project.root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(spec, null, 2)}\n`);
  writeWithNotes(path.replace(/\.openapi\.json$/, '.md'), [
    `# API ${name}`,
    '',
    `- Origem: ${source}`,
    `- Capturado em: ${now.toISOString()}`,
    `- Título: ${spec.info?.title ?? '(sem título)'} · versão ${spec.info?.version ?? '?'}`,
    `- Operações: ${after.size}`,
  ]);

  const items = listItems(db, project.id).filter((item) => !isStarted(db, item.id));
  const broken = citingItems(items, citesApi(name)).filter(({ entry }) => {
    const ref = parseReference(entry);
    if ('error' in ref || ref.kind !== 'api') return false;
    return 'operationId' in ref
      ? !operations(spec).some((op) => op.operationId === ref.operationId)
      : !after.has(operationLabel(ref));
  });
  return { path, url: source, spec, added, removed, broken };
}

// Lista -------------------------------------------------------------------------------------

function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

export function renderReferences(db: DatabaseSync, project: Project): string[] {
  const root = referencesRoot(project.root);
  const items = listItems(db, project.id);
  const cited = (matches: (entry: string) => boolean) => {
    const numbers = [...new Set(citingItems(items, matches).map(({ item }) => `#${item.number}`))];
    return numbers.length > 0 ? ` · itens ${numbers.join(', ')}` : '';
  };
  const lines: string[] = [];

  const apis = listDir(join(root, 'api')).filter((file) => file.endsWith('.openapi.json'));
  lines.push(style.bold('APIs'));
  if (apis.length === 0) lines.push('  nenhuma');
  for (const file of apis) {
    const name = file.replace(/\.openapi\.json$/, '');
    const spec = readSnapshot(project.root, name);
    const detail = typeof spec === 'string' ? spec : `${operations(spec).length} operações`;
    lines.push(`  ${name} · ${detail}${cited(citesApi(name))}`);
  }

  const screens = listDir(join(root, 'telas'));
  lines.push('', style.bold('Telas'));
  if (screens.length === 0) lines.push('  nenhuma');
  for (const name of screens) {
    const files = listDir(join(root, 'telas', name));
    lines.push(
      `  ${name} · ${files.join(', ') || 'sem arquivos'}${cited((entry) => {
        const ref = parseReference(entry);
        return !('error' in ref) && ref.kind === 'tela' && ref.name === name;
      })}`,
    );
  }
  lines.push('', style.dim(`Em ${relative(project.root, root)}/; cite no item com "Referências:".`));
  return lines;
}

// Comando -----------------------------------------------------------------------------------

export async function referenceCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {} });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${referenceUsage}\n`);
    return 1;
  }
  const [kind, name, url, ...extra] = parsed.positionals;
  if (kind !== undefined && (kind !== 'api' || !name || !url || extra.length > 0)) {
    process.stderr.write(`Uso: ${referenceUsage}\n`);
    return 1;
  }

  const db = openDb(dataDir());
  try {
    const project = resolveProject(db);
    syncBacklog(db, project);
    if (kind === undefined) {
      process.stdout.write(`${renderReferences(db, project).join('\n')}\n`);
      return 0;
    }
    const capture = await captureApi(db, project, name as string, url as string);
    const out = [
      `Snapshot ${relative(project.root, capture.path)} gravado (${operations(capture.spec).length} operações), de ${capture.url}.`,
    ];
    if (capture.added.length > 0) out.push('', 'Operações novas:', ...capture.added.map((label) => `  + ${label}`));
    if (capture.removed.length > 0) out.push('', 'Operações removidas:', ...capture.removed.map((label) => `  - ${label}`));
    if (capture.broken.length > 0) {
      out.push(
        '',
        'Itens não iniciados que citam operação que saiu (ficam no backlog até você corrigir):',
        ...capture.broken.map(({ item, entry }) => `  #${item.number} ${item.title}: ${entry}`),
      );
    }
    const { warnings } = syncBacklog(db, project);
    out.push(...warnings.map((warning) => `Aviso: ${warning}`));
    out.push('', style.dim('Versione o snapshot: git add .mabel/referencias'));
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ProjectError || error instanceof CaptureError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}
