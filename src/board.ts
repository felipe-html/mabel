import { writeFileSync } from 'node:fs';
import { type BalanceReading, balanceOf } from './balance.ts';
import { formatCost } from './format.ts';
import { mabelPath } from './project.ts';

/** O que o quadro precisa saber de cada item, já na ordem do backlog. */
export interface BoardItem {
  number: number;
  title: string;
  status: string;
  statusReason: string | null;
  attempts: number;
  branch: string | null;
  costUsd: number;
  /** Dependências que ainda não estão `done`. */
  pendingDeps: number[];
}

export const BOARD_SECTIONS = [
  { title: 'Aguardando você', states: ['needs_human', 'awaiting_merge'] },
  { title: 'Em andamento', states: ['planning', 'executing', 'verifying', 'reviewing'] },
  { title: 'Na fila', states: ['ready', 'backlog'] },
  { title: 'Bloqueados e falhos', states: ['blocked', 'failed'] },
  { title: 'Concluídos', states: ['done'] },
] as const;

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function balanceSummary(readings: BalanceReading[]): string {
  const find = (window: string) => readings.find((reading) => reading.window === window);
  const fiveHour = find('five_hour');
  const sevenDay = find('seven_day');
  if (!fiveHour && !sevenDay) return 'saldo desconhecido';
  const percent = (reading: BalanceReading | undefined) =>
    reading ? `${Math.round(balanceOf(reading) * 100)}%` : '?';
  return `saldo 5h ${percent(fiveHour)} · 7d ${percent(sevenDay)}`;
}

function itemLine(item: BoardItem): string {
  const head = `- #${item.number} ${item.title} — `;
  const cost = item.costUsd > 0 ? ` · ${formatCost(item.costUsd)}` : '';
  switch (item.status) {
    case 'needs_human':
      return `${head}**needs_human**: ${item.statusReason ?? 'aguardando decisão'}`;
    case 'awaiting_merge':
      return `${head}**awaiting_merge**${item.branch ? ` · branch \`${item.branch}\`` : ''}`;
    case 'blocked':
    case 'failed':
      return `${head}${item.status}${item.statusReason ? `: ${item.statusReason}` : ''}`;
    case 'ready':
    case 'backlog': {
      const deps = item.pendingDeps.length > 0 ? ` · depende de ${item.pendingDeps.map((n) => `#${n}`).join(', ')}` : '';
      return `${head}${item.status}${deps}`;
    }
    case 'done':
      return `${head}done${cost}`;
    default: {
      const attempt = item.attempts > 0 ? ` · tentativa ${item.attempts}` : '';
      return `${head}${item.status}${attempt}${cost}`;
    }
  }
}

/** Conteúdo do `quadro.md`. Seções vazias são omitidas; itens `cancelled` não aparecem. */
export function renderBoard(projectName: string, items: BoardItem[], readings: BalanceReading[], now: Date): string {
  const updated = `${two(now.getDate())}/${two(now.getMonth() + 1)} ${two(now.getHours())}:${two(now.getMinutes())}`;
  const lines = [
    '<!-- Gerado pelo Mabel. Edições aqui são descartadas. -->',
    `# Quadro · ${projectName}`,
    `Atualizado ${updated} · ${balanceSummary(readings)}`,
  ];
  for (const section of BOARD_SECTIONS) {
    const states: readonly string[] = section.states;
    const inSection = items.filter((item) => states.includes(item.status));
    if (inSection.length === 0) continue;
    lines.push('', `## ${section.title}`, ...inSection.map(itemLine));
  }
  if (items.every((item) => item.status === 'cancelled')) lines.push('', 'Backlog vazio.');
  return `${lines.join('\n')}\n`;
}

/** Resumo do quadro para o `mabel status`: contagem por seção e os itens que pedem atenção. */
export function renderBoardSummary(projectName: string, items: BoardItem[]): string[] {
  const counts: string[] = [];
  const detail: string[] = [];
  for (const section of BOARD_SECTIONS) {
    const states: readonly string[] = section.states;
    const inSection = items.filter((item) => states.includes(item.status));
    if (inSection.length === 0) continue;
    counts.push(`${section.title.toLowerCase()} ${inSection.length}`);
    if (section.title === 'Aguardando você' || section.title === 'Em andamento') {
      detail.push('', section.title, ...inSection.map(itemLine));
    }
  }
  return [`Projeto ${projectName} · ${counts.length > 0 ? counts.join(' · ') : 'backlog vazio'}`, ...detail];
}

export function writeBoardFile(root: string, content: string): void {
  writeFileSync(mabelPath(root, 'quadro.md'), content);
}
