# Especificação — Prova e branch de integração

Achado do uso real: cada item termina numa branch própria, criada a partir da base, e
fica em `awaiting_merge` até o humano fazer o merge. No fim de um dia, são 15 branches
avulsas, sem relação entre si, cada uma pedindo uma revisão de código. Itens que dependem
de outro esperam esse merge manual.

Referência: o relatório "Como o cepa se encaixa" (mentoria, 8/10/2026). O harness descrito
ali não revisa código: um revisor independente tenta quebrar cada mudança, e um hook
calcula o veredito. Pelos logs do autor, 1 em cada 5 cards foi devolvido pela prova depois
de "pronto" com build verde. Os números são de um projeto só, sem validação independente:
servem de motivação, não de referência.

Duas mudanças, nesta ordem, porque a segunda só é segura com a primeira:

1. **Prova**: o G3 passa a exigir que o teste de cada critério **proteja** a mudança, e
   não só que exista e passe. O veredito da revisão é calculado pelo Mabel, nunca
   declarado pelo revisor.
2. **Integração**: item provado entra sozinho numa branch de integração. Os próximos itens
   nascem dela. O humano revisa **uma** branch, com um relatório por item, e faz um merge na
   branch principal. Branch e worktree do item são apagados depois de integrados.

Resultado esperado: no fim do dia, uma branch e um relatório. A revisão humana se
concentra nos critérios, nas suposições e no que ficou sem prova, não no diff.

Incrementos, cada um com `npm run check` verde, critérios atendidos, `docs/PLANO.md`
atualizado e commit:

- P.1 Veredito calculado
- P.2 Prova: vermelho na base, verde no item
- P.3 Limpeza de worktrees e branches
- P.4 Branch de integração
- P.5 Relatório da integração e `mabel rejeitar`

A prova com agente (mutações) está especificada no fim, como **fase 2**: não entra nestes
incrementos.

Ordem no plano: depois do passo 5 (travas), porque a prova roda comandos no worktree e se
beneficia do sandbox.

## Decisões

Decididas pelo usuário em 2026-10-13.

| # | Tema | Decisão |
|---|---|---|
| D1 | Integração por padrão | Ligada: `integracao: "mabel/integracao"` no `config.json`. `null` volta ao comportamento atual (uma branch por item, merge manual). Config sem o campo vale ligada. |
| D2 | Dependências | Com a integração ligada, uma dependência integrada (em `awaiting_merge`) já libera o item dependente: a fila inteira anda numa noite. |
| D3 | Prova com agente | Por fases. Os incrementos P.1 a P.5 entregam só a prova mecânica, sem agente. A prova por mutação fica especificada nesta spec ("Fase 2") e registrada no `BACKLOG.md`, para mais assertividade depois. |
| D4 | Critério sem prova mecânica | Não bloqueia: é listado em destaque no relatório ("olhe primeiro"), como já acontece com os critérios `verificacao: "humano"`. |
| D5 | Rejeição | `mabel rejeitar <n> "<motivo>"` reverte o item na integração e o leva a replanejar com o motivo; `--cancelar` o cancela. |
| D6 | Merge na branch principal | Continua com o humano, por `git merge` ou PR. O Mabel não ganha comando para isso. |
| D7 | Contrato | Mudanças abaixo autorizadas. |
| D8 | Ordem | Depois do passo 5. |
| D9 | Teste único em Node | Vitest detectado pelo `package.json`; senão, node:test. Jest fica para quando um projeto real pedir. |
| D10 | Relatório | `.mabel/integracao.md`, não versionado, e `mabel integracao` (`/integracao`). |

## Mudanças no contrato

Autorizadas pelo usuário em 2026-10-13. Aplicar em `docs/CONTRATO.md` no incremento que
as introduz (G3 no P.1 e P.2; G5, G10 e ciclo de vida no P.4; decisões do humano no P.5):

