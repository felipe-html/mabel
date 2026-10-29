# Especificação — Specs, entrega por unidade e relatório de run

Pergunta do usuário: hoje o Mabel entrega por uma branch única de integração e um backlog
único. E se o projeto produzir specs e o quadro as referenciar? Unificar a branch não perde
a rastreabilidade? Dá para manter a integração para o teste conjunto e separar na entrega?

## O que acontece hoje

- O item nasce **da** `mabel/integracao` (G5) e entra nela por um commit de merge
  (`integrateItem`). A branch e o worktree do item são apagados depois.
- O vínculo commit → item não se perde: o `integratedCommit` e o segundo pai do merge
  apontam o item.
- O **porquê** se perde: decisões, respostas da inbox, suposições e prova ficam no banco,
  no `plano.json` e no `.mabel/integracao.md`, que não é versionado (D10). Depois do merge,
  a base tem o código e um PR com o relatório colado no corpo.
- A entrega **não pode ser separada**: cada item contém os integrados antes dele. O PR é um
  bloco; aprovar parte dele ou tirar um item exige revert.
- O refinamento (`docs/specs/refinamento.md`) olha um item por vez, numa rodada só, sem
  método para achar perguntas: o agente lê o item e o código e propõe até 5.

## Ideias consolidadas que orientam o desenho

| Prática | O que o Mabel aproveita |
|---|---|
| Fluxo do próprio git (`gitworkflows(7)`): branches de tópico e o `seen` | Cada tópico nasce da base; a branch de integração é descartável, refeita a partir da base com o merge de todos os tópicos, só para teste. Cada tópico é aceito na base sozinho. |
| `linux-next` | Integração diária só para achar conflito e quebra cedo; nunca é origem de nada. |
| Merge queue (bors, GitHub) | O que vai para a base é testado exatamente como vai entrar: base + o que se entrega. |
| `git rerere` | Resolução de conflito gravada e reaplicada quando o mesmo conflito volta. |
| ADR (Nygard) | Decisão versionada junto do código, com contexto e consequência. |
| Desenvolvimento orientado a spec (Spec Kit, Kiro) | O quadro aponta para a spec; a spec é a unidade de intenção. |
| Example Mapping (Matt Wynne) | Refino por história → regras → exemplos → perguntas; exemplo vira critério, e critério vira teste. |
| Documentação viva | Regras vigentes organizadas por assunto e curadas, separadas do histórico. |

## Decisões

### Do usuário (2026-10-28 e 2026-10-29)

| # | Tema | Decisão |
|---|---|---|
| S1 | Modelo de branches | O do git: unidades de entrega nascem da base; a integração é descartável e só para teste. |
| S2 | Base | Tudo começa da `develop` (esteira de DevOps). Já é configurável: `baseBranch` no `.mabel/config.json`. O Mabel passa a dizer "base" onde hoje diz "branch principal". |
| S3 | Integração | Refeita na abertura de cada `run` a partir da base. Cada tarefa concluída entra nela em seguida, o que dá a prévia de conflito no momento em que ele nasce. |
| S4 | Conflito ou teste vermelho na integração | Aviso, sem bloquear o item. Vai para o relatório de run e para o "olhe primeiro" de quem entregar por último. |
| S5 | Avulsos | Cada avulso tem a própria branch e o próprio PR, para manter o rastreio (principalmente de bugs). |
| S6 | Gate do `ready` | Tarefa de spec só fica `ready` com a spec aceita. |
| S7 | Tamanho da spec | O agente sugere fracionar quando a spec parecer grande. Sem limite fixo por ora; os dados são analisados em 2026-11-05. |
| S8 | Refinar | Produz uma tarefa que cai na esteira do `run` do mesmo jeito que as do `especificar`. |
| S9 | Relatório de run | `.mabel/run.md`, não versionado, sobrescrito a cada `run`. |
| S10 | Épicos e vínculos entre tarefas | Fora desta spec; registrado no `BACKLOG.md`. |

### Recomendações confirmadas pelo usuário (2026-10-29)

