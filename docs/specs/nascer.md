# Especificação — `mabel criar`

Incremento 5 de `docs/specs/integracao-externa.md`. Hoje um projeto entra no Mabel pelo
`mabel preparar`, que detecta a stack e cria o `.mabel/` com um backlog vazio (mais o item
"Estabelecer base de testes", quando falta teste). Tudo o que dá forma ao projeto —
`CLAUDE.md`, regras críticas, backlog inicial — fica para o usuário escrever do zero.

O `criar` é uma conversa curta com um agente que termina numa **proposta revisável**:
stack, `CLAUDE.md`, regras críticas e backlog inicial. O usuário revisa como no `refinar`
e o `preparar` grava. Serve a dois começos:

- **Diretório vazio**: a ideia em texto livre ("um app de controle de férias do time").
- **Repositório sem `.mabel/`**: o agente lê o código para propor o resto.

Parente do "`mabel adicionar` assistido" no `BACKLOG.md`: o motor que propõe itens com critérios
é o mesmo, e o `adicionar` assistido pode reusá-lo depois.

Regra que orienta o resto: **o agente propõe, o humano decide, o Mabel grava.** A run é só
leitura; nada entra no repositório antes da revisão.

## Contrato

O `criar` é um comando avulso, como o `refinar`: sem item e fora do ciclo de vida. A run é
auditada (G1), hermética (G8) e passa pela política de saldo (G6). O agente não escreve
nada (G4): quem grava é o Mabel, depois da revisão.

Um ponto mexe no contrato, **autorizado pelo usuário em 2026-10-24** (pergunta 1): o
commit do `CLAUDE.md` que o `criar` criou. O G10 passa a incluir, além do que o humano
escreveu no `.mabel/`, o que ele aceitou na revisão do `mabel criar`.

## Decisões (aceitas pelo usuário em 2026-10-24)

| Tema | Decisão |
|---|---|
| Forma | Comando `mabel criar`, rodadas de pergunta e resposta na mesma sessão (`--resume`), proposta no fim. |
| Rodadas | No máximo 3 rodadas de perguntas, com até 5 perguntas cada, todas com sugestão. Na terceira, o agente propõe com suposições. |
| Gravação | Pelo caminho do `preparar`, com a stack escolhida e os arquivos aceitos. Sem revisão, nada é gravado. |
| `CLAUDE.md` existente | Nunca é sobrescrito. Entra como contexto da run; o agente pode sugerir acréscimos, que aparecem na revisão e não são gravados. |
| Diretório vazio sem git | O `criar` roda `git init -b main` antes de gravar e avisa (pergunta 2). Diretório com arquivos e sem git é recusado, como no `preparar`. |
| Projeto Mabel | Recusado: "já é um projeto Mabel; use `mabel adicionar` ou `mabel refinar`". |
| Base de testes | Continua com o `preparar`: sem testes, "Estabelecer base de testes" é o item 1 e os itens propostos sem dependência passam a depender dele. |
| Sem TTY | Mesmo fluxo em passos (`--responder`, `--aceitar`), com `--json`, para o `mabel-ui`. |

## Comando

```
mabel criar ["<descrição>"] [--stack <id>] [--modelo <m>] [--json]
mabel criar --responder <id> --respostas <arquivo.json> [--json]
mabel criar --aceitar <id> [--proposta <arquivo.json>] [--json]
mabel criar --descartar <id>
mabel criar --lista [--json]
```

| Forma | TTY | Fora de TTY |
|---|---|---|
| `criar` sem descrição | Pergunta "O que é o projeto?" (num repositório com código, enter vazio deixa o agente partir do código). | Num diretório vazio, sai com código 1 pedindo a descrição; num repositório com código, roda sem ela. |
| `criar "<descrição>"` | Roda a primeira rodada; perguntas uma a uma (enter aceita a sugestão, texto responde, `d` decide você); próxima rodada; no fim, a revisão. | Roda a primeira rodada e escreve as perguntas ou a proposta (texto ou `--json`), com o id. |
| `--responder <id>` | — | Retoma a sessão com as respostas e escreve a próxima rodada. `--respostas` é uma lista JSON na ordem das perguntas: texto responde, `null` aceita a sugestão. |
| `--aceitar <id>` | — | Grava a proposta inteira, ou a de `--proposta` (a proposta editada pelo cliente, validada pelo mesmo esquema). |
| `--descartar <id>` | Descarta sem gravar. | Igual. |
| `--lista` | Nascimentos em aberto (perguntas ou proposta pendente) com raiz e data. | Igual. |
| `--stack <id>` | Fixa a stack do catálogo; o agente não a propõe. | Igual. |

Ctrl+C no TTY deixa o nascimento em aberto: `mabel criar --lista` mostra, e
`mabel criar` na mesma raiz pergunta se retoma.

## Run de nascimento

- Etapa `birth` no runner, sem item: ferramentas `Read`, `Glob`, `Grep`; cwd na raiz; as
  mesmas travas das outras etapas (flags herméticas, sandbox, hook de escopo com escopo
  vazio, conferência do `init`, orçamento de contexto). Num diretório vazio, o agente só
  tem a descrição.
