import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ask, confirm, interactive } from './ask.ts';
import { BACKLOG_TEMPLATE, type ItemFields, appendBlocks, renderItemBlock } from './backlog.ts';
import { syncBacklog } from './items.ts';
import { dataDir, openDb } from './db.ts';
import { git } from './git.ts';
import {
  CRITICAL_RULES_TEMPLATE,
  DEFAULT_LIMITS,
  DEFAULT_MODELS,
  MABEL_DIR,
  type ProjectConfig,
  type VerifyCommand,
  currentBranch,
  detectCommands,
  gitRoot,
  hasCommits,
  hasTestCommand,
  isEmptyProject,
  mabelPath,
  newProjectId,
  readConfig,
  registerProject,
} from './project.ts';
import { style } from './style.ts';

export const TEST_BASE_TITLE = 'Estabelecer base de testes';

/** Item criado pelo `init` em projeto sem testes. `stack` só é usado em projeto sem código. */
export function testBaseItem(stack?: string): ItemFields {
  const intent = [
    'O projeto não tem testes automatizados. Escolher um framework de testes adequado à',
    'stack, configurar o comando de teste e escrever ao menos um teste que passe.',
  ];
  if (stack !== undefined) intent.push('', `Stack: ${stack || 'a definir'}`);
  return {
    number: 1,
    title: TEST_BASE_TITLE,
    intent: intent.join('\n'),
    criteria: [
      'Um comando de teste roda e passa',
      'O comando de teste está em `verify` no `.mabel/config.json`',
    ],
    dependsOn: [],
    restrictions: null,
  };
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
  process.stdout.write(style.dim("Enter mantém, '-' remove, texto substitui.\n"));
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
  process.stdout.write(style.dim('Acrescentar comando de verificação como `nome: comando` (enter termina).\n'));
  for (;;) {
    const answer = await ask('  + ');
    if (!answer) break;
    const match = /^([\w-]+)\s*:\s*(.+)$/.exec(answer);
    if (match?.[1] && match[2]) newVerify.push({ name: match[1], command: match[2] });
    else process.stdout.write(style.dim('  formato: nome: comando\n'));
  }
  return { setup: newSetup, verify: newVerify };
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content);
}

export async function init(args: string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write('Uso: mabel init\n');
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
      return 0;
    }

    const empty = isEmptyProject(root);
    let { setup, verify } = detectCommands(root);
    process.stdout.write(`${style.bold('Comandos detectados')}\n${describe(setup, verify).join('\n')}\n\n`);
    if (interactive()) ({ setup, verify } = await editCommands(setup, verify));

    const config: ProjectConfig = {
      projectId: newProjectId(),
      baseBranch: currentBranch(root),
      setup,
      verify,
      models: { ...DEFAULT_MODELS },
      limits: structuredClone(DEFAULT_LIMITS),
    };

    let backlog = BACKLOG_TEMPLATE;
    const noTests = !hasTestCommand(verify);
    if (noTests) {
      let stack: string | undefined;
      if (empty) {
        stack = interactive() ? await ask('Projeto sem código. Qual stack você quer usar? ') : '';
      }
      backlog = appendBlocks(backlog, [renderItemBlock(testBaseItem(stack))]);
    }

    mkdirSync(join(root, MABEL_DIR), { recursive: true });
    writeIfMissing(mabelPath(root, 'regras-criticas.md'), CRITICAL_RULES_TEMPLATE);
    writeIfMissing(mabelPath(root, 'backlog.md'), backlog);
    writeIfMissing(mabelPath(root, '.gitignore'), 'quadro.md\n');
    writeFileSync(mabelPath(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);

    registerProject(db, root, config.projectId);
    syncBacklog(db, { id: config.projectId, root, name: basename(root), config });

    const notes = [`${style.bold('.mabel/ criado')} em ${root} · branch base ${config.baseBranch}`];
    if (verify.length === 0) notes.push('Aviso: nenhum comando em `verify`; o G3 fica sem gate mecânico.');
    if (noTests) notes.push(`Projeto sem testes: "${TEST_BASE_TITLE}" é o primeiro item do backlog.`);
    process.stdout.write(`${notes.join('\n')}\n`);

    if (!hasCommits(root)) {
      process.stdout.write('O repositório não tem commits; os worktrees do Mabel precisam de um commit inicial.\n');
      if (interactive() && (await confirm('Criar o commit inicial com os arquivos do .mabel/?'))) {
        createInitialCommit(root);
        process.stdout.write('Commit inicial criado.\n');
      } else {
        process.stdout.write('Crie-o com `git add .mabel && git commit -m "mabel init"`.\n');
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

export function createInitialCommit(root: string): void {
  git(root, 'add', MABEL_DIR);
  git(root, 'commit', '-m', 'mabel init');
}
