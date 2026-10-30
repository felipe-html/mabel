import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type Project, mabelPath } from './project.ts';

// Specs (S.3): uma funcionalidade com história, regras com exemplos (Example Mapping),
// decisões, fora do escopo e regras críticas, em `.mabel/specs/<slug>.md`. O arquivo é só
// conteúdo; o estado (rascunho, aceita, entregue) fica no banco. Seções que o Mabel não
// conhece (`## Contexto`, `## Alternativas rejeitadas`…) são do humano: passam como estão.

export const SPECS_DIR = 'specs';
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Marca de exemplo de borda no fim da linha. */
export const EDGE_MARK = '(borda)';

export interface SpecExample {
  situacao: string;
  resultado: string;
  borda: boolean;
}

export interface SpecRule {
  id: string;
  texto: string;
  exemplos: SpecExample[];
}

export type RuleChangeAction = 'incluir' | 'alterar' | 'remover';

export interface RuleChange {
  assunto: string;
  acao: RuleChangeAction;
  texto: string;
}

export interface Spec {
  titulo: string;
  historia: string;
  regras: SpecRule[];
  decisoes: string[];
  /** `null`: a seção não foi declarada (diferente de "Nada."). */
  foraDoEscopo: string[] | null;
  regrasCriticas: string[];
  /** Referências de `.mabel/referencias/`, no formato do backlog; as tarefas da spec as herdam. */
  referencias: string[];
  alteracoesRegrasVigentes: RuleChange[];
  /** Seções que o Mabel não interpreta, na ordem do arquivo, com o texto literal. */
  secoes: SpecSection[];
}

export interface SpecSection {
  titulo: string;
  texto: string;
}

/** O que a tarefa recebe da spec: história, regras citadas com exemplos e o resto do contexto. */
export interface SpecExcerpt {
  slug: string;
  titulo: string;
  historia: string;
  regras: SpecRule[];
  decisoes: string[];
  foraDoEscopo: string[];
  regrasCriticas: string[];
  /** Só quando a spec tem seções próprias: a spec sem elas mantém o hash das tarefas. */
  secoes?: SpecSection[];
}

export function specPath(root: string, slug: string): string {
  return mabelPath(root, `${SPECS_DIR}/${slug}.md`);
}

// Formato --------------------------------------------------------------------------------

const ARROW = /\s*(?:→|->)\s*/;
const NOTHING = /^nada\.?$/i;

/** `- situação → resultado (borda)`; sem seta, o resultado fica vazio. */
export function parseExample(line: string): SpecExample {
  let text = line.trim();
  const borda = text.endsWith(EDGE_MARK);
  if (borda) text = text.slice(0, -EDGE_MARK.length).trim();
  const parts = text.split(ARROW);
  if (parts.length < 2) return { situacao: text, resultado: '', borda };
  const resultado = parts.pop() as string;
  return { situacao: parts.join(' → '), resultado: resultado.trim(), borda };
}

export function renderExample(example: SpecExample): string {
  return `${example.situacao} → ${example.resultado || '?'}${example.borda ? ` ${EDGE_MARK}` : ''}`;
}

/** `pedidos: incluir "texto"`. */
export function parseChange(line: string): RuleChange | undefined {
  const found = /^(.+?):\s*(incluir|alterar|remover)\s+"?(.*?)"?\s*$/i.exec(line.trim());
  if (!found) return undefined;
  return { assunto: (found[1] as string).trim(), acao: (found[2] as string).toLowerCase() as RuleChangeAction, texto: found[3] as string };
}

export function renderChange(change: RuleChange): string {
  return `${change.assunto}: ${change.acao} "${change.texto}"`;
}

type Section = 'historia' | 'regras' | 'decisoes' | 'fora' | 'criticas' | 'referencias' | 'alteracoes' | 'outra';

