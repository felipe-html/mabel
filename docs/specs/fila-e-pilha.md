# Especificação — Fila linear e entrega em pilha

Achado do uso real (`wego-keycloak-tema`, 2026-11-03): o avulso #1 ("Estabelecer base de
testes do tema") e a spec `tema-login` nasceram da `main`, cada um na sua branch de
unidade (S.5). A especificação não enxergava o #1 e não declarou dependência dele, então a
spec montou a própria base de testes. As duas criaram os mesmos 11 arquivos
(`package.json`, `playwright.config.ts`, `test/docker-compose.yml`…) e todo merge entre
elas deu conflito add/add. A `mabel/integracao` deixou a spec de fora com um aviso, a
cada run, por 52 commits. No fim, nenhuma unidade passava no `mabel entregar`.

O que falhou foi o modelo, não o merge:

1. **Unidades não se enxergam.** Cada unidade nasce da base. O que uma constrói (a
   fundação, um componente comum) não existe para as outras até a entrega.
2. **Conflito é aviso.** A integração é derivada e deixa de fora quem conflita. Ninguém é
   obrigado a resolver, e o desvio cresce em silêncio até a entrega.
3. **O conflito aparece longe de quem o causou.** Ele surge no fim (integração ou entrega),
   quando o agente que escreveu o código já terminou.

Como harness consolidados resolvem: integração contínua numa linha só. Merge queues como
GitHub Merge Queue, Bors e Zuul testam cada mudança contra a ponta do trunk e devolvem ao
autor a que conflita. A revisão por demanda vem de PRs empilhados (stacked diffs: Graphite,
ghstack, Phabricator): cada PR é uma fatia da linha, cuja base é a fatia anterior, e o
merge sai em ordem.

Esta spec troca o modelo do S.5 por esse:

- **Fila**: a `mabel/integracao` vira o trunk do Mabel. Toda tarefa nasce da ponta dela e
  entra nela por merge, uma de cada vez. Ela só anda para frente; nunca é refeita.
- **Conflito bloqueia e volta a quem o causou**: a tarefa que não entra limpa na ponta
  volta ao executor com os arquivos marcados.
- **Entrega em pilha**: cada unidade continua sendo a unidade de revisão. `mabel entregar
  <unidade>` entrega a fila até a última tarefa da unidade, como uma pilha de PRs (um por
  unidade ainda não entregue, em ordem), com o merge feito pelo humano.

Revê S1, S4 e o modelo de branches de `docs/specs/specs-e-entrega.md` (S.5) e a prova da
entrega do S.6. O formato das specs, o relatório de run, o documento de entrega e o motor
de especificação não mudam.

## Decisões

Decididas pelo usuário em 2026-11-03, com as sugestões das perguntas no fim. As mudanças
no contrato (seção "Contrato") estão autorizadas e entram no `CONTRATO.md` com o
incremento que as introduz.

