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
- **Política de deliberação do projeto-alvo.** Hoje o critério "o que o agente decide sozinho e o que pergunta" é fixo nos prompts. Cada projeto deveria declarar isso, talvez como seção de `.mabel/regras-criticas.md` ("o agente decide": visual, textos, conteúdo provisório; "sempre pergunte": …). Complemento natural: um arquivo de referências (paleta, tom, exemplos) que vai crescendo com as respostas da inbox, para a mesma pergunta não voltar. Medir pela auditoria quantas perguntas por item e quantas respondidas com a sugestão.
- **Saldo estimado ao vivo durante a etapa.** O rodapé só muda quando chega um `rate_limit_event`, no início e no fim de cada run. Numa etapa longa, dá para estimar o consumo parcial pelos tokens do stream, calibrado pela razão utilização/custo das runs anteriores, e mostrar como `~68%`.
- **Estimativa de consumo por modelo.** Hoje a média é por etapa. O escalonamento troca o modelo da execução e muda o consumo; separar por etapa e modelo quando houver amostras.
- **Calibrar a política de saldo com dados reais.** Piso de 10%, margem de 10 pontos no ritmo e 30 min de idade máxima foram escolhidos sem histórico. Revisar depois de algumas semanas de uso, olhando quantas pausas houve e quantas etapas esgotaram o saldo no meio.
- **Rodapé com o estado da fila.** O rodapé fixo pode mostrar também a etapa em andamento e os itens que aguardam você, no lugar de repetir isso na rolagem.
- **ctrl+c na inbox aberta pelo `run` no meio do lote.** Hoje descarta só o item em andamento e a esteira segue para as execuções. Avaliar se o ctrl+c ali deveria encerrar o `run` (como fora da inbox) ou perguntar.
- **Prova com agente (mutações).** Fase 2 da prova, especificada em `docs/specs/prova-e-integracao.md`: um agente propõe mutações no código do item que violam cada critério, o Mabel as aplica, roda os testes e calcula o veredito (mutação sobrevivente devolve o item). Pega testes fracos que a prova mecânica deixa passar. Antes de implementar, medir na fase 1 quantos itens a revisão ou o humano reprovaram com prova mecânica verde.
- **Prova: detectar "nenhum teste rodou".** O `node --test` sai com 0 quando o filtro de nome não casa com nenhum teste; o `{padrao}` escapado reduz o caso, mas um nome declarado errado ainda faz um critério `mantido` parecer provado. Detectar, por stack, a execução sem teste (pela saída do runner ou por um repórter próprio) e tratá-la como `nao_provado` com "o filtro não encontrou o teste".