- **G3**: acrescentar ao texto: "O teste de um critério de comportamento novo falha no
  código base e passa no item; o de comportamento mantido passa nos dois. O parecer da
  revisão é calculado a partir dos critérios avaliados e dos problemas apontados; o revisor
  não declara aprovação." Mecanismo: "Gate de verificação e prova executados pelo runner,
  fora do agente."
- **G5**: mecanismo passa a ser "Worktree e branch próprias por item, criadas a partir da
  branch de integração (ou da base, sem integração)."
- **Nova garantia G10 — A integração só recebe item com "done" calculado.** O Mabel faz o
  merge na branch de integração só depois do G3 e da revisão. A branch principal só recebe
  o merge feito pelo humano. Mecanismo: o runner cria o commit de merge; o agente continua
  sem git de escrita (G4).
- **Ciclo de vida**: `awaiting_merge` passa a significar "na integração, aguardando o merge
  do humano na branch principal" (com integração) e ganha as saídas `planning` e
  `cancelled` (rejeição).
- **Decisões do humano**: acrescentar "Rejeitar um item integrado".
- **Fora da v0**: "merge automático" vira "merge automático na branch principal".

## P.1 — Veredito calculado

### Esquema

`reviewSchema` perde o campo `aprovado`:

```ts
interface ReviewOutput {
  criterios: { id: string; atendido: boolean; evidencia: string }[];
  problemas: { gravidade: 'bloqueante' | 'menor'; descricao: string; arquivo?: string }[];
}
```

Parecer antigo com `aprovado` continua legível; o campo é ignorado.

### Regra

A revisão aprova quando, e só quando:

1. Todo critério do plano aparece em `criterios` (pelo `id`). Critério ausente reprova:
   `revisão não avaliou o critério C2`.
2. Todo critério avaliado tem `atendido: true`.
3. Nenhum problema é `bloqueante`.

Critério avaliado com `id` que não existe no plano é ignorado e registrado no `detail`.

### Prompt

`prompts/revisar.md`, seção "Saída": tirar a frase sobre `aprovado` e explicar que o Mabel
decide a partir dos critérios e dos problemas; avaliar **todos** os critérios do plano.

### Critérios de aceite

