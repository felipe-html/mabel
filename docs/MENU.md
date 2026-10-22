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
- Comandos: [init](#init) · [add](#add) · [refinar](#refinar) · [run](#run) · [inbox](#inbox) · [item](#item) ·
  [aprovar](#aprovar) · [responder](#responder) · [cancelar](#cancelar) ·
  [integracao](#integracao) · [rejeitar](#rejeitar) · [status](#status) · [runs](#runs) ·
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
`MABEL_NOTIFICAR=0`, `NO_COLOR`.

---

## Mapa rápido

Ordem em que aparecem na lista (a mesma de `src/commands.ts`).

| Comando | Sintaxe | Precisa de projeto | Pergunta no REPL sem args | Trava do projeto | Fora de TTY |
|---|---|---|---|---|---|
| `init` | `init [--stack node\|python\|go\|rust]` | não (cria) | — (o próprio comando pergunta) | não | sem perguntas |
| `add` | `add "<título>" [--intencao] [--criterio]… [--fora-do-escopo]… [--depende]… [--restricoes]` | sim | — (o próprio comando pergunta) | não | exige título e `--intencao` |
| `refinar` | `refinar [<n>] [--refazer] [--aceitar \| --descartar]` | sim | — (o próprio comando abre o menu de itens) | não | sem `<n>` lista; com `<n>` mostra a proposta; `--aceitar` grava |
| `run` | `run [--item <n>] [--uma] [--sem-lote]` | sim | não | **sim** | sem perguntas; política decide |
| `item` | `item <n>` | sim | número | não | igual |
| `aprovar` | `aprovar <n>` | sim | número | não | igual |
| `responder` | `responder <n> "<resposta>" [--replanejar]` | sim | número, resposta, replanejar? | não | igual |
| `cancelar` | `cancelar <n>` | sim | número + confirmação | não | igual, **sem confirmação** |
| `integracao` | `integracao` | sim | não | não | igual |
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

### refinar

**Para quê:** antes do planejamento, pedir a um agente uma proposta de critérios, fora do
escopo, decisões de negócio e regras críticas de um item, e gravar no `backlog.md` só o que
você aceitar. Spec: `docs/specs/refinamento.md`.

| Parâmetro | Efeito |
|---|---|
| (nenhum) | TTY: menu dos itens refináveis com estado e situação; o escolhido abre a revisão e o menu volta ao terminar (`q` sai). Fora de TTY: tabela `# · título · estado · refinamento` |
| `<n>` (aceita `#3`) | Usa a proposta pendente ou roda o agente; no TTY abre a revisão, fora dele imprime a proposta e como aceitar |
| `--refazer` | Descarta a proposta pendente e roda o agente de novo |
| `--aceitar` | Grava a proposta como veio (perguntas com sugestão viram decisões; as sem sugestão ficam para o planejamento). Pensado para fora do TTY |
| `--descartar` | Descarta a proposta pendente sem gravar |

Só itens em `backlog` ou `ready` que nunca entraram em planejamento. Situações: `não
refinado`, `proposta pendente`, `proposta desatualizada` (o item mudou depois da
proposta; o agente roda de novo), `refinado`, `descartado`. Item já refinado: no TTY,
pergunta `Pedir outra proposta ao agente? [s/N]` antes de gastar outra run.

**A run:** etapa `refine`, só leitura (`Read`, `Glob`, `Grep`) na raiz do projeto, com as
travas das outras etapas; modelo `models.refine` (padrão `sonnet`), limites
`limits.refine` (30 turnos, US$ 1). Antes dela, a política de saldo numa chamada: sem
leitura recente faz a chamada mínima; saldo baixo ou acima do ritmo pergunta
`Refinar mesmo assim? [s/N]` (TTY) ou recusa. Ctrl+C interrompe a run (sai com 130).

**Revisão (TTY)**

| Etapa | Entradas aceitas |
|---|---|
| Entendimento do agente | — (só leitura) |
| Cada pergunta, com a sugestão | Enter aceita a sugestão · texto responde · `p` deixa para o planejamento |
| Critérios, fora do escopo, regras críticas propostos | Enter aceita · `e` edita um a um (Enter mantém, `-` remove, texto substitui, depois acrescenta até linha vazia) · `-` descarta |
| Quebra sugerida | — (informativa; crie os itens com `/add`) |
| Prévia do bloco e `Gravar no backlog? [S/n/d]` | Enter grava · `n` deixa a proposta pendente · `d` descarta |

Respostas viram `Decisões: - <pergunta> → <resposta>`. A gravação acrescenta sem repetir
entradas iguais, regrava só o trecho do item no `backlog.md` e sincroniza. Ctrl+C na
revisão deixa a proposta pendente.

**Pontos a refinar**

- A quebra sugerida não é aplicada; criar os itens e ajustar o original é manual.
- Comentários HTML no meio do bloco do item somem quando a proposta é gravada.
- `--aceitar` e `--descartar` exigem o número; não há "aceitar todas as pendentes".
- O `run` não avisa sobre itens `ready` nunca refinados.

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

- `.mabel/` commitado na branch base.
- Sandbox disponível, a menos que `"sandbox": false` (aí imprime um aviso).
- Trava do projeto: um `run` por projeto de cada vez.

**Durante**

- Abertura: cria ou atualiza a branch de integração (pode pausar a fila se ela estiver
  aberta num worktree ou divergir da base com conflito), remove worktrees órfãos, marca
  `done` os itens já levados à base e regrava o relatório da integração.
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
| Impedimento de ambiente | O motivo declarado pelo executor e o que ajustar | texto diz o que mudou no ambiente e retoma · `r <texto>` replaneja · `c` cancela · `p` pula |
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

**Para quê:** ver o relatório da branch de integração (`mabel/integracao`): o que levar
à base e o que olhar primeiro.

Sem parâmetros (argumentos ignorados). Regrava `.mabel/integracao.md` e imprime o mesmo
conteúdo: por item integrado, plano, arquivos alterados, prova, devoluções por gate,
custo.

**Pontos a refinar**

- É só leitura: **levar a integração à base** é manual (`git merge` fora do Mabel). O
  README ainda manda "fazer o merge da branch de cada item", texto de antes da
  integração.
- Não atualiza estados: itens já levados à base só viram `done` no próximo `run` (a
  confirmar se o relatório os mostra até lá).
- Não tem atalho para abrir o diff de um item.

### rejeitar

**Para quê:** desfazer a entrega de um item integrado e devolvê-lo ao planejamento.

| Parâmetro | Efeito |
|---|---|
| `<n>` | Item em `awaiting_merge` com commit na integração |
| `"<motivo>"` | Obrigatório; vai para o replanejamento |
| `--cancelar` | Cancela o item em vez de replanejar |

Pega a trava do projeto (não roda junto com `run`). Reverte o merge do item na branch de
integração num worktree temporário. Conflito no revert: nada muda e a mensagem aponta os
itens integrados depois nos mesmos arquivos ("rejeite antes #…"). Item já na base: recusa
("reverta por lá"). Avisa os itens integrados que dependem dele (não os reverte). Regrava
o relatório.

No REPL sem argumentos: número, motivo, `Cancelar o item em vez de replanejar? [s/N]`.

**Pontos a refinar**

- Sem confirmação no shell, apesar de reescrever a branch de integração.
- Dependentes ficam na integração quebrados; poderia oferecer rejeitá-los junto.
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

**Para quê:** rodar um prompt avulso no Claude Code, com a mesma auditoria das etapas.

| Parâmetro | Efeito |
|---|---|
| `"<prompt>"` | Obrigatório (palavras soltas são juntadas) |
| `--model <m>` | Modelo do claude |
| `--max-turns <n>` | Inteiro positivo |
| `--max-budget-usd <x>` | Número positivo |
| `--allowed-tools <a,b>` | Ferramentas liberadas, separadas por vírgula |
| `--cwd <dir>` | Diretório de trabalho (padrão: o atual); precisa existir |

Mostra o cabeçalho (`▸ run abcd… · modelo · cwd`), cada ferramenta, o texto final e o
resumo (turnos, duração, custo, tokens). Ctrl+C interrompe (130). No REPL sem argumentos,
pede só o prompt.

**Pontos a refinar**

- A run não pertence a projeto nenhum: não aparece na auditoria do projeto nem é apagada
  na remoção, mesmo rodando dentro dele.
- Roda sem sandbox e sem hook de escopo: só as etapas recebem o `settings.json` com eles
  (`src/stages.ts`). Destoa do resto do Mabel.
- No REPL não há como passar opções pelas perguntas.
- Para que serve no fluxo? Hoje parece ferramenta de diagnóstico da fase 1 do plano.

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
