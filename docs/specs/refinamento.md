# Especificação — Refinamento de demandas

Pergunta do usuário: como garantir que a demanda chegue ao time de agentes com detalhe
suficiente, e quanto detalhe escrever no backlog?

Hoje o `backlog → ready` só confere título, intenção e dependências; o planejamento faz o
refinamento sem querer (propõe critérios, pergunta, supõe), tarde, quando o item já está
na fila; e as respostas da inbox ficam no banco e no `plano.json`, nunca voltam ao
`backlog.md`, que é a fonte da verdade do conteúdo.

Regra que orienta o resto: **escreva o que só você sabe e o que, se o agente errasse, faria
você reclamar.** Um item bom responde a quatro perguntas: para quê (intenção), o que muda
visto de fora (critérios), que decisões de negócio já estão tomadas (decisões) e o que fica
de fora (fora do escopo). O detalhe acompanha o risco: um ajuste visual vive com título e
intenção; um item que toca regra de negócio pede as quatro.

Não muda o contrato. O refinamento é um comando avulso, fora do ciclo de vida do item; a
run dele é auditada (G1), hermética (G8) e passa pela política de saldo (G6). O gate novo
do `ready` só fica mais exigente.

## Decisões do usuário (2026-10-21)

| Tema | Decisão |
|---|---|
| Forma | Comando avulso `mabel refinar`, sem estado novo no ciclo de vida. |
| Gravação | O agente propõe; o Mabel espera a revisão do humano e só então grava no `backlog.md`. |
| Fora do escopo | Vira campo do backlog; o planejador, o executor e o revisor o recebem. |
| Item mínimo | O planejamento continua propondo critérios para item sem regra crítica. Item com regra crítica declarada só fica `ready` com critérios no backlog. |
| Medição | Perguntas, suposições e replanejamentos por item, separados entre itens refinados e não refinados. |

## Campos novos do backlog

| Campo | Formato | Para quê |
|---|---|---|
| `Fora do escopo:` | lista `- …` (ou texto na mesma linha, uma entrada) | O que o item não faz. Segura o escopo do plano. |
| `Decisões:` | lista `- …` | Regras de negócio já decididas. As respostas do refinamento entram aqui como `pergunta → resposta`. |
| `Regras críticas:` | lista `- …` | Conceitos de `.mabel/regras-criticas.md` que o item toca. |

Ordem gravada pelo Mabel: intenção, critérios, fora do escopo, decisões, regras críticas,
depende de, restrições. O parser aceita qualquer ordem.

O hash de conteúdo só inclui os campos novos quando algum deles tem valor: o backlog que
não os usa mantém o hash e nenhum item iniciado recebe o aviso de "mudou depois de iniciado".

## Gate do `ready`

Item com `Regras críticas:` e sem critérios fica em `backlog` com o motivo "regra crítica
sem critérios: escreva os critérios ou rode `mabel refinar <n>`". É garantia sobre o campo
declarado; a classificação do item como crítico é do humano (ou da proposta que ele aceitou).

No planejamento, os conceitos declarados se somam aos `conceitosCriticos` do plano em
`criticalReasons`: item declarado crítico sempre passa pela aprovação humana (G2).

## Comando `refinar`

```
mabel refinar [<n>] [--refazer] [--aceitar | --descartar]
```

Só itens que ainda não entraram em planejamento (`backlog` ou `ready`, nunca iniciados).

| Forma | TTY | Fora de TTY |
|---|---|---|
| `refinar` | Menu de seleção com os itens refináveis e a situação de cada um; o escolhido abre a revisão; ao terminar, o menu volta. `q` sai. | Tabela dos itens refináveis com a situação. |
| `refinar <n>` | Usa a proposta pendente (ou roda o agente, se não há proposta válida) e abre a revisão. | Mostra a proposta (rodando o agente se preciso) e diz como aceitar. |
| `--refazer` | Descarta a proposta pendente e roda o agente de novo. | Igual. |
| `--aceitar` | — | Grava a proposta inteira: perguntas com sugestão viram decisões, as sem sugestão ficam de fora (com aviso). |
| `--descartar` | Descarta a proposta pendente sem gravar. | Igual. |

Situação de um item: `não refinado`, `proposta pendente`, `proposta desatualizada` (o item
mudou no backlog depois da proposta), `refinado` (proposta aceita) ou `descartado`.

### Run de refinamento

- Etapa `refine` no runner: ferramentas `Read`, `Glob`, `Grep`; cwd na raiz do projeto;
  mesmas travas das outras etapas (flags herméticas, sandbox, hook de escopo, conferência
  do `init`, orçamento de contexto).
- Modelo padrão `sonnet`, limites de 30 turnos e US$ 1, configuráveis em
  `models.refine` e `limits.refine`.
- Prompt de sistema `prompts/refinar.md`; prompt da run com o item inteiro e as regras
  críticas do projeto.
- Saída estruturada:

