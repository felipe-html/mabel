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
- [ ] 2.2 Leitura de saldo, `checkBalance`, probe e `mabel status`.
- [ ] 2.3 `mabel runs` com lista e detalhe da run.
- [ ] 2.4 Menu como painel: cabeçalho de saldo e volta ao menu após cada comando.

## Passo 3 — Backlog, fila e quadro

- [ ] `mabel init`: cria `.mabel/` no projeto-alvo (`backlog.md`, `config`, `regras-criticas.yaml`) e põe `quadro.md` no `.gitignore`.
- [ ] Formato do `backlog.md` e o parser.
- [ ] `mabel add "<título>"`.
- [ ] Máquina de estados do item (ciclo de vida do contrato) no banco.
- [ ] Geração do `quadro.md` a cada transição.
- [ ] Detecção de projeto sem testes e criação do item de base de testes.

## Passo 4 — Etapas e gates

- [ ] Worktree e branch por item.
- [ ] Etapas planejar → executar → verificar → revisar, cada uma em sessão nova, com artefatos em disco.
- [ ] Tabela de roteamento de modelo por etapa.
- [ ] Gate de início (G2) e gate de verificação (G3), executados pelo runner.
- [ ] Política de saldo antes de cada etapa e retomada por `--resume` após interrupção.
- [ ] Retentativas: 2 falhas escalam o modelo só na próxima tentativa; nova falha leva a `needs_human`.
- [ ] `mabel run` consumindo a fila em sequência.

## Passo 5 — Travas e inbox

- [ ] Plugin do Mabel (hooks, agentes, skills) injetado em cada run com contexto hermético (G8).
- [ ] Hook `PreToolUse` de escopo: caminhos declarados e lista de bloqueio (G4).
- [ ] Leitura de `regras-criticas.yaml`: caminhos por hook, conceitos pelo planejador.
- [ ] Saída estruturada com `suposicoes` (G7).
- [ ] `mabel inbox` com decisões em lote e retomada da sessão pausada.

## Histórico

| Data | Registro |
|---|---|
| 2026-10-11 | Contrato v0 fechado (`docs/CONTRATO.md`). |
| 2026-10-11 | Passo 1 concluído. |
| 2026-10-11 | Script de setup do ambiente (`scripts/setup.sh`). |
| 2026-10-11 | Menu interativo na tela inicial. |
| 2026-10-11 | Especificação do passo 2 (`docs/specs/passo-2.md`). |
| 2026-10-11 | Incremento 2.1: banco SQLite, runner e `mabel exec`, validado com run real em haiku. |
