import { add, addUsage } from './add.ts';
import { zshCompletion } from './completion.ts';
import { askPrompt, exec, execUsage } from './exec.ts';
import {
  approveCommand,
  approveUsage,
  askCancel,
  askItemNumber,
  askRespond,
  cancelCommand,
  cancelUsage,
  itemCommand,
  itemUsage,
  respondCommand,
  respondUsage,
} from './decide.ts';
import { init } from './init.ts';
import { run, runUsage } from './run.ts';
import { status } from './status.ts';

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
    run: init,
  },
  {
    name: 'add',
    description: 'Adiciona um item ao backlog do projeto',
    usage: addUsage,
    run: add,
  },
  {
    name: 'run',
    description: 'Consome a fila do backlog, item a item',
    usage: runUsage,
    run,
  },
  {
    name: 'item',
    description: 'Mostra o detalhe de um item: estado, pendência, plano, custo e runs',
    usage: itemUsage,
    menuArgs: askItemNumber,
    run: itemCommand,
  },
  {
    name: 'aprovar',
    description: 'Aprova os critérios de um item crítico',
    usage: approveUsage,
    menuArgs: askItemNumber,
    run: approveCommand,
  },
  {
    name: 'responder',
    description: 'Responde a um item parado em needs_human',
    usage: respondUsage,
    menuArgs: askRespond,
    run: respondCommand,
  },
  {
    name: 'cancelar',
    description: 'Cancela um item',
    usage: cancelUsage,
    menuArgs: askCancel,
    run: cancelCommand,
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
    usage: 'mabel status [--atualizar]',
    run: status,
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
