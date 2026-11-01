# Especificação — Novo terminal do Mabel

Refatoração completa da interface interativa: a tela inicial vira uma lista de comandos
navegável, cada comando abre uma tela guiada e o `mabel rodar` mostra a fila como um
painel que se atualiza no lugar. Substitui o modo Mabel com `/` de
`docs/specs/interface.md` (incremento 2.4).

## Referência visual e funcional

O protótipo é parte desta especificação: `docs/specs/terminal.html` (arquivo único, abra no
navegador), publicado em https://claude.ai/artifact/946voX6LB3a7pNxprHQBUV.

- A implementação reproduz o protótipo: layout, textos, símbolos, ordem dos grupos, campos
  de cada comando, teclas, mensagens e comportamento. Onde esta spec e o protótipo
  divergirem, vale o protótipo, e a divergência é corrigida na spec.
- Desvio só quando reproduzir for inviável no terminal (limite técnico real, não
  preferência). Todo desvio é registrado no histórico do `docs/PLANO.md` com o motivo e
  trazido ao usuário como pergunta, com a sugestão.
- O protótipo usa dados de exemplo e tempo acelerado; esses dois pontos não são normativos.
- As cores do protótipo mapeiam para os estilos de `src/style.ts`: acento, esmaecido,
  negrito, verde, amarelo, vermelho e a faixa de seleção (fundo invertido ou cor de
  seleção do terminal).

## Premissa: interface guiada

Tudo o que dá para fazer está na tela. Nenhuma ação depende de lembrar um comando, uma
tecla ou uma sintaxe.

- Toda escolha é item de menu ou campo de formulário navegável.
- Só valem as teclas universais, sempre listadas no rodapé da tela: ↑ ↓ para navegar, ← →
  para trocar uma escolha, enter para abrir ou confirmar, espaço para marcar, esc para
  voltar, e digitar para filtrar uma lista ou editar um campo de texto.
- Proibido no modo interativo: "enter mantém · - remove · texto substitui", "responda
  enter, e ou -", "[s/N]", "q para sair", "um por linha, linha vazia encerra", "d decide
  você", "p pula o item", número de item digitado.
- Fora do TTY e com `--json`, nada muda: os comandos continuam aceitando argumentos e
  flags, e a saída continua estável para scripts e para o `mabel-ui`.

### Padrões de conversão

| Hoje | Na interface guiada |
|---|---|
| `[s/N]`, `[S/n]` | Dois itens: a ação ("Cancelar o item", "Rodar mesmo assim") e "Voltar". O item seguro vem selecionado. |
| "enter aceita · e edita · - descarta" | Menu: "Aceitar tudo", "Revisar um a um", "Descartar". |
| "enter mantém · - remove · texto substitui" | Para cada entrada, menu: "Manter", "Editar", "Remover". "Editar" abre o campo de texto já preenchido. |
| "um por linha, linha vazia encerra" | Lista repetível: entradas existentes e "+ adicionar" (como "Critérios de aceite" em "Adicionar um item"). |
| Pergunta com "enter aceita a sugestão · texto responde · d decide você · p pula" | A sugestão escrita abaixo da pergunta ("sugestão: <texto>") e o menu: "Aceitar a sugestão", "Responder com outro texto", "Deixar a decisão para você" (quando permitido), "Pular por agora". |
| "Número do item: " | Lista de itens filtrada pelo estado em que o comando faz sentido. |
| "Digite o nome do projeto para confirmar" | Mantém o campo de texto (é a confirmação de uma remoção), dentro do formulário. |
| `$EDITOR` para editar a proposta | Continua, como item "Editar no editor" no menu da revisão. |

### Inventário a converter

Levantado no código em 2026-10-31; a implementação confere de novo antes de começar.

| Arquivo | Pontos |
|---|---|
| `src/birth.ts` | perguntas da rodada; escolha de stack; revisão de CLAUDE.md, regras e backlog; "Rodar mesmo assim? [s/N]"; "Retomar? [S/n]" |
| `src/engine.ts` | perguntas do refinamento e da spec; revisão de listas, regras, tarefas e reprodução |
| `src/inbox.ts` | perguntas da inbox; "Cancelar o item? [s/N]"; orientação do replanejamento; "Retomar a esteira agora? [S/n]" |
| `src/init.ts` | "Qual stack?"; "Usar estes comandos? [S/n/editar]"; edição dos comandos de verificação; extras "um por linha"; "Commitar o .mabel/?" |
| `src/add.ts` | campos perguntados um a um; "Refinar o item agora?" |
| `src/decide.ts` | número do item, resposta e confirmações de aprovar, responder, cancelar e rejeitar |
| `src/delivery.ts` | "Entregar só o que está pronto? [s/N]" |
| `src/run.ts` | confirmação da política de saldo |
| `src/refine.ts`, `src/specify.ts` | "mesmo assim? [s/N]"; "Pedir outra proposta? [s/N]" |
| `src/projects.ts` | confirmação da remoção |
| `src/exec.ts` | prompt avulso |
| `src/menu.ts` | "q sair" no rodapé do menu de seleção |

