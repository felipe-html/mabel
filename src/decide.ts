import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { dataDir, openDb } from './db.ts';
import { openDeliveries, unitArg } from './delivery.ts';
import { DecisionError, approve, cancel, reject, respond } from './decisions.ts';
import { fail } from './errors.ts';
import { formatCost } from './format.ts';
import { fillForm, itemOptions } from './guided.ts';
import { answersFromJson } from './inbox.ts';
import { writeJson } from './json.ts';
import { type Item, type PendingKind, TRANSITIONS, TransitionError, getItem, itemCost, listItems } from './items.ts';
import { LockError, acquireLock } from './lock.ts';
import { autonomousDecisions, humanAttemptsSummary } from './pipeline.ts';
import { unitSections, writeRunReport } from './runreport.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import type { PlanOutput, Question } from './schemas/stages.ts';
import { type FormConfig, type FormField, type FormValues, shellLine } from './screens.ts';
import { itemDir, readArtifact } from './stages.ts';
import { signals, signalsLine, situation } from './refine.ts';
import { type RecentRun, renderRecentRuns } from './status.ts';
import { style } from './style.ts';
import { inSpec, unitBranch } from './worktree.ts';
import { type ArgSpec, type OptionSpecs, itemArg, jsonOption } from './options.ts';

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
  if (number === undefined) return fail('argumento_faltando', 'Informe o número do item.', usage);
  const db = openDb(dataDir());
  try {
    const project = resolveProject(db);
    const item = getItem(db, project.id, number);
    if (!item) return fail('nao_encontrado', `Item #${number} não existe.`);
    return await action(db, project, item);
  } catch (error) {
    if (error instanceof ProjectError) return fail(error.code, error.message);
    if (error instanceof DecisionError || error instanceof TransitionError || error instanceof LockError) {
      return fail('estado_invalido', error.message);
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
  environment_block: (n) => [
    `mabel responder ${n} "<o que mudou no ambiente>"   (a execução retoma e verifica de novo)`,
    `mabel cancelar ${n}`,
  ],
  integration_conflict: (n) => [
    `mabel responder ${n} "<orientação>"   (o executor resolve os conflitos)`,
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
    if (pending.files?.length) lines.push(`  arquivos em conflito: ${pending.files.join(', ')}`);
    if (pending.reason) lines.push(`  ${pending.reason}`);
    if (item.pendingKind === 'attempts_exhausted') {
      lines.push(...humanAttemptsSummary(db, home, item).map((line) => (line ? `  ${line}` : '')));
    }
    lines.push('', 'Comandos:', '  mabel inbox   (responde tudo, uma pergunta por vez)');
    lines.push(...SUGGESTIONS[item.pendingKind](item.number).map((command) => `  ${command}`));
  }

  lines.push('', style.bold('Item'));
  lines.push(`  intenção: ${item.intent.replace(/\n+/g, ' ')}`);
  if (item.restrictions) lines.push(`  restrições: ${item.restrictions}`);
  if (item.outOfScope.length > 0) lines.push(`  fora do escopo: ${item.outOfScope.join('; ')}`);
  if (item.decisions.length > 0) lines.push(`  decisões: ${item.decisions.join('; ')}`);
  if (item.criticalConcepts.length > 0) lines.push(`  regras críticas: ${item.criticalConcepts.join('; ')}`);
  if (item.references.length > 0) lines.push(`  referências: ${item.references.join('; ')}`);
  if (item.branch) lines.push(`  branch: ${item.branch}`);
  if (item.integratedCommit) lines.push(`  integrado em: ${item.integratedCommit.slice(0, 12)}`);
  if (item.worktree) lines.push(`  worktree: ${item.worktree}`);
  lines.push(`  tentativas no ciclo: ${item.attempts} · custo ${formatCost(itemCost(db, item.id))}`);
  lines.push(`  refinamento: ${signalsLine(signals(db, item.id), situation(db, item))}`);

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
  lines.push(...renderDenials(db, item.id));

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

/** Ações negadas em cada run do item: as do hook de escopo, com caminho e motivo, e o total. */
export function renderDenials(db: DatabaseSync, itemId: string): string[] {
  const runs = db
    .prepare(
      `SELECT id, coalesce(stage, kind) AS kind, denials FROM runs
       WHERE item_id = ? AND (coalesce(denials, 0) > 0 OR EXISTS (
         SELECT 1 FROM events e WHERE e.run_id = runs.id AND e.type = 'hook' AND e.subtype = 'deny'))
       ORDER BY started_at, rowid`,
    )
    .all(itemId) as { id: string; kind: string; denials: number | null }[];
  if (runs.length === 0) return [];
  const lines = ['', style.bold('Negações')];
  const events = db.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'hook' AND subtype = 'deny' ORDER BY seq");
  for (const run of runs) {
    const denied = (events.all(run.id) as { payload: string }[]).map((row) => {
      try {
        return JSON.parse(row.payload) as { tool?: string; path?: string; reason?: string };
      } catch {
        return {};
      }
    });
    const total = run.denials ?? denied.length;
    lines.push(`  ${run.kind} · run ${run.id.slice(0, 4)}: ${total === 1 ? '1 negação' : `${total} negações`}`);
    for (const entry of denied) lines.push(`    ${entry.tool ?? '?'} ${entry.path ?? ''} — ${entry.reason ?? ''}`);
  }
  return lines;
}

export const itemUsage = 'mabel item <n>';

export const approveOptions = { json: jsonOption } satisfies OptionSpecs;
export const respondOptions = {
  replanejar: { type: 'boolean', description: 'Descarta o ciclo atual e volta ao planejamento com o plano anterior como referência' },
  respostas: { type: 'string', value: '<arquivo.json>', values: 'arquivo', description: 'Uma resposta por pergunta, em vez de um texto só' },
  json: jsonOption,
} satisfies OptionSpecs;
export const rejectOptions = {
  cancelar: { type: 'boolean', description: 'Cancela o item em vez de devolvê-lo ao planejamento' },
} satisfies OptionSpecs;

export const respondArgs: ArgSpec[] = [itemArg, { name: '"<resposta>"', description: 'A resposta, quando há uma pergunta só' }];
export const rejectArgs: ArgSpec[] = [itemArg, { name: '"<motivo>"', description: 'Por que o item volta; o planejamento o recebe' }];
export const approveUsage = 'mabel aprovar <n> [--json]';
export const respondUsage = 'mabel responder <n> "<resposta>" [--replanejar] [--json]\n       mabel responder <n> --respostas <arquivo.json> [--replanejar] [--json]';
export const cancelUsage = 'mabel cancelar <n>';
export const rejectUsage = 'mabel rejeitar <n> "<motivo>" [--cancelar]';
export const integrationUsage = 'mabel integracao';

export function itemCommand(args: string[]): Promise<number> {
  return withItem(args[0], itemUsage, (db, _project, item) => {
    process.stdout.write(`${renderItemDetail(db, dataDir(), item).join('\n')}\n`);
    return 0;
  });
}

/** Estado do item depois de uma decisão, na saída `--json` de `aprovar` e `responder`. */
function decisionJson(db: DatabaseSync, project: Project, item: Item): void {
  const after = getItem(db, project.id, item.number) as Item;
  writeJson({ item: { numero: after.number, titulo: after.title, estado: after.status } });
}

export function approveCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: approveOptions });
  } catch (error) {
    return Promise.resolve(fail('argumento_invalido', (error as Error).message, approveUsage));
  }
  return withItem(parsed.positionals[0], approveUsage, (db, project, item) => {
    approve(db, project, item);
    if (parsed.values.json) decisionJson(db, project, item);
    else process.stdout.write(`#${item.number} aprovado: segue para a execução no próximo \`mabel run\`.\n`);
    return 0;
  });
}

