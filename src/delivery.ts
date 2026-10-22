import { spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { dataDir, openDb } from './db.ts';
import { git, tryGit } from './git.ts';
import { checkedOutAt, integratedItems, isAncestor } from './integration.ts';
import { type Project, ProjectError, resolveProject } from './project.ts';
import { lookFirstLines, renderIntegrationReport } from './report.ts';
import { style } from './style.ts';

// Entrega da integração (`docs/specs/entregar.md`): snapshot, PR e volta à base.

export const deliverUsage = 'mabel entregar [--substituir] [--rascunho]';

const PREFIX = 'mabel/entrega/';
/** O GitHub aceita 65.536 caracteres no corpo do PR; a margem cobre o que o `gh` acrescenta. */
const BODY_LIMIT = 60_000;
const TITLE_LIMIT = 70;

export type DeliveryStatus = 'open' | 'merged' | 'replaced';

export interface Delivery {
  id: number;
  projectId: string;
  branch: string;
  commit: string;
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
  branch: string;
  commit_sha: string;
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
    branch: row.branch,
    commit: row.commit_sha,
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

/** A entrega aberta do projeto (no máximo uma, E6). */
export function openDelivery(db: DatabaseSync, projectId: string): Delivery | undefined {
  return listDeliveries(db, projectId).find((delivery) => delivery.status === 'open');
}

function insertDelivery(db: DatabaseSync, delivery: Omit<Delivery, 'id' | 'status' | 'createdAt' | 'closedAt'>): Delivery {
  const createdAt = new Date().toISOString();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO deliveries (project_id, branch, commit_sha, items, remote, pr_url, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(delivery.projectId, delivery.branch, delivery.commit, JSON.stringify(delivery.items), delivery.remote, delivery.prUrl, createdAt);
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

type GhState = { kind: 'ready'; repo?: string; mergeCommitAllowed: boolean } | { kind: 'unavailable'; reason: string };

/** O `gh` pode abrir o PR neste remoto: instalado, autenticado e reconhecendo o repositório. */
function ghState(project: Project, remote: string): GhState {
  const hosted = remoteRepo(tryGit(project.root, 'remote', 'get-url', remote) ?? '');
  if (hosted?.host === 'bitbucket') return { kind: 'unavailable', reason: `o remoto ${remote} está no Bitbucket; o gh só abre PR no GitHub` };
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
  return { kind: 'ready', repo, mergeCommitAllowed: allowed };
}

// Entrega --------------------------------------------------------------------------------

function today(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** `mabel/entrega/<data>`, com sufixo se a branch ou uma entrega do projeto já usou o nome. */
function nextBranch(db: DatabaseSync, project: Project): string {
  const used = new Set(listDeliveries(db, project.id).map((delivery) => delivery.branch));
  const base = `${PREFIX}${today()}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!used.has(name) && tryGit(project.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`) === undefined) return name;
  }
}

export function deliveryTitle(numbers: number[]): string {
  const head = `Mabel: ${numbers.length} ${numbers.length === 1 ? 'item' : 'itens'} (`;
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
function switchToBase(project: Project, out: string[]): void {
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
  try {
    git(project.root, 'switch', '-q', base);
    out.push(`checkout da raiz: ${head} → ${base}`);
  } catch (error) {
    out.push(`não troquei para a ${base}: ${(error as Error).message}`);
  }
}

function describe(delivery: Delivery, base: string): string[] {
  return [
    `${style.bold('Entrega')} ${delivery.branch} · ${delivery.items.length} ${delivery.items.length === 1 ? 'item' : 'itens'} desde a ${base}`,
    `  ${delivery.items.map((n) => `#${n}`).join(' · ')}`,
  ];
}

export interface DeliverOptions {
  replace?: boolean;
  draft?: boolean;
}

export interface DeliverResult {
  code: number;
  lines: string[];
  delivery?: Delivery;
}

/**
 * Entrega a integração: snapshot `mabel/entrega/<data>`, push, PR com o relatório e o
 * checkout da raiz de volta à base. Retoma a entrega aberta que ficou sem PR.
 */
export function deliver(db: DatabaseSync, home: string, project: Project, options: DeliverOptions = {}): DeliverResult {
  const integration = project.config.integracao;
  const base = project.config.baseBranch;
  const out: string[] = [];
  if (!integration) {
    return { code: 1, lines: ['Integração desligada (`integracao: null` no config): cada item fica na própria branch; não há o que entregar.'] };
  }
  const snapshot = tryGit(project.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${integration}`);
  const items = snapshot ? integratedItems(db, project, snapshot) : [];

  const open = openDelivery(db, project.id);
  let delivery: Delivery | undefined;
  let previous: Delivery | undefined;
  if (open) {
    const advanced = snapshot !== undefined && snapshot !== open.commit && items.length > 0;
    if (options.replace && advanced) {
      previous = open;
    } else if (open.prUrl === null) {
      // Ficou sem PR (push que falhou, sem gh): retoma do push com a mesma entrega.
      delivery = open;
    } else if (options.replace) {
      return { code: 0, lines: [...describe(open, base), 'A entrega aberta já tem tudo o que está na integração.'] };
    } else {
      return {
        code: 1,
        lines: [
          ...describe(open, base),
          `  PR: ${open.prUrl}`,
          'Já há uma entrega aberta. Faça o merge dela ou rode mabel entregar --substituir para abrir outra com a integração atual.',
        ],
      };
    }
  }
  if (!delivery && items.length === 0) {
    return { code: 0, lines: [`Nada a entregar: a ${integration} não tem itens fora da ${base}.`] };
  }

  const remote = deliveryRemote(project);
  const ghNow = remote ? ghState(project, remote) : undefined;
  if (ghNow?.kind === 'ready' && !ghNow.mergeCommitAllowed) {
    return {
      code: 1,
      lines: [
        'O repositório não permite merge commit: com squash ou rebase, os itens nunca chegam a done.',
        'Ligue em Settings › General › Pull Requests › "Allow merge commits" e rode de novo.',
      ],
    };
  }

  if (!delivery) {
    const branch = nextBranch(db, project);
    git(project.root, 'update-ref', `refs/heads/${branch}`, snapshot as string, '');
    delivery = insertDelivery(db, {
      projectId: project.id,
      branch,
      commit: snapshot as string,
      items: items.map((item) => item.number),
      remote: remote ?? null,
      prUrl: null,
    });
    // Uma entrega aberta por projeto (E6): a anterior sai já, mesmo que o PR novo falhe.
    if (previous) updateDelivery(db, previous, { status: 'replaced' });
  } else if (delivery.remote !== (remote ?? null)) {
    updateDelivery(db, delivery, { remote: remote ?? null });
  }
  out.push(...describe(delivery, base));
  const lookFirst = lookFirstLines(db, home, project, delivery.commit).length;
  if (lookFirst > 0) out.push(`  Olhe primeiro: ${lookFirst} (no corpo do PR)`);

  const bodyPath = deliveryBodyPath(home, project.id, delivery.branch);
  mkdirSync(join(bodyPath, '..'), { recursive: true });
  writeFileSync(
    bodyPath,
    renderIntegrationReport(db, home, project, { delivery: { branch: delivery.branch, commit: delivery.commit }, maxChars: BODY_LIMIT }),
  );

  let code = 0;
  if (!remote) {
    out.push(`sem remoto: para levar à ${base}, git merge --no-ff ${delivery.branch}`);
  } else {
    const pushed = spawnSync('git', ['push', '-q', '-u', remote, delivery.branch], {
      cwd: project.root,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    if (pushed.status !== 0) {
      out.push(`o push para ${remote} falhou: ${(pushed.stderr || pushed.stdout || String(pushed.error ?? '')).trim()}`);
      out.push('A branch local da entrega ficou. Rode mabel entregar de novo para retomar.');
      code = 1;
    } else {
      out.push(`branch publicada em ${remote}`);
      if (ghNow?.kind === 'ready') {
        const created = gh(project.root, [
          'pr',
          'create',
          ...(ghNow.repo ? ['--repo', ghNow.repo] : []),
          '--base',
          base,
          '--head',
          delivery.branch,
          '--title',
          deliveryTitle(delivery.items),
          '--body-file',
          bodyPath,
          ...(options.draft ? ['--draft'] : []),
        ]);
        const url = created?.ok ? /https?:\/\/\S+/.exec(created.stdout)?.[0] : undefined;
        if (url) {
          updateDelivery(db, delivery, { prUrl: url });
          out.push(`PR aberto: ${url}`);
        } else {
          out.push(`o gh não abriu o PR: ${created?.stderr || 'sem resposta'}`);
          out.push(`Corpo do PR: ${bodyPath}`);
          code = 1;
        }
      } else {
        if (ghNow) out.push(`sem PR automático (${ghNow.reason})`);
        const hosted = remoteRepo(tryGit(project.root, 'remote', 'get-url', remote) ?? '');
        if (hosted) out.push(`Abra o PR: ${newPrUrl(hosted, delivery.branch, base)}`);
        out.push(`Corpo do PR: ${bodyPath}`);
        if (hosted?.host !== 'github') out.push('O Mabel não confere a estratégia de merge fora do GitHub: no merge, escolha "Merge commit".');
      }
    }
  }

  if (previous) {
    if (previous.prUrl) {
      const closed = delivery.prUrl
        ? gh(project.root, ['pr', 'close', previous.prUrl, '--comment', `Substituído por ${delivery.prUrl}`])
        : undefined;
      out.push(closed?.ok ? `PR anterior fechado: ${previous.prUrl}` : `Feche o PR anterior: ${previous.prUrl}`);
    }
    if (isAncestor(project.root, previous.commit, delivery.commit)) tryGit(project.root, 'branch', '-D', previous.branch);
  }

  if (code === 0) {
    switchToBase(project, out);
    out.push('', `Faça o merge com merge commit, sem squash nem rebase. Depois, na ${base}: git pull`);
  }
  return { code, lines: out, delivery };
}

// Abertura do `run` ----------------------------------------------------------------------

/**
 * Acompanha a entrega aberta: no merge na base, `merged` e a branch local apagada; integrada
 * só no remoto ou por squash, devolve a nota com o que fazer.
 */
export function checkDeliveries(db: DatabaseSync, project: Project): string[] {
  const delivery = openDelivery(db, project.id);
  if (!delivery) return [];
  const base = project.config.baseBranch;
  if (isAncestor(project.root, delivery.commit, base)) {
    updateDelivery(db, delivery, { status: 'merged' });
    const deleted = tryGit(project.root, 'branch', '-D', delivery.branch) !== undefined;
    return [`entrega ${delivery.branch} na ${base}${deleted ? '; branch local apagada' : ''}`];
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
  const view = gh(project.root, ['pr', 'view', delivery.prUrl, '--json', 'state']);
  let state: string | undefined;
  try {
    state = view?.ok ? (JSON.parse(view.stdout) as { state?: string }).state : undefined;
  } catch {
    state = undefined;
  }
  if (state !== 'MERGED') return [];
  return [
    `O PR da entrega (${delivery.prUrl}) foi integrado sem merge commit (squash ou rebase): os commits do Mabel não estão na ${base}, e os itens não vão a done.`,
    `Para consertar, na ${base}: git merge --no-ff ${delivery.branch} (traz os commits para a história; o conteúdo já está lá).`,
  ];
}

// Comando --------------------------------------------------------------------------------

export function deliverCommand(args: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { substituir: { type: 'boolean' }, rascunho: { type: 'boolean' } } });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\nUso: ${deliverUsage}\n`);
    return 1;
  }
  const home = dataDir();
  const db = openDb(home);
  try {
    const project = resolveProject(db);
    const result = deliver(db, home, project, { replace: parsed.values.substituir, draft: parsed.values.rascunho });
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