## Decisões

| Tema | Decisão |
|---|---|
| Entrada | Sem argumentos no TTY, o Mabel abre a tela inicial. Com argumentos, roda o comando como hoje. |
| Tela inicial | Linha com "mabel", o projeto e o caminho; linha com o que espera por você (prontos, pendências, unidades prontas); campo de filtro "o que você quer fazer?"; lista agrupada; descrição do comando selecionado; rodapé com as teclas e o saldo. Sem desenho nem animação por enquanto. |
| Grupos | Começar, Planejar, Rodar, Decidir, Entregar, Acompanhar, Avulso. Decidir sobe para o topo quando há pendência; Rodar, quando há itens prontos. Começar só aparece onde o Mabel não foi preparado; ali aparecem também os comandos que não dependem do projeto (Listar e Auditar projetos, Pedir algo avulso). |
| Linha do comando | Título com verbo à esquerda; à direita, contagem quando houver ("2 esperando", "2 prontos", "1 pronta") e o nome no shell (`mabel rodar`). |
| Nomes no shell | Um verbo por comando, igual ao do título; sem apelidos para os nomes antigos (tabela abaixo). |
| Menos comandos no menu | O saldo entra em "Conferir o estado"; a lista das unidades prontas entra em "Entregar uma unidade". |
| Tipos de tela | Formulário, escolha de item, vista e fluxo (seção "Telas"). Todo comando novo cabe em um deles. |
| Painel da fila | Lista que se atualiza no lugar, uma linha por item, etapas do item ativo (seção "Painel da fila"). Só no TTY. |
| Frase do agente | Padronizada, montada pelo Mabel a partir das ferramentas ("editando src/x.ts · 2 arquivos alterados"); não vem do texto do agente. |
| Tela cheia | O menu e as telas abrem no buffer alternativo do terminal, como o vim. Ao sair de uma tela, o resultado é impresso no terminal comum, acima do menu, para ficar na rolagem (a validar no primeiro uso). Os fluxos que rodam no terminal comum (seção "Telas") esperam enter ou esc antes de a tela inicial voltar; não há menu "Voltar ao menu" / "Sair do Mabel" (esc com o filtro vazio sai). |
| Volta da fila | Quando a fila termina, ou quando o usuário a solta com ctrl+c, a tela volta ao menu com o resumo da fila. |
| Digitar | Na tela inicial, digitar filtra a lista. O `add` assistido, quando existir, vira um comando próprio. |
| Ações que apagam | O botão vermelho basta para cancelar e rejeitar. Remover projeto pede o nome digitado no formulário ("Confirme o nome") e recusa se não conferir. |
| Retomar | "Retomar um item" (`mabel retomar`) no grupo Decidir: lista os itens parados em `failed` ou `blocked`, mostra o motivo e aceita uma orientação opcional. |
| Decidir | "Decidir as pendências" abre com a lista das pendências (respostas e aprovações) e o item "Passar por todas"; escolher uma pendência decide só ela. "Aprovar critérios" e "Responder a um item" saem do menu e ficam só no shell (`mabel aprovar`, `mabel responder`), para scripts e para a UI futura. |
| Terminal estreito | Abaixo de 88 colunas some o nome do shell à direita; abaixo de 60, somem também as contagens ("2 esperando", "2 prontos"), que já estão na segunda linha da tela. Os títulos nunca são cortados. |
| Saldo e integração no shell | `saldo` sai do menu e fica no shell, como `eventos` e `comandos`, porque o contrato de integração documenta `mabel saldo --json`. `integracao` sai do shell: `entregar` sem argumentos mostra o mesmo, e nenhum programa o consome. |
| Quantos itens | "Rodar a fila" troca o modo "o próximo item e para" (`--uma`) pelo campo "Quantos itens" (`--limite <n>`). |

### Nomes

