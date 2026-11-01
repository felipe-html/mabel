# Integração com o mabel-ui — lado produtor

Como este repositório e o `mabel-ui` (app macOS e controle remoto no iOS, ao lado deste em
`../mabel-ui`) combinam mudanças sem depender da conversa de uma sessão. Aqui nasce o
formato; lá ele é consumido. O lado consumidor está em `../mabel-ui/docs/INTEGRACAO.md`.

## Duas camadas

| Camada | Onde | Para quê |
|---|---|---|
| Contrato | `docs/specs/integracao-externa.md` | O formato de `--json`, eventos, supervisor e comandos sem TTY. É a fonte da verdade. |
| Pedidos | Issues com o rótulo `integracao`, no repositório que vai agir | O que precisa de alguém pensar: campo que falta, comando novo, divergência entre spec e código. |

Os exemplos gerados por teste em `docs/specs/exemplos/` completam o contrato, para o
consumidor conferir de forma mecânica ([felipe-html/mabel#28](https://github.com/felipe-html/mabel/issues/28)).

Os nomes dos comandos mudaram em 2026-10-31, sem apelidos para os antigos (`run` virou
`rodar`, `projetos` virou `listar`…); a tabela da troca está em
`docs/specs/integracao-externa.md`, e o catálogo atual sai em `mabel comandos --json`. Em
2026-11-01, com as telas dos comandos, `rodar --uma` virou `rodar --limite <n>` e entrou o
`retomar` (mesma seção da spec).

## Pedidos

- **Rótulos:** `integracao` em todo pedido; `proposta` enquanto aguarda o usuário;
  `aprovado` quando ele autoriza. Só o usuário troca `proposta` por `aprovado`.
- **Formato:** o template `.github/ISSUE_TEMPLATE/integracao.md` (origem, o que trava,
  problema, evidência, proposta, alternativas). Pelo terminal:
  `gh issue create --label integracao,proposta --title "…" --body-file <arquivo>`.
- **Onde abrir:** no repositório que vai mudar. O `mabel-ui` pede aqui o que a CLI não
  tem; este repositório pede lá quando uma mudança de formato exige algo do app.
- **Nunca contorne do outro lado.** Quem consome não implementa no cliente uma regra que
  é do Mabel; quem produz não muda o formato sem avisar o consumidor.

## O que este lado faz

- **Início de sessão:** `gh issue list --repo felipe-html/mabel --label integracao` (o
  que pediram para nós) e `gh issue list --repo felipe-html/mabel-ui --label integracao`
  (o que pedimos ao app). Issue `aprovado` aberta aqui entra no `docs/PLANO.md` como
  tarefa, citando o número.
- **Ao implementar:** só issue `aprovado`. Dúvida ou desvio vai como comentário na issue,
  além do histórico do `docs/PLANO.md`. O PR fecha a issue (`Fixes #N`) e atualiza a
  spec de integração no mesmo commit.
- **Mudança de formato:** campo novo não muda a `versao`; remover ou mudar o sentido de um
  campo muda, e pede issue no `mabel-ui` (`--repo felipe-html/mabel-ui`) avisando o que
  o app precisa acompanhar.
- **Pedido nosso que fecha no `mabel-ui`:** confira o PR que o fechou e registre no
  histórico do `docs/PLANO.md` o que mudou do lado do app.
- **Ideia sem pedido:** ideia sobre a integração que ninguém pediu vai para o
  `BACKLOG.md`, não para issue.
