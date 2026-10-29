import { add, addArgs, addOptions, addUsage } from './add.ts';
import { birthArgs, birthCommand, birthOptions, birthUsageFull } from './birth.ts';
import { referenceArgs, referenceCommand, referenceOptions, referenceUsage } from './capture.ts';
import { credentialArgs, credentialCommand, credentialOptions, credentialUsage } from './credentials.ts';
import { completionCommand, completionUsage, commandsCommand, commandsUsage } from './completion.ts';
import { deliverCommand, deliverOptions, deliverUsage } from './delivery.ts';
import { askPrompt, exec, execArgs, execOptions, execUsage } from './exec.ts';
import {
  approveCommand,
  approveOptions,
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
  rejectArgs,
  rejectCommand,
  rejectOptions,
  rejectUsage,
  respondArgs,
  respondCommand,
  respondOptions,
  respondUsage,
} from './decide.ts';
import { eventsCommand, eventsOptions, eventsUsage } from './events.ts';
import { inboxCommand, inboxOptions, inboxUsage } from './inbox.ts';
import { init, initOptions, initUsage } from './init.ts';
import { type ArgSpec, type OptionSpecs, itemArg } from './options.ts';
import { projectArgs, projectCommand, projectOptions, projectUsage, projectsCommand, projectsOptions, projectsUsage } from './projects.ts';
import { refineArgs, refineCommand, refineOptions, refineUsage } from './refine.ts';
import { run, runOptions, runUsage } from './run.ts';
import { runsArgs, runsCommand, runsOptions, runsUsage } from './runs.ts';
import {
  attachCommand,
  attachUsage,
  stopCommand,
  stopOptions,
  stopUsage,
  supervisorArgs,
  supervisorCommand,
  supervisorUsage,
} from './supervisor.ts';
import { balanceCommand, balanceOptions, balanceUsage, status, statusUsage } from './status.ts';

