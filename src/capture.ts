import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { expired, expiryWarning } from './credentials.ts';
import { dataDir, openDb } from './db.ts';
import { fail } from './errors.ts';
import { selectMany } from './menu.ts';
import { type Item, isStarted, listItems, syncBacklog } from './items.ts';
import { type ArgSpec, type OptionSpecs, jsonOption } from './options.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import { writeJson } from './json.ts';
import {
  NAME,
  filesUnder,
  type OpenApi,
  asOpenApi,
  operationLabel,
  operations,
  parseReference,
  readSnapshot,
  referencesRoot,
  screenDir,
  snapshotPath,
} from './references.ts';
import { style } from './style.ts';

/** `mabel referencia`: captura e lista as referências do projeto (`docs/specs/referencias.md`). */

export const referenceUsage = [
  'mabel referencia [--json]',
  'mabel referencia api <nome> <url>',
  'mabel referencia tela <nome> <url-figma> [--escala <n>]',
  'mabel referencia tela <nome> --png <arquivo>',
].join('\n       ');

export const referenceOptions = {
  escala: { type: 'string', value: '<n>', description: 'Escala da imagem exportada do Figma, de 0 a 4 (padrão 2)' },
  png: { type: 'string', value: '<arquivo>', values: 'arquivo', description: 'Usa um PNG exportado à mão em vez de baixar do Figma' },
  json: { ...jsonOption, description: 'Sem subcomando: o catálogo de referências em JSON, para outros programas' },
} satisfies OptionSpecs;

export const referenceArgs: ArgSpec[] = [
  {
    name: 'api | tela',
    description: 'O que capturar; sem nada, lista as referências do projeto',
    choices: [
      { name: 'api', description: 'Grava um snapshot OpenAPI a partir da URL do Swagger' },
      { name: 'tela', description: 'Exporta um frame do Figma (ou um PNG) como tela.png e tela.md' },
    ],
  },
  { name: '<nome>', description: 'Nome da referência: minúsculas, dígitos e -' },
  { name: '<url>', description: 'URL do OpenAPI/Swagger ou do frame do Figma (com node-id)' },
];

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

// Tela (Figma) ------------------------------------------------------------------------------

export interface FigmaLink {
  fileKey: string;
  nodeId: string;
}

/** Chave do arquivo e nó do link do Figma (`node-id=2696-108134` vira `2696:108134`). */
export function parseFigmaUrl(url: string): FigmaLink {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CaptureError(`"${url}" não é um link.`);
  }
  const key = /^\/(?:design|file|proto)\/([A-Za-z0-9]+)/.exec(parsed.pathname)?.[1];
  const node = parsed.searchParams.get('node-id');
  if (!/(^|\.)figma\.com$/.test(parsed.hostname) || !key) throw new CaptureError(`"${url}" não é um link de arquivo do Figma.`);
  if (!node) throw new CaptureError('O link não tem node-id: no Figma, selecione o frame e copie o link dele.');
  return { fileKey: key, nodeId: node.replace(/-/g, ':') };
}

interface FigmaNode {
  type?: string;
  name?: string;
  characters?: string;
  visible?: boolean;
  fills?: { type?: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number }; opacity?: number }[];
  absoluteBoundingBox?: { width: number; height: number };
  children?: FigmaNode[];
}

