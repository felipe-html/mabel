import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { ask, confirm, interactive } from './ask.ts';
import { BACKLOG_TEMPLATE, type ItemFields, appendBlocks, renderItemBlock } from './backlog.ts';
import { syncBacklog } from './items.ts';
import { dataDir, openDb } from './db.ts';
import { git } from './git.ts';
import {
  CRITICAL_RULES_TEMPLATE,
  DEFAULT_LIMITS,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_INTEGRATION,
  DEFAULT_MODELS,
  DEFAULT_TEST_GLOBS,
  MABEL_DIR,
  type ProjectConfig,
  type VerifyCommand,
  currentBranch,
  gitRoot,
  hasTestCommand,
  isEmptyProject,
  mabelPath,
  mabelUncommitted,
  newProjectId,
  readConfig,
  registerProject,
  registeredProjectId,
} from './project.ts';
import { select } from './menu.ts';
import { STACKS, type Stack, detectCommands, findStack, stackLabel } from './stacks.ts';
import { style } from './style.ts';

export const TEST_BASE_TITLE = 'Estabelecer base de testes';

export const initUsage = `mabel init [--stack ${STACKS.map((stack) => stack.id).join('|')}]`;

export interface TestBaseOptions {
  /** Projeto sem código: o item cria a estrutura mínima. */
  empty: boolean;
  stack?: Stack;
  /** Stack fora do catálogo, descrita pelo usuário. */
  other?: string;
}

