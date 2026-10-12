# Atividades criadas por mim

- Automatizar o início do Mabel com o ambiente já preparado.

# Atividades criadas pelo Claude

- **Orçamento de contexto do projeto-alvo.** Limite de tamanho para `CLAUDE.md` e docs de contexto, com gate que falha quando estoura. Memória curada (consolidação periódica), nunca append-only.
- **Integração com herdr.** Usar a API de socket do herdr para abrir um pane por agente ativo e acompanhar a frota ao vivo. Só depois que a CLI básica estiver estável.
- **Contexto hermético: medir o efeito.** Comparar runs com e sem `--setting-sources project` para confirmar que nada da configuração pessoal vaza para os agentes da frota.
- **`mabel add` assistido.** Descrever uma funcionalidade em texto livre e deixar um agente (Haiku/Sonnet) propor a quebra em itens do backlog, com critérios, para você revisar antes de gravar.
- **Restringir as ferramentas de cada etapa com `--tools`.** No teste real do 4.4, o planejador (só `Read`, `Glob`, `Grep` em `--allowedTools`) rodou Bash de leitura (`pwd`, `cat`, `git status`): o `dontAsk` libera comandos que o Claude Code considera só de leitura. `--tools` limita as ferramentas disponíveis de fato. Vale decidir junto com o contexto hermético do passo 5.
- **Confirmar a detecção de saldo esgotado.** `isUsageLimit` usa uma heurística (`rate_limit_event` com status fora de `allowed*` ou texto de limite no `result`). Falta capturar uma run real que esgote o saldo e gravá-la em fixture, como pede a spec do passo 4.
- **Autocompletar de argumentos no modo Mabel.** Sugerir números de item em `/item`, `/aprovar`, `/responder` e `/cancelar`, filtrados pelo estado em que cada comando faz sentido.
- **Mais stacks no catálogo do `init`.** Java/Kotlin (Gradle, JUnit), Ruby (RSpec), frontend com Playwright para testes de ponta a ponta. Entram quando houver projeto real pedindo.
