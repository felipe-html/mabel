# Menu do Mabel — levantamento

Rascunho de trabalho: descreve o que cada comando faz hoje, com todos os parâmetros e
modos de uso, e aponta o que parece mal refinado. Depois de revisado, o conteúdo
estável vai para o `README.md`.

Fonte: o código em `src/` na branch `claude/gate-de-escopo` (outubro de 2026), mais o
`refinar` e os campos novos do `add` (`docs/specs/refinamento.md`). Onde o
comportamento parece não ter sido intencional, o texto diz "a confirmar".

## Índice

- [Como o menu aparece](#como-o-menu-aparece)
- [Mapa rápido](#mapa-rápido)
- Comandos: [init](#init) · [add](#add) · [especificar](#especificar) · [refinar](#refinar) · [referencia](#referencia) · [credencial](#credencial) · [run](#run) · [inbox](#inbox) · [item](#item) ·
  [aprovar](#aprovar) · [responder](#responder) · [cancelar](#cancelar) ·
  [integracao](#integracao) · [entregar](#entregar) · [rejeitar](#rejeitar) · [status](#status) · [runs](#runs) ·
  [projetos](#projetos) · [projeto](#projeto) · [exec](#exec) · [completion](#completion)
- [Problemas transversais](#problemas-transversais)
- [Perguntas](#perguntas)

---

## Como o menu aparece

O Mabel tem três portas de entrada para os mesmos comandos (lista única em
`src/commands.ts`).

| Entrada | Quando | O que acontece |
|---|---|---|
| `mabel` em TTY | stdin e stdout interativos | Banner, versão e o **modo Mabel** (REPL com `/comando`) |
| `mabel` fora de TTY | pipe, script | Banner, versão e a lista de comandos; sai com 0 |
| `mabel <comando> [args]` | shell | Executa o comando e sai |

### Opções globais (só no shell)

| Opção | Efeito |
|---|---|
| `--version`, `-v` | Imprime a versão |
| `--help`, `-h`, `help` | Imprime a lista de comandos |
| `mabel <comando> --help` (ou `-h`) | Imprime a descrição e a linha `Uso:` do comando |
| comando desconhecido | Mensagem, lista de comandos, sai com 1 |

### Modo Mabel (REPL)

- Prompt: `mabel · <projeto> ›`; sem projeto, `mabel ›` com um aviso acima (fora de git, ou
  git sem `.mabel/`). Recalculado a cada volta, então muda logo depois do `/init`.
- Depois de um comando que saiu com código diferente de 0, o prompt mostra `✗`.
- Linha precisa começar com `/`. Texto sem `/`: "Comandos começam com /". `exit`, `/sair`
  e Ctrl+D (linha vazia) encerram.
- Argumentos separados como no shell: aspas simples, duplas e `\`. Aspas abertas dão erro.
- `/completion` não aparece no REPL; `/sair` só aparece nele.
- Comando sem argumentos que tem `promptArgs` pede os argumentos por perguntas (ver o
  mapa rápido).
- Ctrl+C dentro de um comando não fecha o Mabel: volta ao prompt (`interrompido`).
- Exceção não tratada: `Erro em /<comando>: …` e volta ao prompt.
- Rodapé fixo com o saldo (última linha do terminal), redesenhado a cada 30 s e a cada
  leitura nova. Some com `MABEL_RODAPE=0` ou terminal com menos de 10 linhas.
- Histórico em `~/.mabel/historico` (500 linhas, sem repetição seguida).

**Teclas do editor de linha**

| Tecla | Lista de comandos aberta | Lista fechada |
|---|---|---|
| `/` no início | abre a lista, filtrada pelo que se digita (até 8 linhas, rola) | — |
| ↑ / ↓ | move a seleção | percorre o histórico |
| Tab | completa o nome selecionado + espaço | nada |
| Enter | executa o comando **selecionado** (sem argumentos) | executa a linha |
| Esc | fecha a lista até a próxima edição | nada |
| ←/→, Home/End, Ctrl+A/E | cursor | cursor |
| Backspace, Delete, Ctrl+U, Ctrl+W | edição | edição |
| Ctrl+C | limpa a linha; vazia: "use exit para sair" | idem |
| Ctrl+D | apaga o caractere; linha vazia: sai | idem |

### Menu de seleção (`select`)

Usado em quatro lugares: escolha de stack no `init`, lista de itens em `refinar`, lista
de runs em `runs` e lista de projetos em `projetos`/`projeto`.

| Tecla | Efeito |
|---|---|
| ↑/↓, `k`/`j` | move (com volta ao início/fim) |
| Home / End | primeiro / último |
| `1`–`9` | escolhe direto a opção N |
| Enter, Espaço | escolhe a opção sob o cursor |
| `q`, Esc, Ctrl+C | sai sem escolher |

### Variáveis de ambiente

`MABEL_HOME` (dados no lugar de `~/.mabel`), `MABEL_BANNER=0`, `MABEL_RODAPE=0`,
`MABEL_NOTIFICAR=0`, `NO_COLOR`, `FIGMA_TOKEN` (captura de telas no `referencia tela`;
nunca repassado às runs; validade em `credencial`), `MABEL_FIGMA_API` (endereço da API do Figma, para testes).

---

## Mapa rápido

Ordem em que aparecem na lista (a mesma de `src/commands.ts`).

| Comando | Sintaxe | Precisa de projeto | Pergunta no REPL sem args | Trava do projeto | Fora de TTY |
|---|---|---|---|---|---|
| `init` | `init [--stack node\|python\|go\|rust]` | não (cria) | — (o próprio comando pergunta) | não | sem perguntas |
| `add` | `add "<título>" [--intencao] [--criterio]… [--fora-do-escopo]… [--depende]… [--restricoes]` | sim | — (o próprio comando pergunta) | não | exige título e `--intencao` |
| `especificar` | `especificar [<slug>] [--refazer] [--aceitar \| --descartar]` | sim | não | não | sem `<slug>` lista; com `<slug>` roda a primeira rodada e mostra a proposta e as perguntas; `--aceitar` responde com as sugestões e grava (sem proposta: aceita a spec do arquivo) |
| `refinar` | `refinar [<n>] [--refazer] [--aceitar \| --descartar]` | sim | — (o próprio comando abre o menu de itens) | não | sem `<n>` lista; com `<n>` roda a primeira rodada e mostra a proposta e as perguntas; `--aceitar` responde com as sugestões e grava |
| `referencia` | `referencia` · `referencia api <nome> <url>` · `referencia tela <nome> <url-figma> [--escala <n>]` · `referencia tela <nome> --png <arquivo>` | sim | não | não | igual |
| `credencial` | `credencial` · `credencial figma --expira <AAAA-MM-DD>` | não (global) | não | não | igual |
| `run` | `run [--item <n>] [--uma] [--sem-lote]` | sim | não | **sim** | sem perguntas; política decide |
| `item` | `item <n>` | sim | número | não | igual |
| `aprovar` | `aprovar <n>` | sim | número | não | igual |
| `responder` | `responder <n> "<resposta>" [--replanejar]` | sim | número, resposta, replanejar? | não | igual |
| `cancelar` | `cancelar <n>` | sim | número + confirmação | não | igual, **sem confirmação** |
| `integracao` | `integracao` | sim | não | não | igual |
| `entregar` | `entregar [--substituir] [--rascunho]` | sim | não | não | igual |
| `rejeitar` | `rejeitar <n> "<motivo>" [--cancelar]` | sim | número, motivo, cancelar? | **sim** | igual |
| `exec` | `exec "<prompt>" [--model] [--max-turns] [--max-budget-usd] [--allowed-tools] [--cwd]` | não | prompt | não | igual |
| `status` | `status [--atualizar]` | não (mostra o quadro se houver) | não | não | igual |
| `runs` | `runs [--limite <n>]` · `runs <id>` | não (global) | não | não | tabela no lugar do menu |
| `inbox` | `inbox` | sim | não | não (o `run` que ela abre, sim) | imprime as pendências |
| `projetos` | `projetos [--removidos]` | não (global) | não | não | tabela no lugar do menu |
| `projeto` | `projeto <nome>` · `projeto remover <nome> [--confirmar <nome>]` | não (global) | não (abre o menu de projetos) | só no `remover` | `remover` exige `--confirmar` |
| `completion` | `completion zsh` | não | — (só shell) | não | igual |

Códigos de saída: 0 sucesso, 1 erro de uso ou de estado, 130 interrompido (Ctrl+C).

---

## Comandos

### init

**Para quê:** transformar o repositório atual (raiz git) em projeto Mabel.

| Parâmetro | Valores | Efeito |
|---|---|---|
| `--stack <id>` | `node`, `python`, `go`, `rust` | Força a stack do catálogo; id inválido lista os válidos e sai com 1 |

**Fluxo**

1. Fora de git: erro, sai com 1.
2. Já é projeto (`.mabel/config.json` existe): registra no banco, mostra id, base, setup e
   verify, **não altera nada** e oferece o commit do `.mabel/` se houver algo pendente.
3. Detecta stacks e comandos:
   - **Detectou algo:** mostra e pergunta `Usar estes comandos? [S/n/editar]` (só TTY).
     `n` zera `setup` e `verify`; `editar` abre o editor de comandos.
   - **Nada detectado, sem `--stack`, TTY:** menu de stacks (catálogo + "Outra").
     Projeto vazio: "Outra" pede o nome em texto livre. Projeto com código: depois do menu
     abre o editor de comandos. Sair do menu cancela o `init`.
4. Grava `config.json` com padrões: branch base = branch atual, modelos e limites padrão,
   `autonomia: "sugestoes"`, `integracao: "mabel/integracao"`, sandbox ligado, domínios de
   rede da stack e dos frameworks detectados (Next: `fonts.googleapis.com` e
   `fonts.gstatic.com`).
5. Sem comando de teste em `verify`: o backlog nasce com o item 1 "Estabelecer base de
   testes", concreto quando a stack é do catálogo. O item não altera o `.mabel/config.json`;
   a intenção traz a nota de que o comando de teste entra em `verify` pelo humano, depois
   do merge.
6. Cria `regras-criticas.md`, `backlog.md`, `.gitignore` (quadro e integração) e por último
   `config.json`. Repositório que já foi projeto reaproveita o id antigo (mantém histórico).
7. Oferece `Commitar o .mabel/ na branch <base>? [S/n]`; fora de TTY só imprime o comando.

**Editor de comandos (TTY):** para cada comando, Enter mantém, `-` remove, texto
substitui. Depois aceita extras no formato `nome: comando` até uma linha vazia.

**Pontos a refinar**

- Com `--stack` em TTY num projeto com código **não detectado**, o editor de comandos não
  é oferecido: o projeto nasce com `verify` vazio sem chance de preencher.
- Com `--stack` e stack detectada diferente, o título mostra a detectada, mas a prova usa
  a forçada. Sem aviso.
- Não há como **reconfigurar** depois: rodar `init` de novo não muda nada. Mudar
  `verify`, modelos, `autonomia`, `integracao`, `rede` ou `sandbox` é só editando o JSON.
- O `config.json` tem campos que nenhum comando mostra (modelos, limites, autonomia,
  contexto, rede). Falta um "ver configuração".

### add

**Para quê:** acrescentar um item ao final de `.mabel/backlog.md`.

| Parâmetro | Repetível | Efeito |
|---|---|---|
| `"<título>"` (posicional) | palavras são juntadas | Título |
| `--intencao <texto>` | não | Intenção (obrigatória) |
| `--criterio <texto>` | sim | Um critério de aceite por ocorrência |
| `--fora-do-escopo <texto>` | sim | O que o item não faz, um por ocorrência |
| `--depende <n>` | sim; aceita `2,3` e `#2` | Números dos itens dos quais depende |
| `--restricoes <texto>` | não | Restrições técnicas |

**Modos**

- **TTY sem `--intencao`:** pergunta, pulando o que já veio por argumento: título,
  intenção, critérios e fora do escopo (um por linha, vazia encerra), dependências
  (`2, 3`), restrições.
- **TTY com `--intencao`:** não pergunta nada; critérios, dependências e restrições ficam
  vazios se não vieram.
- **Fora de TTY:** exige título e `--intencao`.

Grava o bloco, sincroniza o backlog e mostra `Item #N adicionado: <título> · <estado>`
(`ready` ou `backlog`; `blocked` com o motivo). No TTY, pergunta em seguida
`Refinar o item agora com um agente? [s/N]` e, com `s`, abre o [refinar](#refinar) do item.

`Decisões:` e `Regras críticas:` não têm opção no `add`: entram pelo `refinar` ou editando
o `backlog.md`.

**Pontos a refinar**

- Não há comando para **editar**, **reordenar** ou **remover** item: só editando o
  `backlog.md` (apagar o bloco cancela o item se ele não começou).
- `--depende` aceita qualquer número: dependência de item inexistente ou de si mesmo não é
  recusada no `add` (a confirmar o que a sincronização faz nesses casos).
- No modo TTY, passar `--intencao` desliga todas as perguntas, inclusive critérios. Pode
  surpreender quem passou só título e intenção esperando ser perguntado do resto.
- A prioridade é a ordem no arquivo; o `add` sempre põe no fim. Sem `--antes`/`--topo`.

### especificar

**Para quê:** especificar uma funcionalidade com um agente, pelo Example Mapping (história →
regras → exemplos → perguntas), e aceitar a spec (`docs/specs/specs-e-entrega.md`).

| Parâmetro | Efeito |
|---|---|
| (nenhum) | Lista as specs de `.mabel/specs/` com estado, tarefas, validade, proposta pendente e tamanho |
| `<slug>` | A spec em `.mabel/specs/<slug>.md` (o rascunho pode ser só a história). Continua a proposta pendente ou roda o agente; no TTY, responde as perguntas rodada a rodada e abre a revisão; fora dele, roda a primeira rodada e imprime a proposta e as perguntas |
| `--refazer` | Descarta a proposta pendente e começa uma conversa nova |
| `--aceitar` | Com proposta pendente: responde as perguntas com as sugestões (as sem sugestão ficam para o planejamento), segue as rodadas e grava sem revisão. Sem ela: aceita a spec como está no arquivo, se passar na validação |
| `--descartar` | Descarta a proposta pendente sem gravar |

Validação da spec: regra com exemplo, algum exemplo `(borda)`, nenhum `→ ?`, fora do escopo
declarado. Tarefa com `Spec:` só vai a `ready` com a spec aceita, válida e com as `Regras:`
citadas. Spec `entregue` não é especificada de novo; spec `aceita` pergunta antes de pedir
outra proposta (TTY).

**Rodadas:** etapa `specify`, só leitura (`Read`, `Glob`, `Grep`) na raiz, com as travas
do refinamento e o modelo e os limites de `refine` no config, até 5 rodadas na mesma
sessão. O agente recebe o rascunho, o código, o `.mabel/regras.md` (até 20.000 caracteres;
acima, o Mabel avisa e pede para consolidar) e acha as entregas anteriores com `Grep`. Cada
exemplo sem resultado dedutível vira pergunta (no máximo 5 por rodada). A rodada seguinte
recebe as respostas e as regras que elas mexem. Saída inválida (exemplo sem resultado e sem
pergunta, mais de 5 perguntas, regra citada que não existe) volta ao agente uma vez, na
mesma sessão. Ctrl+C deixa a proposta pendente com as respostas já dadas.

**Revisão (TTY)**

| Etapa | Entradas aceitas |
|---|---|
| Cada pergunta, com a regra e a sugestão | Enter aceita a sugestão · texto responde · `p` deixa para o planejamento |
| História | Enter aceita · `e` edita |
| Regras e exemplos | Enter aceita · `e` edita uma a uma (texto da regra, depois os exemplos como lista) |
| Decisões, fora do escopo, regras críticas, alterações nas regras vigentes | Enter aceita · `e` edita um a um · `-` descarta |
| Tarefas | Enter aceita · `e` edita uma a uma (Enter mantém, `-` remove, texto troca o título) · `-` descarta |
| Sugestão de quebra e tamanho | — (informativos) |
| Prévia (spec e tarefas) e `Gravar? [S/n/d]` | Enter grava · `n` deixa a proposta pendente · `d` descarta |

**Grava:** `.mabel/specs/<slug>.md` (a proposta substitui o rascunho), as tarefas no fim do
`backlog.md` com `Spec:`, `Regras:` e `Depende de:` (nenhuma, se a spec já tinha tarefas),
o estado `aceita` e as métricas de tamanho (regras, exemplos, rodadas, perguntas, tarefas).

**Pontos a refinar**

- `--json` e passos sem TTY para clientes, no desenho do `nascer` (fora desta entrega).
- `especificar --de <n>` (transformar um avulso em spec) não existe: escrever o rascunho é manual.
- Reespecificar uma spec com tarefas não ajusta as tarefas existentes.

### refinar

**Para quê:** antes do planejamento, especificar um avulso com o mesmo motor do
[especificar](#especificar) (Example Mapping, uma tarefa só) e gravar no `backlog.md` só o
que você aceitar. Specs: `docs/specs/refinamento.md` e `docs/specs/specs-e-entrega.md`.

| Parâmetro | Efeito |
|---|---|
| (nenhum) | TTY: menu dos itens refináveis com estado e situação; o escolhido abre a conversa e o menu volta ao terminar (`q` sai). Fora de TTY: tabela `# · título · estado · refinamento` |
| `<n>` (aceita `#3`) | Continua a proposta pendente ou roda o agente; no TTY responde as perguntas e abre a revisão, fora dele imprime a proposta, as perguntas e como aceitar |
| `--refazer` | Descarta a proposta pendente e começa uma conversa nova |
| `--aceitar` | Responde as perguntas com as sugestões (as sem sugestão ficam para o planejamento), segue as rodadas e grava sem revisão |
| `--descartar` | Descarta a proposta pendente sem gravar |

Só avulsos (sem `Spec:`) em `backlog` ou `ready` que nunca entraram em planejamento; tarefa
de spec aponta para o `especificar`. Situações: `não refinado`, `perguntas pendentes`,
`proposta pendente`, `proposta desatualizada` (o item mudou depois da proposta, ou é do
refinamento antigo; o agente roda de novo), `refinado`, `descartado`. Item já refinado: no
TTY, pergunta `Pedir outra proposta ao agente? [s/N]` antes de gastar outra run. Antes da
primeira rodada, a política de saldo numa chamada: sem leitura recente faz a chamada
mínima; saldo baixo ou acima do ritmo pergunta `Refinar mesmo assim? [s/N]` (TTY) ou recusa.

**Revisão (TTY):** a mesma do `especificar`, sem as tarefas; com a etapa das referências e,
em `Tipo: bug`, a reprodução (passos, esperado, obtido hoje). Prévia do bloco e
`Gravar? [S/n/d]`.

**Grava:** regras e exemplos como `Critérios:` (`<regra>: situação → resultado`; no bug, a
`Reprodução: passos → esperado (hoje: obtido)` primeiro), respostas como
`Decisões: - <pergunta> → <resposta>`, fora do escopo, regras críticas e `Regras vigentes:`
(aplicadas na entrega). A história vira a intenção só se o item não tinha. Acrescenta sem
repetir entradas iguais, regrava só o trecho do item e sincroniza. Proposta com mais de uma
tarefa sugere transformar o avulso em spec.

**Pontos a refinar**

- Comentários HTML no meio do bloco do item somem quando a proposta é gravada.
- `--aceitar` e `--descartar` exigem o número; não há "aceitar todas as pendentes".
- O `run` não avisa sobre itens `ready` nunca refinados.

### referencia

**Para quê:** guardar cópias de telas e APIs para os itens citarem em `Referências:`
(`docs/specs/referencias.md`). O agente não abre links; lê essas cópias.

| Forma | Efeito |
|---|---|
| (nenhum) | Lista as APIs (operações) e as telas (arquivos) de `.mabel/referencias/`, com os itens que citam cada uma |
| `api <nome> <url>` | Baixa o OpenAPI em JSON e grava `api/<nome>.openapi.json` e `api/<nome>.md` (origem, data, notas abaixo de `<!-- notas -->` ficam) |
| `tela <nome> <url-figma>` | Com `FIGMA_TOKEN`, exporta o frame do link (`node-id`) em `telas/<nome>/tela.png` (escala 2, ou `--escala` até 4) e descreve em `tela.md` arquivo, frame, tamanho, textos e cores sólidas |
| `tela <nome> --png <arquivo>` | Grava um PNG exportado à mão, com um `tela.md` mínimo; sem rede |

A URL do swagger-ui do Quarkus (`…/q/swagger-ui/`) vira `…/q/openapi?format=json`.
Recapturando, mostra as operações novas e removidas e os itens não iniciados que citam uma
operação que saiu. Não commita: o próximo `run` leva o `.mabel/` à base.

**Pontos a refinar**

- OpenAPI em YAML não é aceito; só JSON.
- Sem autenticação: API que exige token não é capturada.
- Um frame por comando; estados (erro, vazio) entram à mão em `telas/<nome>/`.
- O `tela.md` não traz fontes, espaçamentos nem componentes; só textos e cores.

### credencial

**Para quê:** acompanhar a validade dos tokens que o Mabel usa fora das runs. O token do
Figma vence em até 90 dias e a API não informa quando; o Mabel guarda só a data que você
informa, em `~/.mabel/credenciais.json`, nunca o token.

| Forma | Efeito |
|---|---|
| (nenhum) | Para cada credencial: se a variável está definida, a data de vencimento e os dias que faltam |
| `figma --expira <AAAA-MM-DD>` | Registra (ou troca, na renovação) a data de vencimento do `FIGMA_TOKEN` |

A partir de 14 dias do fim, o `status` e o `referencia tela` avisam. Depois do vencimento,
um 403 do Figma vem com o aviso de que o token venceu.

### run

**Para quê:** consumir a fila do projeto: planejar, executar, verificar, revisar e
integrar os itens.

| Parâmetro | Efeito |
|---|---|
| (nenhum) | **Lote**: planeja todos os `ready` primeiro; no fim do planejamento oferece a inbox se houver pendências; depois executa os `planned` um a um até a fila acabar |
| `--item <n>` | Processa só o item N, que precisa estar em `ready` ou `planned`; para no primeiro estado de parada |
| `--uma` | Processa um item só (item a item) e para |
| `--sem-lote` | Item a item: cada item vai do planejamento ao fim antes do próximo; o `planned` vem antes do próximo `ready` |

`--item` e `--uma` implicam item a item.

**Antes de começar** (sai com 1 se falhar)

- Commita na base o que está pendente no `.mabel/` (tarefas, specs, referências), só esse
  diretório e só com a raiz na base; fora dela, avisa e segue.
- `.mabel/` commitado na branch base.
- Sandbox disponível, a menos que `"sandbox": false` (aí imprime um aviso).
- Trava do projeto: um `run` por projeto de cada vez.

**Durante**

- Abertura (com integração): marca `done` as tarefas cuja unidade chegou à base e apaga a
  branch da unidade entregue; no primeiro `run` deste modelo, migra as tarefas da
  `mabel/integracao` antiga para a unidade `legado` (`mabel/spec/legado`); faz o merge da
  base em cada unidade aberta (`mabel/spec/<slug>`, `mabel/avulso/<n>-<slug>`), com
  `rerere` — conflito **pausa a unidade** (as tarefas dela não são escolhidas; as outras
  seguem); refaz a `mabel/integracao` a partir da base com o merge de cada unidade aberta,
  na ordem da primeira integração (a que conflita fica de fora, com aviso); roda a
  verificação do projeto nela (vermelho: aviso). Pausa a fila só se a `mabel/integracao`
  estiver aberta num worktree fora do Mabel. Remove worktrees órfãos e regrava o `run.md`.
- Cada tarefa nasce da branch da sua unidade (criada da base na primeira tarefa); antes,
  recebe o merge das unidades de que depende e que ainda não chegaram à base. Aprovada, entra
  por merge na branch da unidade (a da tarefa é apagada) e a unidade entra na integração:
  conflito ou verificação vermelha ali vão ao `run.md` com a tarefa, sem desfazer nada.
- Antes de cada etapa com agente, aplica a política de saldo: pode fazer uma chamada
  mínima (haiku) para ler o saldo, **perguntar** se segue (TTY), **esperar** o reset da
  janela de 5h ou o ritmo de 7 dias (com contagem regressiva), ou **pausar** (7 dias
  baixo, sem leitura). Fora de TTY, nunca pergunta: espera ou pausa.
- Saldo esgotado no meio da etapa: espera o reset e retoma pela mesma sessão.
- Antes de cada etapa com agente, confere se o código do Mabel (`src/`, `prompts/`,
  `hooks/`) mudou desde que o processo abriu. Se mudou, **pausa** com o motivo `o código do
  Mabel mudou desde que este processo abriu; saia e abra o mabel de novo…`, gravado em
  `queue_events` (causa `code`).
- Mostra cada ferramenta usada pelo agente (`→ Edit arquivo ✓`).
- Notificação do sistema quando para, pausa ou espera você.
- Ctrl+C interrompe a run atual e encerra (sai com 130).

**Fim:** resumo `■ <fim> · <estados> · custo · duração` e as decisões que o agente tomou
pela sugestão. Em TTY, com itens em `needs_human`, pergunta `Abrir a inbox agora?`;
depois da inbox, `Retomar a esteira agora? [S/n]` reabre a fila sem sair.

**Pontos a refinar**

- **`--item <n>` com outro item em andamento processa o outro.** Se houver item em
  `planning`/`executing`/`verifying`/`reviewing` (de um run interrompido), ele tem
  precedência e o `run` termina sem tocar no item pedido. A confirmar se é intencional;
  ao menos deveria avisar.
- **`--uma` e `--sem-lote` se sobrepõem.** `--uma` é `--sem-lote` que para no primeiro
  item. Talvez baste `--sem-lote` + `--item`, ou um `--limite <n>`.
- Não há "planejar só" (parar tudo em `planned` para revisar os planos antes de gastar
  com execução) nem "executar só".
- `--item` recusa item em `failed`, `blocked` ou `needs_human` com "não está em ready nem
  em planned", sem dizer o que fazer.
- Pausa por saldo de 7 dias "até sua decisão": a única decisão possível é rodar `run` de
  novo em TTY e responder "sim". Não existe um comando que registre a autorização.

### inbox

**Para quê:** responder, uma por vez, às decisões dos itens em `needs_human` (em ordem de
número).

Sem parâmetros (argumentos são ignorados).

**Por tipo de pendência**

| Pendência | O que mostra | Entradas aceitas |
|---|---|---|
| Perguntas do planejamento / da execução | Cada pergunta, com a sugestão do agente | Enter aceita a sugestão · texto responde · `d` "decida e registre como suposição" · `p` pula o item |
| (depois) suposições críticas | Lista das suposições | Enter confirma · texto corrige · `p` pula (sem `d`: é decisão humana) |
| (só execução) próximo passo | — | Enter retoma a execução · `r` replaneja com as respostas · `p` pula |
| Plano incompleto | Motivo | texto orienta o plano · `c` cancela (confirma) · `p` pula |
| Aprovação de item crítico | Motivos, critérios, escopo, suposições | `a` aprova · texto ajusta os critérios · `c` cancela · `p` pula (`d` recusado) |
| Tentativas esgotadas | O que reprovou em cada tentativa, em português; "Causa provável: bloqueio do ambiente" com o caminho do log quando ele mostra bloqueio do sandbox ou da rede; diagnóstico do executor na última tentativa | texto orienta novo ciclo (modelo escalonado) · `r <texto>` replaneja · `c` cancela · `p` pula |
| Impedimento de ambiente | O motivo declarado pelo executor, confirmado pela verificação do Mabel fora do sandbox (com o log), e o que ajustar | texto diz o que mudou no ambiente e retoma · `r <texto>` replaneja · `c` cancela · `p` pula |
| Conflito com a integração | Arquivos em conflito | texto orienta a resolução · `r <texto>` replaneja · `c` cancela · `p` pula |

Cada item vira uma decisão, gravada no fim do item. Ctrl+C descarta só o item em
andamento. No fim: `Respostas registradas em N itens · M pulados` e, se houve resposta,
`Retomar a esteira agora? [S/n]`, que chama o `run` sem opções.

**Fora de TTY:** imprime o detalhe de cada item pendente (como `item <n>`) e sai.

**Pontos a refinar**

- Não há como abrir a inbox de **um item** (`inbox <n>`) nem filtrar por tipo.
- Não há como **voltar** a um item já respondido na mesma sessão.
- "Retomar a esteira" sempre roda o `run` em lote, sem as opções do `run` original.
- `awaiting_merge` aparece em "Aguardando você" no quadro, mas não entra na inbox: a
  revisão da integração fica fora do fluxo de decisões.

### item

**Para quê:** mostrar tudo sobre um item.

| Parâmetro | Efeito |
|---|---|
| `<n>` (aceita `#3`) | Número do item |

Mostra: título e estado, motivo; se em `needs_human`, a pendência (perguntas com sugestão,
suposições críticas, arquivos em conflito, resumo de tentativas) e os comandos que
resolvem; intenção, restrições, fora do escopo, decisões, regras críticas, branch, commit
integrado, worktree, tentativas e custo; refinamento (situação e, depois do planejamento,
perguntas, suposições e replanejamentos);
critérios do plano (ou do backlog), escopo e caminho do `plano.md`; decisões tomadas pela
sugestão; últimas 10 runs; negações do hook de escopo; últimas 8 transições.

**Pontos a refinar**

- **Não existe "listar itens".** Para descobrir números, só o `status` (que detalha só
  "Aguardando você" e "Em andamento"), o `.mabel/quadro.md` ou o `projeto <nome>`.
  `item` sem número no shell dá erro em vez de listar.
- As runs aparecem com id de 4 caracteres, mas `runs <id>` lista com 8; prefixo de 4 pode
  ser ambíguo.
- Não mostra o diff nem o caminho do relatório de execução/revisão, só o do plano.

### aprovar

**Para quê:** aprovar os critérios de um item crítico (pendência `critical_approval`).

| Parâmetro | Efeito |
|---|---|
| `<n>` | Número do item |

Leva o item a `planned` com o plano atual; a execução começa no próximo `run`. Qualquer
outro estado ou pendência: erro "não está aguardando aprovação de critérios".

**Pontos a refinar**

- Não mostra o que está sendo aprovado: no shell, aprova às cegas se você não rodou
  `item <n>` antes. A inbox mostra critérios e escopo; o comando avulso não.
- Sem confirmação.

### responder

**Para quê:** destravar um item em `needs_human` com uma resposta ou orientação.

| Parâmetro | Efeito |
|---|---|
| `<n>` | Número do item |
| `"<resposta>"` | Texto (palavras soltas também são juntadas) |
| `--replanejar` | Descarta o ciclo atual e volta ao planejamento com o plano anterior como referência |

**Efeito por pendência**

| Pendência | Sem `--replanejar` | Com `--replanejar` |
|---|---|---|
| Perguntas do planejamento, plano incompleto, aprovação crítica | `planning`, retoma a mesma sessão com a resposta | **ignorado** (mesmo efeito) |
| Perguntas da execução | `executing`, mesma sessão e mesma tentativa | `planning`, ciclo novo |
| Tentativas esgotadas | `executing`, ciclo novo com modelo escalonado | `planning`, ciclo novo |
| Impedimento de ambiente | `executing`, ciclo novo, retoma a sessão da execução; sem alteração nova, verifica de novo | `planning`, ciclo novo |
| Conflito com a integração | `executing`, sessão nova que refaz o merge e resolve os conflitos | `planning`, ciclo novo |

No REPL sem argumentos pergunta: número, resposta e `Replanejar? [s/N]`.

**Pontos a refinar**

- `--replanejar` é aceito e silenciosamente ignorado em três das seis pendências; o REPL
  pergunta "Replanejar?" sempre, sem saber o tipo.
- O REPL pergunta a resposta antes de validar o número e sem mostrar a pergunta do agente.
- Em `critical_approval`, "responder" significa "ajustar critérios": nome pouco claro.
- Respostas a várias perguntas viram um texto só; no comando avulso não há como
  responder pergunta a pergunta (só na inbox).

### cancelar

**Para quê:** tirar um item da fila de vez.

| Parâmetro | Efeito |
|---|---|
| `<n>` | Número do item |

Aceito em `backlog`, `ready`, `planned`, `needs_human`, `blocked`, `failed` e
`awaiting_merge`. Recusado em andamento (`planning`…`reviewing`), `done` e `cancelled`.
No REPL sem argumentos, pede o número e confirma `[s/N]`; no shell, **não confirma**.

**Pontos a refinar**

- **Cancelar item já integrado não reverte o merge.** Em `awaiting_merge` com commit na
  branch de integração, `cancelar` muda o estado, mas o código continua na integração e
  vai para a base no próximo merge. O caminho certo é `rejeitar <n> --cancelar`. O
  `cancelar` deveria recusar ou redirecionar.
- Não é possível cancelar item em andamento (nem há comando para parar uma etapa).
- O item cancelado continua no `backlog.md` e gera aviso em toda sincronização até ser
  apagado à mão.
- Cancelamento é irreversível (não há `reabrir`).
- Itens que dependem do cancelado ficam em `backlog` para sempre, sem aviso no momento
  do cancelamento.

### integracao

**Para quê:** ver as unidades do relatório de run: o que está pronto para entregar (spec
com tarefas concluídas, `n/total`, ou avulso), o que está em andamento e a integração
(`base (commit) + unidades · de fora · verificação`), com o que olhar primeiro.

Sem parâmetros (argumentos ignorados). Regrava `.mabel/run.md` e imprime as seções de
unidade dele: por item integrado, plano, arquivos alterados, prova, devoluções por gate,
custo. O `run.md` substituiu o `.mabel/integracao.md` (S.1).

**Pontos a refinar**

- É só leitura: para levar uma unidade à base, `entregar` (abaixo). A integração é só para
  teste e nunca é entregue.
- Não atualiza estados: itens já levados à base só viram `done` no próximo `run` (a
  confirmar se o relatório os mostra até lá).
- Não tem atalho para abrir o diff de um item.

### entregar

**Para quê:** levar a integração à base por PR (`docs/specs/entregar.md`).

| Parâmetro | Efeito |
|---|---|
| `--substituir` | Com uma entrega aberta, abre outra com a integração atual e fecha o PR anterior |
| `--rascunho` | Abre o PR como rascunho |

Cria `mabel/entrega/<data>` no commit atual da integração (o `run` pode seguir integrando
sem mudar o PR) mais um commit do Mabel só com o documento de entrega
(`.mabel/entregas/<data>-integracao.md`: resumo, olhe primeiro, decisões, suposições,
critérios e prova, desvios e tarefas; trailer `Mabel-Entrega`), publica no remoto da base e
abre o PR pelo `gh`, com o documento como corpo (cortado acima de 60.000 caracteres). Pelo
merge do PR, o documento chega à base junto do código. Recusa se o repositório não permitir merge commit (squash e rebase impedem o `done`).
Sem `gh` ou com o remoto no Bitbucket, mostra o endereço para abrir o PR e o arquivo do corpo;
sem remoto, o `git merge --no-ff`.
Volta o checkout da raiz para a base só se ele estiver na integração ou numa entrega e sem
alteração versionada. Uma entrega aberta por projeto; a que ficou sem PR é retomada ao
rodar de novo. Não pega a trava do projeto: lê a integração uma vez.

Na abertura do `run`: entrega na base vira `merged` (branch local apagada); integrada só
no remoto ou por squash, o `run` avisa o que fazer.

**Pontos a refinar**

- PR fechado sem merge no GitHub não é detectado: a entrega continua aberta até o
  `--substituir`.

### rejeitar

**Para quê:** desfazer uma tarefa concluída na branch da unidade e devolvê-la ao
planejamento.

| Parâmetro | Efeito |
|---|---|
| `<n>` | Tarefa em `awaiting_merge` com merge na branch da unidade |
| `"<motivo>"` | Obrigatório; vai para o replanejamento |
| `--cancelar` | Cancela o item em vez de replanejar |

Pega a trava do projeto (não roda junto com `run`). Tarefa de spec: reverte o merge dela
na branch da spec num worktree temporário; conflito no revert: nada muda e a mensagem
aponta as tarefas concluídas depois nos mesmos arquivos ("rejeite antes #…"). Avulso: a
branch dele volta ao commit da base. A integração não é revertida: o próximo `run` a refaz.
Tarefa já na base: recusa ("reverta por lá"). Avisa as tarefas concluídas que dependem
dela (não as reverte). Regrava o relatório.

No REPL sem argumentos: número, motivo, `Cancelar o item em vez de replanejar? [s/N]`.

**Pontos a refinar**

- Sem confirmação no shell, apesar de reescrever a branch da unidade.
- Dependentes ficam concluídos e quebrados; poderia oferecer rejeitá-los junto.
- Não há rejeição para item em `awaiting_merge` sem integração (`integracao: null`): ali
  a "rejeição" é só não fazer o merge, e o item fica parado.

### status

**Para quê:** visão geral rápida.

| Parâmetro | Efeito |
|---|---|
| `--atualizar` | Faz uma chamada mínima (haiku, auditada, com custo) para ler o saldo agora |

Mostra: barras de saldo das janelas de 5h e 7 dias com o reset; se o cwd é um projeto,
o resumo do quadro (contagem por seção, detalhe de "Aguardando você" e "Em andamento") e
avisos do backlog; as 5 runs mais recentes **de todos os projetos**.

**Pontos a refinar**

- Mistura escopos: quadro do projeto atual com runs globais.
- Não detalha `blocked`/`failed`, que são os itens que mais precisam de ação.
- Não mostra se há `run` ativo no projeto (a trava sabe o pid), nem a última pausa da
  fila e o motivo.

### runs

**Para quê:** auditoria das execuções do Claude Code.

| Forma | Efeito |
|---|---|
| `runs` | Últimas 20 runs |
| `runs --limite <n>` | Últimas N |
| `runs <id>` | Detalhe; aceita prefixo único do id (ambíguo lista as candidatas) |

**Lista:** id (8), início, status, tipo (`exec`, `probe`, `plan #3`…), modelo, turnos,
duração, custo, prompt; total de custo. Em TTY, a tabela é trocada por um menu de
seleção (só a linha de total aparece) e a escolhida abre o detalhe.

**Detalhe:** tipo e item, status e erro, modelo (e o pedido, se diferente), sessão,
versão do claude, tempos, turnos, custo, tokens, diretório, prompt; linha do tempo das
ferramentas (`+tempo nome alvo · duração · erro`); caminhos do `stream.jsonl` e do
transcript.

**Pontos a refinar**

- Global: sem filtro por projeto, item, etapa, status ou período.
- Em TTY a tabela some; quem quer só ver a lista precisa de pipe.
- Do menu, escolher uma run encerra o comando: para ver outra, rodar de novo.
- Prefixo de id com tamanhos diferentes em cada tela (4 no `status`/`item`, 8 aqui).

### projetos

**Para quê:** listar os projetos registrados no banco.

| Parâmetro | Efeito |
|---|---|
| (nenhum) | Em TTY, menu de projetos (estados dos itens, runs, custo, raiz); o escolhido abre a auditoria. Fora de TTY, tabela |
| `--removidos` | Tabela dos projetos removidos (registro de `removals`) |

### projeto

**Para quê:** auditoria de um projeto e remoção dos dados dele no Mabel.

| Forma | Efeito |
|---|---|
| `projeto` | Em TTY, abre o menu de projetos; fora, erro |
| `projeto <nome>` | Auditoria; aceita nome ou prefixo do id |
| `projeto remover <nome>` | Mostra o que será apagado e pede o nome digitado para confirmar (TTY) |
| `projeto remover <nome> --confirmar <nome>` | Remove sem perguntar (exigido fora de TTY) |

**Auditoria:** totais de runs, custo e tokens; custo por etapa e por modelo; itens com
estado, tentativas, custo, se foi refinado, perguntas e suposições; bloco "Refinamento" com
a média de perguntas, suposições e replanejamentos dos itens refinados e dos não refinados; gates reprovados; escalonamentos de modelo; decisões
autônomas; pausas da fila e decisões de saldo; últimas 20 transições.

**Remoção:** recusa se há run em andamento, `run` ativo (trava) ou worktree com alteração
sem commit. Avisa itens integrados que não chegaram à base. Apaga as linhas do projeto
no banco e os diretórios (`runs/`, `items/`, `worktrees/`, `locks/`), registra em
`removals`. Não toca no repositório: imprime os comandos `git worktree prune` e
`git branch --list 'mabel/*'`.

**Pontos a refinar (projetos e projeto)**

- `projetos` e `projeto` são dois comandos quase iguais (o segundo sem argumento faz o
  mesmo que o primeiro). Poderia ser um só.
- `remover` como palavra reservada colide com um projeto chamado `remover`.
- A auditoria de projeto e o `status` se sobrepõem em parte (estados dos itens), mas com
  formatos diferentes.
- Fora de TTY, `projetos` lista; `projeto` sem argumento dá erro. Inconsistente.

### exec

**Para quê:** conversar com o Claude Code fora do backlog (analisar o projeto, tirar
dúvidas), com a mesma auditoria das etapas.

| Parâmetro | Efeito |
|---|---|
| `"<prompt>"` | Obrigatório (palavras soltas são juntadas) |
| `--model <m>` | Modelo do claude |
| `--max-turns <n>` | Inteiro positivo |
| `--max-budget-usd <x>` | Número positivo |
| `--allowed-tools <a,b>` | Ferramentas liberadas, separadas por vírgula |
| `--cwd <dir>` | Diretório de trabalho (padrão: o atual); precisa existir |

Mostra o cabeçalho (`▸ run abcd… · modelo · cwd`), cada ferramenta e o texto final.

**No terminal, é uma conversa.** Todo `exec` abre uma sessão nova. Depois de cada
resposta, o `exec ›` pede a próxima mensagem, que vira uma run nova retomando a mesma
sessão do claude (`--resume`). A sessão só encerra por ação consciente:

| Tecla | Efeito |
|---|---|
| `sair` ou Ctrl+D na linha vazia | Encerra e mostra o total da sessão (mensagens, duração, custo, tokens). Código 0 |
| Enter na linha vazia | Nada; pede de novo |
| Ctrl+C na pergunta | Lembra como encerrar |
| Ctrl+C durante a resposta | Interrompe só aquela resposta e volta ao `exec ›`. Se a sessão ainda não tinha começado, a próxima mensagem abre uma nova (com aviso) |

Cada resposta termina com uma linha curta (status, duração, custo). `--max-budget-usd`
vale para a sessão inteira: cada mensagem recebe o que resta, e a sessão encerra quando
ele acaba. `--max-turns` vale por mensagem; `--model`, `--allowed-tools` e `--cwd` ficam
fixos na sessão. No `mabel runs <id>`, a run mostra a posição na conversa
(`sessão … · mensagem 2 de 3`).

**Sem terminal** (pipe, scripts, clientes), roda uma mensagem só, com o resumo completo
(turnos, duração, custo, tokens). Ctrl+C interrompe (130). No REPL sem argumentos, pede
só o prompt.

A conversa é de leitura: sem `--allowed-tools`, as ferramentas que pedem permissão
(Edit, Write, Bash que altera algo) são recusadas pelo `claude -p`, a menos que as suas
configurações do `~/.claude` as liberem.

**Pontos a refinar**

- A run não pertence a projeto nenhum: não aparece na auditoria do projeto nem é apagada
  na remoção, mesmo rodando dentro dele.
- Roda sem sandbox e sem hook de escopo: só as etapas recebem o `settings.json` com eles
  (`src/stages.ts`). Destoa do resto do Mabel.
- No REPL não há como passar opções pelas perguntas.
- A correção que sai de uma conversa ainda não vira item do backlog sozinha: o caminho
  é o `add` ou o `refinar`.

### completion

**Para quê:** autocompletar no zsh. Só no shell.

| Forma | Efeito |
|---|---|
| `completion zsh` | Imprime o script (uso: `eval "$(mabel completion zsh)"` no `.zshrc`) |
| outro shell | Erro, sai com 1 |

Completa nomes de comandos, `completion zsh`, `projeto remover` e `projetos --removidos`.

**Pontos a refinar**

- Não completa opções dos outros comandos (`--item`, `--replanejar`…), nem números de
  item, nomes de projeto ou ids de run.
- Só zsh (bash e fish ficam de fora).

---

## Problemas transversais

1. **`--help` não funciona no modo Mabel.** O tratamento de `--help` está só no
   `cli.ts`. No REPL, `/run --help` dá "Unknown option", `/item --help` dá "Informe o
   número do item". E o `--help` do shell mostra uma linha de uso, sem explicar as opções.
2. **Itens sem saída.** `failed` só sai por `cancelar`: a transição `failed → ready`
   existe na máquina de estados, mas nenhum comando a usa. `blocked` por falha do `setup`
   também: só o bloqueio por erro de formato do backlog se desfaz sozinho. Falta um
   `retomar <n>`/`tentar-de-novo <n>`.
3. **Não há lista de itens.** Ver nota em [item](#item).
4. **Idiomas misturados nos nomes.** Comandos: `init`, `add`, `run`, `item`, `exec`,
   `status`, `runs`, `inbox`, `completion` em inglês; `aprovar`, `responder`, `cancelar`,
   `rejeitar`, `integracao`, `projetos`, `projeto` em português. Opções também
   (`--stack`, `--model` × `--intencao`, `--uma`, `--limite`).
5. **Confirmação inconsistente.** `cancelar` confirma no REPL e não no shell; `rejeitar` e
   `aprovar` não confirmam em lugar nenhum; `projeto remover` exige digitar o nome.
6. **Perguntas do REPL não olham o estado.** `promptArgs` pede número e depois resposta
   sem mostrar o item nem validar antes; o "Replanejar?" aparece mesmo quando não se
   aplica. O BACKLOG já tem "autocompletar de argumentos" como ideia relacionada.
7. **Ordem da lista não segue a jornada.** `inbox`, a ação mais frequente depois do `run`,
   aparece em 14º. Sugestão de agrupamento: preparar (`init`, `add`, `refinar`), rodar (`run`,
   `inbox`), decidir (`item`, `aprovar`, `responder`, `cancelar`), integrar (`integracao`,
   `rejeitar`), auditar (`status`, `runs`, `projetos`, `projeto`), avulsos (`exec`,
   `completion`).
8. **Decisões sem trava.** `aprovar`, `responder` e `cancelar` não pegam a trava do
   projeto e podem rodar no meio de um `run` em outro terminal. A transição é validada,
   então não corrompe o estado, mas o `run` em curso pode pegar o item na hora seguinte
   sem que o usuário espere (a confirmar se é desejado).
9. **README desatualizado.** A tabela de comandos não tem `integracao`, `rejeitar`,
   `runs`, `projetos` e `projeto`; o passo 4 dos primeiros passos descreve o merge por
   branch de item, não a integração.
10. **Configuração invisível.** Nenhum comando mostra ou altera `config.json`
    (modelos, limites, `autonomia`, `integracao`, `rede`, `sandbox`).

---

## Perguntas

1. **Lista de itens:** criar `itens` (ou `item` sem número lista)?
   *Sugestão:* `item` sem número lista os itens com estado e pendência; no REPL, abre o
   menu de seleção como `runs` e `projetos`.
2. **Itens em `failed`/`blocked`:** como sair sem cancelar?
   *Sugestão:* `retomar <n>` leva `failed → ready` e `blocked → backlog`, com o motivo na
   transição.
3. **`cancelar` em item integrado:** recusar ou reverter?
   *Sugestão:* recusar com "use `rejeitar <n> --cancelar`", para que só um caminho mexa
   na integração.
4. **Idioma dos comandos:** padronizar?
   *Sugestão:* tudo em português nos comandos e opções novos; para os atuais, manter
   `init`, `run`, `status` (curtos e conhecidos) e decidir caso a caso, com aliases por um
   tempo.
5. **`--help` no REPL:** tratar no `parseLine`?
   *Sugestão:* sim, e enriquecer o texto de uso de cada comando com uma linha por opção.
6. **`run --uma` × `--sem-lote`:** manter os dois?
   *Sugestão:* manter `--sem-lote` e trocar `--uma` por `--limite <n>`; acrescentar
   `--so-planejar`.
7. **`--item` com outro item em andamento:** o que fazer?
   *Sugestão:* avisar e perguntar (TTY) ou recusar (fora de TTY), em vez de processar o
   outro em silêncio.
8. **`projetos` × `projeto`:** fundir?
   *Sugestão:* `projetos` lista e abre a auditoria; `projeto remover` vira
   `projetos remover`.
9. **Confirmações:** qual regra?
   *Sugestão:* ações que reescrevem git ou são irreversíveis (`cancelar`, `rejeitar`)
   confirmam em TTY e aceitam `--sim` fora dele; `aprovar` mostra critérios e confirma.
10. **`exec`:** manter no menu principal?
    *Sugestão:* manter, mas associar a run ao projeto do cwd quando houver, para entrar na
    auditoria e na remoção.
11. **Levar a integração à base:** comando próprio?
    *Sugestão:* discutir à parte; tocar na base é a fronteira do contrato e pode ficar
    manual. Ao menos o `integracao` deveria imprimir o comando git exato.
