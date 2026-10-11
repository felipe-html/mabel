# Especificação — Passo 2: runner, auditoria e saldo

Garantias do contrato cobertas: **G1** (toda run é auditada) e a base de **G6** (leitura de
saldo). Leia `docs/CONTRATO.md` antes desta especificação.

O passo é entregue em quatro incrementos, nesta ordem. Cada incremento termina com
`npm run check` verde, critérios de aceite atendidos, `docs/PLANO.md` atualizado e um commit.

## Fatos observados

Claude Code 2.1.296, `claude -p ... --output-format stream-json --verbose`. Amostra
sanitizada em `test/fixtures/stream-read-file.jsonl` (run que lê um arquivo com a
ferramenta Read).

- Uma linha JSON por evento, no stdout. Campo `type` sempre presente; `subtype` em parte deles.
- Sequência típica: `system/init` → `assistant` → `rate_limit_event` → `user` → ...
  → `result` → mais eventos `system` **depois** do `result`. O leitor consome até o EOF.
- `system/init`: `session_id`, `model`, `cwd`, `tools`, `permissionMode`,
  `claude_code_version`. Também lista `plugins`, `skills`, `mcp_servers` e `memory_paths`
  do ambiente do usuário — registro útil para o futuro G8.
- `assistant`: `message.content[]` com itens `text`, `thinking` ou `tool_use`
  (`id`, `name`, `input`).
- `user`: `message.content[]` com `tool_result` (`tool_use_id`, `is_error`, `content`).
- `rate_limit_event`: `rate_limit_info.unifiedWindows.{five_hour,seven_day}` com
  `utilization` (0–1) e `resetsAt` (epoch em segundos); também `status` e `rateLimitType`.
