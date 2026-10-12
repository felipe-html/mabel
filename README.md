# Mabel

O Mabel executa o backlog de um projeto com agentes Claude Code, de forma auditável e
com intervenção humana só onde ela importa: regras de negócio críticas e o merge.

Você escreve o que quer no `backlog.md` do projeto. O Mabel pega um item por vez, cria
uma branch isolada, planeja, implementa, verifica e revisa com agentes, e entrega o item
pronto para merge, com as evidências. Quando algo depende de uma decisão sua, o item
para e a pergunta vai para a inbox.

## Princípios

- **"Pronto" é um fato, não uma opinião do agente.** Quem decide se um item terminou é o
  Mabel: comandos de verificação verdes, cada critério de aceite coberto por teste e
  revisão aprovada por outro agente.
- **Regra que importa é trava, não pedido.** O que o Mabel garante é imposto por código
  (gates, banco, permissões das etapas); o que depende de o modelo obedecer é tratado
  como pedido. A divisão está no [contrato](docs/CONTRATO.md).
- **Sua atenção é o recurso mais escasso.** Perguntas chegam em lote, com sugestão de
  resposta. O que não toca regra crítica o agente decide e registra como suposição.
- **Tudo é auditado.** Cada execução do Claude fica no banco: prompt, modelo, ferramentas
  usadas, custo, tokens, saldo e o transcript completo.

## Como funciona

```
backlog.md → ready → planning → planned → executing → verifying → reviewing → awaiting_merge → done
                                              ↑            │            │
                                              └────────────┴────────────┘  falha de gate ou revisão

desvios: needs_human (pergunta para você) · blocked · failed · cancelled
```

| Etapa | Quem faz | O que sai |
|---|---|---|
| Planejar | Agente (Opus), só leitura | Critérios de aceite, escopo de arquivos, passos, suposições e perguntas |
| Executar | Agente (Sonnet) no worktree do item | Código e testes, com cada critério ligado a um teste |
| Verificar | O Mabel, sem agente | Comandos de `verify` do projeto e conferência dos testes declarados |
| Revisar | Agente (Opus), só leitura | Parecer por critério e problemas encontrados |

- **Isolamento:** cada item trabalha num worktree e numa branch `mabel/<n>-<titulo>`,
  fora do diretório do projeto. O Mabel faz os commits; os agentes não usam git.
- **Retentativas:** falha de verificação ou de revisão volta para a execução. Depois de
  duas falhas, a próxima tentativa usa um modelo acima. Três falhas param o item para você.
- **Planejamento em lote:** o `run` planeja todos os itens prontos antes de executar, para
  que as perguntas cheguem juntas no começo e a execução siga sem você.
- **Saldo:** antes de cada etapa, o Mabel confere as janelas de uso de 5 horas e de 7 dias
  e estima o consumo da etapa. Se não houver folga, pergunta ou espera o reset. Um rodapé
  fixo mostra as duas janelas.
- **Avisos:** no macOS, uma notificação do sistema avisa quando a fila termina ou espera você.

## Instalação

Requer macOS ou Linux, Node ≥ 22.18, git e o Claude Code CLI autenticado.

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

## Primeiros passos

> Até o passo 5 do plano (trava de escopo por hook), o agente de execução tem terminal
> protegido só por uma lista de comandos proibidos. Use o Mabel em projetos descartáveis
> ou com tudo commitado.

```bash
cd ~/projetos/minha-app        # um repositório git
mabel                          # abre o modo Mabel
```

No modo Mabel, os comandos começam com `/`:

1. **`/init`** prepara o projeto: escolhe a stack, detecta os comandos de instalação e de
   verificação, cria o `.mabel/` e faz o commit dele. Projeto sem testes ganha como
   primeiro item "Estabelecer base de testes".
2. **`/add`** acrescenta itens ao backlog, ou edite `.mabel/backlog.md` direto.
3. **`/run`** consome a fila: planeja tudo, oferece a inbox se houver perguntas e executa
   item a item até cada um chegar a `awaiting_merge`.
4. **Revise e faça o merge** da branch de cada item. No próximo `/run`, o item vira `done`.

### Escrevendo itens

