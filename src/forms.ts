import type { DatabaseSync } from 'node:sqlite';
import { addForm } from './add.ts';
import { type CatalogEntry, isLink, referenceCatalog } from './capture.ts';
import { CREDENTIALS } from './credentials.ts';
import { dataDir, openDb, processAlive } from './db.ts';
import { RESUMABLE } from './decisions.ts';
import { unitArg, unitLabel } from './delivery.ts';
import { formatCost } from './format.ts';
import { itemOptions } from './guided.ts';
import { pendingItems } from './inbox.ts';
import { FORMAT_ERROR_PREFIX, type Item, TRANSITIONS, listItems, syncBacklog } from './items.ts';
import { lockHolder } from './lock.ts';
import { type Project, gitRoot, readConfig, resolveProject } from './project.ts';
import { type ProjectRow, listProjects } from './projects.ts';
import { refinableItems } from './refine.ts';
import { type FormConfig, type FormField, type FormValues, shellLine } from './screens.ts';
import { getSpecRecord, listSpecFiles } from './specs.ts';
import { latestSpecProposal } from './specify.ts';
import { STACKS } from './stacks.ts';
import { queueFinished, readQueueState } from './supervisor.ts';
import { style } from './style.ts';
import { type Unit, openUnits } from './units.ts';

/**
 * A tela de cada comando do menu (`docs/specs/terminal.md`, seção "Telas"), como no
 * protótipo: formulário, vista ou fluxo. O botão de um formulário roda o comando com os
 * mesmos argumentos da linha "$ mabel …" embaixo dele; quem desenha e roda é `src/home.ts`.
 */

// Dados ----------------------------------------------------------------------------------

/** O que as telas listam: itens, specs, unidades, projetos e a fila. */
export interface ScreenData {
  /** Há projeto preparado no diretório; sem ele, as listas do projeto ficam vazias. */
  project: boolean;
  items: Item[];
  /** Itens que ainda podem ser refinados (no backlog ou prontos, nunca planejados). */
  refinable: Item[];
  pending: Item[];
  catalog: CatalogEntry[];
  specs: { slug: string; hint: string }[];
  /** Unidades com tarefa concluída e não entregue; vazio sem a branch de integração. */
  units: Unit[];
  integration: boolean;
  projects: ProjectRow[];
  /** `mabel rodar` do projeto rodando (num terminal ou em segundo plano). */
  queueRunning: boolean;
  /** Fila em segundo plano rodando, para o "Acompanhar a fila". */
  background: boolean;
}

export const EMPTY_DATA: ScreenData = {
  project: false,
  items: [],
  refinable: [],
  pending: [],
  catalog: [],
  specs: [],
  units: [],
  integration: false,
  projects: [],
  queueRunning: false,
  background: false,
};

function specHints(db: DatabaseSync, project: Project, items: Item[]): { slug: string; hint: string }[] {
  return listSpecFiles(project.root).map((slug) => {
    const status = getSpecRecord(db, project.id, slug)?.status ?? 'rascunho';
    const tasks = items.filter((item) => item.spec === slug && item.status !== 'cancelled').length;
    const proposal = latestSpecProposal(db, project.id, slug)?.status === 'proposed' ? ' · proposta pendente' : '';
    return { slug, hint: `${status} · ${tasks === 0 ? 'sem tarefas' : `${tasks} ${tasks === 1 ? 'tarefa' : 'tarefas'}`}${proposal}` };
  });
}

/** Lê os dados das telas. Nunca lança: o que falha fica vazio, e o comando explica o erro. */
export function loadScreenData(cwd = process.cwd()): ScreenData {
  const home = dataDir();
  let db: DatabaseSync;
  try {
    db = openDb(home);
  } catch {
    return EMPTY_DATA;
  }
  let data: ScreenData = EMPTY_DATA;
  try {
    data = { ...EMPTY_DATA, projects: listProjects(db) };
    const root = gitRoot(cwd);
    if (!root || !readConfig(root)) return data;
    const project = resolveProject(db, root);
    syncBacklog(db, project);
    const items = listItems(db, project.id);
    const holder = lockHolder(home, project.id);
    const queue = readQueueState(home, project.id);
    return {
      ...data,
      project: true,
      items,
      refinable: refinableItems(db, project),
      pending: pendingItems(db, project.id),
      catalog: referenceCatalog(project.root, items),
      specs: specHints(db, project, items),
      units: project.config.integracao ? openUnits(db, project, items) : [],
      integration: project.config.integracao !== null,
      queueRunning: holder !== undefined && !queueFinished(db, project.id),
      background: queue !== undefined && queue.desired === 'rodando' && processAlive(queue.pid),
    };
  } catch {
    return data;
  } finally {
    db.close();
  }
}

