# Especificação — Modo Mabel e inicialização por stack

Revisão da interface e do `mabel init` depois do primeiro uso. Não muda o contrato:
o catálogo de stacks é uma forma de cumprir "Projeto sem testes" (`docs/CONTRATO.md`).

Dois incrementos, nesta ordem. Cada um termina com `npm run check` verde, critérios de
aceite atendidos, `docs/PLANO.md` atualizado e um commit.

## Decisões

| Tema | Decisão |
|---|---|
| Menu de uso único | Substituído pelo modo Mabel. O incremento 2.4 (menu como painel) sai do plano. |
| Sintaxe | Comandos só com `/` (`/init`, `/item 3`). Texto sem `/` fica reservado para o `add` assistido. |
| Autocompletar | Lista visível e interativa abaixo do prompt, filtrada enquanto se digita. |
| Saída | `exit`, `/sair` ou Ctrl+D. |
| Stacks | Node/TypeScript, Python, Go, Rust e "Outra". Node usa Vitest. |

## Incremento 2.4 — Modo Mabel

> **Substituído pelo novo terminal** (`docs/specs/terminal.md`, incremento T.2, em
> 2026-10-31): `mabel` sem argumentos no TTY abre a tela inicial com a lista de comandos
> navegável e o filtro; o modo com `/`, o autocompletar abaixo do prompt e o histórico
> saíram, e os comandos ganharam nomes novos (`init` virou `preparar`, `add` virou
> `adicionar`…). O texto abaixo fica como registro do que foi feito.

`mabel` sem argumentos, em TTY, entra no modo Mabel: um laço de prompt que executa
comandos sem o prefixo `mabel`. Fora de TTY, imprime a lista de comandos (como hoje).
`mabel <comando> [args]` continua funcionando para scripts e para o autocompletar do zsh.

### Entrada

```
<banner>
v0.x · harness para frotas de agentes

 5h  ████████░░  78% livre · reset hoje 16:40
 7d  █████████░  91% livre · reset sex 09:00        leitura de 4 min atrás

Digite / para ver os comandos · exit para sair

mabel · meu-app › 
```

- O projeto do prompt é o projeto Mabel que contém o cwd. Ele é recalculado a cada
  volta do laço, então o prompt muda logo depois de um `/init`.
- Fora de um projeto Mabel, o prompt é `mabel ›` e uma linha acima dele avisa:
  - repositório git sem `.mabel/`: `Este repositório ainda não é um projeto Mabel. Digite /init.`
  - fora de um repositório git: `Fora de um repositório git. Rode git init aqui ou abra o Mabel num projeto.`

### Linha de comando

- `/nome args...`: os argumentos são separados como no shell, com aspas simples e duplas
  (`/exec "explique o runner"`). Aspas sem fechamento geram um erro e voltam ao prompt.
- Se o comando tem `promptArgs` (hoje `menuArgs`) e foi chamado sem argumentos, os
  argumentos são pedidos interativamente, como o menu faz hoje.
- Comando desconhecido: `Comando desconhecido: /x. Digite / para ver os comandos.`
- Texto sem `/`: `Comandos começam com /. Digite / para ver a lista.`
- Comando planejado (`/inbox`): mostra o aviso de "ainda não implementado" e volta.
- `exit`, `/sair` e Ctrl+D encerram. `/sair` entra na lista de comandos só no modo Mabel.
- `/completion` não aparece no modo Mabel (só faz sentido no shell).
- Linha vazia: nada acontece.

### Lista de autocompletar

- Aparece assim que a linha começa com `/` e o cursor ainda está no nome do comando
  (antes do primeiro espaço). Some quando aparece o espaço ou a linha deixa de começar com `/`.
- Mostra nome e descrição dos comandos cujo nome começa com o texto digitado depois da
  `/`. Comandos planejados aparecem apagados, com `(passo N)`.
- ↑/↓ movem a seleção. Tab completa o nome selecionado e acrescenta um espaço. Enter
  com a lista aberta executa o comando selecionado. Esc fecha a lista até a próxima tecla
  que altere a linha.
- Sem correspondência, a lista mostra `nenhum comando` apagado.
- No máximo 8 linhas; com mais comandos, a lista rola junto com a seleção.

### Editor de linha

Editor próprio em modo raw, no padrão do `menu.ts`: uma função pura
`(estado, tecla) → estado | ação` e uma função de desenho separada.

- Edição: caracteres imprimíveis, Backspace, Delete, ←/→, Home/End, Ctrl+A/Ctrl+E,
  Ctrl+U (apaga até o início), Ctrl+W (apaga a palavra anterior).
- Histórico: ↑/↓ percorrem os comandos anteriores quando a lista de autocompletar está
  fechada. Uma linha trazida do histórico mantém a lista fechada, para que as setas
  continuem no histórico. Gravado em `<dados>/historico`, com as últimas 500 linhas; comandos repetidos
  em sequência entram uma vez só.
- Ctrl+C com texto limpa a linha. Com a linha vazia, mostra `use exit para sair`.
- Colar texto com várias teclas de uma vez deve funcionar: a sequência do keypress é
  tratada caractere a caractere.

### Execução do comando

- Antes de rodar o comando, o editor sai do modo raw, remove os listeners de `keypress` e
  restaura o cursor. Assim o `ask()` e o `select()` de cada comando funcionam sem
  conflito. Depois do comando, o editor volta.
- Ctrl+C durante um comando é tratado pelo próprio comando (`run`, `exec` e `status` já
  registram `SIGINT`). O modo Mabel não encerra: volta ao prompt.
- Durante o comando, o modo Mabel registra um handler de `SIGINT` vazio, para que um
  Ctrl+C num comando sem handler próprio não encerre o processo.
