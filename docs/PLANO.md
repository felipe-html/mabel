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
- [ ] Gravar no banco as pausas da fila (saldo de 7 dias, falta de leitura) e as respostas
      do humano às perguntas da política de saldo. Hoje só aparecem na saída (auditoria).
- [ ] 2.3 `mabel runs` com lista e detalhe da run (`docs/specs/passo-2.md`).
- [ ] Passo 5 — Travas e inbox: plugin com hooks e contexto hermético (G8), hook de escopo
      (G4), inbox em lote. A especificar com os achados do teste.

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
