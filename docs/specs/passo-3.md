# Especificação — Passo 3: projeto, backlog, fila e quadro

Pré-requisito: incremento 2.2 concluído (`checkBalance` e leitura de saldo). Leia
`docs/CONTRATO.md` (ciclo de vida do item, "Backlog e quadro", "Projeto sem testes",
"Regras críticas") antes desta especificação.

Entrega: o Mabel conhece o projeto-alvo, gera e lê o backlog, mantém o estado de cada item
com auditoria das transições e gera o quadro. **Nenhum agente é executado neste passo.**

Incrementos, cada um com `npm run check` verde, critérios atendidos, `docs/PLANO.md`
atualizado e commit:

- 3.1 Projeto e `mabel init`
- 3.2 Backlog: formato, parser, sincronização e `mabel add`
- 3.3 Máquina de estados e quadro

## Decisão de formato

O arquivo de regras críticas é **Markdown** (`regras-criticas.md`), para manter zero
dependências de runtime. O contrato foi atualizado com autorização do usuário em
2026-10-11. A configuração do projeto é JSON.

## Incremento 3.1 — Projeto e `mabel init`

### Projeto

- O projeto-alvo é a raiz do repositório git que contém o diretório atual
  (`git rev-parse --show-toplevel`). Todo comando que depende de projeto resolve a raiz
  assim; fora de um repositório git, encerra com erro e dica de `git init`.
- Um projeto só é reconhecido se tiver `.mabel/config.json`.

```sql
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,                 -- UUID
  root       TEXT NOT NULL UNIQUE,             -- caminho real (realpath) da raiz
  name       TEXT NOT NULL,                    -- nome do diretório
  created_at TEXT NOT NULL
);
```

O `id` do projeto é gravado em `.mabel/config.json`; se o repositório mudar de lugar, o
Mabel atualiza `root` pelo `id`.

### Arquivos criados no projeto-alvo

```
.mabel/
  config.json          versionado
  backlog.md           versionado
  regras-criticas.md   versionado
  .gitignore           versionado, contém "quadro.md"
  quadro.md            gerado, ignorado pelo git
```

`.mabel/config.json`:

```json
{
  "projectId": "<uuid>",
  "baseBranch": "main",
  "setup": "npm ci",
  "verify": [
    { "name": "typecheck", "command": "npm run typecheck" },
    { "name": "test", "command": "npm test" }
  ],
  "models": { "plan": "opus", "execute": "sonnet", "review": "opus" },
  "limits": {
    "plan":    { "maxTurns": 40,  "maxBudgetUsd": 3 },
    "execute": { "maxTurns": 120, "maxBudgetUsd": 8 },
    "review":  { "maxTurns": 40,  "maxBudgetUsd": 3 }
  }
}
```

- `setup`: comando rodado uma vez em cada worktree novo (passo 4). Pode ser `null`.
- `verify`: gates mecânicos, executados em ordem pelo passo 4. Lista vazia é permitida,
  mas o `init` avisa que o G3 fica sem gate mecânico.
- `models` e `limits`: usados pelo passo 4. Valores padrão como acima.

`.mabel/regras-criticas.md`:

```markdown
# Regras críticas

Itens que tocam estas regras exigem sua aprovação dos critérios de aceite.

## Caminhos

<!-- Um glob por linha, relativo à raiz. Ex.: - src/billing/** -->

## Conceitos

<!-- Uma regra de negócio por linha, em linguagem natural. -->
```

Parser: itens de lista (`- `) sob cada seção; comentários HTML e linhas vazias ignorados.
Sem itens nas duas seções, nada é crítico.

### Comportamento do `mabel init`

1. Exige repositório git. Se o repositório não tiver nenhum commit, informa que o primeiro
   commit é necessário para os worktrees e, no TTY, oferece criá-lo com os arquivos do
   `.mabel/`.
2. Se `.mabel/config.json` já existir, não sobrescreve nada: mostra o estado e sai com 0.
3. **Detecção de comandos** (somente leitura):
   - `package.json`: scripts `build`, `typecheck`, `lint`, `test`, nessa ordem, como
     `npm run <script>` (`npm test` para `test`). Lockfile define o `setup`:
     `package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`,
     `yarn.lock` → `yarn install --frozen-lockfile`.
   - `pyproject.toml` ou `pytest.ini` → `pytest`; `Cargo.toml` → `cargo build`,
     `cargo test`; `go.mod` → `go build ./...`, `go test ./...`; `Makefile` com alvo
     `test` → `make test`.
