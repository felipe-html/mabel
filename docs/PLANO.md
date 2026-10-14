# Plano de implementação

Backlog de construção do Mabel. Diferente do `BACKLOG.md` da raiz, que guarda ideias
ainda em discussão, aqui só entra o que já foi decidido e tem ordem de execução.

Ao concluir uma tarefa, marque-a e registre no histórico. O próximo passo é sempre o
primeiro item não marcado.

## Passo 1 — Estrutura e CLI ✅

- [x] `git init`, `package.json`, `tsconfig.json`, TypeScript sem build.
- [x] CLI `mabel` com registro de comandos e menu.
- [x] Banner lido de `assets/logo.txt` e `assets/titulo.txt`; desligável com `MABEL_BANNER=0`.
- [x] Autocompletar zsh (`mabel completion zsh`).
- [x] Testes com `node:test`.
- [x] `scripts/setup.sh`: preflight, instalação e verificação do ambiente.
- [x] Menu interativo ao rodar `mabel` sem argumentos (setas, números, enter, q).

## Passo 2 — Runner, auditoria e saldo

Especificação: `docs/specs/passo-2.md`.

- [x] 2.1 Banco SQLite, runner e `mabel exec` (G1).
- [x] 2.2 Leitura de saldo, `checkBalance`, probe e `mabel status`.

## Passo 3 — Projeto, backlog, fila e quadro ✅

Especificação: `docs/specs/passo-3.md`.

- [x] 3.1 Projeto e `mabel init` (detecção de comandos, projeto sem testes).
- [x] 3.2 Backlog: formato, parser, sincronização e `mabel add`.
- [x] 3.3 Máquina de estados, auditoria de transições e `quadro.md`.

## Passo 4 — Etapas, gates e `mabel run` ✅

Especificação: `docs/specs/passo-4.md`.

- [x] 4.1 Runner para etapas e worktree por item.
- [x] 4.2 Etapas com agente (planejar, executar, revisar) e saída estruturada.
- [x] 4.3 Gates G2 e G3, retentativas e escalonamento.
- [x] 4.4 `mabel run`, política de saldo e comandos de decisão.

## 🧪 Marco — Teste com aplicação real

Primeiro uso do Mabel num projeto descartável, com backlog escrito pelo usuário. Os
achados do teste orientam a especificação dos passos seguintes.

## Depois do teste

- [x] 2.4 Modo Mabel: prompt com comandos `/`, lista de autocompletar e histórico
      (`docs/specs/interface.md`). Substitui o menu como painel.
- [x] 3.4 `mabel init` por stack: catálogo Node/Python/Go/Rust e item da base de testes
      concreto (`docs/specs/interface.md`).
- [x] `init` commita o `.mabel/` (os worktrees nasciam sem config e backlog), `run` recusa
      começar sem ele na branch base, worktree sem commits próprios avança até a base, e
      planejador calibrado para perguntar só o que bloqueia.
- [x] Inbox: `/inbox` com perguntas uma a uma, sugestão de resposta, "decide você" e
      retomada da esteira (`docs/specs/inbox.md`).
- [x] Jornadas longas (`docs/specs/jornadas.md`):
  - [x] J.1 Autonomia nas perguntas: pergunta não crítica com sugestão não para o item.
  - [x] J.2 Estado `planned` e planejamento em lote no `run` (muda o ciclo de vida do contrato).
  - [x] J.3 Aviso do sistema quando a esteira para ou espera você.
- [x] Saldo eficiente e sempre visível (`docs/specs/saldo.md`): leitura antiga (30 min),
      consumo medido por etapa, projeção contra piso de 10%, ritmo da janela de 7 dias e
      rodapé fixo. Muda a política de saldo do contrato (autorizado).
- [x] Gravar no banco as pausas da fila (saldo de 7 dias, falta de leitura) e as respostas
      do humano às perguntas da política de saldo. Hoje só aparecem na saída (auditoria).
- [x] Gate de escopo depois da execução: arquivos alterados no commit do item conferidos
      contra o escopo do plano (fecha a escrita fora do escopo pelo terminal, dentro do worktree).
- [x] 2.3 `mabel runs` com lista e detalhe da run (`docs/specs/passo-2.md`).
- [x] Gestão de projetos no banco (`docs/specs/projetos.md`): `mabel projetos`, auditoria
      por projeto e `mabel projeto remover`.