| # | Tema | Recomendação |
|---|---|---|
| R1 | `run.md` e `integracao.md` | O `run.md` absorve o `integracao.md`: um arquivo só, com o estado da integração como seção. |
| R2 | Regras vigentes | `.mabel/regras.md`, proposto pelo agente e revisado por você junto com a spec; aplicado na entrega, nunca editado sem revisão. |
| R3 | Nomes | `mabel especificar` (spec) e `mabel refinar` (avulso) como comandos distintos sobre o mesmo motor. |
| R4 | Documento de entrega | Arquivo próprio em `.mabel/entregas/`, versionado pela branch de entrega. A spec diz o que se quer; o documento registra o que aconteceu. |
| R5 | Método | Example Mapping, no `especificar` e no `refinar`. |
| R6 | Dependência entre unidades | A entrega fica bloqueada até a dependência estar na base; `--com <unidade>` entrega as duas juntas. |
| R7 | Entrega parcial | Permitida, com confirmação no TTY e `--parcial` fora dele. |
| R8 | Ordem | Incrementos S.1 a S.6 abaixo, cada um útil sozinho. |

## Arquivos do projeto-alvo

```
.mabel/
  backlog.md               # quadro: tarefas, ordem, Spec:, dependências      versionado
  specs/<slug>.md          # uma spec por funcionalidade                        versionado
  regras.md                # regras de negócio vigentes, por assunto            versionado
  entregas/<data>-<unidade>.md  # documento de entrega                          versionado (pela entrega)
  run.md                   # relatório do último run                            não versionado
  quadro.md                # como hoje                                          não versionado
```

`<slug>` usa letras minúsculas, dígitos e `-`. O `.mabel/.gitignore` passa a listar
`quadro.md` e `run.md`; o `integracao.md` sai (R1), e o projeto antigo que o listar não é
alterado.

## Spec

```markdown
# Exportar pedidos em CSV

## História
O financeiro exporta os pedidos do período para conciliar no ERP.

## Regras

### R1 Só pedidos do período escolhido
- Pedido de 31/10 às 23h59, período até 31/10 → entra.
- Pedido de 01/11 às 00h00, período até 31/10 → não entra.

### R2 Pedido cancelado não entra
- Pedido cancelado dentro do período → não entra.

## Decisões
- Pedido cancelado entra? → Não. (refino, 2026-10-29)

## Fora do escopo
- Agendar a exportação.

## Regras críticas
- Valores financeiros

## Alterações nas regras vigentes
- pedidos: incluir "Exportação considera só pedidos não cancelados do período."
```

- Cada regra tem um id estável (`R1`, `R2`…), que as tarefas citam.
- Cada exemplo é um caso concreto: situação → resultado.
- `Alterações nas regras vigentes` é o que a entrega aplica ao `regras.md` (R2): a regra
  só vira vigente quando o código chega à base.
- O estado da spec (`rascunho`, `aceita`, `entregue`) fica no banco, como o dos itens; o
  arquivo é só conteúdo.

### Spec válida

O Mabel confere a estrutura, sem depender do agente:

- toda regra tem pelo menos um exemplo, e algum exemplo da spec é de borda (marcado pelo
  agente na proposta e conferido na revisão);
- nenhum exemplo sem resultado (`→ ?`);
- `Fora do escopo` declarado (pode ser "Nada.").

A spec escrita à mão por você, que passa na validação, pode ser aceita sem o agente
(`mabel especificar <slug> --aceitar`).

## Quadro (backlog)

Tarefas de spec ganham dois campos:

```
## 5. Exportar pedidos filtrados por período
Spec: exportar-csv
Regras: R1, R2
Depende de: 4
```

- O planejador, o executor e o revisor recebem a história, as regras citadas com os
  exemplos, as decisões, o fora do escopo e as regras críticas da spec. Os exemplos das
  regras citadas contam como critérios de aceite da tarefa; `Critérios:` no backlog
  acrescenta outros.
