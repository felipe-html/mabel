# Mabel

Harness para gerenciar, auditar e coordenar agentes Claude Code.

- O que o Mabel garante: [docs/CONTRATO.md](docs/CONTRATO.md)
- Estado da implementação: [docs/PLANO.md](docs/PLANO.md)

## Instalação local

Requer macOS ou Linux, Node ≥ 22.18, git e o Claude Code CLI.

```bash
scripts/setup.sh
```

O script faz o preflight (sistema, Node, `node:sqlite`, npm, git, Claude Code, zsh,
PATH), instala as dependências, cria `~/.mabel/`, liga `mabel` em `~/.local/bin`,
configura o autocompletar no `~/.zshrc` e roda typecheck e testes. Pode ser executado
várias vezes.

| Opção | Efeito |
|---|---|
| `--check` | Só o preflight, sem alterar nada. |
| `--force` | Substitui um `mabel` já existente em `~/.local/bin`. |
| `--no-shell` | Não altera o `~/.zshrc`. |

## Desenvolvimento

```bash
npm run check
```

## Banner

O gatinho e o título são grids editáveis em `assets/logo.txt` e `assets/titulo.txt`
(`#` aceso, `.` apagado). Para desligar o banner: `MABEL_BANNER=0`.