1. Parecer com todos os critérios atendidos e sem bloqueante aprova, com ou sem `aprovado`.
2. Critério do plano ausente no parecer reprova com o motivo.
3. `aprovado: true` com critério não atendido reprova (caso do relatório: "o revisor
   escreveu provado e o hook recusou").
4. Esquema validado com o `claude` real (Haiku), como no 4.2.

## P.2 — Prova: vermelho na base, verde no item

### A ideia

Um teste que passa sem a mudança não protege o critério. Para cada critério com
`verificacao: "teste"`, o Mabel roda os testes declarados duas vezes: no código base (com os
arquivos de teste do item) e no item. O resultado esperado depende do critério:

| Comportamento do critério | Na base | No item |
|---|---|---|
| `novo` | falha | passa |
| `mantido` (caracterização, refatoração) | passa | passa |

### Esquema do plano

`PlanCriterion` ganha `comportamento: 'novo' | 'mantido'`, obrigatório no `planSchema`.
Plano antigo sem o campo: o critério fica **sem prova** (D4), com o motivo
`plano sem comportamento declarado`.

`prompts/planejar.md`: `novo` quando o critério descreve algo que o código ainda não faz;
`mantido` quando descreve algo que já faz e precisa continuar fazendo.

### Configuração

Dois campos novos no `config.json`, com valores padrão por stack no catálogo
(`src/stacks.ts`) e gravados pelo `init`:

| Campo | Para quê | Node (node:test) | Node (Vitest) | Python | Go | Rust |
|---|---|---|---|---|---|---|
| `testeUnico` | Rodar um teste só. `{arquivo}`, `{pasta}` e `{nome}` são substituídos já com aspas de shell. | `node --test --test-name-pattern={nome} {arquivo}` | `npx vitest run {arquivo} -t {nome}` | `pytest {arquivo} -k {nome}` | `go test -run {nome} ./{pasta}` | `cargo test {nome}` |
| `arquivosDeTeste` | Globs dos arquivos que são só de teste (testes, fixtures, helpers). | `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, `test/**`, `tests/**` | igual | `tests/**`, `**/test_*.py`, `**/*_test.py`, `**/conftest.py` | `**/*_test.go`, `**/testdata/**` | `tests/**` |

`init` detecta Vitest pelo `package.json` para escolher o `testeUnico`. Config sem
`testeUnico`: a prova cai para o **modo por item** (abaixo).

Para Go, o `nome` declarado pela execução é o nome da função (`TestX`); o `prompts/executar.md`
passa a dizer isso por stack.

### Execução da prova

No worktree do item, sem agente, depois do gate `criteria_tests` e antes da revisão:

1. `base` = `git merge-base HEAD <integração ou base>`.
2. Conjunto **restaurável**: arquivos que o item mudou (`git diff --name-only base HEAD`)
   e que **não** casam com `arquivosDeTeste` nem estão entre os arquivos de teste declarados.
3. Rodar no item: para cada teste declarado, `testeUnico`. Resultado guardado.
4. Levar o worktree à base, só no conjunto restaurável: `git checkout <base> -- <arquivos
   que existiam na base>` e remoção dos que o item criou.
5. Rodar na base: o mesmo `testeUnico` para cada teste declarado.
6. **Restaurar sempre** (`finally`): `git checkout HEAD -- .` e `git clean -fd` no conjunto
   restaurável. Conferir `git status --porcelain` vazio; se não estiver, o item vai a
   `failed` com `worktree não restaurado após a prova` (nunca segue com código misturado).

Saídas gravadas em `<dados>/items/<item_id>/prova-<tentativa>/<criterio>-<base|item>.log`.

### Resultado por critério

| Situação | Resultado |
|---|---|
| Esperado da tabela acima, em todos os testes do critério | `provado` |
| `novo` e algum teste passa na base | `nao_provado`: "o teste `<nome>` já passava sem a mudança; ele não protege o critério" |
| `mantido` e algum teste falha na base | `nao_provado`: "o teste `<nome>` falha no código anterior; ele não descreve o comportamento mantido" |
| Algum teste falha no item | `nao_provado` (não deveria ocorrer depois do `verify`; indica teste instável ou nome errado) |
| Arquivo de teste declarado está no conjunto restaurável (teste dentro do código de produção, como `#[cfg(test)]` em Rust) | `sem_prova`: "o teste mora no código alterado" |
| Plano sem `comportamento` | `sem_prova` |

**Modo por item** (sem `testeUnico`): passos 3 e 5 rodam o comando `test` do `verify` uma
vez. Com algum critério `novo`, a base precisa falhar; senão, passar. O resultado vale para
todos os critérios, marcados `provado (por item)` ou `nao_provado`. É mais fraco e aparece
assim no relatório.

### Veredito

- Algum `nao_provado` → falha de gate, com as lacunas nomeadas no prompt da próxima
  tentativa (retentativas e escalonamento como hoje).
- Senão → revisão. Critérios `sem_prova` seguem para o relatório (D4).

`recordGate(..., 'proof', passou, '<C1 provado; C2 nao_provado: …; C3 sem_prova: …>', <pasta de logs>)`.
O resultado por critério também vai a `prova-<tentativa>.json`, lido pelo relatório.

### Prompt do executor

`prompts/executar.md`, seção "Testes": "O Mabel roda cada teste de critério `novo` no código
anterior à sua mudança: ele precisa falhar ali. Teste que passaria sem a sua implementação
devolve o item."

### Limites conhecidos

- Teste que falha na base por erro de carga (importa algo que o item criou) conta como
  vermelho. É o caso comum e correto para comportamento novo; um teste mal escrito pode
  passar por isso. A revisão continua olhando.
- Dependências novas (lockfile alterado) não são reinstaladas para a base.

### Critérios de aceite

1. Critério `novo` com teste que falha na base e passa no item: `provado`.
2. Critério `novo` com teste que já passava na base: `nao_provado`, nova tentativa com a lacuna.
3. Critério `mantido`: passa nos dois → `provado`; falha na base → `nao_provado`.
4. Teste declarado em arquivo restaurável → `sem_prova`; não bloqueia.
5. Worktree restaurado depois da prova, inclusive quando um comando lança erro; status
   sujo leva a `failed`.
6. Modo por item sem `testeUnico`.
7. Catálogo com `testeUnico` e `arquivosDeTeste` por stack; `init` grava os campos.
8. Testado em repositório git temporário com um projeto Node mínimo (node:test).

## P.3 — Limpeza de worktrees e branches

Vale com e sem integração.

- Sem integração: worktree removido ao chegar a `awaiting_merge` (a branch guarda tudo; um
  retrabalho recria o worktree pela branch, como na retomada). Branch apagada
  (`git branch -D`) ao passar a `done`, depois de confirmar que está contida na base.
- Com integração: worktree e branch apagados logo depois do merge na integração (P.4).
- `run`, ao abrir: remove worktrees órfãos em `<dados>/worktrees/<projeto>/` de itens em
  `awaiting_merge`, `done` ou `cancelled` (`git worktree prune` em seguida).

### Critérios de aceite

1. `awaiting_merge` sem worktree; retrabalho recria a partir da branch.
2. `done` apaga a branch; branch não contida na base não é apagada (aviso no log).
3. Órfãos removidos na abertura do `run`.

## P.4 — Branch de integração

### Configuração

`integracao: string | null` no `config.json` (D1). Com integração, a branch de origem dos
itens (`origem`) é a integração; sem ela, a base.

### Abertura do `run`

Antes da fila, com a trava do projeto:

1. Integração inexistente → criada a partir da base.
2. Integração em uso num worktree que não é do Mabel (`git worktree list --porcelain`)
   → pausa com o motivo: `a branch mabel/integracao está aberta em <caminho>; feche-a para o Mabel continuar`.
3. Base à frente da integração (o humano fez o merge, ou commitou na base):
   - integração contida na base → avança a integração até a base (`update-ref` com o valor
     antigo, para não sobrescrever nada);
   - divergiram → merge da base na integração num worktree temporário
     (`<dados>/worktrees/<projeto>/_integracao`); conflito → `merge --abort`, pausa com os
     arquivos em conflito.
4. Itens `awaiting_merge` cujo `integrated_commit` está contido na base → `done`.

### Item

- `prepareWorktree` cria a branch a partir de `origem`; `catchUp` avança até `origem`.
- **Antes da verificação** (`verifying`), se `origem` andou desde o início do item: o Mabel
  faz `git merge --no-edit <origem>` no worktree do item. Conflito → `merge --abort`, item a
  `needs_human` (`integration_conflict`) com os arquivos. Merge limpo → a verificação e a
  prova rodam já sobre o código atualizado: o que entra na integração é exatamente o que foi
  verificado.
- **Depois da revisão aprovada**, em vez de parar em `awaiting_merge` com a branch:
  1. Commit de merge sem worktree:
     `git commit-tree <tree do item> -p <integração> -p <item> -m "mabel: integra #<n> <título>"`.
     Como o item já contém a integração, a árvore do item é o resultado do merge.
  2. `git update-ref refs/heads/<integração> <novo> <antigo>`: falha se a integração mudou
     no meio (não deveria, com a trava), e o item vai a `failed` com o motivo.
  3. `items.integrated_commit` = o commit de merge.
  4. Remove worktree e branch do item (P.3).
  5. `awaiting_merge` com as notas de hoje (`mergeNotes`).

`responder` em `integration_conflict`: → `executing`, sessão nova, com a resposta e a lista
de arquivos; o Mabel faz o merge da integração no worktree e deixa os conflitos marcados
para o executor resolver. (O agente continua sem git; quem chama o merge é o Mabel.)

### Dependências (D2)

Com integração, a dependência é satisfeita por `done` ou por `awaiting_merge` com
`integrated_commit`. Sem integração, só por `done`, como hoje.

### Banco

`items.integrated_commit TEXT` (nulo até a integração). Transições novas:
`awaiting_merge → planning`, `awaiting_merge → cancelled` (rejeição, P.5).
`awaiting_merge → executing` fica só para o modo sem integração.

### Critérios de aceite

1. Três itens em sequência com o `claude` falso: cada um nasce da integração, o segundo vê
   o código do primeiro, e a integração termina com três commits de merge.
2. Item dependente de outro integrado inicia sem merge do humano.
3. Integração que andou durante o item: merge limpo antes da verificação; conflito leva a
   `integration_conflict`.
4. Merge da integração na base pelo humano: próximo `run` leva os itens a `done` e avança a
   integração.
5. Base e integração divergentes: merge limpo segue; conflito pausa com os arquivos.
6. Integração aberta no checkout do humano: pausa com o motivo, nada é escrito.
7. `integracao: null` reproduz o comportamento atual (mais a limpeza do P.3).

## P.5 — Relatório da integração e `mabel rejeitar`

### Relatório

`.mabel/integracao.md`, gerado a cada integração e na abertura do `run` (não versionado,
como o `quadro.md`; entra no `.gitignore` criado pelo `init`). `mabel integracao` mostra o
mesmo conteúdo no terminal. Em português, decidível sem abrir o código.

```
# Integração · mabel/integracao · 4 itens desde a main

Para levar à main: git merge --no-ff mabel/integracao

## Olhe primeiro
- #7 Exportar CSV: C3 sem prova (o teste mora no código alterado)
- #9 Desconto progressivo: tocou regra crítica (aprovada por você em 13/10 09:12)
- #8 Filtro por data: 2 decisões autônomas

## #6 Login com e-mail · provado · 1 tentativa · US$ 0,82
Critérios
  C1 novo     login aceita e-mail válido    auth.test.ts › aceita e-mail   provado
  C2 mantido  login por usuário continua    auth.test.ts › aceita usuário  provado
Validação humana: —
Suposições: —
Arquivos: 4 alterados, +120 −8
…
```

Ordem: "Olhe primeiro" (critérios `sem_prova`, prova `por item`, regra crítica, suposições
e decisões autônomas, validações humanas), depois os itens na ordem de integração, com
tentativas e devoluções (pela prova, pela verificação, pela revisão).

### `mabel rejeitar <n> "<motivo>" [--cancelar]`

Só para item `awaiting_merge` com `integrated_commit` que ainda não está na base.

1. Worktree temporário `_integracao`: `git revert --no-edit -m 1 <integrated_commit>`.
2. Conflito → `revert --abort`; nada muda; mensagem lista os itens integrados depois dele
   que tocam os mesmos arquivos (rejeite-os antes).
3. Sem conflito → `update-ref` da integração; item → `planning` (sessão nova, com o plano
   anterior e o motivo) ou → `cancelled` com `--cancelar`. `integrated_commit` limpo.
4. Itens integrados que dependem dele: aviso com os números (não são revertidos sozinhos).
5. Transição com `reason` `humano: rejeitado — <motivo>`.

Disponível no modo Mabel (`/rejeitar`) e no autocompletar.

### Critérios de aceite

1. Relatório com as seções acima, regenerado a cada integração.
2. `rejeitar` reverte só o item, o leva a `planning` com o motivo; `--cancelar` cancela.
3. Revert com conflito não altera a integração e aponta os itens que o impedem.
4. Dependentes integrados geram aviso.

## Fase 2 — Prova com agente (especificada, não implementada)

A prova mecânica mostra que o teste não passaria **sem** a mudança. Ela não mostra que o
teste pegaria uma mudança **errada**: um teste de `calcularDesconto` que só confere se o
resultado é um número falha na base (a função não existia) e passa no item, mas aceitaria
qualquer desconto. A fase 2 cobre isso com mutações: pequenas alterações deliberadas no
código do item que deveriam fazer algum teste falhar.

### Princípio

O agente **propõe** as mutações; o Mabel as **aplica e julga**. O agente não edita nada e
não declara veredito, como no P.1. Isso mantém a prova como garantia, não como pedido.

### Etapa `provar`

- Nova etapa com agente, depois da prova mecânica e antes da revisão. Modelo em
  `config.models.prove` (padrão `sonnet`), limites em `config.limits.prove`.
- Ferramentas: as da revisão (leitura e `git diff`/`git log`). Mesmo sandbox e hook do
  passo 5.
- Prompt (`prompts/provar.md`): parta da hipótese de que os testes não protegem os
  critérios. Para cada critério com `verificacao: "teste"`, proponha mutações que violem o
  critério e que um teste correto deveria pegar: trocar operador ou limite, inverter
  condição, remover uma chamada, devolver valor fixo. Só em arquivos de produção alterados
  pelo item. A mutação precisa compilar e mudar o comportamento.

### Saída estruturada

```ts
interface ProveOutput {
  mutacoes: {
    criterio: string;      // id do critério que a mutação viola
    arquivo: string;       // relativo à raiz, alterado pelo item, fora de `arquivosDeTeste`
    original: string;      // trecho exato, que aparece uma única vez no arquivo
    mutado: string;        // substituição
    porque: string;        // em português: o que deixa de valer no critério
  }[];
}
```

### Execução pelo Mabel

Para cada mutação, no worktree do item, sem agente:

1. **Validar**: arquivo no diff do item e fora de `arquivosDeTeste`; `original` aparece
   exatamente uma vez; `mutado` diferente. Falha → mutação `invalida`, com o motivo.
2. **Aplicar** a substituição.
3. **Compilar**: se o `verify` tem comando `typecheck` ou `build`, rodá-lo. Falha →
   `invalida` ("não compila"); não conta como morta.
4. **Testar**: os testes do critério com `testeUnico` (ou o comando `test`, no modo por
   item). Algum falha → `morta`. Todos passam → `sobrevivente`.
5. **Restaurar** sempre, com a mesma checagem de `git status` limpo do P.2.

Logs em `<dados>/items/<item_id>/mutacoes-<tentativa>/`; resultado em
`mutacoes-<tentativa>.json`; `recordGate(..., 'mutation', …)`.

### Veredito

| Situação | Resultado |
|---|---|
| Critério com ao menos `mutacoesMinimas` (padrão 2) mutações válidas, todas mortas | `provado` |
| Alguma mutação sobrevivente | `nao_provado`, com a lacuna: "trocar `>=` por `>` em `preco.ts` não quebrou nenhum teste do C2" |
| Menos mutações válidas que o mínimo | `sem_prova` (vai a "Olhe primeiro") |

Falha volta à execução com as sobreviventes no prompt, pelas retentativas de hoje.

### Mutante equivalente

Uma mutação pode não mudar o comportamento de fato (ex.: trocar `<` por `<=` num laço que
nunca chega ao limite). Na retentativa, o executor pode **contestar** uma sobrevivente em
`contestacoes: { mutacao, porque }[]` na saída da execução. Mutação contestada não bloqueia:
vai a "Olhe primeiro" com o argumento, para o humano julgar no relatório.

### Quando roda

Decidir na implementação, com os números da fase 1. Proposta inicial: opcional por projeto
(`provaComAgente: true`) e sempre para itens que tocam regra crítica.

### Como saber se vale a pena

Antes de implementar, medir com a auditoria da fase 1: quantos itens a revisão reprova
**depois** da prova mecânica passar, e quantos itens rejeitados pelo humano tinham prova
mecânica verde. São os casos que as mutações deveriam pegar. Custo esperado: uma run a mais
por tentativa, mais as execuções dos testes.

## Fora desta spec

- Implementação da fase 2 (prova com agente), registrada no `BACKLOG.md`.
- Métricas da auditoria: taxa de devolução pela prova e pela revisão, e casos em que o
  revisor aprovou e o gate recusou. Entram com o `mabel runs` (2.3).
- Merge automático na branch principal.
- Reinstalar dependências para rodar a base quando o lockfile muda.
