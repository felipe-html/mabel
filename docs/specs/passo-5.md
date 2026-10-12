# Especificação — Passo 5: travas

Garantias do contrato cobertas: **G8** (contexto hermético) e **G4** (o agente não sai do
escopo). Hoje G8 não existe e G4 é só uma lista de comandos proibidos. Ao fim deste passo,
o aviso de "use só em projeto descartável" sai do README.

Leia `docs/CONTRATO.md` antes desta especificação. Incrementos, cada um com
`npm run check` verde, critérios atendidos, `docs/PLANO.md` atualizado e commit:

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
- **Orçamento**: no máximo 40.000 caracteres somados. Acima disso, a etapa não inicia e o
  item vai para `blocked` com o motivo e o tamanho de cada arquivo. Configurável em
  `config.json` (`contexto.maxCaracteres`).
- Arquivos `CLAUDE.md` em subdiretórios não são carregados nesta versão.

### Verificação mecânica do isolamento

No evento `system/init`, o runner confere: `memory_paths` nulo ou vazio, `mcp_servers`
vazio, `skills` vazio e `tools` igual à lista pedida. Qualquer divergência interrompe a
run (`SIGTERM`), marca `failed` com `error='contexto não hermético: <campo>'` e grava o
`init` completo em `events`. Plugins e agentes internos são permitidos; a lista dos
permitidos fica em código e é comparada pelo nome.

### Critérios de aceite

- [ ] `claudeArgs` monta as flags para `kind='stage'` e `kind='probe'`, e não para `exec`.
- [ ] Contexto do projeto injetado com os três arquivos, na ordem, uma vez cada.
- [ ] Orçamento estourado leva o item a `blocked` sem iniciar a run.
- [ ] `init` com memória, MCP, skills ou ferramenta extra interrompe a run como `failed`
      (testado com o `claude` falso emitindo cada caso).
- [ ] Teste real (Haiku): uma etapa de planejamento num projeto com `CLAUDE.md` recebe o
      conteúdo dele e passa na verificação do `init`.

## Incremento 5.2 — Sandbox e ferramentas por etapa (G4)

### Arquivo de settings por run

`<dados>/runs/<run_id>/settings.json`, gerado antes da run e mantido como evidência:

```json
{
  "sandbox": {
    "enabled": true,
    "allowUnsandboxedCommands": false,
    "network": { "allowedDomains": ["<domínios da stack e do projeto>"] }
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash",
        "hooks": [{ "type": "command", "command": "node <mabel>/hooks/escopo.mjs" }] }
    ]
  }
}
```

Os nomes exatos das chaves de rede e de caminhos graváveis extras do sandbox precisam ser
confirmados na documentação do Claude Code durante a implementação; só
`sandbox.enabled` e `allowUnsandboxedCommands` foram observados.

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
- `config.json` ganha `"rede": ["…"]` para domínios extras do projeto.
- O `setup` e os comandos de `verify` rodam fora do sandbox (são do Mabel, não do agente).

### Worktree

- Os commits do Mabel excluem `.claude/` (`git add -A -- . ':!.claude'`).
- O executor não consegue fazer commit: o índice do worktree fica no `.git` do projeto,
  fora do diretório gravável. Isso reforça o `--disallowedTools`, que continua.

### Sandbox indisponível

O sandbox depende do sistema (macOS: `sandbox-exec`; Linux: `bubblewrap`). Sem ele, o
`run` **não inicia** e explica o motivo. Escape explícito: `"sandbox": false` no
`config.json`, que o `run` aceita com aviso em cada execução e registra em cada run.

### Critérios de aceite

- [ ] `settings.json` gerado por run, com sandbox, rede da stack e do projeto e o hook.
- [ ] `--tools` e `--allowedTools` por etapa conforme a tabela.
- [ ] Commits do Mabel não incluem `.claude/`.
- [ ] `run` recusa iniciar sem sandbox disponível, salvo `"sandbox": false`.
- [ ] Teste real (Haiku), executor num worktree em `~/.mabel/worktrees`: escrita no
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

- [ ] Cada regra do hook coberta por teste, executando o script com stdin simulado.
- [ ] Erro de leitura do contexto nega a ação.
- [ ] `escopoAdicional` não crítico amplia o escopo e retoma a sessão; crítico vai para
      `critical_approval`.
- [ ] Decisões do hook em `events` e `runs.denials` preenchido.
- [ ] Teste real (Haiku): escrita fora do escopo negada com a mensagem; escrita no escopo
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

- [ ] Contrato atualizado só depois da autorização registrada no histórico do plano.
- [ ] Preflight falha com mensagem clara sem as flags ou sem sandbox.

## Fora deste passo

Hook para `Bash` que interprete comandos; `CLAUDE.md` de subdiretórios; regras de rede por
etapa; travas para o `exec` avulso.
