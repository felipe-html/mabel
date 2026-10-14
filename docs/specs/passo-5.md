# Especificação — Passo 5: travas

Garantias do contrato cobertas: **G8** (contexto hermético) e **G4** (o agente não sai do
escopo). Hoje G8 não existe e G4 é só uma lista de comandos proibidos. Ao fim deste passo,
o aviso de "use só em projeto descartável" sai do README.

Leia `docs/CONTRATO.md` antes desta especificação.

Decisões do usuário (2026-10-12):

- Mudança dos mecanismos de G4 e G8 no contrato: **autorizada** (aplicada no 5.4).
- Escopo **rígido**: escrita fora do escopo do plano é negada; ampliação não crítica é
  automática via `escopoAdicional`.
- Sem sandbox disponível, o `run` **não inicia**, salvo `"sandbox": false` no config.

Incrementos, cada um com `npm run check` verde, critérios atendidos, `docs/PLANO.md`
atualizado e commit:

- 5.1 Contexto hermético (G8)
- 5.2 Sandbox e ferramentas por etapa (G4, terminal e rede)
- 5.3 Hook de escopo (G4, arquivos)
- 5.4 Contrato, preflight e documentação

## Fatos observados

Claude Code 2.1.296, testado com Haiku num repositório descartável em 2026-10-12.

**Isolamento de contexto** (lido do evento `system/init`):

| Flags | Memória | MCP | Skills | Plugins | `CLAUDE.md` do projeto |
|---|---|---|---|---|---|
| nenhuma | ligada | 1 | 34 | 3 | carregado |
| `--setting-sources project` | ligada | 1 | 20 | 3 | carregado |
| `--restricted --strict-mcp-config` | `null` | 0 | 20 | 3 | **não carregado** |
| idem + `--disable-slash-commands` | `null` | 0 | 0 | 3 | **não carregado** |

- Os 3 plugins que restam são internos do Claude Code (`cc-plugin-agents-md`,
  `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`); os agentes que restam são os
  internos (`Explore`, `Plan`, `general-purpose`…).
- `--setting-sources project` sozinho **não** isola: mantém memória, MCP e skills.
- `--tools <lista>` limita as ferramentas disponíveis de fato (o `init` passa a listar só
  elas). `--restricted` remove `Bash` a menos que `--tools` o nomeie.

**Travas** (com `--restricted`, `--permission-mode dontAsk` e `--settings <arquivo>`):

