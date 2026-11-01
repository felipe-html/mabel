/**
 * Opções e argumentos dos comandos, com a explicação de cada um. A mesma declaração vai para
 * o `parseArgs`, o `--help`, o autocompletar do zsh e o
 * `mabel comandos --json`: ninguém precisa decorar uma opção para usá-la.
 */

/** De onde vêm os valores de uma opção ou argumento. */
export type ValueSource = 'item' | 'projeto' | 'stack' | 'referencia' | 'spec' | 'credencial' | 'arquivo' | 'diretorio';

export interface OptionSpec {
  type: 'string' | 'boolean';
  multiple?: boolean;
  short?: string;
  description: string;
  /** Nome do valor no uso, como `<n>`; só nas opções `string`. */
  value?: string;
  values?: ValueSource;
}

/** Repassado tal como está ao `parseArgs`, que ignora os campos de descrição. */
export type OptionSpecs = Record<string, OptionSpec>;

/** Palavra fixa numa posição, como `remover` em `mabel auditar remover`. */
export interface Choice {
  name: string;
  description: string;
}

export interface ArgSpec {
  /** Nome no uso: `<n>`, `"<título>"`. */
  name: string;
  description: string;
  values?: ValueSource;
  choices?: Choice[];
}

export const jsonOption = {
  type: 'boolean',
  description: 'Saída em uma linha de JSON, para outros programas',
} as const satisfies OptionSpec;

export const itemArg: ArgSpec = { name: '<n>', description: 'Número do item', values: 'item' };

/** Valor oferecido para uma fonte: o que entra na linha e a explicação ao lado. */
export interface ValueOption {
  value: string;
  description: string;
}

/** `--item <n>`, `--json`. */
export function optionLabel(name: string, spec: OptionSpec): string {
  return spec.type === 'string' ? `--${name} ${spec.value ?? '<valor>'}` : `--${name}`;
}

/** Explicação com as marcas de repetição: "(repetível)". */
export function optionDescription(spec: OptionSpec): string {
  return spec.multiple ? `${spec.description} (repetível)` : spec.description;
}

function table(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

/** Bloco do `--help` abaixo do uso: argumentos e opções com a explicação de cada um. */
export function renderOptionsHelp(args: ArgSpec[] = [], options: OptionSpecs = {}): string[] {
  const lines: string[] = [];
  const argRows: [string, string][] = args.flatMap((arg): [string, string][] => [
    [arg.name, arg.description],
    ...(arg.choices ?? []).map((choice): [string, string] => [`  ${choice.name}`, choice.description]),
  ]);
  if (argRows.length > 0) lines.push('', 'Argumentos:', ...table(argRows));
  const optionRows = Object.entries(options).map(([name, spec]): [string, string] => [optionLabel(name, spec), optionDescription(spec)]);
  if (optionRows.length > 0) lines.push('', 'Opções:', ...table(optionRows));
  return lines;
}
