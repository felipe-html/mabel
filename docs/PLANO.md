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

## Passo 2 — Runner e auditoria

- [ ] Schema SQLite (`node:sqlite`): `runs`, `events`, `rate_limits`. Banco em `~/.mabel/mabel.db`.
- [ ] Runner: inicia `claude -p` com `--output-format stream-json --verbose`, lê linha a linha e grava cada evento.
- [ ] Registro da run: item, etapa, modelo, início, fim, custo, tokens, `session_id`. Se o banco não estiver gravável, a run não inicia (G1).
- [ ] Cópia do transcript bruto da run para o armazenamento do Mabel.
- [ ] Leitura do `rate_limit_event` e persistência da última leitura de saldo.
- [ ] Chamada mínima para obter leitura de saldo quando não houver leitura recente.
- [ ] `mabel status` com o cabeçalho das janelas de 5 horas e 7 dias (saldo, reset, idade da leitura).
- [ ] Comando de diagnóstico para disparar uma run avulsa (ex.: `mabel exec "<prompt>"`), útil até a fila existir.

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