- `result`: `subtype`, `is_error`, `num_turns`, `duration_ms`, `total_cost_usd`, `usage`
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`), `modelUsage`, `result` (texto final), `permission_denials`.
- Tipos desconhecidos aparecem com frequência (`system/task_summary`,
  `system/thinking_tokens`, `system/post_turn_summary`). São gravados e ignorados.
- O transcript da sessão fica em `<config>/projects/<slug>/<session_id>.jsonl`, onde
  `<config>` é `$CLAUDE_CONFIG_DIR` ou `~/.claude`. O slug deriva do caminho real do cwd;
  **não reconstrua o slug**: procure por `<config>/projects/*/<session_id>.jsonl`.

O formato não é uma API documentada. O parser deve tolerar campos ausentes e tipos novos
sem falhar.

## Armazenamento

- Diretório de dados: `$MABEL_HOME` ou `~/.mabel`.
- Banco: `<dados>/mabel.db`, via `node:sqlite` (`DatabaseSync`), com `journal_mode=WAL`,
  `busy_timeout=5000` e `foreign_keys=ON`.
- Migrações versionadas por `PRAGMA user_version`, aplicadas ao abrir o banco.
- Arquivos por run em `<dados>/runs/<run_id>/`: `stream.jsonl` (saída bruta, linha a
  linha), `stderr.log` e `transcript.jsonl` (cópia).

### Schema

```sql
CREATE TABLE runs (
  id                    TEXT PRIMARY KEY,      -- UUID gerado pelo Mabel
  kind                  TEXT NOT NULL,         -- 'exec' | 'probe' (futuro: 'stage')
  item_id               TEXT,                  -- futuro, passo 3
  stage                 TEXT,                  -- futuro, passo 4
  prompt                TEXT NOT NULL,
  cwd                   TEXT NOT NULL,
  model_requested       TEXT,
  model                 TEXT,                  -- do system/init
  session_id            TEXT,                  -- do system/init
  claude_version        TEXT,
  status                TEXT NOT NULL,         -- 'running' | 'succeeded' | 'failed' | 'interrupted'
  exit_code             INTEGER,
  error                 TEXT,
  started_at            TEXT NOT NULL,         -- ISO 8601 UTC
  ended_at              TEXT,
  duration_ms           INTEGER,
  num_turns             INTEGER,
  cost_usd              REAL,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_creation_tokens INTEGER,
  result_text           TEXT,
  transcript_path       TEXT,
  pid                   INTEGER                -- processo do Mabel dono da run (item 8 do 2.1)
);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  seq         INTEGER NOT NULL,                -- ordem de chegada na run
  received_at TEXT NOT NULL,
  type        TEXT NOT NULL,                   -- 'invalid' para linha que não é JSON
  subtype     TEXT,
  payload     TEXT NOT NULL                    -- linha original
);
CREATE INDEX events_run ON events(run_id, seq);

CREATE TABLE tool_calls (
  run_id      TEXT NOT NULL REFERENCES runs(id),
  tool_use_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  input       TEXT NOT NULL,                   -- JSON
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  is_error    INTEGER,
  PRIMARY KEY (run_id, tool_use_id)
);

CREATE TABLE rate_limits (
  id          INTEGER PRIMARY KEY,
  run_id      TEXT REFERENCES runs(id),
  observed_at TEXT NOT NULL,
  window      TEXT NOT NULL,                   -- 'five_hour' | 'seven_day'
  utilization REAL NOT NULL,                   -- 0–1
  resets_at   TEXT NOT NULL,
  status      TEXT
);
CREATE INDEX rate_limits_window ON rate_limits(window, observed_at);
```

## Incremento 2.1 — Runner e `mabel exec`

### Comportamento

1. Abre o banco e insere a run com `status='running'` **antes** de iniciar o processo. Se
   o banco ou o diretório da run não puderem ser gravados, encerra com erro e não inicia
   o `claude` (G1).
2. Inicia o `claude` com `-p --output-format stream-json --verbose`, as opções repassadas
   e o prompt por último, depois de `--` (assim um prompt que começa com hífen ou vem após
   `--allowedTools`, que é variádica, nunca é lido como opção). O executável vem de
   `$MABEL_CLAUDE_BIN` ou `claude` no PATH.
3. Lê o stdout linha a linha até o EOF. Cada linha é anexada a `stream.jsonl` antes de
   qualquer interpretação e gravada em `events`.
4. Interpretação por evento:
   - `system/init` → `session_id`, `model`, `claude_version` na run.
   - `assistant` com `tool_use` → insere em `tool_calls` e mostra a chamada ao vivo.
   - `user` com `tool_result` → fecha a chamada em `tool_calls` (`ended_at`, `is_error`).
   - `rate_limit_event` → uma linha em `rate_limits` por janela presente em `unifiedWindows`.
   - `result` → totais da run (turnos, custo, tokens, duração, texto final).
   - Linha inválida ou tipo desconhecido → só o registro em `events`.
5. Ao terminar o processo: `succeeded` se o código de saída for 0 e `result.is_error` for
   falso; senão `failed`, com `error` preenchido (stderr resumido ou `result.subtype`).
6. `ctrl+c` no Mabel repassa `SIGINT` ao `claude`, espera o processo encerrar e marca
   `interrupted`.
7. Copia o transcript (ver "Fatos observados") para `<dados>/runs/<run_id>/transcript.jsonl`
   e grava o caminho. Transcript não encontrado não falha a run: registra um evento
   `type='mabel', subtype='transcript_missing'`.
8. Uma run que ficou `running` porque o Mabel morreu é marcada `failed` com
   `error='abandoned'` na próxima abertura do banco, se o processo não existir mais.

### Interface

```
mabel exec "<prompt>" [--model <m>] [--max-turns <n>] [--max-budget-usd <x>]
                      [--allowed-tools <a,b>] [--cwd <dir>]
```

Saída ao vivo, uma linha por chamada de ferramenta, com o alvo principal do input
(`file_path`, `command`, `pattern` ou `url`, truncado):

```
▸ run 3f2a…  ·  claude-sonnet-5-5  ·  /caminho/do/projeto
  → Read   src/cli.ts                          ✓
  → Bash   npm test                            ✗
  …
<texto final da run>

✓ concluída · 12 turnos · 1m21s · US$ 0,42 · 18,3k tokens de entrada · 2,1k de saída
```

No menu interativo, `exec` pede o prompt numa linha de entrada antes de executar.

### Testes

Nenhum teste chama a API. Um `claude` falso (script Node em `test/fixtures/`) reproduz a
fixture no stdout e grava um transcript num `$CLAUDE_CONFIG_DIR` temporário. Os testes
usam `$MABEL_HOME` e `$MABEL_CLAUDE_BIN` temporários.

### Critérios de aceite

- [x] Uma run de fixture gera: 1 linha em `runs` com totais iguais aos do `result`; uma
      linha em `events` por linha do stream; 1 linha em `tool_calls` com `is_error=0`;
      2 linhas em `rate_limits`.
- [x] `stream.jsonl` é idêntico ao stdout do `claude` falso.
- [x] Banco não gravável: o `claude` falso não é iniciado e o código de saída é diferente de 0.
- [x] Linha inválida no meio do stream não interrompe a leitura.
- [x] Eventos depois do `result` são gravados.
- [x] `claude` saindo com código diferente de 0 resulta em `failed` com `error` preenchido.
- [x] `SIGINT` resulta em `interrupted` e o processo filho encerrado.
- [x] Transcript copiado quando existe; evento `transcript_missing` quando não.
- [x] Run `running` órfã vira `failed`/`abandoned` ao reabrir o banco.
- [x] Teste manual com o `claude` real e `--model haiku` registra custo e saldo.

## Incremento 2.2 — Saldo

### Comportamento

- **Leitura atual**: a linha mais recente de `rate_limits` para cada janela.
- **Saldo** = `1 - utilization`. Leitura **vencida** quando `resets_at` já passou.
- **Probe**: run `kind='probe'` com `--model haiku --max-turns 1` e prompt mínimo,
  auditada como qualquer run. Nunca é disparada sem pedido explícito neste passo.
- **Política** (função pura, usada pelo passo 4, testada agora):

  ```ts
  checkBalance(readings, now): { action: 'proceed' }
                             | { action: 'ask', window: 'five_hour' | 'seven_day', balance: number }
                             | { action: 'refresh', reason: 'missing' | 'expired' }
  ```

  Limiar de 30% nas duas janelas, conforme a política de saldo do contrato. Com as duas
  janelas abaixo do limiar, `ask` cita a de 7 dias.

### Interface

Cabeçalho exibido acima do menu interativo e no `mabel status`:

```
 5h  ████████░░  78% livre · reset hoje 16:40
 7d  █████████░  91% livre · reset sex 09:00        leitura de 4 min atrás
```

- Cores: verde ≥ 50%, amarelo entre 30% e 50%, vermelho abaixo de 30%.
- Sem leitura: `saldo desconhecido · mabel status --atualizar`.
- Leitura vencida: valores apagados com `(vencida)`.
- Horários no fuso local.

`mabel status [--atualizar]`: cabeçalho de saldo e as 5 runs mais recentes.
`--atualizar` executa o probe antes.

### Critérios de aceite

- [ ] `checkBalance` coberta para: ambas acima, 5h abaixo, 7d abaixo, ambas abaixo,
      leitura ausente, leitura vencida.
- [ ] Cabeçalho renderizado por função pura, testado sem cores.
- [ ] O probe aparece em `runs` com `kind='probe'` e gera leituras novas. Autorizado
      rodar com o `claude` real (Haiku).
- [ ] `status` funciona fora de TTY (sem cores e sem menu).

## Incremento 2.3 — `mabel runs`

- `mabel runs [--limite <n>]` (padrão 20): tabela com início, status, kind, modelo,
  turnos, duração, custo e prompt truncado. No TTY, abre o menu para escolher uma run.
- `mabel runs <id>` (aceita prefixo único do id): resumo da run, linha do tempo das
  chamadas de ferramenta (nome, alvo, duração, erro) e caminhos de `stream.jsonl` e do
  transcript.
- Total de custo das runs listadas no rodapé.

### Critérios de aceite

- [ ] Prefixo ambíguo lista as candidatas e encerra com erro.
- [ ] Saída fora de TTY é texto simples, estável para testes.

## Incremento 2.4 — Menu como painel

- O cabeçalho de saldo aparece acima do menu.
- Ao terminar um comando escolhido no menu, mostra `enter para voltar ao menu` e redesenha
  o menu. Apenas `sair`, `q` e `esc` encerram o Mabel.
- `exec`, `status` e `runs` passam a constar como disponíveis no menu e no autocompletar.

### Critérios de aceite

- [ ] Comando que falha volta ao menu com a mensagem de erro visível.
- [ ] O cursor do terminal é restaurado em qualquer saída, inclusive por exceção.

## Fora deste passo

Fila e backlog (passo 3), etapas, worktrees e gates (passo 4), hooks, plugin e contexto
hermético (passo 5), retenção e limpeza de dados antigos.
