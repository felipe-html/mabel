# Especificação — Inbox

Achado do teste com o `ferias-planner`: os 3 itens pararam em `needs_human` no
planejamento, e a única forma de responder era `mabel item <n>` seguido de
`mabel responder <n> "..."`, um item por vez. A inbox junta as pendências de todos os
itens num só fluxo, pergunta por pergunta, e devolve a esteira para a fila.

Não muda o contrato: é a "inbox em lote" prevista em "Decisões do humano" e no passo 5.
O `responder`, o `aprovar` e o `cancelar` continuam existindo e a inbox os usa por baixo.

Termina com `npm run check` verde, critérios atendidos, `docs/PLANO.md` atualizado e um
commit.

## Decisões

| Tema | Decisão |
|---|---|
| Granularidade | Uma pergunta por vez. O Mabel junta as respostas do item num texto `P1… R1…` e chama `respond` uma vez por item. |
| Sugestão de resposta | As perguntas passam a ser `{ texto, sugestao }` no planejamento e na execução. Enter aceita a sugestão. |
| "Decide você" | Devolve a pergunta ao agente, que decide e registra como suposição. Indisponível em `critical_approval`, porque G2 e G7 exigem decisão humana ali. |
| Motivos cobertos | Todos os `pending_kind`, cada um com as opções que lhe cabem (tabela abaixo). |
| Fim da inbox | Pergunta "Retomar a esteira agora? [S/n]". |
| Fim do `run` | Se a fila terminar com itens em `needs_human` num TTY, oferece abrir a inbox. Fluxo: run → inbox → run. |

## Esquema

`perguntas` passa de `string[]` para `{ texto: string; sugestao: string }[]` em
`planSchema` e `executeSchema`. `sugestao` pode ser vazia quando não houver resposta
razoável a propor. `Pending.questions` acompanha a mudança; pendências gravadas no
formato antigo (strings) são lidas como `{ texto, sugestao: '' }`.

O prompt continua pedindo no máximo 3 perguntas de uma linha (pedido, não garantia).

## Fluxo

```
/inbox
  3 itens aguardando você

  #2 Template genérico inicial · perguntas do planejamento
  1/2 Quais cômodos aparecem na casa?
      sugestão: Sala, Cozinha, Quarto, Banheiro
      [enter aceita · texto responde · d decide você · p pula o item]
  ...
  #4 Pagamento · aprovação de item crítico
      motivo: escopo `src/pagamento/**` toca o caminho crítico `src/pagamento/**`
      critérios: C1 …, C2 …
      [a aprova · texto ajusta os critérios · c cancela · p pula]

  Respostas registradas em 2 itens · 1 pulado.
  Retomar a esteira agora? [S/n]
```

- Itens em ordem de número. Item pulado continua em `needs_human`.
- Ctrl+C sai sem gravar o item em andamento; os itens já concluídos ficam gravados.
- Fora do TTY, `mabel inbox` só lista as pendências (o mesmo conteúdo de `mabel item`) e
  sai com código 0.

## Opções por motivo

| `pending_kind` | Mostra | Opções |
|---|---|---|
| `question_plan` | Perguntas com sugestão | Enter, texto, `d`, `p` por pergunta |
| `question_execute` | Perguntas com sugestão e suposições críticas | Enter, texto, `d`, `p`; ao final do item, `r` para replanejar com as respostas |
| `plan_incomplete` | Motivo da reprovação | Texto (orientação), `c`, `p` |
| `critical_approval` | Motivos e critérios do plano | `a` aprova, texto ajusta, `c`, `p`. Sem `d`. |
| `attempts_exhausted` | Resumo das tentativas | Texto (novo ciclo), `r` + texto (replanejar), `c`, `p` |

"Decide você" entra na resposta como `R: decida e registre como suposição.` O prompt das
etapas trata essa frase como delegação explícita.

## Critérios de aceite

1. `/inbox` percorre todos os itens em `needs_human`, na ordem, com as opções da tabela.
2. Respostas de um item viram uma única chamada a `respond`, com o texto `P/R`; a
   transição grava `humano: inbox …`.
3. `d` não aparece em `critical_approval`.
4. Ao final, `[S/n]` com S inicia a fila como `/run`; n volta ao prompt.
5. `/run` que termina com itens em `needs_human` num TTY oferece abrir a inbox.
6. Esquema novo validado com o `claude` falso; pendência antiga em string continua legível.
7. Testes num pseudo-terminal ou com entrada simulada cobrindo enter, texto, `d`, `p` e
   Ctrl+C.