// Formulários ----------------------------------------------------------------------------

/**
 * Como o botão roda o comando. `view`: sem perguntas, exatamente como a linha de shell fora
 * do TTY, e o resultado numa vista. `terminal`: no terminal comum, com as rodadas e
 * revisões de hoje; `headless` tira as perguntas que o formulário já respondeu.
 */
export type RunMode = 'view' | 'terminal';

export interface CommandForm {
  /** Campos, botão e a linha de shell (montada a partir de `args`). */
  config: FormConfig;
  /** Argumentos do comando, na ordem da linha de shell. */
  args: (values: FormValues) => string[];
  mode: (values: FormValues) => RunMode;
  headless?: boolean;
  /** Linhas esmaecidas depois do resultado, na vista ("Próximo passo: …"). */
  next?: (values: FormValues) => string[];
}

const text = (values: FormValues, key: string) => (typeof values[key] === 'string' ? (values[key] as string).trim() : '');
const list = (values: FormValues, key: string) => (Array.isArray(values[key]) ? (values[key] as string[]) : []);
const flag = (values: FormValues, key: string, name: string) => (values[key] ? [name] : []);
const option = (values: FormValues, key: string, name: string) => (text(values, key) ? [name, text(values, key)] : []);
const many = (values: FormValues, key: string, name: string) => list(values, key).flatMap((value) => [name, value]);

const view = () => 'view' as const;
const terminal = () => 'terminal' as const;

/** Liga o formulário ao comando: título e descrição do menu, nome no shell e a linha "$ mabel …". */
function form(name: string, config: Omit<FormConfig, 'command' | 'shell'>, rest: Omit<CommandForm, 'config'>): CommandForm {
  return { ...rest, config: { ...config, command: name, shell: (values) => shellLine(['mabel', name, ...rest.args(values)]) } };
}

/** Campo "Item": a lista só com os itens no estado em que o comando faz sentido. */
function itemField(items: Item[], settings: Partial<FormField> = {}): FormField {
  return { type: 'pick', key: 'item', label: 'Item', required: true, options: () => itemOptions(items), ...settings } as FormField;
}

const itemOf = (items: Item[], values: FormValues) => items.find((item) => String(item.number) === text(values, 'item'));

const MODELS: [string, string][] = [
  ['', 'sonnet (padrão)'],
  ['opus', 'opus'],
  ['haiku', 'haiku'],
];

const stackChoices = (none: string): [string, string][] => [['', none], ...STACKS.map((stack): [string, string] => [stack.id, stack.label])];

/** Título e descrição de cada comando no menu; os formulários repetem. */
const head = (title: string, description: string) => ({ title, description });

