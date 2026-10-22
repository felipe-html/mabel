# Especificação — Entrega da integração (`mabel entregar`)

Com a branch de integração (`docs/specs/prova-e-integracao.md`, P.4), o fim do dia é
sempre o mesmo: ler o `.mabel/integracao.md`, publicar a branch, abrir o PR com o
relatório, copiar o texto e voltar o checkout para a base. `mabel entregar` faz esses
passos. O merge na branch principal continua com o humano (G10).

Revê a D6 da prova e integração ("o Mabel não ganha comando para isso"), a pedido do
usuário.

Termina com `npm run check` verde, critérios atendidos, `docs/PLANO.md` atualizado e um
commit.

## Decisões

| # | Tema | Decisão |
|---|---|---|
| E1 | O que é entregue | Um **snapshot** da integração: a branch `mabel/entrega/<AAAA-MM-DD>` (sufixo `-2`, `-3` se já existir) criada no commit atual da integração. O PR é dela, não da `mabel/integracao`: o `run` pode seguir integrando sem mudar o que está em revisão. |
| E2 | Commit | Nenhum. Cada item já entra na integração por um commit de merge do Mabel, e o relatório não é versionado (D10). O "o que foi feito" vai no corpo do PR. |
| E3 | Merge do PR | Só merge commit. Squash e rebase tiram os `integrated_commit` da história da base, e os itens nunca chegam a `done`. O comando recusa abrir o PR num repositório que não permite merge commit, e o corpo do PR avisa. |
| E4 | Checkout | Troca para a base só o checkout da raiz do projeto, só se ele estiver na integração ou numa entrega, e só se não houver alteração em arquivo versionado. Fora disso, não mexe e diz por quê. |
| E5 | `gh` | Usado se estiver instalado e autenticado e o remoto for do GitHub. Sem ele: publica a branch (se houver remoto), mostra a URL de comparação e o arquivo do corpo do PR. Sem remoto: só cria o snapshot e mostra o `git merge --no-ff`. |
| E6 | Entrega aberta | Uma por projeto. Com uma aberta, o comando mostra o PR e sai; `--substituir` fecha o PR anterior e abre outro com a integração atual. |

## Comando

```
mabel entregar [--substituir] [--rascunho]
```

Disponível no modo Mabel (`/entregar`), no menu e no autocompletar.

```
mabel entregar
  Entrega mabel/entrega/2026-10-22 · 4 itens desde a main
    #3 Login com e-mail · #5 Exportar CSV · #7 Filtro por data · #9 Desconto progressivo
  Olhe primeiro: 2 (no corpo do PR)
  branch publicada em origin
  PR aberto: https://github.com/felipe/app/pull/42
  checkout da raiz: mabel/integracao → main

  Faça o merge com "Create a merge commit". Depois, na main: git pull
```

### Passos

1. Projeto com `integracao` ligada; sem ela, erro explicando que cada item fica na própria
   branch.
2. Snapshot: `rev-parse` da integração uma vez; tudo daqui em diante usa esse commit, não a
   branch (um `run` em andamento pode integrar outro item no meio). Não precisa da trava do
   projeto.
3. Itens: os de `integratedItems` calculados contra o snapshot (`<base>..<snapshot>`). Lista
   vazia → `Nada a entregar: a <integracao> não tem itens fora da <base>.` e sai sem criar
   nada.
4. Entrega aberta (E6): mostra branch, itens e PR e sai com erro. Com `--substituir`, fecha
   o PR anterior (`gh pr close --comment "Substituído por <url nova>"`, depois de abrir o
   novo) e marca a entrega como `replaced`. Se o snapshot for igual ao da entrega aberta,
   não substitui: `A entrega aberta já tem tudo o que está na integração.`
5. Remoto: o da base (`<base>@{upstream}`); sem upstream, `origin`; sem nenhum, segue sem
   remoto (E5).
6. Com `gh` e remoto do GitHub, antes de criar qualquer coisa:
   `gh repo view --json mergeCommitAllowed`. Falso → recusa (E3) com o caminho para ligar
   (Settings › General › Pull Requests › "Allow merge commits").
7. Cria `refs/heads/mabel/entrega/<data>` no snapshot (`update-ref` com o valor antigo
   vazio, para não sobrescrever).
8. Publica: `git push -u <remoto> mabel/entrega/<data>`. Falha → a branch local fica, a
   entrega é gravada sem PR e o erro do git aparece; rodar de novo retoma do passo 8 com a
   mesma entrega.
9. Corpo do PR: `<dados>/entregas/<projeto>/<entrega>.md` (fora do repositório), gerado pelo
   mesmo `renderIntegrationReport` do P.5, calculado contra o snapshot, com estas trocas:
   - no lugar de `Para levar à <base>: git merge --no-ff …`, o aviso
     `Faça o merge com "Create a merge commit": squash e rebase impedem o Mabel de dar os itens como concluídos.`;
   - acima de 60.000 caracteres (o limite do GitHub é 65.536), as seções dos itens são
     cortadas do fim para o começo, com `… <n> itens sem detalhe aqui; rode mabel integracao.`
     O "Olhe primeiro" nunca é cortado.
10. PR: `gh pr create --base <base> --head mabel/entrega/<data> --title "<título>" --body-file <arquivo>`
    (`--draft` com `--rascunho`). Título: `Mabel: <n> itens (#3, #5, #7, #9)`, com os
    números cortados em `…` acima de 70 caracteres.
