/** Formato do `.mabel/backlog.md`: geração de blocos de item. */

export interface ItemFields {
  number?: number;
  title: string;
  intent: string;
  criteria: string[];
  dependsOn: number[];
  restrictions: string | null;
}

export const BACKLOG_TEMPLATE = `# Backlog

<!--
Cada item começa com "## <título>". A ordem no arquivo é a prioridade: o primeiro item
pronto é o próximo a ser executado.

Campos de um item:
- Título (obrigatório): o texto do cabeçalho "## ".
- id: <n> — número do item. Atribuído pelo Mabel; não edite.
- Intenção (obrigatória): texto livre logo abaixo, dizendo o que você quer e por quê.
- Critérios: seguido de uma lista "- ..." com os critérios de aceite.
- Depende de: <n>, <n> — itens que precisam estar concluídos antes.
- Restrições: <texto> — limites para a implementação, numa linha.

Três níveis de detalhe:
- Mínimo: título e intenção. O planejador propõe os critérios.
- Recomendado: com critérios de aceite.
- Completo: com critérios, dependências e restrições.

Exemplo:

## Exportar pedidos em CSV
Quero baixar a lista de pedidos para abrir no Excel.

Critérios:
- Uma linha por pedido, com data, cliente e valor
- Valores com vírgula decimal

Depende de: 2
Restrições: não adicionar bibliotecas novas
-->
`;

/** Bloco Markdown de um item, no formato que o parser lê de volta. */
export function renderItemBlock(item: ItemFields): string {
  const lines = [`## ${item.title}`];
  if (item.number !== undefined) lines.push(`id: ${item.number}`);
  lines.push(item.intent.trim());
  if (item.criteria.length > 0) lines.push('', 'Critérios:', ...item.criteria.map((criterion) => `- ${criterion}`));
  const tail: string[] = [];
  if (item.dependsOn.length > 0) tail.push(`Depende de: ${item.dependsOn.join(', ')}`);
  if (item.restrictions) tail.push(`Restrições: ${item.restrictions}`);
  if (tail.length > 0) lines.push('', ...tail);
  return `${lines.join('\n')}\n`;
}

/** Acrescenta blocos ao fim do texto do backlog, separados por uma linha vazia. */
export function appendBlocks(text: string, blocks: string[]): string {
  let result = text;
  for (const block of blocks) {
    if (!result.endsWith('\n')) result += '\n';
    if (!result.endsWith('\n\n')) result += '\n';
    result += block;
  }
  return result;
}

// Parser ---------------------------------------------------------------------------------

export interface ParsedItem extends ItemFields {
  /** Ordem no arquivo, a partir de 0. */
  position: number;
  /** Erros de formato; item com erro fica `blocked`. */
  errors: string[];
  /** Linha `id:` presente mas com valor que não é um inteiro positivo. */
  invalidId?: string;
  /** Posição no texto logo depois da linha do cabeçalho (onde a linha `id:` é inserida). */
  headingEnd: number;
}

/** Troca comentários HTML por espaços, preservando quebras de linha e posições. */
function maskComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

const ID_LINE = /^id:\s*(.*?)\s*$/i;
const CRITERIA_LINE = /^crit[ée]rios:\s*$/i;
const DEPENDS_LINE = /^depende de:\s*(.*?)\s*$/i;
const RESTRICTIONS_LINE = /^restri[çc][õo]es:\s*(.*?)\s*$/i;
const LIST_ITEM = /^\s*[-*]\s+(.+?)\s*$/;