4. No TTY, mostra o que detectou e permite confirmar ou editar cada comando antes de gravar.
   Fora do TTY, grava o detectado.
5. Detecta a **branch base**: a branch atual.
6. **Projeto sem testes** (nenhum comando de teste detectado): cria no backlog o item
   "Estabelecer base de testes" como primeiro item. Se o projeto não tiver código (só
   arquivos do `.mabel/` e de configuração), no TTY pergunta a stack desejada e grava a
   resposta na intenção do item; sem resposta, a intenção registra `Stack: a definir`
   (o planejador do passo 4 vai tratá-la como pergunta).
7. Registra o projeto no banco e gera o `quadro.md`.

### Critérios de aceite

- [x] `init` fora de repositório git falha com dica; em repositório sem commits, oferece o commit inicial.
- [x] `init` repetido não altera arquivos.
- [x] Detecção coberta por teste para `package.json` (com e sem lockfile), `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile` e projeto vazio.
- [x] Projeto sem testes recebe o item "Estabelecer base de testes" em primeiro.
- [x] `quadro.md` fica ignorado pelo git (`git check-ignore`).

## Incremento 3.2 — Backlog

### Formato do `backlog.md`

```markdown
# Backlog

<!-- Instruções geradas pelo mabel init (ver abaixo). -->

## Exportar pedidos em CSV
id: 3
Quero baixar a lista de pedidos para abrir no Excel.

Critérios:
- Uma linha por pedido, com data, cliente e valor
- Valores com vírgula decimal

Depende de: 2
Restrições: não adicionar bibliotecas novas
```

Regras do parser:

- Cada `## ` inicia um item; o texto do cabeçalho é o **título**.
- `id: <n>` — número inteiro, único no projeto, atribuído pelo Mabel.
- `Critérios:` seguido de itens de lista — critérios de aceite. Opcional.
- `Depende de: <n>[, <n>...]` — ids de outros itens. Opcional.
- `Restrições: <texto>` — opcional, uma linha.
- O resto do texto (fora das chaves acima e de comentários HTML) é a **intenção**.
- A **ordem no arquivo é a prioridade**.
- Erros de formato (id duplicado, dependência para id inexistente, dependência circular,
  item sem título) não derrubam o comando: o item fica `blocked` com o motivo, e o resto
  do backlog segue.

### Geração

- `mabel init` cria o `backlog.md` com um comentário HTML no topo explicando o formato
  (campos, o que é obrigatório, a ordem como prioridade) e os três níveis de detalhe
  (mínimo: título e intenção; recomendado: com critérios; completo: com dependências e
  restrições).
- `mabel add` acrescenta itens ao fim do arquivo, já com `id`:

  ```
  mabel add "<título>" [--intencao <texto>] [--criterio <texto>]... [--depende <n>]...
                       [--restricoes <texto>]
  ```

  No TTY, sem argumentos ou só com o título, pergunta em sequência: título, intenção,
  critérios (um por linha, linha vazia encerra), dependências, restrições. Só título e
  intenção são obrigatórios.

### Sincronização

`syncBacklog(project)` lê o arquivo e reconcilia com o banco. É chamada por `status`,
`add` e (no passo 4) por `run`.

- Item sem `id` no arquivo: recebe o próximo número livre, e o Mabel reescreve só a linha
  `id:` logo abaixo do cabeçalho daquele item, preservando o resto do arquivo byte a byte.
- Item novo → estado `backlog`.
- Conteúdo do item (título, intenção, critérios, dependências, restrições) é guardado com
  um hash. Mudança de conteúdo em item ainda não iniciado atualiza o banco; em item já
  iniciado, é ignorada e gera aviso (o item segue com o conteúdo do início do planejamento).
- Item removido do arquivo: se não iniciado, vai para `cancelled`; se iniciado, permanece
  e gera aviso.
- `backlog → ready` quando o item tem título e intenção e todas as dependências estão
  `done`.

