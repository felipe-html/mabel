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
  sandbox do agente); se falhar, o executor recebe o log de fora do sandbox e corrige numa
  nova tentativa, que conta como qualquer outra. O item só para para você na hora quando
  não há nada a verificar (nenhuma alteração). Ajuste o ambiente e responda o que mudou: a
  execução retoma e verifica de novo.
- **Planejamento em lote:** o `rodar` planeja todos os itens prontos antes de executar, para
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
  porta local é permitido (bundlers como o Turbopack precisam). Em projeto Next, o `preparar`
  já libera `fonts.googleapis.com` e `fonts.gstatic.com`, que o `next/font/google` usa no
  build. Sem sandbox no sistema, o `rodar` não inicia.
- **Auditoria das negações:** cada decisão do hook fica na run, e `mabel detalhar <n>` lista o
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
mabel                          # abre a tela inicial
```

A tela inicial mostra o projeto, o que espera por você (itens prontos, pendências, unidades
prontas) e os comandos agrupados: Começar, Planejar, Rodar, Decidir, Entregar, Acompanhar e
Avulso. ↑ ↓ navegam, enter abre, digitar filtra a lista e esc limpa o filtro (ou sai). Cada
comando mostra à direita o nome no shell (`mabel rodar`), que faz o mesmo fora da tela.

1. **Preparar este projeto** (`mabel preparar`) escolhe a stack, detecta os comandos de
   instalação e de verificação, cria o `.mabel/` e faz o commit dele. Projeto sem testes
   ganha como primeiro item "Estabelecer base de testes". Depois do merge dele, inclua o
   comando de teste em `verify` no `.mabel/config.json`: o agente não altera o config.
   Para começar do zero, **Criar um projeto novo** (`mabel criar "<descrição>"`) num
   diretório vazio (ou num repositório sem `.mabel/`) conversa com um agente que propõe a
   stack, o `CLAUDE.md`, as regras críticas e o backlog inicial, em até 3 rodadas de
   perguntas. Você revisa parte a parte; o que aceitar é gravado pelo caminho do
   `preparar` e commitado como "mabel criar".
2. **Adicionar um item** (`mabel adicionar`) acrescenta itens ao backlog, ou edite
   `.mabel/backlog.md` direto. Specs e referências também vão no `.mabel/`: não precisa
   commitar, o `rodar` commita o que estiver pendente nele na base (só esse diretório)
   antes de começar. **Refinar um item** (`mabel refinar`) pede a um agente uma proposta
   de critérios, decisões e limites; você revisa e só o que aceitar entra no backlog.
3. **Rodar a fila** (`mabel rodar`) planeja tudo, oferece as pendências se houver
   perguntas e executa item a item até cada um chegar a `awaiting_merge`.
4. **Revise e entregue.** Cada tarefa aprovada entra na branch da sua unidade, e
   **Entregar uma unidade** (`mabel entregar`) mostra as prontas, prova uma contra a base,
   publica o snapshot (`mabel/entrega/<unidade>`), abre o PR (pelo `gh` no GitHub; pela API
   no Bitbucket, com o `BITBUCKET_TOKEN`, em [PR no Bitbucket](#pr-no-bitbucket); sem eles,
   mostra o link do PR e o texto) e volta o seu checkout para a base. Faça o merge com
   merge commit ("Create a merge commit" no GitHub, "Merge commit" no Bitbucket) e dê
   `git pull` na base: no próximo `rodar`, os itens viram `done`.

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

O `mabel auditar <nome>` mostra quantas perguntas e suposições cada item gerou, separando
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
mabel capturar api wego-acessos https://…/q/swagger-ui/      # OpenAPI em JSON
mabel capturar tela home-operador '<link do frame no Figma>'  # PNG e tela.md
mabel capturar tela home-operador exportado.png              # sem token: o PNG exportado
mabel capturar                                                # lista e quem cita
```

A captura do Figma usa um token pessoal (Settings › Security › Personal access tokens,
leitura de arquivos) em `FIGMA_TOKEN`. Guarde-o num arquivo só seu e carregue-o no shell:

```
read -rs "t?Token do Figma: " && print -r -- "export FIGMA_TOKEN='$t'" > ~/.figma_token && chmod 600 ~/.figma_token && unset t
echo '[ -f ~/.figma_token ] && source ~/.figma_token' >> ~/.zshrc
```