- O hash da tarefa inclui o trecho da spec que ela cita (história, regras citadas,
  decisões, fora do escopo). Spec alterada → tarefa não iniciada tratada como alterada;
  tarefa iniciada segue com a cópia do início, como as referências.
- Gate do `ready` (S6): tarefa com `Spec:` exige spec `aceita` e regras citadas existentes;
  senão fica em `backlog` com o motivo.
- Tarefa sem `Spec:` é **avulso**. Ganha o campo opcional `Tipo: bug`.

## Motor de especificação (Example Mapping)

Um motor, dois comandos (R3):

| Comando | Escopo | Saída |
|---|---|---|
| `mabel especificar <slug> [--refazer] [--aceitar \| --descartar]` | A spec em `.mabel/specs/<slug>.md` (rascunho livre, pode ser só a história) | Spec completa + tarefas propostas para o quadro |
| `mabel refinar <n> [--refazer] [--aceitar \| --descartar]` | Um avulso do backlog | O avulso completo, no backlog, pronto para o `run` |

### Rodadas

1. O agente (etapa `specify`, só leitura, mesmas travas do `refine` de hoje) lê o rascunho,
   o código, o `regras.md` e, sob demanda, os documentos de entrega (ver "Memória").
2. Para cada regra, monta exemplos: o caso comum e os de borda de uma lista fixa no prompt
   (limites de valor e de data, lista vazia, estados do objeto, quem pode fazer, repetição
   e concorrência, falha externa).
3. Exemplo com resultado dedutível da spec, do `regras.md`, das decisões ou do código entra
   com o resultado. **Exemplo sem resultado dedutível vira pergunta**, com a sugestão do
   agente. As perguntas nascem dos exemplos, não de "pense em perguntas".
4. No máximo 5 perguntas por rodada, ordenadas pelo impacto; as outras ficam para a
   próxima.
5. Você responde no TTY como na inbox (enter aceita a sugestão, texto responde, `p` deixa
   para o planejamento). Cada resposta vira decisão e, quando muda um resultado, exemplo.
6. A rodada seguinte, na mesma sessão (`--resume`, como no `nascer`), retrabalha só as
   regras que as respostas mexeram.
7. Termina quando a proposta forma uma spec válida e não sobra pergunta (fora as marcadas
   `p`). Saída inválida pede correção na mesma sessão, como no `nascer`.

Tamanho (S7): o agente devolve `sugestaoQuebra` quando a spec parecer grande demais, com as
specs menores que proporia. O Mabel só mostra; não há limite fixo. Grava por spec o número
de regras, exemplos, rodadas, perguntas e tarefas, para a análise de 2026-11-05.

### Saída estruturada

```ts
interface SpecifyOutput {
  historia: string;
  regras: { id: string; texto: string; exemplos: { situacao: string; resultado: string; borda: boolean }[] }[];
  perguntas: (Question & { regra: string })[];    // no máximo 5
  decisoes: string[];                              // "pergunta → resposta" das rodadas
  foraDoEscopo: string[];
  conceitosCriticos: string[];                     // copiados de regras-criticas.md
  alteracoesRegrasVigentes: { assunto: string; acao: 'incluir' | 'alterar' | 'remover'; texto: string }[];
  tarefas: { titulo: string; intencao: string; regras: string[]; dependeDe: number[] }[];
  sugestaoQuebra: { titulo: string; historia: string }[];
}
```

`dependeDe` usa a posição na lista de tarefas, como no `nascer`.

### Revisão e gravação

A revisão segue a do `refinar` de hoje (aceita, edita um a um, descarta), parte a parte:
história, regras com exemplos, decisões, fora do escopo, regras críticas, alterações nas
regras vigentes e tarefas. `Gravar? [S/n/d]`.

- **`especificar`**: grava `.mabel/specs/<slug>.md`, acrescenta as tarefas ao fim do
  `backlog.md` com `Spec:` e `Regras:` e marca a spec como `aceita`.