export interface Command {
  name: string;
  description: string;
  usage: string;
  /** Opções aceitas, com a explicação de cada uma; a mesma declaração vai para o `parseArgs`. */
  options?: OptionSpecs;
  /** Argumentos posicionais, na ordem. */
  args?: ArgSpec[];
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
    options: initOptions,
    run: init,
  },
  {
    name: 'nascer',
    description: 'Conversa com um agente que propõe stack, CLAUDE.md, regras críticas e backlog de um projeto novo',
    usage: birthUsageFull,
    options: birthOptions,
    args: birthArgs,
    run: birthCommand,
  },
  {
    name: 'add',
    description: 'Adiciona um item ao backlog do projeto',
    usage: addUsage,
    options: addOptions,
    args: addArgs,
    run: add,
  },
  {
    name: 'refinar',
    description: 'Pede a um agente uma proposta de critérios, decisões e limites de um item, para você revisar',
    usage: refineUsage,
    options: refineOptions,
    args: refineArgs,
    run: refineCommand,
  },
  {
    name: 'referencia',
    description: 'Captura telas e APIs para os itens citarem em "Referências:"; sem argumentos, lista',
    usage: referenceUsage,
    options: referenceOptions,
    args: referenceArgs,
    run: referenceCommand,
  },
  {
    name: 'credencial',
    description: 'Registra e mostra a validade dos tokens usados na captura (FIGMA_TOKEN)',
    usage: credentialUsage,
    options: credentialOptions,
    args: credentialArgs,
    run: credentialCommand,
  },
  {
    name: 'run',
    description: 'Consome a fila: planeja os itens prontos, depois executa',
    usage: runUsage,
    options: runOptions,
    run,
  },
  {
    name: 'anexar',
    description: 'Acompanha ao vivo a fila em segundo plano do projeto; ctrl+c solta sem parar',
    usage: attachUsage,
    run: attachCommand,
  },
  {
    name: 'parar',
    description: 'Para a fila do projeto depois da etapa em andamento',
    usage: stopUsage,
    options: stopOptions,
    run: stopCommand,
  },
  {
    name: 'supervisor',
    description: 'Processo que roda as filas em segundo plano; `instalar` o põe no launchd',
    usage: supervisorUsage,
    shellOnly: true,
    args: supervisorArgs,
    run: supervisorCommand,
  },
  {
    name: 'item',
    description: 'Mostra o detalhe de um item: estado, pendência, plano, custo e runs',
    usage: itemUsage,
    promptArgs: askItemNumber,
    args: [itemArg],
    run: itemCommand,
  },
  {
    name: 'aprovar',
    description: 'Aprova os critérios de um item crítico',
    usage: approveUsage,
    promptArgs: askItemNumber,
    options: approveOptions,
    args: [itemArg],
    run: approveCommand,
  },
  {
    name: 'responder',
    description: 'Responde a um item parado em needs_human',
    usage: respondUsage,
    promptArgs: askRespond,
    options: respondOptions,
    args: respondArgs,
    run: respondCommand,
  },
  {
    name: 'cancelar',
    description: 'Cancela um item',
    usage: cancelUsage,
    promptArgs: askCancel,
    args: [itemArg],
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
    options: rejectOptions,
    args: rejectArgs,
    run: rejectCommand,
  },
  {
    name: 'entregar',
    description: 'Publica um snapshot da integração e abre o PR com o relatório; volta o checkout para a base',
    usage: deliverUsage,
    options: deliverOptions,
    run: deliverCommand,
  },
  {
    name: 'exec',
    description: 'Executa um prompt avulso no Claude Code, com auditoria',
    usage: execUsage,
    promptArgs: askPrompt,
    options: execOptions,
    args: execArgs,
    run: exec,
  },
  {
    name: 'status',
    description: 'Mostra a fila, as etapas em andamento e o saldo',
    usage: statusUsage,
    options: balanceOptions,
    run: status,
  },
  {
    name: 'saldo',
    description: 'Mostra as duas janelas de saldo e a pausa da fila por saldo, se houver',
    usage: balanceUsage,
    options: balanceOptions,
    run: balanceCommand,
  },
  {
    name: 'runs',
    description: 'Lista as runs auditadas; com um id, mostra o detalhe e as ferramentas usadas',
    usage: runsUsage,
    options: runsOptions,
    args: runsArgs,
    run: runsCommand,
  },
  {
    name: 'inbox',
    description: 'Responde às decisões que aguardam você, uma por vez',
    usage: inboxUsage,
    options: inboxOptions,
    run: inboxCommand,
  },
  {
    name: 'projetos',
    description: 'Lista os projetos registrados: itens, runs, custo e última atividade',
    usage: projectsUsage,
    options: projectsOptions,
    run: projectsCommand,
  },
  {
    name: 'projeto',
    description: 'Auditoria de um projeto; `remover` apaga os dados dele no Mabel',
    usage: projectUsage,
    options: projectOptions,
    args: projectArgs,
    run: projectCommand,
  },
  {
    name: 'eventos',
    description: 'Fluxo de eventos de todos os projetos, uma linha de JSON por evento, até ser encerrado',
    usage: eventsUsage,
    shellOnly: true,
    options: eventsOptions,
    run: eventsCommand,
  },
  {
    name: 'comandos',
    description: 'Lista os comandos com as opções e argumentos de cada um, explicados',
    usage: commandsUsage,
    options: { json: { type: 'boolean', description: 'O catálogo em JSON, para outros programas montarem formulários' } },
    run: (args) => commandsCommand(commands, args),
  },
  {
    name: 'completion',
    description: 'Gera o script de autocompletar do shell',
    usage: completionUsage,
    shellOnly: true,
    args: [
      { name: 'zsh', description: 'Shell do script', choices: [{ name: 'zsh', description: 'Script para o .zshrc' }] },
    ],
    run: (args) => completionCommand(commands, args),
  },
];

export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}