Registre a data de vencimento que você escolheu ao criar o token; o `mabel conferir` e o
`referencia tela` avisam a partir de 14 dias do fim:

```
mabel credenciar figma --expira 2027-01-20
```

Abra um terminal novo (ou saia e entre de novo no Mabel): um processo só vê as
variáveis que existiam quando ele abriu. O token não é gravado em lugar nenhum pelo Mabel
e não chega ao agente. No `tela.md`, escreva abaixo de `<!-- notas -->` o que o agente
precisa saber (por exemplo, que os textos dos cards são dados de exemplo); as notas
ficam na recaptura.

### PR no Bitbucket

Com o remoto no Bitbucket Cloud, o `mabel entregar` abre o PR pela API quando encontra o
token no ambiente. Crie um *API token* da sua conta Atlassian em id.atlassian.com ›
Security › API tokens › **Create API token with scopes**, escolha o app **Bitbucket** e
marque os escopos `read:repository:bitbucket` e `write:pullrequest:bitbucket`. O token
leva o seu e-mail da Atlassian junto. Guarde os dois num arquivo só seu e carregue-o no
shell:

```
read -r "e?E-mail da Atlassian: " && read -rs "t?Token do Bitbucket: " && print -r -- "export BITBUCKET_EMAIL='$e'"$'\n'"export BITBUCKET_TOKEN='$t'" > ~/.bitbucket_token && chmod 600 ~/.bitbucket_token && unset e t
echo '[ -f ~/.bitbucket_token ] && source ~/.bitbucket_token' >> ~/.zshrc
```

No lugar do token da conta, serve também um *access token* do repositório ou do workspace
(Repository settings › Security › Access tokens, com o escopo **Pull requests: Write**):
defina só o `BITBUCKET_TOKEN`, sem o `BITBUCKET_EMAIL`. O PR sai em nome do token, não do
seu usuário.

O token da Atlassian sempre vence (no máximo um ano). Registre a data para o Mabel avisar
a partir de 14 dias do fim, no `mabel conferir` e no `entregar`:

```
mabel credenciar bitbucket --expira 2027-11-04
```

Abra um terminal novo depois de definir as variáveis. Como o do Figma, o token não é
gravado pelo Mabel, não chega ao agente e não aparece na linha de comando (a chamada à API
passa pelo `curl`, com a credencial no stdin). Sem o token, ou se o Bitbucket recusá-lo, o
`entregar` publica a branch e mostra o link para abrir o PR à mão, com o motivo. O Mabel
não confere a estratégia de merge no Bitbucket: no merge, escolha "Merge commit".

### Regras críticas

Em `.mabel/regras-criticas.md`, declare o que exige sua aprovação: **caminhos** (globs de
arquivos) e **conceitos** (regras de negócio em linguagem natural). Item que toca uma
delas para antes da execução para você aprovar os critérios. Arquivo vazio: nada é
crítico e a esteira roda sozinha.

## Comandos

Todos funcionam no shell (`mabel <comando>`); os que têm título aparecem na tela inicial.

