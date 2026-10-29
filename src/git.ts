import { spawnSync } from 'node:child_process';

export class GitError extends Error {}

/** Roda `git` no diretório dado e devolve o stdout sem a quebra de linha final. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw new GitError(`git indisponível: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new GitError(`git ${args.join(' ')} falhou: ${detail}`);
  }
  return result.stdout.replace(/\n$/, '');
}

/** Como `git`, mas devolve `undefined` em vez de lançar quando o comando falha. */
export function tryGit(cwd: string, ...args: string[]): string | undefined {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined;
  }
}

/** Como `git`, com stdin e variáveis de ambiente (índice temporário, por exemplo). */
export function gitWith(cwd: string, options: { input?: string; env?: Record<string, string> }, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input: options.input, env: { ...process.env, ...options.env } });
  if (result.error) throw new GitError(`git indisponível: ${result.error.message}`);
  if (result.status !== 0) throw new GitError(`git ${args.join(' ')} falhou: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.replace(/\n$/, '');
}

/** Trailers do Mabel no fim da mensagem de commit (`git log --grep 'Mabel-Unidade: x'`). */
export function withTrailers(message: string, trailers: Record<string, string>): string {
  return `${message}\n\n${Object.entries(trailers).map(([key, value]) => `${key}: ${value}`).join('\n')}`;
}
