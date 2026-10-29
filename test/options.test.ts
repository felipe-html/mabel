import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commands } from '../src/commands.ts';
import { commandsJson, renderHelp, zshCompletion } from '../src/completion.ts';
import { type LineContext, type LineState, type LineStep, initialLine, lineStep, renderBelow, suggestionsFor } from '../src/line.ts';
import type { Key } from '../src/menu.ts';
import { cachedValues, replCommandSpecs } from '../src/repl.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// Declaração única ------------------------------------------------------------------------

test('toda opção e todo argumento de comando têm explicação', () => {
  for (const command of commands) {
    for (const [name, spec] of Object.entries(command.options ?? {})) {
      assert.ok(spec.description.trim(), `${command.name} --${name} sem descrição`);
      if (spec.type === 'string') assert.ok(spec.value, `${command.name} --${name} sem nome de valor`);
    }
    for (const arg of command.args ?? []) assert.ok(arg.description.trim(), `${command.name} ${arg.name} sem descrição`);
  }
});

test('nenhum parseArgs declara opções à mão: todas vêm da declaração com explicação', () => {
  for (const file of readdirSync(SRC).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(join(SRC, file), 'utf8');
    for (const match of text.matchAll(/parseArgs\(\{[\s\S]*?\}\)/g)) {
      assert.doesNotMatch(match[0], /options:\s*\{/, `${file}: opções escritas dentro do parseArgs`);
    }
  }
});

test('opções usadas no uso de cada comando estão declaradas', () => {
  for (const command of commands) {
    for (const [, name] of command.usage.matchAll(/--([a-z-]+)/g)) {
      assert.ok(name && command.options?.[name], `${command.name}: --${name} no uso, mas não declarada`);
    }
  }
});

test('--help mostra argumentos e opções explicados', () => {
  const help = renderHelp(commands.find((command) => command.name === 'run') as (typeof commands)[number]);
  assert.match(help, /Uso: mabel run/);
  assert.match(help, /Opções:\n {2}--item <n> {2}Processa só este item/);
  assert.match(help, /--sem-lote {2}Item a item/);

  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'add', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Argumentos:\n {2}"<título>"\s+Título do item/);
  assert.match(result.stdout, /--criterio <texto>\s+Critério de aceite \(repetível\)/);
  assert.match(result.stdout, /--referencia <entrada>/);
});

test('comandos --json: cada comando com argumentos, escolhas e opções', () => {
  const json = commandsJson(commands) as { comandos: { nome: string; opcoes: Record<string, unknown>[]; argumentos: Record<string, unknown>[] }[] };
  const run = json.comandos.find((command) => command.nome === 'run');
  assert.deepEqual(run?.opcoes[0], {
    nome: '--item',
    tipo: 'texto',
    valor: '<n>',
    descricao: 'Processa só este item, do planejamento ao fim',
    repetivel: false,
    valores: 'item',
  });
  const project = json.comandos.find((command) => command.nome === 'projeto');
  assert.deepEqual((project?.argumentos[0]?.escolhas as { nome: string }[]).map((choice) => choice.nome), ['remover']);

  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'comandos', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).versao, 1);
  const text = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'comandos'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(text.stdout, /run {2}Consome a fila[^\n]*\n {4}--item <n> +Processa só este item/);
});

// Autocompletar do zsh ---------------------------------------------------------------------

