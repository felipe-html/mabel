# Especificação — Ferramentas do Mabel para os agentes (`verificar`)

Achado do uso real (levantamento de 2026-11-03): 18 de 18 execuções do `wego-login-tema` e
47 de 50 do `wego-keycloak-tema` terminaram sem rodar `npm test`. Os testes Playwright
desses temas sobem um Keycloak com `docker compose`, e o sandbox do Claude Code (G4) fecha o
socket do Docker. O executor escreve testes que nunca viu rodar; só a verificação do Mabel,
depois da execução e fora do sandbox, mostra a falha. Cada erro bobo (seletor errado,
import quebrado) custa uma tentativa inteira, e o item chega a `needs_human` pelo
escalonamento.

Caminhos descartados com o usuário:

- **Tirar o sandbox** (como o cepa, que larga com `--dangerously-skip-permissions`): o
  agente passaria a escrever em `~/.mabel`, nos registros que o auditam (G1).
- **Liberar o `docker.sock`** no sandbox: o socket dá acesso à máquina inteira (container
  com `/` montado), e qualquer comando do agente o alcançaria.

Esta spec cria um canal de ferramentas do próprio Mabel, um servidor MCP por run, e a
primeira ferramenta dele: `verificar`, que roda **só** o comando configurado do projeto
fora do sandbox, no worktree do item, e devolve o log ao agente.

## Por que o risco não aumenta (e o que muda)

A verificação do Mabel já roda o código do agente fora do sandbox a cada tentativa: o
`npm test` executa os scripts do `package.json` e os testes que o agente escreveu, sem
sandbox de arquivo nem lista de domínios. A ferramenta não dá ao agente nada que ele já não
consiga por essa via. O que muda:

1. **Frequência e interatividade.** Antes, o código do agente rodava fora do sandbox uma
   vez por tentativa e ele via o log na tentativa seguinte. Com a ferramenta, roda até o
   limite de chamadas da run, e ele vê o log na hora.
2. **O agente continua sem shell livre fora do sandbox.** Ele escolhe, no máximo, o arquivo
   e o nome de um teste; a linha de comando é a do config. O `Bash` dele continua no
   sandbox.

Fica registrado na spec, para não ser lido como garantia que não é: quem controla o código
que o `verify` executa é o agente. A ferramenta restringe a *linha de comando*, não o que
os testes fazem. Isso já era verdade para a verificação do Mabel e continua sendo.

## Decisões

Aprovadas pelo usuário em 2026-11-04, com as quatro perguntas respondidas pela sugestão.
As mudanças no contrato estão autorizadas e entraram no `CONTRATO.md` com esta
implementação. **Revisão marcada para 2026-11-18** (duas semanas de filas com a 3.0.0):
a ferramenta só na execução (V2) e os limites fixos no código (V8), com os números da
seção "Medição".

