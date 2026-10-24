# Especificação — App do Mabel para macOS

Interface gráfica do Mabel: lista de projetos, saldo da conta, terminal com o modo Mabel,
inbox nativa e um gato animado por papel. O app é um **projeto novo, em repositório
próprio** (`mabel-app`), e esta spec é o ponto de partida dele: quem começar o projeto
deve conseguir trabalhar só com ela e com a referência visual.

A CLI continua sendo a porta principal do Mabel e o plano B do app. O app é um cliente:
não implementa regra do Mabel, não escreve no banco e não fala com o Claude Code. Tudo o
que ele faz passa pela CLI `mabel`.

Referência visual: [Mabel — referência visual](https://claude.ai/artifact/7zZweawt8Yshx2JRiVi46j)
(lista de projetos, projeto aberto com terminal e inbox, e os gatos por papel e por estado). É um esboço de layout e de comportamento,
não o desenho final dos gatos.

## Decisões

| Tema | Decisão |
|---|---|
| Plataforma | macOS 14 ou mais novo, Swift 6, SwiftUI. iOS fica para o controle remoto (fora desta spec). |
| Repositório | `mabel-app`, separado do `mabel`. O `mabel` não ganha dependência nenhuma por causa do app. |
| Fonte da verdade | A CLI `mabel`. O app lê estado por `--json` e por um fluxo de eventos; age rodando comandos. Nunca lê nem escreve o `~/.mabel/mabel.db` direto. |
| Terminal | SwiftTerm (pacote Swift) num pty rodando `mabel` no diretório do projeto. Atrás de um protocolo `TerminalView`, para trocar pela libghostty se ela estabilizar. |
| Segundo plano | Quem mantém a fila rodando é o supervisor do Mabel, não o app. Fechar a janela ou o app não para nenhuma fila. |
| Saldo | Da conta. Aparece no topo da lista de projetos e no rodapé do modo Mabel dentro do terminal (o rodapé da CLI, sem reimplementar). |
| Mascotes | Um gato por papel, animado com Rive (máquina de estados). Ver "Mascotes". |
| Distribuição | Build local, sem App Store: o App Sandbox impediria rodar `mabel`, `git` e `claude`. Sem App Sandbox, com Hardened Runtime. Assinatura e notarização ficam para depois. |
| Dependências | SwiftTerm e o runtime do Rive (`rive-ios`, que cobre macOS). Outra dependência exige justificativa ao usuário. |
| Idioma | Identificadores em inglês; textos da interface em português. |

## O que o app precisa do Mabel

Nada disto existe hoje na CLI. São pré-requisitos implementados **no repositório `mabel`**,
com spec própria lá, antes ou junto do primeiro incremento do app. Enquanto não existirem,
o app trabalha contra o `mabel-fake` (ver "Testes").

### Supervisor

Processo `mabel supervisor` dono das filas, iniciado por um LaunchAgent
(`~/Library/LaunchAgents/dev.mabel.supervisor.plist`). Ele roda o `run` de cada projeto,
cada um com o lock que já existe (`~/.mabel/locks/<projeto>.lock`), e aplica a política
de saldo única do contrato a todas as filas.

| Comando | Efeito |
|---|---|
| `mabel run --fundo` | Entrega a fila do projeto atual ao supervisor e volta na hora. |
| `mabel anexar` | Mostra ao vivo a saída da fila do projeto atual, como o `run` em primeiro plano. Ctrl+C solta, sem parar a fila. |
| `mabel parar` | Pede ao supervisor que pare a fila do projeto depois da etapa em andamento. |

### Saídas `--json`

Uma linha de JSON por chamada, com `"versao": 1` no topo. O app recusa versão que não
conhece e mostra "Atualize o Mabel" no lugar da tela.

| Comando | Conteúdo |
|---|---|
| `mabel projetos --json` | Por projeto: `id`, `nome`, `raiz`, `fila` (`parada`, `rodando`, `pausada_por_saldo`, `aguardando_humano`), item e etapa em andamento, papel ativo, pendências da inbox, custo total, última atividade. |
| `mabel status --json` | Do projeto atual: a fila por estado, as etapas em andamento e o saldo. |
| `mabel saldo --json` | As duas janelas: `uso`, `reset`, `ritmo` (só 7d), `idade_leitura_s`, e a pausa em vigor com o motivo, se houver. |
| `mabel inbox --json` | As pendências: item, tipo (`aprovar`, `responder`, `validar`), pergunta, sugestão, opções. |
| `mabel projeto consumo <id> --json` | Diagnóstico de consumo: custo e uso de janela por etapa, por modelo e por item. |

### Fluxo de eventos

`mabel eventos --json` fica aberto e escreve um evento por linha (NDJSON), de todos os
projetos, até o processo ser encerrado. O app mantém um só aberto e reabre se ele cair.

```json
{"versao":1,"tipo":"etapa","projeto":"loja-online","item":12,"etapa":"executar","estado":"iniciou"}
{"versao":1,"tipo":"ferramenta","projeto":"loja-online","item":12,"nome":"Edit"}
{"versao":1,"tipo":"gate","projeto":"loja-online","item":12,"gate":"testes","resultado":"verde"}
{"versao":1,"tipo":"inbox","projeto":"app-financas","item":7,"pendencias":2}
{"versao":1,"tipo":"saldo","janela":"5h","uso":0.22,"reset":"2026-10-23T16:40:00-03:00"}
{"versao":1,"tipo":"fila","projeto":"loja-online","estado":"pausada_por_saldo"}
```

Tipos: `etapa` (iniciou, terminou, falhou), `ferramenta` (nome da ferramenta chamada pelo
agente), `gate` (verde, vermelho), `revisao` (aprovada, reprovada), `inbox` (número de
pendências do projeto), `saldo` (leitura nova), `fila` (mudança de estado da fila),
`item` (transição de estado). Campo desconhecido é ignorado; tipo desconhecido também.

### Ações

O app age só rodando comandos da CLI no diretório do projeto e mostrando a saída:
`mabel run --fundo`, `mabel parar`, `mabel aprovar`, `mabel responder`,
`mabel projeto remover` (com a confirmação do próprio app no lugar da pergunta do TTY,
por `--sim`), `mabel init`.

## Telas

### Lista de projetos (janela principal)

- **Topo:** saldo das duas janelas (barra, percentual livre, reset), ritmo da janela de 7
  dias e idade da leitura. Pausa por saldo em vigor aparece aqui, com o motivo.
- **Cards**, um por projeto registrado: nome, gato do papel ativo no estado atual, selo
  da fila (Rodando, Aguarda você, Pausado por saldo, Ocioso, Reprovou), item e etapa em
  andamento, pendências da inbox.
- **Ações do card:** Abrir (vai para o projeto), Responder (quando há pendência; abre a
  inbox do projeto), Consumo (diagnóstico), Remover o Mabel (confirmação que diz o que é
  apagado e que o repositório não é alterado).
- **Card "Novo projeto":** abre o novo projeto assistido.
- Ordem: primeiro os que aguardam você, depois os que estão rodando, depois os outros por
  última atividade.

### Projeto aberto

- **Terminal** (área principal) com o modo Mabel no diretório do projeto. Quando a fila
  está no supervisor, o terminal abre já anexado (`mabel anexar`) e o usuário volta ao
  prompt com Ctrl+C.
- **Painel lateral** recolhível: inbox do projeto (perguntas com a sugestão em destaque,
  botões que rodam `aprovar`/`responder`), quadro resumido (contagem por estado) e o gato
  do papel ativo, maior.
- Sair do projeto não para a fila. O terminal pode ser fechado; a fila continua.

### Diagnóstico de consumo

Custo e uso de janela por etapa e por modelo, os itens mais caros e as runs que mais
consumiram, a partir de `mabel projeto consumo --json`. Só leitura.

### Novo projeto assistido

Conversa num terminal (`mabel nascer`, comando a criar no `mabel`) que sai com uma
proposta: stack, `CLAUDE.md`, regras críticas e backlog inicial. O usuário revisa e o
`mabel init` grava. O app só abre o terminal no diretório escolhido (ou cria o diretório
e roda `git init`, com confirmação). Enquanto o `mabel nascer` não existir, o card roda
`mabel init`.

### Barra de menus e Dock

- **Barra de menus:** gato pequeno no estado mais urgente entre todos os projetos
  (pergunta > reprovou > rodando > ocioso) e o total de pendências. O menu lista os
  projetos com o selo da fila e abre cada um.
- **Dock:** badge com o total de pendências da inbox.
- **Notificação** do macOS quando chega pendência nova na inbox e quando uma fila pausa
  por saldo. Clicar abre o projeto na inbox.

## Mascotes

Um gato por papel. O papel ativo de um projeto vem da etapa em andamento.

| Gato | Papel | Quando aparece |
|---|---|---|
| Siamês | Planejador | Etapa `planejar` (e `refinar`) |
| Laranja | Executor | Etapa `executar` |
| Preto | Revisor | Etapa `revisar` |
| Frajola | Inbox | Projeto com pendência da inbox |
| Mabel (tricolor) | O harness | Fila parada, verificação, entrega, tela de início |

Estados, derivados dos eventos (o mais recente vence, e cada estado volta ao de base da
etapa depois de alguns segundos):

| Estado | Evento | Animação |
|---|---|---|
| `dormindo` | fila parada ou ocioso | Respira devagar, "z" subindo |
| `lendo` | `ferramenta` `Read`, `Grep`, `Glob`, `WebFetch` | Livro aberto, olhos indo e voltando |
| `digitando` | `ferramenta` `Edit`, `Write`, `Bash` | Patas no teclado |
| `pensando` | etapa iniciou, sem ferramenta ainda | Olha para cima, rabo lento |
| `perguntando` | `inbox` com pendência | Olha para a câmera, rabo rápido |
| `comemorando` | `gate` verde, `revisao` aprovada | Pulinho |
| `desconfiado` | `gate` vermelho, `revisao` reprovada | Orelhas para trás, olhos semicerrados |
| `cansado` | `fila` `pausada_por_saldo` | Deitado, bateria vazia ao lado |

Com várias pendências e etapa rodando ao mesmo tempo, o card mostra o frajola
(`perguntando`): o que precisa do usuário vem antes.

Animação:

- Um arquivo Rive por gato (`siames.riv`, `laranja.riv`…), todos com a mesma máquina de
  estados `Gato` e a mesma entrada de texto `estado` (os nomes da tabela acima). O app só
  muda a entrada; as transições entre estados ficam no arquivo.
- O mesmo arquivo serve para os tamanhos do card (~96 pt), do painel (~160 pt) e da
  barra de menus (18 pt). Na barra de menus, que é monocromática, vale um ícone de
  template simplificado por estado.
- Até os arquivos Rive existirem, o app usa um gato provisório desenhado em SwiftUI
  (formas simples e animação por `TimelineView`), com os mesmos estados. O provisório é
  só para não travar o resto: não é o desenho final.
- "Reduzir movimento" do macOS ligado: estados sem loop, só a pose.

## Fora desta spec

Controle remoto no iOS, edição do backlog pela interface, vários terminais por projeto,
temas, sons, App Store.

## Incrementos

Cada um termina com os testes verdes, os critérios atendidos e um commit.

1. **Esqueleto e lista.** Projeto Xcode (ou Swift Package com executável), cliente da CLI
   (`MabelClient`: roda o binário, decodifica `--json`, trata versão), lista de projetos
   e saldo no topo contra o `mabel-fake`.
2. **Terminal.** Projeto aberto com SwiftTerm rodando `mabel` no diretório do projeto;
   anexar quando a fila está no supervisor.
3. **Eventos e estados.** `mabel eventos` aberto, estado de cada projeto e do gato
   provisório derivado dos eventos, barra de menus, badge do Dock, notificações.
4. **Inbox nativa e consumo.** Painel lateral com a inbox e a tela de diagnóstico.
5. **Gatos de verdade.** Arquivos Rive no lugar do provisório.
6. **Novo projeto assistido**, quando o `mabel nascer` existir.

## Testes

- **`mabel-fake`:** executável do próprio `mabel-app` (script ou alvo Swift) que responde
  aos comandos `--json` a partir de fixtures e reproduz um arquivo NDJSON em
  `mabel eventos`. O app aceita o caminho do binário por variável
  (`MABEL_BIN`), e os testes apontam para o fake.
- **Unitários** (Swift Testing): decodificação de cada `--json` e de cada evento, recusa
  de versão desconhecida, derivação do estado do card e do gato a partir de uma sequência
  de eventos, ordem da lista, estado mais urgente da barra de menus.
- **Interface:** XCUITest do fluxo lista → abrir projeto → responder pendência contra o
  fake.

## Critérios de aceite

1. Com o supervisor rodando a fila de dois projetos, fechar o app e reabrir mostra os
   dois rodando, no item e na etapa certos.
2. O saldo do topo é o mesmo do rodapé do modo Mabel dentro do terminal.
3. Uma pendência nova na inbox muda o card para "Aguarda você" e o gato para o frajola
   `perguntando`, soma no badge do Dock e gera notificação, sem o usuário abrir o
   projeto.
4. Responder pelo painel lateral roda `mabel responder` e a pendência some do card.
5. Remover o Mabel de um projeto pede confirmação, roda `mabel projeto remover` e tira o
   card; o repositório do projeto não muda.
6. Um evento `ferramenta` `Edit` numa etapa `executar` deixa o gato laranja
   `digitando`; um `gate` vermelho o deixa `desconfiado`.
7. Com `mabel` numa versão de `--json` desconhecida, o app mostra "Atualize o Mabel" e
   não quebra.
8. Com "Reduzir movimento" ligado, nenhum gato fica em loop.
9. Sem o app, a CLI faz tudo o que fazia antes.