| # | Tema | Decisão |
|---|---|---|
| F1 | Origem da tarefa | A ponta da `mabel/integracao`, com integração ligada. Sem integração (`integracao: null`), a base, como hoje. |
| F2 | Integração | Branch permanente, só anda para frente: recebe o merge de cada tarefa com "done" calculado e o merge da base. Nunca é refeita do zero. Com a fila sequencial do contrato (um item por vez), o merge da tarefa na ponta é sempre o próximo. |
| F3 | Conflito da tarefa | Antes da verificação, o Mabel faz o merge da ponta da integração no worktree (o `mergeOrigin` de hoje, com a integração como origem). Conflito volta ao executor na mesma tentativa, com os arquivos marcados e o merge em andamento; ele resolve e a verificação roda sobre o resultado. Conta como tentativa. Só vai à inbox (`integration_conflict`) quando as tentativas se esgotam. |
| F4 | Base anda | Na abertura do `rodar`, merge da base na integração (worktree temporário, `rerere`). Conflito pausa a fila com a pendência `base_conflict` (arquivos, comando para resolver). Sem merge limpo da base, nada novo entra. |
| F5 | Agendamento por unidade | Entre as tarefas prontas, a fila prefere a da unidade que já começou na integração e ainda não terminou (uma unidade aberta por vez). Outra unidade só começa quando a atual termina, para ou fica bloqueada. Isso mantém contíguo, na fila, o trecho de cada unidade. |
| F6 | Dependência entre unidades | O especificador recebe as tarefas abertas do projeto (número, título, unidade, estado) e pode declarar `dependeDe: ["#1"]` além das posições. Na fila, a ordem já faz a dependência ser herdada; a declaração serve ao agendamento e ao relatório. O `bringDependencies` sai. |
| F7 | Corte | O trecho entregável de uma unidade é `base..ponta da unidade`, onde a ponta da unidade é o último merge de tarefa dela na integração (trailer `Mabel-Unidade`). Entregar uma unidade entrega tudo o que está antes dessa ponta. |
| F8 | Pilha | `mabel entregar <unidade>` monta uma entrega por unidade ainda não entregue, da mais antiga até a pedida, em ordem de ponta: `mabel/entrega/<unidade>`. A primeira tem a base como alvo do PR; cada uma das outras tem como alvo a branch de entrega anterior. |
| F9 | Tarefa de outra unidade no trecho | Quando o F5 não basta (dependência, bloqueio), o trecho de uma unidade pode conter tarefas de outra. Elas entram na entrega em que aparecem e ficam listadas no "Olhe primeiro" como `#7 (de tema-login) entra nesta entrega`. Não há reordenação de commits. |
| F10 | Rejeição | `mabel rejeitar <n>` reverte o merge da tarefa na integração (como no P.5, antes do S.5). Entregas abertas que contêm a tarefa são refeitas sobre a nova ponta (`--substituir` automático, só nas afetadas). Revert com conflito não muda nada e aponta as tarefas posteriores que o impedem, como hoje. |
| F11 | Modelo por unidade | Sai. As branches `mabel/spec/*` e `mabel/avulso/*` deixam de existir: a unidade é um trecho da fila, identificado pelos trailers. Uma opção só (`integracao`), sem um terceiro modo. |
| F12 | Migração | Primeiro `rodar` com este modelo: as unidades abertas entram na integração por merge, na ordem da primeira tarefa concluída de cada uma (a mesma do `openUnitModel`). Conflito pausa a fila com `base_conflict` sobre a unidade, para o humano resolver uma vez. As branches de unidade migradas são apagadas depois que a integração as contém. |

## Branches

```
main ── mabel/integracao ── #1 ── #2 ── #3 ── #9 ── #4 …     (só anda para frente)
                   ↑          └─ avulso-1 ┘└ tema-login ┘└ avulso-9
                   merge da main na abertura do rodar

entrega:  main ← mabel/entrega/avulso-1 ← mabel/entrega/tema-login ← mabel/entrega/avulso-9
```

| Branch | Nasce de | Recebe | Vive até |
|---|---|---|---|
| `mabel/integracao` | Base, uma vez | Merge de cada tarefa (G10) e da base | Sempre |
| `mabel/item/<n>-…` (tarefa) | Ponta da integração | Commits do executor | Merge na integração |
| `mabel/entrega/<unidade>` | Entrega anterior da pilha (ou base) + ponta da unidade | Commit do documento | Merge na base (apagada depois) |

## Fim de cada tarefa

1. G3, prova e revisão, como hoje.
2. Merge da ponta da integração no worktree (F3). Se ela andou durante a revisão (não
   deveria, com a fila sequencial), o mesmo vale: conflito volta ao executor.
3. `integrateItem` na integração: commit de merge com a árvore da tarefa e `update-ref`
   contra o valor antigo (já existe). Tarefa vai a `awaiting_merge`, worktree e branch da
   tarefa apagados.
4. Relatório de run reescrito.

A verificação do projeto na integração, que o S.5 fazia depois de cada tarefa, sai: a
árvore da ponta é a árvore que a tarefa verificou.

## Abertura do `rodar`