- **`refinar`** (S8): a mesma saída, com uma tarefa só. As regras e os exemplos viram
  `Critérios:` do avulso, as respostas viram `Decisões:`, e o resto vai para os campos que
  já existem. As alterações nas regras vigentes ficam num campo novo do avulso, aplicado na
  entrega. Se a proposta tiver mais de uma tarefa, o Mabel sugere transformar o avulso em
  spec e explica o caminho manual (escrever a spec e tirar o avulso). Não há
  `especificar --de <n>`: avulso é tarefa curta, como hotfix, e a conversão seria rara.
- **Bug** (`Tipo: bug`): os cartões de regra viram passos para reproduzir, resultado
  esperado e resultado obtido. O exemplo de reprodução é o primeiro critério, e a prova
  mecânica exige o teste vermelho na base.

O avulso aceito vai a `ready` pelo gate de sempre; a tarefa de spec, pelo S6. O `run` não
distingue as duas origens além da branch.

### Respostas da inbox

Resposta da inbox (ou aprovação de plano) de uma tarefa de spec é gravada nas `Decisões`
da spec, com a origem (`inbox, #5, 2026-10-30`). A próxima tarefa da spec já a recebe, e o
documento de entrega a lista. No avulso, vai para as `Decisões:` dele. Fecha o "caminho B"
de `docs/specs/refinamento.md`.

## Memória: regras vigentes e histórico

Ler todas as entregas anteriores fica inviável com o tempo. O agente separa o que vale hoje
do histórico:

- **`.mabel/regras.md`** (R2): regras de negócio vigentes por assunto, curado (regra
  obsoleta sai). O agente lê sempre, dentro do orçamento de contexto; acima do limite, o
  `especificar` avisa e propõe consolidar.
- **Documentos de entrega**: histórico. A primeira linha de cada um é o resumo
  (`Resumo: <unidade> · <data> · <assuntos> · <decisões principais>`). O agente os
  encontra com `Grep` e lê só os relevantes. Sem arquivo de índice: duas entregas abertas
  editando o mesmo índice conflitariam.

## Branches

```
develop ─┬─ mabel/spec/exportar-csv ─┬─ tarefa #5 ┐
         │                           └─ tarefa #6 ┘→ merge na spec (done calculado)
         ├─ mabel/avulso/9-corrige-total            (a própria branch do avulso)
         │
         └─ mabel/integracao = develop + specs + avulsos   (refeita a cada run, só teste)
```

| Unidade | Branch | Nasce de | Recebe |
|---|---|---|---|
| Spec | `mabel/spec/<slug>` | Base, quando a primeira tarefa começa | Merge de cada tarefa depois do G3 e da revisão (o `integrateItem` de hoje, com outro destino) |
| Tarefa de spec | `mabel/item/<n>-…` (worktree, como hoje) | Branch da spec | — (apagada depois do merge na spec) |
| Avulso | `mabel/avulso/<n>-<slug>` | Base | Os commits do próprio avulso; fica até a entrega (S5) |
| Integração | `mabel/integracao` | Base, a cada `run` | Merge de cada unidade aberta; nunca é origem nem entrega |

Dependência entre unidades: a tarefa que depende de outra unidade não entregue faz, antes
de começar, o merge daquela unidade na sua (spec ou avulso). A entrega fica presa à da
dependência (R6).

Os merges do Mabel rodam com `-c rerere.enabled=true -c rerere.autoUpdate=true`: a
resolução que você fizer num conflito da base com uma unidade é reaplicada quando ele
voltar.

### Abertura do `run`

1. O que já existe: commit do `.mabel/` pendente na base, conferência das entregas.
2. Unidade cuja branch está na base → entregue: tarefas a `done`, spec `entregue`, branch
   local apagada.
3. Merge da base em cada unidade aberta (traz o que entrou na `develop`). Conflito → a
   unidade fica **pausada** ("resolva o merge da develop na mabel/spec/x"), as tarefas dela
   não são escolhidas, e as outras seguem.
4. Integração refeita: `update-ref` da `mabel/integracao` para a base (recusa se ela
   estiver aberta num worktree fora do Mabel) e merge de cada unidade aberta, na ordem da
   primeira integração. Unidade que conflita fica de fora, com aviso (S4).