- Contexto: o `CLAUDE.md` e o `AGENTS.md` da raiz, se existirem (como nas outras etapas);
  o catálogo de stacks (ids, nomes, comandos detectados) e, num repositório com código, a
  detecção do `preparar` (stacks e comandos).
- Modelo padrão `sonnet`, 40 turnos e US$ 2 por rodada. Não há `config.json` ainda: os
  padrões ficam no código, e `--modelo` troca o modelo.
- Prompt de sistema `prompts/nascer.md`. O que ele pede ao agente:
  - perguntar só o que muda a proposta e só o humano sabe (público, regra de negócio,
    restrição dura); o resto vira suposição declarada;
  - `CLAUDE.md` curto: o que o projeto é, convenções, comandos, o que não fazer;
  - regras críticas só onde um erro custa caro (dinheiro, dado pessoal, permissão);
  - backlog de 3 a 10 itens pequenos, em ordem de execução, cada um com intenção e
    critérios verificáveis; item que toca regra crítica traz `regrasCriticas`.
- Saída estruturada:

```ts
interface BirthOutput {
  entendimento: string;       // o que o agente entendeu, em 2 a 4 frases
  perguntas: Question[];      // vazio quando a proposta está pronta
  suposicoes: string[];       // o que o agente decidiu sem perguntar
  proposta: BirthProposal;    // ignorada enquanto houver perguntas
}

interface BirthProposal {
  stack: string;              // id do catálogo ou "outra"
  stackMotivo: string;
  claudeMd: string;           // vazio quando a raiz já tem CLAUDE.md
  acrescimosClaudeMd: string[]; // com CLAUDE.md existente: sugestões, não gravadas
  regrasCriticas: { caminhos: string[]; conceitos: string[] };
  backlog: {
    titulo: string;
    intencao: string;
    criterios: string[];
    foraDoEscopo: string[];
    decisoes: string[];
    regrasCriticas: string[]; // conceitos de regrasCriticas.conceitos
    dependeDe: number[];      // posições (1, 2, …) na própria lista
  }[];
}
```

- Validação do Mabel além do esquema: stack do catálogo ou `outra`; conceitos citados nos
  itens existem em `regrasCriticas.conceitos`; `dependeDe` aponta para posições anteriores;
  globs de caminho relativos à raiz. Proposta inválida pede ao agente, na mesma sessão, que
  corrija (uma vez); falhando de novo, a rodada falha com o motivo.
- Respostas entram como `decisoes` nos itens que elas afetam ou no `CLAUDE.md`, a critério
  do agente; o prompt da rodada seguinte leva `P: … R: …`, como o `responder`.
- Saldo: a política de uma chamada só do `refinar` (`ensureRefineBalance`, que passa a
  receber a etapa da estimativa), antes de cada rodada. Fora do TTY, abaixo do piso ou
  acima do ritmo, recusa com o motivo.

### Tabela `births`

| Coluna | Conteúdo |
|---|---|
| `id` | Id do nascimento (o `<id>` dos comandos aceita prefixo único). |
| `root` | Raiz do repositório. |
| `description` | Descrição inicial. |
| `options` | `--stack` e `--modelo` da primeira chamada, que valem para as rodadas seguintes. |
| `session_id` | Sessão do agente, retomada a cada rodada. |
| `rounds` | Rodadas feitas. |
| `output` | Última saída estruturada. |
| `status` | `asking`, `proposed`, `accepted`, `discarded`. |
| `decision` | O que foi gravado (a proposta depois da revisão). |
| `project_id` | Projeto criado no aceite. |
| `created_at`, `decided_at` | Horários. |

As runs são de etapa, sem item, como o `pedir`; o `births` liga o nascimento a elas pela
sessão. Classificação para a remoção: `project`, onde `project_id = ?`. Nascimento
descartado ou abandonado fica fora de qualquer projeto, como as runs sem item.

## Revisão (TTY)

```
Proposta para ferias-time

Entendimento
  …
Suposições
  - Login pelo Google Workspace da empresa

Stack: node (Node com Vitest) — o time já usa TypeScript
  › enter aceita · s escolhe outra

CLAUDE.md (novo, 34 linhas)
  <primeiras 12 linhas>
  › enter aceita · v mostra tudo · e edita no $EDITOR · - não cria

Regras críticas
  Caminhos: src/aprovacoes/**
  Conceitos: Saldo de férias nunca fica negativo
  › enter aceita · e edita um a um · - descarta

Backlog (6 itens; "Estabelecer base de testes" entra antes, como item 1)
  2. Cadastro de pessoas do time
     intenção: …  critérios: 3  depende de: 1
  › enter aceita · v detalha · e edita · - descarta

Gravar? [S/n/d]   (n deixa a proposta pendente · d descarta)
```

- Edição de listas como no `refinar`: enter mantém, `-` remove, texto substitui, linhas
  novas até uma vazia.
- Item descartado some das dependências dos outros; a revisão avisa.
- `e` no `CLAUDE.md` abre um arquivo temporário no `$EDITOR` (padrão `vi`) e lê de volta.
- Com `CLAUDE.md` existente, a seção mostra os acréscimos sugeridos e lembra que não serão
  gravados.