1. O que já existe: commit do `.mabel/` pendente na base, conferência das entregas.
2. Entregas que chegaram à base: tarefas a `done`, spec `entregue`, branch de entrega
   apagada. A entrega seguinte da pilha passa a ter a base como alvo (o GitHub retarget faz
   isso sozinho quando a branch de baixo é apagada; o Mabel confere com `gh pr edit --base`
   quando não).
3. Migração (F12), uma vez.
4. Merge da base na integração (F4).

## Entrega

```
mabel entregar <slug | #n> [--parcial] [--substituir] [--rascunho]
```

`--com` sai: a pilha já leva as unidades anteriores.

1. **Unidade e ponta**: a unidade precisa ter pelo menos uma tarefa em `awaiting_merge`.
   Tarefa da unidade fora desse estado e fora de `cancelled` → entrega parcial (R7, como
   hoje).
2. **Pilha**: unidades com ponta antes da ponta pedida e ainda não entregues, em ordem. A
   tela mostra a pilha antes de criar qualquer coisa:

   ```
   Entrega de tema-login · 3 PRs em pilha
     1. avulso-1      #1                 → main
     2. tema-login    #2 #3 #4 #5 #6 #7 #8 → mabel/entrega/avulso-1
     3. (pedida)
   ```

   No TTY, confirmação. Entregas já abertas e atuais na pilha são reaproveitadas; as
   desatualizadas só são refeitas com `--substituir`.
3. **Prova da pilha**: num worktree temporário, base + merge da ponta pedida e a
   verificação do projeto (S.6). Como a integração já contém a base (F4), o conflito só
   acontece se a base andou depois da abertura do `rodar`; nesse caso a recusa manda rodar
   de novo.
4. **Branches de entrega**, de baixo para cima. A de baixo é a ponta da unidade mais um
   commit do Mabel com o documento de entrega e as regras vigentes dela. Cada uma acima é o
   merge da ponta da sua unidade sobre a entrega de baixo (só os arquivos de `.mabel/` da
   de baixo diferem, e a ponta não os toca) mais o commit do seu documento, com as regras
   aplicadas sobre as da de baixo.
5. **PRs**: um por branch, com o alvo do F8. Corpo = documento da unidade, mais a linha
   `Depende de <PR de baixo>; faça o merge em ordem.` E3 (só merge commit) continua.
6. Gravação: uma linha em `deliveries` por unidade, com `stack_parent` (a entrega de
   baixo).

## Contrato

Mudanças a autorizar, aplicadas no incremento que as introduz:

- **Vocabulário**: "Fila: a branch de integração, onde toda tarefa entra em ordem." e
  "Pilha de entregas: um PR por unidade, cada um sobre o anterior."
- **Ciclo de vida**: `awaiting_merge` passa a "na fila (integração), aguardando entrega e
  merge do humano na base".
- **G5**: mecanismo "Worktree e branch próprias por tarefa, criadas da ponta da branch de
  integração (ou da base, sem integração)."
- **G10**: "A integração só recebe tarefa com 'done' calculado. Toda tarefa nasce da ponta
  dela e entra nela em ordem; tarefa que não entra limpa volta ao executor. A integração
  só anda para frente: recebe o merge das tarefas e o da base, e nunca é refeita." O
  restante (base só com merge humano, `.mabel/` na abertura, `mabel criar`, trailers) não
  muda. A entrega: "publica a pilha de entregas da unidade (`mabel/entrega/<unidade>`, uma
  por unidade não entregue até ela), cada uma com o commit do seu documento, e abre os
  PRs; não faz merge nem push na base."
- **Decisões do humano**: "Resolver conflito da base com a integração" (`base_conflict`).

## Incrementos

Cada um com `npm run check` verde, critérios atendidos, `docs/ESTEIRA.html` atualizado,
`docs/PLANO.md` com a versão nova e commit.

