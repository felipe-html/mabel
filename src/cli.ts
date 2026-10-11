#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { readFileSync } from 'node:fs';
import { banner } from './banner.ts';
import { commands, findCommand } from './commands.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text: string) => (color ? `\x1b[1m${text}\x1b[0m` : text);

function menu(): string {
  const width = Math.max(...commands.map((command) => command.name.length));
  const lines = commands.map((command) => {
    const line = `  ${command.name.padEnd(width)}  ${command.description}`;
    return command.plannedStep ? dim(`${line}  (passo ${command.plannedStep})`) : line;
  });
  return [bold('Comandos'), ...lines, '', dim('Use `mabel <comando> --help` para ver o uso.')].join(
    '\n',
  );
}

function home(): number {
  if (process.env.MABEL_BANNER !== '0') {
    process.stdout.write(`\n${banner(process.stdout.columns ?? 80)}\n\n`);
  }
  process.stdout.write(`${dim(`v${pkg.version} · harness para frotas de agentes`)}\n\n`);
  process.stdout.write(`${menu()}\n`);
  return 0;
}

function main(argv: string[]): number {
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

  const command = findCommand(name);
  if (!command) {
    process.stderr.write(`Comando desconhecido: ${name}\n\n${menu()}\n`);
    return 1;
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${command.description}\n\nUso: ${command.usage}\n`);
    return 0;
  }
  if (!command.run) {
    process.stderr.write(
      `\`mabel ${command.name}\` ainda não foi implementado (passo ${command.plannedStep} do plano).\n`,
    );
    return 1;
  }
  return command.run(args);
}

process.exitCode = main(process.argv.slice(2));
