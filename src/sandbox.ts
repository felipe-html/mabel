import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tryGit } from './git.ts';
import type { Project } from './project.ts';
import { STACKS, detectCommands, frameworkDomains } from './stacks.ts';

/**
 * Sandbox do Claude Code nas etapas (G4, terminal e rede): o `Bash` só escreve no worktree
 * e no temporário, e só alcança os domínios liberados. Arquivos e chaves confirmados na
 * validação de 2026-10-13 (`docs/specs/passo-5.md`).
 */

/**
 * Domínios liberados: os do config ou, sem o campo, os das stacks e frameworks detectados
 * no projeto.
 */
export function allowedDomains(project: Project): string[] {
  if (project.config.rede) return [...project.config.rede];
  const stacks = detectCommands(project.root).stacks.flatMap((stack) => stack.rede);
  return [...new Set([...stacks, ...frameworkDomains(project.root)])];
}

/**
 * Caches dos gerenciadores de pacotes, para `npm install` e afins: os das stacks detectadas
 * e os das stacks cujo registro está na `rede` do config (projeto vazio ainda sem arquivos).
 */
export function packageCaches(project: Project): string[] {
  const rede = project.config.rede ?? [];
  const stacks = [
    ...detectCommands(project.root).stacks,
    ...STACKS.filter((stack) => stack.rede.some((domain) => rede.includes(domain))),
  ];
  return [...new Set(stacks.flatMap((stack) => stack.caches))];
}

/**
 * `.git` do repositório principal. Num worktree ligado, o sandbox libera a escrita nele para
 * o `git commit` funcionar; o Mabel o fecha, porque só ele faz commit e move refs.
 */
export function gitCommonDir(root: string): string {
  const dir = tryGit(root, 'rev-parse', '--git-common-dir') ?? '.git';
  const absolute = isAbsolute(dir) ? dir : join(root, dir);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

export interface SandboxSettings {
  enabled: true;
  failIfUnavailable: true;
  allowUnsandboxedCommands: false;
  network: { allowedDomains: string[]; strictAllowlist: true; allowLocalBinding: true };
  filesystem: { allowWrite: string[]; denyWrite: string[] };
}

export function sandboxSettings(project: Project): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    // Porta local: bundlers (Turbopack, loaders do Next) sobem processos auxiliares em localhost.
    network: { allowedDomains: allowedDomains(project), strictAllowlist: true, allowLocalBinding: true },
    filesystem: { allowWrite: packageCaches(project), denyWrite: [gitCommonDir(project.root)] },
  };
}

function onPath(command: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}

/**
 * O sistema tem o que o sandbox do Claude Code usa: `sandbox-exec` no macOS, `bubblewrap` e
 * `socat` no Linux. Devolve o motivo quando falta.
 */
export function sandboxUnavailable(platform: NodeJS.Platform = process.platform): string | undefined {
  if (process.env.MABEL_SANDBOX_INDISPONIVEL) return process.env.MABEL_SANDBOX_INDISPONIVEL;
  if (platform === 'darwin') return existsSync('/usr/bin/sandbox-exec') ? undefined : 'sandbox-exec não encontrado';
  if (platform === 'linux') {
    const missing = ['bwrap', 'socat'].filter((command) => !onPath(command));
    return missing.length > 0 ? `falta ${missing.join(' e ')} (instale bubblewrap e socat)` : undefined;
  }
  return `o sandbox do Claude Code não roda em ${platform}`;
}

/**
 * Sandbox da run de nascimento: sem projeto nem config, nada liberado além do padrão. A
 * etapa só lê (sem `Bash`); o sandbox fica ligado pelas mesmas travas das outras etapas.
 */
export function birthSandbox(root: string): SandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: true },
    filesystem: { allowWrite: [], denyWrite: [gitCommonDir(root)] },
  };
}