11. Sem `gh` (E5): mostra `https://github.com/<dono>/<repo>/compare/<base>...<branch>?expand=1`
    quando o remoto é do GitHub e o caminho do arquivo do corpo, para copiar. Remoto que
    não é do GitHub: só o caminho do arquivo.
12. Checkout (E4), na raiz do projeto:
    - HEAD na integração ou numa `mabel/entrega/*` e `git status --porcelain --untracked-files=no`
      vazio → `git switch <base>`;
    - alteração versionada → `Checkout da raiz em <branch> com alterações; não troquei para a <base>.`;
    - outra branch → nada, sem mensagem;
    - integração aberta em outro worktree (`checkedOutAt`) → aviso com o caminho, sem mexer.
    `git switch` que falha (arquivo não versionado que seria sobrescrito) → mostra o erro
    do git; a entrega já está feita.
13. Grava a entrega (tabela abaixo) e mostra o resumo.

`--substituir` e a primeira entrega seguem os mesmos passos; o que muda é o 4.

## Depois do merge

Na abertura do `run`, depois do `openIntegration` e antes do `finishIntegrated`:

1. Entrega `open` cujo commit está contido na base local → `merged`; a branch local da
   entrega é apagada (já está na base). A branch remota fica: o GitHub pode apagá-la
   sozinho, e o Mabel não apaga nada no remoto.
2. Entrega `open` com remoto e fora da base local: `git fetch -q <remoto> <base>` (falha é
   ignorada). Se o commit da entrega estiver no `<remoto>/<base>` e não na base local →
   nota `O PR da entrega foi integrado no <remoto>; atualize a <base> local (git pull) para os itens irem a done.`
   O Mabel não atualiza a base local.
3. Entrega `open` sem o commit nem na base local nem na remota, mas com o PR `MERGED`
   (`gh pr view <url> --json state`, só com `gh`) → foi squash ou rebase. Nota com o que
   aconteceu e o conserto: `git merge --no-ff mabel/entrega/<data>` na base (traz os commits
   do Mabel para a história; o conteúdo já está lá). A entrega continua `open`.

O passo 3 é o único que chama o `gh` no `run`, e só quando há entrega aberta e fora da base.

## Rejeição com entrega aberta

`mabel rejeitar <n>` de um item que está numa entrega `open` funciona como hoje (reverte na
integração) e avisa: `O #<n> está na entrega aberta (<url>). Rode mabel entregar --substituir para tirá-lo do PR.`
O Mabel não mexe no PR sozinho.

## Relatório

O `.mabel/integracao.md` e o `mabel integracao` ganham, abaixo do `git merge --no-ff`,
`ou: mabel entregar`, e, com entrega aberta, `Entrega aberta: <branch> · <url ou "sem PR">`.

## Banco

```sql
CREATE TABLE deliveries (
  id          INTEGER PRIMARY KEY,
  project_id  TEXT NOT NULL,
  branch      TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  items       TEXT NOT NULL,   -- JSON: números dos itens, na ordem de integração
  remote      TEXT,            -- nulo sem remoto
  pr_url      TEXT,            -- nulo sem gh ou com push que falhou
  status      TEXT NOT NULL,   -- open | merged | replaced
  created_at  TEXT NOT NULL,
  closed_at   TEXT
);
```

Classificada como `project` em `src/projects.ts` (sai com o projeto). O diretório
`<dados>/entregas/<projeto>` também entra na remoção. `mabel projeto <nome>` lista as
entregas (branch, itens, PR, estado).

## Contrato

Autorizado pelo usuário em 2026-10-22.

- **Decisões do humano**: "Fazer merge na branch principal" passa a "Pedir a entrega
  (`mabel entregar`) e fazer o merge na branch principal".
- G10 fica igual: o PR não é merge, e o Mabel não faz merge nem push na base.
- Primeira escrita do Mabel num remoto: só branches `mabel/entrega/*` e só quando o humano
  pede. O agente continua sem git de escrita (G4).

## Critérios de aceite

Com um remoto local (`git init --bare`) e um `gh` falso no `PATH`, como o `claude` falso:

1. Três itens integrados: `mabel entregar` cria `mabel/entrega/<data>` no commit da
   integração, publica, chama `gh pr create` com o corpo do relatório e grava a entrega.
2. Item integrado durante a entrega (integração anda entre o snapshot e o push): o PR e a
   entrega têm só os itens do snapshot.
3. Repositório sem merge commit: recusa antes de criar a branch.
4. Sem `gh`: publica e mostra a URL de comparação e o arquivo; sem remoto: só a branch e o
   `git merge --no-ff`.
5. Entrega aberta: sem flag, mostra e sai com erro; `--substituir` abre o novo PR e fecha
   o anterior.
6. Checkout da raiz na integração e limpo → base; com alteração versionada → fica, com o
   aviso; em outra branch → fica, sem aviso.
7. Merge da entrega na base: o próximo `run` marca `merged`, apaga a branch local e leva os
   itens a `done`.
8. PR integrado só no remoto: o `run` avisa para atualizar a base local.
9. PR com squash (`gh` falso responde `MERGED`, commit fora da base): o `run` explica e
   mostra o conserto; a entrega segue `open`.
10. `rejeitar` de item numa entrega aberta avisa sobre o `--substituir`.
11. Remoção do projeto apaga `deliveries` e `<dados>/entregas/<projeto>`.
