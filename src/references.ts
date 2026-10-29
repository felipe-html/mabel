import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { mabelPath } from './project.ts';

/**
 * Referências de tela e de API do item (`docs/specs/referencias.md`): cópias versionadas em
 * `.mabel/referencias/`, conferidas no `ready` e congeladas por item no planejamento.
 */

export const REFERENCES_DIR = 'referencias';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export type Reference =
  | { kind: 'tela'; name: string }
  | { kind: 'api'; name: string; method: string; path: string }
  | { kind: 'api'; name: string; operationId: string }
  | { kind: 'arquivo'; path: string };

export const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function referencesRoot(root: string): string {
  return mabelPath(root, REFERENCES_DIR);
}

export function snapshotPath(root: string, name: string): string {
  return join(referencesRoot(root), 'api', `${name}.openapi.json`);
}

export function screenDir(root: string, name: string): string {
  return join(referencesRoot(root), 'telas', name);
}

/** Lê uma entrada do campo `Referências:`; `{ error }` quando a forma não é reconhecida. */
export function parseReference(entry: string): Reference | { error: string } {
  const text = entry.trim();
  const screen = /^tela:\s*(.*)$/i.exec(text);
  if (screen) {
    const name = (screen[1] ?? '').trim();
    return NAME.test(name) ? { kind: 'tela', name } : { error: 'nome de tela inválido' };
  }
  const api = /^api:\s*(.*)$/i.exec(text);
  if (api) {
    const [name = '', ...rest] = (api[1] ?? '').trim().split(/\s+/);
    if (!NAME.test(name)) return { error: 'nome de API inválido' };
    if (rest.length === 1 && rest[0]) return { kind: 'api', name, operationId: rest[0] };
    if (rest.length === 2 && rest[0] && rest[1] && HTTP_METHODS.includes(rest[0].toLowerCase() as never)) {
      return { kind: 'api', name, method: rest[0].toUpperCase(), path: rest[1] };
    }
    return { error: 'use `api: <nome> <MÉTODO> <caminho>` ou `api: <nome> <operationId>`' };
  }
  return { kind: 'arquivo', path: text };
}

// Snapshot OpenAPI -----------------------------------------------------------------------

export interface OpenApi {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface Operation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
}

/** Valida o JSON de um snapshot; `undefined` quando não é OpenAPI (ou Swagger) com `paths`. */
export function asOpenApi(value: unknown): OpenApi | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const spec = value as Partial<OpenApi>;
  if (typeof spec.openapi !== 'string' && typeof spec.swagger !== 'string') return undefined;
  if (typeof spec.paths !== 'object' || spec.paths === null) return undefined;
  return spec as OpenApi;
}

export function readSnapshot(root: string, name: string): OpenApi | string {
  const path = snapshotPath(root, name);
  if (!existsSync(path)) return `snapshot ${relative(root, path)} não existe`;
  try {
    return asOpenApi(JSON.parse(readFileSync(path, 'utf8'))) ?? `snapshot ${name} não é OpenAPI com \`paths\``;
  } catch {
    return `snapshot ${name} não é JSON válido`;
  }
}

export function operations(spec: OpenApi): Operation[] {
  const result: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method] as { operationId?: string; summary?: string } | undefined;
      if (!op) continue;
      result.push({ method: method.toUpperCase(), path, operationId: op.operationId, summary: op.summary });
    }
  }
  return result;
}

export function operationLabel(op: Pick<Operation, 'method' | 'path'>): string {
  return `${op.method} ${op.path}`;
}

export function findOperation(
  spec: OpenApi,
  ref: { method: string; path: string } | { operationId: string },
): Operation | undefined {
  return operations(spec).find((op) =>
    'operationId' in ref ? op.operationId === ref.operationId : op.method === ref.method && op.path === ref.path,
  );
}

/** A operação com os componentes que ela alcança por `$ref`, num documento OpenAPI mínimo. */
export function extractOperation(spec: OpenApi, op: Pick<Operation, 'method' | 'path'>): OpenApi {
  const pathItem = spec.paths[op.path] ?? {};
  const method = op.method.toLowerCase();
  // Parâmetros do caminho valem para todas as operações dele.
  const shared = Object.fromEntries(Object.entries(pathItem).filter(([key]) => key === 'parameters'));
  const extracted: OpenApi = {
    ...(spec.openapi ? { openapi: spec.openapi } : { swagger: spec.swagger }),
    info: spec.info ?? {},
    paths: { [op.path]: { ...shared, [method]: pathItem[method] } },
  };

  const seen = new Set<string>();
  const pending: unknown[] = [extracted.paths];
  const components: Record<string, Record<string, unknown>> = {};
  const definitions: Record<string, unknown> = {};
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key !== '$ref' || typeof value !== 'string') {
        pending.push(value);
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      const target = /^#\/components\/([^/]+)\/(.+)$/.exec(value) ?? /^#\/(definitions)\/(.+)$/.exec(value);
      if (!target?.[1] || !target[2]) continue;
      const [, group, rawName] = target;
      const name = rawName.replace(/~1/g, '/').replace(/~0/g, '~');
      const source = group === 'definitions' ? (spec.definitions as Record<string, unknown>) : spec.components?.[group];
      const component = source?.[name];
      if (component === undefined) continue;
      if (group === 'definitions') definitions[name] = component;
      else (components[group] ??= {})[name] = component;
      pending.push(component);
    }
  }
  if (Object.keys(components).length > 0) extracted.components = components;
  if (Object.keys(definitions).length > 0) extracted.definitions = definitions;
  return extracted;
}

