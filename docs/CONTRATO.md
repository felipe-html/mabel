# Contrato do Mabel — rascunho v0

O Mabel executa o backlog de um projeto com agentes Claude Code, de forma auditável,
com intervenção humana apenas em pontos críticos de regra de negócio.

Este documento separa o que o Mabel **garante** do que ele apenas **pede**. Garantia é
imposta por código (runner, hook, gate, banco); se depende de o modelo obedecer, é pedido.

## Escopo da v0

- Vários projetos-alvo em paralelo, cada um com a sua fila.
- Máquina local.
- Fila sequencial dentro de cada projeto: um item por vez, uma etapa por vez.
- A fila de um projeto roda em segundo plano: não depende do terminal ou da interface
  que a iniciou, e pode ser acompanhada e deixada a qualquer momento.

## Vocabulário

| Termo | Significado |
|---|---|
| Projeto-alvo | Repositório onde o Mabel atua. |
| Item | Unidade do backlog do projeto-alvo. |
| Spec | Funcionalidade com história, regras e exemplos, em `.mabel/specs/<slug>.md`. Estado (`rascunho`, `aceita`, `entregue`) no banco. |
| Tarefa | Item do quadro: de uma spec (`Spec:` e `Regras:`) ou avulso. |
| Unidade de entrega | Spec ou avulso. |
| Base | A branch configurada em `baseBranch`. |
| Etapa | Fase do item: planejamento, execução, verificação, revisão. |
| Run | Uma execução de `claude -p`. Toda etapa com agente é uma run. |
| Gate | Checagem mecânica que decide se o item avança. |
| Evidência | Artefato que comprova um gate (saída de teste, diff, parecer do revisor). |
| Regra crítica | Regra de negócio declarada pelo projeto-alvo como exigindo decisão humana. |
| Inbox | Fila de decisões pendentes do humano. |

## Ciclo de vida do item

```
backlog → ready → planning → planned → executing → verifying → reviewing → awaiting_merge → done
                                            ↑            │            │
                                            └────────────┴────────────┘  (falha de gate ou revisão)

Desvios a partir de qualquer etapa: needs_human · blocked · failed
```

Com a branch de integração, `awaiting_merge` significa "concluído na branch da unidade,
aguardando entrega e merge do humano na base". Dele o item vai a `done` (merge na base) ou,
quando o humano o rejeita, a `planning` ou `cancelled`.

## Garantias

| # | Garantia | Mecanismo |
|---|---|---|
| G1 | **Toda run é auditada.** Item, etapa, modelo, início, fim, custo, tokens, chamadas de ferramenta e transcript bruto copiado. Se o registro não puder ser gravado, a run não inicia. | Runner lendo o stream-json, hooks, SQLite, cópia do transcript. |
| G2 | **Nenhum item entra em execução sem critério de início.** Critérios de aceite verificáveis, escopo de arquivos declarado e, se tocar regra crítica, aprovação humana registrada. | Gate entre `planning` e `planned`. |
| G3 | **"Done" é calculado pelo Mabel, nunca declarado pelo agente.** Gates mecânicos verdes, cada critério de aceite do item ligado a pelo menos um teste (ou a uma rota de validação humana declarada), revisão aprovada. A exigência vale para o que o item muda, não para a cobertura do projeto inteiro. O teste de um critério de comportamento novo falha no código base e passa no item; o de comportamento mantido passa nos dois. O parecer da revisão é calculado a partir dos critérios avaliados e dos problemas apontados; o revisor não declara aprovação. | Gate de verificação e prova executados pelo runner, fora do agente. |
| G4 | **O agente não sai do escopo.** Escrita fora dos caminhos declarados e comandos da lista de bloqueio são barrados. O agente nunca faz merge nem push na base. | Hook `PreToolUse` de escopo nas ferramentas de arquivo, `--restricted` (ferramentas de arquivo confinadas ao worktree), sandbox do Claude Code no terminal (escrita no worktree, `.git` do projeto fechado, rede só para os domínios da stack e do projeto), `--disallowedTools` e gate de escopo depois da execução (arquivos alterados pelo item conferidos contra o escopo do plano, inclusive a escrita pelo terminal). Sem sandbox, a fila não roda, salvo desligamento explícito no projeto, registrado em cada run. |
| G5 | **Cada item trabalha isolado.** | Worktree e branch próprias por tarefa, criadas da branch da unidade: a da spec (`mabel/spec/<slug>`) ou a do avulso (`mabel/avulso/<n>-<slug>`), que nascem da base e ficam até a entrega. Sem integração, da base. |
| G6 | **Nenhuma etapa inicia sem saldo.** Ver "Política de saldo". Cada run tem teto de custo e de turnos. | `rate_limit_event` do stream-json, `--max-budget-usd`, `--max-turns`. |
| G7 | **Ambiguidade em regra crítica para o item.** Suposição declarada sobre regra crítica leva o item a `needs_human`. | Saída estruturada (`--json-schema`) com campo `suposicoes`, validada pelo runner. |
| G8 | **Contexto hermético.** O agente recebe apenas as regras do Mabel (versionadas), a configuração do projeto-alvo e os artefatos da etapa anterior. Nada da configuração pessoal do usuário. | `--restricted`, `--strict-mcp-config`, `--disable-slash-commands`, `--tools` por etapa e `--settings` por run; contexto do projeto (`CLAUDE.md`, `AGENTS.md`, regras críticas) injetado pelo Mabel, com orçamento; o runner confere o `init` de cada run e interrompe a que trouxer memória, MCP, skills ou ferramentas fora das pedidas. |
| G9 | **Estado sobrevive à sessão.** Interromper o Mabel a qualquer momento e reiniciá-lo retoma do último estado gravado. | Estado no banco e em arquivos; sessão nova por etapa. |
| G10 | **A unidade só recebe tarefa com "done" calculado.** O Mabel faz o merge da tarefa na branch da unidade só depois do G3 e da revisão. A integração é derivada: refeita pelo Mabel a partir da base a cada `run`, com o merge de cada unidade aberta, só para teste; nunca é origem nem entrega, e conflito ou verificação vermelha nela é aviso. A base só recebe o merge feito pelo humano, o commit do que o humano escreveu no `.mabel/` e o do que ele aceitou na revisão do `mabel nascer`. | O runner cria os commits de merge (na unidade e na integração, com `rerere`); o agente continua sem git de escrita (G4). No início do `run`, com a raiz na base, o Mabel commita nela o que está pendente no `.mabel/` (só esse diretório; o resto do índice fica como está), para os worktrees dos itens nascerem com as tarefas e as specs. No aceite do `mabel nascer`, o Mabel commita na branch atual só o `.mabel/` e o `CLAUDE.md` que acabou de criar (o resto do índice fica como está). A pedido do humano (`mabel entregar <unidade>`), o Mabel prova a entrega (base + snapshot da unidade num worktree temporário, com a verificação do projeto; conflito ou vermelho recusam) e publica o snapshot da branch da unidade (`mabel/entrega/<unidade>`) com um commit dele só com o documento de entrega (`.mabel/entregas/`) e as alterações da unidade no `.mabel/regras.md`, na branch de entrega e nunca na base, e abre o PR; não faz merge nem push na base. A integração nunca é entregue. Os commits de merge e de rejeição do Mabel levam os trailers `Mabel-Item` e `Mabel-Unidade`; o da entrega, `Mabel-Entrega`. |