const code = (text: string) => `\`${text}\``;
const joinAnd = (parts: string[]) =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} e ${parts.at(-1)}`;

/** Item criado pelo `init` em projeto sem testes. Fica concreto quando a stack é do catálogo. */
export function testBaseItem({ empty, stack, other }: TestBaseOptions): ItemFields {
  const base = {
    number: 1,
    title: TEST_BASE_TITLE,
    dependsOn: [],
    restrictions: null,
    outOfScope: [],
    decisions: [],
    criticalConcepts: [],
  };
  if (stack && empty) {
    const { framework, setup, verify } = stack.template;
    const config = [
      ...(setup ? [`${code('setup')} igual a ${code(setup)}`] : []),
      `${code('verify')} com ${joinAnd(verify.map((command) => `${code(command.name)} (${code(command.command)})`))}`,
    ];
    return {
      ...base,
      intent: [
        `O projeto ainda não tem código. Criar a estrutura mínima de ${stack.label} com ${framework}`,
        'e escrever ao menos um teste que passe.',
      ].join('\n'),
      criteria: [
        `${joinAnd(verify.map((command) => code(command.command)))} rodam e passam`,
        `${code('.mabel/config.json')} tem ${joinAnd(config)}`,
      ],
    };
  }
  const intent = stack
    ? [
        `O projeto não tem testes automatizados. Configurar ${stack.template.framework}, o comando de`,
        'teste e escrever ao menos um teste que passe.',
        '',
        `Comando sugerido: ${code(stack.template.verify.at(-1)?.command ?? '')}`,
      ]
    : [
        'O projeto não tem testes automatizados. Escolher um framework de testes adequado à',
        'stack, configurar o comando de teste e escrever ao menos um teste que passe.',
      ];
  if (!stack && (empty || other)) intent.push('', `Stack: ${other || 'a definir'}`);
  return {
    ...base,
    intent: intent.join('\n'),
    criteria: [
      'Um comando de teste roda e passa',
      'O comando de teste está em `verify` no `.mabel/config.json`',
    ],
  };
}

type StackChoice = { stack: Stack } | { other: string } | null;

/** Menu com o catálogo e "Outra". `null` quando o usuário sai do menu. */
async function chooseStack(question: string, askOther: boolean): Promise<StackChoice> {
  process.stdout.write(`${style.bold(question)}\n`);
  const options = [
    ...STACKS.map((stack) => ({ label: stack.label, hint: `testes com ${stack.template.framework.replaceAll('`', '')}` })),
    { label: 'Outra', hint: askOther ? 'você descreve a stack' : 'o agente escolhe o framework' },
  ];
  const chosen = await select(options, style);
  if (chosen === null) return null;
  const stack = STACKS[chosen];
  if (stack) return { stack };
  return { other: askOther ? await ask('Qual stack? ') : '' };
}

/** Pergunta `[S/n/editar]` até receber uma resposta válida. */
async function confirmCommands(): Promise<'yes' | 'no' | 'edit'> {
  for (;;) {
    const answer = (await ask('Usar estes comandos? [S/n/editar] ')).toLowerCase();
    if (!answer || answer.startsWith('s') || answer.startsWith('y')) return 'yes';
    if (answer === 'n' || answer === 'nao' || answer === 'não') return 'no';
    if (answer.startsWith('e')) return 'edit';
  }
}

function describe(setup: string | null, verify: VerifyCommand[]): string[] {
  return [
    `  setup   ${setup ?? style.dim('(nenhum)')}`,
    ...(verify.length > 0
      ? verify.map((command) => `  ${command.name.padEnd(7)} ${command.command}`)
      : [`  verify  ${style.dim('(nenhum)')}`]),
  ];
}

/** No TTY: enter mantém, `-` remove, texto substitui; depois permite acrescentar comandos. */
async function editCommands(setup: string | null, verify: VerifyCommand[]) {
  process.stdout.write(style.dim("Edite cada comando: enter mantém, '-' remove, texto novo substitui.\n"));
  const edit = async (label: string, current: string | null) => {
    const answer = await ask(`  ${label.padEnd(9)}[${current ?? ''}] `);
    if (answer === '-') return null;
    return answer || current;
  };
  const newSetup = await edit('setup', setup);
  const newVerify: VerifyCommand[] = [];
  for (const command of verify) {
    const edited = await edit(command.name, command.command);
    if (edited) newVerify.push({ name: command.name, command: edited });
  }
  process.stdout.write(style.dim('Comandos de verificação extras, um por linha como `nome: comando` (linha vazia termina).\n'));
  for (;;) {
    const answer = await ask('  + ');
    if (!answer) break;
    const match = /^([\w-]+)\s*:\s*(.+)$/.exec(answer);
    if (match?.[1] && match[2]) newVerify.push({ name: match[1], command: match[2] });
    else process.stdout.write(style.dim('  formato: nome: comando\n'));
  }
  return { setup: newSetup, verify: newVerify };
}

/**
 * Cria no `.mabel/` os arquivos que ainda não existem (os do usuário são preservados).
 * Se uma gravação falhar, remove o que esta chamada criou e relança o erro.
 */
export function createProjectFiles(root: string, files: [string, string][]): void {
  const dir = join(root, MABEL_DIR);
  const created: string[] = [];
  const createdDir = !existsSync(dir);
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of files) {
      const path = mabelPath(root, name);
      if (existsSync(path)) continue;
      writeFileSync(path, content);
      created.push(path);
    }
  } catch (error) {
    for (const path of created) rmSync(path, { force: true });
    if (createdDir) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function init(args: string[]): Promise<number> {
  let values: { stack?: string };
  try {
    ({ values } = parseArgs({ args, options: { stack: { type: 'string' } }, strict: true }));
  } catch {
    process.stderr.write(`Uso: ${initUsage}\n`);
    return 1;
  }
  const forced = values.stack === undefined ? undefined : findStack(values.stack);
  if (values.stack !== undefined && !forced) {
    process.stderr.write(`Stack desconhecida: ${values.stack}. Use uma destas: ${STACKS.map((stack) => stack.id).join(', ')}.\n`);
    return 1;
  }
  const root = gitRoot(process.cwd());
  if (!root) {
    process.stderr.write('Não é um repositório git. Rode `git init` aqui e depois `mabel init`.\n');
    return 1;
  }

  const db = openDb(dataDir());
  try {
    const existing = readConfig(root);
    if (existing) {
      registerProject(db, root, existing.projectId);
      process.stdout.write(
        [
          `${style.bold(basename(root))} já é um projeto Mabel. Nada foi alterado.`,
          `  projeto ${existing.projectId}`,
          `  base    ${existing.baseBranch}`,
          ...describe(existing.setup, existing.verify),
          '',
        ].join('\n'),
      );
      await offerCommit(root);
      return 0;
    }

    const empty = isEmptyProject(root);
    const detected = detectCommands(root);
    let { setup, verify } = detected;
    let stack = forced ?? detected.stacks[0];
    let other: string | undefined;

    if (detected.stacks.length > 0 || verify.length > 0) {
      const title = detected.stacks.length > 0 ? `Stack detectada: ${stackLabel(detected.stacks)}` : 'Comandos detectados';
      process.stdout.write(`${style.bold(title)}\n${describe(setup, verify).join('\n')}\n`);
      if (interactive()) {
        const answer = await confirmCommands();
        if (answer === 'no') ({ setup, verify } = { setup: null, verify: [] });
        if (answer === 'edit') ({ setup, verify } = await editCommands(setup, verify));
      }
    } else if (!stack && interactive()) {
      const choice = empty
        ? await chooseStack('Projeto sem código. Qual stack o projeto vai usar?', true)
        : await chooseStack('Não reconheci a stack do projeto. Qual é?', false);
      if (choice === null) {
        process.stdout.write('init cancelado. Nada foi alterado.\n');
        return 1;
      }
      if ('stack' in choice) stack = choice.stack;
      else other = choice.other;
      if (!empty) ({ setup, verify } = await editCommands(setup, verify));
    }
    process.stdout.write('\n');

    // Repositório que já foi projeto Mabel: o id anterior mantém o histórico no banco.
    const previousId = registeredProjectId(db, root);
    const config: ProjectConfig = {
      projectId: previousId ?? newProjectId(),
      baseBranch: currentBranch(root),
      setup,
      verify,
      models: { ...DEFAULT_MODELS },
      limits: structuredClone(DEFAULT_LIMITS),
      autonomia: 'sugestoes',
      // Sem stack do catálogo, a prova roda o comando de teste inteiro (modo por item).
      testeUnico: stack?.proof(root, empty).testeUnico ?? null,
      arquivosDeTeste: stack?.proof(root, empty).arquivosDeTeste ?? [...DEFAULT_TEST_GLOBS],
      integracao: DEFAULT_INTEGRATION,
      contexto: { maxCaracteres: DEFAULT_CONTEXT_BUDGET },
      rede: [...new Set([...(stack ? [stack] : []), ...detected.stacks].flatMap((found) => found.rede))],
      sandbox: true,
    };

    let backlog = BACKLOG_TEMPLATE;
    const noTests = !hasTestCommand(verify);
    if (noTests) backlog = appendBlocks(backlog, [renderItemBlock(testBaseItem({ empty, stack, other }))]);

    // Registrar antes de gravar: se a gravação falhar, um novo `init` reaproveita o id.
    registerProject(db, root, config.projectId);
    try {
      createProjectFiles(root, [
        ['regras-criticas.md', CRITICAL_RULES_TEMPLATE],
        ['backlog.md', backlog],
        ['.gitignore', 'quadro.md\nintegracao.md\n'],
        // Por último: é o config que marca a pasta como projeto Mabel.
        ['config.json', `${JSON.stringify(config, null, 2)}\n`],
      ]);
    } catch (error) {
      process.stderr.write(`Não foi possível criar o .mabel/: ${(error as Error).message}\nNenhum arquivo foi criado.\n`);
      return 1;
    }
    syncBacklog(db, { id: config.projectId, root, name: basename(root), config });

    const notes = [`${style.bold('.mabel/ criado')} em ${root} · branch base ${config.baseBranch}`];
    if (previousId) notes.push('Este repositório já foi um projeto Mabel: o histórico anterior foi mantido.');
    if (verify.length === 0 && empty && stack) {
      notes.push('Os comandos de `verify` entram no config com o item 1; até lá, o G3 fica sem gate mecânico.');
    } else if (verify.length === 0) {
      notes.push('Aviso: nenhum comando em `verify`; o G3 fica sem gate mecânico.');
    }
    if (noTests) notes.push(`Projeto sem testes: "${TEST_BASE_TITLE}" é o primeiro item do backlog.`);
    process.stdout.write(`${notes.join('\n')}\n`);

    await offerCommit(root);
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Os worktrees dos itens nascem da branch base: sem o `.mabel/` commitado, o agente não vê
 * o config nem o backlog. Oferece o commit sempre que houver arquivos do `.mabel/` pendentes.
 */
async function offerCommit(root: string): Promise<void> {
  if (!mabelUncommitted(root)) return;
  const branch = currentBranch(root);
  process.stdout.write(`O .mabel/ tem arquivos fora do git; os worktrees dos itens nascem da branch ${branch}.\n`);
  if (interactive() && (await confirm(`Commitar o .mabel/ na branch ${branch}?`))) {
    commitMabelDir(root);
    process.stdout.write('Commit criado.\n');
  } else {
    process.stdout.write('Commite com `git add .mabel && git commit -m "mabel init" -- .mabel` antes do `mabel run`.\n');
  }
}

/** Commita só o `.mabel/`, sem levar o que o usuário tiver no índice. */
export function commitMabelDir(root: string): void {
  git(root, 'add', MABEL_DIR);
  git(root, 'commit', '-q', '-m', 'mabel init', '--', MABEL_DIR);
}
