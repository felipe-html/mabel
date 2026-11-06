import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { Interrupted, interactive } from './ask.ts';
import { BITBUCKET_TOKEN, type BitbucketAuth, bitbucketAuth, bitbucketPr, bitbucketPrState, bitbucketProblem, createBitbucketPr, declineBitbucketPr } from './bitbucket.ts';
import { expired, expiryWarning } from './credentials.ts';
import { dataDir, openDb } from './db.ts';
import { type GuidedIO, confirmAction, terminalGuided } from './guided.ts';
import { select } from './menu.ts';
import { git, gitWith, tryGit, withTrailers } from './git.ts';
import { deliveryDocPath, renderDeliveryDoc } from './deliverydoc.ts';
import { checkedOutAt, integratedItems, isAncestor, unitOf } from './integration.ts';
import { type Item, listItems } from './items.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import { unitContext, unitSections } from './runreport.ts';
import { CURRENT_RULES_FILE, type RuleChange, SPECS_DIR, applyRuleChanges, parseChange, parseSpec } from './specs.ts';
import { style } from './style.ts';
import type { ArgSpec, OptionSpecs } from './options.ts';
import { type Unit, combineUnits, openUnits, proveDelivery } from './units.ts';
import { type OnStep, progressView, timed } from './progress.ts';

// Entrega por unidade (`docs/specs/entregar.md`, S.6 de `docs/specs/specs-e-entrega.md`):
// prova (base + snapshot), documento e regras vigentes num commit do Mabel na branch de
// entrega, PR e volta à base. Na fila (F.1), o snapshot é o corte `base..ponta da unidade`
// (F7): leva também as tarefas de outras unidades que entraram antes dela.

export const deliverUsage = 'mabel entregar [<slug> | #<n>] [--com <unidade>]… [--parcial] [--substituir] [--rascunho]';

export const deliverOptions = {
  com: { type: 'string', multiple: true, value: '<unidade>', description: 'Entrega junto a unidade de que esta depende (numa branch só)' },
  parcial: { type: 'boolean', description: 'Entrega a spec com tarefas ainda não concluídas (no terminal, o Mabel pergunta)' },
  substituir: { type: 'boolean', description: 'Troca a entrega aberta da unidade pela atual (o PR é atualizado)' },
  rascunho: { type: 'boolean', description: 'Abre o PR como rascunho' },
} satisfies OptionSpecs;

export const deliverArgs: ArgSpec[] = [
  { name: '<slug | #n>', description: 'A unidade: o slug da spec ou o número do avulso; sem ela, a lista das prontas', values: 'spec' },
];

const PREFIX = 'mabel/entrega/';
/** O GitHub aceita 65.536 caracteres no corpo do PR; a margem cobre o que o `gh` acrescenta. */
export const BODY_LIMIT = 60_000;
const TITLE_LIMIT = 70;

export type DeliveryStatus = 'open' | 'merged' | 'replaced';

export interface Delivery {
  id: number;
  projectId: string;
  /** Unidade entregue (`exportar-csv`, `avulso-9`, `a+b` com `--com`); `integracao` nas antigas. */
  unit: string;
  branch: string;
  /** Ponta da branch de entrega: o snapshot mais o commit do documento (S.2). */
  commit: string;
  /** Snapshot da integração entregue. Entregas antigas, sem documento: o próprio `commit`. */
  snapshot: string;
  items: number[];
  remote: string | null;
  prUrl: string | null;
  status: DeliveryStatus;
  createdAt: string;
  closedAt: string | null;
}

interface DeliveryRow {
  id: number;
  project_id: string;
  unit: string;
  branch: string;
  commit_sha: string;
  snapshot_sha: string | null;
  items: string;
  remote: string | null;
  pr_url: string | null;
  status: DeliveryStatus;
  created_at: string;
  closed_at: string | null;
}

