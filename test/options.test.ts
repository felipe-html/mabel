import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commands } from '../src/commands.ts';
import { commandsJson, renderHelp, zshCompletion } from '../src/completion.ts';

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
  const help = renderHelp(commands.find((command) => command.name === 'rodar') as (typeof commands)[number]);
  assert.match(help, /Uso: mabel rodar/);
  assert.match(help, /Opções:\n {2}--item <n> {2}Processa só este item/);
  assert.match(help, /--sem-lote {2}Item a item/);

  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'adicionar', '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Argumentos:\n {2}"<título>"\s+Título do item/);
  assert.match(result.stdout, /--criterio <texto>\s+Critério de aceite \(repetível\)/);
  assert.match(result.stdout, /--referencia <entrada>/);
});

test('comandos --json: cada comando com argumentos, escolhas e opções', () => {
  const json = commandsJson(commands) as { comandos: { nome: string; opcoes: Record<string, unknown>[]; argumentos: Record<string, unknown>[] }[] };
  const run = json.comandos.find((command) => command.nome === 'rodar');
  assert.deepEqual(run?.opcoes[0], {
    nome: '--item',
    tipo: 'texto',
    valor: '<n>',
    descricao: 'Processa só este item, do planejamento ao fim',
    repetivel: false,
    valores: 'item',
  });
  const project = json.comandos.find((command) => command.nome === 'auditar');
  assert.deepEqual((project?.argumentos[0]?.escolhas as { nome: string }[]).map((choice) => choice.nome), ['remover']);

  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'comandos', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).versao, 1);
  const text = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'comandos'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(text.stdout, /rodar {2}Planeja os itens prontos[^\n]*\n {4}--item <n> +Processa só este item/);
});

// Autocompletar do zsh ---------------------------------------------------------------------

test('completion zsh: opções com explicação, valores lidos na hora e sintaxe válida', () => {
  const script = zshCompletion(commands);
  assert.match(script, /_mabel_cmd_rodar\(\) \{\n {2}_arguments \\\n {4}'--item\[Processa só este item, do planejamento ao fim\]:n:_mabel_valores item n'/);
  assert.match(script, /'\*--criterio\[Critério de aceite \(repetível\)\]:texto: '/);
  assert.match(script, /'1:n:_mabel_valores item n'/);
  assert.match(script, /_mabel_escolhas_auditar_1\(\) \{[\s\S]*'remover:Apaga os dados/);
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
