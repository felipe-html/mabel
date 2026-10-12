import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { ask, confirm } from './ask.ts';
import { dataDir, openDb } from './db.ts';
import { DecisionError, approve, cancel, respond } from './decisions.ts';
import { formatCost } from './format.ts';
import { type Item, type PendingKind, TransitionError, getItem, itemCost } from './items.ts';
import { attemptsSummary, autonomousDecisions } from './pipeline.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import type { PlanOutput } from './schemas/stages.ts';
import { itemDir, readArtifact } from './stages.ts';
import { type RecentRun, renderRecentRuns } from './status.ts';
import { style } from './style.ts';

function parseNumber(value: string | undefined): number | undefined {
  const number = Number((value ?? '').replace(/^#/, ''));
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** Abre o banco, resolve o projeto e o item `<n>`; trata os erros comuns com mensagem. */
async function withItem(
  value: string | undefined,
  usage: string,
  action: (db: DatabaseSync, project: Project, item: Item) => number | Promise<number>,
): Promise<number> {
  const number = parseNumber(value);
  if (number === undefined) {
    process.stderr.write(`Informe o número do item.\nUso: ${usage}\n`);
    return 1;
  }
  const db = openDb(dataDir());
  try {
    const project = resolveProject(db);
    const item = getItem(db, project.id, number);
    if (!item) {
      process.stderr.write(`Item #${number} não existe.\n`);
      return 1;
    }
    return await action(db, project, item);
  } catch (error) {
    if (error instanceof ProjectError || error instanceof DecisionError || error instanceof TransitionError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}

const SUGGESTIONS: Record<PendingKind, (n: number) => string[]> = {
  question_plan: (n) => [`mabel responder ${n} "<resposta>"`],
  plan_incomplete: (n) => [`mabel responder ${n} "<orientação para o plano>"`],
  critical_approval: (n) => [`mabel aprovar ${n}`, `mabel responder ${n} "<ajuste dos critérios>"`],
  question_execute: (n) => [`mabel responder ${n} "<resposta>"`, `mabel responder ${n} "<orientação>" --replanejar`],
  attempts_exhausted: (n) => [
    `mabel responder ${n} "<orientação>"   (novo ciclo com modelo escalonado)`,
    `mabel responder ${n} "<orientação>" --replanejar`,
    `mabel cancelar ${n}`,
  ],
};

/** Detalhe do item: estado, pendência, plano, custo, runs e transições recentes. */
export function renderItemDetail(db: DatabaseSync, home: string, item: Item): string[] {
  const lines = [style.bold(`#${item.number} ${item.title} — ${item.status}`)];
  if (item.statusReason) lines.push(`Motivo: ${item.statusReason}`);

  if (item.status === 'needs_human' && item.pendingKind) {
    const pending = item.pending ?? {};
    lines.push('', style.bold(`Aguardando você (${item.pendingKind})`));
    for (const question of pending.questions ?? []) {
      lines.push(`  ? ${question.texto}`);
      if (question.sugestao) lines.push(`    sugestão: ${question.sugestao}`);
    }
    for (const assumption of pending.criticalAssumptions ?? []) lines.push(`  ! suposição crítica: ${assumption}`);
    if (pending.reason) lines.push(`  ${pending.reason}`);
    if (item.pendingKind === 'attempts_exhausted') {
      lines.push(...(pending.summary || attemptsSummary(db, item.id)).split('\n').map((line) => `  ${line}`));
    }
    lines.push('', 'Comandos:', '  mabel inbox   (responde tudo, uma pergunta por vez)');
    lines.push(...SUGGESTIONS[item.pendingKind](item.number).map((command) => `  ${command}`));
  }

  lines.push('', style.bold('Item'));
  lines.push(`  intenção: ${item.intent.replace(/\n+/g, ' ')}`);
  if (item.restrictions) lines.push(`  restrições: ${item.restrictions}`);
  if (item.branch) lines.push(`  branch: ${item.branch}`);
  if (item.worktree) lines.push(`  worktree: ${item.worktree}`);
  lines.push(`  tentativas no ciclo: ${item.attempts} · custo ${formatCost(itemCost(db, item.id))}`);

  const plan = readArtifact<PlanOutput>(home, item.id, 'plano.json');
  if (plan) {
    lines.push('', style.bold('Critérios do plano'));
    for (const criterion of plan.criterios) lines.push(`  ${criterion.id} (${criterion.verificacao}): ${criterion.texto}`);
    lines.push(`  escopo: ${plan.escopo.join(', ')}`);
    const planPath = join(itemDir(home, item.id), 'plano.md');
    if (existsSync(planPath)) lines.push(`  plano: ${planPath}`);
  } else if (item.criteria.length > 0) {
    lines.push('', style.bold('Critérios do backlog'), ...item.criteria.map((criterion) => `  - ${criterion}`));
  }

  const autonomous = autonomousDecisions(db, { itemId: item.id });
  if (autonomous.length > 0) {
    lines.push('', style.bold('Decididas pela sugestão'), ...autonomous.map(({ decision }) => `  ${decision}`));
  }

  const runs = db
    .prepare(
      `SELECT id, coalesce(stage, kind) AS kind, status, model, model_requested, started_at, cost_usd, prompt
       FROM runs WHERE item_id = ? ORDER BY started_at DESC LIMIT 10`,
    )
    .all(item.id) as unknown as RecentRun[];
  if (runs.length > 0) lines.push('', style.bold('Runs'), ...renderRecentRuns(runs));

  const transitions = db
    .prepare('SELECT from_state, to_state, reason, at FROM item_transitions WHERE item_id = ? ORDER BY id DESC LIMIT 8')
    .all(item.id) as { from_state: string; to_state: string; reason: string | null; at: string }[];
  if (transitions.length > 0) {
    lines.push('', style.bold('Transições recentes'));
    for (const t of transitions.reverse()) {
      const reason = t.reason ? ` · ${t.reason.replace(/\s+/g, ' ').slice(0, 100)}` : '';
      lines.push(`  ${t.from_state} → ${t.to_state}${reason}`);
    }
  }
  return lines;
}

export const itemUsage = 'mabel item <n>';
export const approveUsage = 'mabel aprovar <n>';
export const respondUsage = 'mabel responder <n> "<resposta>" [--replanejar]';
export const cancelUsage = 'mabel cancelar <n>';

export function itemCommand(args: string[]): Promise<number> {
  return withItem(args[0], itemUsage, (db, _project, item) => {
    process.stdout.write(`${renderItemDetail(db, dataDir(), item).join('\n')}\n`);
    return 0;
  });
}

export function approveCommand(args: string[]): Promise<number> {
  return withItem(args[0], approveUsage, (db, project, item) => {
    approve(db, project, item);
    process.stdout.write(`#${item.number} aprovado: segue para a execução no próximo \`mabel run\`.\n`);
    return 0;
  });
}

export function respondCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { replanejar: { type: 'boolean' } } });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${respondUsage}\n`);
    return Promise.resolve(1);
  }
  const [number, ...rest] = parsed.positionals;
  const answer = rest.join(' ').trim();
  return withItem(number, respondUsage, (db, project, item) => {
    if (!answer) {
      process.stderr.write(`Informe a resposta.\nUso: ${respondUsage}\n`);
      return 1;
    }
    const to = respond(db, project, item, answer, { replan: parsed.values.replanejar });
    process.stdout.write(`#${item.number} → ${to}: retomado no próximo \`mabel run\`.\n`);
    return 0;
  });
}

export function cancelCommand(args: string[]): Promise<number> {
  return withItem(args[0], cancelUsage, (db, project, item) => {
    cancel(db, project, item);
    process.stdout.write(`#${item.number} cancelado.\n`);
    return 0;
  });
}

// Argumentos pedidos no menu interativo ----------------------------------------------------

export async function askItemNumber(): Promise<string[]> {
  const number = await ask('Número do item: ');
  return number ? [number] : [];
}

export async function askRespond(): Promise<string[]> {
  const number = await ask('Número do item: ');
  const answer = await ask('Resposta: ');
  const replan = await confirm('Replanejar?', false);
  return [number, answer, ...(replan ? ['--replanejar'] : [])];
}

export async function askCancel(): Promise<string[]> {
  const number = await ask('Número do item a cancelar: ');
  return number && (await confirm(`Cancelar o item #${number}?`, false)) ? [number] : [];
}
