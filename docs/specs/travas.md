# Especificação — Travas da esteira

Menos paradas que não são decisão do humano. Origem: a leitura do cepa e a medição das 18
paradas em `needs_human` (histórico do `docs/PLANO.md`, 2026-10-31), os casos do
`wego-keycloak-tema` de 01 e 02/11 no `BACKLOG.md` e as respostas do usuário em
2026-11-02, que autorizam as mudanças no contrato listadas abaixo.

Princípio: toda falha tem um "quem resolve". Só o que o executor pode corrigir gasta
tentativa; o que é da máquina espera a máquina; o que é do humano chega a ele uma vez, já
com o que mudou.

## Interface

Tudo segue o novo terminal (`docs/specs/terminal.md` e o protótipo `docs/specs/terminal.html`)
e a premissa da interface guiada: nada de tecla a decorar nem `[s/N]`. Pendências aparecem
em "Decidir as pendências" com o menu de opções da inbox; avisos da fila aparecem no painel
da fila, com a barra de ações. Fora do TTY e com `--json`, a saída continua estável para o
`mabel-ui`: nenhum incremento cria tipo de pendência novo no `inbox --json` (cada um usa um
tipo existente, com o motivo no texto). Campo novo no `--json` segue
`docs/INTEGRACAO.md` (campo novo não muda a `versao`).

## Mudanças no contrato (autorizadas em 2026-11-02)

Cada incremento grava o seu trecho no `docs/CONTRATO.md` na mesma mudança e sobe a versão
**major** (mudança no contrato, regra do `CLAUDE.md`).

| Incremento | Onde | Texto |
|---|---|---|
| E.1 | Retentativas | "Projeto cujo `setup` ou `verify` usa Docker tem o Docker da máquina conferido pelo Mabel antes da execução e da verificação. Sem resposta, a etapa não inicia, nenhuma tentativa é gasta e a fila espera o Docker voltar, conferindo de novo a cada 30 s." |
| E.2 | Retentativas | "Execução sem alteração e sem commits do item, depois de uma tentativa reprovada, vai a `needs_human` na hora, com a falha anterior: o executor não tem como corrigi-la." |
| E.3 | G4, mecanismo | "`--disallowedTools` (com `curl` e `wget` liberados quando o projeto declara `rede`: o sandbox já restringe os domínios)" |
| E.4 | G7 | "Novo pedido de aprovação do mesmo item crítico mostra o que mudou desde a última aprovação." |
| E.5 | G3 | "Critério `mantido` cujo teste falha na base e passa no item é reclassificado como `novo` pelo Mabel, com registro, sem gastar tentativa. Critério cujo teste depende de infraestrutura de teste alterada pelo próprio item fica `sem_prova`, com o motivo." |

## E.1 — Ambiente da máquina conferido na largada

