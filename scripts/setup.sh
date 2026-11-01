#!/usr/bin/env bash
# Prepara o ambiente do Mabel: preflight, dependências, comando `mabel` no PATH,
# autocompletar do zsh e verificação final. Pode ser executado várias vezes.
#
# Uso: scripts/setup.sh [--check] [--force] [--no-shell]
#   --check     só o preflight, sem alterar nada
#   --force     substitui um `mabel` já existente em ~/.local/bin
#   --no-shell  não altera o ~/.zshrc

set -euo pipefail

NODE_MIN_MAJOR=22
NODE_MIN_MINOR=18

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
DATA_DIR="$HOME/.mabel"
ZSHRC="$HOME/.zshrc"
COMPLETION_LINE='eval "$(mabel completion zsh)"'
ZSHRC_MARKER='# mabel: autocompletar'

CHECK_ONLY=0
FORCE=0
SHELL_SETUP=1
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
    --no-shell) SHELL_SETUP=0 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  GREEN=$'\e[32m' YELLOW=$'\e[33m' RED=$'\e[31m' DIM=$'\e[2m' BOLD=$'\e[1m' RESET=$'\e[0m'
else
  GREEN='' YELLOW='' RED='' DIM='' BOLD='' RESET=''
fi

ERRORS=0
WARNINGS=0
ok()      { echo "  ${GREEN}✓${RESET} $1"; }
warn()    { echo "  ${YELLOW}!${RESET} $1"; WARNINGS=$((WARNINGS + 1)); }
fail()    { echo "  ${RED}✗${RESET} $1"; ERRORS=$((ERRORS + 1)); }
hint()    { echo "    ${DIM}$1${RESET}"; }
section() { echo; echo "${BOLD}$1${RESET}"; }

# ---------------------------------------------------------------- preflight

section "Preflight"

case "$(uname -s)" in
  Darwin|Linux) ok "Sistema: $(uname -s) $(uname -m)" ;;
  *) fail "Sistema não suportado: $(uname -s)" ;;
esac

if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -p 'process.versions.node')"
  if node -e "
    const [major, minor] = process.versions.node.split('.').map(Number);
    process.exit(major > $NODE_MIN_MAJOR || (major === $NODE_MIN_MAJOR && minor >= $NODE_MIN_MINOR) ? 0 : 1);
  "; then
    ok "Node $NODE_VERSION"
  else
    fail "Node $NODE_VERSION — o Mabel exige ≥ $NODE_MIN_MAJOR.$NODE_MIN_MINOR (TypeScript nativo)"
  fi
  if node -e "require('node:sqlite')" 2>/dev/null; then
    ok "node:sqlite disponível"
  else
    fail "node:sqlite indisponível nesta versão do Node"
  fi
else
  fail "Node não encontrado"
  hint "Instale o Node ≥ $NODE_MIN_MAJOR.$NODE_MIN_MINOR (ex.: https://nodejs.org ou via fnm/nvm)."
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm --version)"
else
  fail "npm não encontrado"
fi

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
  if git -C "$ROOT" worktree list >/dev/null 2>&1; then
    ok "git worktree disponível"
  else
    warn "O diretório do Mabel não é um repositório git"
  fi
else
  fail "git não encontrado (necessário para os worktrees dos itens)"
fi

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"
  CLAUDE_HELP="$(claude --help 2>/dev/null)"
  # Etapas herméticas e travas (passo 5): o Mabel não roda sem estas flags.
  MISSING_FLAGS=""
  for flag in --output-format --restricted --strict-mcp-config --disable-slash-commands --tools --settings; do
    grep -q -- "$flag" <<<"$CLAUDE_HELP" || MISSING_FLAGS="$MISSING_FLAGS $flag"
  done
  if [[ -n "$MISSING_FLAGS" ]]; then
    fail "Esta versão do Claude Code não tem:$MISSING_FLAGS"
    hint "Atualize o Claude Code (claude update); o Mabel usa essas flags para isolar e travar os agentes."
  fi
