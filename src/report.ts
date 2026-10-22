import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { formatCost } from './format.ts';
import { tryGit } from './git.ts';
import { openDelivery } from './delivery.ts';
import { integratedItems } from './integration.ts';
import { type Item, itemCost } from './items.ts';
import { MABEL_DIR, type Project, mabelPath } from './project.ts';
import { type ProofResult, proofLabel } from './proof.ts';
import type { ExecuteOutput, PlanOutput } from './schemas/stages.ts';
import { readArtifact } from './stages.ts';

// Relatório da integração (P.5): decidível sem abrir o código.

export const REPORT_FILE = 'integracao.md';

const two = (n: number) => String(n).padStart(2, '0');

function when(iso: string): string {
  const date = new Date(iso);
  return `${two(date.getDate())}/${two(date.getMonth() + 1)} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** `4 alterados, +120 −8`, pelo `--shortstat` do merge contra o primeiro pai. */
function filesChanged(root: string, commit: string): string {
  const stat = tryGit(root, 'diff', '--shortstat', `${commit}^1`, commit) ?? '';
  const number = (pattern: RegExp) => Number(pattern.exec(stat)?.[1] ?? 0);
  return `${number(/(\d+) files? changed/)} alterados, +${number(/(\d+) insertions?/)} −${number(/(\d+) deletions?/)}`;
}

/** Tentativas devolvidas, por quem devolveu. */
function returns(db: DatabaseSync, itemId: string): string {
  const rows = db
    .prepare('SELECT gate, count(DISTINCT attempt) AS n FROM gate_results WHERE item_id = ? AND attempt > 0 AND passed = 0 GROUP BY gate')
    .all(itemId) as { gate: string; n: number }[];
  const by = { prova: 0, verificação: 0, revisão: 0 };
  for (const { gate, n } of rows) {
    if (gate === 'proof') by.prova += n;
    else if (gate === 'review') by.revisão += n;
    else if (gate !== 'integration' && gate !== 'autonomy') by.verificação += n;
  }
  const parts = Object.entries(by)
    .filter(([, n]) => n > 0)
    .map(([who, n]) => `${n} pela ${who}`);
  return parts.length > 0 ? parts.join(', ') : '—';
}

interface Entry {
  item: Item;
  plan?: PlanOutput;
  execution?: ExecuteOutput;
  proof?: ProofResult;
}

function entry(home: string, item: Item): Entry {
  return {
    item,
    plan: readArtifact<PlanOutput>(home, item.id, 'plano.json'),
    execution: readArtifact<ExecuteOutput>(home, item.id, `execucao-${item.attemptNo}.json`),
    proof: readArtifact<ProofResult>(home, item.id, `prova-${item.attemptNo}.json`),
  };
}

/** Situação da prova do item: `provado`, `provado (por item)`, `parcialmente provado`, `sem prova`. */
function proofStatus(proof: ProofResult | undefined): string {
  if (!proof || proof.criteria.length === 0) return 'sem prova automática';
  const proven = proof.criteria.filter((c) => c.status === 'provado').length;
  if (proven === 0) return 'sem prova';
  if (proven < proof.criteria.length) return 'parcialmente provado';
  return proof.mode === 'item' ? 'provado (por item)' : 'provado';
}

function lookFirst({ item, plan, execution, proof }: Entry): string[] {
  const head = `#${item.number} ${item.title}`;
  const lines: string[] = [];
  for (const criterion of proof?.criteria ?? []) {
    if (criterion.status === 'sem_prova') lines.push(`${head}: ${criterion.id} sem prova (${criterion.reason})`);
  }
  if (proof?.mode === 'item' && proof.criteria.some((c) => c.status === 'provado')) {
    lines.push(`${head}: prova por item, mais fraca (o comando de teste inteiro, não cada teste)`);
  }
  if (item.approvedAt) lines.push(`${head}: tocou regra crítica (aprovada por você em ${when(item.approvedAt)})`);
  const assumptions = [...(plan?.suposicoes ?? []), ...(execution?.suposicoes ?? [])];
  const autonomous = assumptions.filter((s) => s.texto.endsWith('(autônomo)')).length;
  const others = assumptions.length - autonomous;
  if (autonomous > 0) lines.push(`${head}: ${plural(autonomous, 'decisão autônoma', 'decisões autônomas')}`);
  if (others > 0) lines.push(`${head}: ${plural(others, 'suposição', 'suposições')}`);
  for (const criterion of plan?.criterios.filter((c) => c.verificacao === 'humano') ?? []) {
    lines.push(`${head}: valide ${criterion.id} — ${criterion.texto}`);
  }
  return lines;
}

