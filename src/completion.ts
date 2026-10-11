import type { Command } from './commands.ts';

function escape(text: string): string {
  return text.replaceAll("'", "'\\''").replaceAll(':', '\\:');
}

/**
 * Script de autocompletar para zsh. Funciona via `eval "$(mabel completion zsh)"`
 * no `.zshrc`, mesmo sem o compinit já carregado.
 */
export function zshCompletion(commands: Command[]): string {
  const entries = commands
    .map((command) => {
      const suffix = command.plannedStep ? ` (passo ${command.plannedStep})` : '';
      return `    '${escape(command.name)}:${escape(command.description + suffix)}'`;
    })
    .join('\n');

  return `#compdef mabel
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit }

_mabel() {
  local -a commands
  commands=(
${entries}
  )
  if (( CURRENT == 2 )); then
    _describe 'comando do mabel' commands
  elif [[ \${words[2]} == completion && CURRENT == 3 ]]; then
    _values 'shell' zsh
  fi
}

compdef _mabel mabel
`;
}
