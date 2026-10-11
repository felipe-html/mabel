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
