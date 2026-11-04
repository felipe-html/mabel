import { add, addArgs, addOptions, addUsage } from './add.ts';
import { birthArgs, birthCommand, birthOptions, birthUsageFull } from './birth.ts';
import { referenceArgs, referenceCommand, referenceOptions, referenceUsage } from './capture.ts';
import { credentialArgs, credentialCommand, credentialOptions, credentialUsage } from './credentials.ts';
import { completionCommand, completionUsage, commandsCommand, commandsUsage } from './completion.ts';
import { deliverArgs, deliverCommand, deliverOptions, deliverUsage } from './delivery.ts';
import { exec, execArgs, execOptions, execUsage } from './exec.ts';
import {
  approveCommand,
  approveOptions,
  approveUsage,
  cancelCommand,
  cancelUsage,
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
  resumeCommand,
  resumeOptions,
  resumeUsage,
} from './decide.ts';
import { eventsCommand, eventsOptions, eventsUsage } from './events.ts';
import { inboxCommand, inboxOptions, inboxUsage } from './inbox.ts';
import { init, initOptions, initUsage } from './init.ts';
import { type ArgSpec, type OptionSpecs, itemArg } from './options.ts';
import { projectArgs, projectCommand, projectOptions, projectUsage, projectsCommand, projectsOptions, projectsUsage } from './projects.ts';
import { refineArgs, refineCommand, refineOptions, refineUsage } from './refine.ts';
import { specifyArgs, specifyCommand, specifyOptions, specifyUsage } from './specify.ts';
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

/** Grupos da tela inicial, na ordem de quando nada sobe para o topo. */
export const MENU_GROUPS = ['comecar', 'planejar', 'rodar', 'decidir', 'entregar', 'acompanhar', 'avulso'] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];

export const GROUP_TITLES: Record<MenuGroup, string> = {
  comecar: 'Começar',
  planejar: 'Planejar',
  rodar: 'Rodar',
  decidir: 'Decidir',
  entregar: 'Entregar',
  acompanhar: 'Acompanhar',
  avulso: 'Avulso',
};

/** Contagem à direita do comando na tela inicial. */
export type MenuBadge = 'ready' | 'pending' | 'units';

export interface MenuEntry {
  /** Título com verbo, igual ao nome no shell. */
  title: string;
  group: MenuGroup;
  /** Não depende do projeto: aparece também onde o Mabel não foi preparado. */
  global?: boolean;
  badge?: MenuBadge;
}

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
  /** Na tela inicial, o comando abre a tela dele (`src/forms.ts`), que roda isto com os argumentos. */
  run?: (args: string[]) => number | Promise<number>;
  /** Lugar na tela inicial; sem ele, o comando fica só no shell. */
  menu?: MenuEntry;
}