else
  fail "Claude Code CLI não encontrado"
  hint "Instale com: curl -fsSL https://claude.ai/install.sh | bash"
fi

# Sandbox do Claude Code no terminal do agente (G4): sem ele, o `mabel rodar` não inicia.
case "$(uname -s)" in
  Darwin)
    if [[ -x /usr/bin/sandbox-exec ]]; then
      ok "Sandbox disponível (sandbox-exec)"
    else
      fail "Sandbox indisponível: /usr/bin/sandbox-exec não encontrado"
    fi
    ;;
  Linux)
    MISSING=""
    for command in bwrap socat; do
      command -v "$command" >/dev/null 2>&1 || MISSING="$MISSING $command"
    done
    if [[ -z "$MISSING" ]]; then
      ok "Sandbox disponível (bubblewrap e socat)"
    else
      fail "Sandbox indisponível: falta$MISSING"
      hint "Instale bubblewrap e socat (ex.: sudo apt install bubblewrap socat)."
    fi
    ;;
esac

if command -v zsh >/dev/null 2>&1; then
  ok "zsh $(zsh --version | awk '{print $2}')"
else
  warn "zsh não encontrado — o autocompletar não será configurado"
  SHELL_SETUP=0
fi

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR está no PATH" ;;
  *)
    warn "$BIN_DIR não está no PATH — o comando \`mabel\` não será encontrado"
    hint "Adicione ao ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

if (( ERRORS > 0 )); then
  echo
  echo "${RED}Preflight falhou com $ERRORS erro(s).${RESET} Corrija e rode de novo."
  exit 1
fi

if (( CHECK_ONLY )); then
  echo
  echo "${GREEN}Preflight ok${RESET} ($WARNINGS aviso(s)). Nada foi alterado (--check)."
  exit 0
fi

# ---------------------------------------------------------------- instalação

section "Instalação"

cd "$ROOT"
if [[ -f package-lock.json ]]; then
  npm ci --silent --no-audit --no-fund
else
  npm install --silent --no-audit --no-fund
fi
ok "Dependências de desenvolvimento instaladas"

chmod +x src/cli.ts
mkdir -p "$BIN_DIR" "$DATA_DIR"
ok "Diretório de dados: $DATA_DIR"

LINK="$BIN_DIR/mabel"
TARGET="$ROOT/src/cli.ts"
if [[ -L "$LINK" && "$(readlink "$LINK")" == "$TARGET" ]]; then
  ok "\`mabel\` já aponta para este repositório"
elif [[ -e "$LINK" || -L "$LINK" ]] && (( ! FORCE )); then
  warn "$LINK já existe e aponta para outro lugar — mantido"
  hint "Rode com --force para substituir."
else
  ln -sfn "$TARGET" "$LINK"
  ok "\`mabel\` instalado em $LINK"
fi

if (( SHELL_SETUP )); then
  if [[ -f "$ZSHRC" ]] && grep -qF "$COMPLETION_LINE" "$ZSHRC"; then
    ok "Autocompletar já configurado no ~/.zshrc"
  else
    printf '\n%s\n%s\n' "$ZSHRC_MARKER" "$COMPLETION_LINE" >> "$ZSHRC"
    ok "Autocompletar adicionado ao ~/.zshrc"
  fi
else
  ok "~/.zshrc não alterado"
fi

# ---------------------------------------------------------------- verificação

section "Verificação"

if npm run --silent check >/dev/null 2>&1; then
  ok "Typecheck e testes passaram"
else
  fail "Typecheck ou testes falharam — rode \`npm run check\` para ver os detalhes"
fi

if "$TARGET" --version >/dev/null 2>&1; then
  ok "CLI responde: mabel $("$TARGET" --version)"
else
  fail "A CLI não executou"
fi

echo
if (( ERRORS > 0 )); then
  echo "${RED}Setup terminou com $ERRORS erro(s).${RESET}"
  exit 1
fi
echo "${GREEN}Ambiente pronto${RESET} ($WARNINGS aviso(s)). Abra um novo terminal e digite ${BOLD}mabel${RESET}."
