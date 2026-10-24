# Especificação — Integração externa: supervisor, `--json` e eventos

O que a CLI precisa oferecer para ser usada por outros programas, a começar pela
interface gráfica (repositório `mabel-ui`: app macOS e, depois, o controle remoto no iOS).
Esta spec é o contrato entre os dois repositórios: o formato nasce aqui, com teste aqui, e
o `mabel-ui` só o consome. Remover ou mudar o sentido de um campo muda a versão; campo
novo, não (ver "Compatibilidade").
Pedidos entre os dois repositórios seguem `docs/INTEGRACAO.md` (issues com o rótulo
`integracao`).

Base no contrato: "Vários projetos-alvo em paralelo, cada um com a sua fila" e "A fila de
um projeto roda em segundo plano" (`docs/CONTRATO.md`, escopo da v0), e a política de
saldo única para todas as filas.

Cada incremento termina com `npm run check` verde, critérios atendidos, `docs/PLANO.md`
atualizado e um commit.

## Decisões

| Tema | Decisão |
|---|---|
| Quem roda as filas | Um processo supervisor por máquina, iniciado pelo launchd. A CLI e a interface só pedem e observam. |
| Formato | JSON numa linha por chamada (`--json`) e NDJSON no fluxo de eventos, sempre com `"versao": 1`. |
| Compatibilidade | Campo novo não muda a versão. Remover ou mudar o sentido de um campo muda. O cliente ignora campo e tipo de evento que não conhece. |
| Escrita | Só a CLI escreve no banco. Nenhum cliente lê ou escreve o `~/.mabel/mabel.db` direto. |
| Idioma | Nomes de campos e valores em português, como o resto da CLI. |

## Supervisor

Processo `mabel supervisor` dono das filas, iniciado por um LaunchAgent
(`~/Library/LaunchAgents/dev.mabel.supervisor.plist`). Ele roda o `run` de cada projeto,
cada um com o lock que já existe (`~/.mabel/locks/<projeto>.lock`), e aplica a política
de saldo única do contrato a todas as filas.

| Comando | Efeito |
|---|---|
| `mabel run --fundo` | Entrega a fila do projeto atual ao supervisor e volta na hora. |
| `mabel anexar` | Mostra ao vivo a saída da fila do projeto atual, como o `run` em primeiro plano. Ctrl+C solta, sem parar a fila. |
| `mabel parar` | Pede ao supervisor que pare a fila do projeto depois da etapa em andamento. |
| `mabel supervisor instalar` / `remover` | Grava ou apaga o LaunchAgent. |

## Saídas `--json`

Uma linha de JSON por chamada, com `"versao": 1` no topo.

| Comando | Conteúdo |
|---|---|
| `mabel projetos --json` | Por projeto: `id`, `nome`, `raiz`, `fila` (`parada`, `rodando`, `pausada_por_saldo`, `aguardando_humano`), item e etapa em andamento, papel ativo, pendências da inbox, custo total, última atividade. |
| `mabel status --json` | Do projeto atual: a fila por estado, as etapas em andamento e o saldo. |
| `mabel saldo --json` | As duas janelas: `uso`, `reset`, `ritmo` (só 7d), `idade_leitura_s`, e a pausa em vigor com o motivo, se houver. |
| `mabel inbox --json` | As pendências: item, tipo (`aprovar`, `responder`, `validar`), pergunta, sugestão, opções. |
| `mabel projeto <nome> --json` | Diagnóstico de consumo: custo e uso de janela por etapa, por modelo e por item. |

### Exemplos

`docs/specs/exemplos/` tem um exemplo real de cada saída `--json` (`projetos.json`,
`status.json`, `saldo.json`, `inbox.json`, `projeto.json`, `nascer-*.json`) e um evento de
cada tipo (`eventos.ndjson`). Quem os grava é `test/examples.test.ts`, rodando o CLI num
cenário fixo; o teste falha se a saída mudar sem o exemplo ser regravado:

```bash
MABEL_GRAVAR_EXEMPLOS=1 npm test
```