/** Conteúdo de `--respostas`: JSON lido do arquivo, ou o erro em texto. */
function readAnswersFile(path: string): { value: unknown } | { error: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { error: `Não foi possível ler as respostas em ${path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}.` };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return { error: `${path} não é JSON válido: ${(error as Error).message}.` };
  }
}

export function respondCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: respondOptions,
    });
  } catch (error) {
    return Promise.resolve(fail('argumento_invalido', (error as Error).message, respondUsage));
  }
  const { values } = parsed;
  const [number, ...rest] = parsed.positionals;
  const typed = rest.join(' ').trim();
  if (typed && values.respostas !== undefined) {
    return Promise.resolve(fail('argumento_invalido', 'Use a resposta em texto ou --respostas, não os dois.', respondUsage));
  }
  return withItem(number, respondUsage, (db, project, item) => {
    let answer = typed;
    if (values.respostas !== undefined) {
      const file = readAnswersFile(values.respostas);
      if ('error' in file) return fail('argumento_invalido', file.error);
      if (item.status !== 'needs_human' || !item.pendingKind) {
        return fail('estado_invalido', `#${item.number} não está aguardando resposta (estado: ${item.status}).`);
      }
      const built = answersFromJson(file.value, item.pending ?? {});
      if ('error' in built) return fail('argumento_invalido', `Respostas inválidas: ${built.error}.`);
      answer = built.text;
    }
    if (!answer) return fail('argumento_faltando', 'Informe a resposta.', respondUsage);
    const to = respond(db, project, item, answer, { replan: values.replanejar });
    if (values.json) decisionJson(db, project, item);
    else process.stdout.write(`#${item.number} → ${to}: retomado no próximo \`mabel run\`.\n`);
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

export function rejectCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: rejectOptions });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${rejectUsage}\n`);
    return Promise.resolve(1);
  }
  const [number, ...rest] = parsed.positionals;
  const reason = rest.join(' ').trim();
  return withItem(number, rejectUsage, (db, project, item) => {
    if (!reason) {
      process.stderr.write(`Informe o motivo.\nUso: ${rejectUsage}\n`);
      return 1;
    }
    // A rejeição escreve na branch da unidade: não pode correr junto com um `mabel run`.
    const home = dataDir();
    const release = acquireLock(home, project.id);
    try {
      const result = reject(db, home, project, item, reason, { cancel: parsed.values.cancelar });
      writeRunReport(db, home, project);
      const where = inSpec(item) ? `revertido na ${unitBranch(item)}` : `retirado da ${unitBranch(item)}`;
      process.stdout.write(
        result.to === 'cancelled'
          ? `#${item.number} ${where} e cancelado.\n`
          : `#${item.number} ${where}: volta ao planejamento com o motivo no próximo \`mabel run\`.\n`,
      );
      if (result.dependents.length > 0) {
        const list = result.dependents.map((n) => `#${n}`).join(', ');
        process.stdout.write(`Atenção: ${list} depende(m) de #${item.number} e continua(m) concluído(s); rejeite-o(s) se for o caso.\n`);
      }
      const delivery = openDeliveries(db, project.id).find((open) => open.items.includes(item.number));
      if (delivery) {
        process.stdout.write(
          `O #${item.number} está na entrega aberta (${delivery.prUrl ?? delivery.branch}). Rode mabel entregar ${unitArg(delivery.unit.split('+')[0] as string)} --substituir para tirá-lo do PR.\n`,
        );
      }
      return 0;
    } finally {
      release();
    }
  });
}