function itemSection(db: DatabaseSync, project: Project, { item, plan, execution, proof }: Entry): string[] {
  const attempts = plural(Math.max(item.attemptNo, 1), 'tentativa', 'tentativas');
  const lines = [`## #${item.number} ${item.title} · ${proofStatus(proof)} · ${attempts} · ${formatCost(itemCost(db, item.id))}`];
  lines.push('Critérios');
  for (const criterion of plan?.criterios ?? []) {
    const kind = criterion.verificacao === 'humano' ? 'humano' : (criterion.comportamento ?? '—');
    const tests = execution?.criterios.find((c) => c.id === criterion.id)?.testes ?? [];
    const where = tests.map((t) => `${t.arquivo} › ${t.nome}`).join(', ');
    const found = proof?.criteria.find((c) => c.id === criterion.id);
    const result = criterion.verificacao === 'humano' ? 'validação humana' : found ? proofLabel(found, proof!.mode) : 'sem prova';
    lines.push(`  ${criterion.id} ${kind.padEnd(8)} ${criterion.texto}${where ? ` · ${where}` : ''} · ${result}`);
  }
  const human = plan?.criterios.filter((c) => c.verificacao === 'humano').map((c) => `${c.id} ${c.texto}`) ?? [];
  const assumptions = [...(plan?.suposicoes ?? []), ...(execution?.suposicoes ?? [])].map((s) => s.texto);
  lines.push(`Validação humana: ${human.join('; ') || '—'}`);
  lines.push(`Suposições: ${assumptions.join('; ') || '—'}`);
  lines.push(`Devoluções: ${returns(db, item.id)}`);
  if (item.integratedCommit) lines.push(`Arquivos: ${filesChanged(project.root, item.integratedCommit)}`);
  return lines;
}

export interface ReportOptions {
  /** Entrega (`mabel entregar`): o relatório vira o corpo do PR, só com os itens até o commit dela. */
  delivery?: { branch: string; commit: string };
  /** Limite de caracteres: as seções dos itens são cortadas do fim para o começo. */
  maxChars?: number;
}

/** Linhas do "Olhe primeiro" dos itens integrados (até `upTo`, se dado). */
export function lookFirstLines(db: DatabaseSync, home: string, project: Project, upTo?: string): string[] {
  return integratedItems(db, project, upTo).flatMap((item) => lookFirst(entry(home, item)));
}

/** Conteúdo do `.mabel/integracao.md` ou, com `delivery`, do corpo do PR da entrega. */
export function renderIntegrationReport(db: DatabaseSync, home: string, project: Project, options: ReportOptions = {}): string {
  const integration = project.config.integracao;
  const base = project.config.baseBranch;
  if (!integration) return '# Integração desligada\n\nCom `integracao: null` no config, cada item fica na própria branch.\n';
  const { delivery, maxChars } = options;
  const entries = integratedItems(db, project, delivery?.commit).map((item) => entry(home, item));
  const lines = delivery
    ? [`# Entrega · ${delivery.branch} · ${plural(entries.length, 'item', 'itens')} desde a ${base}`]
    : ['<!-- Gerado pelo Mabel. Edições aqui são descartadas. -->', `# Integração · ${integration} · ${plural(entries.length, 'item', 'itens')} desde a ${base}`];
  if (entries.length === 0) return `${[...lines, '', `Nada a levar para a ${base}.`].join('\n')}\n`;
  if (delivery) {
    lines.push('', 'Faça o merge com "Create a merge commit": squash e rebase impedem o Mabel de dar os itens como concluídos.');
  } else {
    lines.push('', `Para levar à ${base}: git merge --no-ff ${integration}`, 'ou: mabel entregar');
    const open = openDelivery(db, project.id);
    if (open) lines.push(`Entrega aberta: ${open.branch} · ${open.prUrl ?? 'sem PR'}`);
  }
  lines.push(`Para devolver um item: mabel rejeitar <n> "<motivo>"`);
  const first = entries.flatMap(lookFirst);
  lines.push('', '## Olhe primeiro', ...(first.length > 0 ? first.map((line) => `- ${line}`) : ['Nada: todos os critérios provados.']));
  const sections = entries.map((e) => ['', ...itemSection(db, project, e)].join('\n'));
  const head = lines.join('\n');
  let kept = sections.length;
  const cut = (n: number) => (n < sections.length ? `\n\n… ${plural(sections.length - n, 'item', 'itens')} sem detalhe aqui; rode mabel integracao.` : '');
  const size = (n: number) => head.length + sections.slice(0, n).reduce((sum, section) => sum + section.length + 1, 0) + cut(n).length;
  while (maxChars !== undefined && kept > 0 && size(kept) > maxChars) kept--;
  return `${head}${sections.slice(0, kept).map((section) => `\n${section}`).join('')}${cut(kept)}\n`;
}

/**
 * Projeto iniciado antes do relatório: o `.mabel/.gitignore` não o lista. Ignora pelo
 * `info/exclude` do repositório, que não é versionado.
 */
function ensureIgnored(root: string): void {
  const file = `${MABEL_DIR}/${REPORT_FILE}`;
  if (tryGit(root, 'check-ignore', '-q', file) !== undefined) return;
  const common = tryGit(root, 'rev-parse', '--git-common-dir');
  if (!common) return;
  const exclude = resolve(root, common, 'info', 'exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/${file}\n`);
}

/** Regenera o `.mabel/integracao.md`. Sem integração, não grava nada. */
export function writeIntegrationReport(db: DatabaseSync, home: string, project: Project): string {
  const content = renderIntegrationReport(db, home, project);
  if (project.config.integracao) {
    ensureIgnored(project.root);
    writeFileSync(mabelPath(project.root, REPORT_FILE), content);
  }
  return content;
}
