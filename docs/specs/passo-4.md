# Especificação — Passo 4: etapas, gates e `mabel run`

Pré-requisito: passo 3 concluído. Leia `docs/CONTRATO.md` (G2, G3, G5, G6, G9, política
de saldo, retentativas) antes desta especificação.

Entrega: `mabel run` consome a fila do projeto em sequência. Cada item passa por planejar →
executar → verificar → revisar num worktree próprio e termina em `awaiting_merge` (com
evidências) ou em `needs_human` (com uma pergunta). **Ao fim deste passo, o Mabel está
pronto para o primeiro teste com uma aplicação real.**

Incrementos, cada um com `npm run check` verde, critérios atendidos, `docs/PLANO.md`
atualizado e commit:

- 4.1 Runner para etapas e worktree por item
- 4.2 Etapas com agente (planejar, executar, revisar) e saída estruturada
- 4.3 Gates, retentativas e escalonamento
- 4.4 `mabel run`, política de saldo e comandos de decisão

## Fatos observados

Claude Code 2.1.296:

- `--json-schema '<schema>'` faz o agente terminar chamando uma ferramenta
  `StructuredOutput`; o objeto validado chega em `result.structured_output` (o mesmo
  conteúdo vem serializado em `result.result`). A chamada consome um turno.
- `--permission-mode dontAsk` nega tudo que não estiver em `--allowedTools`, sem perguntar.
  É o modo certo para runs sem humano.
- `--append-system-prompt <texto>` é gravado na sessão; um `--resume` reenvia o registro
  original mesmo que outro texto seja passado.

## Incremento 4.1 — Runner para etapas e worktree

### Extensões do runner

`RunRequest` ganha:

| Campo | Flag do `claude` |
|---|---|
| `itemId`, `stage` | — (gravados em `runs.item_id` e `runs.stage`) |
| `permissionMode` | `--permission-mode` |
| `disallowedTools` | `--disallowedTools` |
| `appendSystemPrompt` | `--append-system-prompt` |
| `jsonSchema` | `--json-schema` (objeto serializado) |
| `resumeSessionId` | `--resume <id>` |

- `RunKind` ganha `'stage'`.
- `ResultTotals` ganha `structuredOutput?: unknown`, lido de `result.structured_output`.
- Coluna nova `runs.structured_output TEXT` (JSON).
- `runs.stage`: `'plan' | 'execute' | 'review'`.

### Worktree por item

- Caminho: `<dados>/worktrees/<project_id>/<number>-<slug>`, fora do projeto-alvo.
- Branch: `mabel/<number>-<slug>`, criada a partir de `config.baseBranch` no início do
  planejamento. `slug`: título em minúsculas, sem acentos, só `[a-z0-9-]`, até 40 caracteres.
- Depois de criado o worktree, roda `config.setup` nele (se houver). Falha do setup leva o
  item a `blocked` com a saída resumida.
- Worktree e branch já existentes (retomada) são reutilizados.
- `items.branch` e `items.worktree` são gravados.
- Quando o item chega a `done`, o worktree é removido (`git worktree remove`). A branch fica.

### Commits do Mabel

Os agentes não usam git para gravar. Ao fim de cada execução bem-sucedida, o Mabel faz o
commit no worktree:

```
mabel(#<n>): <título> — execução <tentativa>
```

com o autor configurado no repositório. Execução sem nenhuma alteração é falha de gate.

### Trava de execução

Um `mabel run` por projeto: arquivo `<dados>/locks/<project_id>.lock` com o pid. Lock de
processo morto é descartado.

### Critérios de aceite

- [x] Flags novas montadas por `claudeArgs`, cobertas por teste.
- [x] `structured_output` gravado na run.
- [x] Worktree e branch criados a partir da branch base, reutilizados na retomada e
      removidos em `done`; testado em repositório git temporário.
- [x] Segundo `mabel run` no mesmo projeto falha com mensagem clara enquanto o primeiro roda.

## Incremento 4.2 — Etapas com agente

### Prompts

Ficam no repositório do Mabel, em `prompts/`, e são **pedidos** (orientação), não garantias:

- `prompts/planejar.md`, `prompts/executar.md`, `prompts/revisar.md`: papel, limites e o
  que se espera da saída. Enviados por `--append-system-prompt`.
- O prompt da run (`-- <prompt>`) é montado pelo Mabel a partir do item e dos artefatos da
  etapa anterior, em Markdown, com seções fixas.

Conteúdo mínimo obrigatório dos prompts de sistema:

- **Planejar**: produzir o menor plano que satisfaça a intenção; usar os critérios do item
  quando existirem e propor critérios verificáveis quando faltarem; declarar o escopo de
  arquivos; listar toda suposição e marcar as que tocam regra crítica; perguntar em vez de
  supor quando a dúvida for de regra de negócio ou de stack.
- **Executar**: implementar só o plano; não sair do escopo declarado; escrever um teste
  por critério com `verificacao: "teste"`; antes de alterar código sem testes, escrever
  testes de caracterização do comportamento atual; não usar git; rodar os comandos de
  verificação antes de terminar.
- **Revisar**: partir da hipótese de que o código não atende aos critérios; verificar cada
  critério contra o diff e os testes; não editar nada.

### Etapas

| Etapa | Ferramentas (`--allowedTools`) | Sessão |
|---|---|---|
| Planejar | `Read`, `Glob`, `Grep` | Nova |
| Executar | `Read`, `Glob`, `Grep`, `Edit`, `Write`, `Bash` | Nova na 1ª tentativa e no escalonamento; `--resume` nas demais |
| Revisar | `Read`, `Glob`, `Grep`, `Bash(git diff:*)`, `Bash(git log:*)` | Nova |

- Todas com `--permission-mode dontAsk`, `cwd` no worktree, modelo de `config.models` e
  limites de `config.limits`.
- Executar usa `--disallowedTools` com: `Bash(git commit:*)`, `Bash(git push:*)`,
  `Bash(git merge:*)`, `Bash(git checkout:*)`, `Bash(git reset:*)`, `Bash(git rebase:*)`,
  `Bash(rm -rf:*)`, `Bash(sudo:*)`, `Bash(curl:*)`, `Bash(wget:*)`. É uma barreira fraca;
  a trava de escopo de verdade é o hook do passo 5.

### Saídas estruturadas

Esquemas JSON em `src/schemas/`. Resumo:

**Planejar**

```ts
{
  resumo: string;
  criterios: { id: string; texto: string; verificacao: 'teste' | 'humano' }[];
  escopo: string[];                 // globs relativos à raiz
  passos: string[];
  suposicoes: { texto: string; regraCritica: boolean }[];
  conceitosCriticos: string[];      // conceitos de regras-criticas.md que o item toca
  perguntas: string[];
}
```

**Executar**

```ts
{
  resumo: string;
  criterios: { id: string; testes: { arquivo: string; nome: string }[] }[];
  suposicoes: { texto: string; regraCritica: boolean }[];
  perguntas: string[];
}
```

**Revisar**

```ts
{
  aprovado: boolean;
  criterios: { id: string; atendido: boolean; evidencia: string }[];
  problemas: { gravidade: 'bloqueante' | 'menor'; descricao: string; arquivo?: string }[];
}
```

### Artefatos

Em `<dados>/items/<item_id>/`, fora do worktree para não entrarem nos commits:

- `plano.json` e `plano.md` (versão legível, usada nos prompts seguintes)
- `execucao-<tentativa>.json`
- `verificacao-<tentativa>.json` (do 4.3)
- `revisao-<tentativa>.json`

### Critérios de aceite

- [x] Cada etapa monta os argumentos certos (ferramentas, modo, modelo, limites, esquema, sessão).
- [x] Saída estruturada ausente ou fora do esquema é falha da etapa, não exceção.
- [x] Artefatos gravados por etapa e tentativa.
- [x] Testes com um `claude` falso dirigido por cenário: arquivo JSON com a resposta de
      cada chamada (saída estruturada e, para executar, arquivos a criar ou alterar no cwd).

## Incremento 4.3 — Gates, retentativas e escalonamento

### Gate de início (G2): `planning → executing`

Passa quando, nesta ordem:

1. Há saída estruturada válida.
2. `perguntas` está vazio. Senão → `needs_human` com as perguntas.
3. `criterios` não está vazio e todo critério tem `verificacao`.
4. `escopo` não está vazio.

Falha nas condições 1, 3 ou 4 é **plano incompleto**: o planejamento é refeito uma vez,
retomando a mesma sessão com o motivo da falha (o item continua em `planning`; a falha
fica em `gate_results`). Segunda falha → `needs_human` com o motivo. Plano incompleto não
conta como tentativa de execução.
5. **Regra crítica**: o item é crítico se algum glob do `escopo` casar com um caminho de
   `regras-criticas.md` (checagem mecânica), se `conceitosCriticos` não estiver vazio ou se
   alguma suposição tiver `regraCritica: true`. Item crítico → `needs_human` pedindo
   aprovação dos critérios, exceto se já aprovados (`mabel aprovar`).

