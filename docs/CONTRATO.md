# Contrato do Mabel — rascunho v0

O Mabel executa o backlog de um projeto com agentes Claude Code, de forma auditável,
com intervenção humana apenas em pontos críticos de regra de negócio.

Este documento separa o que o Mabel **garante** do que ele apenas **pede**. Garantia é
imposta por código (runner, hook, gate, banco); se depende de o modelo obedecer, é pedido.

## Escopo da v0

- Um projeto-alvo por vez.
- Máquina local.
- Fila sequencial: um item por vez, uma etapa por vez.

## Vocabulário

| Termo | Significado |
|---|---|
| Projeto-alvo | Repositório onde o Mabel atua. |
| Item | Unidade do backlog do projeto-alvo. |
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

Com a branch de integração, `awaiting_merge` significa "na integração, aguardando o merge
do humano na branch principal". Dele o item vai a `done` (merge na principal) ou, quando o
humano o rejeita, a `planning` ou `cancelled`.

## Garantias

| # | Garantia | Mecanismo |
|---|---|---|
| G1 | **Toda run é auditada.** Item, etapa, modelo, início, fim, custo, tokens, chamadas de ferramenta e transcript bruto copiado. Se o registro não puder ser gravado, a run não inicia. | Runner lendo o stream-json, hooks, SQLite, cópia do transcript. |
| G2 | **Nenhum item entra em execução sem critério de início.** Critérios de aceite verificáveis, escopo de arquivos declarado e, se tocar regra crítica, aprovação humana registrada. | Gate entre `planning` e `planned`. |
| G3 | **"Done" é calculado pelo Mabel, nunca declarado pelo agente.** Gates mecânicos verdes, cada critério de aceite do item ligado a pelo menos um teste (ou a uma rota de validação humana declarada), revisão aprovada. A exigência vale para o que o item muda, não para a cobertura do projeto inteiro. O teste de um critério de comportamento novo falha no código base e passa no item; o de comportamento mantido passa nos dois. O parecer da revisão é calculado a partir dos critérios avaliados e dos problemas apontados; o revisor não declara aprovação. | Gate de verificação e prova executados pelo runner, fora do agente. |
| G4 | **O agente não sai do escopo.** Escrita fora dos caminhos declarados e comandos da lista de bloqueio são barrados. O agente nunca faz merge nem push na branch principal. | Hook `PreToolUse` e `--disallowedTools`. |
| G5 | **Cada item trabalha isolado.** | Worktree e branch próprias por item, criadas a partir da branch de integração (ou da base, sem integração). |
| G6 | **Nenhuma etapa inicia sem saldo.** Ver "Política de saldo". Cada run tem teto de custo e de turnos. | `rate_limit_event` do stream-json, `--max-budget-usd`, `--max-turns`. |
| G7 | **Ambiguidade em regra crítica para o item.** Suposição declarada sobre regra crítica leva o item a `needs_human`. | Saída estruturada (`--json-schema`) com campo `suposicoes`, validada pelo runner. |
| G8 | **Contexto hermético.** O agente recebe apenas as regras do Mabel (versionadas), a configuração do projeto-alvo e os artefatos da etapa anterior. Nada da configuração pessoal do usuário. | `--setting-sources project`, `--settings`, `--append-system-prompt-file`. |
| G9 | **Estado sobrevive à sessão.** Interromper o Mabel a qualquer momento e reiniciá-lo retoma do último estado gravado. | Estado no banco e em arquivos; sessão nova por etapa. |
| G10 | **A integração só recebe item com "done" calculado.** O Mabel faz o merge na branch de integração só depois do G3 e da revisão. A branch principal só recebe o merge feito pelo humano. | O runner cria o commit de merge; o agente continua sem git de escrita (G4). |

## Política de saldo

A política existe para evitar iniciar etapas que seriam interrompidas por falta de saldo.
Ela é checada apenas antes de cada etapa; uma etapa em andamento pode ultrapassar os
limites.

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
recente. A interface do Mabel (modo Mabel e `mabel run` num terminal) mantém um rodapé
fixo com as duas janelas: saldo, horário de reset, ritmo da janela de 7 dias e idade da
leitura.

## Backlog e quadro

| Arquivo | Conteúdo | Quem escreve | Versionado |
|---|---|---|---|
| `.mabel/backlog.md` | Itens: título, descrição, critérios de aceite. | Humano (e `mabel add`) | Sim |
| `.mabel/quadro.md` | Kanban gerado: colunas por etapa, custo, pendências. | Só o Mabel | Não |
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
- A tabela de roteamento só é alterada com base em amostragem relevante da auditoria. O
  Mabel sugere a mudança; o humano decide.

## Regras críticas do projeto-alvo

O projeto-alvo declara em `.mabel/regras-criticas.md` o que exige decisão humana:

- **Caminhos**: arquivos cuja alteração sempre exige critérios aprovados pelo humano.
  Imposto por hook.
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
- Fazer merge na branch principal.
- Alterar este contrato.

## Fora da v0

Múltiplos projetos, itens em paralelo, integração com herdr, servidor MCP da frota,
dashboard, merge automático na branch principal.

## Perguntas em aberto

Nenhuma no momento.
