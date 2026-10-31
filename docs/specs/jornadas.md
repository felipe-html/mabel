# Especificação — Jornadas longas

Achado do uso real: a esteira para a cada pergunta, e as perguntas surgem espalhadas ao
longo da fila (as do item 5 só aparecem horas depois, quando ele é planejado). O humano
fica de plantão e os itens não avançam.

Três mudanças, que se completam:

1. **Autonomia**: pergunta que não toca regra crítica e tem sugestão não para o item. O
   Mabel adota a sugestão, registra como suposição e mostra tudo no fim.
2. **Planejar em lote**: o `rodar` planeja todos os itens `ready` antes de executar; as
   perguntas que sobram se juntam numa inbox só, no começo. Novo estado `planned`.
3. **Aviso**: notificação do sistema quando a esteira para ou espera o humano.

Resultado esperado: uma sessão curta de respostas no início e horas de execução sem
interrupção. Regra crítica continua parando a esteira (G2, G7).

Incrementos, cada um com `npm run check` verde, critérios atendidos, `docs/PLANO.md`
atualizado e commit:

- J.1 Autonomia nas perguntas
- J.2 Estado `planned` e planejamento em lote
- J.3 Aviso do sistema

## Decisões

| Tema | Decisão |
|---|---|
| Autonomia | Ligada por padrão: `autonomia: "sugestoes"` no `config.json`. O projeto pode escolher `"perguntar"` (comportamento atual). Config sem o campo vale `"sugestoes"`. |
| Planejar em lote | Padrão do `mabel rodar`. `--sem-lote` volta ao item a item. `--item <n>` e `--uma` implicam item a item. |
| Item planejado aguardando a vez | Novo estado `planned`, entre `planning` e `executing`. Muda o ciclo de vida do contrato (autorizado pelo usuário em 2026-10-12). |
| Aviso | Entra nesta spec. macOS via `osascript`; desligável com `MABEL_NOTIFICAR=0`. |

## Mudanças no contrato

Aplicar em `docs/CONTRATO.md` no J.2 (autorizado):

- Ciclo de vida: `backlog → ready → planning → planned → executing → verifying → reviewing → awaiting_merge → done`.
  O laço de falha de gate continua voltando para `executing`.
- Em "Pedidos", acrescentar: "Pergunta do agente que não toca regra crítica e traz sugestão
  é respondida pela própria sugestão e registrada como suposição, salvo se o projeto
  configurar `autonomia: \"perguntar\"`." É pedido, não garantia: a classificação
  `regraCritica` da pergunta vem do modelo. A rede de segurança é mecânica e já existe: um
  plano que toca caminho ou conceito crítico para em `critical_approval` (G2), e ali o
  humano vê as respostas autônomas como suposições.

G7 não muda: suposição marcada como `regraCritica` continua levando a `needs_human`.

## J.1 — Autonomia nas perguntas

### Esquema

`Question` ganha `regraCritica: boolean` em `planSchema` e `executeSchema`:

```ts
interface Question { texto: string; sugestao: string; regraCritica: boolean }
```

Pendência antiga sem o campo é lida com `regraCritica: false` (mesma normalização que
`readPending` já faz para perguntas em texto).

### Regra

Depois de uma etapa de planejamento ou execução com `perguntas` não vazias e
`config.autonomia === "sugestoes"`:

- Se **todas** as perguntas têm `regraCritica: false` e `sugestao` não vazia, o item **não
  para**. Cada pergunta vira uma suposição autônoma (abaixo) e o fluxo segue como se não
  houvesse perguntas: o planejamento vai ao gate de início (G2); a execução vai ao commit
  e à verificação.
- Se **alguma** pergunta é crítica ou não tem sugestão, o item para como hoje
  (`question_plan` / `question_execute`) com **todas** as perguntas. A inbox já mostra a
  sugestão das outras; enter aceita.
- Na execução, suposição crítica continua parando (G7), com ou sem perguntas.

Não há run extra: o prompt passa a exigir que o agente já trabalhe assumindo a sugestão.

### Prompts

`prompts/planejar.md` e `prompts/executar.md`, seção "Quando perguntar":

- Marque `regraCritica: true` na pergunta que toca uma regra crítica do projeto (caminho ou
  conceito da seção "Regras críticas do projeto").
- **Monte o plano (ou implemente) assumindo a sua sugestão.** Se o humano responder outra
  coisa, você refaz; se ninguém responder, a sugestão vale.
- Pergunta sem sugestão só quando não houver resposta razoável a propor; ela sempre para
  o item.

### Registro

Suposição autônoma: `{ texto: "P: <pergunta> → R: <sugestão> (autônomo)", regraCritica: false }`.

- Planejamento: acrescentada a `plano.suposicoes` antes de gravar `plano.json` /
  `plano.md`, e `perguntas` gravado vazio. O gate de início vê o plano já sem perguntas.
- Execução: acrescentada a `suposicoes` da `execucao-<n>.json`; `perguntas` gravado vazio.
- `recordGate(..., 'autonomy', true, '<P → R | P → R>')` com o `attempt` da etapa (0 no
  planejamento), para a auditoria contar respostas autônomas por item.
- `env.log`: `#3 Título: 2 perguntas respondidas pela sugestão (autônomo)`.

Como as suposições já entram nas notas do `awaiting_merge` (`mergeNotes`) e no
`plano.md`, o humano revê as decisões autônomas no merge sem nada novo.

### Resumo do `rodar`

Ao fim da fila, depois da linha `■ …`, listar as decisões autônomas desta execução:

```
Decididas pela sugestão (revise no merge):
  #2 Quais cômodos aparecem? → Sala, Cozinha, Quarto, Banheiro
  #4 Qual cor do botão? → Azul
```