| Título na tela inicial | Comando | O que faz |
|---|---|---|
| Preparar este projeto | `preparar [--stack <id>]` | Prepara o projeto atual para o Mabel |
| Criar um projeto novo | `criar ["<descrição>"] [--stack <id>] [--modelo <m>]` | Conversa com um agente, num diretório vazio ou num repositório sem `.mabel/`, que propõe stack, `CLAUDE.md`, regras críticas e backlog inicial; você revisa e o Mabel grava pelo `preparar`. Sem TTY: `--responder`, `--aceitar`, `--descartar`, `--lista` e `--json` |
| Adicionar um item | `adicionar` | Adiciona um item ao backlog; no terminal, um formulário, com as referências escolhidas numa lista do que já foi capturado (`--referencia <entrada>` fora dele) |
| Especificar uma funcionalidade | `especificar [<slug>]` | Lista, valida e aceita as specs de `.mabel/specs/` |
| Refinar um item | `refinar [<n>] [--refazer] [--aceitar \| --descartar]` | Proposta de refinamento de um item, por agente, para você revisar antes de gravar no backlog; `refinar <n> --referencias` só escolhe as referências, sem agente |
| Capturar uma referência | `capturar [tela \| api] …` | Captura telas do Figma e APIs OpenAPI para os itens citarem em "Referências:"; sem argumentos, lista |
| Credenciar um token | `credenciar [<nome>] [--expira <data>]` | Registra e mostra a validade dos tokens (Figma e Bitbucket) |
| Rodar a fila | `rodar [--item <n> \| --limite <n>] [--sem-lote] [--fundo]` | Consome a fila. `--item` processa um item; `--limite <n>` toma no máximo n itens; `--sem-lote` planeja e executa item a item; `--fundo` entrega a fila ao supervisor e volta na hora |
| Acompanhar a fila | `acompanhar` | Acompanha ao vivo a fila em segundo plano do projeto; Ctrl+C solta sem parar a fila |
| Parar a fila | `parar` | Para a fila do projeto (em segundo plano ou num terminal) depois da etapa em andamento |
| Decidir as pendências | `decidir` | Responde às decisões pendentes, uma por vez, com sugestão do agente |
| Retomar um item | `retomar <n> [--orientacao <texto>]` | Devolve à fila um item parado por falha ou bloqueio; o planejamento recebe o motivo e a orientação |
| Cancelar um item | `cancelar <n>` | Cancela um item |
| Entregar uma unidade | `entregar [<slug> \| #<n>] [--com <unidade>] [--parcial] [--substituir] [--rascunho]` | Sem unidade, mostra as prontas para entregar, as em andamento e a integração; com ela, prova a unidade contra a base, abre o PR e volta o checkout para a base |
| Rejeitar um item | `rejeitar <n> "<motivo>" [--cancelar]` | Reverte um item na unidade e o devolve ao planejamento (ou o cancela) |
| Conferir o estado | `conferir [--atualizar]` | Saldo (e a pausa por saldo, se houver), resumo da fila e runs recentes; `--atualizar` lê o saldo agora |
| Detalhar um item | `detalhar <n>` | Detalhe do item: estado, pendência, plano, custo e runs |
| Consultar as runs | `consultar [<id>]` | Lista as runs auditadas; com um id, o detalhe e as ferramentas |
| Listar os projetos | `listar` | Projetos registrados: itens, runs, custo e última atividade |
| Auditar um projeto | `auditar <nome> \| remover <nome>` | Auditoria de um projeto; `remover` apaga os dados dele no Mabel |
| Pedir algo avulso | `pedir "<prompt>"` | Executa um prompt avulso no Claude Code, com auditoria |
| | `aprovar <n>` | Aprova os critérios de um item crítico |
| | `responder <n> "<resposta>" [--replanejar]` | Responde a um item parado em `needs_human`; `--respostas <arquivo.json>` traz uma resposta por pergunta |
| | `saldo [--atualizar]` | As duas janelas de saldo e a pausa da fila por saldo, se houver |
| | `supervisor [instalar \| remover \| estado]` | Processo que roda as filas em segundo plano; `instalar` grava o LaunchAgent, que o sobe com a sessão do macOS |
| | `eventos --json` | Fluxo de eventos de todos os projetos, uma linha de JSON por evento |
| | `comandos [--json]` | Todos os comandos com as opções e os argumentos explicados |
| | `completion zsh` | Script de autocompletar do shell: comandos, opções e valores (itens, projetos, referências) com a explicação de cada um |

`listar`, `conferir`, `saldo`, `decidir` e `auditar <nome>` aceitam `--json` (uma linha com
`"versao": 1`), e `eventos --json` escreve um evento por linha. `aprovar`, `responder`,
`parar`, `rodar --fundo` e `auditar remover` também aceitam `--json`, e com `--json` o erro
sai no stderr como `{"versao":1,"erro":{"codigo","mensagem"}}`. O formato está em
`docs/specs/integracao-externa.md`.

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
| `~/.mabel/filas/<projeto>.log` | Saída das filas em segundo plano (o `acompanhar` lê daqui) |
| `~/.mabel/supervisor.sock`, `supervisor.log` | Socket e log do supervisor |

| Variável | Efeito |
|---|---|
| `MABEL_HOME` | Diretório de dados no lugar de `~/.mabel` |
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
