# Especificação — Referências de tela e de API

Pergunta do usuário: tarefas de front-end chegam com um frame do Figma, um Swagger público e
uma lista de funcionalidades. Como o item aponta para esses artefatos, onde eles ficam
quando várias tarefas os usam, e o que o Mabel precisa para isso?

As runs são herméticas (G8) e rodam em sandbox (G4): sem MCP, sem WebFetch, rede só para
os domínios da stack. O agente não abre o link do Figma nem o do Swagger. E, se abrisse,
o ambiente dev muda sem aviso: a run de hoje e a retentativa de amanhã veriam contratos
diferentes, e a auditoria não saberia o que o agente tinha na frente.

Por isso as referências são **cópias datadas e versionadas** no projeto, capturadas pelo
humano (ou pelo Mabel, fora da run), e o item as cita por nome. Não muda o contrato: as
referências são arquivos do projeto-alvo, e cada item lê uma cópia congelada no início do
planejamento, como o resto do conteúdo do item.

## Decisões do usuário (2026-10-22)

| Tema | Decisão |
|---|---|
| Lugar | `.mabel/referencias/`, junto ao backlog, versionado. |
| Snapshot mudou | Item não iniciado é tratado como alterado (o hash inclui os arquivos). Item iniciado segue com a cópia do início. |
| Rede na execução | O backend dev não entra em `rede`. Os testes usam dados do snapshot; teste contra o dev é validação humana. |
| Ordem | Campo `Referências:` e gate do `ready`; depois `mabel referencia api`; por último `mabel referencia tela` (Figma), num commit separado para desfazer fácil. |

## Arquivos

```
.mabel/referencias/
  api/<nome>.openapi.json     # OpenAPI 3 em JSON
  api/<nome>.md               # origem, data da captura, observações (opcional)
  telas/<nome>/               # qualquer arquivo: tela.png, estados/*.png, tela.md
```

`<nome>` usa letras minúsculas, dígitos e `-`.

## Campo do backlog

```
Referências:
- tela: cadastro-acesso
- api: wego-acessos POST /v1/acessos
- api: wego-acessos listarPerfis
- docs/regras-de-cpf.md
```

| Forma | Aponta para | Conferido no `ready` |
|---|---|---|
| `tela: <nome>` | `.mabel/referencias/telas/<nome>/` | diretório existe e tem ao menos um arquivo |
| `api: <nome> <MÉTODO> <caminho>` | operação do snapshot `api/<nome>.openapi.json` | snapshot existe, é JSON com `paths`, a operação existe |
| `api: <nome> <operationId>` | idem, pelo `operationId` | idem |
| `<caminho>` | arquivo em `.mabel/referencias/<caminho>` | arquivo existe, sem sair do diretório |

O caminho da operação é o do snapshot, literal (`/v1/acessos/{id}`). O método aceita
maiúsculas ou minúsculas.

Ordem gravada pelo Mabel: intenção, critérios, fora do escopo, decisões, regras críticas,
referências, depende de, restrições.

## Gate do `ready`

Item com referência que não confere fica em `backlog` com o motivo
`referência inválida: <entrada> (<problema>)`. Não é erro de formato (não vai a
`blocked`): o conserto é capturar o arquivo, e o item passa a `ready` no próximo sync.

## Hash

Com `Referências:` preenchido, o hash do item inclui as entradas e o hash de cada arquivo
que elas alcançam (o diretório inteiro da tela; o snapshot inteiro da API). Sem o campo,
o hash não muda. Atualizar um snapshot faz o item não iniciado ser relido; o iniciado
recebe o aviso de sempre ("mudou depois de iniciado; segue com o conteúdo do início").

## Cópia congelada do item

Na primeira vez que o item entra em `planning`, o Mabel copia as referências para
`items/<id>/referencias/`:

- `tela: <nome>` → `telas/<nome>/…` (o diretório inteiro).
- `api: …` → `api/<nome>.openapi.json` (o snapshot) e `api/<nome>--<MÉTODO>-<caminho>.json`
  com só a operação e os componentes que ela alcança por `$ref` (fechamento transitivo),
  para o agente não precisar ler o snapshot inteiro.
- `<caminho>` → o mesmo caminho.

Se a cópia já existe, fica como está: replanejamento, execução e revisão leem a cópia do
início. A cópia é do item, entra na remoção do projeto com o resto de `items/`.

## Nas runs

- Planejamento, execução e revisão: `--add-dir <items/<id>/referencias>`. O `--restricted`
  confina as ferramentas de arquivo aos diretórios de trabalho, `--add-dir` incluído; a
  escrita lá continua negada pelo hook de escopo (fora do worktree).
- O prompt ganha a seção "Referências" com cada entrada e os caminhos absolutos dos
  arquivos (imagens são lidas com `Read`), e a orientação: a tela é a referência visual,
  a operação é o contrato da API; os testes usam dados derivados do snapshot, sem chamar
  o backend.
