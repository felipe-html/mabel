import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initViolation } from '../src/hermetic.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { MCP_SERVER, type ToolsConfig, VerifyTool, plannedCommands } from '../src/mcp.ts';
import { claudeArgs } from '../src/runner.ts';
import { type StageContext, runExecute, stageRequest } from '../src/stages.ts';
import { prepareWorktree } from '../src/worktree.ts';
import { EXECUTION, PLAN, setupProject, useScenario } from './helpers.ts';

// Ferramenta `verificar` do Mabel (docs/specs/ferramentas.md).

function worktree(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'mabel-mcp-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function tools(dir: string, overrides: Partial<ToolsConfig> = {}): ToolsConfig {
  mkdirSync(join(dir, '.run'), { recursive: true });
  return {
    worktree: dir,
    verify: [{ name: 'test', command: 'echo verde' }],
    testeUnico: 'printf "%s|%s" {arquivo} {nome} > saida.txt',
    log: join(dir, '.run', 'verificar.jsonl'),
    logDir: join(dir, '.run'),
    maxCalls: 8,
    timeoutMs: 60_000,
    ...overrides,
  };
}

test('V4/V5: argumentos recusados antes de montar o comando', () => {
  const dir = worktree({ 'test/a.spec.ts': '', 'fora.txt': '' });
  symlinkSync(tmpdir(), join(dir, 'link'));
  const config = tools(dir);
  const refused = (args: object) => {
    const result = plannedCommands(config, args);
    assert.ok(!Array.isArray(result), JSON.stringify(args));
    return result.error;
  };
  assert.match(refused({ arquivo: 'test/a.spec.ts' }), /juntos/);
  assert.match(refused({ arquivo: '/etc/passwd', nome: 'x' }), /relativo/);
  assert.match(refused({ arquivo: 'test/../fora.txt', nome: 'x' }), /\.\./);
  assert.match(refused({ arquivo: 'test/b.spec.ts', nome: 'x' }), /não existe/);
  assert.match(refused({ arquivo: '--config=x', nome: 'x' }), /"-"/);
  assert.match(refused({ arquivo: 'test/a.spec.ts', nome: '-x' }), /"-"/);
  assert.match(refused({ arquivo: 'test/a.spec.ts', nome: 'a\nb' }), /quebra de linha/);
  assert.match(refused({ arquivo: 'test/a.spec.ts', nome: 'x'.repeat(501) }), /500/);
  assert.match(refused({ arquivo: 'test/a.spec.ts', nome: 'x', comando: 'rm' }), /desconhecido: comando/);
  assert.match(refused({ arquivo: 'link/x', nome: 'x' }), /não existe|fora do worktree/);
  assert.match((plannedCommands({ ...config, testeUnico: null }, { arquivo: 'test/a.spec.ts', nome: 'x' }) as { error: string }).error, /sem argumentos/);
  assert.match((plannedCommands({ ...config, verify: [] }, {}) as { error: string }).error, /verify/);
  assert.deepEqual(plannedCommands(config, {}), [{ name: 'test', command: 'echo verde' }]);
});

test('V5: nome com metacaracteres chega literal ao comando, sem injeção de shell', async () => {
  const dir = worktree({ 'test/a.spec.ts': '' });
  const tool = new VerifyTool(tools(dir));
  const name = `x'; touch injetado; echo '$(touch injetado2) \`touch injetado3\` "aspas"`;
  const result = await tool.call({ arquivo: 'test/a.spec.ts', nome: name });
  assert.equal(result.isError, false, result.text);
  assert.equal(readFileSync(join(dir, 'saida.txt'), 'utf8'), `test/a.spec.ts|${name}`);
  for (const file of ['injetado', 'injetado2', 'injetado3']) assert.ok(!existsSync(join(dir, file)), file);
});