export const FORMS: Record<string, (data: ScreenData) => CommandForm> = {
  preparar: () =>
    form(
      'preparar',
      {
        ...head('Preparar este projeto', 'Prepara o projeto atual para o Mabel, detectando a stack pelo código.'),
        fields: [{ type: 'choice', key: 'stack', label: 'Stack', options: stackChoices('detectar pelo código') }],
        action: 'Preparar o projeto',
      },
      { args: (v) => option(v, 'stack', '--stack'), mode: terminal },
    ),

  criar: () =>
    form(
      'criar',
      {
        ...head('Criar um projeto novo', 'Conversa com um agente que propõe stack, CLAUDE.md, regras críticas e backlog.'),
        fields: [
          { type: 'text', key: 'desc', label: 'Descrição', required: true, placeholder: 'o que o projeto vai ser, em poucas frases' },
          { type: 'choice', key: 'stack', label: 'Stack', options: stackChoices('deixar o agente propor') },
          { type: 'choice', key: 'modelo', label: 'Modelo', options: MODELS },
        ],
        action: 'Começar a conversa',
      },
      { args: (v) => [...(text(v, 'desc') ? [text(v, 'desc')] : []), ...option(v, 'stack', '--stack'), ...option(v, 'modelo', '--modelo')], mode: terminal },
    ),

  adicionar: (data) => {
    return form('adicionar', addForm(data.catalog, data.items), {
      args: addFormArgs,
      mode: view,
      next: () => ['Próximo passo: Refinar um item, para o agente propor critérios e limites.'],
    });
  },

  especificar: (data) =>
    form(
      'especificar',
      {
        ...head('Especificar uma funcionalidade', 'Lista, valida e aceita as specs; as tarefas ligadas só ficam prontas com a spec aceita.'),
        fields: [
          {
            type: 'pick',
            key: 'spec',
            label: 'Spec',
            required: true,
            options: () => data.specs.map((spec) => ({ value: spec.slug, label: spec.slug, hint: spec.hint })),
          },
          {
            type: 'choice',
            key: 'acao',
            label: 'O que fazer',
            options: [
              ['', 'validar e mostrar'],
              ['--refazer', 'pedir outra proposta ao agente'],
              ['--aceitar', 'aceitar sem revisar'],
              ['--descartar', 'descartar a proposta pendente'],
            ],
          },
        ],
        action: 'Abrir a spec',
      },
      { args: (v) => [...(text(v, 'spec') ? [text(v, 'spec')] : []), ...(text(v, 'acao') ? [text(v, 'acao')] : [])], mode: terminal },
    ),

  refinar: (data) =>
    form(
      'refinar',
      {
        ...head('Refinar um item', 'Um agente propõe critérios, decisões e limites para um item, e você revisa.'),
        fields: [
          itemField(data.refinable),
          {
            type: 'choice',
            key: 'acao',
            label: 'O que fazer',
            options: [
              ['', 'pedir a proposta ao agente'],
              ['--refazer', 'pedir outra proposta'],
              ['--aceitar', 'aceitar a proposta sem revisar'],
              ['--descartar', 'descartar a proposta pendente'],
              ['--referencias', 'só escolher referências, sem agente'],
            ],
          },
        ],
        action: 'Refinar',
      },
      { args: (v) => [...(text(v, 'item') ? [text(v, 'item')] : []), ...(text(v, 'acao') ? [text(v, 'acao')] : [])], mode: terminal },
    ),

  capturar: () => {
    const screen = (v: FormValues) => text(v, 'tipo') !== 'api';
    return form(
      'capturar',
      {
        ...head('Capturar uma referência', 'Guarda uma tela do Figma ou uma API OpenAPI para os itens citarem.'),
        fields: [
          { type: 'choice', key: 'tipo', label: 'Tipo', options: [['tela', 'tela do Figma'], ['api', 'API OpenAPI ou Swagger']] },
          { type: 'text', key: 'nome', label: 'Nome', required: true, placeholder: 'minúsculas, dígitos e hífen' },
          { type: 'text', key: 'origem', label: 'Link do Figma ou arquivo PNG', required: true, placeholder: 'link do frame (com node-id) ou caminho do PNG', when: screen },
          { type: 'text', key: 'url', label: 'Endereço', required: true, placeholder: 'URL do OpenAPI ou do Swagger', when: (v) => !screen(v) },
          // A escala só vale para o que é baixado do Figma; o PNG local é copiado como está.
          {
            type: 'choice',
            key: 'escala',
            label: 'Escala da imagem',
            options: [['', '2 (padrão)'], ['1', '1'], ['3', '3'], ['4', '4']],
            when: (v) => screen(v) && isLink(text(v, 'origem')),
          },
        ],
        action: 'Capturar',
      },
      {
        args: (v) => {
          const source = text(v, screen(v) ? 'origem' : 'url');
          return [
            screen(v) ? 'tela' : 'api',
            ...(text(v, 'nome') ? [text(v, 'nome')] : []),
            ...(source ? [source] : []),
            ...(screen(v) && isLink(source) ? option(v, 'escala', '--escala') : []),
          ];
        },
        mode: view,
      },
    );
  },

  credenciar: () =>
    form(
      'credenciar',
      {
        ...head('Credenciar um token', 'Registra quando vence cada token (Figma, Bitbucket), para o Mabel avisar antes.'),
        fields: [
          { type: 'choice', key: 'cred', label: 'Credencial', options: Object.entries(CREDENTIALS).map(([name, { env }]): [string, string] => [name, env]) },
          { type: 'text', key: 'expira', label: 'Vence em', required: true, placeholder: 'AAAA-MM-DD' },
        ],
        action: 'Registrar',
      },
      { args: (v) => [text(v, 'cred') || 'figma', ...option(v, 'expira', '--expira')], mode: view },
    ),

  rodar: (data) => {
    const single = (v: FormValues) => text(v, 'modo') === 'item';
    return form(
      'rodar',
      {
        ...head('Rodar a fila', 'Planeja os itens prontos e depois executa um por um.'),
        fields: [
          {
            type: 'choice',
            key: 'modo',
            label: 'Modo',
            options: [
              ['', 'fila inteira: planeja todos, depois executa'],
              ['item', 'só um item, do plano ao fim'],
              ['--sem-lote', 'item a item, cada um até o fim'],
            ],
          },
          { type: 'text', key: 'limite', label: 'Quantos itens', placeholder: 'todos os prontos', when: (v) => !single(v) },
          itemField(
            data.items.filter((item) => item.status === 'ready' || item.status === 'planned'),
            { when: single },
          ),
          { type: 'bool', key: 'fundo', label: 'Em segundo plano' },
        ],
        action: 'Rodar',
        check: (v) => (!single(v) && text(v, 'limite') && !/^[1-9]\d*$/.test(text(v, 'limite')) ? 'Quantos itens: um número inteiro maior que zero.' : null),
      },
      {
        args: (v) => [
          ...(single(v) ? option(v, 'item', '--item') : option(v, 'limite', '--limite')),
          ...flag(v, 'fundo', '--fundo'),
          ...(text(v, 'modo') === '--sem-lote' ? ['--sem-lote'] : []),
        ],
        mode: (v) => (v.fundo ? 'view' : 'terminal'),
        next: () => ['Acompanhe em "Acompanhar a fila" ou com mabel acompanhar.'],
      },
    );
  },

  cancelar: (data) =>
    form(
      'cancelar',
      {
        ...head('Cancelar um item', 'Tira um item da fila de vez.'),
        fields: [itemField(data.items.filter((item) => TRANSITIONS[item.status].includes('cancelled')))],
        action: 'Cancelar o item',
        danger: true,
      },
      { args: (v) => (text(v, 'item') ? [text(v, 'item')] : []), mode: view, next: () => ['O histórico e as runs continuam na auditoria.'] },
    ),

  retomar: (data) => {
    const stopped = data.items.filter((item) => RESUMABLE.includes(item.status) && !item.statusReason?.startsWith(FORMAT_ERROR_PREFIX));
    return form(
      'retomar',
      {
        ...head('Retomar um item', 'Devolve à fila um item parado por falha ou bloqueio, com o motivo à vista.'),
        fields: [
          itemField(stopped),
          {
            type: 'info',
            key: 'motivo',
            lines: (v) => {
              const item = itemOf(stopped, v);
              return item ? [style.dim(`motivo: ${item.statusReason ?? (item.status === 'failed' ? 'falhou' : 'bloqueado')}`)] : [];
            },
          },
          { type: 'text', key: 'orientacao', label: 'Orientação', placeholder: 'opcional: o que mudou ou o que tentar agora' },
        ],
        action: 'Retomar',
      },
      { args: (v) => [...(text(v, 'item') ? [text(v, 'item')] : []), ...option(v, 'orientacao', '--orientacao')], mode: view },
    );
  },

  entregar: (data) =>
    form(
      'entregar',
      {
        ...head('Entregar uma unidade', 'Mostra as unidades prontas, prova uma contra a base e abre o PR.'),
        fields: [
          {
            type: 'pick',
            key: 'unidade',
            label: 'Unidade',
            required: true,
            options: () => data.units.map((unit) => ({ value: unitArg(unit.name), label: unitLabel(unit) })),
          },
          {
            type: 'pick',
            key: 'com',
            label: 'Junto com',
            multi: true,
            noun: ['unidade', 'unidades'],
            options: (v) => data.units.filter((unit) => unitArg(unit.name) !== text(v, 'unidade')).map((unit) => ({ value: unitArg(unit.name), label: unitLabel(unit) })),
          },
          { type: 'bool', key: 'parcial', label: 'Entrega parcial' },
          { type: 'bool', key: 'substituir', label: 'Substituir a entrega aberta' },
          { type: 'bool', key: 'rascunho', label: 'PR como rascunho' },
        ],
        action: 'Provar e entregar',
      },
      {
        args: (v) => [
          ...(text(v, 'unidade') ? [text(v, 'unidade')] : []),
          ...many(v, 'com', '--com'),
          ...flag(v, 'parcial', '--parcial'),
          ...flag(v, 'substituir', '--substituir'),
          ...flag(v, 'rascunho', '--rascunho'),
        ],
        // A prova leva tempo: a saída corre no terminal, sem perguntas (o formulário respondeu).
        mode: terminal,
        headless: true,
      },
    ),

  rejeitar: (data) =>
    form(
      'rejeitar',
      {
        ...head('Rejeitar um item', 'Desfaz um item na integração e o devolve ao planejamento.'),
        fields: [
          itemField(data.items.filter((item) => item.status === 'awaiting_merge' && item.integratedCommit)),
          { type: 'text', key: 'motivo', label: 'Motivo', required: true, placeholder: 'por que o item volta; o planejamento recebe' },
          { type: 'bool', key: 'cancelar', label: 'Cancelar em vez de devolver' },
        ],
        action: 'Rejeitar',
        danger: true,
      },
      {
        args: (v) => [...(text(v, 'item') ? [text(v, 'item')] : []), ...(text(v, 'motivo') ? [text(v, 'motivo')] : []), ...flag(v, 'cancelar', '--cancelar')],
        mode: view,
      },
    ),

  detalhar: (data) =>
    form(
      'detalhar',
      {
        ...head('Detalhar um item', 'Mostra estado, pendência, plano, custo e runs de um item.'),
        fields: [itemField(data.items)],
        action: 'Detalhar',
      },
      { args: (v) => (text(v, 'item') ? [text(v, 'item')] : []), mode: view },
    ),

  auditar: (data) =>
    form(
      'auditar',
      {
        ...head('Auditar um projeto', 'Mostra a auditoria de um projeto e permite remover os dados dele do Mabel.'),
        fields: [
          {
            type: 'pick',
            key: 'projeto',
            label: 'Projeto',
            required: true,
            options: () =>
              data.projects.map((project) => ({
                value: project.name,
                label: project.name,
                hint: project.items === 0 ? 'sem itens' : `${project.items} itens · ${project.runs} runs · ${formatCost(project.costUsd)}`,
              })),
          },
          { type: 'bool', key: 'remover', label: 'Remover os dados do Mabel' },
          { type: 'text', key: 'confirma', label: 'Confirme o nome', required: true, placeholder: 'digite o nome do projeto', when: (v) => Boolean(v.remover) },
        ],
        action: 'Auditar',
        danger: (v) => Boolean(v.remover),
        check: (v) => (v.remover && text(v, 'confirma') !== text(v, 'projeto') ? 'O nome digitado não confere com o projeto escolhido.' : null),
      },
      {
        args: (v) =>
          v.remover
            ? ['remover', ...(text(v, 'projeto') ? [text(v, 'projeto')] : []), ...option(v, 'confirma', '--confirmar')]
            : text(v, 'projeto')
              ? [text(v, 'projeto')]
              : [],
        mode: view,
      },
    ),

  pedir: () =>
    form(
      'pedir',
      {
        ...head('Pedir algo avulso', 'Manda um prompt ao Claude Code fora da fila, com auditoria.'),
        fields: [
          { type: 'text', key: 'prompt', label: 'Pedido', required: true, placeholder: 'o que o agente deve fazer' },
          { type: 'choice', key: 'model', label: 'Modelo', options: MODELS },
          { type: 'text', key: 'turnos', label: 'Limite de turnos', placeholder: 'opcional' },
          { type: 'text', key: 'custo', label: 'Limite de custo', placeholder: 'opcional, em dólares' },
          { type: 'text', key: 'tools', label: 'Ferramentas', placeholder: 'opcional, separadas por vírgula' },
          { type: 'text', key: 'cwd', label: 'Diretório', placeholder: 'o atual' },
        ],
        action: 'Executar',
      },
      {
        args: (v) => [
          ...(text(v, 'prompt') ? [text(v, 'prompt')] : []),
          ...option(v, 'model', '--model'),
          ...option(v, 'turnos', '--max-turns'),
          ...option(v, 'custo', '--max-budget-usd'),
          ...option(v, 'tools', '--allowed-tools'),
          ...option(v, 'cwd', '--cwd'),
        ],
        // A conversa continua no terminal, como hoje.
        mode: terminal,
      },
    ),
};

