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