export async function integrationCommand(): Promise<number> {
  const home = dataDir();
  const db = openDb(home);
  try {
    const project = resolveProject(db);
    writeRunReport(db, home, project);
    process.stdout.write(`${unitSections(db, home, project).join('\n')}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ProjectError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    db.close();
  }
}

// Argumentos pedidos no menu interativo ----------------------------------------------------

const value = (values: FormValues, key: string) => (typeof values[key] === 'string' ? (values[key] as string).trim() : '');

/** Campo "Item": a lista só com os itens no estado em que o comando faz sentido. */
function itemField(items: Item[]): FormField {
  return { type: 'pick', key: 'item', label: 'Item', required: true, options: () => itemOptions(items) };
}

/** Itens do projeto atual; sem projeto, a lista vazia (o comando explica o erro depois). */
function projectItems(): { items: Item[]; home: string } {
  const home = dataDir();
  const db = openDb(home);
  try {
    return { items: listItems(db, resolveProject(db).id), home };
  } catch (error) {
    if (error instanceof ProjectError) return { items: [], home };
    throw error;
  } finally {
    db.close();
  }
}

/** Formulário "Detalhar um item": qualquer item. */
export function itemForm(items: Item[]): FormConfig {
  return {
    title: 'Detalhar um item',
    description: 'Mostra estado, pendência, plano, custo e runs de um item.',
    command: 'item',
    fields: [itemField(items)],
    action: 'Detalhar',
    shell: (values) => shellLine(['mabel', 'item', value(values, 'item') || '<n>']),
  };
}

/** Formulário "Aprovar critérios": itens aguardando aprovação, com os critérios do plano. */
export function approveForm(items: Item[], criteria: (item: Item) => string[] = () => []): FormConfig {
  const waiting = items.filter((item) => item.status === 'needs_human' && item.pendingKind === 'critical_approval');
  return {
    title: 'Aprovar critérios',
    description: 'Aprova os critérios de um item que toca regra crítica.',
    command: 'aprovar',
    fields: [
      itemField(waiting),
      {
        type: 'info',
        key: 'criterios',
        lines: (values) => {
          const item = waiting.find((other) => String(other.number) === value(values, 'item'));
          const list = item ? criteria(item) : [];
          return list.length > 0 ? [style.dim('Critérios'), ...list.map((text, i) => `  ${i + 1}. ${text}`)] : [];
        },
      },
    ],
    action: 'Aprovar os critérios',
    shell: (values) => shellLine(['mabel', 'aprovar', value(values, 'item') || '<n>']),
  };
}

/** Formulário "Responder a um item": itens esperando você, com as perguntas e as sugestões. */
export function respondForm(items: Item[]): FormConfig {
  const waiting = items.filter((item) => item.status === 'needs_human' && item.pendingKind && item.pendingKind !== 'critical_approval');
  return {
    title: 'Responder a um item',
    description: 'Responde a um item parado esperando você.',
    command: 'responder',
    fields: [
      itemField(waiting),
      {
        type: 'info',
        key: 'pergunta',
        lines: (values) => {
          const item = waiting.find((other) => String(other.number) === value(values, 'item'));
          if (!item) return [];
          const questions = item.pending?.questions ?? [];
          if (questions.length === 0) return [item.pending?.reason ?? item.statusReason ?? ''].filter(Boolean);
          // Pendências antigas guardavam as perguntas como texto.
          return questions.flatMap((q: Question | string) =>
            typeof q === 'string' ? [q] : [q.texto, ...(q.sugestao ? [style.dim(`sugestão: ${q.sugestao}`)] : [])],
          );
        },
      },
      { type: 'text', key: 'resposta', label: 'Resposta', required: true, placeholder: 'o que o agente deve saber' },
      { type: 'bool', key: 'replanejar', label: 'Replanejar o item' },
    ],
    action: 'Responder',
    shell: (values) =>
      shellLine(['mabel', 'responder', value(values, 'item') || '<n>', value(values, 'resposta') || '<resposta>', ...(values.replanejar ? ['--replanejar'] : [])]),
  };
}

/** Formulário "Cancelar um item": itens que ainda podem ser cancelados; botão vermelho. */
export function cancelForm(items: Item[]): FormConfig {
  return {
    title: 'Cancelar um item',
    description: 'Tira um item da fila de vez.',
    command: 'cancelar',
    fields: [itemField(items.filter((item) => TRANSITIONS[item.status].includes('cancelled')))],
    action: 'Cancelar o item',
    danger: true,
    shell: (values) => shellLine(['mabel', 'cancelar', value(values, 'item') || '<n>']),
  };
}

/** Formulário "Rejeitar um item": itens concluídos na unidade; botão vermelho. */
export function rejectForm(items: Item[]): FormConfig {
  return {
    title: 'Rejeitar um item',
    description: 'Desfaz um item na integração e o devolve ao planejamento.',
    command: 'rejeitar',
    fields: [
      itemField(items.filter((item) => item.status === 'awaiting_merge')),
      { type: 'text', key: 'motivo', label: 'Motivo', required: true, placeholder: 'por que o item volta; o planejamento recebe' },
      { type: 'bool', key: 'cancelar', label: 'Cancelar em vez de devolver' },
    ],
    action: 'Rejeitar',
    danger: true,
    shell: (values) =>
      shellLine(['mabel', 'rejeitar', value(values, 'item') || '<n>', value(values, 'motivo') || '<motivo>', ...(values.cancelar ? ['--cancelar'] : [])]),
  };
}

/** Argumentos do comando a partir do formulário; `null` quando o usuário volta. */
async function argsFrom(form: FormConfig, toArgs: (values: FormValues) => string[]): Promise<string[] | null> {
  const values = await fillForm(form);
  return values && toArgs(values);
}

export async function askItemNumber(): Promise<string[] | null> {
  return argsFrom(itemForm(projectItems().items), (values) => [value(values, 'item')]);
}

export async function askApprove(): Promise<string[] | null> {
  const { items, home } = projectItems();
  const criteria = (item: Item) => (readArtifact<PlanOutput>(home, item.id, 'plano.json')?.criterios ?? []).map((c) => c.texto);
  return argsFrom(approveForm(items, criteria), (values) => [value(values, 'item')]);
}

export async function askRespond(): Promise<string[] | null> {
  return argsFrom(respondForm(projectItems().items), (values) => [
    value(values, 'item'),
    value(values, 'resposta'),
    ...(values.replanejar ? ['--replanejar'] : []),
  ]);
}

export async function askCancel(): Promise<string[] | null> {
  return argsFrom(cancelForm(projectItems().items), (values) => [value(values, 'item')]);
}

export async function askReject(): Promise<string[] | null> {
  return argsFrom(rejectForm(projectItems().items), (values) => [
    value(values, 'item'),
    value(values, 'motivo'),
    ...(values.cancelar ? ['--cancelar'] : []),
  ]);
}
