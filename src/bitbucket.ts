import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * PR no Bitbucket Cloud pela API REST 2.0 (`docs/specs/entregar.md`, E5). O `deliver` é
 * síncrono, então a chamada é feita pelo `curl` com `spawnSync`, como o `gh`. O token vai
 * pela configuração no stdin (`-K -`), nunca na linha de comando, onde o `ps` o mostraria.
 *
 * Credencial: `BITBUCKET_TOKEN`. Com `BITBUCKET_EMAIL`, é um API token da conta Atlassian
 * (autenticação básica e-mail:token); sem ele, um access token do repositório ou do
 * workspace (Bearer).
 */

export const BITBUCKET_TOKEN = 'BITBUCKET_TOKEN';
export const BITBUCKET_EMAIL = 'BITBUCKET_EMAIL';

const API = 'https://api.bitbucket.org/2.0';

function curlBin(): string {
  return process.env.MABEL_CURL_BIN || 'curl';
}

export interface BitbucketAuth {
  token: string;
  email?: string;
}

export function bitbucketAuth(env: NodeJS.ProcessEnv = process.env): BitbucketAuth | undefined {
  const token = env[BITBUCKET_TOKEN]?.trim();
  if (!token) return undefined;
  const email = env[BITBUCKET_EMAIL]?.trim();
  return email ? { token, email } : { token };
}

export interface ApiResult {
  /** Código HTTP; 0 quando o `curl` não chegou a ter resposta. */
  status: number;
  ok: boolean;
  json: unknown;
  /** Mensagem de erro do Bitbucket ou do `curl`. */
  error?: string;
}

/** Valor entre aspas na configuração do `curl`. */
const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Chama a API; `undefined` quando o `curl` não está instalado. */
export function bitbucketApi(auth: BitbucketAuth, method: string, path: string, body?: unknown): ApiResult | undefined {
  const config = auth.email ? `user = ${quoted(`${auth.email}:${auth.token}`)}\n` : `header = ${quoted(`Authorization: Bearer ${auth.token}`)}\n`;
  const dir = body === undefined ? undefined : mkdtempSync(join(tmpdir(), 'mabel-bitbucket-'));
  try {
    const args = ['-sS', '--max-time', '30', '-K', '-', '-X', method, '-H', 'Accept: application/json', '-w', '\n%{http_code}'];
    if (dir) {
      const file = join(dir, 'body.json');
      writeFileSync(file, JSON.stringify(body));
      args.push('-H', 'Content-Type: application/json', '--data-binary', `@${file}`);
    }
    args.push(`${API}${path}`);
    const result = spawnSync(curlBin(), args, { input: config, encoding: 'utf8' });
    if (result.error) return undefined;
    const out = result.stdout ?? '';
    const cut = out.lastIndexOf('\n');
    const status = Number(out.slice(cut + 1)) || 0;
    const text = cut >= 0 ? out.slice(0, cut) : '';
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const ok = result.status === 0 && status >= 200 && status < 300;
    if (ok) return { status, ok, json };
    const message = (json as { error?: { message?: string } } | undefined)?.error?.message;
    return { status, ok, json, error: message || (result.stderr || '').trim() || `HTTP ${status}` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const repoPath = (repo: string) => `/repositories/${repo.split('/').map(encodeURIComponent).join('/')}`;

/** Motivo de não abrir o PR neste repositório, ou `undefined` quando dá para abrir. */
export function bitbucketProblem(auth: BitbucketAuth, repo: string): string | undefined {
  const view = bitbucketApi(auth, 'GET', repoPath(repo));
  if (!view) return 'curl não instalado';
  if (view.ok) return undefined;
  if (view.status === 401 || view.status === 403) return `o Bitbucket recusou o ${BITBUCKET_TOKEN} (HTTP ${view.status}: ${view.error})`;
  if (view.status === 404) return `o ${BITBUCKET_TOKEN} não enxerga o repositório ${repo}`;
  return `o Bitbucket não respondeu (${view.error})`;
}

export interface PullRequestInput {
  title: string;
  description: string;
  source: string;
  destination: string;
  draft?: boolean;
}

/** Abre o PR; devolve o endereço dele ou o erro. */
export function createBitbucketPr(auth: BitbucketAuth, repo: string, input: PullRequestInput): { url: string } | { error: string } {
  const created = bitbucketApi(auth, 'POST', `${repoPath(repo)}/pullrequests`, {
    title: input.title,
    description: input.description,
    source: { branch: { name: input.source } },
    destination: { branch: { name: input.destination } },
    close_source_branch: false,
    ...(input.draft ? { draft: true } : {}),
  });
  if (!created) return { error: 'curl não instalado' };
  const url = (created.json as { links?: { html?: { href?: string } } } | undefined)?.links?.html?.href;
  if (created.ok && url) return { url };
  return { error: created.error ?? 'resposta sem o endereço do PR' };
}

/** Workspace/repositório e número de um endereço de PR do Bitbucket. */
export function bitbucketPr(url: string): { repo: string; id: string } | undefined {
  const match = /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/.exec(url.trim());
  return match ? { repo: `${match[1]}/${match[2]}`, id: match[3] as string } : undefined;
}

/** Recusa (decline) o PR com um comentário. */
export function declineBitbucketPr(auth: BitbucketAuth, url: string, comment: string): boolean {
  const pr = bitbucketPr(url);
  if (!pr) return false;
  const base = `${repoPath(pr.repo)}/pullrequests/${pr.id}`;
  bitbucketApi(auth, 'POST', `${base}/comments`, { content: { raw: comment } });
  return bitbucketApi(auth, 'POST', `${base}/decline`)?.ok === true;
}

/** Estado do PR (`OPEN`, `MERGED`, `DECLINED`, `SUPERSEDED`), ou `undefined`. */
export function bitbucketPrState(auth: BitbucketAuth, url: string): string | undefined {
  const pr = bitbucketPr(url);
  if (!pr) return undefined;
  const view = bitbucketApi(auth, 'GET', `${repoPath(pr.repo)}/pullrequests/${pr.id}`);
  return view?.ok ? (view.json as { state?: string } | undefined)?.state : undefined;
}