Item não crítico segue com os critérios do plano sem aprovação humana.

### Perguntas e suposições na execução (G7)

Depois de cada execução, antes do commit e da verificação:

- `perguntas` não vazio, ou alguma suposição com `regraCritica: true` → `needs_human` com
  as perguntas e as suposições críticas. As alterações ficam no worktree, sem commit.
  Não conta como tentativa. Após `mabel responder`, o item volta a `executing` retomando
  a sessão daquela execução com a resposta.
- Suposições não críticas não param o item: ficam no artefato da execução e são listadas
  para você no `awaiting_merge`.

### Gate de verificação (G3): `verifying → reviewing`

Executado pelo Mabel no worktree, sem agente:

1. Cada comando de `config.verify`, em ordem, com saída gravada em
   `<dados>/items/<item_id>/verificacao-<tentativa>/<nome>.log`. Código diferente de 0 reprova.
2. Todo critério com `verificacao: "teste"` tem ao menos um teste declarado na saída da
   execução, cujo `arquivo` existe no worktree e contém o texto `nome`.
3. Critérios `verificacao: "humano"` não reprovam; são listados para você no
   `awaiting_merge`.

```sql
CREATE TABLE gate_results (
  id        INTEGER PRIMARY KEY,
  item_id   TEXT NOT NULL REFERENCES items(id),
  attempt   INTEGER NOT NULL,
  gate      TEXT NOT NULL,          -- 'start' | nome do comando | 'criteria_tests' | 'review'
  passed    INTEGER NOT NULL,
  detail    TEXT,                   -- motivo resumido
  log_path  TEXT,
  at        TEXT NOT NULL
);
```

### Revisão: `reviewing → awaiting_merge`

`aprovado: true` e nenhum problema `bloqueante`. Senão, conta como falha de gate e volta
para `executing` com os problemas no prompt.

### Retentativas e escalonamento

- Uma **tentativa** é uma passagem por executar → verificar → revisar. `items.attempts`
  conta as tentativas.
- Falha de verificação ou de revisão: nova tentativa, retomando a sessão da execução
  anterior com a saída da falha (últimas 200 linhas do log, ou os problemas da revisão).
- Na 3ª tentativa (depois de 2 falhas), a execução usa o modelo acima na escada
  `haiku → sonnet → opus`, numa sessão nova que recebe o resumo das tentativas anteriores.
  Só para aquela tentativa; `config.models` não muda. Se o modelo já for `opus`, repete `opus`.
- Falha na 3ª tentativa → `needs_human` com o resumo das três tentativas.
- `failed` fica para erro que não é de gate: run com `is_error` sem ser por saldo, setup que
  quebra no meio, limite de turnos ou de orçamento atingido.

### Critérios de aceite

- [x] Cada condição do G2 coberta por teste, incluindo casamento de glob com caminho crítico.
- [x] Plano incompleto: refeito uma vez pela mesma sessão; segunda falha → `needs_human`.
- [x] Execução com pergunta ou suposição crítica → `needs_human` sem commit; `responder`
      retoma a sessão da execução.
- [x] G3 reprova por comando com erro e por critério sem teste encontrado.
- [x] Sequência falha, falha, sucesso com escalonamento na 3ª: modelos e sessões corretos.
- [x] Três falhas levam a `needs_human` com resumo.
- [x] `responder` em `attempts_exhausted` abre novo ciclo com o modelo escalonado e sessão
      nova; com `--replanejar`, volta ao planejamento.
- [x] `responder` em cada `pending_kind` leva ao estado e à sessão da tabela.
- [x] Cada gate gera linha em `gate_results`.

## Incremento 4.4 — `mabel run` e decisões

### Laço

```
mabel run [--item <n>] [--uma]
```

1. Adquire a trava do projeto. `syncBacklog`.
2. Itens `awaiting_merge` cuja branch já está contida na branch base
   (`git merge-base --is-ancestor`) → `done`; remove o worktree.
3. Retomada: item em `planning`, `executing`, `verifying` ou `reviewing` (run interrompida
   ou Mabel morto) é retomado antes de qualquer item novo, a partir da etapa em que estava.
4. Próximo item: o primeiro `ready` pela ordem do arquivo (ou o `--item`).
5. **Antes de cada etapa com agente**, `checkBalance`:
   - `proceed` → segue.
   - `refresh` → probe e reavalia.
   - `ask` na janela de 5h → no TTY, pergunta se continua; recusa ou fora do TTY → espera
     o reset mostrando contagem regressiva e retoma sozinho.
   - `ask` na janela de 7 dias → alerta; no TTY, pergunta; recusa ou fora do TTY → encerra
     o `run` com o motivo.