- Refinamento: o cwd é a raiz do projeto; o prompt lista os caminhos em
  `.mabel/referencias/`, sem cópia.

## `mabel referencia`

```
mabel referencia                       lista as referências e os itens que as citam
mabel referencia api <nome> <url>      baixa o OpenAPI e grava o snapshot
mabel referencia tela <nome> <url-figma> [--escala <n>]   exporta o frame do Figma
mabel referencia tela <nome> --png <arquivo>              grava um PNG exportado à mão
```

### `api`

- `GET <url>`. A URL de um swagger-ui do Quarkus (`…/q/swagger-ui/`) vira
  `…/q/openapi?format=json`; outra URL é usada como está.
- A resposta precisa ser JSON com `openapi` (ou `swagger`) e `paths`; senão, erro com a
  dica de pedir a versão JSON.
- Grava `api/<nome>.openapi.json` formatado e `api/<nome>.md` com origem, data, título,
  versão e número de operações. Comentários do humano no `.md` abaixo da linha
  `<!-- notas -->` ficam.
- Atualizando um snapshot existente: mostra as operações novas e as removidas, e os itens
  não iniciados que citam uma operação removida.

### `tela` (Figma)

- Lê o token de `FIGMA_TOKEN` (token pessoal do Figma, só leitura). Sem ele, erro dizendo
  como criar e a alternativa `--png`.
- Do link: chave do arquivo (`/design/<chave>/` ou `/file/<chave>/`) e `node-id`
  (`2696-108134` → `2696:108134`).
- `GET /v1/images/<chave>?ids=<nó>&format=png&scale=<escala>` (padrão 2) e download do PNG
  para `telas/<nome>/tela.png`.
- `GET /v1/files/<chave>/nodes?ids=<nó>` → `telas/<nome>/tela.md`: link, data, tamanho do
  frame, textos (nós `TEXT`, na ordem do documento) e cores sólidas usadas, com contagem.
- Erros do Figma (403 sem acesso, 404 nó inexistente) aparecem com o status e a mensagem.
- `--png`: copia o arquivo para `telas/<nome>/tela.png` e cria o `tela.md` mínimo.
- O token nunca é gravado nem registrado, e não chega ao agente: o runner tira de toda
  run as variáveis de `PRIVATE_ENV` (`FIGMA_TOKEN`), que o agente leria pelo `Bash`.
- Teste real (2026-10-22): frame `WO-01 — HOME · OPERADOR` de um arquivo de terceiro, com
  token de quem tem acesso de leitura; PNG de 2880×2124 e `tela.md` com 70 textos e 17
  cores. O nome da tela é do humano e descreve a tela (`home-operador`), não o item.

### Validade do token (`mabel credencial`)

Decisão do usuário (2026-10-23): a data fica num comando do Mabel, não no arquivo do token.

- `mabel credencial figma --expira <AAAA-MM-DD>` grava `{ expira, registradoEm }` em
  `~/.mabel/credenciais.json` (global, fora da remoção de projeto). O token não é gravado.
- `mabel credencial` lista cada credencial conhecida: variável definida ou ausente, data e
  dias que faltam (ou "validade não registrada").
- Aviso a partir de 14 dias do fim (dias de calendário no fuso local): no `status` e antes
  da captura pelo Figma no `referencia tela`. Vencido pela data registrada, o 403 do Figma
  vem acompanhado do aviso de vencimento.

## Critérios de aceite

1. O parser lê e o `renderItemBlock` grava `Referências:`; backlog sem o campo mantém o hash.
2. Referência inválida (tela sem arquivos, snapshot ausente, operação inexistente, caminho
   fora de `.mabel/referencias/`) deixa o item em `backlog` com o motivo; corrigida, vai a
   `ready`.
3. Mudar um arquivo referenciado muda o hash do item.
4. Ao entrar em `planning`, a cópia congelada é criada com a operação extraída (com os
   `$ref` alcançados); a segunda entrada não a altera.
5. As runs de planejamento, execução e revisão recebem `--add-dir` e a seção
   "Referências"; o refinamento recebe os caminhos da raiz.
6. `referencia api` grava o snapshot, converte a URL do swagger-ui do Quarkus, recusa
   resposta que não é OpenAPI JSON e relata operações novas e removidas.
7. `referencia tela` com `FIGMA_TOKEN` grava `tela.png` e `tela.md`; sem token, erro com a
   alternativa; `--png` funciona sem rede.
8. `referencia` sem argumentos lista as referências e os itens que as citam.
9. `credencial figma --expira` registra a data; `status` e `referencia tela` avisam a 14
   dias do fim e depois do vencimento.

## Fora desta entrega (vai para o `BACKLOG.md`)

- Refinamento propondo referências.
- `add` com `--referencia`.
- Validação visual na inbox: captura do Playwright ao lado do PNG da tela.
- Mocks gerados do snapshot (MSW ou fixtures) como passo do `setup`.
- Telas com vários frames num comando só.