export const commands: Command[] = [
  {
    name: 'preparar',
    description: 'Prepara o projeto atual para o Mabel, detectando a stack pelo código.',
    usage: initUsage,
    options: initOptions,
    run: init,
    menu: { title: 'Preparar este projeto', group: 'comecar' },
  },
  {
    name: 'criar',
    description: 'Conversa com um agente que propõe stack, CLAUDE.md, regras críticas e backlog.',
    usage: birthUsageFull,
    options: birthOptions,
    args: birthArgs,
    run: birthCommand,
    menu: { title: 'Criar um projeto novo', group: 'comecar' },
  },
  {
    name: 'adicionar',
    description: 'Cria um item no backlog do projeto.',
    usage: addUsage,
    options: addOptions,
    args: addArgs,
    run: add,
    menu: { title: 'Adicionar um item', group: 'planejar' },
  },
  {
    name: 'especificar',
    description: 'Lista, valida e aceita as specs; as tarefas ligadas só ficam prontas com a spec aceita.',
    usage: specifyUsage,
    options: specifyOptions,
    args: specifyArgs,
    run: specifyCommand,
    menu: { title: 'Especificar uma funcionalidade', group: 'planejar' },
  },
  {
    name: 'refinar',
    description: 'Um agente propõe critérios, decisões e limites para um item, e você revisa.',
    usage: refineUsage,
    options: refineOptions,
    args: refineArgs,
    run: refineCommand,
    menu: { title: 'Refinar um item', group: 'planejar' },
  },
  {
    name: 'capturar',
    description: 'Guarda uma tela do Figma ou uma API OpenAPI para os itens citarem.',
    usage: referenceUsage,
    options: referenceOptions,
    args: referenceArgs,
    run: referenceCommand,
    menu: { title: 'Capturar uma referência', group: 'planejar' },
  },
  {
    name: 'credenciar',
    description: 'Registra quando vence cada token (Figma, Bitbucket), para o Mabel avisar antes.',
    usage: credentialUsage,
    options: credentialOptions,
    args: credentialArgs,
    run: credentialCommand,
    menu: { title: 'Credenciar um token', group: 'planejar' },
  },
  {
    name: 'rodar',
    description: 'Planeja os itens prontos e depois executa um por um.',
    usage: runUsage,
    options: runOptions,
    run,
    menu: { title: 'Rodar a fila', group: 'rodar', badge: 'ready' },
  },
  {
    name: 'acompanhar',
    description: 'Mostra ao vivo a fila em segundo plano; sair não para a fila.',
    usage: attachUsage,
    run: attachCommand,
    menu: { title: 'Acompanhar a fila', group: 'rodar' },
  },
  {
    name: 'parar',
    description: 'Encerra a fila depois da etapa em andamento.',
    usage: stopUsage,
    options: stopOptions,
    run: stopCommand,
    menu: { title: 'Parar a fila', group: 'rodar' },
  },
  {
    name: 'decidir',
    description: 'Responde perguntas e aprova critérios: uma pendência ou todas, uma por vez.',
    usage: inboxUsage,
    options: inboxOptions,
    run: inboxCommand,
    menu: { title: 'Decidir as pendências', group: 'decidir', badge: 'pending' },
  },
  {
    name: 'aprovar',
    description: 'Aprova os critérios de um item crítico',
    usage: approveUsage,
    options: approveOptions,
    args: [itemArg],
    run: approveCommand,
  },
  {
    name: 'responder',
    description: 'Responde a um item parado em needs_human',
    usage: respondUsage,
    options: respondOptions,
    args: respondArgs,
    run: respondCommand,
  },
  {
    name: 'retomar',
    description: 'Devolve à fila um item parado por falha ou bloqueio, com o motivo à vista.',
    usage: resumeUsage,
    options: resumeOptions,
    args: [itemArg],
    run: resumeCommand,
    menu: { title: 'Retomar um item', group: 'decidir' },
  },
  {
    name: 'cancelar',
    description: 'Tira um item da fila de vez.',
    usage: cancelUsage,
    args: [itemArg],
    run: cancelCommand,
    menu: { title: 'Cancelar um item', group: 'decidir' },
  },
  {
    name: 'entregar',
    description: 'Mostra as unidades prontas, prova uma contra a base e abre o PR.',
    usage: deliverUsage,
    options: deliverOptions,
    args: deliverArgs,
    run: deliverCommand,
    menu: { title: 'Entregar uma unidade', group: 'entregar', badge: 'units' },
  },
  {
    name: 'rejeitar',
    description: 'Desfaz um item na integração e o devolve ao planejamento.',
    usage: rejectUsage,
    options: rejectOptions,
    args: rejectArgs,
    run: rejectCommand,
    menu: { title: 'Rejeitar um item', group: 'entregar' },
  },
  {
    name: 'conferir',
    description: 'Mostra a fila, as etapas em andamento e as duas janelas de saldo.',
    usage: statusUsage,
    options: balanceOptions,
    run: status,
    menu: { title: 'Conferir o estado', group: 'acompanhar' },
  },
  {
    name: 'detalhar',
    description: 'Mostra estado, pendência, plano, custo e runs de um item.',
    usage: itemUsage,
    args: [itemArg],
    run: itemCommand,
    menu: { title: 'Detalhar um item', group: 'acompanhar' },
  },
  {
    name: 'consultar',
    description: 'Lista as runs auditadas e mostra o detalhe e as ferramentas de cada uma.',
    usage: runsUsage,
    options: runsOptions,
    args: runsArgs,
    run: runsCommand,
    menu: { title: 'Consultar as runs', group: 'acompanhar' },
  },
  {
    name: 'listar',
    description: 'Lista os projetos registrados, com itens, runs, custo e última atividade.',
    usage: projectsUsage,
    options: projectsOptions,
    run: projectsCommand,
    menu: { title: 'Listar os projetos', group: 'acompanhar', global: true },
  },
  {
    name: 'auditar',
    description: 'Mostra a auditoria de um projeto e permite remover os dados dele do Mabel.',
    usage: projectUsage,
    options: projectOptions,
    args: projectArgs,
    run: projectCommand,
    menu: { title: 'Auditar um projeto', group: 'acompanhar', global: true },
  },
  {
    name: 'pedir',
    description: 'Manda um prompt ao Claude Code fora da fila, com auditoria.',
    usage: execUsage,
    options: execOptions,
    args: execArgs,
    run: exec,
    menu: { title: 'Pedir algo avulso', group: 'avulso', global: true },
  },
  {
    name: 'saldo',
    description: 'Mostra as duas janelas de saldo e a pausa da fila por saldo, se houver',
    usage: balanceUsage,
    options: balanceOptions,
    run: balanceCommand,
  },
  {
    name: 'supervisor',
    description: 'Processo que roda as filas em segundo plano; `instalar` o põe no launchd',
    usage: supervisorUsage,
    args: supervisorArgs,
    run: supervisorCommand,
  },
  {
    name: 'eventos',
    description: 'Fluxo de eventos de todos os projetos, uma linha de JSON por evento, até ser encerrado',
    usage: eventsUsage,
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
    args: [
      { name: 'zsh', description: 'Shell do script', choices: [{ name: 'zsh', description: 'Script para o .zshrc' }] },
    ],
    run: (args) => completionCommand(commands, args),
  },
];

export function findCommand(name: string): Command | undefined {
  return commands.find((command) => command.name === name);
}
