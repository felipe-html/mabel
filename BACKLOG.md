# Atividades criadas por mim

- Automatizar o início do Mabel com o ambiente já preparado.

# Atividades criadas pelo Claude

- **Orçamento de contexto do projeto-alvo.** Limite de tamanho para `CLAUDE.md` e docs de contexto, com gate que falha quando estoura. Memória curada (consolidação periódica), nunca append-only.
- **Integração com herdr.** Usar a API de socket do herdr para abrir um pane por agente ativo e acompanhar a frota ao vivo. Só depois que a CLI básica estiver estável.
- **Contexto hermético: medir o efeito.** Comparar runs com e sem `--setting-sources project` para confirmar que nada da configuração pessoal vaza para os agentes da frota.
- **`mabel add` assistido.** Descrever uma funcionalidade em texto livre e deixar um agente (Haiku/Sonnet) propor a quebra em itens do backlog, com critérios, para você revisar antes de gravar.