function sectionOf(title: string): Section {
  const t = title.toLowerCase();
  if (t.startsWith('hist')) return 'historia';
  if (t.startsWith('regras cr')) return 'criticas';
  if (t.startsWith('regras')) return 'regras';
  if (t.startsWith('decis')) return 'decisoes';
  if (t.startsWith('fora do escopo')) return 'fora';
  if (t.startsWith('altera')) return 'alteracoes';
  if (t.startsWith('refer')) return 'referencias';
  return 'outra';
}

/** Lê o arquivo de spec. Não lança: o que não confere aparece na validação. */
export function parseSpec(text: string): Spec {
  const spec: Spec = {
    titulo: '',
    historia: '',
    regras: [],
    decisoes: [],
    foraDoEscopo: null,
    regrasCriticas: [],
    referencias: [],
    alteracoesRegrasVigentes: [],
    secoes: [],
  };
  const story: string[] = [];
  let section: Section | undefined;
  let rule: SpecRule | undefined;
  let other: { titulo: string; linhas: string[] } | undefined;
  const others: { titulo: string; linhas: string[] }[] = [];
  for (const raw of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const line = raw.trimEnd();
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1 && !spec.titulo) {
      spec.titulo = (h1[1] as string).trim();
      continue;
    }
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      section = sectionOf(h2[1] as string);
      rule = undefined;
      other = section === 'outra' ? { titulo: (h2[1] as string).trim(), linhas: [] } : undefined;
      if (other) others.push(other);
      if (section === 'fora') spec.foraDoEscopo ??= [];
      continue;
    }
    const h3 = /^###\s+(R\d+)\b\s*(.*)$/.exec(line);
    if (h3 && section === 'regras') {
      rule = { id: h3[1] as string, texto: (h3[2] as string).trim(), exemplos: [] };
      spec.regras.push(rule);
      continue;
    }
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1];
    if (other) {
      other.linhas.push(line);
    } else if (section === 'historia') {
      story.push(line);
    } else if (item && section === 'regras' && rule) {
      rule.exemplos.push(parseExample(item));
    } else if (item && section === 'decisoes') {
      spec.decisoes.push(item);
    } else if (section === 'fora' && (item || NOTHING.test(line.trim()))) {
      const entry = item ?? line.trim();
      if (!NOTHING.test(entry)) spec.foraDoEscopo?.push(entry);
    } else if (item && section === 'criticas') {
      spec.regrasCriticas.push(item);
    } else if (item && section === 'referencias') {
      spec.referencias.push(item);
    } else if (item && section === 'alteracoes') {
      const change = parseChange(item);
      if (change) spec.alteracoesRegrasVigentes.push(change);
    }
  }
  spec.historia = story.join('\n').trim();
  spec.secoes = others.map((entry) => ({ titulo: entry.titulo, texto: entry.linhas.join('\n').trim() }));
  return spec;
}

export function renderSpec(spec: Spec): string {
  const lines = [`# ${spec.titulo}`, '', '## História', spec.historia];
  for (const own of spec.secoes) lines.push('', `## ${own.titulo}`, ...(own.texto ? [own.texto] : []));
  lines.push('', '## Regras');
  for (const rule of spec.regras) {
    lines.push('', `### ${rule.id} ${rule.texto}`, ...rule.exemplos.map((e) => `- ${renderExample(e)}`));
  }
  const list = (title: string, entries: string[], empty?: string) => {
    if (entries.length === 0 && empty === undefined) return;
    lines.push('', `## ${title}`, ...(entries.length > 0 ? entries.map((e) => `- ${e}`) : [empty as string]));
  };
  list('Decisões', spec.decisoes);
  list('Fora do escopo', spec.foraDoEscopo ?? [], 'Nada.');
  list('Regras críticas', spec.regrasCriticas);
  list('Referências', spec.referencias);
  list('Alterações nas regras vigentes', spec.alteracoesRegrasVigentes.map(renderChange));
  return `${lines.join('\n')}\n`;
}

