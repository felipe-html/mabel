# Atividades criadas por mim

- Automatizar o início do Mabel com o ambiente já preparado.

# Atividades criadas pelo Claude

- **Orçamento de contexto do projeto-alvo.** Limite de tamanho para `CLAUDE.md` e docs de contexto, com gate que falha quando estoura. Memória curada (consolidação periódica), nunca append-only.
- **Integração com herdr.** Usar a API de socket do herdr para abrir um pane por agente ativo e acompanhar a frota ao vivo. Só depois que a CLI básica estiver estável.
- **`mabel add` assistido.** Descrever uma funcionalidade em texto livre e deixar um agente (Haiku/Sonnet) propor a quebra em itens do backlog, com critérios, para você revisar antes de gravar.
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
- **Revisor e critério `mantido` verificado por comando.** No teste real do passo 5, o planejador (Haiku) criou o critério "`npm test` passa, incluindo o teste base", e o revisor o reprovou duas vezes porque o diff não tocava o teste base. A prova mecânica já cobre critério `mantido`; o revisor deveria aceitar a saída da verificação como evidência (talvez recebendo o resultado dos gates no prompt), ou o planejador não deveria transformar "a verificação passa" em critério.
- **Aplicar a quebra sugerida pelo refinamento.** Hoje o `refinar` só mostra a quebra. Aplicar seria criar os itens menores no backlog (com dependências entre eles) e reduzir ou cancelar o original, tudo numa revisão só.
- **Respostas da inbox de volta ao `backlog.md`.** As respostas do refinamento já viram `Decisões:`; as da inbox (perguntas do planejamento e da execução) ficam no banco e no plano. Gravá-las também no item, ao menos as de regra de negócio, fecharia o ciclo. Cuidado: o item já iniciado tem conteúdo congelado.
- **Aviso no `run` sobre itens nunca refinados.** No começo do lote, listar os itens `ready` que nunca passaram pelo `refinar`, com a opção de refinar antes de planejar (TTY).
- **Reescrita da intenção no refinamento.** A proposta só acrescenta critérios, fora do escopo, decisões e regras críticas. Avaliar se o agente deveria propor uma intenção reescrita quando a original estiver vaga, sempre com a revisão.
- **Template do backlog guiado pelas métricas.** Depois de algumas semanas de `refinar`, comparar perguntas e suposições de itens refinados e não refinados e ajustar o template (e talvez o padrão de oferecer o refinamento no `add`).
- **`add` com `--decisao` e `--regra-critica`.** Hoje esses campos entram só pelo `refinar` ou editando o arquivo.
- **Refinar em lote.** `mabel refinar --todos` para rodar o agente em todos os itens não refinados e revisar as propostas em sequência, como a inbox.
- **Preservar comentários dentro do bloco do item.** A gravação do refinamento regrava o trecho do item e perde comentários HTML no meio dele (os de depois do item ficam).
- **PR da entrega fechado sem merge.** Hoje a entrega continua `open` até o `mabel entregar --substituir`. A abertura do `run` poderia perguntar ao `gh` e marcá-la como fechada, liberando uma entrega nova sem a flag.
- **Refinamento propondo referências.** O agente do `refinar` poderia sugerir `tela:` e `api:` a partir da intenção e dos snapshots em `.mabel/referencias/`, conferidos antes de gravar.
- **`add --referencia`.** Hoje o campo entra só editando o arquivo.
- **Validação visual na inbox.** Captura do Playwright da tela implementada ao lado do `tela.png`, como rota de validação humana do critério visual.
- **Mocks do snapshot no `setup`.** Gerar fixtures ou handlers (MSW) a partir de `api/<nome>.openapi.json`, para o executor não escrever dados de teste à mão.
- **Telas com vários frames.** `referencia tela` com vários `node-id` (estados de erro, vazio, carregando) num comando só, e fontes e espaçamentos no `tela.md`.
- **OpenAPI em YAML e API autenticada.** `referencia api` só aceita JSON público.
- **Supervisor, `--json` e eventos.** Especificados em `docs/specs/integracao-externa.md`: o supervisor dono das filas (`run --fundo`, `anexar`, `parar`), as saídas `--json`, o fluxo `mabel eventos --json`, os comandos sem TTY e o `mabel nascer`. O contrato já prevê filas em paralelo e saldo único; falta o código. É o que a interface (repositório `mabel-ui`) consome.