/** Argumentos do `adicionar` a partir do formulário, na ordem das opções. */
export function addFormArgs(values: FormValues): string[] {
  return [
    ...(text(values, 'title') ? [text(values, 'title')] : []),
    ...option(values, 'intent', '--intencao'),
    ...many(values, 'criteria', '--criterio'),
    ...many(values, 'outOfScope', '--fora-do-escopo'),
    ...many(values, 'references', '--referencia'),
    ...many(values, 'dependsOn', '--depende'),
    ...option(values, 'restrictions', '--restricoes'),
  ];
}

// Telas ----------------------------------------------------------------------------------

/** O que abrir para cada comando do menu. */
export type CommandScreen =
  | { kind: 'form'; form: CommandForm }
  /** Saída só de leitura do comando, sem perguntas. */
  | { kind: 'view'; args: string[] }
  /** Mensagem só de leitura, sem rodar nada. */
  | { kind: 'message'; lines: string[] }
  /** O fluxo de hoje no terminal comum. */
  | { kind: 'terminal'; args: string[] }
  | { kind: 'decide' };

/** Etapa do item em andamento, para "A fila termina a etapa em andamento (#14 executar)". */
const STAGE_NAMES: Partial<Record<Item['status'], string>> = { planning: 'planejar', executing: 'executar', verifying: 'verificação', reviewing: 'revisar' };