test('V4/V9/V11: verify em ordem para no primeiro vermelho, devolve o log e grava o registro', async () => {
  const dir = worktree();
  const config = tools(dir, {
    verify: [
      { name: 'lint', command: 'echo lint ok' },
      { name: 'test', command: 'echo falhou o teste; exit 3' },
      { name: 'build', command: 'touch nao-devia' },
    ],
  });
  const result = await new VerifyTool(config).call({});
  assert.equal(result.isError, false);
  assert.match(result.text, /`echo lint ok` \(lint\) saiu com 0/);
  assert.match(result.text, /\(test\) saiu com 3[\s\S]*falhou o teste/);
  assert.match(result.text, /Chamada 1 de 8[\s\S]*não conta como verificação/);
  assert.ok(!existsSync(join(dir, 'nao-devia')));
  const records = readFileSync(config.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records[0].inicio, true);
  assert.deepEqual(records.slice(1).map((r) => [r.comando, r.codigo]), [['echo lint ok', 0], ['echo falhou o teste; exit 3', 3]]);
  assert.equal(readFileSync(records[2].log, 'utf8'), 'falhou o teste\n');
});

test('V8: limite de chamadas e tempo máximo encerram sem rodar mais', async () => {
  const dir = worktree();
  const limited = new VerifyTool(tools(dir, { maxCalls: 2 }));
  assert.equal((await limited.call({})).isError, false);
  assert.equal((await limited.call({})).isError, false);
  const third = await limited.call({});
  assert.equal(third.isError, true);
  assert.match(third.text, /limite de 2 verificações/);

  const slow = new VerifyTool(tools(dir, { verify: [{ name: 'test', command: 'sleep 5; touch tarde' }], timeoutMs: 300 }));
  const started = Date.now();
  const result = await slow.call({});
  assert.ok(Date.now() - started < 3000, 'o prazo encerra o comando');
  assert.match(result.text, /passou do tempo máximo/);
  await new Promise((done) => setTimeout(done, 100));
  assert.ok(!existsSync(join(dir, 'tarde')));
});

test('V11: sem registro gravável, a chamada é recusada sem rodar o comando (G1)', async () => {
  const dir = worktree();
  const config = tools(dir, { verify: [{ name: 'test', command: 'touch rodou' }], log: join(dir, 'nao', 'existe', 'verificar.jsonl') });
  const result = await new VerifyTool(config).call({});
  assert.equal(result.isError, true);
  assert.match(result.text, /registro/);
  assert.ok(!existsSync(join(dir, 'rodou')));
});

test('V1: protocolo stdio: sonda, initialize, tools/list, tools/call e método desconhecido', async () => {
  const dir = worktree();
  const configPath = join(dir, '.run', 'ferramentas.json');
  mkdirSync(join(dir, '.run'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(tools(dir)));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MCP_SERVER, configPath], { stdio: ['pipe', 'pipe', 'inherit'] });
  const responses: Record<string, unknown>[] = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) responses.push(JSON.parse(line));
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  send({ id: 'probe', method: 'server/discover' });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'verificar', arguments: {} } });
  send({ id: 4, method: 'tools/call', params: { name: 'outra', arguments: {} } });
  child.stdin.end();
  await new Promise((done) => child.on('close', done));
  const byId = (id: unknown) => responses.find((r) => r.id === id) as { result?: any; error?: any };
  assert.equal(responses.length, 5, 'notificação não tem resposta');
  assert.equal(byId('probe').error.code, -32601);
  assert.equal(byId(1).result.protocolVersion, '2025-11-25');
  assert.deepEqual(byId(1).result.capabilities, { tools: {} });
  assert.deepEqual(byId(2).result.tools.map((t: { name: string }) => t.name), ['verificar']);
  assert.equal(byId(2).result.tools[0].inputSchema.additionalProperties, false);
  assert.match(byId(3).result.content[0].text, /`echo verde` \(test\) saiu com 0/);
  assert.equal(byId(3).result.isError, false);
  assert.equal(byId(4).error.code, -32602);
});

test('V12: init exige exatamente o MCP do Mabel, conectado', () => {
  const clean = { tools: ['Read', 'mcp__mabel__verificar'], mcp_servers: [{ name: 'mabel', status: 'connected' }], skills: [], slash_commands: [] };
  const expected = ['Read', 'mcp__mabel__verificar'];
  assert.equal(initViolation(clean, expected, ['mabel']), undefined);
  assert.equal(initViolation(clean, ['Read']), 'mcp_servers');
  assert.equal(initViolation({ ...clean, mcp_servers: [{ name: 'mabel', status: 'failed' }] }, expected, ['mabel']), 'mcp_servers (mabel: failed)');
  assert.equal(initViolation({ ...clean, mcp_servers: [] }, expected, ['mabel']), 'mcp_servers (-mabel)');
  assert.equal(
    initViolation({ ...clean, mcp_servers: [...clean.mcp_servers, { name: 'pessoal', status: 'connected' }] }, expected, ['mabel']),
    'mcp_servers (+pessoal)',
  );
  assert.equal(initViolation({ ...clean, tools: ['Read'] }, expected, ['mabel']), 'tools (-mcp__mabel__verificar)');
});