// Conferência e arquivos -----------------------------------------------------------------

export function filesUnder(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function insideReferences(root: string, path: string): string | undefined {
  const base = referencesRoot(root);
  const absolute = resolve(base, path);
  const rel = relative(base, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  return absolute;
}

/** Arquivos que a entrada alcança, ou o problema que impede a referência. */
export function resolveReference(root: string, entry: string): { files: string[] } | { problem: string } {
  const ref = parseReference(entry);
  if ('error' in ref) return { problem: ref.error };
  if (ref.kind === 'tela') {
    const dir = screenDir(root, ref.name);
    const files = existsSync(dir) && statSync(dir).isDirectory() ? filesUnder(dir) : [];
    return files.length > 0 ? { files } : { problem: `tela ${ref.name} sem arquivos em ${relative(root, dir)}` };
  }
  if (ref.kind === 'api') {
    const spec = readSnapshot(root, ref.name);
    if (typeof spec === 'string') return { problem: spec };
    if (!findOperation(spec, ref)) {
      const label = 'operationId' in ref ? `operationId ${ref.operationId}` : operationLabel(ref);
      return { problem: `${label} não existe no snapshot ${ref.name}` };
    }
    return { files: [snapshotPath(root, ref.name)] };
  }
  const path = insideReferences(root, ref.path);
  if (!path) return { problem: `caminho fora de .mabel/${REFERENCES_DIR}/` };
  if (!existsSync(path) || !statSync(path).isFile()) return { problem: `arquivo .mabel/${REFERENCES_DIR}/${ref.path} não existe` };
  return { files: [path] };
}

/** Primeira referência que não confere, como motivo do `backlog`; `null` quando todas conferem. */
export function referenceProblem(root: string, entries: string[]): string | null {
  for (const entry of entries) {
    const resolved = resolveReference(root, entry);
    if ('problem' in resolved) return `referência inválida: ${entry} (${resolved.problem})`;
  }
  return null;
}

/** Hash dos arquivos que as entradas alcançam; entra no hash do item. Ausentes contam como ausentes. */
export function referencesDigest(root: string, entries: string[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    const resolved = resolveReference(root, entry);
    hash.update(`${entry}\0`);
    if ('problem' in resolved) {
      hash.update(`!${resolved.problem}\0`);
      continue;
    }
    for (const file of resolved.files) {
      hash.update(`${relative(root, file)}\0`);
      hash.update(readFileSync(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

// Cópia congelada --------------------------------------------------------------------------

export function frozenDir(itemDirectory: string): string {
  return join(itemDirectory, REFERENCES_DIR);
}

function operationFileName(name: string, op: Pick<Operation, 'method' | 'path'>): string {
  const slug = op.path.replace(/^\/+/, '').replace(/[{}]/g, '').replace(/[^A-Za-z0-9._-]+/g, '-') || 'raiz';
  return `${name}--${op.method}-${slug}.json`;
}

export interface FrozenReference {
  entry: string;
  /** Caminhos dos arquivos, relativos ao diretório da cópia. */
  files: string[];
}

/**
 * Copia as referências do item para `<itemDir>/referencias/`, uma vez: se a cópia existe,
 * fica como está (o item iniciado lê o que tinha no começo). Devolve o que está na cópia.
 */
export function freezeReferences(root: string, itemDirectory: string, entries: string[]): FrozenReference[] {
  const dir = frozenDir(itemDirectory);
  const manifest = join(dir, 'referencias.json');
  if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')) as FrozenReference[];

  const base = referencesRoot(root);
  const frozen: FrozenReference[] = [];
  const copy = (source: string): string => {
    const rel = relative(base, source);
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    return rel;
  };
  for (const entry of entries) {
    const resolved = resolveReference(root, entry);
    if ('problem' in resolved) {
      frozen.push({ entry, files: [] });
      continue;
    }
    const files = resolved.files.map(copy);
    const ref = parseReference(entry);
    if (!('error' in ref) && ref.kind === 'api') {
      const spec = readSnapshot(root, ref.name) as OpenApi;
      const op = findOperation(spec, ref) as Operation;
      const name = join('api', operationFileName(ref.name, op));
      writeFileSync(join(dir, name), `${JSON.stringify(extractOperation(spec, op), null, 2)}\n`);
      files.unshift(name);
    }
    frozen.push({ entry, files });
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(manifest, `${JSON.stringify(frozen, null, 2)}\n`);
  return frozen;
}

/** As referências como estão na raiz do projeto (refinamento, sem cópia), relativas a ela. */
export function liveReferences(root: string, entries: string[]): FrozenReference[] {
  return entries.map((entry) => {
    const resolved = resolveReference(root, entry);
    return { entry, files: 'files' in resolved ? resolved.files.map((file) => relative(root, file)) : [] };
  });
}

/** Seção "Referências" dos prompts: cada entrada com os arquivos, já no caminho que o agente lê. */
export function referencesSection(frozen: FrozenReference[], base: string): string {
  if (frozen.length === 0) return '';
  const lines = [
    'Arquivos de referência do item, só para leitura. A tela é a referência visual (abra as',
    'imagens com Read); a operação é o contrato da API (o primeiro arquivo traz só ela e os',
    'esquemas que usa). Os testes usam dados derivados do contrato, sem chamar o backend.',
    '',
  ];
  for (const { entry, files } of frozen) {
    lines.push(`- ${entry}`);
    if (files.length === 0) lines.push('  - (arquivos ausentes na cópia do item)');
    for (const file of files) lines.push(`  - \`${join(base, file)}\``);
  }
  return lines.join('\n');
}