| # | Tema | Proposta |
|---|---|---|
| V1 | Canal | Um servidor MCP stdio do Mabel (`src/mcp.ts`), JSON-RPC escrito à mão, sem dependência, iniciado pelo `claude` como subprocesso. O processo do MCP não passa pelo sandbox do Claude Code (conferido em 2026-11-04 com o `claude` 2.1.296: com o sandbox ligado, o `Bash` não escreve em `~/.mabel` e o MCP escreve). Nome do servidor: `mabel`; nome da ferramenta para o agente: `mcp__mabel__verificar`. |
| V2 | Em que etapa | **Só na execução.** O revisor não precisa rodar testes: a prova e a verificação já rodaram antes dele, e o `Bash` dele é só `git diff/log/show`. Dar a ele a ferramenta abriria um segundo agente fora do sandbox sem ganho. O item "Revisor e critério `mantido` verificado por comando" do backlog resolve a necessidade dele passando os resultados dos gates no prompt. |
| V3 | Quando existe | Só quando o projeto tem `verify` não vazio ou `testeUnico`, e o sandbox está ligado. Com `"sandbox": false`, o `Bash` já roda fora do sandbox e a ferramenta não acrescenta nada; fica de fora para não haver dois caminhos. |
| V4 | Assinatura | `verificar()` roda os comandos do `verify` em ordem, parando no primeiro que falha, como a verificação do Mabel. `verificar({ arquivo, nome })` roda o `testeUnico` (o mesmo modelo da prova, `proofTestCommand`) com esse teste. Sem `testeUnico`, a chamada com teste é recusada com a orientação de chamar sem argumentos. |
| V5 | Argumentos sem injeção | O `arquivo` e o `nome` entram no modelo pelo `singleTestCommand` da prova: cada valor vai entre aspas simples (`shellQuote`), e o `{padrao}` é o nome escapado como regex. Antes disso, o Mabel recusa: `arquivo` absoluto, com `..`, fora do worktree ou inexistente; `arquivo` ou `nome` começando com `-` (seria lido como opção pelo runner de teste, mesmo com aspas); quebra de linha ou NUL; mais de 500 caracteres. Nenhum outro campo é aceito (`additionalProperties: false`). |
| V6 | Pasta | A raiz do worktree do item, a mesma da verificação do Mabel. O worktree vem do arquivo de configuração da run, gravado pelo Mabel em `~/.mabel/runs/<run>/`; o agente não o escolhe. |
| V7 | Ambiente | O do processo do `claude` da run (o do Mabel sem as variáveis privadas, `agentEnv`), sem `NODE_TEST_CONTEXT`, como o `shell` da verificação. Sem o proxy de rede do sandbox: a rede é a da máquina, como na verificação do Mabel. |
| V8 | Limites | **8 chamadas por run de execução** e **10 minutos por chamada** (o comando e os filhos são encerrados por grupo de processo). Acima do limite, a ferramenta responde com erro: "limite de 8 verificações nesta tentativa; termine e deixe a verificação do Mabel conferir". Uma chamada por vez: a seguinte espera a anterior. A run retomada depois de interrupção é outra run e recomeça a contagem. Valores fixos no código nesta versão; viram config se a auditoria pedir. O `MCP_TOOL_TIMEOUT` do `claude` da run é ajustado acima do tempo da chamada, para o `claude` não desistir antes do Mabel. |
| V9 | Saída para o agente | Código de saída, duração, o comando rodado e as últimas 200 linhas do log (no máximo 30 mil caracteres). Erro do comando volta como resultado normal (`isError: false`), com o código; `isError: true` só para recusa (argumento inválido, limite, sem comando). |
| V10 | Não é gate | **A chamada não conta para nenhum gate.** O G3 continua calculado pela verificação e pela prova do Mabel depois da execução, sobre o commit. A ferramenta não grava `gates`, não muda o estado do item e não é lida pela verificação. Um `verificar()` verde não dispensa nada. |
| V11 | Auditoria | Sem tabela nova. (a) A chamada já entra em `tool_calls` pelo stream-json (nome `mcp__mabel__verificar`, argumentos, início, fim, `is_error`). (b) O servidor grava cada execução em `~/.mabel/runs/<run>/verificar.jsonl` (sequência, comando rodado, código, duração, caminho do log, motivo da recusa) e o log completo em `~/.mabel/runs/<run>/verificar-<n>.log`; no fim da run, o runner importa o `.jsonl` como eventos `mabel`/`verificar`, como já faz com o log do hook de escopo. (c) Sem registro, não roda: se o servidor não conseguir gravar a linha do `.jsonl`, a chamada é recusada sem executar o comando (G1). O diretório da run já entra na remoção de projeto (`src/projects.ts`). |
| V12 | Declaração e G8 | O Mabel grava `~/.mabel/runs/<run>/mcp.json` só com o servidor `mabel` (`node` do Mabel + `src/mcp.ts` + caminho do arquivo de configuração da run) e passa `--mcp-config` com ele, ao lado do `--strict-mcp-config`, que continua ignorando qualquer outro MCP. A conferência do `init` passa a exigir que `mcp_servers` seja **exatamente** a lista pedida pela etapa, cada um `connected`, e que `tools` traga as ferramentas pedidas mais as do MCP do Mabel. MCP a mais, faltando ou não conectado interrompe a run, como hoje. A ferramenta entra no `--allowedTools` (o modo `dontAsk` nega o resto). |
| V13 | Prompt do executor | `prompts/executar.md`: quando o `Bash` não conseguir rodar os testes (sandbox, Docker, rede), use `verificar` em vez de declarar impedimento; prefira `verificar({arquivo, nome})` para o teste que está escrevendo e `verificar()` uma vez no fim; o limite de chamadas; o resultado não substitui a verificação do Mabel. O impedimento continua valendo para o que a ferramenta também não resolve (Docker parado na máquina). |
| V14 | Canal para outras ferramentas | O servidor nasce com uma lista de ferramentas por etapa, mas esta spec só cria a `verificar`. Ferramenta nova (consultar referência, ler o tema pai de uma imagem) é mudança nesta spec e, se rodar algo fora do sandbox, no G4. |

## Contrato

Texto aprovado. Muda o G4 e o G8; o G3 recebe uma frase que deixa explícito que a
ferramenta não é gate.

**G3**, ao fim da garantia:

> … O parecer da revisão é calculado a partir dos critérios avaliados e dos problemas
> apontados; o revisor não declara aprovação. **Teste que o agente roda durante a etapa,
> inclusive pela ferramenta `verificar` do Mabel, não conta para nenhum gate.**