## Gravação

Pelo `preparar`, com a stack aceita (como `--stack`; `outra` segue sem stack, com "Stack: a
definir" no item da base de testes) e:

- `regras-criticas.md` do modelo com os caminhos e os conceitos aceitos;
- `backlog.md` com o item da base de testes (se faltar teste) e os itens aceitos, pelo
  `renderItemBlock`, com as posições trocadas pelos números;
- `CLAUDE.md` na raiz, se aceito e se ainda não existir (conferido de novo na gravação);
- `births.status = accepted`, com a proposta gravada e o projeto.

Depois, um commit "mabel criar" na branch atual só com o `.mabel/` e o `CLAUDE.md` criado
(o resto do índice fica como está, como no `commitMabelDir`), e o resumo: arquivos criados, itens, regras críticas, custo
das rodadas e o próximo passo (`mabel refinar` para os itens críticos, depois `mabel rodar`).

## Saída `--json`

Uma linha, como as de `docs/specs/integracao-externa.md`:

```json
{"versao":1,"nascimento":"3f2a…","estado":"perguntas","rodada":1,"entendimento":"…","perguntas":[{"texto":"…","sugestao":"…","regra_critica":false}],"suposicoes":[],"proposta":null,"custo_usd":0.12}
```

`estado`: `perguntas`, `proposta`, `gravado` ou `descartado`. Em `proposta`, `proposta` traz
os campos de `BirthProposal` com nomes em português de cobra (`claude_md`,
`acrescimos_claude_md`, `regras_criticas`, `fora_do_escopo`, `depende_de`). Em `gravado`,
vem `projeto` (`id`, `nome`, `raiz`) e `arquivos`.

## Incrementos

1. **Rodadas**: etapa `birth`, prompt, esquema, validação, tabela `births`, saldo e as
   perguntas no TTY; no fim, a proposta é mostrada, sem gravar.
2. **Revisão e gravação**: revisão no TTY, gravação pelo `preparar`, `git init` no diretório
   vazio, o commit do `.mabel/` e do `CLAUDE.md` e o G10 atualizado no contrato.
3. **Sem TTY**: `--responder`, `--aceitar` (com `--proposta`), `--descartar`, `--lista`
   e `--json`.

## Critérios de aceite

1. `criar "<descrição>"` num diretório vazio roda a etapa `birth` (auditada, hermética, só
   leitura) e grava o nascimento; com perguntas, a rodada seguinte retoma a mesma sessão
   com as respostas.
2. Na terceira rodada, a proposta vem sem perguntas; a validação recusa conceito
   inexistente e dependência para frente, e a correção roda na mesma sessão.
3. A revisão aceita, edita e descarta cada parte; a gravação cria o `.mabel/` pelo `preparar`,
   com as regras críticas e o backlog aceitos, e o `CLAUDE.md` só se ele não existir.
4. Sem testes, "Estabelecer base de testes" é o item 1 e os itens propostos sem dependência
   dependem dele.
5. Num repositório com código, o agente recebe a detecção do `preparar` e o `CLAUDE.md`
   existente, que não é sobrescrito.
6. Fora do TTY, `criar`, `--responder`, `--aceitar` e `--descartar` não perguntam nada e
   escrevem uma linha de JSON com `"versao": 1` em `--json`; o que falta sai com código 1.
7. Projeto Mabel e diretório com arquivos sem git são recusados.
8. A tabela `births` está classificada para a remoção.

## Fora desta entrega (vai para o `BACKLOG.md`)

- `mabel adicionar --assistido`, reusando o motor de proposta de itens.
- Acrescentar ao `CLAUDE.md` existente.
- `setup` e `verify` propostos pelo agente para stack fora do catálogo.
- Nascer a partir de um documento (`--de <arquivo>`) em vez da descrição.
- Medir quanto do backlog proposto chegou a `done` sem replanejamento.

## Perguntas para o usuário (respondidas em 2026-10-24: todas as recomendações aceitas)

1. **Commit do `CLAUDE.md`** (muda o G10). Recomendo: o aceite na revisão autoriza um
   commit "mabel criar" com o `.mabel/` e o `CLAUDE.md` criado (só esses caminhos), e o
   G10 passa a incluir "e o que o humano aceitou no `mabel criar`". Sem o commit, os
   worktrees dos itens nascem sem o `CLAUDE.md` até o usuário commitar, e o `rodar` não o
   commita (só o `.mabel/`). Alternativa: não commitar e avisar, como o `preparar` faz sem TTY.
2. **`git init` no diretório vazio**. Recomendo fazer sem perguntar, porque não há nada a
   perder, e avisar no resumo. Alternativa: perguntar no TTY e exigir `--git-init` fora dele.
3. **Limite de rodadas**. Recomendo 3, com até 5 perguntas cada. Alternativa: uma rodada
   só, como o `refinar`, com o resto em suposições.
4. **Modelo padrão**. Recomendo `sonnet`, como o `refinar`. Alternativa: `opus`, porque a
   proposta molda o projeto inteiro e roda uma vez.