```sql
CREATE TABLE items (
  id             TEXT PRIMARY KEY,             -- UUID
  project_id     TEXT NOT NULL REFERENCES projects(id),
  number         INTEGER NOT NULL,             -- o `id:` do arquivo
  position       INTEGER NOT NULL,             -- ordem no arquivo
  title          TEXT NOT NULL,
  intent         TEXT NOT NULL,
  criteria       TEXT NOT NULL,                -- JSON: string[]
  depends_on     TEXT NOT NULL,                -- JSON: number[]
  restrictions   TEXT,
  content_hash   TEXT NOT NULL,
  status         TEXT NOT NULL,
  status_reason  TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,   -- usado no passo 4
  branch         TEXT,                         -- usado no passo 4
  worktree       TEXT,                         -- usado no passo 4
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (project_id, number)
);
```

### Critérios de aceite

- [ ] Parser coberto por teste: item mínimo, recomendado, completo; comentários; ordem; cada erro de formato.
- [ ] Atribuição de `id` não altera nenhum outro byte do arquivo.
- [ ] `add` não interativo gera um bloco que o parser lê de volta com os mesmos campos.
- [ ] Mudança de conteúdo antes e depois do início tem o efeito descrito.
- [ ] Remoção de item não iniciado leva a `cancelled`.

## Incremento 3.3 — Máquina de estados e quadro

### Estados e transições

Estados do contrato mais `cancelled`. Transições permitidas (qualquer outra lança erro):

| De | Para |
|---|---|
| `backlog` | `ready`, `blocked`, `cancelled` |
| `ready` | `planning`, `backlog`, `blocked`, `cancelled` |
| `planning` | `executing`, `needs_human`, `failed`, `blocked` |
| `executing` | `verifying`, `needs_human`, `failed`, `blocked` |
| `verifying` | `reviewing`, `executing`, `needs_human`, `failed` |
| `reviewing` | `awaiting_merge`, `executing`, `needs_human`, `failed` |
| `awaiting_merge` | `done`, `executing` |
| `needs_human` | `planning`, `executing`, `cancelled` |
| `blocked` | `backlog`, `cancelled` |
| `failed` | `ready`, `cancelled` |

`transition(item, to, reason, runId?)` grava a mudança e a auditoria na mesma transação e
regenera o quadro.

```sql
CREATE TABLE item_transitions (
  id         INTEGER PRIMARY KEY,
  item_id    TEXT NOT NULL REFERENCES items(id),
  from_state TEXT NOT NULL,
  to_state   TEXT NOT NULL,
  reason     TEXT,
  run_id     TEXT REFERENCES runs(id),
  at         TEXT NOT NULL
);
```

### Quadro

`.mabel/quadro.md`, regenerado inteiro a cada transição e a cada `syncBacklog`:

```markdown
<!-- Gerado pelo Mabel. Edições aqui são descartadas. -->
# Quadro · meu-app
Atualizado 11/10 14:32 · saldo 5h 78% · 7d 91%

## Aguardando você
- #4 Permissões por perfil — **needs_human**: <pergunta ou motivo>
- #2 Listagem de pedidos — **awaiting_merge** · branch `mabel/2-listagem-de-pedidos`

## Em andamento
- #3 Exportar pedidos em CSV — executing · tentativa 2 · US$ 1,84

## Na fila
- #5 Filtro por data — ready
- #6 Relatório mensal — backlog · depende de #5

## Bloqueados e falhos
- #7 Item sem título — blocked: <motivo>

## Concluídos
- #1 Estabelecer base de testes — done · US$ 3,10
```

- Custo de um item = soma de `cost_usd` das runs com aquele `item_id`.
- Seções vazias são omitidas.

### `mabel status`

Estende o do 2.2: cabeçalho de saldo, depois o resumo do quadro (contagem por seção e os
itens de "Aguardando você" e "Em andamento"), depois as runs recentes. Fora de um projeto
Mabel, mostra só saldo e runs.

### Critérios de aceite

- [ ] Toda transição da tabela é aceita; uma transição fora dela lança e não grava nada.
- [ ] Cada transição gera uma linha em `item_transitions` e regenera o quadro.
- [ ] Quadro gerado por função pura, coberto por teste de snapshot em texto.
- [ ] `init`, `add` e `status` disponíveis no menu interativo e no autocompletar.
