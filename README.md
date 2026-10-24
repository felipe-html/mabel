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
  Retentativa em que o código já está certo não reprova por falta de alteração: o Mabel
  verifica de novo o que já foi commitado.
- **Impedimento de ambiente:** quando a verificação não passa por causa do ambiente
  (domínio fora da `rede`, bloqueio do sandbox), o executor o declara. O Mabel roda a
  própria verificação, fora do sandbox: se passar, o item segue (o bloqueio era só do
  sandbox do agente); se falhar, o item para para você na hora, com o trabalho commitado e
  sem gastar tentativas. Ajuste o ambiente e responda o que mudou: a execução retoma e
  verifica de novo.
- **Planejamento em lote:** o `run` planeja todos os itens prontos antes de executar, para
  que as perguntas cheguem juntas no começo e a execução siga sem você.
- **Saldo:** antes de cada etapa, o Mabel confere as janelas de uso de 5 horas e de 7 dias
  e estima o consumo da etapa. Se não houver folga, pergunta ou espera o reset. Um rodapé
  fixo mostra as duas janelas.
- **Avisos:** no macOS, uma notificação do sistema avisa quando a fila termina ou espera você.
- **Mabel atualizado:** se o código do Mabel mudar com o `mabel` aberto (um `git pull`, um
  merge), a fila pausa antes da próxima etapa e pede para abrir o `mabel` de novo. O
  processo aberto continuaria com o código antigo e os prompts novos.

### Travas

O que o agente pode fazer em cada etapa é imposto pelo Mabel e pelo Claude Code, não
pedido no prompt:

- **Contexto hermético:** os agentes rodam sem a sua configuração pessoal (memória, MCP,
  skills, plugins, `CLAUDE.md` global). Recebem só as regras do Mabel e o contexto do
  projeto (`CLAUDE.md`, `AGENTS.md` e as regras críticas), com limite de tamanho. Uma run
  que mostra qualquer outra coisa no início é interrompida.
- **Ferramentas por etapa:** o planejador só lê; o revisor lê e roda `git diff`, `git log`
  e `git show`; só o executor edita e usa o terminal.
- **Escopo de arquivos:** um hook nega a escrita fora do escopo do plano, em `.git/`, em
  `.mabel/` e em caminhos críticos sem a sua aprovação. O `.mabel/config.json` é seu: o
  plano que o inclui no escopo volta ao planejador, e a mudança sugerida chega a você como
  recomendação. Se o executor precisar de um
  caminho a mais, ele o declara: o Mabel amplia o escopo sozinho, ou pede a sua aprovação
  quando o caminho é crítico.
- **Sandbox no terminal:** os comandos do executor só escrevem no worktree do item (e nos
  caches de pacotes da stack), não conseguem fazer commit nem mover branches, e a rede só
  alcança o registro de pacotes da stack e os domínios que você liberar em `rede`. Abrir
  porta local é permitido (bundlers como o Turbopack precisam). Em projeto Next, o `init`
  já libera `fonts.googleapis.com` e `fonts.gstatic.com`, que o `next/font/google` usa no
  build. Sem sandbox no sistema, o `run` não inicia.
- **Auditoria das negações:** cada decisão do hook fica na run, e `mabel item <n>` lista o
  que foi negado.

## Instalação

Requer macOS ou Linux, Node ≥ 22.18, git e o Claude Code CLI autenticado. No Linux, o
sandbox precisa de `bubblewrap` e `socat`.

```bash
scripts/setup.sh
```

O script faz o preflight (sistema, Node, `node:sqlite`, npm, git, Claude Code com as
flags que o Mabel usa, sandbox do sistema, zsh, PATH), instala as dependências, cria `~/.mabel/`, liga `mabel` em `~/.local/bin`,
configura o autocompletar no `~/.zshrc` e roda typecheck e testes. Pode ser executado
várias vezes.

| Opção | Efeito |
|---|---|
| `--check` | Só o preflight, sem alterar nada. |
| `--force` | Substitui um `mabel` já existente em `~/.local/bin`. |
| `--no-shell` | Não altera o `~/.zshrc`. |

## Primeiros passos

```bash
cd ~/projetos/minha-app        # um repositório git
mabel                          # abre o modo Mabel
```

No modo Mabel, os comandos começam com `/`:

1. **`/init`** prepara o projeto: escolhe a stack, detecta os comandos de instalação e de
   verificação, cria o `.mabel/` e faz o commit dele. Projeto sem testes ganha como
   primeiro item "Estabelecer base de testes". Depois do merge dele, inclua o comando de
   teste em `verify` no `.mabel/config.json`: o agente não altera o config.
   Para começar do zero, **`mabel nascer "<descrição>"`** num diretório vazio (ou num
   repositório sem `.mabel/`) conversa com um agente que propõe a stack, o `CLAUDE.md`, as
   regras críticas e o backlog inicial, em até 3 rodadas de perguntas. Você revisa parte a
   parte; o que aceitar é gravado pelo caminho do `init` e commitado como "mabel nascer".