- Hook `PreToolUse` declarado no arquivo de `--settings` dispara, recebe `tool_name`,
  `tool_input` e `cwd` no stdin, e nega a ação com
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`.
  O agente recebe a mensagem como erro da ferramenta, e a negação aparece em
  `result.permission_denials`.
- `--restricted` confina `Write`/`Edit` ao diretório de trabalho (`… is outside …;
  --restricted confines the file tools to the working directory`). Exceção observada: o
  diretório de rascunho do próprio Claude Code, em `/private/tmp/claude-*/…`.
- `Bash` **não** é confinado pelo `--restricted`: `echo d > ../fora.txt` funcionou.
- Com `{"sandbox":{"enabled":true,"allowUnsandboxedCommands":false}}` no `--settings`,
  o `Bash` só escreve no diretório de trabalho: escrita no diretório pai, em `~` e em
  `/tmp` falhou com `operation not permitted`, e a rede foi negada
  (`deny network-outbound example.com:443`). `git commit` dentro do diretório funcionou
  num repositório comum.
- O Claude Code cria um diretório `.claude/` no diretório de trabalho.

## Validação de 2026-10-13

A spec foi revista antes da implementação, contra a documentação do sandbox do Claude Code
e com um experimento real (Haiku, 2.1.296, US$ 0,005) num worktree ligado. O que mudou:

- **O `.git` do projeto precisa de `denyWrite`.** Num worktree ligado, o sandbox libera de
  propósito a escrita no `.git` compartilhado do repositório principal, para o `git commit`
  funcionar. Sem trava, o agente faria commit e moveria refs, inclusive da branch
  principal. Com `sandbox.filesystem.denyWrite: ["<raiz>/.git"]`, `git commit` e
  `git update-ref refs/heads/main` falharam com `Operation not permitted`; `git status` e
  `git diff` seguiram funcionando.
- **`sandbox.failIfUnavailable: true`**: sem sandbox, o próprio Claude Code não inicia (em vez
  de rodar sem ele). Fica junto da checagem do `run`.
- **`sandbox.network.strictAllowlist: true`**: domínio fora da lista é negado sem pedir
  permissão. `registry.npmjs.org` respondeu 200; `example.com` foi negado
  (`host is not on the allow list`). As chaves confirmadas são `network.allowedDomains` e
  `filesystem.denyWrite`/`allowWrite`.
- **O diretório temporário é gravável.** O sandbox aponta `$TMPDIR` para um diretório
  temporário por usuário (`/tmp/claude-<uid>`), e testes que escrevem em temporário
  funcionam. O worktree do experimento estava dentro desse diretório, por isso
  `echo > ../fora.txt` funcionou lá; o teste real do 5.2 confirma em `~/.mabel/worktrees`.
- **O `init` não tem `memory_paths`.** Campo ausente conta como memória desligada. A lista
  de agentes internos em 2.1.296 é `claude`, `claude-code-guide`, `Explore`,
  `general-purpose`, `Plan`, `statusline-setup`.
- **O hook não deve devolver `allow`.** Uma decisão `allow` passaria por cima das regras de
  permissão. Para permitir, o hook sai sem saída e o fluxo normal de permissão segue.
- O hook recebeu a variável `MABEL_ESCOPO` do processo do `claude`, e a negação dele
  apareceu em `result.permission_denials`.
- O Claude Code cria `.claude/.cc-writes` no worktree.
- (Teste real do passo, mesmo dia) Com `--json-schema`, o `init` lista também a ferramenta
  `StructuredOutput`. O `npm` precisa gravar no cache `~/.npm`: os caches do gerenciador de
  pacotes de cada stack entram em `sandbox.filesystem.allowWrite` (catálogo, `caches`).

Desvios decididos na implementação estão no histórico do `docs/PLANO.md`.

## Incremento 5.1 — Contexto hermético (G8)

### Flags em toda run de etapa e no probe

```
--restricted --strict-mcp-config --disable-slash-commands --tools <lista da etapa>
--settings <dados>/runs/<run_id>/settings.json
```

O `exec` avulso continua sem essas flags (é uma ferramenta de diagnóstico do usuário).

### Contexto do projeto montado pelo Mabel

Como o `--restricted` não carrega o `CLAUDE.md`, o Mabel injeta o contexto do projeto no
`--append-system-prompt`, depois do prompt da etapa:

- Lê do worktree, nesta ordem, os que existirem: `CLAUDE.md`, `AGENTS.md`,
  `.mabel/regras-criticas.md` (este já entra em parte das etapas hoje; passa a entrar em
  todas, uma vez só).
- Seção `## Contexto do projeto`, com o caminho de cada arquivo como subtítulo.
- **Orçamento**: no máximo 40.000 caracteres somados. Acima disso, a etapa não inicia e a
  fila pausa com o motivo e o tamanho de cada arquivo; o item fica no estado em que está
  e segue quando o contexto couber. Configurável em `config.json`
  (`contexto.maxCaracteres`). (Revisto: a spec pedia `blocked`, mas `blocked` só volta ao
  `backlog` e o estouro é do projeto, não do item.)
- Arquivos `CLAUDE.md` em subdiretórios não são carregados nesta versão.

### Verificação mecânica do isolamento

No evento `system/init`, o runner confere: `memory_paths` ausente, nulo ou vazio,
`mcp_servers` vazio, `skills` vazio, `slash_commands` vazio e `tools` igual à lista pedida
(como conjunto). Qualquer divergência interrompe a
run (`SIGTERM`), marca `failed` com `error='contexto não hermético: <campo>'` e grava o
`init` completo em `events`. Plugins e agentes internos são permitidos; a lista dos
permitidos fica em código e é comparada pelo nome.

### Critérios de aceite

- [x] `claudeArgs` monta as flags para `kind='stage'` e `kind='probe'`, e não para `exec`.
- [x] Contexto do projeto injetado com os três arquivos, na ordem, uma vez cada.
- [x] Orçamento estourado pausa a fila sem iniciar a run.
- [x] `init` com memória, MCP, skills ou ferramenta extra interrompe a run como `failed`
      (testado com o `claude` falso emitindo cada caso).
- [x] Teste real (Haiku): uma etapa de planejamento num projeto com `CLAUDE.md` recebe o
      conteúdo dele e passa na verificação do `init`.

## Incremento 5.2 — Sandbox e ferramentas por etapa (G4)

### Arquivo de settings por run