5. Verificação do projeto na integração. Vermelho → aviso (S4).

### Fim de cada tarefa

1. G3 e revisão, como hoje.
2. Merge na branch da unidade (spec) ou fim dos commits na branch do avulso. Tarefa vai a
   `awaiting_merge`.
3. Merge da unidade na integração: conflito ou verificação vermelha → aviso, com a tarefa
   que o causou, sem desfazer o passo 2 (S4).
4. Relatório de run reescrito.

### Rejeição

`mabel rejeitar <n>` reverte a tarefa na branch da spec (dentro da spec, as tarefas se
acumulam). No avulso, a branch volta ao commit da base e o item replaneja. A integração não
precisa de revert: o próximo `run` a refaz.

## Entrega

```
mabel entregar <slug | #n> [--com <unidade>] [--parcial] [--substituir] [--rascunho]
```

Sem argumento, no TTY: menu das unidades com tarefas concluídas; fora dele, a tabela.

1. **Unidade**: spec com pelo menos uma tarefa concluída, ou avulso concluído. Tarefa da
   spec ainda não concluída → entrega parcial: confirmação no TTY, `--parcial` fora dele
   (R7).
2. **Dependências**: unidade que depende de outra fora da base → recusa, com a sugestão
   `--com <outra>` (R6), que entrega as duas numa branch só.
3. **Snapshot**: `rev-parse` da branch da unidade, como hoje.
4. **Prova da entrega**: num worktree temporário, base + merge do snapshot. Conflito →
   recusa ("faça o merge da develop na unidade"). Depois, a verificação do projeto. Vermelho
   → recusa, com a saída. É a regra do merge queue: testar o que vai entrar.
5. **Documento de entrega** (abaixo), gravado em `.mabel/entregas/<data>-<unidade>.md`
   junto com as alterações nas regras vigentes aplicadas ao `.mabel/regras.md`.
6. **Branch de entrega** `mabel/entrega/<unidade>`: o snapshot + um commit do Mabel só com
   esses dois arquivos (`mabel: entrega <unidade>`).
7. Publicação, PR (corpo = documento, cortado como hoje acima de 60.000 caracteres),
   checkout da raiz e gravação da entrega: como em `docs/specs/entregar.md`, por unidade.
   E3 (só merge commit) continua valendo.

Uma entrega aberta por unidade; `--substituir` como hoje.

### Documento de entrega

```markdown
Resumo: exportar-csv · 2026-11-02 · pedidos, financeiro · cancelado não entra; período inclusivo

# Entrega: Exportar pedidos em CSV

Spec: .mabel/specs/exportar-csv.md (a4f9c21) · Base: develop · 3 tarefas · US$ 4,12

## Olhe primeiro
- Critério sem prova mecânica: …
- Conflito visto na integração com mabel/spec/login em src/api/pedidos.ts (resolvido? não)

## Decisões
- Pedido cancelado entra? → Não. (refino, 2026-10-29)
- Fuso do período? → America/Sao_Paulo. (inbox, #6, 2026-10-30)

## Suposições do agente
- #6: o separador decimal segue a configuração do usuário. (não contestada)

## Critérios e prova
| Regra | Exemplo | Teste | Prova |
|---|---|---|---|
| R1 | 31/10 23h59 entra | pedidos.test.ts › limite superior | vermelho na base, verde na entrega |

## Desvios
- #5 replanejado 1 vez: …
- #7 rejeitado: …

## Tarefas
- #5 Exportar filtrados por período · merge a1b2c3d
- #6 …

## Regras vigentes alteradas
- pedidos: incluído "…"
```

O documento vai para a base pelo merge do PR: o porquê fica no repositório, junto do
código.

### Trailers

Todo commit de merge do Mabel leva `Mabel-Item: #5` e `Mabel-Unidade: exportar-csv` (ou
`avulso-9`). O commit da entrega leva `Mabel-Entrega: <data>-<unidade>`. `git log
--grep 'Mabel-Unidade: exportar-csv'` reconstrói a unidade sem o banco.