2. **`/add`** acrescenta itens ao backlog, ou edite `.mabel/backlog.md` direto. Specs e
   referências também vão no `.mabel/`: não precisa commitar, o `/run` commita o que
   estiver pendente nele na base (só esse diretório) antes de começar.
   **`/refinar`** pede a um agente uma proposta de critérios, decisões e limites para um
   item; você revisa e só o que aceitar entra no backlog.
3. **`/run`** consome a fila: planeja tudo, oferece a inbox se houver perguntas e executa
   item a item até cada um chegar a `awaiting_merge`.
4. **Revise e entregue.** Cada item aprovado entra sozinho na branch `mabel/integracao`, e
   `/integracao` mostra o relatório. **`/entregar`** publica um snapshot dela
   (`mabel/entrega/<data>`), abre o PR com o relatório (pelo `gh` no GitHub; sem ele ou no
   Bitbucket, mostra o link do PR e o texto) e volta o seu checkout para a base. Faça o merge com "Create a merge commit" e
   dê `git pull` na base: no próximo `/run`, os itens viram `done`.

### Escrevendo itens

```markdown
## Exportar pedidos em CSV
Quero baixar a lista de pedidos para abrir no Excel.

Critérios:
- Uma linha por pedido, com data, cliente e valor
- Valores com vírgula decimal

Fora do escopo:
- Exportar itens do pedido

Decisões:
- Pedidos cancelados entram? → Não

Depende de: 2
Restrições: não adicionar bibliotecas novas
```

Quanto detalhe escrever: **o que só você sabe e o que, se o agente errasse, faria você
reclamar.** O resto o agente tira do código ou decide e registra como suposição. Um bom
item responde: para quê (intenção), o que muda visto de fora (`Critérios:`), que regras de
negócio já estão decididas (`Decisões:`) e o que fica de fora (`Fora do escopo:`).

| Item | O que escrever | Efeito |
|---|---|---|
| Ajuste pequeno, sem regra de negócio | Título e intenção | O planejador propõe os critérios e registra as suposições |
| Com regra de negócio | Intenção, critérios, decisões e fora do escopo | O planejador não pergunta o que já está decidido; o revisor julga contra o que você espera |
| Toca regra crítica | Também `Regras críticas:` com os conceitos | Só fica pronto com critérios e sempre passa pela sua aprovação |
| Encadeado ou com limite técnico | `Depende de:` e `Restrições:` | Ordem e limites da implementação |
| Usa tela ou API | `Referências:` com `tela: <nome>` e `api: <nome> <MÉTODO> <caminho>` | Só fica pronto com as referências capturadas; o agente lê uma cópia congelada |

O `mabel projeto <nome>` mostra quantas perguntas e suposições cada item gerou, separando
os refinados dos não refinados: é o sinal de quanto detalhe falta no backlog.

A ordem no arquivo é a prioridade. O Mabel acrescenta a linha `id:` em cada item.

### Referências de tela e de API

O agente não abre links (Figma, Swagger): as runs são herméticas. Guarde cópias em
`.mabel/referencias/`, versionadas, e cite-as no item:

```
.mabel/referencias/
  api/<nome>.openapi.json     # OpenAPI 3 em JSON
  telas/<nome>/               # tela.png, estados, tela.md com textos e medidas
```

```
Referências:
- tela: cadastro-acesso
- api: wego-acessos POST /v1/acessos
- api: wego-acessos listarPerfis
- docs/regras-de-cpf.md
```

A operação vem do snapshot, literal (`MÉTODO /caminho` ou `operationId`). Referência que
não confere deixa o item no backlog com o motivo. Atualizar um snapshot faz o item não
iniciado ser relido; o iniciado segue com a cópia feita no começo do planejamento, que
traz a operação já extraída com os esquemas que ela usa. Spec: `docs/specs/referencias.md`.

Para capturar:

```
mabel referencia api wego-acessos https://…/q/swagger-ui/      # OpenAPI em JSON
mabel referencia tela home-operador '<link do frame no Figma>'  # PNG e tela.md
mabel referencia tela home-operador --png exportado.png         # sem token
mabel referencia                                                # lista e quem cita
```

A captura do Figma usa um token pessoal (Settings › Security › Personal access tokens,
leitura de arquivos) em `FIGMA_TOKEN`. Guarde-o num arquivo só seu e carregue-o no shell:

```
read -rs "t?Token do Figma: " && print -r -- "export FIGMA_TOKEN='$t'" > ~/.figma_token && chmod 600 ~/.figma_token && unset t
echo '[ -f ~/.figma_token ] && source ~/.figma_token' >> ~/.zshrc
```