Fonte: `gate_results` com `gate = 'autonomy'` e `at >=` início da execução.

### `mabel detalhar`

Seção "Decididas pela sugestão" com as linhas `autonomy` do item.

### Critérios de aceite

1. Planejamento com perguntas não críticas e com sugestão segue ao gate de início sem
   `needs_human`; o `plano.json` traz as suposições `(autônomo)` e `perguntas: []`.
2. Uma pergunta crítica, ou uma sem sugestão, para o item com todas as perguntas.
3. Execução com perguntas não críticas e com sugestão commita e segue para a verificação;
   suposição crítica continua parando (G7).
4. `autonomia: "perguntar"` reproduz o comportamento atual.
5. Config sem `autonomia` vale `"sugestoes"`; `mabel preparar` grava o campo.
6. Gate `autonomy` gravado; resumo do `rodar` e `mabel detalhar` listam as decisões.
7. Item crítico (`critical_approval`) mostra na inbox as suposições autônomas junto dos
   critérios.

## J.2 — Estado `planned` e planejamento em lote

### Estado

`ITEM_STATES` ganha `planned`. Transições:

| De | Para |
|---|---|
| `planning` | `planned`, `needs_human`, `failed`, `blocked` (sai `executing`) |
| `planned` | `executing`, `blocked`, `cancelled` |
| `needs_human` | `planning`, `planned`, `executing`, `cancelled` |

- Gate de início aprovado: `planning → planned` (motivo `plano aprovado pelo gate de início`).
- `aprovar` (e `a` na inbox): `needs_human → planned`.
- `responder` em `question_execute` / `attempts_exhausted` / `environment_block` continua
  indo para `executing`.
- `advanceItem` trata `planned` como o ponto de entrada da execução: `planned → executing`
  e segue. `prepareWorktree` já avança até a base um worktree sem commits próprios, então
  o item executa sobre a base atual mesmo planejado horas antes.
- Quadro: `planned` entra em "Na fila", antes de `ready` (`BOARD_SECTIONS`).
- `planned` **não** é `IN_PROGRESS` em `run.ts`: nada a retomar após ctrl+c.

### Ordem da fila em lote

A cada volta do laço de `startQueue`:

1. Item em andamento (`planning`, `executing`, `verifying`, `reviewing`): continua.
2. Item `ready`: **planeja** (para em `planned` ou `needs_human`).
3. Sem `ready`, fim da fase de planejamento: se há itens em `needs_human` e o terminal é
   interativo, oferece a inbox **uma vez** por execução
   (`N itens aguardam você. Abrir a inbox agora? [S/n]`). Respondidos, voltam a
   `planning` e caem no passo 1. Recusada, ou fora do TTY, a fila segue sem esperar.
4. Item `planned`, em ordem de backlog: **executa** até `awaiting_merge`, `needs_human`,
   `failed` ou `blocked`.
5. Nada disso: fim (`empty`); a oferta de inbox do fim do `rodar` continua valendo.

`advanceItem` ganha uma opção `{ until: 'planned' }` para o passo 2 parar ao chegar em
`planned`. Item que vira `ready` durante a execução (dependência concluída) é planejado
na próxima volta, antes do próximo `planned`.

Saída: separador ao trocar de fase, `── planejamento (3 itens) ──` e
`── execução (3 itens) ──`.

### Opções

`mabel rodar [--item <n>] [--uma] [--sem-lote]`

- `--sem-lote`: ordem atual (cada item até o fim antes do próximo), passando por
  `planned` sem parar.
- `--item <n>`: só o item, item a item.
- `--uma`: um item, item a item.

### Critérios de aceite

1. Fila de 3 itens `ready`: as 3 runs de planejamento acontecem antes da primeira de
   execução (ordem verificada no log do `claude` falso).
2. Item com pergunta no planejamento não segura os outros: os demais vão a `planned` e
   executam.
3. Oferta de inbox ao fim do planejamento, uma vez, só no TTY; item respondido é
   replanejado antes das execuções.
4. `--sem-lote`, `--item` e `--uma` mantêm o comportamento atual.
5. Tabela de transições atualizada e testada; `aprovar` leva a `planned`.
6. Quadro e `mabel conferir` mostram `planned`.
7. `docs/CONTRATO.md` com o ciclo de vida novo e o pedido de autonomia.

## J.3 — Aviso do sistema

`src/notify.ts`: `notify(title: string, message: string): void`.

- Só em `process.platform === 'darwin'` e com `MABEL_NOTIFICAR !== '0'`; nos testes,
  desligado pelo ambiente dos helpers.
- `spawn('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, message])`,
  desacoplado (`detached`, `stdio: 'ignore'`, `unref()`). Texto vai por `argv`, nunca
  interpolado no script. Falha é ignorada.

Quando avisar (título `Mabel · <projeto>`):

| Evento | Mensagem |
|---|---|
| Fim da fila (`empty`, `once`) | o resumo `■ …` sem custo e tempo, ex.: `fila vazia · awaiting_merge 3 · needs_human 1` |
| Pausa (`paused`) | o motivo da pausa |
| Pergunta no terminal esperando o humano (saldo, inbox, retomar) | `aguardando você: <pergunta>` |

### Critérios de aceite

1. `notify` monta os argumentos acima (teste com `spawn` injetável).
2. Desligado com `MABEL_NOTIFICAR=0` e fora do macOS.
3. Chamado nos três eventos (teste com `notify` injetado em `startQueue`/`rodar`).

## Fora desta spec

- Arquivo de referências que cresce com as respostas da inbox e política de deliberação
  por projeto (seção do Claude no `BACKLOG.md`): complementam a autonomia, entram depois de
  medir quantas perguntas sobram com o gate `autonomy`.