function stageContext(): StageContext & { ctx: ReturnType<typeof setupProject> } {
  const ctx = setupProject('\n## Soma\nQuero uma função soma.\n');
  syncBacklog(ctx.db, ctx.project);
  const item = getItem(ctx.db, ctx.project.id, 1)!;
  const { path } = prepareWorktree(ctx.db, ctx.home, ctx.project, item);
  ctx.project.config.verify = [{ name: 'test', command: 'echo verde fora do sandbox' }];
  return { ctx, home: ctx.home, project: ctx.project, item, worktree: path };
}

test('V2/V3: MCP só na execução, com sandbox e comando; nunca no planejamento ou na revisão', () => {
  const stage = stageContext();
  const args = (kind: 'plan' | 'execute' | 'review') => claudeArgs(stageRequest(stage, kind, 'p'), '/s.json', stageRequest(stage, kind, 'p').mabelTools ? '/m.json' : undefined);
  assert.ok(args('execute').includes('--mcp-config'));
  assert.ok(!args('plan').includes('--mcp-config'));
  assert.ok(!args('review').includes('--mcp-config'));
  assert.equal(stageRequest(stage, 'execute', 'p').mabelTools?.maxCalls, 8);

  stage.project.config.sandbox = false;
  assert.equal(stageRequest(stage, 'execute', 'p').mabelTools, undefined, 'sem sandbox, o Bash já roda fora dele');
  stage.project.config.sandbox = true;
  stage.project.config.verify = [];
  stage.project.config.testeUnico = null;
  assert.equal(stageRequest(stage, 'execute', 'p').mabelTools, undefined, 'sem comando, sem ferramenta');
});

test('V11/V12: execução chama verificar pelo MCP; a chamada fica em tool_calls e nos eventos da run', async () => {
  const stage = stageContext();
  const { log } = useScenario(stage.ctx.root, [{ structured_output: EXECUTION, mcp_calls: [{ tool: 'verificar', arguments: {} }] }]);
  const result = await runExecute(stage.ctx.db, stage, { plan: PLAN as never, attempt: 1 });
  assert.equal(result.outcome.status, 'succeeded', result.outcome.error ?? '');
  const argv = log()[0]!.argv;
  const mcpConfig = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1]!, 'utf8'));
  assert.deepEqual(Object.keys(mcpConfig.mcpServers), ['mabel']);

  const call = stage.ctx.db.prepare('SELECT name, input, ended_at, is_error FROM tool_calls WHERE run_id = ?').get(result.outcome.runId) as Record<string, unknown>;
  assert.deepEqual([call.name, call.input, call.is_error], ['mcp__mabel__verificar', '{}', 0]);
  assert.ok(call.ended_at);
  const events = stage.ctx.db
    .prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'mabel' AND subtype = 'verificar' ORDER BY seq")
    .all(result.outcome.runId) as { payload: string }[];
  const [start, done] = events.map((e) => JSON.parse(e.payload));
  assert.equal(start.inicio, true);
  assert.deepEqual([done.comando, done.codigo], ['echo verde fora do sandbox', 0]);
  assert.equal(readFileSync(done.log, 'utf8'), 'verde fora do sandbox\n');
  // O comando rodou no worktree do item, não na raiz do projeto.
  assert.equal(stage.item.worktree, stage.worktree);
});

test('V12: MCP do Mabel que não conecta interrompe a execução como contexto não hermético', async () => {
  const stage = stageContext();
  useScenario(stage.ctx.root, [{ structured_output: EXECUTION, init: { mcp_servers: [{ name: 'mabel', status: 'failed' }] } }]);
  const result = await runExecute(stage.ctx.db, stage, { plan: PLAN as never, attempt: 1 });
  assert.equal(result.outcome.status, 'failed');
  assert.equal(result.outcome.error, 'contexto não hermético: mcp_servers (mabel: failed)');
});