Registre a data de vencimento que você escolheu ao criar o token; o `mabel status` e o
`referencia tela` avisam a partir de 14 dias do fim:

```
mabel credencial figma --expira 2027-01-20
```

Abra um terminal novo (ou saia e entre de novo no modo Mabel): um processo só vê as
variáveis que existiam quando ele abriu. O token não é gravado em lugar nenhum pelo Mabel
e não chega ao agente. No `tela.md`, escreva abaixo de `<!-- notas -->` o que o agente
precisa saber (por exemplo, que os textos dos cards são dados de exemplo); as notas
ficam na recaptura.

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
| `nascer ["<descrição>"] [--stack <id>] [--modelo <m>]` | Conversa com um agente, num diretório vazio ou num repositório sem `.mabel/`, que propõe stack, `CLAUDE.md`, regras críticas e backlog inicial; você revisa e o Mabel grava pelo `init`. Sem TTY: `--responder`, `--aceitar`, `--descartar`, `--lista` e `--json` |
| `add` | Adiciona um item ao backlog |
| `refinar [<n>] [--refazer] [--aceitar \| --descartar]` | Proposta de refinamento de um item, por agente, para você revisar antes de gravar no backlog |
| `run [--item <n>] [--uma] [--sem-lote] [--fundo]` | Consome a fila. `--item` processa um item; `--uma` para no primeiro estado final; `--sem-lote` planeja e executa item a item; `--fundo` entrega a fila ao supervisor e volta na hora |
| `anexar` | Acompanha ao vivo a fila em segundo plano do projeto; Ctrl+C solta sem parar a fila |
| `parar` | Para a fila do projeto (em segundo plano ou num terminal) depois da etapa em andamento |
| `inbox` | Responde às decisões pendentes, uma por vez, com sugestão do agente |
| `item <n>` | Detalhe do item: estado, pendência, plano, custo e runs |
| `aprovar <n>` | Aprova os critérios de um item crítico |
| `responder <n> "<resposta>" [--replanejar]` | Responde a um item parado em `needs_human` |
| `cancelar <n>` | Cancela um item |
| `integracao` | Relatório da branch de integração: o que levar à base e o que olhar primeiro |
| `entregar [--substituir] [--rascunho]` | Publica um snapshot da integração, abre o PR com o relatório e volta o checkout para a base; `--substituir` troca a entrega aberta pela integração atual |
| `rejeitar <n> "<motivo>" [--cancelar]` | Reverte um item na integração e o devolve ao planejamento (ou o cancela) |
| `status [--atualizar]` | Saldo, resumo da fila e runs recentes; `--atualizar` lê o saldo agora |
| `saldo [--atualizar]` | As duas janelas de saldo e a pausa da fila por saldo, se houver |
| `supervisor [instalar \| remover \| estado]` | Processo que roda as filas em segundo plano (só no shell); `instalar` grava o LaunchAgent, que o sobe com a sessão do macOS |
| `exec "<prompt>"` | Executa um prompt avulso no Claude Code, com auditoria |
| `completion zsh` | Script de autocompletar do shell |

`projetos`, `status`, `saldo`, `inbox` e `projeto <nome>` aceitam `--json` (uma linha com
`"versao": 1`), e `eventos --json` escreve um evento por linha; o formato está em
`docs/specs/integracao-externa.md`.

No modo Mabel: `/` abre a lista de comandos, Tab completa, ↑/↓ percorrem o histórico e
`exit`, `/sair` ou Ctrl+D encerram.

## Onde ficam as coisas

| Caminho | Conteúdo |
|---|---|
| `.mabel/config.json` | Branch base, `setup`, comandos de `verify`, modelos e limites por etapa, `autonomia`, `rede` (domínios liberados no sandbox), `contexto.maxCaracteres` (limite do contexto do projeto) e `sandbox` (`false` desliga, por sua conta) |
| `.mabel/backlog.md` | Itens do backlog (versionado, escrito por você) |
| `.mabel/regras-criticas.md` | Caminhos e conceitos críticos (versionado) |
| `.mabel/quadro.md` | Quadro kanban gerado a cada transição (fora do git; editar não tem efeito) |
| `~/.mabel/mabel.db` | Estado dos itens e auditoria (SQLite) |
| `~/.mabel/runs/<id>/` | Saída bruta, stderr e transcript de cada execução |
| `~/.mabel/items/<id>/` | Plano, execuções, verificações e revisões de cada item |
| `~/.mabel/worktrees/` | Worktrees dos itens em andamento |
| `~/.mabel/entregas/<projeto>/` | Corpo do PR de cada entrega |
| `~/.mabel/filas/<projeto>.log` | Saída das filas em segundo plano (o `anexar` lê daqui) |
| `~/.mabel/supervisor.sock`, `supervisor.log` | Socket e log do supervisor |

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