```ts
interface RefineOutput {
  entendimento: string;          // o que o agente entendeu, em 2 a 4 frases
  criterios: string[];           // só os que faltam; não repete os do backlog
  foraDoEscopo: string[];
  perguntas: Question[];         // regra de negócio; no máximo 5, com sugestão
  conceitosCriticos: string[];   // copiados de regras-criticas.md
  quebra: { titulo: string; intencao: string }[]; // vazio se o item cabe num só
}
```

- Saldo: antes da run, a política do contrato numa versão de uma chamada só. Sem leitura
  ou leitura velha, faz a chamada mínima. Abaixo do piso ou acima do ritmo: no TTY
  pergunta se continua; fora dele, recusa. Não espera reset (o comando é interativo).
- A proposta fica em `items/<id>/refinamento-<k>.json` e na tabela `refinements`
  (item, run, hash do item na proposta, proposta, situação, decisão, horários). Tabela
  classificada como `project` para a remoção.

### Revisão (TTY)

```
#3 Exportar pedidos em CSV · proposta de refinamento

Entendimento
  …

Perguntas
  1/2 Pedidos cancelados entram na exportação?
      sugestão: não
      › enter aceita a sugestão · texto responde · p deixa para o planejamento

Critérios propostos
  1. Uma linha por pedido, com data, cliente e valor
  2. Arquivo vazio tem só o cabeçalho
  › enter aceita · e edita um a um · - descarta

(o mesmo para fora do escopo e regras críticas)

Quebra sugerida (não é aplicada; crie os itens com /add se concordar)
  - Exportar pedidos filtrados por data: …

Como fica o item
  <bloco do backlog>

Gravar no backlog? [S/n/d]   (n deixa a proposta pendente · d descarta)
```

- Edição um a um: enter mantém, `-` remove, texto substitui; depois aceita entradas
  novas até uma linha vazia.
- Resposta a pergunta vira `Decisões: - <pergunta> → <resposta>`. `p` não grava nada:
  a dúvida fica para o planejamento.
- Ctrl+C deixa a proposta pendente.
- Proposta sem nada a acrescentar: "Nada a acrescentar" e o item fica `refinado`.
- Gravação: relê o `backlog.md`, confere que o item continua não iniciado, acrescenta aos
  campos o que foi aceito (sem repetir entradas iguais), regrava só o trecho do item e
  sincroniza. Comentários HTML no meio do bloco do item se perdem; os de fora ficam.

### `add`

- Opção nova `--fora-do-escopo <texto>`, repetível; no TTY, pergunta "Fora do escopo".
- No TTY, depois de gravar: `Refinar o item agora? [s/N]`.

## Medição

Por item, calculado das runs auditadas:

- **Perguntas**: soma das `perguntas` da saída estruturada de todas as runs de
  planejamento e execução (a saída bruta, antes da autonomia).
- **Suposições**: as da última run de planejamento mais as da última de execução (as
  runs retomadas repetem o plano inteiro; somar contaria duas vezes).
- **Replanejamentos**: entradas em `planning` além da primeira.

`mabel item <n>` mostra a linha "Refinamento" (situação, perguntas, suposições,
replanejamentos). `mabel projeto <nome>` ganha as colunas `perg.` e `sup.` na tabela de
itens e o bloco "Refinamento" com a média de perguntas, suposições e replanejamentos dos
itens planejados refinados e não refinados.

## Critérios de aceite

1. O parser lê e o `renderItemBlock` grava `Fora do escopo`, `Decisões` e `Regras
   críticas`; backlog sem os campos mantém o hash de antes.
2. Item com `Regras críticas` e sem critérios fica em `backlog` com o motivo; com
   critérios, vai a `ready`.
3. Conceito declarado no backlog leva o plano à aprovação humana mesmo com
   `conceitosCriticos` vazio.
4. O prompt do planejamento traz fora do escopo, decisões e regras críticas declaradas;
   o da execução e o da revisão trazem fora do escopo.
5. `refinar <n>` roda a etapa `refine` (auditada, hermética, só leitura) e grava a
   proposta; a segunda chamada reusa a proposta sem nova run; `--refazer` roda de novo.
6. A revisão aceita, edita e descarta entradas; respostas viram decisões; a gravação
   altera só o bloco do item e sincroniza.
7. `--aceitar` e `--descartar` funcionam fora do TTY; item iniciado é recusado.
8. `refinar` sem argumentos lista os itens refináveis com a situação.
9. `mabel item` e `mabel projeto` mostram os sinais de refinamento.

## Fora desta entrega (vai para o `BACKLOG.md`)

- Aplicar a quebra sugerida (criar os itens novos e ajustar o original).
- Reescrita da intenção pelo agente.
- Respostas da inbox gravadas de volta no `backlog.md` (caminho B da discussão).
- Aviso no `run` sobre itens `ready` nunca refinados.
- Template do backlog orientado ao risco a partir das métricas.
- `add` com `--decisao` e `--regra-critica`.
- Refinar em lote (`--todos`).
- Preservar comentários HTML no meio do bloco do item.
