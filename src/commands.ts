import { add, addUsage } from './add.ts';
import { referenceCommand, referenceUsage } from './capture.ts';
import { credentialCommand, credentialUsage } from './credentials.ts';
import { zshCompletion } from './completion.ts';
import { deliverCommand, deliverUsage } from './delivery.ts';
import { askPrompt, exec, execUsage } from './exec.ts';
import {
  approveCommand,
  approveUsage,
  askCancel,
  askItemNumber,
  askReject,
  askRespond,
  cancelCommand,
  cancelUsage,
  integrationCommand,
  integrationUsage,
  itemCommand,
  itemUsage,
  rejectCommand,
  rejectUsage,
  respondCommand,
  respondUsage,
} from './decide.ts';
import { eventsCommand, eventsUsage } from './events.ts';
import { inboxCommand, inboxUsage } from './inbox.ts';
import { init, initUsage } from './init.ts';
import { projectCommand, projectUsage, projectsCommand, projectsUsage } from './projects.ts';
import { refineCommand, refineUsage } from './refine.ts';
import { run, runUsage } from './run.ts';
import { runsCommand, runsUsage } from './runs.ts';
import { status } from './status.ts';

export interface Command {
  name: string;
  description: string;
  usage: string;
  /** Passo do plano em que o comando será implementado; ausente quando já está disponível. */
  plannedStep?: number;
  run?: (args: string[]) => number | Promise<number>;
  /** Pede os argumentos quando o comando é chamado sem eles no modo Mabel. */
  promptArgs?: () => string[] | Promise<string[]>;
  /** Só faz sentido no shell; não aparece no modo Mabel. */
  shellOnly?: boolean;
}

export const commands: Command[] = [
  {
    name: 'init',
    description: 'Prepara o projeto atual para o Mabel',
    usage: initUsage,
    run: init,
  },
  {
    name: 'add',
    description: 'Adiciona um item ao backlog do projeto',
    usage: addUsage,
    run: add,
  },
  {
    name: 'refinar',
    description: 'Pede a um agente uma proposta de critérios, decisões e limites de um item, para você revisar',
    usage: refineUsage,
    run: refineCommand,
  },
  {
    name: 'referencia',
    description: 'Captura telas e APIs para os itens citarem em "Referências:"; sem argumentos, lista',
    usage: referenceUsage,
    run: referenceCommand,
  },
  {
    name: 'credencial',
    description: 'Registra e mostra a validade dos tokens usados na captura (FIGMA_TOKEN)',
    usage: credentialUsage,
    run: credentialCommand,
  },
  {
    name: 'run',
    description: 'Consome a fila: planeja os itens prontos, depois executa',
    usage: runUsage,
    run,
  },
  {
    name: 'item',
    description: 'Mostra o detalhe de um item: estado, pendência, plano, custo e runs',
    usage: itemUsage,
    promptArgs: askItemNumber,
    run: itemCommand,
  },
  {
    name: 'aprovar',
    description: 'Aprova os critérios de um item crítico',
    usage: approveUsage,
    promptArgs: askItemNumber,
    run: approveCommand,
  },
  {
    name: 'responder',
    description: 'Responde a um item parado em needs_human',
    usage: respondUsage,
    promptArgs: askRespond,
    run: respondCommand,
  },
  {
    name: 'cancelar',
    description: 'Cancela um item',
    usage: cancelUsage,
    promptArgs: askCancel,
    run: cancelCommand,
  },
  {
    name: 'integracao',
    description: 'Mostra o relatório da branch de integração: o que levar à base e o que olhar primeiro',
    usage: integrationUsage,
    run: integrationCommand,
  },
  {
    name: 'rejeitar',
    description: 'Reverte um item na integração e o devolve ao planejamento (ou o cancela)',
    usage: rejectUsage,
    promptArgs: askReject,
    run: rejectCommand,
  },
  {
    name: 'entregar',
    description: 'Publica um snapshot da integração e abre o PR com o relatório; volta o checkout para a base',
    usage: deliverUsage,
    run: deliverCommand,
  },
  {
    name: 'exec',
    description: 'Executa um prompt avulso no Claude Code, com auditoria',
    usage: execUsage,
    promptArgs: askPrompt,
    run: exec,
  },
  {
    name: 'status',
    description: 'Mostra a fila, as etapas em andamento e o saldo',
    usage: 'mabel status [--atualizar]',
    run: status,
  },
  {
    name: 'runs',
    description: 'Lista as runs auditadas; com um id, mostra o detalhe e as ferramentas usadas',
    usage: runsUsage,
    run: runsCommand,
  },
  {
    name: 'inbox',
    description: 'Responde às decisões que aguardam você, uma por vez',
    usage: inboxUsage,
    run: inboxCommand,
  },
  {
    name: 'projetos',
    description: 'Lista os projetos registrados: itens, runs, custo e última atividade',
    usage: projectsUsage,
    run: projectsCommand,
  },
  {
    name: 'projeto',
    description: 'Auditoria de um projeto; `remover` apaga os dados dele no Mabel',
    usage: projectUsage,
    run: projectCommand,
  },
  {
    name: 'eventos',
    description: 'Fluxo de eventos de todos os projetos, uma linha de JSON por evento, até ser encerrado',
    usage: eventsUsage,
    shellOnly: true,
    run: eventsCommand,
  },
  {
    name: 'completion',
    description: 'Gera o script de autocompletar do shell',
    usage: 'mabel completion zsh',
    shellOnly: true,
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