| Título | Shell novo | Hoje |
|---|---|---|
| Preparar este projeto | `preparar` | `init` |
| Criar um projeto novo | `criar` | `nascer` |
| Adicionar um item | `adicionar` | `add` |
| Especificar uma funcionalidade | `especificar` | `especificar` |
| Refinar um item | `refinar` | `refinar` |
| Capturar uma referência | `capturar` | `referencia` |
| Credenciar um token | `credenciar` | `credencial` |
| Rodar a fila | `rodar` | `run` |
| Acompanhar a fila | `acompanhar` | `anexar` |
| Parar a fila | `parar` | `parar` |
| Decidir as pendências | `decidir` | `inbox` |
| Retomar um item | `retomar` | (novo) |
| Cancelar um item | `cancelar` | `cancelar` |
| Entregar uma unidade | `entregar` | `entregar` (absorve `integracao`) |
| Rejeitar um item | `rejeitar` | `rejeitar` |
| Conferir o estado | `conferir` | `status` (absorve `saldo`) |
| Detalhar um item | `detalhar` | `item` |
| Consultar as runs | `consultar` | `runs` |
| Listar os projetos | `listar` | `projetos` |
| Auditar um projeto | `auditar` | `projeto` |
| Pedir algo avulso | `pedir` | `exec` |