## Política de saldo

A política existe para evitar iniciar etapas que seriam interrompidas por falta de saldo.
Ela é checada apenas antes de cada etapa; uma etapa em andamento pode ultrapassar os
limites.

O saldo é da conta, não do projeto: as filas de todos os projetos consomem as mesmas
janelas. A política é uma só, avaliada contra a mesma leitura antes da etapa de qualquer
projeto, e uma pausa vale para todas as filas.

O Mabel mede quanto cada etapa (planejar, executar, revisar) costuma consumir de cada
janela, pela diferença entre a primeira e a última leitura das runs auditadas. Com pelo
menos 3 amostras, a política olha o saldo **depois** da etapa contra um piso de 10%. Sem
amostras suficientes, vale o limiar de 30% sobre o saldo atual.

O ritmo da janela de 7 dias é a fração dela já decorrida. O uso está **acima do ritmo**
quando, somado ao consumo estimado da etapa, passa do ritmo em mais de 10 pontos.

| Situação | Ação |
|---|---|
| Saldo da janela de 7 dias abaixo do piso (ou de 30%, sem estimativa) | Alerta ao humano. A fila pausa até a resposta. |
| Uso da janela de 7 dias acima do ritmo | A fila pausa e pergunta ao humano se continua; a autorização vale até o reset da janela de 5 horas em curso. Sem autorização, aguarda o ritmo alcançar o uso e retoma sozinha. |
| Saldo da janela de 5 horas abaixo do piso (ou de 30%, sem estimativa) | A fila pausa e pergunta ao humano se continua. Sem autorização, aguarda o reset da janela e retoma sozinha. |
| Saldo esgotado durante uma etapa | A run é interrompida. A etapa é retomada pela mesma sessão (`--resume`) quando houver saldo. |
| Leitura de saldo ausente, vencida ou com mais de 30 minutos | Antes da etapa, o Mabel faz uma chamada mínima para obter a leitura. Sem leitura, a fila pausa e registra o motivo. |

As situações são avaliadas nessa ordem. A leitura vem do `rate_limit_event` da run mais
recente, de qualquer projeto. A interface do Mabel (modo Mabel e `mabel run` num terminal) mantém um rodapé
fixo com as duas janelas: saldo, horário de reset, ritmo da janela de 7 dias e idade da
leitura. O mesmo saldo aparece dentro de um projeto e fora dele.

## Backlog e quadro