/** Lê o `backlog.md`. Erros de formato ficam no item, nunca lançam. */
export function parseBacklog(text: string): ParsedItem[] {
  const masked = maskComments(text);
  type Draft = ParsedItem & { intentLines: string[]; inCriteria: boolean };
  const items: Draft[] = [];
  let current: Draft | undefined;
  let offset = 0;

  for (const rawLine of masked.split('\n')) {
    const lineEnd = offset + rawLine.length;
    offset = lineEnd + 1;
    const line = rawLine.replace(/\r$/, '');

    const heading = /^##(?:\s+(.*?))?\s*$/.exec(line);
    if (heading && !line.startsWith('###')) {
      current = {
        title: heading[1] ?? '',
        intent: '',
        criteria: [],
        dependsOn: [],
        restrictions: null,
        position: items.length,
        errors: [],
        headingEnd: Math.min(lineEnd + 1, text.length),
        intentLines: [],
        inCriteria: false,
      };
      if (!current.title) current.errors.push('item sem título');
      items.push(current);
      continue;
    }
    if (!current) continue;

    if (current.inCriteria) {
      const item = LIST_ITEM.exec(line);
      if (item?.[1]) {
        current.criteria.push(item[1]);
        continue;
      }
      if (!line.trim()) continue;
      current.inCriteria = false;
    }

    const id = ID_LINE.exec(line);
    if (id && current.number === undefined && current.invalidId === undefined) {
      if (/^[1-9]\d*$/.test(id[1] ?? '')) current.number = Number(id[1]);
      else current.invalidId = id[1] ?? '';
      continue;
    }
    if (CRITERIA_LINE.test(line)) {
      current.inCriteria = true;
      continue;
    }
    const depends = DEPENDS_LINE.exec(line);
    if (depends) {
      for (const token of (depends[1] ?? '').split(',').map((part) => part.trim().replace(/^#/, ''))) {
        if (!token) continue;
        if (/^[1-9]\d*$/.test(token)) current.dependsOn.push(Number(token));
        else current.errors.push(`dependência inválida: "${token}"`);
      }
      continue;
    }
    const restrictions = RESTRICTIONS_LINE.exec(line);
    if (restrictions) {
      current.restrictions = restrictions[1] || null;
      continue;
    }
    current.intentLines.push(line.trimEnd());
  }

  return items.map(({ intentLines, inCriteria: _, ...item }) => ({
    ...item,
    intent: intentLines.join('\n').trim().replace(/\n{3,}/g, '\n\n'),
  }));
}

/**
 * Erros que dependem do backlog inteiro: id duplicado, dependência para id inexistente e
 * dependência circular. `knownNumbers` são ids que existem fora do arquivo (no banco).
 */
export function validateBacklog(items: ParsedItem[], knownNumbers: Iterable<number> = []): void {
  const firstByNumber = new Map<number, ParsedItem>();
  for (const item of items) {
    if (item.number === undefined) continue;
    const first = firstByNumber.get(item.number);
    if (first) {
      const reason = `id ${item.number} duplicado no backlog`;
      if (!first.errors.includes(reason)) first.errors.push(reason);
      item.errors.push(reason);
    } else {
      firstByNumber.set(item.number, item);
    }
  }

  const existing = new Set([...firstByNumber.keys(), ...knownNumbers]);
  for (const item of items) {
    for (const dep of item.dependsOn) {
      if (!existing.has(dep)) item.errors.push(`depende de #${dep}, que não existe`);
    }
  }

  // Ciclos: busca em profundidade com marcação; cada item entra em no máximo um ciclo relatado.
  const finished = new Set<number>();
  const visit = (number: number, path: number[]) => {
    const index = path.indexOf(number);
    if (index >= 0) {
      const cycle = path.slice(index);
      const reason = `dependência circular: ${[...cycle, number].map((n) => `#${n}`).join(' → ')}`;
      for (const member of cycle) {
        const item = firstByNumber.get(member);
        if (item && !item.errors.some((error) => error.startsWith('dependência circular'))) item.errors.push(reason);
      }
      return;
    }
    const item = firstByNumber.get(number);
    if (!item || finished.has(number)) return;
    for (const dep of item.dependsOn) visit(dep, [...path, number]);
    finished.add(number);
  };
  for (const number of firstByNumber.keys()) visit(number, []);
}

/** Insere `id: <n>` logo abaixo do cabeçalho de cada item, sem tocar em nenhum outro byte. */
export function insertIds(text: string, assignments: { headingEnd: number; number: number }[]): string {
  let result = text;
  for (const { headingEnd, number } of [...assignments].sort((a, b) => b.headingEnd - a.headingEnd)) {
    const atEnd = headingEnd >= result.length && !result.endsWith('\n');
    const line = atEnd ? `\nid: ${number}` : `id: ${number}\n`;
    result = result.slice(0, headingEnd) + line + result.slice(headingEnd);
  }
  return result;
}
