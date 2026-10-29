#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from 'node:fs';
import { banner } from './banner.ts';
import { type Command, commands, findCommand } from './commands.ts';
import { Interrupted } from './ask.ts';
import { renderHelp } from './completion.ts';
import { fail, setJsonErrors } from './errors.ts';
import { repl } from './repl.ts';
import { style } from './style.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const interactive = process.stdin.isTTY && process.stdout.isTTY;

function plannedNote(command: Command): string {
  return `ainda não implementado (passo ${command.plannedStep} do plano)`;
}

function menu(): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = commands.map((command) => {
    const line = `  ${command.name.padEnd(width)}  ${command.description}`;
    return command.plannedStep ? style.dim(`${line}  (passo ${command.plannedStep})`) : line;
  });
  return [
    style.bold('Comandos'),
    ...lines,
    '',
    style.dim('Use `mabel <comando> --help` para ver o uso e as opções, ou `mabel comandos` para ver todas.'),
  ].join('\n');
}

async function home(): Promise<number> {
  if (process.env.MABEL_BANNER !== '0') {
    process.stdout.write(`\n${banner(process.stdout.columns ?? 80)}\n\n`);
  }
  process.stdout.write(`${style.dim(`v${pkg.version} · harness para frotas de agentes`)}\n\n`);

  if (!interactive) {
    process.stdout.write(`${menu()}\n`);
    return 0;
  }

  return repl();
}

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;

  if (name === undefined) return home();
  if (name === '--version' || name === '-v') {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (name === '--help' || name === '-h' || name === 'help') {
    process.stdout.write(`${menu()}\n`);
    return 0;
  }

  const json = args.includes('--json');
  setJsonErrors(json);
  const command = findCommand(name);
  if (!command) {
    if (json) return fail('argumento_invalido', `Comando desconhecido: ${name}`);
    process.stderr.write(`Comando desconhecido: ${name}\n\n${menu()}\n`);
    return 1;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${renderHelp(command)}\n`);
    return 0;
  }
  if (!command.run) return fail('argumento_invalido', `\`mabel ${command.name}\` ${plannedNote(command)}.`);
  try {
    return await command.run(args);
  } catch (error) {
    if (error instanceof Interrupted) return 130;
    // Com --json, nem o erro inesperado sai em texto.
    if (json) return fail('interno', (error as Error).message ?? String(error));
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