**G4**, garantia:

> **O agente não sai do escopo.** Escrita fora dos caminhos declarados e comandos da lista
> de bloqueio são barrados. O agente nunca faz merge nem push na base. **O único comando
> que roda fora do sandbox a pedido do agente é o de verificação do projeto, pela
> ferramenta `verificar` do Mabel na execução.**

**G4**, mecanismo, ao fim:

> … Sem sandbox, a fila não roda, salvo desligamento explícito no projeto, registrado em
> cada run. **A ferramenta `verificar` (servidor MCP do Mabel, só na etapa de execução e só
> com o sandbox ligado) roda o `verify` ou o `testeUnico` do `.mabel/config.json`, no
> worktree do item, com limite de chamadas por run e de tempo por chamada; o agente escolhe
> no máximo o arquivo e o nome de um teste, validados e passados entre aspas. Cada chamada
> fica gravada na run com o comando, o código de saída e o log.**

**G8**, mecanismo:

> `--restricted`, `--strict-mcp-config` **com `--mcp-config` só para o servidor MCP do
> Mabel, nas etapas que o usam**, `--disable-slash-commands`, `--tools` por etapa e
> `--settings` por run; … o runner confere o `init` de cada run e interrompe a que trouxer
> memória, skills, **MCP além do pedido pela etapa** ou ferramentas fora das pedidas.

**Fora da v0**: "servidor MCP da frota" continua fora; o MCP desta spec é por run, para o
agente, e não expõe a frota.

Mudança no contrato: versão **major** (3.0.0), pela regra do `CLAUDE.md`.

## Implementação

1. `src/mcp.ts`: servidor stdio (linhas JSON-RPC 2.0). Responde `initialize` (ecoa a
   `protocolVersion` pedida, `capabilities.tools`), `tools/list`, `tools/call`, `ping`;
   ignora notificações; responde `-32601` aos outros métodos com `id` (o `claude` sonda
   `server/discover` antes do `initialize`). Lê a configuração da run do arquivo passado
   como argumento (`worktree`, `verify`, `testeUnico`, `log`, limites). Funções puras
   exportadas para teste (`validateTestArgs`, `toolCommand`).
2. `src/runner.ts`: `RunRequest.mcp` (ferramentas do Mabel e a configuração do servidor);
   grava `mcp.json` e a configuração no diretório da run; `--mcp-config`; `MCP_TOOL_TIMEOUT`
   no ambiente do `claude`; conferência do `init` com os servidores esperados; importação
   do `verificar.jsonl` como eventos no fim.
3. `src/hermetic.ts`: `initViolation(init, tools, mcpServers)`: lista exata de servidores,
   todos `connected`.
4. `src/stages.ts`: na execução, com sandbox e comando, a ferramenta entra em `tools`
   esperadas e em `allowedTools`; o prompt da execução cita a ferramenta.
5. `prompts/executar.md`, `docs/ESTEIRA.html`, `docs/CONTRATO.md`, `docs/PLANO.md`,
   `BACKLOG.md`, versão 3.0.0.

Testes (com o `claude` falso):

- Servidor: `initialize`/`tools/list`/`tools/call` por stdio; `verificar()` com `verify` de
  dois comandos (para no primeiro vermelho); `verificar({arquivo, nome})` com nome cheio de
  metacaracteres (`'; touch /tmp/x; '`, `$(…)`, aspas) chega literal ao comando; recusas
  (`..`, absoluto, `-` inicial, inexistente, sem `testeUnico`); limite de chamadas; tempo
  máximo encerra o comando; sem registro, não roda; método desconhecido.
- Runner: `--mcp-config` só na execução com sandbox e comando; `init` com o `mabel`
  conectado passa; MCP a mais, faltando ou `failed` interrompe; eventos `verificar`
  importados.
- Etapas: revisão e planejamento sem MCP; `"sandbox": false` sem MCP.

## Medição

Depois de algumas filas do `wego-login-tema` e do `wego-keycloak-tema` com a 3.0.0: fração
de execuções que terminam com impedimento "não consegui rodar os testes", tentativas por
item até `reviewing`, chamadas de `verificar` por execução (para calibrar o limite de 8) e
duração delas (para o de 10 minutos).

## Riscos que ficam

- **Serviços com nome e porta fixos.** Os temas sobem o compose `test` na porta 8080. A
  ferramenta roda no meio da execução, então pode cruzar com a verificação de outro projeto
  ou com um Keycloak que o humano deixou de pé. O problema já existe com a verificação do
  Mabel; o item "Isolamento de serviços entre worktrees" do backlog o trata.
- **Testes que vazam.** O código do agente roda fora do sandbox mais vezes. Ver "Por que o
  risco não aumenta".