`<dados>/runs/<run_id>/settings.json`, gerado antes da run e mantido como evidência:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": ["<domínios da stack e do projeto>"], "strictAllowlist": true },
    "filesystem": { "denyWrite": ["<raiz do projeto>/.git"] }
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node <mabel>/hooks/escopo.mjs" }] }
    ]
  }
}
```

As chaves foram confirmadas na validação de 2026-10-13. O comando do hook usa o `node` que
roda o Mabel (`process.execPath`).

### Ferramentas por etapa

| Etapa | `--tools` | `--allowedTools` |
|---|---|---|
| Planejar | `Read,Glob,Grep` | `Read,Glob,Grep` |
| Executar | `Read,Glob,Grep,Edit,Write,Bash` | os mesmos |
| Revisar | `Read,Glob,Grep,Bash` | `Read,Glob,Grep,Bash(git diff:*),Bash(git log:*),Bash(git show:*)` |
| Probe | `""` (nenhuma) | — |

Isso resolve o achado do teste em que o planejador rodou `cat` e `git status`.

### Rede

- Padrão: negada, exceto os domínios do registro de pacotes da stack, definidos no
  catálogo (`src/stacks.ts`): Node → `registry.npmjs.org`; Python → `pypi.org`,
  `files.pythonhosted.org`; Go → `proxy.golang.org`, `sum.golang.org`; Rust →
  `crates.io`, `static.crates.io`, `index.crates.io`.
- `config.json` ganha `"rede": ["…"]`. O `init` grava nele os domínios da stack escolhida ou
  detectada (o projeto vazio ainda não tem os arquivos que a detecção lê), e o humano
  acrescenta os do projeto. Config sem o campo usa os domínios das stacks detectadas na raiz.
- O `setup` e os comandos de `verify` rodam fora do sandbox (são do Mabel, não do agente).

### Worktree

- Os commits do Mabel excluem `.claude/` (`git add -A -- . ':!.claude'`).
- O executor não consegue fazer commit nem mover refs: o `denyWrite` no `.git` do projeto
  fecha a exceção que o sandbox abre para worktrees. Isso reforça o `--disallowedTools`,
  que continua.

### Sandbox indisponível

O sandbox depende do sistema (macOS: `sandbox-exec`; Linux: `bubblewrap`). Sem ele, o
`run` **não inicia** e explica o motivo. Escape explícito: `"sandbox": false` no
`config.json`, que o `run` aceita com aviso em cada execução e registra em cada run.

### Critérios de aceite

- [x] `settings.json` gerado por run, com sandbox, rede da stack e do projeto e o hook.
- [x] `--tools` e `--allowedTools` por etapa conforme a tabela.
- [x] Commits do Mabel não incluem `.claude/`.
- [x] `git commit` e `git update-ref` pelo agente falham no sandbox.
- [x] `run` recusa iniciar sem sandbox disponível, salvo `"sandbox": false`.
- [x] Teste real (Haiku), executor num worktree em `~/.mabel/worktrees`: escrita no
      diretório pai e em `~` falha; `npm install <pacote pequeno>` funciona com a rede da
      stack; acesso a outro domínio falha.

## Incremento 5.3 — Hook de escopo (G4)

### Contexto do hook

Antes de cada run de etapa, o Mabel grava `<dados>/runs/<run_id>/escopo.json` e passa o
caminho na variável `MABEL_ESCOPO` do processo do `claude` (os hooks herdam o ambiente):

```json
{
  "worktree": "/abs/worktree",
  "stage": "execute",
  "escopo": ["src/export/**", "test/export/**"],
  "criticos": ["src/billing/**"],
  "criticosAprovados": false,
  "log": "<dados>/runs/<run_id>/hook.jsonl"
}
```

### Regras, em ordem

Para `Write`, `Edit`, `MultiEdit` e `NotebookEdit`, com o caminho normalizado (absoluto,
`realpath` do diretório pai):

1. Fora do worktree → nega: `fora do worktree do item`.
2. Dentro de `.git/` ou `.mabel/` → nega: `arquivo do Mabel ou do git`.
3. Casa com um caminho crítico e `criticosAprovados` é falso → nega:
   `caminho crítico sem aprovação: <glob>`.
4. Não casa com nenhum glob do `escopo` → nega:
   `fora do escopo do plano; declare em escopoAdicional se for necessário`.
5. Senão, permite.

Para `Bash`: o hook não interpreta o comando (o sandbox confina a escrita). Só registra.

Toda decisão (permitida ou negada) é anexada ao `log` em JSONL. O hook não tem
dependências, roda com `node` e falha **fechado**: erro ao ler o contexto nega a ação.
Permitir é sair sem saída (nunca `permissionDecision: "allow"`, que passaria por cima das
regras de permissão).

### Escopo adicional

O esquema da execução ganha `escopoAdicional: { glob: string; motivo: string }[]`. Quando
a execução termina com `escopoAdicional` não vazio:

- Glob que casa com caminho crítico sem aprovação → `needs_human` com
  `pending_kind='critical_approval'`.
- Senão, o Mabel amplia o `escopo` do item (grava no plano e em `gate_results` com
  `gate='scope_extension'`), registra a decisão como autônoma e retoma a mesma sessão da
  execução para concluir. Não conta como tentativa.

### Auditoria

- O runner importa o `hook.jsonl` para `events` (`type='hook'`, `subtype` = `allow` ou
  `deny`) ao fim da run.
- `runs` ganha `denials INTEGER` (tamanho de `result.permission_denials`).
- `mabel item <n>` mostra as negações de cada tentativa.

### Critérios de aceite

- [x] Cada regra do hook coberta por teste, executando o script com stdin simulado.
- [x] Erro de leitura do contexto nega a ação.
- [x] `escopoAdicional` não crítico amplia o escopo e retoma a sessão; crítico vai para
      `critical_approval`.
- [x] Decisões do hook em `events` e `runs.denials` preenchido.
- [x] Teste real (Haiku): escrita fora do escopo negada com a mensagem; escrita no escopo
      permitida.

## Incremento 5.4 — Contrato, preflight e documentação

- Contrato, com autorização do usuário:
  - G4, mecanismo: hook `PreToolUse` de escopo, `--restricted` (ferramentas de arquivo no
    worktree), sandbox (terminal e rede) e `--disallowedTools`.
  - G8, mecanismo: `--restricted`, `--strict-mcp-config`, `--disable-slash-commands`,
    `--tools` por etapa, contexto do projeto injetado pelo Mabel e verificação do `init`.
  - "Regras críticas", caminhos: "imposto pelo hook de escopo".
- `scripts/setup.sh`: preflight confere `claude --help` com `--restricted` e
  `--disable-slash-commands`, e a disponibilidade do sandbox no sistema.
- README: remove o aviso de projeto descartável e descreve as travas.
- `BACKLOG.md`: retira "Restringir as ferramentas de cada etapa com `--tools`" e
  "Contexto hermético: medir o efeito", resolvidos aqui.

### Critérios de aceite

- [x] Contrato atualizado conforme a autorização registrada no histórico do plano.
- [x] Preflight falha com mensagem clara sem as flags ou sem sandbox.

## Depois do passo 5 — Gate de escopo

O hook não interpreta o `Bash`, e o sandbox deixa o terminal escrever em qualquer lugar do
worktree. O gate `scope` fecha essa porta: é o primeiro da verificação, antes do merge da
origem e dos comandos.

- Arquivos do item: `git diff --name-only --no-renames <merge-base com a origem> HEAD`
  (apagar também conta). O merge da origem no item não entra, porque a base é o
  `merge-base`.
- Cada arquivo passa pelas regras 2 a 4 do hook (`scopeViolation` em `src/scope.ts`, a mesma
  função do hook): `.git/` ou `.mabel/`, caminho crítico sem aprovação, fora do escopo do
  plano (já com o `escopoAdicional` aceito).
- Arquivos gerados pelo `setup` do Mabel num worktree novo (o worktree nasce limpo; o que
  aparece no `git status` depois do setup é dele, como o lockfile) ficam em
  `<dados>/items/<id>/setup-arquivos.json`, acumulados entre recriações do worktree, e não
  contam.
- Violação grava `gate_results` (`gate='scope'`, um motivo por arquivo) e é uma tentativa
  reprovada: volta à execução com a lista e o caminho (desfazer ou declarar em
  `escopoAdicional`; o crítico segue para `critical_approval` por esse caminho).

### Critérios de aceite

- [x] Escrita fora do escopo, em `.mabel/` e em caminho crítico sem aprovação reprova a
      tentativa com o motivo de cada arquivo; desfeita, a tentativa seguinte passa.
- [x] Arquivos do `setup` não contam.

## Fora deste passo

Hook para `Bash` que interprete comandos; `CLAUDE.md` de subdiretórios; regras de rede por
etapa; travas para o `exec` avulso.