function fromRow(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    projectId: row.project_id,
    unit: row.unit,
    branch: row.branch,
    commit: row.commit_sha,
    snapshot: row.snapshot_sha ?? row.commit_sha,
    items: JSON.parse(row.items) as number[],
    remote: row.remote,
    prUrl: row.pr_url,
    status: row.status,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export function listDeliveries(db: DatabaseSync, projectId: string): Delivery[] {
  const rows = db.prepare('SELECT * FROM deliveries WHERE project_id = ? ORDER BY id').all(projectId) as unknown as DeliveryRow[];
  return rows.map(fromRow);
}

/** Entregas abertas do projeto: no máximo uma por unidade (E6). */
export function openDeliveries(db: DatabaseSync, projectId: string): Delivery[] {
  return listDeliveries(db, projectId).filter((delivery) => delivery.status === 'open');
}

/** A entrega aberta da unidade (ou a primeira do projeto, sem unidade). */
export function openDelivery(db: DatabaseSync, projectId: string, unit?: string): Delivery | undefined {
  return openDeliveries(db, projectId).find((delivery) => unit === undefined || delivery.unit === unit);
}

function insertDelivery(db: DatabaseSync, delivery: Omit<Delivery, 'id' | 'status' | 'createdAt' | 'closedAt'>): Delivery {
  const createdAt = new Date().toISOString();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO deliveries (project_id, unit, branch, commit_sha, snapshot_sha, items, remote, pr_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(
      delivery.projectId,
      delivery.unit,
      delivery.branch,
      delivery.commit,
      delivery.snapshot,
      JSON.stringify(delivery.items),
      delivery.remote,
      delivery.prUrl,
      createdAt,
    );
  return { ...delivery, id: Number(lastInsertRowid), status: 'open', createdAt, closedAt: null };
}

function updateDelivery(db: DatabaseSync, delivery: Delivery, fields: Partial<Pick<Delivery, 'remote' | 'prUrl' | 'status'>>): void {
  Object.assign(delivery, fields);
  const closedAt = delivery.status === 'open' ? null : new Date().toISOString();
  delivery.closedAt = closedAt;
  db.prepare('UPDATE deliveries SET remote = ?, pr_url = ?, status = ?, closed_at = ? WHERE id = ?').run(
    delivery.remote,
    delivery.prUrl,
    delivery.status,
    closedAt,
    delivery.id,
  );
}

/** Corpo do PR, fora do repositório. */
export function deliveryBodyPath(home: string, projectId: string, branch: string): string {
  return join(home, 'entregas', projectId, `${branch.slice(PREFIX.length)}.md`);
}

// gh e remoto ----------------------------------------------------------------------------

function ghBin(): string {
  return process.env.MABEL_GH_BIN || 'gh';
}

interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Roda o `gh`; `undefined` quando ele não está instalado. */
function gh(cwd: string, args: string[]): GhResult | undefined {
  const result = spawnSync(ghBin(), args, { cwd, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  if (result.error) return undefined;
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: (result.stderr || result.stdout).trim() };
}

/** Remoto da base: o upstream dela; sem upstream, `origin`; sem nenhum, `undefined`. */
export function deliveryRemote(project: Project): string | undefined {
  const upstream = tryGit(project.root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${project.config.baseBranch}@{upstream}`);
  const remotes = (tryGit(project.root, 'remote') ?? '').split('\n').filter(Boolean);
  const fromUpstream = upstream && remotes.find((remote) => upstream.startsWith(`${remote}/`));
  if (fromUpstream) return fromUpstream;
  return remotes.includes('origin') ? 'origin' : undefined;
}

export interface RemoteRepo {
  host: 'github' | 'bitbucket';
  /** `dono/repo` (no Bitbucket, `workspace/repo`). */
  repo: string;
}

/** Hospedagem e repositório de um remoto do GitHub ou do Bitbucket Cloud (https, ssh ou scp). */
export function remoteRepo(url: string): RemoteRepo | undefined {
  const path = '[:/]([^/]+)\\/([^/]+?)(?:\\.git)?\\/?$';
  const github = new RegExp(`github\\.com${path}`).exec(url.trim());
  if (github) return { host: 'github', repo: `${github[1]}/${github[2]}` };
  const bitbucket = new RegExp(`(?:^|[@/])(?:ssh\\.)?bitbucket\\.org${path}`).exec(url.trim());
  if (bitbucket) return { host: 'bitbucket', repo: `${bitbucket[1]}/${bitbucket[2]}` };
  return undefined;
}

/** Endereço para abrir o PR à mão, já com a branch da entrega e a base. */
export function newPrUrl({ host, repo }: RemoteRepo, branch: string, base: string): string {
  return host === 'github'
    ? `https://github.com/${repo}/compare/${base}...${branch}?expand=1`
    : `https://bitbucket.org/${repo}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(base)}`;
}

/** Onde e como o Mabel abre o PR: pelo `gh` no GitHub, pela API no Bitbucket, ou à mão. */
type PrHost =
  | { kind: 'github'; repo?: string; mergeCommitAllowed: boolean }
  | { kind: 'bitbucket'; repo: string; auth: BitbucketAuth }
  | { kind: 'unavailable'; reason: string };

function prHost(home: string, project: Project, remote: string): PrHost {
  const hosted = remoteRepo(tryGit(project.root, 'remote', 'get-url', remote) ?? '');
  if (hosted?.host === 'bitbucket') return bitbucketHost(home, hosted.repo);
  return ghState(project, remote, hosted);
}

/** Bitbucket Cloud: precisa do `BITBUCKET_TOKEN` e de o token enxergar o repositório. */
function bitbucketHost(home: string, repo: string): PrHost {
  const auth = bitbucketAuth();
  if (!auth) return { kind: 'unavailable', reason: `defina ${BITBUCKET_TOKEN} para o Mabel abrir o PR no Bitbucket; veja o README` };
  const problem = bitbucketProblem(auth, repo);
  if (!problem) return { kind: 'bitbucket', repo, auth };
  const stale = expired(home, 'bitbucket') ? '; a validade registrada já passou (mabel credenciar)' : '';
  return { kind: 'unavailable', reason: `${problem}${stale}` };
}

/** O `gh` pode abrir o PR neste remoto: instalado, autenticado e reconhecendo o repositório. */
function ghState(project: Project, remote: string, hosted: RemoteRepo | undefined): PrHost {
  const auth = gh(project.root, ['auth', 'status']);
  if (!auth) return { kind: 'unavailable', reason: 'gh não instalado' };
  if (!auth.ok) return { kind: 'unavailable', reason: 'gh sem login (gh auth login)' };
  const repo = hosted?.repo;
  const view = gh(project.root, ['repo', 'view', ...(repo ? [repo] : []), '--json', 'mergeCommitAllowed']);
  if (!view?.ok) return { kind: 'unavailable', reason: `o remoto ${remote} não é um repositório do GitHub para o gh` };
  let allowed = true;
  try {
    allowed = (JSON.parse(view.stdout) as { mergeCommitAllowed?: boolean }).mergeCommitAllowed !== false;
  } catch {
    // Resposta inesperada: segue como permitido; o corpo do PR avisa de qualquer forma.
  }
  return { kind: 'github', repo, mergeCommitAllowed: allowed };
}

/** Fecha o PR substituído, no GitHub pelo `gh` e no Bitbucket pela API. */
function closePr(project: Project, url: string, comment: string): boolean {
  if (bitbucketPr(url)) {
    const auth = bitbucketAuth();
    return auth ? declineBitbucketPr(auth, url, comment) : false;
  }
  return gh(project.root, ['pr', 'close', url, '--comment', comment])?.ok === true;
}

/** Estado do PR em maiúsculas (`OPEN`, `MERGED`…), ou `undefined` quando não dá para saber. */
function prState(project: Project, url: string): string | undefined {
  if (bitbucketPr(url)) {
    const auth = bitbucketAuth();
    return auth ? bitbucketPrState(auth, url) : undefined;
  }
  const view = gh(project.root, ['pr', 'view', url, '--json', 'state']);
  try {
    return view?.ok ? (JSON.parse(view.stdout) as { state?: string }).state : undefined;
  } catch {
    return undefined;
  }
}

// Entrega --------------------------------------------------------------------------------

function today(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** `mabel/entrega/<unidade>`, com sufixo se a branch ou uma entrega do projeto já usou o nome. */
function nextBranch(db: DatabaseSync, project: Project, unit: string): string {
  const used = new Set(listDeliveries(db, project.id).map((delivery) => delivery.branch));
  const base = `${PREFIX}${unit}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!used.has(name) && tryGit(project.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`) === undefined) return name;
  }
}

export function deliveryTitle(unit: string, numbers: number[]): string {
  const head = `Mabel: ${unit} (`;
  const refs = numbers.map((n) => `#${n}`);
  let list = refs.join(', ');
  for (let kept = refs.length - 1; head.length + list.length + 1 > TITLE_LIMIT && kept > 0; kept--) {
    list = `${refs.slice(0, kept).join(', ')}, …`;
  }
  return `${head}${list})`;
}

const same = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
};

/** Volta o checkout da raiz para a base quando ele está na integração ou numa entrega e limpo (E4). */
function switchToBase(project: Project, out: string[], onStep?: OnStep): void {
  const integration = project.config.integracao as string;
  const base = project.config.baseBranch;
  const elsewhere = checkedOutAt(project, integration);
  if (elsewhere && !same(elsewhere, project.root)) {
    out.push(`a ${integration} está aberta em ${elsewhere}; feche-a para o Mabel continuar a integrar`);
  }
  const head = tryGit(project.root, 'symbolic-ref', '-q', '--short', 'HEAD');
  if (!head || (head !== integration && !head.startsWith(PREFIX))) return;
  if ((tryGit(project.root, 'status', '--porcelain', '--untracked-files=no') ?? '') !== '') {
    out.push(`Checkout da raiz em ${head} com alterações; não troquei para a ${base}.`);
    return;
  }
  const error = timed(
    onStep,
    'voltar à base',
    () => {
      try {
        git(project.root, 'switch', '-q', base);
        return undefined;
      } catch (error) {
        return error as Error;
      }
    },
    (error) => !error,
  );
  out.push(error ? `não troquei para a ${base}: ${error.message}` : `checkout da raiz: ${head} → ${base}`);
}

/**
 * Commit do Mabel sobre o snapshot só com o documento de entrega e o `regras.md`, montado
 * num índice temporário: nenhum worktree é tocado, e a base não recebe nada (G10).
 */
function commitDocument(root: string, snapshot: string, files: { path: string; content: string }[], unit: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mabel-entrega-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    gitWith(root, { env }, 'read-tree', snapshot);
    for (const { path, content } of files) {
      const blob = gitWith(root, { input: content }, 'hash-object', '-w', '--stdin');
      gitWith(root, { env }, 'update-index', '--add', '--cacheinfo', `100644,${blob},${path}`);
    }
    const tree = gitWith(root, { env }, 'write-tree');
    const message = withTrailers(`mabel: entrega ${unit}`, { 'Mabel-Entrega': name });
    return git(root, 'commit-tree', tree, '-p', snapshot, '-m', message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Nome do documento da entrega, pelo arquivo que o commit dela acrescentou. */
function deliveryDocOf(root: string, delivery: Delivery): string | undefined {
  if (delivery.commit === delivery.snapshot) return undefined;
  const files = tryGit(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', delivery.snapshot, delivery.commit) ?? '';
  return files.split('\n').find((file) => file.startsWith('.mabel/entregas/'));
}

/**
 * Corpo do PR: o aviso do merge commit e o documento da entrega, lido da branch. Acima do
 * limite, o documento é cortado na última linha inteira e aponta para o arquivo.
 */
export function deliveryBody(project: Project, delivery: Delivery, limit = BODY_LIMIT): string {
  const path = deliveryDocOf(project.root, delivery);
  const doc = path ? (tryGit(project.root, 'show', `${delivery.commit}:${path}`) ?? '') : '';
  const head = 'Faça o merge com merge commit ("Create a merge commit" no GitHub, "Merge commit" no Bitbucket): squash e rebase impedem o Mabel de dar os itens como concluídos.\n\n';
  const body = `${head}${doc}\n`;
  if (body.length <= limit) return body;
  const tail = `\n\n… documento cortado; a íntegra está em ${path} na branch ${delivery.branch}.\n`;
  const kept = body.slice(0, limit - tail.length);
  return `${kept.slice(0, kept.lastIndexOf('\n'))}${tail}`;
}

function describe(delivery: Delivery, base: string): string[] {
  return [
    `${style.bold('Entrega')} ${delivery.branch} · ${delivery.unit} · ${delivery.items.length} ${delivery.items.length === 1 ? 'tarefa' : 'tarefas'} desde a ${base}`,
    `  ${delivery.items.map((n) => `#${n}`).join(' · ')}`,
  ];
}

export interface DeliverOptions {
  /** A unidade: slug da spec, `avulso-<n>` ou `#<n>`; sem ela, a lista das prontas. */
  unit?: string;
  /** Unidades entregues junto (`--com`). */
  with?: string[];
  partial?: boolean;
  replace?: boolean;
  draft?: boolean;
  /** Começo e fim de cada etapa, para o acompanhamento no terminal (`progressView`). */
  onStep?: OnStep;
}

export interface DeliverResult {
  code: number;
  lines: string[];
  delivery?: Delivery;
  /** Recusada por ser parcial: as tarefas da unidade que faltam (o TTY pergunta). */
  missing?: number[];
}

/**
 * Entrega a integração: snapshot `mabel/entrega/<data>`, push, PR com o relatório e o
 * checkout da raiz de volta à base. Retoma a entrega aberta que ficou sem PR. Antes, confere
 * a entrega aberta como a abertura do `run`: a que já chegou à base não impede a próxima.
 */
export function deliver(db: DatabaseSync, home: string, project: Project, options: DeliverOptions = {}): DeliverResult {
  const notes = project.config.integracao ? timed(options.onStep, 'conferir entregas abertas', () => checkDeliveries(db, project)) : [];
  if (project.config.integracao && !options.unit) {
    if (openUnits(db, project).length > 0) return { code: 0, lines: [...notes, ...unitSections(db, home, project)] };
    return { code: 0, lines: [...notes, 'Nada a entregar: nenhuma unidade com tarefa concluída fora da base.', '', ...unitContext(db, home, project)] };
  }
  const result = deliverChecked(db, home, project, options);
  return { ...result, lines: [...notes, ...result.lines] };
}

/** `#9` ou `9` → a unidade da tarefa; o resto é o nome da unidade. */
export function resolveUnit(items: Item[], value: string): string | undefined {
  const number = /^#?(\d+)$/.exec(value.trim());
  if (!number) return value.trim();
  const item = items.find((other) => other.number === Number(number[1]));
  return item ? unitOf(item) : undefined;
}

/** O argumento do `entregar` para a unidade: `#9` no avulso, o nome nas outras. */
export function unitArg(unit: string): string {
  return /^avulso-(\d+)$/.exec(unit)?.[1] ? `#${unit.slice('avulso-'.length)}` : unit;
}

export function unitLabel(unit: Unit): string {
  return /^avulso-/.test(unit.name) ? `avulso ${unitArg(unit.name)} ${unit.items[0]?.title ?? ''}`.trimEnd() : `${unit.name} (${unit.items.length} ${unit.items.length === 1 ? 'tarefa' : 'tarefas'})`;
}

/** Alterações nas regras vigentes da unidade: as da spec (lida do snapshot) ou as do avulso. */
function unitRuleChanges(root: string, snapshot: string, items: Item[]): RuleChange[] {
  const item = items[0];
  if (item?.spec) {
    const text = tryGit(root, 'show', `${snapshot}:.mabel/${SPECS_DIR}/${item.spec}.md`);
    return text ? parseSpec(text).alteracoesRegrasVigentes : [];
  }
  return items.flatMap((task) => task.ruleChanges.flatMap((line) => parseChange(line) ?? []));
}

/** As tarefas do corte agrupadas por unidade, na ordem da fila. */
function byUnit(items: Item[]): Map<string, Item[]> {
  const units = new Map<string, Item[]>();
  for (const item of items) units.set(unitOf(item), [...(units.get(unitOf(item)) ?? []), item]);
  return units;
}

function deliverChecked(db: DatabaseSync, home: string, project: Project, options: DeliverOptions): DeliverResult {
  const integration = project.config.integracao;
  const base = project.config.baseBranch;
  const out: string[] = [];
  if (!integration) {
    return { code: 1, lines: ['Integração desligada (`integracao: null` no config): cada item fica na própria branch; não há o que entregar.'] };
  }
  const all = listItems(db, project.id);
  const ready = openUnits(db, project, all);
  const names: string[] = [];
  for (const value of [options.unit as string, ...(options.with ?? [])]) {
    const name = resolveUnit(all, value);
    if (!name) return { code: 1, lines: [`Tarefa ${value} não existe.`] };
    if (!names.includes(name)) names.push(name);
  }
  const group = names.join('+');
  const open = openDelivery(db, project.id, group);
  const units = names.map((name) => ready.find((unit) => unit.name === name));
  const missingUnit = names.find((_, i) => !units[i]);
  if (missingUnit && !(open && open.prUrl === null)) {
    return { code: missingUnit === names[0] ? 0 : 1, lines: [`Nada a entregar: a unidade ${missingUnit} não tem tarefa concluída fora da ${base}.`] };
  }
  const chosen = units.filter((unit): unit is Unit => unit !== undefined);

  // Entrega parcial (R7): tarefa da unidade ainda não concluída.
  const missing = all
    .filter((item) => names.includes(unitOf(item)) && !['awaiting_merge', 'done', 'cancelled'].includes(item.status))
    .map((item) => item.number);
  if (missing.length > 0 && !options.partial) {
    return {
      code: 1,
      missing,
      lines: [`Entrega parcial: ${names.join(' e ')} ainda tem ${missing.map((n) => `#${n}`).join(', ')} por concluir. Rode com --parcial para entregar o que está pronto.`],
    };
  }
  // O corte (F7): base..ponta da unidade. A dependência (R6) já vem antes dela na fila.
  let snapshot: string | undefined;
  if (chosen.length === names.length) {
    if (chosen.length === 1) snapshot = (chosen[0] as Unit).tip;
    else {
      const combined = timed(
        options.onStep,
        'montar a unidade',
        () => combineUnits(home, project, chosen.map((unit) => unit.tip)),
        (result) => !('files' in result),
      );
      if ('files' in combined) {
        return { code: 1, lines: [`As unidades não se juntam: conflito com ${combined.tip.slice(0, 7)} em ${combined.files.join(', ')}. Entregue uma de cada vez.`] };
      }
      snapshot = combined.commit;
    }
  }
  const items = snapshot ? integratedItems(db, project, snapshot) : [];

  let delivery: Delivery | undefined;
  let previous: Delivery | undefined;
  if (open) {
    const advanced = snapshot !== undefined && snapshot !== open.snapshot && items.length > 0;
    if (options.replace && advanced) {
      previous = open;
    } else if (open.prUrl === null) {
      // Ficou sem PR (push que falhou, sem gh): retoma do push com a mesma entrega.
      delivery = open;
    } else if (options.replace) {
      return { code: 0, lines: [...describe(open, base), `A entrega aberta já tem tudo o que está na unidade.`] };
    } else {
      return {
        code: 1,
        lines: [
          ...describe(open, base),
          `  PR: ${open.prUrl}`,
          `Já há uma entrega aberta de ${group}. Faça o merge dela ou rode mabel entregar ${unitArg(names[0] as string)} --substituir para abrir outra.`,
        ],
      };
    }
  }

  // Prova da entrega: base + snapshot, verificados juntos, antes de criar qualquer branch.
  if (!delivery && snapshot) {
    const proof = proveDelivery(home, project, snapshot, options.onStep);
    if (proof.kind === 'conflict') {
      return {
        code: 1,
        lines: [`A ${base} conflita com a entrega em ${proof.files.join(', ')}: rode mabel rodar (a abertura traz a ${base} para a ${integration}) e entregue de novo.`],
      };
    }
    if (proof.kind === 'red') {
      return {
        code: 1,
        lines: [`A verificação de ${base} + ${group} falhou em \`${proof.verify.command}\`; nada foi criado.`, ...(proof.verify.detail ? [proof.verify.detail] : [])],
      };
    }
  }

  const remote = deliveryRemote(project);
  const host = remote ? prHost(home, project, remote) : undefined;
  if (host?.kind === 'github' && !host.mergeCommitAllowed) {
    return {
      code: 1,
      lines: [
        'O repositório não permite merge commit: com squash ou rebase, os itens nunca chegam a done.',
        'Ligue em Settings › General › Pull Requests › "Allow merge commits" e rode de novo.',
      ],
    };
  }

  if (!delivery) {
    delivery = timed(options.onStep, 'gravar o documento', () => recordDelivery());
    // Uma entrega aberta por unidade (E6): a anterior sai já, mesmo que o PR novo falhe.
    if (previous) updateDelivery(db, previous, { status: 'replaced' });
  } else if (delivery.remote !== (remote ?? null)) {
    updateDelivery(db, delivery, { remote: remote ?? null });
  }
  /** Documento e regras vigentes num commit sobre o snapshot, a branch e a entrega gravada. */
  function recordDelivery(): Delivery {
    const branch = nextBranch(db, project, group);
    const date = today();
    const name = `${date}-${group}`;
    const units = byUnit(items);
    const changes = [...units.values()].flatMap((unitItems) => unitRuleChanges(project.root, snapshot as string, unitItems));
    const rulesPath = `.mabel/${CURRENT_RULES_FILE}`;
    const applied = changes.length > 0 ? applyRuleChanges(tryGit(project.root, 'show', `${snapshot}:${rulesPath}`) ?? '', changes) : undefined;
    const short = git(project.root, 'rev-parse', '--short', snapshot as string);
    const warnings = [
      ...(missing.length > 0 ? [`Entrega parcial: faltam ${missing.map((n) => `#${n}`).join(', ')}.`] : []),
      // Tarefas de outra unidade antes da ponta entram junto (F9).
      ...items.filter((item) => !names.includes(unitOf(item))).map((item) => `#${item.number} (de ${unitOf(item)}) entra nesta entrega`),
    ];
    const doc = renderDeliveryDoc(db, home, project, {
      name,
      unit: group,
      snapshot: snapshot as string,
      date,
      items,
      specs: [...units.keys()].filter((unit) => existsSpec(project.root, snapshot as string, unit)).map((unit) => `.mabel/${SPECS_DIR}/${unit}.md (${short})`),
      subjects: changes.map((change) => change.assunto),
      ruleNotes: applied?.notes,
      warnings,
    });
    const files = [{ path: deliveryDocPath(name), content: doc }, ...(applied ? [{ path: rulesPath, content: applied.text }] : [])];
    const commit = commitDocument(project.root, snapshot as string, files, group, name);
    git(project.root, 'update-ref', `refs/heads/${branch}`, commit, '');
    return insertDelivery(db, {
      projectId: project.id,
      unit: group,
      branch,
      commit,
      snapshot: snapshot as string,
      items: items.map((item) => item.number),
      remote: deliveryRemote(project) ?? null,
      prUrl: null,
    });
  }
  out.push(...describe(delivery, base));
  const docPath = deliveryDocOf(project.root, delivery);
  if (docPath) out.push(`  Documento: ${docPath} (na branch da entrega)`);

  const bodyPath = deliveryBodyPath(home, project.id, delivery.branch);
  mkdirSync(join(bodyPath, '..'), { recursive: true });
  writeFileSync(bodyPath, deliveryBody(project, delivery));

  let code = 0;
  if (!remote) {
    out.push(`sem remoto: para levar à ${base}, git merge --no-ff ${delivery.branch}`);
  } else {
    const branch = delivery.branch;
    const pushed = timed(
      options.onStep,
      'publicar a branch',
      () => spawnSync('git', ['push', '-q', '-u', remote, branch], { cwd: project.root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }),
      (result) => result.status === 0,
    );
    if (pushed.status !== 0) {
      out.push(`o push para ${remote} falhou: ${(pushed.stderr || pushed.stdout || String(pushed.error ?? '')).trim()}`);
      out.push('A branch local da entrega ficou. Rode mabel entregar de novo para retomar.');
      code = 1;
    } else {
      out.push(`branch publicada em ${remote}`);
      if (host?.kind === 'bitbucket') {
        const warning = expiryWarning(home, 'bitbucket');
        if (warning) out.push(warning);
        const pr = { title: deliveryTitle(delivery.unit, delivery.items), description: readFileSync(bodyPath, 'utf8'), source: branch, destination: base, draft: options.draft };
        const created = timed(options.onStep, 'abrir o PR', () => createBitbucketPr(host.auth, host.repo, pr), (result) => 'url' in result);
        if ('url' in created) {
          updateDelivery(db, delivery, { prUrl: created.url });
          out.push(`PR aberto: ${created.url}`);
          out.push('O Mabel não confere a estratégia de merge no Bitbucket: no merge, escolha "Merge commit".');
        } else {
          out.push(`o Bitbucket não abriu o PR: ${created.error}`);
          out.push(`Abra o PR: ${newPrUrl({ host: 'bitbucket', repo: host.repo }, delivery.branch, base)}`);
          out.push(`Corpo do PR: ${bodyPath}`);
          code = 1;
        }
      } else if (host?.kind === 'github') {
        const args = [
          'pr',
          'create',
          ...(host.repo ? ['--repo', host.repo] : []),
          '--base',
          base,
          '--head',
          delivery.branch,
          '--title',
          deliveryTitle(delivery.unit, delivery.items),
          '--body-file',
          bodyPath,
          ...(options.draft ? ['--draft'] : []),
        ];
        const prUrl = (result: ReturnType<typeof gh>) => (result?.ok ? /https?:\/\/\S+/.exec(result.stdout)?.[0] : undefined);
        const created = timed(options.onStep, 'abrir o PR', () => gh(project.root, args), (result) => prUrl(result) !== undefined);
        const url = prUrl(created);
        if (url) {
          updateDelivery(db, delivery, { prUrl: url });
          out.push(`PR aberto: ${url}`);
        } else {
          out.push(`o gh não abriu o PR: ${created?.stderr || 'sem resposta'}`);
          out.push(`Corpo do PR: ${bodyPath}`);
          code = 1;
        }
      } else {
        if (host) out.push(`sem PR automático (${host.reason})`);
        const hosted = remoteRepo(tryGit(project.root, 'remote', 'get-url', remote) ?? '');
        if (hosted) out.push(`Abra o PR: ${newPrUrl(hosted, delivery.branch, base)}`);
        out.push(`Corpo do PR: ${bodyPath}`);
        if (hosted?.host !== 'github') out.push('O Mabel não confere a estratégia de merge fora do GitHub: no merge, escolha "Merge commit".');
      }
    }
  }

  if (previous) {
    if (previous.prUrl) {
      const [old, current] = [previous.prUrl, delivery.prUrl];
      const closed = current ? timed(options.onStep, 'fechar o PR anterior', () => closePr(project, old, `Substituído por ${current}`), (ok) => ok) : false;
      out.push(closed ? `PR anterior fechado: ${previous.prUrl}` : `Feche o PR anterior: ${previous.prUrl}`);
    }
    if (isAncestor(project.root, previous.snapshot, delivery.snapshot)) tryGit(project.root, 'branch', '-D', previous.branch);
  }

  if (code === 0) {
    switchToBase(project, out, options.onStep);
    out.push('', `Faça o merge com merge commit, sem squash nem rebase. Depois, na ${base}: git pull`);
  }
  return { code, lines: out, delivery };
}

/** A spec existe no snapshot (o `legado` e os avulsos não têm arquivo). */
function existsSpec(root: string, snapshot: string, unit: string): boolean {
  return tryGit(root, 'cat-file', '-e', `${snapshot}:.mabel/${SPECS_DIR}/${unit}.md`) !== undefined;
}

// Abertura do `run` ----------------------------------------------------------------------

/**
 * Acompanha a entrega aberta: no merge na base, `merged` e a branch local apagada; integrada
 * só no remoto ou por squash, devolve a nota com o que fazer.
 */
export function checkDeliveries(db: DatabaseSync, project: Project): string[] {
  return openDeliveries(db, project.id).flatMap((delivery) => checkDelivery(db, project, delivery));
}

function checkDelivery(db: DatabaseSync, project: Project, delivery: Delivery): string[] {
  const base = project.config.baseBranch;
  if (isAncestor(project.root, delivery.commit, base)) {
    updateDelivery(db, delivery, { status: 'merged' });
    const deleted = tryGit(project.root, 'branch', '-D', delivery.branch) !== undefined;
    return [`entrega ${delivery.branch} na ${base}${deleted ? '; branch local apagada' : ''}`];
  }
  // Na fila, a entrega de uma unidade posterior leva a desta junto (F7).
  if (isAncestor(project.root, delivery.snapshot, base)) {
    updateDelivery(db, delivery, { status: 'replaced' });
    tryGit(project.root, 'branch', '-D', delivery.branch);
    return [`entrega ${delivery.branch}: o conteúdo chegou à ${base} por outra entrega${delivery.prUrl ? `; feche o PR ${delivery.prUrl}` : ''}`];
  }
  if (!delivery.remote) return [];
  const fetched = spawnSync('git', ['fetch', '-q', delivery.remote, base], {
    cwd: project.root,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (fetched.status === 0 && isAncestor(project.root, delivery.commit, 'FETCH_HEAD')) {
    return [`O PR da entrega foi integrado no ${delivery.remote}; atualize a ${base} local (git pull) para os itens irem a done.`];
  }
  if (!delivery.prUrl) return [];
  if (prState(project, delivery.prUrl) !== 'MERGED') return [];
  return [
    `O PR da entrega (${delivery.prUrl}) foi integrado sem merge commit (squash ou rebase): os commits do Mabel não estão na ${base}, e os itens não vão a done.`,
    `Para consertar, na ${base}: git merge --no-ff ${delivery.branch} (traz os commits para a história; o conteúdo já está lá).`,
  ];
}

// Comando --------------------------------------------------------------------------------

/** Confirmação da entrega parcial no terminal (R7). */
export async function confirmPartial(io: GuidedIO, missing: number[]): Promise<boolean> {
  io.write(`Faltam ${missing.map((n) => `#${n}`).join(', ')}.`);
  return confirmAction(io, 'Entregar só o que está pronto');
}

/**
 * O `deliver` com as etapas e o tempo de cada uma na tela, ao vivo (`progressView`), e o
 * total no fim. Sem unidade, o `deliver` só lista: nada a acompanhar.
 */
async function deliverWithProgress(db: DatabaseSync, home: string, project: Project, options: DeliverOptions): Promise<DeliverResult> {
  if (!options.unit) return deliver(db, home, project, options);
  const group = [options.unit, ...(options.with ?? [])].join(' + ');
  process.stdout.write(`${style.bold('Entregando')} ${group}\n`);
  const view = progressView();
  let result: DeliverResult | undefined;
  try {
    result = deliver(db, home, project, { ...options, onStep: view.onStep });
  } finally {
    await view.finish(result !== undefined && !result.missing);
  }
  process.stdout.write('\n');
  return result;
}

export async function deliverCommand(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: deliverOptions, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${deliverUsage}\n`);
    return 1;
  }
  const { values } = parsed;
  const home = dataDir();
  const db = openDb(home);
  try {
    const project = resolveProject(db);
    let unit = parsed.positionals[0];
    if (!unit && (values.com?.length ?? 0) > 0) {
      process.stderr.write(`Informe a unidade antes do --com.\nUso: ${deliverUsage}\n`);
      return 1;
    }
    if (!unit && interactive() && project.config.integracao) {
      process.stdout.write(`${unitContext(db, home, project).join('\n')}\n\n`);
      const units = openUnits(db, project);
      if (units.length === 0) {
        process.stdout.write('Nada a entregar: nenhuma unidade com tarefa concluída fora da base.\n');
        return 0;
      }
      process.stdout.write(`${style.bold('Prontas para entregar')}\n`);
      const chosen = await select(
        units.map((u) => ({ label: unitLabel(u), hint: style.dim(`mabel entregar ${unitArg(u.name)}`) })),
        style,
      );
      if (chosen === null) return 0;
      unit = (units[chosen] as Unit).name;
    }
    const options: DeliverOptions = { unit, with: values.com, partial: values.parcial, replace: values.substituir, draft: values.rascunho };
    let result = await deliverWithProgress(db, home, project, options);
    if (result.missing && interactive()) {
      process.stdout.write(`${result.lines.join('\n')}\n`);
      try {
        if (!(await confirmPartial(terminalGuided, result.missing))) return 1;
      } catch (error) {
        if (error instanceof Interrupted) return 130;
        throw error;
      }
      result = await deliverWithProgress(db, home, project, { ...options, partial: true });
    }
    (result.code === 0 ? process.stdout : process.stderr).write(`${result.lines.join('\n')}\n`);
    return result.code;
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