// Validação ------------------------------------------------------------------------------

/** Estrutura da spec válida, conferida pelo Mabel sem depender do agente. */
export function validateSpec(spec: Spec): string[] {
  const errors: string[] = [];
  if (!spec.titulo) errors.push('sem título (# …)');
  if (!spec.historia) errors.push('sem história');
  if (spec.regras.length === 0) errors.push('sem regras');
  const ids = new Set<string>();
  for (const rule of spec.regras) {
    if (ids.has(rule.id)) errors.push(`${rule.id} repetida`);
    ids.add(rule.id);
    if (rule.exemplos.length === 0) errors.push(`${rule.id} sem exemplo`);
    for (const example of rule.exemplos) {
      if (!example.resultado || example.resultado === '?') errors.push(`${rule.id}: exemplo sem resultado ("${example.situacao}")`);
    }
  }
  if (spec.regras.length > 0 && !spec.regras.some((rule) => rule.exemplos.some((e) => e.borda))) {
    errors.push(`nenhum exemplo de borda (marque com ${EDGE_MARK} no fim da linha)`);
  }
  if (spec.foraDoEscopo === null) errors.push('fora do escopo não declarado (pode ser "Nada.")');
  return errors;
}

/** Spec lida do disco, ou o motivo de não ter sido lida. */
export function readSpec(root: string, slug: string): Spec | undefined {
  const path = specPath(root, slug);
  return existsSync(path) ? parseSpec(readFileSync(path, 'utf8')) : undefined;
}

export function listSpecFiles(root: string): string[] {
  const dir = mabelPath(root, SPECS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && SLUG.test(name.slice(0, -3)))
    .map((name) => name.slice(0, -3))
    .sort();
}

/** O trecho da spec que a tarefa cita: entra no hash e nos prompts. */
export function specExcerpt(slug: string, spec: Spec, ruleIds: string[]): SpecExcerpt {
  return {
    slug,
    titulo: spec.titulo,
    historia: spec.historia,
    regras: ruleIds.flatMap((id) => spec.regras.filter((rule) => rule.id === id)),
    decisoes: spec.decisoes,
    foraDoEscopo: spec.foraDoEscopo ?? [],
    regrasCriticas: spec.regrasCriticas,
    ...(spec.secoes.length > 0 ? { secoes: spec.secoes } : {}),
  };
}

export function excerptDigest(excerpt: SpecExcerpt): string {
  return createHash('sha256').update(JSON.stringify(excerpt)).digest('hex');
}

/** Exemplos das regras citadas como critérios de aceite: `R1: situação → resultado`. */
export function exampleCriteria(excerpt: SpecExcerpt): string[] {
  return excerpt.regras.flatMap((rule) => rule.exemplos.map((example) => `${rule.id}: ${renderExample(example)}`));
}