Ficam fora do menu, só no shell: `aprovar` e `responder` (cobertos por "Decidir as
pendências"), `saldo`, `supervisor`, `eventos`, `comandos` e `completion`. `integracao`
sai.

## Telas

Todas as telas mantêm as duas linhas do topo (projeto e o que espera por você) e o rodapé
com as teclas daquela tela e o saldo. Cada tela abre com "‹ <título>", a descrição em
itálico e, à direita, o nome no shell.

### Formulário

Um campo por argumento ou opção do comando, na ordem do protótipo.

- **Texto:** mostra o valor ou o exemplo esmaecido; enter edita; começar a digitar também
  edita.
- **Escolha:** "◂ valor ▸"; ← → ou enter trocam.
- **Marcar:** "[x] sim" / "[ ] não"; espaço ou enter trocam.
- **Lista:** abre a escolha de item (uma ou várias, com "[x]").
- **Lista repetível:** abre as entradas com "+ adicionar"; editar uma entrada e deixá-la
  vazia a remove.
- **Informação:** linhas só de leitura que dependem do que foi escolhido (critérios do
  item a retomar, critérios da pendência a aprovar).
- **Campos condicionais:** só aparecem quando fazem sentido ("Item" em "Rodar a fila" no
  modo "só um item"; "Escala" só quando a tela vem de um link do Figma).
- **Botão de ação:** "[ <ação> ]"; enquanto faltar campo obrigatório, fica esmaecido e
  mostra "falta: <campos>". Ações que apagam ou revertem têm o botão em vermelho.
- **Linha de shell:** embaixo, "$ mabel …" com o comando equivalente, atualizado a cada
  mudança e quebrado em linhas quando não cabe. Campo vazio não entra na linha.
- **O botão** roda o comando com os argumentos da linha de shell. Nos comandos sem conversa
  (adicionar, capturar, credenciar, retomar, cancelar, rejeitar, detalhar, auditar, rodar
  em segundo plano e parar), roda sem perguntas, exatamente como a linha fora do TTY, e o
  resultado aparece numa vista ("✓ <ação>", a saída do comando e a linha de shell). Criar,
  preparar, especificar, refinar, rodar, entregar e pedir rodam no terminal comum, com as
  rodadas, revisões e a saída de hoje; o entregar, sem perguntas (o formulário já
  respondeu a entrega parcial).
- **Valor longo** num campo é cortado com "…"; ao editar, o campo mostra o trecho do cursor.

### Escolha de item

Lista só com as opções no estado em que o comando faz sentido, cada uma com o estado à
direita ("pronto", "esperando você", "aguardando aprovação", "na unidade", "rascunho").
Lista vazia mostra "Nenhum item nesse estado agora."

### Vista

Saída só de leitura: "Conferir o estado", "Consultar as runs", "Listar os projetos",
"Detalhar um item" e o resultado de cada formulário. Enter ou esc voltam ao menu. Vista mais
alta que a tela rola com ↑ ↓ ("↑ mais N", "↓ mais N"), e o rodapé diz "↑↓ rola". "Acompanhar
a fila" sem fila em segundo plano e "Parar a fila" sem fila rodando são vistas com o aviso.

### Fluxo

- **Decidir as pendências:** abre com a lista das pendências e "Passar por todas"; depois,
  uma decisão por vez ("1 de 2"), com o item, o tipo da pendência ("perguntas do
  planejamento", "tentativas esgotadas"…), a pergunta ou os critérios e o menu de opções da
  inbox; no fim, o resumo do que foi decidido. Esc no menu de uma pendência sai do fluxo:
  o que já foi decidido fica, e o resumo diz o que continua esperando você.
- **Rodar a fila** e **Acompanhar a fila:** abrem o painel da fila (T.4); até lá, a saída de
  hoje no terminal comum.
- **Parar a fila:** com fila rodando, confirma com o botão "Parar depois da etapa"; sem
  fila, diz que não há fila rodando.
- **Criar um projeto novo, Refinar, Especificar:** as rodadas e revisões de hoje, com o
  mesmo conteúdo e as mensagens convertidas pelos padrões da premissa.

## Painel da fila

Conforme a aba "Fila (rodar)" do protótipo.

- Cabeçalho com a fase (planejamento ou execução), a contagem da fila e a hora.
- Uma linha por item: ✓ concluído (tempo e custo), ● em andamento, ◌ pendente, ⏸ esperando
  você (com a pendência e a indicação de "Decidir agora" na barra de ações).
- Do item em andamento, as etapas da fase atual: no planejamento, planejar e critério de
  início (G2); na execução, "✓ planejar · plano aceito", executar, verificação, escopo,
  prova, revisar e merge na unidade. Os gates ficam em linhas próprias enquanto o item
  roda; ao concluir, o item recolhe para uma linha.
- Etapa ativa: ⠹ girando, modelo, turno e tempo; abaixo, a frase padronizada e a contagem
  de ferramentas.
- Barra de ações no rodapé, navegável com ← → e enter: "Mostrar ferramentas" (as seis
  últimas, com ✓/✗), "Mostrar concluídos" (as etapas dos três últimos), "Decidir agora"
  (só quando há item esperando você; abre "Decidir as pendências") e "Parar depois da
  etapa". Com a fila encerrada: "Voltar ao menu". Nenhum atalho de uma tecla.
- Nova tentativa: ↻ com a causa mecânica da anterior e "tentativa 2/3".
- Pausa por saldo: aviso com a janela, o limite e "faltam 41m".
- Ficam na tela os três últimos concluídos, com "+N concluídos" acima.
- Terminal baixo recolhe nesta ordem: ferramentas abertas, pendentes ("+N na fila"),
  concluídos. O item ativo e o rodapé nunca são cortados; abaixo do mínimo de linhas, volta
  o log de hoje.
- Fora do TTY, a saída de hoje sem mudança. O detalhe continua no banco e no transcript
  (G1).

## Mudanças em outros documentos

- `docs/CONTRATO.md` cita `mabel nascer`, `mabel add`, `mabel run`, `mabel entregar`,
  `mabel especificar`, `mabel rejeitar`, `mabel init` e `mabel projeto`. Troca dos nomes
  autorizada pelo usuário em 2026-10-31; entra no contrato junto com o T.2, sem mudar
  nenhuma garantia.
- `docs/ESTEIRA.html`: comandos e o que gravam, na mesma mudança.
- `docs/INTEGRACAO.md` e `docs/specs/integracao-externa.md`: nomes novos no catálogo do
  `comandos --json`.
- `docs/specs/interface.md`: o incremento 2.4 passa a apontar para esta spec.
- `docs/MENU.md`: atualizado ou aposentado no fim.

## Incrementos

Cada um termina com `npm run check` verde, critérios de aceite atendidos, `docs/PLANO.md`
atualizado e um commit.

1. **Componentes de tela.** Formulário, escolha (uma e várias), lista repetível, menu de
   opções, campo de texto, vista e rodapé de teclas, puros e testáveis como os de
   `src/menu.ts` e `src/line.ts`. Converte todos os pontos do inventário para os padrões da
   premissa, ainda com os nomes de hoje.
2. **Tela inicial e nomes novos.** Lista agrupada com ordem pelo momento, filtro e
   contagens; renomeação no shell, no catálogo e no autocompletar; documentos acima
   (contrato autorizado).
3. **Telas dos comandos.** Um formulário, vista ou fluxo por comando, como no protótipo, com
   a linha de shell.
4. **Painel da fila.** O `mabel rodar` e o `mabel acompanhar` no TTY.

### Critérios de aceite

- Cada tela, campo, texto e símbolo confere com o protótipo; desvios registrados no
  histórico do plano.
- Nenhuma mensagem do modo interativo pede tecla com significado próprio, `[s/N]` ou texto
  com sintaxe; um teste percorre as mensagens das telas e falha se encontrar esses padrões.
- O rodapé de toda tela lista as teclas que funcionam nela.
- Fora do TTY e com `--json`, a saída e os argumentos de cada comando continuam aceitos e
  estáveis (com os nomes novos).
- A linha de shell de cada formulário, executada fora do TTY, faz o mesmo que o botão.

## Perguntas em aberto

Nenhuma. Pergunta nova durante a implementação segue o método do `CLAUDE.md`: a
recomendação é aplicada, registrada no histórico do `docs/PLANO.md` e trazida no fim.

## Fora desta especificação

- Desenho ou animação na tela inicial (três tentativas no protótipo não funcionaram; o
  usuário volta ao tema depois).
- O `add` assistido.
- Interface gráfica: a doc de integração segue ativa para uma UI futura.
