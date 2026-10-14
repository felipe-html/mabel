# Especificação — Gestão de projetos no banco

O banco (`~/.mabel/mabel.db`) só era visível pelo `sqlite3`. Faltava acompanhar a
auditoria por projeto e remover um projeto de teste sem editar o banco à mão. Tudo pelo
terminal, como o resto do Mabel.

Muda o contrato: a linha do banco em "Backlog e quadro" passa a prever a remoção feita
pelo humano (autorizado pelo usuário).

Termina com `npm run check` verde, critérios atendidos, `docs/PLANO.md` atualizado e um
commit.

## Decisões

| Tema | Decisão |
|---|---|
| Interface | Comandos no terminal (`mabel` e modo Mabel), com menu num TTY. Sem página web. |
| Remover | Apaga de verdade e grava um registro mínimo em `removals`. Não há arquivamento. |
| Alcance | Só os dados do Mabel: banco e `~/.mabel`. O repositório do projeto (`.mabel/`, branches `mabel/*`) fica intocado; o Mabel mostra os comandos git para quem quiser limpar. |
| Runs sem item | `exec` e probe não pertencem a projeto: ficam fora da auditoria do projeto e da remoção. O `cwd` não é usado para atribuir. |
| Ordem | Depois do 2.3 (`mabel runs`), antes do passo 5. |

## Comandos

### `mabel projetos`

Tabela com nome, raiz, itens por estado, runs, custo e última atividade. Num TTY, abre o
menu e o projeto escolhido mostra o detalhe de `mabel projeto`.

### `mabel projeto <nome>`

Auditoria do projeto. `<nome>` aceita o nome ou um prefixo único do id; nome repetido
lista os candidatos e encerra com erro.

- Totais: runs, custo, tokens (entrada, saída, cache).
- Custo e runs por etapa e por modelo.
- Itens: número, título, estado, tentativas, custo.
- Gates reprovados, escalonamentos de modelo e decisões autônomas (`(autônomo)`).
- Pausas da fila e decisões de saldo (últimas 20, tabela `queue_events`): pausas, esperas
  que retomam sozinhas e respostas do humano às perguntas da política de saldo.
- Últimas 20 transições de estado.

### `mabel projeto remover <nome>`

```
mabel projeto remover ferias-planner
  ferias-planner · /Users/felipe/Pessoal/ferias-planner
  3 itens · 18 runs · US$ 4,65
  banco: items, item_transitions, gate_results, runs, events, tool_calls, rate_limits, queue_events
  disco: runs/ (18), items/ (3), worktrees/c70d928b…, locks/

  Digite o nome do projeto para confirmar: ferias-planner
  Projeto removido. Registro em removals.

  O repositório não foi alterado. Para limpar também:
    git -C /Users/felipe/Pessoal/ferias-planner worktree prune
    git -C /Users/felipe/Pessoal/ferias-planner branch --list 'mabel/*'
```

Com a branch de integração (`docs/specs/prova-e-integracao.md`, P.4), o resumo avisa
quantos itens integrados ainda não chegaram à base: o trabalho deles só existe na branch
de integração, que a remoção não toca. O worktree temporário `_integracao` fica dentro de
`worktrees/<projectId>` e entra na remoção e na checagem de alterações sem commit.

- Recusa se houver run `running` de um item do projeto ou trava ativa do projeto.
- Recusa se algum worktree em `worktrees/<projectId>` (dos itens ou o `_integracao`) tiver
  alterações sem commit, listando-os.
- Fora do TTY, exige `--confirmar <nome>`; sem ele, só mostra o resumo e sai com erro.
- O banco é apagado numa transação; os diretórios, depois do commit. Falha ao apagar um
  diretório é avisada e não desfaz o banco (o que sobrar em disco é órfão inofensivo).
- Remover `rate_limits` das runs do projeto reduz a amostra das estimativas de consumo
  por etapa (`docs/specs/saldo.md`). Aceito: o projeto de teste é justamente o que não
  deve calibrar nada.

## Tabela `removals`

```sql
CREATE TABLE removals (
  id          INTEGER PRIMARY KEY,
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  root        TEXT NOT NULL,
  items       INTEGER NOT NULL,
  runs        INTEGER NOT NULL,
  cost_usd    REAL NOT NULL,
  removed_at  TEXT NOT NULL
);
```

Sem chave estrangeira: o projeto já não existe. `mabel projetos --removidos` lista essa
tabela.

## Critério de remoção para tabelas novas

Toda tabela do banco é classificada num só lugar, `src/projects.ts`
(`tableScope`), como:

- `project`: tem dados de um projeto (direta ou indiretamente, por item ou run) e é
  apagada na remoção, com a consulta que encontra as linhas do projeto;
- `global`: não pertence a projeto (ex.: `removals`, runs sem item) e fica.

Um teste compara as tabelas de `sqlite_master` com essa classificação e falha se
alguma tabela não estiver nela. Quem criar tabela nova numa migração precisa decidir ali
se ela entra na remoção. O mesmo vale para diretórios novos em `~/.mabel` (`dirScope`).

## Critérios de aceite

- [ ] `mabel projetos` e `mabel projeto <nome>` com saída em texto simples fora do TTY,
      estável para testes.
- [ ] Remoção apaga todas as linhas do projeto nas tabelas `project` e preserva as
      runs sem item e as de outros projetos (teste com dois projetos e uma run de `exec`).
- [ ] Remoção recusada com run em andamento, trava ativa ou worktree sujo.
- [ ] Remoção grava a linha em `removals` e apaga `runs/<id>`, `items/<id>`,
      `worktrees/<projectId>` e `locks/<projectId>.lock`.
- [ ] Teste de classificação falha com uma tabela não classificada.
- [ ] Comandos `/projetos` e `/projeto` no modo Mabel, com autocompletar.

## Fora desta spec

Edição de dados pelo terminal, exportação, retenção automática de dados antigos e
remoção de runs avulsas.