- Ctrl+C numa pergunta (`ask()`) lança `Interrupted`: o modo Mabel mostra `interrompido`
  e volta ao prompt. Fora do modo Mabel, o comando sai com 130.
- Exceção não tratada num comando: mensagem de erro em vermelho, volta ao prompt.
- Código de saída diferente de zero: o prompt seguinte mostra `✗` antes de `›`.

### Remoções

- `select()` continua no `menu.ts`, porque é usado pelo `init` (escolha de stack). A tela
  inicial com menu (`home()` em `cli.ts`) é removida.
- `menuArgs` passa a se chamar `promptArgs`.

### Critérios de aceite

- [x] Função pura do editor testada: edição, histórico, abertura e filtro da lista,
      Tab, Enter com lista aberta, Esc, Ctrl+C com e sem texto, Ctrl+D.
- [x] Separação de argumentos testada: aspas simples, duplas, escapes e aspas abertas.
- [x] Comando que falha ou lança exceção volta ao prompt com a mensagem visível.
- [x] O terminal é restaurado (modo raw desligado, cursor visível) em qualquer saída,
      inclusive por exceção.
- [x] `/init` dentro do modo Mabel muda o prompt para o nome do projeto.
- [x] `mabel` fora de TTY imprime a lista de comandos e sai com 0.
- [x] Verificado num pseudo-terminal: `/run` interrompido com Ctrl+C volta ao prompt.

## Incremento 3.4 — `mabel init` por stack

### Catálogo

Módulo `src/stacks.ts` com uma entrada por stack:

| Campo | Uso |
|---|---|
| `id`, `label` | `node`, "Node/TypeScript"… |
| `detect(root)` | Reconhece a stack num projeto com código. |
| `commands(root)` | Setup e verificação detectados num projeto existente (o que já existe). |
| `template` | Framework de testes, setup e verificação esperados num projeto novo. |

`detectCommands` passa a percorrer o catálogo. A detecção atual é preservada: num projeto
existente entram só os comandos que já existem.

| Stack | Detecta | Framework | Setup esperado | Verificação esperada |
|---|---|---|---|---|
| Node/TypeScript | `package.json` | Vitest | `npm ci` | `npm run typecheck`, `npm test` |
| Python | `pyproject.toml`, `pytest.ini`, `requirements.txt` | pytest | `uv sync` | `uv run ruff check`, `uv run pytest` |
| Go | `go.mod` | `testing` | — | `go vet ./...`, `go test ./...` |
| Rust | `Cargo.toml` | `cargo test` | — | `cargo clippy -- -D warnings`, `cargo test` |
| Outra | — | o agente escolhe | texto livre | texto livre |

O template do Node fica sem lint: configurar ESLint pesa demais para o primeiro item.
O lint entra quando o projeto pedir.

O `Makefile` com alvo `test` continua detectado, independente da stack.

### Fluxo

Cada pergunta tem padrão no Enter. Um passo por vez:

1. **Projeto com código e stack reconhecida.**
   ```
   Stack detectada: Node/TypeScript
     setup   npm ci
     build   npm run build
     test    npm test
   Usar estes comandos? [S/n/editar]
   ```
   `n` deixa `setup` e `verify` vazios, com o aviso de G3 sem gate mecânico. `editar`
   abre o editor de comandos atual, com os textos revistos. Com mais de uma stack
   detectada, o rótulo junta as duas (`Node/TypeScript + Python`) e os comandos são somados.
2. **Projeto com código e stack não reconhecida.** Menu com o catálogo. Escolher uma
   stack só define o framework sugerido no item da base de testes; os comandos ficam
   vazios, e o editor oferece incluí-los.
3. **Projeto sem código.** Menu com o catálogo: `Qual stack o projeto vai usar?`. "Outra"
   pede o nome em texto livre.
4. **Commit inicial**, como hoje.

### Item da base de testes

Num projeto existente sem testes, o item sugere o framework da stack.

Num projeto sem código, `setup` e `verify` ficam **vazios** no `config.json` (o aviso do
`init` diz que entram com o item 1): o `setup` roda
quando o worktree é criado (`worktree.ts`) e falharia sem o manifesto, bloqueando o item.
O item 1 carrega o template completo:

```
### 1. Estabelecer base de testes

O projeto ainda não tem código. Criar a estrutura mínima de Node/TypeScript com Vitest e
escrever ao menos um teste que passe.

O item não altera o `.mabel/config.json`: o config do Mabel é do humano. Depois do merge,
o config deve ter `setup` igual a `npm ci` e `verify` com `typecheck` (`npm run typecheck`)
e `test` (`npm test`).

Critérios de aceite:
- `npm run typecheck` e `npm test` rodam e passam
```

Até 2026-10-22 o config era critério do item; o gate de escopo barra o `.mabel/`, e o item
reprovava por fazer o que o critério pedia.

Com "Outra", o texto é o de hoje, com `Stack: <texto>`.

### Fora de TTY

`mabel init [--stack node|python|go|rust]`. Sem TTY, não há perguntas: usa a stack
detectada; num projeto sem código, usa `--stack` ou gera o item genérico de hoje.

### Critérios de aceite

- [x] Catálogo testado com repositórios temporários: detecção de cada stack, comandos
      de projeto existente iguais aos de hoje (os testes do 3.1 continuam passando).
- [x] Item da base de testes gerado por stack, testado por texto.
- [x] Projeto sem código grava `setup` nulo e `verify` vazio.
- [x] `--stack` inválido lista os ids válidos e sai com erro.
- [x] Verificado num pseudo-terminal: `/init` num repositório vazio, escolhendo Node.

## Fora desta especificação

Autocompletar de argumentos (números de item em `/item`, `/aprovar`); stacks além das
quatro; `add` assistido por texto livre.
