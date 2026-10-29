import type { DatabaseSync } from 'node:sqlite';
import { formatCost } from './format.ts';
import { tryGit } from './git.ts';
import { integratedItems } from './integration.ts';
import { type Item, itemCost } from './items.ts';
import { autonomousDecisions } from './pipeline.ts';
import type { Project } from './project.ts';
import { readSpec } from './specs.ts';
import type { CriterionProof, ProofResult } from './proof.ts';
import { type Entry, entry, lookFirst, returns } from './report.ts';

// Documento de entrega (S.2): o que aconteceu, versionado pela branch de entrega em
// `.mabel/entregas/<data>-<unidade>.md`. O PR leva o mesmo texto no corpo.

export const DELIVERIES_DIR = 'entregas';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const day = (iso: string) => iso.slice(0, 10);
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** Caminho do documento no repositório: `.mabel/entregas/<nome>.md`. */
export function deliveryDocPath(name: string): string {
  return `.mabel/${DELIVERIES_DIR}/${name}.md`;
}

interface Transition {
  from_state: string;
  to_state: string;
  reason: string | null;
  at: string;
}

function transitions(db: DatabaseSync, item: Item): Transition[] {
  return db
    .prepare('SELECT from_state, to_state, reason, at FROM item_transitions WHERE item_id = ? ORDER BY id')
    .all(item.id) as unknown as Transition[];
}

/**
 * Decisões das tarefas: as do avulso (backlog, com as respostas do humano) e as das specs
 * das tarefas de spec, uma vez por spec.
 */
function decisionsOf(project: Project, items: Item[]): string[] {
  const specs = new Set<string>();
  return items.flatMap((item) => {
    if (!item.spec) return item.decisions.map((d) => `#${item.number}: ${d}`);
    if (specs.has(item.spec)) return [];
    specs.add(item.spec);
    return (readSpec(project.root, item.spec)?.decisoes ?? []).map((d) => `${item.spec}: ${d}`);
  });
}

/** `vermelho na base, verde no item` e afins, pelo comportamento declarado no plano. */
function proofText(proof: ProofResult | undefined, found: CriterionProof | undefined, behavior: string | undefined): string {
  if (!found) return 'sem prova';
  if (found.status === 'provado' && proof?.mode === 'item') return 'por item (o comando de teste inteiro)';
  if (found.status === 'provado') return behavior === 'mantido' ? 'verde na base e no item' : 'vermelho na base, verde no item';
  return found.status === 'nao_provado' ? `não provado${found.reason ? `: ${found.reason}` : ''}` : `sem prova${found.reason ? `: ${found.reason}` : ''}`;
}

function criteriaRows({ item, plan, execution, proof }: Entry): string[] {
  return (plan?.criterios ?? []).map((criterion) => {
    const tests = execution?.criterios.find((c) => c.id === criterion.id)?.testes ?? [];
    const where = tests.map((t) => `${t.arquivo} › ${t.nome}`).join(', ') || '—';
    const result =
      criterion.verificacao === 'humano'
        ? 'validação humana'
        : proofText(proof, proof?.criteria.find((c) => c.id === criterion.id), criterion.comportamento);
    return `| #${item.number} | ${cell(`${criterion.id} ${criterion.texto}`)} | ${cell(where)} | ${cell(result)} |`;
  });
}

function deviations(db: DatabaseSync, item: Item): string[] {
  const moves = transitions(db, item);
  const lines: string[] = [];
  // Resposta a pergunta do plano e rejeição (listada à parte) não são replanejamento.
  const replans = moves.filter(
    (t) =>
      t.to_state === 'planning' &&
      (/--replanejar/.test(t.reason ?? '') || !['ready', 'needs_human', 'awaiting_merge'].includes(t.from_state)),
  ).length;
  if (replans > 0) lines.push(`#${item.number} replanejado ${plural(replans, 'vez', 'vezes')}`);
  for (const t of moves.filter((m) => /^humano: rejeitado/.test(m.reason ?? ''))) {
    lines.push(`#${item.number} rejeitado em ${day(t.at)}: ${(t.reason ?? '').replace(/^humano: rejeitado — /, '')}`);
  }
  const returned = returns(db, item.id);
  if (returned !== '—') lines.push(`#${item.number} devolvido ${returned}`);
  return lines;
}

const section = (title: string, lines: string[], empty = 'Nada.') => ['', `## ${title}`, ...(lines.length > 0 ? lines : [empty])];
const bullets = (lines: string[]) => lines.map((line) => `- ${line}`);

export interface DeliveryDocInput {
  /** Nome do documento e da entrega: `<data>-<unidade>`. */
  name: string;
  unit: string;
  /** Snapshot entregue: só as tarefas integradas até ele. */
  snapshot: string;
  date: string;
}

/** Conteúdo do documento de entrega. A primeira linha é o resumo, achado pelo `Grep`. */
export function renderDeliveryDoc(db: DatabaseSync, home: string, project: Project, input: DeliveryDocInput): string {
  const base = project.config.baseBranch;
  const entries = integratedItems(db, project, input.snapshot).map((item) => entry(home, item));
  const items = entries.map((e) => e.item);
  const decisions = decisionsOf(project, items);
  const assumptions = entries.flatMap(({ item, plan, execution }) =>
    [...(plan?.suposicoes ?? []), ...(execution?.suposicoes ?? [])]
      .filter((s) => !s.texto.endsWith('(autônomo)'))
      .map((s) => `#${item.number}: ${s.texto}${s.regraCritica ? ' (regra crítica)' : ''}`),
  );
  const autonomous = items.flatMap((item) => autonomousDecisions(db, { itemId: item.id }).map((d) => `#${d.number}: ${d.decision} (pela sugestão)`));
  const cost = items.reduce((sum, item) => sum + itemCost(db, item.id), 0);
  const main = decisions.slice(0, 2).map((d) => d.replace(/^[^:]+: /, '').replace(/ \([^()]*\d{4}-\d{2}-\d{2}\)$/, '')).join('; ') || '—';
  const baseCommit = tryGit(project.root, 'rev-parse', '--short', base) ?? '?';

  const lines = [
    `Resumo: ${input.unit} · ${input.date} · — · ${main}`,
    '',
    `# Entrega: ${input.unit}`,
    '',
    `Base: ${base} (${baseCommit}) · ${plural(items.length, 'tarefa', 'tarefas')} · ${formatCost(cost)}`,
    ...section('Olhe primeiro', bullets(entries.flatMap(lookFirst)), 'Nada: todos os critérios provados.'),
    ...section('Decisões', bullets(decisions)),
    ...section('Suposições do agente', bullets([...assumptions, ...autonomous])),
    ...section('Critérios e prova', [
      '| Tarefa | Critério | Teste | Prova |',
      '|---|---|---|---|',
      ...entries.flatMap(criteriaRows),
    ]),
    ...section('Desvios', bullets(items.flatMap((item) => deviations(db, item)))),
    ...section(
      'Tarefas',
      bullets(items.map((item) => `#${item.number} ${item.title} · merge ${(item.integratedCommit ?? '').slice(0, 7)} · ${formatCost(itemCost(db, item.id))}`)),
    ),
  ];
  return `${lines.join('\n')}\n`;
}
