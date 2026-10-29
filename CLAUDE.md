# Mabel

Harness que usa o Claude Code CLI como subprocesso para executar o backlog de um projeto
com agentes, de forma auditável e com intervenção humana só em regras de negócio críticas.

## Leia antes de agir

1. `docs/CONTRATO.md` — o que o Mabel garante e o que apenas pede. Toda decisão de
   implementação respeita o contrato; mudá-lo exige autorização do usuário.
2. `docs/PLANO.md` — estado da implementação. O próximo passo é o primeiro item não marcado.
3. `BACKLOG.md` — ideias em discussão. A seção do usuário é dele: não edite. A seção do
   Claude pode receber ideias novas que precisem ser aprofundadas.

## Método

- Decisão com mais de um caminho defensável vai para o usuário, com recomendação. Durante
  uma implementação, não pare por ela: siga com a recomendação, registre o desvio no
  histórico do `docs/PLANO.md` e traga as perguntas numeradas, cada uma com a sugestão, no
  fim. Mudança no contrato continua exigindo autorização antes.
- Ao concluir uma tarefa do plano, marque-a e registre no histórico do `docs/PLANO.md`.
- Ideia nova que não cabe na tarefa atual vai para a seção do Claude no `BACKLOG.md`.
- `docs/ESTEIRA.html` é o fluxograma do funcionamento do Mabel: comandos e o que gravam,
  agentes (modelo, ferramentas, limites, saída), gates, estados e pendências. Mudança em
  qualquer um deles atualiza o arquivo na mesma mudança. É HTML de arquivo único, sem build;
  a grade do fluxo tem 24 linhas contadas (`grid-template-rows` e `.rail`): nó ou fase nova
  na esteira ajusta essas contagens.

## Código

- Node ≥ 22.18 executa TypeScript direto, sem build. Use só sintaxe apagável
  (`erasableSyntaxOnly`): nada de `enum`, `namespace` ou parameter properties.
- Imports locais com extensão `.ts`.
- Sem dependências de runtime: prefira os módulos `node:` (`node:sqlite`, `node:test`,
  `node:util` `parseArgs`). Dependência nova exige justificativa ao usuário.
- Identificadores em inglês; textos para o usuário e documentação em português.
- `npm run check` (typecheck + testes) precisa passar antes de qualquer commit.
- Tabela nova no banco ou diretório novo em `~/.mabel`: classifique em `src/projects.ts`
  se entra na remoção de projeto (`docs/specs/projetos.md`).
- `assets/*.txt` são grids editáveis pelo usuário: `#` aceso, `.` apagado.
