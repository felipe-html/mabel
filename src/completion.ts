import type { Command } from './commands.ts';
import { fail } from './errors.ts';
import { writeJson } from './json.ts';
import { type ArgSpec, type OptionSpec, type ValueSource, optionDescription, optionLabel, renderOptionsHelp } from './options.ts';
import { style } from './style.ts';
import { valuesFor } from './values.ts';

export const completionUsage = 'mabel completion zsh';
export const commandsUsage = 'mabel comandos [--json]';

const VALUE_SOURCES: ValueSource[] = ['item', 'projeto', 'stack', 'referencia', 'spec', 'credencial', 'arquivo', 'diretorio'];

function escape(text: string): string {
  return text.replaceAll("'", "'\\''").replaceAll(':', '\\:');
}

/** Texto dentro de uma especificação do `_arguments`: sem `[`, `]` e `:` soltos. */
function specText(text: string): string {
  return escape(text).replaceAll('[', '\\[').replaceAll(']', '\\]');
}

/** O que o zsh oferece para uma fonte de valores. */
function action(source: ValueSource | undefined, label: string): string {
  if (source === 'arquivo') return '_files';
  if (source === 'diretorio') return '_files -/';
  if (source) return `_mabel_valores ${source} ${specText(label.replaceAll(' ', '_'))}`;
  return ' ';
}

function optionSpec(name: string, spec: OptionSpec): string {
  const repeat = spec.multiple ? '*' : '';
  const head = `${repeat}--${name}[${specText(optionDescription(spec))}]`;
  if (spec.type === 'boolean') return `'${head}'`;
  const label = (spec.value ?? 'valor').replace(/[<>]/g, '');
  return `'${head}:${specText(label)}:${action(spec.values, label)}'`;
}

function choicesFunction(command: Command, position: number, arg: ArgSpec): string {
  const choices = (arg.choices ?? []).map((choice) => `'${escape(choice.name)}:${escape(choice.description)}'`).join(' ');
  const values = arg.values ? `\n  _mabel_valores ${arg.values} valor` : '';
  return `_mabel_escolhas_${command.name}_${position}() {
  local -a escolhas
  escolhas=(${choices})
  _describe 'subcomando' escolhas${values}
}`;
}

function argSpec(command: Command, position: number, arg: ArgSpec): string {
  const label = specText(arg.name.replace(/["<>]/g, ''));
  const target = arg.choices ? `_mabel_escolhas_${command.name}_${position}` : action(arg.values, arg.name.replace(/["<>]/g, ''));
  return `'${position}:${label}:${target}'`;
}

function commandFunction(command: Command): string {
  const specs = [
    ...Object.entries(command.options ?? {}).map(([name, spec]) => optionSpec(name, spec)),
    ...(command.args ?? []).map((arg, i) => argSpec(command, i + 1, arg)),
    `'--help[Mostra o uso, os argumentos e as opções]'`,
  ];
  return `_mabel_cmd_${command.name}() {
  _arguments \\
    ${specs.join(' \\\n    ')}
}`;
}

/**
 * Script de autocompletar para zsh. Funciona via `eval "$(mabel completion zsh)"`
 * no `.zshrc`, mesmo sem o compinit já carregado. Comandos, opções e argumentos vêm com a
 * explicação; itens, projetos e referências são lidos na hora com `mabel completion valores`.
 */
export function zshCompletion(commands: Command[]): string {
  const entries = commands
    .map((command) => {
      const suffix = command.plannedStep ? ` (passo ${command.plannedStep})` : '';
      return `    '${escape(command.name)}:${escape(command.description + suffix)}'`;
    })
    .join('\n');
  const helpers = commands.flatMap((command) =>
    (command.args ?? []).flatMap((arg, i) => (arg.choices ? [choicesFunction(command, i + 1, arg)] : [])),
  );

  return `#compdef mabel
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit }

_mabel_valores() {
  local -a valores
  valores=("\${(@f)$(mabel completion valores $1 2>/dev/null)}")
  [[ -n \${valores[1]} ]] && _describe -t valores "\${2:-valor}" valores
}

${[...helpers, ...commands.map(commandFunction)].join('\n\n')}

_mabel() {
  local -a commands
  commands=(
${entries}
  )
  if (( CURRENT == 2 )); then
    _describe 'comando do mabel' commands
    return
  fi
  local command=\${words[2]}
  shift words
  (( CURRENT-- ))
  (( $+functions[_mabel_cmd_$command] )) && _mabel_cmd_$command
}

compdef _mabel mabel
`;
}

/** `mabel completion zsh`; `mabel completion valores <fonte>` serve o próprio script. */
export function completionCommand(commands: Command[], args: string[]): number {
  if (args[0] === 'valores' && args.length === 2 && VALUE_SOURCES.includes(args[1] as ValueSource)) {
    const lines = valuesFor(args[1] as ValueSource).map((option) => `${option.value.replaceAll(':', '\\:')}:${option.description}`);
    if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }
  if (args.length !== 1 || args[0] !== 'zsh') {
    process.stderr.write(`Shell não suportado. Uso: ${completionUsage}\n`);
    return 1;
  }
  process.stdout.write(zshCompletion(commands));
  return 0;
}

// Catálogo ---------------------------------------------------------------------------------

/** Descrição e uso do comando seguidos dos argumentos e opções explicados (o `--help`). */
export function renderHelp(command: Command): string {
  return [`${command.description}`, '', `Uso: ${command.usage}`, ...renderOptionsHelp(command.args, command.options)].join('\n');
}

export function commandsJson(commands: Command[]): Record<string, unknown> {
  return {
    comandos: commands.map((command) => ({
      nome: command.name,
      descricao: command.description,
      uso: command.usage,
      soNoShell: !command.menu,
      argumentos: (command.args ?? []).map((arg) => ({
        nome: arg.name,
        descricao: arg.description,
        valores: arg.values ?? null,
        escolhas: (arg.choices ?? []).map((choice) => ({ nome: choice.name, descricao: choice.description })),
      })),
      opcoes: Object.entries(command.options ?? {}).map(([name, spec]) => ({
        nome: `--${name}`,
        tipo: spec.type === 'string' ? 'texto' : 'sinal',
        valor: spec.type === 'string' ? (spec.value ?? '<valor>') : null,
        descricao: spec.description,
        repetivel: spec.multiple ?? false,
        valores: spec.values ?? null,
      })),
    })),
  };
}

/** `mabel comandos`: cada comando com as opções e os argumentos, explicados. */
export function commandsCommand(commands: Command[], args: string[]): number {
  const json = args.length === 1 && args[0] === '--json';
  if (args.length > 0 && !json) return fail('argumento_invalido', `Argumento inesperado: ${args.join(' ')}.`, commandsUsage);
  if (json) {
    writeJson(commandsJson(commands));
    return 0;
  }
  const blocks = commands.map((command) => {
    const rows = [
      ...(command.args ?? []).map((arg): [string, string] => [arg.name, arg.description]),
      ...Object.entries(command.options ?? {}).map(([name, spec]): [string, string] => [optionLabel(name, spec), optionDescription(spec)]),
    ];
    const width = Math.max(0, ...rows.map(([left]) => left.length));
    return [
      `${style.bold(command.name)}  ${command.description}`,
      ...rows.map(([left, right]) => `    ${left.padEnd(width)}  ${style.dim(right)}`),
    ].join('\n');
  });
  process.stdout.write(`${blocks.join('\n\n')}\n`);
  return 0;
}