| Arquivo | Conteúdo | Quem escreve | Versionado |
|---|---|---|---|
| `.mabel/backlog.md` | Itens: título, descrição, critérios de aceite. | Humano (e `mabel add`) | Sim |
| `.mabel/specs/<slug>.md` | Spec: história, regras com exemplos, decisões, fora do escopo, regras críticas e alterações nas regras vigentes. Tarefa com `Spec:` só fica `ready` com a spec aceita, válida e com as regras citadas; o trecho citado entra no hash da tarefa. Respostas do humano a uma tarefa de spec entram nas decisões dela; no avulso, nas `Decisões:` do item. | Humano (e o Mabel, nas decisões) | Sim |
| `.mabel/regras.md` | Regras de negócio vigentes, por assunto (`## <assunto>`, `- regra`). Lido pelo especificador, com orçamento. Muda só pela entrega: as alterações da spec ou do avulso entram no commit da branch de entrega e chegam à base pelo merge do humano. | Humano (e o Mabel, na branch de entrega) | Sim |
| `.mabel/quadro.md` | Kanban gerado: colunas por etapa, custo, pendências. | Só o Mabel | Não |
| `.mabel/entregas/<data>-<unidade>.md` | Documento de entrega: resumo, olhe primeiro, decisões, suposições, critérios e prova, desvios e tarefas. | Só o Mabel, na branch de entrega | Sim (pelo merge da entrega) |
| `.mabel/run.md` | Relatório do último `run`: o que precisa do humano, o que está pronto para entregar, a integração e as tarefas do run. Reescrito ao fim de cada tarefa e no fim do `run`. | Só o Mabel | Não |
| Banco SQLite | Estado de execução e auditoria. | Só o Mabel | Não |

O backlog é a fonte da verdade do conteúdo dos itens. O banco é a fonte da verdade do
estado. O quadro é uma visão, regenerada a cada transição; editá-lo não tem efeito.

Dados do banco só são removidos por comando explícito do humano (`mabel projeto remover`),
com confirmação, e cada remoção fica registrada em `removals`. A remoção alcança só os
dados do Mabel; o repositório do projeto não é alterado.

## Retentativas e escalonamento de modelo

- Após 2 falhas de gate na mesma etapa, a próxima tentativa usa o modelo da camada acima.
  O escalonamento vale só para aquela tentativa; a tabela de roteamento não muda.
- Falha também com o modelo escalonado: o item vai para `needs_human` com o
  resumo das tentativas.
- Retentativa sem alteração nova, num item que já tem commits, volta à verificação com o
  código já commitado; a tentativa conta se ela reprovar de novo.
- Impedimento de ambiente declarado pelo executor (rede, sandbox, permissão) é conferido
  pela verificação do Mabel, fora do sandbox. Se ela passar, o item segue; se falhar, o
  item vai a `needs_human` na hora, com o trabalho commitado e sem gastar tentativas.
- A tabela de roteamento só é alterada com base em amostragem relevante da auditoria. O
  Mabel sugere a mudança; o humano decide.

## Regras críticas do projeto-alvo

O projeto-alvo declara em `.mabel/regras-criticas.md` o que exige decisão humana:

- **Caminhos**: arquivos cuja alteração sempre exige critérios aprovados pelo humano.
  Imposto pelo hook de escopo: sem a aprovação, a escrita neles é negada.
- **Conceitos**: regras de negócio descritas em linguagem natural. O planejador classifica
  se o item toca algum deles. Orientação, não garantia.

## Projeto sem testes

- `mabel init` detecta a ausência de infraestrutura de testes e cria como primeiro item
  do backlog o estabelecimento da base de testes (framework e comando de teste).
- Antes de alterar código sem testes, o executor escreve testes de caracterização do
  comportamento atual, que precisam passar antes da mudança.
- Critério sem verificação automatizável (visual, infraestrutura) declara uma rota de
  validação humana e gera um item na inbox.

## Pedidos

Orientação entregue por prompt, agentes e skills. Não é garantida; quando um pedido se
mostrar crítico, ele sobe para garantia.

- O planejador produz o menor plano que satisfaz os critérios de aceite.
- O executor segue as convenções do projeto-alvo.
- O revisor parte da hipótese de que o código não atende aos critérios.
- Commits pequenos, com mensagem descritiva.
- Relatórios e perguntas da inbox em português claro, decidíveis sem abrir o código.
- Pergunta do agente que não toca regra crítica e traz sugestão é respondida pela própria
  sugestão e registrada como suposição, salvo se o projeto configurar
  `autonomia: "perguntar"`.

## Decisões do humano

- Aprovar critérios de aceite de itens que tocam regra crítica.
- Responder a inbox.
- Rejeitar um item integrado (`mabel rejeitar`).
- Aceitar a spec (`mabel especificar`).
- Pedir a entrega (`mabel entregar`) e fazer o merge na base.
- Alterar este contrato.

## Fora da v0

Itens em paralelo dentro de um projeto, integração com herdr, servidor MCP da frota,
dashboard, merge automático na base.

## Perguntas em aberto

Nenhuma no momento.