| # | Incremento | Contrato |
|---|---|---|
| F.1 | Fila: tarefa nasce da ponta e entra nela; conflito volta ao executor; merge da base na abertura com `base_conflict`; migração das unidades abertas. | G5, G10, ciclo de vida, decisões do humano |
| F.2 | Agendamento por unidade e especificador com as tarefas abertas (`dependeDe: ["#n"]`). | — |
| F.3 | Entrega em pilha: corte, branches de entrega encadeadas, PRs com alvo na entrega de baixo, retarget. | G10 (entrega) |
| F.4 | Rejeição na fila e refação das entregas abertas afetadas. | — |

F.1 é major: muda o dado gravado (branches de unidade somem) e o contrato. F.3 também
(`--com` sai, `deliveries` ganha campo). F.2 e F.4 são minor.

Fase 2, fora destes incrementos: agente de merge para o `base_conflict` (etapa própria, sem
git de escrita, o Mabel commita e a verificação confirma; humano só se ele falhar).
Registrado no `BACKLOG.md`.

## Critérios de aceite

**F.1**

1. Tarefa nova nasce da ponta da integração; a segunda tarefa de outra unidade enxerga os
   arquivos da primeira (o caso do keycloak, em repositório temporário).
2. A integração muda só para frente: nenhum `update-ref` dela sem o valor antigo como
   ancestral do novo.
3. Conflito entre a tarefa e a ponta volta ao executor com o merge em andamento e os
   arquivos no prompt; resolvido, a tarefa integra. Tentativas esgotadas → inbox.
4. Base com commit novo entra na integração na abertura; conflito pausa a fila com
   `base_conflict` e os arquivos; resolvido à mão, o próximo `rodar` segue.
5. Migração: duas unidades abertas sem conflito viram trechos da integração, na ordem;
   com conflito, `base_conflict` sobre a unidade; branches migradas apagadas.
6. `integracao: null` continua com uma branch por item, da base.

**F.2**

7. Com tarefas prontas de duas unidades, a da unidade já começada vem antes.
8. Unidade atual bloqueada (`needs_human`) libera a outra.
9. Especificador recebe as tarefas abertas; `dependeDe: ["#1"]` é validado (tarefa existe,
   não cancelada) e gravado.

**F.3**

10. Entregar a terceira unidade abre três PRs encadeados, com alvos corretos e um documento
    por unidade.
11. Entrega aberta e atual na pilha é reaproveitada; desatualizada só com `--substituir`.
12. Tarefa de outra unidade dentro do trecho aparece no "Olhe primeiro" da entrega em que
    entra.
13. Merge da entrega de baixo na base: o `rodar` marca as tarefas `done` e a entrega de
    cima passa a ter a base como alvo.
14. Regras vigentes de duas unidades da pilha que mexem no mesmo assunto ficam aplicadas
    em ordem, sem conflito no `.mabel/regras.md`.

**F.4**

15. Rejeitar uma tarefa reverte o merge dela na integração e a leva a replanejar.
16. Entregas abertas que contêm a tarefa são refeitas; as de baixo não mudam.

## Perguntas (respondidas em 2026-11-03: todas com a sugestão)

1. **F4 — conflito da base pausa a fila inteira?** Sugestão: sim. Com a fila linear, toda
   tarefa nova nasceria de uma ponta sem a base, e o conflito só cresceria. A alternativa
   (seguir sem a base) adia o problema para a entrega, que é o que aconteceu no keycloak.
2. **F5 — uma unidade aberta por vez?** Sugestão: sim. É o que deixa o trecho de cada
   unidade contíguo e a revisão por PR limpa. O custo é que uma spec longa atrasa um avulso
   urgente; para isso, `mabel rodar --item <n>` já fura a ordem.
3. **F9 — tarefa de outra unidade no trecho: listar ou reordenar?** Sugestão: listar.
   Reordenar commits (rebase da fila) reescreve o que já foi verificado e provado, e
   exigiria provar de novo.
4. **F11 — o modelo por unidade sai de vez?** Sugestão: sim. Manter os dois dobra os
   caminhos de branch, rejeição e entrega, e o modelo por unidade é o que falhou. Quem
   precisa de branches separadas usa `integracao: null`.