- [x] Passo 5 — Travas (`docs/specs/passo-5.md`):
  - [x] 5.1 Contexto hermético (G8).
  - [x] 5.2 Sandbox e ferramentas por etapa (G4, terminal e rede).
  - [x] 5.3 Hook de escopo (G4, arquivos).
  - [x] 5.4 Contrato, preflight e documentação.
- [x] Prova e integração (`docs/specs/prova-e-integracao.md`):
  - [x] P.1 Veredito calculado (revisor não declara aprovação).
  - [x] P.2 Prova mecânica: vermelho na base, verde no item.
  - [x] P.3 Limpeza de worktrees e branches.
  - [x] P.4 Branch de integração.
  - [x] P.5 Relatório da integração e `mabel rejeitar`.

## Histórico

| Data | Registro |
|---|---|
| 2026-10-11 | Contrato v0 fechado (`docs/CONTRATO.md`). |
| 2026-10-11 | Passo 1 concluído. |
| 2026-10-11 | Script de setup do ambiente (`scripts/setup.sh`). |
| 2026-10-11 | Menu interativo na tela inicial. |
| 2026-10-11 | Especificação do passo 2 (`docs/specs/passo-2.md`). |
| 2026-10-11 | Especificações dos passos 3 e 4; ordem revista para antecipar o teste com aplicação real. |
| 2026-10-11 | Incremento 2.1: banco SQLite, runner e `mabel exec`, validado com run real em haiku. |
| 2026-10-11 | Incremento 2.2: saldo, `checkBalance`, probe e `mabel status`; probe validado com o `claude` real. |
| 2026-10-11 | Incremento 3.1: projeto, `mabel init` com detecção de comandos e item de base de testes. |
| 2026-10-11 | Incremento 3.2: parser e sincronização do backlog, `mabel add`. A função `transition()` e a tabela `item_transitions` entraram aqui, porque a sincronização já muda estados. |
| 2026-10-11 | Incremento 3.3: tabela de transições testada, quadro completo e `mabel status` com resumo do projeto. Passo 3 concluído. |
| 2026-10-11 | Incremento 4.1: flags de etapa no runner, `structured_output`, worktree e branch por item, commits do Mabel e trava por projeto (testada entre processos; o teste pelo `mabel run` entra no 4.4). |
| 2026-10-11 | Incremento 4.2: prompts de sistema, esquemas e validador próprio, montagem das etapas, artefatos e `claude` falso por cenário. O esquema do plano foi validado com o `claude` real. |
| 2026-10-11 | Incremento 4.3: pipeline do item com G2, G7 na execução, G3, revisão, retentativas com escalonamento e as decisões `responder`/`aprovar`/`cancelar` como funções (os comandos entram no 4.4). |
| 2026-10-11 | Incremento 4.4: `mabel run` com política de saldo, retomada após ctrl+c, `item`/`aprovar`/`responder`/`cancelar`. Teste real: item simples em `awaiting_merge` por US$ 0,35. Passo 4 concluído; próximo marco é o teste com aplicação real. |
| 2026-10-11 | Revisão da interface e do `init` (`docs/specs/interface.md`): modo Mabel com comandos `/` substitui o menu como painel; `init` passa a usar um catálogo de stacks. |
| 2026-10-11 | Incremento 2.4: modo Mabel com editor de linha próprio, lista de autocompletar, histórico em `<dados>/historico` e ctrl+c que volta ao prompt. Verificado num pseudo-terminal: `/init`, `/item` interrompido, `/exec` e `/run` interrompidos, `/status`. |
| 2026-10-11 | Incremento 3.4: catálogo de stacks (`src/stacks.ts`) com a detecção existente, `init` com confirmação `[S/n/editar]`, menu de stack e `--stack`. Verificado num pseudo-terminal: repositório vazio com Node e projeto Node existente sem testes. |
| 2026-10-11 | Correção: `init` depois de apagar o `.mabel/` reaproveita o id registrado para a raiz, mantendo o histórico. |
| 2026-10-11 | Correção: `init` registra o projeto antes de gravar, grava o `config.json` por último e desfaz os arquivos criados se a gravação falhar. |
| 2026-10-12 | Achados do teste com o `ferias-planner`: os 3 itens pararam em `needs_human` no planejamento. Correções: `init` commita o `.mabel/`, `run` exige o `.mabel/` na branch base, worktree parado no planejamento avança até a base, prompts com critério do que perguntar e do que decidir. Spec da inbox (`docs/specs/inbox.md`). |
| 2026-10-12 | Inbox (`docs/specs/inbox.md`): `/inbox` percorre os itens em `needs_human` pergunta por pergunta, com sugestão do agente (enter aceita), "decide você" (fora de `critical_approval`) e pular; cada item vira uma decisão só, gravada como `humano: inbox …`. O `run` num TTY oferece a inbox quando a fila termina com pendências e retoma a esteira em seguida. Perguntas passam a `{ texto, sugestao }`; pendências antigas continuam legíveis. Verificado num pseudo-terminal com o `claude` falso: run → inbox → run até `awaiting_merge`. |
| 2026-10-12 | Spec das jornadas longas (`docs/specs/jornadas.md`): autonomia ligada por padrão, planejamento em lote como padrão do `run`, estado `planned` (mudança no ciclo de vida autorizada) e aviso do sistema. |
| 2026-10-12 | J.1 (`docs/specs/jornadas.md`): pergunta com `regraCritica` no esquema; com `autonomia: "sugestoes"` (padrão, gravado pelo `init`), perguntas não críticas e com sugestão viram suposições `(autônomo)` no plano ou na execução, com gate `autonomy`; o item não para. Resumo do `run`, `mabel item` e a aprovação de item crítico na inbox mostram as decisões. O prompt do executor passa a receber as regras críticas do projeto. |
| 2026-10-12 | J.2: estado `planned` entre `planning` e `executing` (contrato atualizado: ciclo de vida e pedido de autonomia). O `run` planeja todos os itens `ready` antes de executar, oferece a inbox uma vez no fim do planejamento (só no TTY) e replaneja os respondidos antes das execuções; `--sem-lote`, `--item` e `--uma` seguem item a item. `aprovar` leva a `planned`; quadro e `mabel status` mostram `planned`. Verificado num pseudo-terminal com o `claude` falso: 3 itens, um com pergunta no planejamento; 3 planejamentos, inbox, replanejamento pela mesma sessão e 3 execuções até `awaiting_merge`. |
| 2026-10-12 | J.3: `src/notify.ts` com `osascript` (texto por `argv`, processo desacoplado, desligável com `MABEL_NOTIFICAR=0`). Avisos no fim da fila, na pausa e antes de cada pergunta no terminal (saldo, oferta da inbox, retomada). Jornadas longas concluídas. |
| 2026-10-12 | Contrato: o mecanismo do G2 passa a ser o gate entre `planning` e `planned`, alinhado ao ciclo de vida do J.2 (autorizado pelo usuário). |
| 2026-10-12 | Saldo (`docs/specs/saldo.md`): leitura com mais de 30 min é atualizada antes da etapa; consumo de cada etapa medido pelas leituras das runs (média das 10 últimas, mínimo 3); com estimativa, a política compara o saldo depois da etapa com o piso de 10%, sem ela vale o limiar de 30%; janela de 7 dias acima do ritmo pergunta e, sem autorização, espera o ritmo alcançar. Rodapé fixo com as duas janelas no modo Mabel e no `mabel run`, no lugar do cabeçalho de abertura. Política de saldo do contrato atualizada. Verificado num pseudo-terminal. |
| 2026-10-12 | Spec do passo 5 (`docs/specs/passo-5.md`), com experimentos no Claude Code real: `--restricted` isola o contexto mas não carrega o `CLAUDE.md`; hook por `--settings` nega ações; o sandbox confina o terminal e a rede. |
| 2026-10-12 | Decisões do passo 5 (usuário): autorizada a mudança dos mecanismos de G4 e G8 no contrato; escopo rígido com ampliação automática não crítica; `run` não inicia sem sandbox, salvo `"sandbox": false`. |
| 2026-10-13 | Spec de prova e integração (`docs/specs/prova-e-integracao.md`), a partir do relatório do cepa: veredito calculado, prova mecânica (vermelho na base, verde no item), branch de integração com relatório e `rejeitar`. Decisões do usuário: integração ligada por padrão, dependência integrada libera o dependente, critério sem prova não bloqueia, mudanças no G3, G5, G10 e ciclo de vida autorizadas, entra depois do passo 5. Prova com agente especificada como fase 2 e registrada no `BACKLOG.md`. |
| 2026-10-13 | Spec da gestão de projetos (`docs/specs/projetos.md`), decidida com o usuário: tudo pelo terminal, remoção apaga de verdade com registro em `removals`, alcança só os dados do Mabel, runs sem item ficam fora, toda tabela nova precisa ser classificada para a remoção. Contrato: remoção de dados só por comando do humano (autorizado). |
| 2026-10-13 | P.1 (`docs/specs/prova-e-integracao.md`): `reviewSchema` sem `aprovado`; `reviewVerdict` aprova só com todo critério do plano avaliado e atendido e nenhum bloqueante (critério fora do plano é ignorado e registrado). Prompt do revisor atualizado; G3 do contrato ganha o parecer calculado. Esquema validado com o `claude` real (Haiku, US$ 0,0013). Implementado antes do passo 5, a pedido do usuário. |
| 2026-10-13 | P.2: critério do plano com `comportamento` (`novo`/`mantido`); `testeUnico` e `arquivosDeTeste` no config, por stack no catálogo e gravados pelo `init` (Vitest detectado pelo `package.json`). Gate `proof` depois do `criteria_tests`: roda cada teste no item e no código base (só os arquivos restauráveis), restaura sempre e confere o `git status`; lacuna volta à execução, `sem_prova` segue. Modo por item sem `testeUnico`. Desvios da spec: placeholder `{padrao}` (nome escapado como regex, porque o `node --test` passa sem rodar nada quando o filtro não casa) e conjunto restaurável decidido só pelos globs (teste declarado fora deles conta como "mora no código"). Testado com node:test real. |
| 2026-10-13 | P.3: worktree removido ao chegar a `awaiting_merge` (retrabalho recria pela branch), branch apagada ao passar a `done` só se contida na base (senão, aviso), e o `run` remove na abertura os worktrees órfãos de itens em `awaiting_merge`, `done` ou `cancelled`. |
| 2026-10-13 | P.4: `integracao` no config (padrão `mabel/integracao`, `null` desliga); itens nascem dela, o Mabel faz o merge dela no item antes da verificação (conflito → `integration_conflict`, que o `responder` devolve ao executor com os conflitos marcados) e, com a revisão aprovada, integra por `commit-tree` + `update-ref` e apaga worktree e branch. Abertura do `run` cria a integração, pausa se ela estiver aberta num checkout, avança ou faz o merge da base (conflito pausa) e leva a `done` os itens já na base. Dependência integrada libera o dependente. Coluna `items.integrated_commit`. Contrato: G5, G10, ciclo de vida e fora da v0. |
| 2026-10-13 | P.5: `.mabel/integracao.md` regenerado a cada integração, na abertura do `run` e na rejeição ("Olhe primeiro" com critérios sem prova, prova por item, regra crítica, suposições e validações humanas; depois os itens na ordem de integração, com critérios, devoluções e arquivos), e `mabel integracao`. Projeto antigo ignora o relatório pelo `info/exclude`. `mabel rejeitar <n> "<motivo>" [--cancelar]` reverte o merge num worktree temporário destacado (`update-ref` contra o valor antigo), leva o item a `planning` com o motivo ou o cancela, avisa sobre dependentes integrados e, com conflito, não muda nada e aponta os itens que o impedem. Contrato: "Rejeitar um item integrado" nas decisões do humano. Prova e integração concluídas. |
| 2026-10-13 | Decisões do usuário sobre os desvios da prova e integração: mantidos o `{padrao}`, o conjunto restaurável pelos globs, o `info/exclude` para projetos antigos e o `responder --replanejar` no conflito de integração; detecção de "nenhum teste rodou" vai para o `BACKLOG.md`; o próximo passo segue sendo o passo 5. |
| 2026-10-13 | Gestão de projetos (`docs/specs/projetos.md`): `mabel projetos` (tabela fora do TTY, menu no TTY, `--removidos`), `mabel projeto <nome>` com totais, custo por etapa e modelo, itens, gates reprovados, escalonamentos, decisões autônomas e últimas 20 transições, e `mabel projeto remover` com confirmação pelo nome (`--confirmar` fora do TTY), recusa por run em andamento, trava ativa ou worktree sujo, banco numa transação com registro em `removals` e diretórios depois. Classificação em `src/projects.ts` (`tableScope`, `dirScope`) com testes que falham para tabela ou entrada nova. Feito antes do 2.3, a pedido do usuário. O resumo da remoção avisa os itens integrados que ainda não chegaram à base (P.4). Verificado num pseudo-terminal: menu e confirmação digitada. |
| 2026-10-13 | Validação da spec do passo 5 (`docs/specs/passo-5.md`, seção "Validação de 2026-10-13") com a documentação do sandbox e um experimento real (Haiku, US$ 0,005): o sandbox libera a escrita no `.git` compartilhado de um worktree (o agente faria commit e moveria refs), e por isso entra `denyWrite` no `.git` do projeto; entram também `failIfUnavailable` e `strictAllowlist`; o `init` não tem `memory_paths`; o hook não pode devolver `allow`. |
| 2026-10-13 | 5.1: etapa e probe rodam com `--restricted --strict-mcp-config --disable-slash-commands --tools <etapa> --settings <run>/settings.json` (o `exec` não). Contexto do projeto (`CLAUDE.md`, `AGENTS.md` do worktree e as regras críticas) no fim do prompt de sistema, uma vez cada, com orçamento `contexto.maxCaracteres` (40.000). O runner confere o `init` (memória, MCP, skills, comandos, ferramentas, plugins e agentes internos) e interrompe a run não hermética como `failed`. Desvios: orçamento estourado **pausa a fila** em vez de levar o item a `blocked` (`blocked` só volta ao `backlog`, e o estouro é do projeto); regras críticas entram já interpretadas (sem os comentários do modelo), no lugar da seção que os prompts de planejar e executar tinham; `memory_paths: {}` conta como vazio. Teste real no fim do passo. |
| 2026-10-13 | 5.2: `settings.json` de cada etapa com sandbox estrito (`failIfUnavailable`, sem comando fora dele, `strictAllowlist`), rede dos domínios do registro da stack (catálogo) e `denyWrite` no `.git` do projeto. `--tools`/`--allowedTools` por etapa (revisor com `git show`). Commits do Mabel sem `.claude/`. `run` recusa iniciar sem sandbox (`sandbox-exec` no macOS, `bwrap` e `socat` no Linux), salvo `"sandbox": false`, que avisa a cada execução e grava `sandbox_disabled` em cada run. Desvio: o `init` grava em `rede` os domínios da stack (projeto vazio não tem o que detectar); config sem o campo usa as stacks detectadas na raiz. |
| 2026-10-13 | 5.3: `hooks/escopo.mjs` (decisão em `src/scope.ts`) em toda etapa, pelo `node` do Mabel, com o contexto em `<run>/escopo.json` via `MABEL_ESCOPO`: nega fora do worktree, em `.git/`/`.mabel/`, caminho crítico sem aprovação e fora do escopo do plano; permite sem saída; `Bash` só registra; erro nega. Execução com `escopoAdicional`: não crítico amplia o plano (`scope_extension` e `autonomy`) e retoma a mesma sessão na mesma tentativa; crítico vai a `critical_approval` com a sessão do planejamento (para o `responder`). Decisões do hook em `events` (`hook`/`allow`/`deny`), `runs.denials` e a seção "Negações" no `mabel item`. Desvio: as negações aparecem por run (etapa e id), não por tentativa, porque a run não guarda a tentativa. |
| 2026-10-13 | Teste real do passo 5 (Haiku, projeto descartável em `~/.mabel-teste-passo5`, apagado depois; US$ 0,10 no total). Run de execução montada pelo Mabel: escrita no diretório pai e em `~` negada, `git commit` e `git update-ref refs/heads/main` negados, `example.com` negado, `npm install left-pad` funcionou, `Write` fora do escopo negado pelo hook com a mensagem, `Write` no escopo permitido, e o agente citou a convenção do `CLAUDE.md`. `mabel run` completo: plano, execução, verificação, prova e revisão rodaram sob as travas, o código seguiu o `CLAUDE.md`, commits sem `.claude/`; o item parou em `needs_human` porque a revisão (Haiku) reprovou um critério `mantido` de comando. Achados corrigidos: `--json-schema` acrescenta a ferramenta `StructuredOutput` ao `init` (esperada quando há esquema), e o `npm` precisa gravar no `~/.npm` (caches do gerenciador de pacotes por stack em `filesystem.allowWrite`). |
| 2026-10-13 | 5.4: contrato com os mecanismos novos de G4 (hook de escopo, `--restricted`, sandbox com `.git` fechado e rede da stack, `--disallowedTools`) e G8 (flags herméticas, contexto injetado com orçamento, conferência do `init`), e caminhos críticos "impostos pelo hook de escopo"; o texto das garantias não mudou. `scripts/setup.sh` confere as flags do Claude Code e o sandbox do sistema. README sem o aviso de projeto descartável e com a seção "Travas". `BACKLOG.md`: saem `--tools` e "medir o efeito" do contexto hermético; entram o revisor diante de critério `mantido` de comando e a escrita fora do escopo pelo terminal (dentro do worktree). Passo 5 concluído. |
| 2026-10-13 | Próxima tarefa, a pedido do usuário: gravar no banco as pausas da fila e as respostas do humano às perguntas da política de saldo (primeiro item não marcado de "Depois do teste"). |
| 2026-10-13 | Decisões do usuário sobre as pontas do passo 5: mantidos a pausa da fila por contexto acima do orçamento, as regras críticas só no prompt de sistema, a `rede` gravada pelo `init`, os caches de pacotes graváveis no sandbox (cache próprio só se aparecer problema), a lista fixa de agentes internos (falha fechada) e as negações por run; o gate de escopo depois da execução entra no plano logo depois das pausas da fila; o revisor diante de critério `mantido` de comando segue no `BACKLOG.md`. |
| 2026-10-14 | Pausas da fila no banco: tabela `queue_events` (projeto, horário, tipo, causa, detalhe, retomada prevista, resposta). O `run` grava as pausas (saldo de 7 dias, sem leitura depois da chamada mínima), as esperas que retomam sozinhas (reset de 5h, ritmo de 7 dias) e as respostas do humano às perguntas de saldo; `mabel projeto <nome>` mostra as 20 últimas. Tabela classificada como `project` para a remoção. Desvio: entram também a pausa pela integração aberta ou em conflito (P.4) e a espera por saldo esgotado no meio da etapa, que são pausas da fila do mesmo tipo. |
| 2026-10-14 | Decisões do usuário sobre as pausas da fila: mantidas a pausa pela integração e a espera por saldo esgotado na auditoria; o fim da espera não é gravado (o ctrl+c já aparece nas runs e nas transições). |
| 2026-10-14 | Incremento 2.3: `mabel runs [--limite <n>]` (tabela com total de custo; menu no TTY) e `mabel runs <id>` (prefixo único; ambíguo lista as candidatas e falha) com resumo, ferramentas com início relativo, alvo, duração e erro, e os caminhos do `stream.jsonl` e do transcript. Desvios: coluna `id` (8 caracteres) para abrir o detalhe; o tipo das runs de etapa mostra etapa e item (`plan #3`) e o detalhe traz o título e o projeto; a lista cobre as runs de todos os projetos e as sem item, sem filtro por projeto. Verificado num pseudo-terminal. |
| 2026-10-14 | Merge da main (passo 5) na branch das pausas: a migração de `queue_events` vai depois da de `runs.denials`, e a pausa por contexto acima do orçamento (5.1) também é gravada em `queue_events` (causa `context`). |
| 2026-10-14 | Gate de escopo (`docs/specs/passo-5.md`, "Depois do passo 5"): gate `scope` no início da verificação confere os arquivos do item (diff desde o `merge-base` com a origem) pelas regras do hook, agora em `scopeViolation`, compartilhada; violação é tentativa reprovada, com a lista e o caminho (desfazer ou `escopoAdicional`). Desvio: arquivos gerados pelo `setup` do Mabel no worktree novo (o lockfile do `npm install`) ficam em `setup-arquivos.json` do item, acumulados, e não contam; sem isso, todo item de projeto Node reprovaria. O contrato não foi alterado: falta autorização para citar o gate no mecanismo do G4. |