```markdown
## Exportar pedidos em CSV
Quero baixar a lista de pedidos para abrir no Excel.

Critérios:
- Uma linha por pedido, com data, cliente e valor
- Valores com vírgula decimal

Depende de: 2
Restrições: não adicionar bibliotecas novas
```

| Nível | O que escrever | Efeito |
|---|---|---|
| Mínimo | Título e intenção | O planejador propõe os critérios e registra as suposições |
| Recomendado | Com `Critérios:` | O revisor julga o código contra o que você espera |
| Completo | Com `Depende de:` e `Restrições:` | Para itens encadeados ou com limites técnicos |

A ordem no arquivo é a prioridade. O Mabel acrescenta a linha `id:` em cada item.

### Regras críticas

Em `.mabel/regras-criticas.md`, declare o que exige sua aprovação: **caminhos** (globs de
arquivos) e **conceitos** (regras de negócio em linguagem natural). Item que toca uma
delas para antes da execução para você aprovar os critérios. Arquivo vazio: nada é
crítico e a esteira roda sozinha.

## Comandos

Todos funcionam no modo Mabel (`/comando`) e no shell (`mabel comando`).

| Comando | O que faz |
|---|---|
| `init [--stack <id>]` | Prepara o projeto atual para o Mabel |
| `add` | Adiciona um item ao backlog |
| `run [--item <n>] [--uma] [--sem-lote]` | Consome a fila. `--item` processa um item; `--uma` para no primeiro estado final; `--sem-lote` planeja e executa item a item |
| `inbox` | Responde às decisões pendentes, uma por vez, com sugestão do agente |
| `item <n>` | Detalhe do item: estado, pendência, plano, custo e runs |
| `aprovar <n>` | Aprova os critérios de um item crítico |
| `responder <n> "<resposta>" [--replanejar]` | Responde a um item parado em `needs_human` |
| `cancelar <n>` | Cancela um item |
| `status [--atualizar]` | Saldo, resumo da fila e runs recentes; `--atualizar` lê o saldo agora |
| `exec "<prompt>"` | Executa um prompt avulso no Claude Code, com auditoria |
| `completion zsh` | Script de autocompletar do shell |

No modo Mabel: `/` abre a lista de comandos, Tab completa, ↑/↓ percorrem o histórico e
`exit`, `/sair` ou Ctrl+D encerram.

## Onde ficam as coisas

| Caminho | Conteúdo |
|---|---|
| `.mabel/config.json` | Branch base, `setup`, comandos de `verify`, modelos e limites por etapa, `autonomia` |
| `.mabel/backlog.md` | Itens do backlog (versionado, escrito por você) |
| `.mabel/regras-criticas.md` | Caminhos e conceitos críticos (versionado) |
| `.mabel/quadro.md` | Quadro kanban gerado a cada transição (fora do git; editar não tem efeito) |
| `~/.mabel/mabel.db` | Estado dos itens e auditoria (SQLite) |
| `~/.mabel/runs/<id>/` | Saída bruta, stderr e transcript de cada execução |
| `~/.mabel/items/<id>/` | Plano, execuções, verificações e revisões de cada item |
| `~/.mabel/worktrees/` | Worktrees dos itens em andamento |

| Variável | Efeito |
|---|---|
| `MABEL_HOME` | Diretório de dados no lugar de `~/.mabel` |
| `MABEL_BANNER=0` | Desliga o banner |
| `MABEL_RODAPE=0` | Desliga o rodapé de saldo |
| `MABEL_NOTIFICAR=0` | Desliga as notificações do sistema |
| `NO_COLOR` | Saída sem cores |

## Documentação

- [docs/CONTRATO.md](docs/CONTRATO.md): o que o Mabel garante e o que apenas pede.
- [docs/PLANO.md](docs/PLANO.md): estado da implementação e histórico.
- [docs/specs/](docs/specs/): especificação de cada passo.
- [BACKLOG.md](BACKLOG.md): ideias em discussão.

## Desenvolvimento

```bash
npm run check
```

TypeScript executado direto pelo Node, sem build e sem dependências de runtime. Os testes
não chamam a API: usam um `claude` falso dirigido por cenário. Convenções em
[CLAUDE.md](CLAUDE.md).

O gatinho e o título do banner são grids editáveis em `assets/logo.txt` e
`assets/titulo.txt` (`#` aceso, `.` apagado).
