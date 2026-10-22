/** Formato do `.mabel/backlog.md`: geração de blocos de item. */

export interface ItemFields {
  number?: number;
  title: string;
  intent: string;
  criteria: string[];
  dependsOn: number[];
  restrictions: string | null;
  /** O que o item não faz. */
  outOfScope: string[];
  /** Regras de negócio já decididas (as respostas do refinamento entram aqui). */
  decisions: string[];
  /** Conceitos de `regras-criticas.md` que o item toca, declarados no backlog. */
  criticalConcepts: string[];
  /** Telas, operações de API e arquivos de `.mabel/referencias/` (`docs/specs/referencias.md`). */
  references?: string[];
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
- Fora do escopo: lista "- ..." com o que o item não faz.
- Decisões: lista "- ..." com as regras de negócio já decididas.
- Regras críticas: lista "- ..." com os conceitos de regras-criticas.md que o item toca.
  Item com regras críticas só fica pronto com critérios.
- Referências: lista "- ..." com o que o item usa de .mabel/referencias/:
  "tela: <nome>", "api: <nome> <MÉTODO> <caminho>" (ou "api: <nome> <operationId>")
  ou um caminho de arquivo. Item com referência que não existe fica no backlog.
- Depende de: <n>, <n> — itens que precisam estar concluídos antes.
- Restrições: <texto> — limites para a implementação, numa linha.

Quanto detalhe: escreva o que só você sabe e o que, se o agente errasse, faria você
reclamar. O resto o agente tira do código ou decide e registra como suposição.
- Ajuste pequeno, sem regra de negócio: título e intenção bastam.
- Item com regra de negócio: intenção, critérios, decisões e fora do escopo.
mabel refinar <n> pede a um agente uma proposta desses campos para você revisar.

Exemplo:

## Exportar pedidos em CSV
Quero baixar a lista de pedidos para abrir no Excel.

Critérios:
- Uma linha por pedido, com data, cliente e valor
- Valores com vírgula decimal

Fora do escopo:
- Exportar itens do pedido

Decisões:
- Pedidos cancelados entram? → Não

Depende de: 2
Restrições: não adicionar bibliotecas novas
-->
`;

/** Bloco Markdown de um item, no formato que o parser lê de volta. */
export function renderItemBlock(item: ItemFields): string {
  const lines = [`## ${item.title}`];
  if (item.number !== undefined) lines.push(`id: ${item.number}`);
  lines.push(item.intent.trim());
  const list = (label: string, entries: string[]) => {
    if (entries.length > 0) lines.push('', `${label}:`, ...entries.map((entry) => `- ${entry}`));
  };
  list('Critérios', item.criteria);
  list('Fora do escopo', item.outOfScope);
  list('Decisões', item.decisions);
  list('Regras críticas', item.criticalConcepts);
  list('Referências', item.references ?? []);
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
  references: string[];
  /** Ordem no arquivo, a partir de 0. */
  position: number;
  /** Erros de formato; item com erro fica `blocked`. */
  errors: string[];
  /** Linha `id:` presente mas com valor que não é um inteiro positivo. */
  invalidId?: string;
  /** Posição no texto logo depois da linha do cabeçalho (onde a linha `id:` é inserida). */
  headingEnd: number;
  /** Início da linha do cabeçalho. */
  start: number;
  /** Fim da última linha com conteúdo do item; linhas vazias e comentários depois dela ficam de fora. */
  contentEnd: number;
}

/** Troca comentários HTML por espaços, preservando quebras de linha e posições. */
function maskComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

const ID_LINE = /^id:\s*(.*?)\s*$/i;
const CRITERIA_LINE = /^crit[ée]rios:\s*$/i;
const OUT_OF_SCOPE_LINE = /^fora do escopo:\s*(.*?)\s*$/i;
const DECISIONS_LINE = /^decis[õo]es:\s*(.*?)\s*$/i;
const CRITICAL_LINE = /^regras? cr[íi]ticas?:\s*(.*?)\s*$/i;
const REFERENCES_LINE = /^refer[êe]ncias:\s*(.*?)\s*$/i;
const DEPENDS_LINE = /^depende de:\s*(.*?)\s*$/i;
const RESTRICTIONS_LINE = /^restri[çc][õo]es:\s*(.*?)\s*$/i;
const LIST_ITEM = /^\s*[-*]\s+(.+?)\s*$/;

type ListField = 'criteria' | 'outOfScope' | 'decisions' | 'criticalConcepts' | 'references';

/** Campos em lista: rótulo numa linha e itens `- …` abaixo (ou o valor na mesma linha). */
const LIST_LINES: [RegExp, ListField][] = [
  [OUT_OF_SCOPE_LINE, 'outOfScope'],
  [DECISIONS_LINE, 'decisions'],
  [CRITICAL_LINE, 'criticalConcepts'],
  [REFERENCES_LINE, 'references'],
];

/** Lê o `backlog.md`. Erros de formato ficam no item, nunca lançam. */
export function parseBacklog(text: string): ParsedItem[] {
  const masked = maskComments(text);
  type Draft = ParsedItem & { intentLines: string[]; inList: ListField | null };
  const items: Draft[] = [];
  let current: Draft | undefined;
  let offset = 0;

  for (const rawLine of masked.split('\n')) {
    const lineStart = offset;
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
        outOfScope: [],
        decisions: [],
        criticalConcepts: [],
        references: [],
        position: items.length,
        errors: [],
        headingEnd: Math.min(lineEnd + 1, text.length),
        start: lineStart,
        contentEnd: lineEnd,
        intentLines: [],
        inList: null,
      };
      if (!current.title) current.errors.push('item sem título');
      items.push(current);
      continue;
    }
    if (!current) continue;
    if (line.trim()) current.contentEnd = lineEnd;

    if (current.inList) {
      const item = LIST_ITEM.exec(line);
      if (item?.[1]) {
        current[current.inList].push(item[1]);
        continue;
      }
      if (!line.trim()) continue;
      current.inList = null;
    }

    const id = ID_LINE.exec(line);
    if (id && current.number === undefined && current.invalidId === undefined) {
      if (/^[1-9]\d*$/.test(id[1] ?? '')) current.number = Number(id[1]);
      else current.invalidId = id[1] ?? '';
      continue;
    }
    if (CRITERIA_LINE.test(line)) {
      current.inList = 'criteria';
      continue;
    }
    const listLine = LIST_LINES.find(([pattern]) => pattern.test(line));
    if (listLine) {
      const [pattern, field] = listLine;
      const inline = pattern.exec(line)?.[1];
      if (inline) current[field].push(inline);
      current.inList = field;
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

  return items.map(({ intentLines, inList: _, ...item }) => ({
    ...item,
    intent: intentLines.join('\n').trim().replace(/\n{3,}/g, '\n\n'),
  }));
}

/**
 * Troca o conteúdo de um item pelo bloco dado, do cabeçalho até a última linha com conteúdo.
 * Linhas vazias e comentários depois do item ficam como estão.
 */
export function replaceItemBlock(text: string, item: Pick<ParsedItem, 'start' | 'contentEnd'>, block: string): string {
  return text.slice(0, item.start) + block.replace(/\n+$/, '') + text.slice(item.contentEnd);
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