Nos exemplos, ids, raízes e nomes de projeto são fixos, os horários partem de
`2026-10-24T12:00:00-03:00` e o que depende do relógio (`idade_leitura_s`, `ritmo.esperado`)
vem arredondado. A saída real é uma linha só; os `.json` estão formatados para leitura. O
`mabel-ui` copia os arquivos, e a verificação dele compara a cópia com
`../mabel/docs/specs/exemplos/`.

## Fluxo de eventos

`mabel eventos --json` fica aberto e escreve um evento por linha (NDJSON), de todos os
projetos, até o processo ser encerrado. O cliente mantém um só aberto e reabre se ele cair.

```json
{"versao":1,"tipo":"etapa","projeto":"loja-online","projeto_id":"3f0c2a9e-…","item":12,"etapa":"executar","estado":"iniciou"}
{"versao":1,"tipo":"ferramenta","projeto":"loja-online","projeto_id":"3f0c2a9e-…","item":12,"nome":"Edit"}
{"versao":1,"tipo":"gate","projeto":"loja-online","projeto_id":"3f0c2a9e-…","item":12,"gate":"testes","resultado":"verde"}
{"versao":1,"tipo":"inbox","projeto":"app-financas","projeto_id":"8d2b…","pendencias":2}
{"versao":1,"tipo":"saldo","janela":"5h","uso":0.22,"reset":"2026-10-23T16:40:00-03:00"}
{"versao":1,"tipo":"fila","projeto":"loja-online","projeto_id":"3f0c2a9e-…","estado":"pausada_por_saldo"}
```

Tipos: `etapa` (iniciou, terminou, falhou), `ferramenta` (nome da ferramenta chamada pelo
agente), `gate` (verde, vermelho), `revisao` (aprovada, reprovada), `inbox` (número de
pendências do projeto), `saldo` (leitura nova), `fila` (mudança de estado da fila),
`item` (transição de estado). Todo evento de projeto traz `projeto` (o nome) e
`projeto_id`; o `saldo` não tem projeto, porque o saldo é da conta. Horários sempre no fuso
local com o deslocamento, como nas saídas `--json`. Os campos exatos de cada tipo estão em
`docs/specs/exemplos/eventos.ndjson`.

## Ações sem TTY

Os comandos que um cliente roda precisam funcionar sem perguntas interativas: `mabel run
--fundo`, `mabel parar`, `mabel aprovar`, `mabel responder`, `mabel init` e `mabel
projeto remover <nome> --confirmar <nome>` (que já existe). Sem TTY, um comando que
precisaria perguntar sai com código diferente de 0 e diz qual argumento falta.

## `mabel nascer`

Conversa com um agente, num diretório vazio ou num repositório sem `.mabel/`, que sai com
uma proposta revisável: stack, `CLAUDE.md`, regras críticas e backlog inicial. O usuário
revisa como no `refinar` e o `mabel init` grava. Parente do "`mabel add` assistido" no
`BACKLOG.md`. Spec própria: `docs/specs/nascer.md`.

## Incrementos

1. **`--json`** em `projetos`, `status`, `inbox`, `projeto <nome>` e o comando `saldo`.
2. **Fluxo de eventos:** `mabel eventos --json`, alimentado pelo que o runner e a fila já
   gravam (runs, ferramentas, gates, transições, leituras de saldo).
3. **Supervisor:** `mabel supervisor`, `run --fundo`, `anexar`, `parar` e o LaunchAgent,
   com a política de saldo aplicada a todas as filas.
4. **Ações sem TTY** conferidas comando a comando.
5. **`mabel nascer`**, depois da spec própria.

## Critérios de aceite

1. Cada saída `--json` tem teste que fixa os campos e a versão.
2. Um run de etapa produz, em ordem, os eventos `etapa` (iniciou), `ferramenta`, `gate` e
   `etapa` (terminou) no `mabel eventos`.
3. Com o supervisor rodando a fila de dois projetos, fechar o terminal não para nenhuma;
   `mabel anexar` em cada um mostra a saída ao vivo.
4. Com o saldo abaixo do piso, as duas filas pausam e o evento `fila`
   `pausada_por_saldo` sai para cada uma.
5. Sem TTY, nenhum dos comandos de "Ações sem TTY" fica esperando resposta.
6. Sem supervisor e sem `--json`, a CLI faz tudo o que fazia antes.