test('completion zsh: opções com explicação, valores lidos na hora e sintaxe válida', () => {
  const script = zshCompletion(commands);
  assert.match(script, /_mabel_cmd_run\(\) \{\n {2}_arguments \\\n {4}'--item\[Processa só este item, do planejamento ao fim\]:n:_mabel_valores item n'/);
  assert.match(script, /'\*--criterio\[Critério de aceite \(repetível\)\]:texto: '/);
  assert.match(script, /'1:n:_mabel_valores item n'/);
  assert.match(script, /_mabel_escolhas_projeto_1\(\) \{[\s\S]*'remover:Apaga os dados/);
  const path = join(tmpdir(), `mabel-completion-${process.pid}.zsh`);
  writeFileSync(path, script);
  const check = spawnSync('zsh', ['-n', path], { encoding: 'utf8' });
  if (!check.error) assert.equal(check.status, 0, check.stderr);
});

test('completion valores: stacks com descrição; fonte desconhecida é recusada', () => {
  const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'completion', 'valores', 'stack'], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^node:Node\/TypeScript$/m);
  assert.equal(spawnSync(process.execPath, [CLI, 'completion', 'valores', 'gatos'], { encoding: 'utf8' }).status, 1);
});

// Modo Mabel ---------------------------------------------------------------------------------

const plain = { dim: (t: string) => t, bold: (t: string) => t, accent: (t: string) => t };

const context: LineContext = {
  suggestions: [{ name: 'run', description: 'Fila' }],
  commandSpecs: replCommandSpecs(),
  values: cachedValues((source) =>
    source === 'item'
      ? [
          { value: '3', description: 'Login · ready' },
          { value: '7', description: 'Cadastro de acesso · backlog' },
        ]
      : source === 'referencia'
        ? [{ value: 'tela: cadastro-acesso', description: 'tela.png, tela.md' }]
        : [],
  ),
  history: [],
};

function stateOf(step: LineStep): LineState {
  assert.ok('state' in step, `esperava estado, veio ${JSON.stringify(step)}`);
  return step.state;
}

function type(text: string, keys: Key[] = []): LineState {
  let state = initialLine(context);
  for (const sequence of text) state = stateOf(lineStep(state, { sequence }, context));
  for (const key of keys) state = stateOf(lineStep(state, key, context));
  return state;
}

const labels = (state: LineState) => (suggestionsFor(state, context) ?? []).map((suggestion) => suggestion.label);

test('espaço depois do comando abre as opções com a explicação', () => {
  const state = type('/run ');
  assert.deepEqual(labels(state), ['--item <n>', '--uma', '--sem-lote', '--fundo', '--json']);
  const lines = renderBelow(state, context, plain, 120);
  assert.match(lines[0] ?? '', /^ {2}--item <n> {2}Processa só este item/);
  assert.match(lines.at(-1) ?? '', /tab completa · ↑\/↓ escolhe · enter executa/);
});

test('opção já usada sai da lista; repetível continua; -- filtra', () => {
  assert.ok(!labels(type('/run --uma ')).includes('--uma'));
  assert.deepEqual(labels(type('/run --s')), ['--sem-lote']);
  assert.ok(labels(type('/add "x" --criterio a ')).includes('--criterio <texto>'));
});

test('opção que espera valor oferece os valores da fonte, filtrados pelo texto', () => {
  assert.deepEqual(labels(type('/run --item ')), ['3', '7']);
  assert.deepEqual(labels(type('/run --item cad')), ['7']);
  assert.equal(suggestionsFor(type('/add "x" --intencao '), context), undefined, 'texto livre não abre lista');
});

test('argumento com fonte: itens antes das opções; escolhas fixas do subcomando', () => {
  assert.deepEqual(labels(type('/aprovar ')), ['3', '7', '--json']);
  assert.deepEqual(labels(type('/projeto r')), ['remover']);
});

test('tab completa a palavra; valor com espaço entra entre aspas', () => {
  assert.equal(type('/run --it', [{ name: 'tab' }]).text, '/run --item ');
  const state = type('/add "x" --referencia ', [{ name: 'tab' }]);
  assert.equal(state.text, '/add "x" --referencia "tela: cadastro-acesso" ');
});

test('enter executa a linha; depois das setas, escolhe da lista', () => {
  assert.deepEqual(lineStep(type('/run '), { name: 'return' }, context), { submit: '/run ' });
  const moved = type('/run ', [{ name: 'down' }, { name: 'down' }]);
  const chosen = stateOf(lineStep(moved, { name: 'return' }, context));
  assert.equal(chosen.text, '/run --uma ');
  assert.equal(chosen.navigated, false);
});

test('aspas abertas e cursor no meio fecham a lista', () => {
  assert.equal(suggestionsFor(type('/responder 7 "texto '), context), undefined);
  assert.equal(suggestionsFor(type('/run ', [{ name: 'left' }]), context), undefined);
});
