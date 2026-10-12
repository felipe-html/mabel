import { spawn as nodeSpawn } from 'node:child_process';

/** Aviso do sistema: título e mensagem. */
export type Notify = (title: string, message: string) => void;

/** Dependências trocadas nos testes. */
export interface NotifyDeps {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Script fixo: o texto chega por `argv`, nunca interpolado no AppleScript. */
const SCRIPT = [
  '-e',
  'on run argv',
  '-e',
  'display notification (item 2 of argv) with title (item 1 of argv)',
  '-e',
  'end run',
];

/**
 * Notificação do macOS via `osascript`, sem esperar por ela. Só no macOS e com
 * `MABEL_NOTIFICAR` diferente de `0`; qualquer falha é ignorada.
 */
export function notify(title: string, message: string, deps: NotifyDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  if (platform !== 'darwin' || env.MABEL_NOTIFICAR === '0') return;
  try {
    const child = (deps.spawn ?? nodeSpawn)('osascript', [...SCRIPT, title, message], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Aviso é conveniência: sem osascript, a esteira segue.
  }
}