function hex(color: { r: number; g: number; b: number; a: number }, opacity = 1): string {
  const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0');
  const alpha = color.a * opacity;
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}${alpha < 1 ? channel(alpha) : ''}`.toUpperCase();
}

/** Textos (na ordem do documento) e cores sólidas com contagem, dos nós visíveis do frame. */
export function describeFrame(frame: FigmaNode): { texts: string[]; colors: [string, number][] } {
  const texts: string[] = [];
  const colors = new Map<string, number>();
  const visit = (node: FigmaNode) => {
    if (node.visible === false) return;
    if (node.type === 'TEXT' && node.characters?.trim()) texts.push(node.characters.trim().replace(/\s*\n\s*/g, ' / '));
    for (const fill of node.fills ?? []) {
      if (fill.type !== 'SOLID' || fill.visible === false || !fill.color) continue;
      const color = hex(fill.color, fill.opacity);
      colors.set(color, (colors.get(color) ?? 0) + 1);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(frame);
  return { texts, colors: [...colors].sort((a, b) => b[1] - a[1]) };
}

function figmaApi(): string {
  return process.env.MABEL_FIGMA_API || 'https://api.figma.com';
}

async function figmaJson<T>(path: string, token: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${figmaApi()}${path}`, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new CaptureError(`Figma inacessível: ${(error as Error).message}`);
  }
  const body = await response.text();
  if (!response.ok) {
    const hint = response.status === 403 ? ' (token inválido ou sem acesso ao arquivo)' : response.status === 404 ? ' (arquivo ou nó não existe)' : '';
    throw new CaptureError(`Figma respondeu ${response.status}${hint}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body) as T;
}

export interface ScreenCapture {
  dir: string;
  files: string[];
}

function screenHeader(name: string, lines: string[]): string[] {
  return [`# Tela ${name}`, '', ...lines];
}

/** Exporta o frame do Figma como `tela.png` e descreve textos, cores e tamanho em `tela.md`. */
export async function captureFigma(root: string, name: string, url: string, scale = 2, now = new Date()): Promise<ScreenCapture> {
  if (!NAME.test(name)) throw new CaptureError(`Nome "${name}" inválido: use letras minúsculas, dígitos e -.`);
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new CaptureError(
      'Defina FIGMA_TOKEN com um token pessoal do Figma (Settings › Security › Personal access tokens, escopo de leitura de arquivos). Sem token, exporte o frame como PNG no Figma e use --png <arquivo>.',
    );
  }
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const ids = encodeURIComponent(nodeId);
  const images = await figmaJson<{ err?: string | null; images?: Record<string, string | null> }>(
    `/v1/images/${fileKey}?ids=${ids}&format=png&scale=${scale}`,
    token,
  );
  const imageUrl = images.images?.[nodeId];
  if (!imageUrl) throw new CaptureError(`Figma não exportou o nó ${nodeId}${images.err ? `: ${images.err}` : ''}.`);
  const nodes = await figmaJson<{ name?: string; nodes?: Record<string, { document?: FigmaNode } | null> }>(
    `/v1/files/${fileKey}/nodes?ids=${ids}`,
    token,
  );
  const frame = nodes.nodes?.[nodeId]?.document;
  if (!frame) throw new CaptureError(`Nó ${nodeId} não encontrado no arquivo.`);

  let png: Response;
  try {
    png = await fetch(imageUrl, { signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new CaptureError(`Não foi possível baixar o PNG: ${(error as Error).message}`);
  }
  if (!png.ok) throw new CaptureError(`Download do PNG respondeu ${png.status}.`);

  const dir = screenDir(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tela.png'), Buffer.from(await png.arrayBuffer()));
  const { texts, colors } = describeFrame(frame);
  const box = frame.absoluteBoundingBox;
  writeWithNotes(
    join(dir, 'tela.md'),
    screenHeader(name, [
      `- Origem: ${url}`,
      `- Arquivo: ${nodes.name ?? fileKey} · frame "${frame.name ?? nodeId}" (${nodeId})`,
      `- Capturado em: ${now.toISOString()}`,
      ...(box ? [`- Tamanho: ${Math.round(box.width)} × ${Math.round(box.height)} (PNG em escala ${scale})`] : []),
      '',
      '## Textos',
      '',
      ...(texts.length > 0 ? texts.map((text) => `- ${text}`) : ['Nenhum.']),
      '',
      '## Cores sólidas',
      '',
      ...(colors.length > 0 ? colors.map(([color, count]) => `- \`${color}\` × ${count}`) : ['Nenhuma.']),
    ]),
  );
  return { dir, files: ['tela.png', 'tela.md'] };
}

/** Grava um PNG exportado à mão como `tela.png`, com um `tela.md` mínimo. */
export function captureScreenFile(root: string, name: string, file: string, now = new Date()): ScreenCapture {
  if (!NAME.test(name)) throw new CaptureError(`Nome "${name}" inválido: use letras minúsculas, dígitos e -.`);
  if (!existsSync(file)) throw new CaptureError(`${file} não existe.`);
  if (!readFileSync(file).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new CaptureError(`${file} não é um PNG.`);
  }
  const dir = screenDir(root, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, join(dir, 'tela.png'));
  writeWithNotes(join(dir, 'tela.md'), screenHeader(name, [`- Origem: ${file} (exportado à mão)`, `- Capturado em: ${now.toISOString()}`]));
  return { dir, files: ['tela.png', 'tela.md'] };
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

// Catálogo ----------------------------------------------------------------------------------

/** Uma entrada que um item pode citar em `Referências:`, pronta para gravar. */
export interface CatalogEntry {
  entry: string;
  kind: 'tela' | 'api' | 'arquivo';
  /** Nome da tela ou da API; caminho do arquivo avulso. */
  name: string;
  /** Arquivos da tela, resumo da operação ou vazio. */
  detail: string;
  /** Itens (não cancelados) que já a citam. */
  items: number[];
}

/**
 * Tudo o que se pode citar hoje: cada tela, cada operação de cada snapshot (pelo método e
 * caminho, nunca o snapshot inteiro) e os arquivos avulsos de `.mabel/referencias/`.
 */
export function referenceCatalog(root: string, items: Item[]): CatalogEntry[] {
  const base = referencesRoot(root);
  const citing = (matches: (entry: string) => boolean) => [...new Set(citingItems(items, matches).map(({ item }) => item.number))];
  const same = (entry: string) => (other: string) => other.trim().toLowerCase() === entry.toLowerCase();
  const catalog: CatalogEntry[] = [];

  for (const name of listDir(join(base, 'telas'))) {
    const entry = `tela: ${name}`;
    const files = existsSync(screenDir(root, name)) ? filesUnder(screenDir(root, name)).map((file) => relative(screenDir(root, name), file)) : [];
    if (files.length === 0) continue;
    catalog.push({
      entry,
      kind: 'tela',
      name,
      detail: files.join(', '),
      items: citing((other) => {
        const ref = parseReference(other);
        return !('error' in ref) && ref.kind === 'tela' && ref.name === name;
      }),
    });
  }

  for (const file of listDir(join(base, 'api')).filter((f) => f.endsWith('.openapi.json'))) {
    const name = file.replace(/\.openapi\.json$/, '');
    const spec = readSnapshot(root, name);
    if (typeof spec === 'string') continue;
    for (const op of operations(spec)) {
      const entry = `api: ${name} ${operationLabel(op)}`;
      catalog.push({
        entry,
        kind: 'api',
        name,
        detail: op.summary ?? op.operationId ?? '',
        items: citing((other) => {
          const ref = parseReference(other);
          if ('error' in ref || ref.kind !== 'api' || ref.name !== name) return false;
          return 'operationId' in ref ? ref.operationId === op.operationId : ref.method === op.method && ref.path === op.path;
        }),
      });
    }
  }

  const loose = existsSync(base)
    ? filesUnder(base)
        .map((file) => relative(base, file).split('\\').join('/'))
        .filter((path) => !path.startsWith('api/') && !path.startsWith('telas/'))
    : [];
  for (const path of loose) {
    catalog.push({ entry: path, kind: 'arquivo', name: path, detail: '', items: citing(same(path)) });
  }
  return catalog;
}

/** Rótulo e dica de uma entrada para listas de escolha. */
export function catalogHint(entry: CatalogEntry): string {
  const cited = entry.items.length > 0 ? `itens ${entry.items.map((n) => `#${n}`).join(', ')}` : '';
  return [entry.detail, cited].filter(Boolean).join(' · ');
}

export function catalogJson(catalog: CatalogEntry[]): Record<string, unknown> {
  return {
    referencias: catalog.map((entry) => ({
      entrada: entry.entry,
      tipo: entry.kind,
      nome: entry.name,
      detalhe: entry.detail,
      itens: entry.items,
    })),
  };
}

/**
 * Escolha das referências na lista do catálogo, com as já informadas marcadas. Devolve as
 * entradas na ordem do catálogo, seguidas das informadas que não estão nele.
 */
export async function chooseReferences(catalog: CatalogEntry[], current: string[]): Promise<string[] | null> {
  const key = (entry: string) => entry.trim().toLowerCase();
  const preselected = catalog.flatMap((entry, i) => (current.some((other) => key(other) === key(entry.entry)) ? [i] : []));
  const chosen = await selectMany(
    catalog.map((entry) => ({ label: entry.entry, hint: style.dim(catalogHint(entry)) })),
    preselected,
    style,
  );
  if (chosen === null) return null;
  const known = new Set(catalog.map((entry) => key(entry.entry)));
  return [...chosen.map((i) => (catalog[i] as CatalogEntry).entry), ...current.filter((entry) => !known.has(key(entry)))];
}

// Comando -----------------------------------------------------------------------------------

export async function referenceCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: referenceOptions });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${referenceUsage}\n`);
    return 1;
  }
  const { values } = parsed;
  const [kind, name, url, ...extra] = parsed.positionals;
  const scale = values.escala === undefined ? 2 : Number(values.escala);
  const valid =
    kind === undefined
      ? parsed.positionals.length === 0 && values.png === undefined && values.escala === undefined
      : values.json !== undefined
        ? false
        : kind === 'api'
          ? Boolean(name && url) && extra.length === 0 && values.png === undefined && values.escala === undefined
          : kind === 'tela' && Boolean(name) && extra.length === 0 && (values.png === undefined) === Boolean(url);
  if (!valid || !(scale > 0 && scale <= 4)) return fail('argumento_invalido', 'Argumentos inválidos.', referenceUsage);

  const home = dataDir();
  const db = openDb(home);
  const figma = kind === 'tela' && values.png === undefined;
  try {
    const project = resolveProject(db);
    syncBacklog(db, project);
    if (kind === undefined && values.json) {
      writeJson(catalogJson(referenceCatalog(project.root, listItems(db, project.id))));
      return 0;
    }
    if (kind === undefined) {
      process.stdout.write(`${renderReferences(db, project).join('\n')}\n`);
      return 0;
    }
    if (kind === 'tela') {
      const warning = figma ? expiryWarning(home, 'figma') : null;
      if (warning) process.stderr.write(`${style.dim(`Aviso: ${warning}`)}\n`);
      const screen = values.png
        ? captureScreenFile(project.root, name as string, values.png)
        : await captureFigma(project.root, name as string, url as string, scale);
      const { warnings } = syncBacklog(db, project);
      process.stdout.write(
        [
          `Tela ${relative(project.root, screen.dir)}/ gravada: ${screen.files.join(', ')}.`,
          ...warnings.map((warning) => `Aviso: ${warning}`),
          '',
          style.dim('Confira o tela.md e acrescente estados e notas; o próximo `mabel run` commita o .mabel/ na base.'),
          '',
        ].join('\n'),
      );
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
    out.push('', style.dim('O próximo `mabel run` commita o snapshot na base.'));
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  } catch (error) {
    if (values.json && error instanceof ProjectError) return fail(error.code, error.message);
    if (error instanceof ProjectError || error instanceof CaptureError) {
      process.stderr.write(`${error.message}\n`);
      // 403 com o token vencido pela data registrada: o motivo provável, dito com todas as letras.
      if (figma && /respondeu 403/.test(error.message) && expired(home, 'figma')) {
        process.stderr.write(`${expiryWarning(home, 'figma')}\n`);
      }
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}