## Relatório de run

`.mabel/run.md` (S9), reescrito ao fim de cada tarefa e no fim do `run`: se o processo
cair, o relatório mostra até onde foi. A notificação de fim de fila aponta para ele.

```markdown
# Run de 2026-11-02 · 22:10 → 06:42 (8h32)

Fim: fila vazia · US$ 18,40 · saldo 7 dias: 41% (reset 05/11)

## Precisa de você
- Inbox: 2 perguntas (#8, #11), 1 aprovação de plano (#12)
- #10 falhou na verificação 3 vezes: needs_human
- Spec login pausada: conflito da develop em src/auth.ts
- Integração: mabel/spec/exportar-csv × mabel/spec/login conflitam em src/api/pedidos.ts (desde #6)

## Prontas para entregar
- exportar-csv (3/3) · mabel entregar exportar-csv
- avulso #9 Corrige total do carrinho · mabel entregar #9

## Em andamento
- login (2/5): #7 concluída neste run

## Integração
develop (a1b2c3d) + 3 unidades · 1 de fora (login) · verificação: verde

## Tarefas deste run
| # | Unidade | Resultado | Etapas | Custo |
|---|---|---|---|---|
| 5 | exportar-csv | concluída | planejar, executar, revisar | US$ 3,10 |
```

O `run.md` substitui o `integracao.md` (R1): a seção "Integração" e as unidades prontas
cobrem o que ele mostra hoje, e o `mabel integracao` passa a mostrar as seções de unidade
do `run.md`.

## Migração

Projeto com itens em `awaiting_merge` na `mabel/integracao` antiga: no primeiro `run` com
este modelo, a branch vira a unidade `mabel/spec/legado` (spec sem arquivo, só para
entrega), e esses itens passam a pertencer a ela. `mabel entregar legado` funciona como a
entrega de hoje. Depois, a integração é refeita normalmente.

## Contrato

Autorizado pelo usuário em 2026-10-29. Cada mudança entra no `docs/CONTRATO.md` com o
incremento que a implementa (coluna "Contrato" em "Incrementos"), para o contrato nunca
descrever garantia que o código ainda não impõe.

- **Vocabulário**: `Spec` (funcionalidade com história, regras e exemplos), `Tarefa` (item
  do quadro, de uma spec ou avulso), `Unidade de entrega` (spec ou avulso), `Base` (a branch
  configurada em `baseBranch`; substitui "branch principal" no texto).
- **Ciclo de vida**: `awaiting_merge` passa a "concluído na branch da unidade, aguardando
  entrega e merge do humano na base".
- **G5**: worktree e branch próprias por tarefa, criadas da branch da spec (tarefa de spec)
  ou da base (avulso, que mantém a branch até a entrega).
- **G10**: "A unidade só recebe tarefa com done calculado." A integração é derivada:
  refeita pelo Mabel a partir da base, só para teste, nunca origem nem entrega. A base só
  recebe o merge feito pelo humano, os commits do `.mabel/` que já existem e o do `nascer`.
  Na entrega, o Mabel commita na branch de entrega (nunca na base) o documento e as
  alterações no `regras.md`.
- **Backlog e quadro**: linhas para `specs/`, `regras.md`, `entregas/` e `run.md`; o
  `integracao.md` sai.
- **Decisões do humano**: "Aceitar a spec (`mabel especificar`)" entra; "Pedir a entrega
  (`mabel entregar`) e fazer o merge na base".

## Incrementos

Cada um termina com `npm run check` verde, critérios atendidos, `docs/PLANO.md` e
`docs/ESTEIRA.html` atualizados e um commit.