/** Acrescenta uma decisão à seção `## Decisões` do arquivo (criada antes de `Fora do escopo`, se faltar). */
export function appendSpecDecision(root: string, slug: string, decision: string): boolean {
  const path = specPath(root, slug);
  if (!existsSync(path)) return false;
  const lines = readFileSync(path, 'utf8').replace(/\n+$/, '').split('\n');
  const start = lines.findIndex((line) => /^##\s+decis/i.test(line));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !/^##\s/.test(lines[end] as string)) end++;
    while (end > start + 1 && !(lines[end - 1] as string).trim()) end--;
    lines.splice(end, 0, `- ${decision}`);
  } else {
    const before = lines.findIndex((line) => /^##\s+(fora do escopo|regras cr|altera)/i.test(line));
    const block = ['## Decisões', `- ${decision}`, ''];
    if (before >= 0) lines.splice(before, 0, ...block);
    else lines.push('', ...block.slice(0, 2));
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
  return true;
}

// Estado no banco ------------------------------------------------------------------------

export type SpecStatus = 'rascunho' | 'aceita' | 'entregue';

export interface SpecRecord {
  slug: string;
  status: SpecStatus;
  acceptedAt: string | null;
}

/** Tamanho da spec no aceite do motor (S7), para a análise de 2026-11-05. */
export interface SpecMetrics {
  regras: number;
  exemplos: number;
  rodadas: number;
  perguntas: number;
  tarefas: number;
}

export function setSpecMetrics(db: DatabaseSync, projectId: string, slug: string, metrics: SpecMetrics): void {
  db.prepare('UPDATE specs SET metrics = ?, updated_at = ? WHERE project_id = ? AND slug = ?').run(
    JSON.stringify(metrics),
    new Date().toISOString(),
    projectId,
    slug,
  );
}

export function getSpecMetrics(db: DatabaseSync, projectId: string, slug: string): SpecMetrics | null {
  const row = db.prepare('SELECT metrics FROM specs WHERE project_id = ? AND slug = ?').get(projectId, slug) as { metrics: string | null } | undefined;
  return row?.metrics ? (JSON.parse(row.metrics) as SpecMetrics) : null;
}

export function getSpecRecord(db: DatabaseSync, projectId: string, slug: string): SpecRecord | undefined {
  const row = db.prepare('SELECT slug, status, accepted_at FROM specs WHERE project_id = ? AND slug = ?').get(projectId, slug) as
    | { slug: string; status: SpecStatus; accepted_at: string | null }
    | undefined;
  return row ? { slug: row.slug, status: row.status, acceptedAt: row.accepted_at } : undefined;
}

export function listSpecRecords(db: DatabaseSync, projectId: string): SpecRecord[] {
  const rows = db.prepare('SELECT slug, status, accepted_at FROM specs WHERE project_id = ? ORDER BY slug').all(projectId) as {
    slug: string;
    status: SpecStatus;
    accepted_at: string | null;
  }[];
  return rows.map((row) => ({ slug: row.slug, status: row.status, acceptedAt: row.accepted_at }));
}

export function setSpecStatus(db: DatabaseSync, projectId: string, slug: string, status: SpecStatus): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO specs (project_id, slug, status, accepted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (project_id, slug) DO UPDATE SET status = excluded.status,
       accepted_at = coalesce(excluded.accepted_at, specs.accepted_at), updated_at = excluded.updated_at`,
  ).run(projectId, slug, status, status === 'aceita' ? now : null, now, now);
}

/**
 * Motivo pelo qual a tarefa de spec não pode ir a `ready` (S6), ou `null`: spec aceita,
 * válida e com as regras citadas.
 */
export function specProblem(db: DatabaseSync, project: Pick<Project, 'id' | 'root'>, slug: string, ruleIds: string[]): string | null {
  if (!SLUG.test(slug)) return `spec "${slug}" com nome inválido (letras minúsculas, dígitos e -)`;
  const spec = readSpec(project.root, slug);
  if (!spec) return `spec ${slug} não encontrada em .mabel/${SPECS_DIR}/${slug}.md`;
  const status = getSpecRecord(db, project.id, slug)?.status ?? 'rascunho';
  if (status === 'rascunho') return `spec ${slug} não aceita: rode mabel especificar ${slug}`;
  const errors = validateSpec(spec);
  if (errors.length > 0) return `spec ${slug} inválida: ${errors.join('; ')}`;
  const missing = ruleIds.filter((id) => !spec.regras.some((rule) => rule.id === id));
  if (missing.length > 0) return `regra ${missing.join(', ')} não existe na spec ${slug}`;
  return null;
}

// Regras vigentes ------------------------------------------------------------------------

/** Arquivo das regras de negócio vigentes, por assunto (`## <assunto>` e `- regra`). */
export const CURRENT_RULES_FILE = 'regras.md';
const RULES_HEADER = '# Regras vigentes\n';

export interface AppliedChanges {
  text: string;
  /** Uma linha por alteração: o que foi feito (ou por que não). */
  notes: string[];
}

const sameRule = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

const sectionStart = (lines: string[], subject: string) => lines.findIndex((line) => /^##\s/.test(line) && sameRule(line.replace(/^##\s+/, ''), subject));

function sectionEnd(lines: string[], start: number): number {
  let end = start + 1;
  while (end < lines.length && !/^##?\s/.test(lines[end] as string)) end++;
  while (end > start + 1 && !(lines[end - 1] as string).trim()) end--;
  return end;
}

/** Linha da regra `text` no assunto `subject`; -1 se não está lá. */
function findRule(lines: string[], subject: string, text: string): number {
  const start = sectionStart(lines, subject);
  if (start < 0) return -1;
  for (let i = start + 1; i < sectionEnd(lines, start); i++) {
    const item = /^\s*[-*]\s+(.+)$/.exec(lines[i] as string)?.[1];
    if (item && sameRule(item, text)) return i;
  }
  return -1;
}

/**
 * Problemas das alterações contra o `regras.md` atual: `alterar` precisa de `antigo → novo`,
 * com o antigo no assunto. Sem isso a entrega só incluiria a regra nova, e as duas ficariam.
 */
export function ruleChangeProblems(current: string, changes: RuleChange[]): string[] {
  const lines = current.split('\n');
  const problems: string[] = [];
  for (const change of changes.filter((c) => c.acao === 'alterar')) {
    const [before, after] = change.texto.split(ARROW);
    if (after === undefined) problems.push(`alteração em "${change.assunto}" sem a seta: use "regra antiga → regra nova"`);
    else if (findRule(lines, change.assunto, before as string) < 0)
      problems.push(`alteração em "${change.assunto}": "${before}" não está nesse assunto em .mabel/${CURRENT_RULES_FILE}; copie a regra antiga literalmente ou use incluir`);
  }
  return problems;
}

/**
 * Aplica as alterações ao texto do `regras.md`: `incluir` acrescenta a regra no assunto (que
 * é criado se faltar); `alterar` troca `antigo → novo` (sem a seta, ou sem o antigo, inclui);
 * `remover` tira a regra igual ao texto.
 */
export function applyRuleChanges(current: string, changes: RuleChange[]): AppliedChanges {
  const lines = (current.trim() ? current.replace(/\n+$/, '') : RULES_HEADER.trimEnd()).split('\n');
  const notes: string[] = [];
  const include = (subject: string, text: string) => {
    const start = sectionStart(lines, subject);
    if (start < 0) lines.push('', `## ${subject}`, `- ${text}`);
    else lines.splice(sectionEnd(lines, start), 0, `- ${text}`);
  };
  const find = (subject: string, text: string) => findRule(lines, subject, text);
  for (const change of changes) {
    if (change.acao === 'incluir') {
      include(change.assunto, change.texto);
      notes.push(`${change.assunto}: incluído "${change.texto}"`);
    } else if (change.acao === 'remover') {
      const at = find(change.assunto, change.texto);
      if (at >= 0) {
        lines.splice(at, 1);
        notes.push(`${change.assunto}: removido "${change.texto}"`);
      } else notes.push(`${change.assunto}: "${change.texto}" não estava nas regras vigentes; nada removido`);
    } else {
      const [before, after] = change.texto.split(ARROW);
      const at = after !== undefined ? find(change.assunto, before as string) : -1;
      if (at >= 0) {
        lines[at] = `- ${(after as string).trim()}`;
        notes.push(`${change.assunto}: alterado "${before}" → "${(after as string).trim()}"`);
      } else {
        include(change.assunto, (after ?? change.texto).trim());
        notes.push(`${change.assunto}: incluído "${(after ?? change.texto).trim()}" (alteração sem a regra antiga)`);
      }
    }
  }
  return { text: `${lines.join('\n')}\n`, notes };
}
