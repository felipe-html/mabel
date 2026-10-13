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
- [ ] Gravar no banco as pausas da fila (saldo de 7 dias, falta de leitura) e as respostas
      do humano às perguntas da política de saldo. Hoje só aparecem na saída (auditoria).
- [ ] 2.3 `mabel runs` com lista e detalhe da run (`docs/specs/passo-2.md`).
- [ ] Gestão de projetos no banco (`docs/specs/projetos.md`): `mabel projetos`, auditoria
      por projeto e `mabel projeto remover`.
- [ ] Passo 5 — Travas (`docs/specs/passo-5.md`):
  - [ ] 5.1 Contexto hermético (G8).
  - [ ] 5.2 Sandbox e ferramentas por etapa (G4, terminal e rede).
  - [ ] 5.3 Hook de escopo (G4, arquivos).
  - [ ] 5.4 Contrato, preflight e documentação.
- [ ] Prova e integração (`docs/specs/prova-e-integracao.md`):
  - [x] P.1 Veredito calculado (revisor não declara aprovação).
  - [x] P.2 Prova mecânica: vermelho na base, verde no item.
  - [ ] P.3 Limpeza de worktrees e branches.
  - [ ] P.4 Branch de integração.
  - [ ] P.5 Relatório da integração e `mabel rejeitar`.

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