6. Executa as etapas do item até um estado de parada (`awaiting_merge`, `needs_human`,
   `blocked`, `failed`). Com `--uma`, encerra aqui.
7. Volta ao passo 2 até não haver item `ready`.

Saída ao vivo: uma linha por transição e, dentro da etapa, as chamadas de ferramenta (como
o `exec`), indentadas. No fim, resumo: itens por estado final, custo total e tempo.

### Interrupção

- `ctrl+c`: interrompe a run atual (`SIGINT`), mantém o item na etapa, libera a trava e sai.
  O próximo `mabel run` retoma pela mesma sessão (`--resume`).
- Saldo esgotado durante a etapa (`result` com erro de limite de uso, ou
  `rate_limit_event` com `status` diferente de `allowed`): mesmo tratamento, e o `run`
  espera o reset antes de retomar. A detecção exata do erro de limite precisa ser
  confirmada com uma run real e registrada em fixture.

### Comandos de decisão (versão mínima da inbox do passo 5)

```
mabel item <n>                    detalhe: estado, plano, critérios, pergunta pendente, custo, runs
mabel aprovar <n>                 aprova os critérios de um item crítico → executing
mabel responder <n> "<resposta>" [--replanejar]
                                  orienta o item; o efeito depende do motivo da parada (abaixo)
mabel cancelar <n>                → cancelled
```

Toda decisão grava `item_transitions` com `reason` iniciando por `humano:`.

### Motivos de `needs_human` e efeito do `responder`

O item guarda o motivo da parada em `items.pending_kind`. O `responder` age conforme o motivo:

| Motivo (`pending_kind`) | Origem | `responder` | `--replanejar` |
|---|---|---|---|
| `question_plan` | Perguntas ou suposição crítica no planejamento | → `planning`, retoma a sessão do planejamento com a resposta | Igual |
| `plan_incomplete` | Plano incompleto duas vezes | → `planning`, retoma a sessão do planejamento com a resposta | Igual |
| `critical_approval` | Item crítico aguardando aprovação | A resposta é um ajuste dos critérios: → `planning`, retoma a sessão do planejamento. Para aprovar sem ajuste, use `aprovar` | Igual |
| `question_execute` | Perguntas ou suposição crítica na execução | → `executing`, retoma a sessão daquela execução com a resposta. Contador de tentativas inalterado | → `planning`, sessão nova com o plano anterior, a resposta e o resumo das tentativas |
| `attempts_exhausted` | Três tentativas reprovadas | → `executing`, **novo ciclo** de até 3 tentativas: contador do ciclo zerado, sessão nova com a resposta e o resumo das tentativas anteriores, todas as tentativas do ciclo com o modelo escalonado. Nova reprovação no ciclo → `needs_human` (`attempts_exhausted`) de novo | → `planning`, sessão nova com o plano anterior, a resposta e o resumo das tentativas; ao voltar à execução, novo ciclo com as regras normais |

- `items.attempts` passa a contar as tentativas **do ciclo atual**; o total do item é
  derivado das runs de execução.
- `mabel item <n>` mostra o motivo, a pergunta ou o resumo das tentativas e sugere o
  comando adequado (`responder`, `responder --replanejar`, `aprovar`, `cancelar`).

### Critérios de aceite

- [ ] Fila de três itens com `claude` falso: dois chegam a `awaiting_merge`, um para em
      `needs_human`; `responder` e novo `run` o levam a `awaiting_merge`.
- [ ] Merge manual da branch na base leva o item a `done` no próximo `run`.
- [ ] `ctrl+c` no meio de uma etapa e novo `run` retomam pela mesma sessão.
- [ ] Saldo de 5h abaixo de 30% fora do TTY espera o reset (testado com relógio injetado).
- [ ] Item com dependência só inicia depois que a dependência fica `done`.
- [ ] `run`, `item`, `aprovar`, `responder` e `cancelar` disponíveis no menu e no autocompletar.
- [ ] Teste manual: um item simples num projeto descartável, com o `claude` real, chega a
      `awaiting_merge` com custo registrado. Autorizado pelo usuário com modelos baratos:
      no `config.json` do projeto descartável, `models` = `haiku`/`sonnet`/`sonnet` e
      `maxBudgetUsd` = 1 em cada etapa. Reportar o custo total ao usuário.

## Fora deste passo

Hook de escopo, plugin e contexto hermético (passo 5); inbox em lote; itens em paralelo;
merge automático; 2.3 e 2.4.
