import { zshCompletion } from './completion.ts';
import { askPrompt, exec, execUsage } from './exec.ts';

export interface Command {
  name: string;
  description: string;
  usage: string;
  /** Passo do plano em que o comando será implementado; ausente quando já está disponível. */
  plannedStep?: number;
  run?: (args: string[]) => number | Promise<number>;
  /** Argumentos usados quando o comando é escolhido no menu interativo. */
  menuArgs?: () => string[] | Promise<string[]>;
}

export const commands: Command[] = [
  {
    name: 'init',
    description: 'Prepara o projeto atual para o Mabel',
    usage: 'mabel init',
    plannedStep: 3,
  },
  {
    name: 'add',
    description: 'Adiciona um item ao backlog do projeto',
    usage: 'mabel add "<título do item>"',
    plannedStep: 3,
  },
  {
    name: 'run',
    description: 'Consome a fila do backlog, item a item',
    usage: 'mabel run',
    plannedStep: 4,
  },
  {
    name: 'exec',
    description: 'Executa um prompt avulso no Claude Code, com auditoria',
    usage: execUsage,
    menuArgs: askPrompt,
    run: exec,
  },
  {
    name: 'status',
    description: 'Mostra a fila, as etapas em andamento e o saldo',
    usage: 'mabel status',
    plannedStep: 2,
  },
  {
    name: 'inbox',
    description: 'Lista as decisões que aguardam você',
    usage: 'mabel inbox',
    plannedStep: 5,
  },
  {
    name: 'completion',
    description: 'Gera o script de autocompletar do shell',
    usage: 'mabel completion zsh',
    menuArgs: () => ['zsh'],
    run: (args) => {
      if (args[0] !== 'zsh') {
        process.stderr.write('Shell não suportado. Uso: mabel completion zsh\n');
        return 1;
      }
      process.stdout.write(zshCompletion(commands));
      return 0;
    },
  },
];

export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}