**Caso:** #4 do `wego-keycloak-tema` (2026-11-01). O Docker Desktop parou, e o Mabel gastou
duas tentativas até reconhecer o impedimento (a regra do #49).

- O projeto "usa Docker" quando algum comando de `setup` ou `verify` cita `docker`, ou
  quando o worktree tem `docker-compose*.yml` ou `compose*.yml` em qualquer pasta de primeiro
  ou segundo nível. A detecção fica numa função pura, testada.
- Antes da execução e antes da verificação, o Mabel roda `docker info` fora do sandbox, com
  prazo de 10 s. Sem resposta, a etapa não inicia e nenhuma tentativa é gasta.
- A fila **espera**, como na política de saldo: confere de novo a cada 30 s e retoma
  sozinha quando o Docker responde. O motivo da espera é gravado nos eventos da fila
  (`queue_events`), como as pausas do saldo.
- **Painel da fila:** linha de aviso acima da barra, como a pausa por saldo:
  "⏸ Docker parado nesta máquina · confiro de novo a cada 30 s · esperando há 3m". A barra
  segue com "Mostrar ferramentas", "Mostrar concluídos" e "Parar depois da etapa".
- **Conferir o estado** (`mabel conferir`): no projeto que usa Docker, uma linha
  "Docker: respondendo" ou "Docker: parado nesta máquina".
- Fora do TTY: uma linha no log da fila ao começar a espera e outra ao retomar.
- `docker info` é conferência do Mabel, não do agente: não passa pelo sandbox nem pelo G4.

**Critérios de aceite**

1. `docker` falso que falha: a execução não roda, `attempts` não muda e a fila fica na espera
   com o motivo nos eventos.
2. `docker` falso que falha e depois responde: a fila retoma sozinha e o item segue.
3. Projeto sem Docker: nenhum `docker info` é rodado.
4. Painel: a linha de aviso aparece durante a espera (teste do estado puro em `src/panel.ts`).
5. `conferir` mostra a linha do Docker só no projeto que usa Docker.

## E.2 — Execução vazia depois de reprovação

**Caso:** 2026-10-22, até 5 execuções vazias seguidas no #1 e no #2 do
`wego-acessos-frontend-novo`.

- Execução sem alteração e sem commits do item (`hasOwnCommits` falso), depois de uma
  tentativa reprovada do mesmo ciclo, vai a `needs_human` na hora. A tentativa conta.
- Tipo da pendência: `attempts_exhausted` (o mesmo de hoje, sem tipo novo no `--json`), com
  o motivo "a execução não alterou nada depois da tentativa N reprovada: <falha anterior>" e
  o resumo das tentativas para o humano (`humanAttemptsSummary`).
- **Decidir as pendências:** a pendência mostra a falha anterior e o diagnóstico do executor,
  com o menu de hoje para esse tipo ("Responder", "Replanejar", "Cancelar o item").
- A primeira execução de um ciclo sem alteração continua como hoje (reprova e tenta de
  novo): ali ainda não há falha anterior que o executor deixou de corrigir.

**Critérios de aceite**

1. Execução 1 reprovada no `verify`, execução 2 sem alteração: o item vai a `needs_human` com
   `attempts` 2, sem a execução 3.
2. Execução 1 sem alteração (sem falha anterior): reprova e tenta de novo, como hoje.
3. O motivo cita a falha anterior.

## E.3 — `curl` e `wget` quando o projeto declara `rede`

**Caso:** #4 do `wego-keycloak-tema` (2026-11-01). O plano mandava baixar um `.jar` do
`repo1.maven.org`, já liberado na `rede`, e o download foi negado pelo `EXECUTE_DISALLOWED`.

- Com `rede` não vazia no `.mabel/config.json`, `curl` e `wget` saem do `--disallowedTools`
  da execução. O sandbox continua negando o domínio fora da lista.
- Sem `rede`, nada muda.
- Junto, confirmar a causa do item do BACKLOG "Lista de comandos da revisão sem efeito com o
  sandbox" (a revisão rodou `curl` fora da lista): se o `--allowedTools` não restringe com o
  sandbox ligado, a revisão ganha `--disallowedTools` com os comandos de escrita e rede. Se a
  causa for outra, registrar no histórico e devolver o item ao BACKLOG com o achado.
- `docs/ESTEIRA.html`: as ferramentas da execução e da revisão.

**Critérios de aceite**

1. Projeto com `rede`: o `--disallowedTools` da execução não tem `curl` nem `wget`.
2. Projeto sem `rede`: tem os dois, como hoje.
3. O teste do `settings.json` gerado confere que a `rede` continua na lista de domínios do
   sandbox.

## E.4 — Aprovação crítica mostra o que mudou

**Caso:** cada replanejamento do #4 do `wego-keycloak-tema` pediu a aprovação de novo, com
o mesmo caminho e a mesma suposição, só com outras palavras.

- Ao aprovar (`aprovar` e "Aprovar" em "Decidir as pendências"), o Mabel grava o que foi
  aprovado: critérios, caminhos críticos tocados, conceitos e suposições críticas.
- Novo pedido de aprovação do mesmo item compara com o último aprovado e separa: caminhos e
  conceitos novos, critérios incluídos, removidos ou alterados, e suposições novas.
- A aprovação continua sendo pedida, mesmo sem mudança.
- **Decidir as pendências:** no topo da pendência, "Desde a sua aprovação em <data>:" e as
  linhas do que mudou, ou "Nada mudou nos caminhos, conceitos e suposições críticas; mudou só
  a redação dos critérios." O menu de hoje ("Aprovar", "Responder", "Cancelar o item").
- `inbox --json`: campo novo opcional `desdeAprovacao` na pendência, com as mesmas listas;
  issue no `mabel-ui` avisando o campo (`docs/INTEGRACAO.md`).
- Comparação de critérios pelo texto normalizado (como `sameAssumption`), não pelo id.

**Critérios de aceite**

1. Item aprovado, replanejado com os mesmos caminhos e um critério a mais: a pendência mostra
   só o critério incluído.
2. Item aprovado, replanejado com um caminho crítico novo: o caminho aparece como novo.
3. Primeira aprovação: nenhum "desde a sua aprovação".
4. Exemplo do `inbox --json` atualizado em `docs/specs/exemplos/`.

## E.5 — Prova: reclassificação e infraestrutura de teste

**Casos:** 3 das 6 falhas da prova na amostra de 2026-10-22 eram critérios `mantido` com um
bom teste de comportamento novo; #9 do `wego-keycloak-tema` (2026-11-02), item que muda o
`globalSetup` e helpers em `test/`.

- **Reclassificação:** critério `mantido` cujo teste falha na base e passa no item vira
  `novo` e fica `provado`. O Mabel grava a correção no `prova-N.json` (`reclassificado:
  "mantido → novo"`) e no detalhe do gate. Nenhuma tentativa é gasta por isso.
- **Infraestrutura de teste do item:** quando o diff do item muda arquivos de teste que não
  são os declarados pelos critérios (setup, helpers, compose), e o teste de um critério
  `novo` passa na base, o critério fica `sem_prova` com o motivo "o item muda a
  infraestrutura de teste (`<arquivos>`), que fica também na base; a prova não separa o
  comportamento". Não reprova a tentativa.
- **Documento de entrega e relatório da run:** a reclassificação e o `sem_prova` aparecem nos
  critérios e prova, como os outros.
- **Painel da fila:** a linha da prova diz "1 reclassificado" quando houver.

**Critérios de aceite**

1. `mantido` com teste vermelho na base e verde no item: `provado`, com a reclassificação no
   artefato, e o item segue.
2. `novo` que passa na base num item que muda `test/setup.mjs`: `sem_prova` com o motivo, e o
   item segue para a revisão.
3. `novo` que passa na base num item que não muda infraestrutura de teste: `nao_provado`,
   como hoje.

## Ordem e sessões

Os incrementos são independentes no comportamento, mas tocam `src/pipeline.ts`: um por
sessão, na ordem E.1 a E.5, cada um aberto depois do PR anterior mergeado na `main`. Cada
sessão segue o método do `CLAUDE.md`: contrato, `docs/ESTEIRA.html`, `docs/PLANO.md`
(marcar e registrar com a versão nova) e `npm run check` antes do commit.

## Fora desta especificação

Ficam no `BACKLOG.md`: diagnóstico fora do sandbox, memória de ambiente, issue automática
para defeito do Mabel, máquina acordada durante a fila, `run --ate` e "parar antes ou revisar
depois" no G7.