/** Formulário "Parar a fila": só com fila rodando; o botão pede a parada depois da etapa. */
export function stopForm(data: ScreenData): CommandForm {
  const active = data.items.find((item) => STAGE_NAMES[item.status]);
  const stage = active ? ` (#${active.number} ${STAGE_NAMES[active.status]})` : '';
  return form(
    'parar',
    {
      ...head('Parar a fila', 'Encerra a fila depois da etapa em andamento.'),
      fields: [
        {
          type: 'info',
          key: 'fila',
          lines: () => [`A fila termina a etapa em andamento${stage} e para.`, style.dim('Nada se perde: o próximo rodar continua de onde parou.')],
        },
      ],
      action: 'Parar depois da etapa',
    },
    { args: () => [], mode: view },
  );
}

export function commandScreen(name: string, data: ScreenData): CommandScreen {
  switch (name) {
    case 'conferir':
    case 'consultar':
    case 'listar':
      return { kind: 'view', args: [] };
    case 'decidir':
      return { kind: 'decide' };
    case 'acompanhar':
      if (data.background) return { kind: 'terminal', args: [] };
      return {
        kind: 'message',
        lines: [
          'Nenhuma fila em segundo plano neste projeto.',
          style.dim('Para rodar sem prender o terminal: Rodar a fila, com "Em segundo plano" marcado.'),
        ],
      };
    case 'parar':
      return data.queueRunning ? { kind: 'form', form: stopForm(data) } : { kind: 'message', lines: ['Nenhuma fila rodando neste projeto.'] };
    case 'entregar':
      // Sem a branch de integração não há unidades: o entregar de hoje, sem argumentos.
      if (!data.integration) return { kind: 'terminal', args: [] };
  }
  const build = FORMS[name];
  return build ? { kind: 'form', form: build(data) } : { kind: 'terminal', args: [] };
}