| # | Incremento | Contrato |
|---|---|---|
| S.1 | Relatório de run: `.mabel/run.md`, reescrito por tarefa, substitui o `integracao.md`. | Tabela de arquivos |
| S.2 | Documento de entrega versionado e trailers, ainda com a integração única. | G10 (commit na branch de entrega) |
| S.3 | Specs: formato, parser, validação, `Spec:` e `Regras:` no backlog, contexto nos prompts, hash, gate do `ready`, respostas da inbox nas decisões da spec. | Vocabulário, tabela de arquivos, decisões do humano |
| S.4 | Motor de especificação: `especificar` com Example Mapping, rodadas, `regras.md`, métricas de tamanho; `refinar` migrado para o motor (avulso e bug). | — |
| S.5 | Branches por unidade, integração refeita no `run`, aviso de conflito, rerere, rejeição por unidade, migração do legado. | G5, G10, ciclo de vida |
| S.6 | `entregar <unidade>`: prova da entrega, `--com`, `--parcial`, regras vigentes aplicadas, depois do merge por unidade. | G10 |

S.1 e S.2 já valem com o modelo de hoje. S.3 e S.4 valem com a integração única (todas as
tarefas continuam indo para ela). S.5 e S.6 trocam o modelo de branches.

## Critérios de aceite

Com o `claude` falso, um remoto local (`git init --bare`) e o `gh` falso, como nas specs
anteriores.

**S.1**
1. Um `run` com três tarefas (uma concluída, uma em `needs_human`, uma com falha) grava o
   `run.md` com as seções na ordem, e o arquivo existe depois da primeira tarefa.
2. Um segundo `run` sobrescreve o arquivo; `run.md` está no `.gitignore` de projeto novo.

**S.2**
3. `mabel entregar` grava o documento na branch de entrega, com decisões, suposições,
   critérios com prova, desvios e tarefas; a base não recebe commit do Mabel.
4. Commits de merge do Mabel trazem os trailers.

**S.3**
5. Tarefa com `Spec:` de spec não aceita fica em `backlog` com o motivo; aceita, vai a
   `ready`. Regra citada inexistente também segura.
6. O prompt do planejamento traz a história, as regras citadas com exemplos, as decisões e
   o fora do escopo da spec.
7. Mudar uma regra citada muda o hash da tarefa não iniciada; a iniciada segue com a cópia.
8. Resposta da inbox de uma tarefa de spec aparece nas `Decisões` da spec.

**S.4**
9. `especificar` com duas rodadas: as respostas da primeira viram decisões e exemplos, a
   segunda só retrabalha as regras mexidas, e a aceitação grava a spec e as tarefas.
10. Proposta com exemplo sem resultado e sem pergunta é corrigida na mesma sessão.
11. `refinar` de um avulso grava critérios e decisões no backlog, e o item vai a `ready`.
    `Tipo: bug` exige o critério de reprodução.
12. Métricas de tamanho gravadas por spec; `sugestaoQuebra` aparece na revisão.

**S.5**
13. Duas specs: as tarefas de cada uma nascem da sua branch; a integração é refeita no
    `run` com as duas.
14. Conflito entre as specs: aviso no `run.md` com a tarefa que o causou; as duas specs
    seguem.
15. Conflito da `develop` com uma spec: a spec fica pausada, a outra segue.
16. Avulso mantém `mabel/avulso/<n>-<slug>` até a entrega.
17. Migração: itens na integração antiga viram a unidade `legado`.

**S.6**
18. `entregar exportar-csv` com verificação vermelha em base + spec é recusado sem criar
    branch.
19. Spec que depende de outra não entregue: recusa; `--com` entrega as duas.
20. Entrega parcial pede confirmação (TTY) ou `--parcial`.
21. Merge da entrega na base: o próximo `run` leva as tarefas a `done`, a spec a
    `entregue`, e o `regras.md` da base tem as alterações.

## Fora desta entrega (vai para o `BACKLOG.md`)

- Épicos e vínculos entre tarefas, quadro funcional (S10, já registrado).
- `--json` e passos sem TTY do `especificar` para clientes, no desenho do `nascer`.
- Limite de tamanho da spec, depois da análise de 2026-11-05.
- Spec que enxerga o que outras specs abertas vão mudar nas regras vigentes.
- Resolução de conflito pelo agente (hoje: aviso e humano).
