import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interrupted } from '../src/ask.ts';
import { BACKLOG_TEMPLATE } from '../src/backlog.ts';
import type { GuidedIO } from '../src/guided.ts';
import { commitMabelDir } from '../src/init.ts';
import { openDb } from '../src/db.ts';
import { resolveProject } from '../src/project.ts';

// Sem avisos do sistema nos testes, no processo atual e nos filhos.
process.env.MABEL_NOTIFICAR = '0';

export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
export const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

/** Repositório git temporário, na branch `main`, com os arquivos dados e um commit inicial. */
export function makeRepo(files: Record<string, string> = {}, { commit = true } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'mabel-repo-'));
  const run = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Teste');
  run('config', 'user.email', 'teste@example.com');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  if (commit) {
    writeFileSync(join(root, 'README.md'), '# teste\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'inicial');
  }
  return root;
}

/** Projeto Mabel num repositório temporário, com `MABEL_HOME` próprio e o banco aberto. */
export function setupProject(backlog?: string, options: { integracao?: string } = {}) {
  const root = makeRepo({ 'src/index.js': '', 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
  const home = mkdtempSync(join(tmpdir(), 'mabel-home-'));
  // O ambiente é lido a cada chamada: cenários do `claude` falso valem também para o CLI.
  const env = () => ({ ...process.env, MABEL_HOME: home, NO_COLOR: '1', MABEL_NOTIFICAR: '0' });
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: env(),
    });
  assert.equal(cli('preparar').status, 0);
  const path = join(root, '.mabel', 'backlog.md');
  if (backlog !== undefined) writeFileSync(path, BACKLOG_TEMPLATE + backlog);
  // Os testes do pipeline usam arquivos de teste falsos: a prova roda no modo por item e,
  // sem comando de teste no `verify`, deixa os critérios sem prova. `proof.test.ts` a liga.
  // Sem integração: uma branch por item, como antes do P.4. `integration.test.ts` a liga.
  const configPath = join(root, '.mabel', 'config.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...raw, testeUnico: null, integracao: options.integracao ?? null }, null, 2));
  commitMabelDir(root);
  const db = openDb(home);
  const project = resolveProject(db, root);
  return { root, home, env, cli, path, db, project };
}

/** Aponta o `claude` falso (no processo atual) para um cenário com as respostas dadas. */
export function useScenario(dir: string, responses: unknown[]): { log: () => { argv: string[]; session_id: string; cwd: string; figmaToken?: boolean }[] } {
  const scenario = join(dir, `cenario-${Math.random().toString(36).slice(2)}.json`);
  const log = `${scenario}.log`;
  writeFileSync(scenario, JSON.stringify({ responses }));
  Object.assign(process.env, {
    MABEL_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_SCENARIO: scenario,
    FAKE_CLAUDE_LOG: log,
    CLAUDE_CONFIG_DIR: join(dir, 'claude-config'),
  });
  return {
    log: () => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

export const PLAN = {
  resumo: 'Criar a função soma.',
  criterios: [{ id: 'C1', texto: 'soma(2, 3) devolve 5', verificacao: 'teste', comportamento: 'novo' }],
  escopo: ['src/**', 'test/**'],
  passos: ['Criar src/soma.js', 'Criar test/soma.test.js'],
  suposicoes: [],
  conceitosCriticos: [],
  perguntas: [],
};

export const EXECUTION = {
  resumo: 'Função soma criada com teste.',
  criterios: [{ id: 'C1', testes: [{ arquivo: 'test/soma.test.js', nome: 'soma de dois números' }] }],
  suposicoes: [],
  perguntas: [],
  escopoAdicional: [],
  impedimento: '',
};

export const EXECUTION_FILES = {
  'src/soma.js': 'export const soma = (a, b) => a + b;\n',
  'test/soma.test.js': "test('soma de dois números', () => {});\n",
};

export const REVIEW_OK = {
  criterios: [{ id: 'C1', atendido: true, evidencia: 'test/soma.test.js' }],
  problemas: [],
};

// Interface guiada ------------------------------------------------------------------------

/** Resposta roteirizada: o começo do rótulo da opção, o texto do campo (`null` cancela) ou a lista final. */
export type GuidedAnswer = string | string[] | null;

/**
 * Terminal falso da interface guiada: devolve as respostas na ordem; sem respostas, simula
 * o ctrl+c. Em `choose`, a resposta é o começo do rótulo e precisa casar com uma opção.
 * `lines` guarda o que foi escrito; `prompts`, as opções e os campos mostrados.
 */
export function scriptedGuided(answers: GuidedAnswer[]): GuidedIO & { lines: string[]; prompts: string[] } {
  const lines: string[] = [];
  const prompts: string[] = [];
  const next = (): GuidedAnswer => {
    if (answers.length === 0) throw new Interrupted();
    return answers.shift() as GuidedAnswer;
  };
  return {
    lines,
    prompts,
    write: (line) => lines.push(line),
    choose: async (options) => {
      const labels = options.map((option) => (typeof option === 'string' ? option : option.label));
      prompts.push(labels.join(' | '));
      const answer = next();
      if (typeof answer !== 'string') throw new Error(`resposta ${JSON.stringify(answer)} para um menu: ${labels.join(' | ')}`);
      const exact = labels.indexOf(answer);
      const index = exact >= 0 ? exact : labels.findIndex((label) => label.startsWith(answer));
      if (index < 0) throw new Error(`"${answer}" não está no menu: ${labels.join(' | ')}`);
      return index;
    },
    text: async (label) => {
      prompts.push(label);
      const answer = next();
      if (Array.isArray(answer)) throw new Error(`lista ${JSON.stringify(answer)} para o campo ${label}`);
      return answer;
    },
    list: async (title, entries) => {
      prompts.push(title);
      const answer = next();
      if (answer === null) return entries;
      if (!Array.isArray(answer)) throw new Error(`"${answer}" para a lista ${title}; use uma lista`);
      return answer;
    },
  };
}

/**
 * Padrões proibidos nas mensagens do modo interativo (`docs/specs/terminal.md`): tecla com
 * significado próprio, `[s/N]` e texto com sintaxe.
 */
export const FORBIDDEN_PATTERNS: [RegExp, string][] = [
  [/\[[sS]\/[nN]/, '[s/N]'],
  [/um por linha/i, 'um por linha'],
  [/linha vazia (encerra|termina)/i, 'linha vazia encerra'],
  [/\benter (mantém|aceita|vazio|parte|para nenhum)/i, 'enter com significado'],
  // Tecla de uma letra, como nas dicas antigas: no começo, depois de "·" ou "[", ou entre crases.
  [
    /(?:(?:^['"`]?|·\s*|\[)[a-z]|`[a-z]`) (aceita|edita|pula|mostra|remove|descarta|decide|sai|sair|escolhe|detalha|replaneja|cancela|aprova|confirma|corrige|retoma|orienta|deixa)(?=[\s·,.:)\]'"`]|$)/,
    'tecla de uma letra',
  ],
  [/(^|[\s·])- (remove|descarta|não cria)/, '- remove'],
  [/responda (enter|e, |a, )/i, 'responda enter'],
  [/ctrl\+d/i, 'ctrl+d'],
  [/\bq (para )?sair/i, 'q sair'],
  [/Número do item( a \w+)?: /, 'número digitado'],
  [/\btab completa/i, 'tab'],
];

/** Padrões proibidos que o texto contém. */
export function guidedProblems(text: string): string[] {
  return FORBIDDEN_PATTERNS.flatMap(([pattern, name]) => (pattern.test(text) ? [`${name}: ${text}`] : []));
}
