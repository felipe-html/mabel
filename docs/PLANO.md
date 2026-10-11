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

## Passo 3 — Projeto, backlog, fila e quadro

Especificação: `docs/specs/passo-3.md`.

- [ ] 3.1 Projeto e `mabel init` (detecção de comandos, projeto sem testes).
- [ ] 3.2 Backlog: formato, parser, sincronização e `mabel add`.
- [ ] 3.3 Máquina de estados, auditoria de transições e `quadro.md`.

## Passo 4 — Etapas, gates e `mabel run`

Especificação: `docs/specs/passo-4.md`.

- [ ] 4.1 Runner para etapas e worktree por item.
- [ ] 4.2 Etapas com agente (planejar, executar, revisar) e saída estruturada.
- [ ] 4.3 Gates G2 e G3, retentativas e escalonamento.
- [ ] 4.4 `mabel run`, política de saldo e comandos de decisão.

## 🧪 Marco — Teste com aplicação real

Primeiro uso do Mabel num projeto descartável, com backlog escrito pelo usuário. Os
achados do teste orientam a especificação dos passos seguintes.

## Depois do teste

- [ ] 2.3 `mabel runs` com lista e detalhe da run (`docs/specs/passo-2.md`).
- [ ] 2.4 Menu como painel (`docs/specs/passo-2.md`).
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
| 2026-10-11 | Incremento 2.1 concluído. |
| 2026-10-11 | Especificações dos passos 3 e 4; ordem revista para antecipar o teste com aplicação real. |
| 2026-10-11 | Incremento 2.1: banco SQLite, runner e `mabel exec`, validado com run real em haiku. |
| 2026-10-11 | Incremento 2.2: saldo, `checkBalance`, probe e `mabel status`; probe validado com o `claude` real. |
