import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getItem, syncBacklog } from '../src/items.ts';
import { refinePrompt } from '../src/refine.ts';
import { extractOperation, parseReference, referencesRoot } from '../src/references.ts';
import { claudeArgs } from '../src/runner.ts';
import type { PlanOutput } from '../src/schemas/stages.ts';
import { executePrompt, planPrompt, reviewPrompt, stageRequest } from '../src/stages.ts';
import { EXECUTION, PLAN, setupProject } from './helpers.ts';

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Acessos', version: '1.0' },
  paths: {
    '/v1/acessos': {
      get: { operationId: 'listarAcessos', responses: { 200: { description: 'ok' } } },
      post: {
        operationId: 'criarAcesso',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NovoAcesso' } } } },
        responses: { 201: { description: 'criado' } },
      },
    },
    '/v1/perfis/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true }],
      get: { operationId: 'buscarPerfil', responses: { 200: { description: 'ok' } } },
    },
  },
  components: {
    schemas: {
      NovoAcesso: { type: 'object', properties: { pessoa: { $ref: '#/components/schemas/Pessoa' } } },
      Pessoa: { type: 'object', properties: { cpf: { type: 'string' } } },
      Perfil: { type: 'object' },
    },
  },
};

const ITEM = (references: string) => `
## Cadastrar acesso
Operador cadastra um acesso.

Referências:
${references}
`;

function writeReference(root: string, path: string, content: string): void {
  const full = join(referencesRoot(root), path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

test('parseReference: tela, api por método e caminho, api por operationId e arquivo', () => {
  assert.deepEqual(parseReference('tela: cadastro-acesso'), { kind: 'tela', name: 'cadastro-acesso' });
  assert.deepEqual(parseReference('api: acessos post /v1/acessos'), {
    kind: 'api', name: 'acessos', method: 'POST', path: '/v1/acessos',
  });
  assert.deepEqual(parseReference('api: acessos criarAcesso'), { kind: 'api', name: 'acessos', operationId: 'criarAcesso' });
  assert.deepEqual(parseReference('docs/regras.md'), { kind: 'arquivo', path: 'docs/regras.md' });
  assert.ok('error' in parseReference('api: acessos'));
  assert.ok('error' in parseReference('api: acessos PEGAR /v1'));
  assert.ok('error' in parseReference('tela: Cadastro Acesso'));
});

test('ready: referência que não confere deixa o item no backlog; capturada, o item fica pronto', () => {
  const { db, project, root } = setupProject(
    ITEM('- tela: cadastro\n- api: acessos POST /v1/acessos\n- api: acessos buscarPerfil\n- docs/cpf.md'),
  );
  const status = () => {
    syncBacklog(db, project);
    const item = getItem(db, project.id, 1);
    return [item?.status, item?.statusReason];
  };
  assert.deepEqual(status(), ['backlog', 'referência inválida: tela: cadastro (tela cadastro sem arquivos em .mabel/referencias/telas/cadastro)']);

  writeReference(root, 'telas/cadastro/tela.png', 'png');
  assert.match(String(status()[1]), /api: acessos POST \/v1\/acessos \(snapshot .*acessos.openapi.json não existe\)/);

  writeReference(root, 'api/acessos.openapi.json', '{"openapi": "3.0.3"}');
  assert.match(String(status()[1]), /não é OpenAPI com `paths`/);

  const missing: { paths: Record<string, unknown> } = structuredClone(SPEC);
  delete missing.paths['/v1/perfis/{id}'];
  writeReference(root, 'api/acessos.openapi.json', JSON.stringify(missing));
  assert.match(String(status()[1]), /operationId buscarPerfil não existe no snapshot acessos/);

  writeReference(root, 'api/acessos.openapi.json', JSON.stringify(SPEC));
  assert.match(String(status()[1]), /docs\/cpf.md \(arquivo .mabel\/referencias\/docs\/cpf.md não existe\)/);

  writeReference(root, 'docs/cpf.md', '# CPF');
  assert.deepEqual(status(), ['ready', null]);
});

test('ready: caminho que sai de .mabel/referencias/ é recusado', () => {
  const { db, project } = setupProject(ITEM('- ../backlog.md'));
  syncBacklog(db, project);
  assert.match(String(getItem(db, project.id, 1)?.statusReason), /\.\.\/backlog\.md \(caminho fora de \.mabel\/referencias\/\)/);
});

test('hash: mudar um arquivo referenciado muda o hash do item', () => {
  const { db, project, root } = setupProject(ITEM('- tela: cadastro'));
  writeReference(root, 'telas/cadastro/tela.md', 'v1');
  syncBacklog(db, project);
  const before = getItem(db, project.id, 1)?.contentHash;
  writeReference(root, 'telas/cadastro/tela.md', 'v2');
  syncBacklog(db, project);
  assert.notEqual(getItem(db, project.id, 1)?.contentHash, before);
});

test('extractOperation: a operação, os parâmetros do caminho e os componentes alcançados', () => {
  const post = extractOperation(SPEC, { method: 'POST', path: '/v1/acessos' });
  assert.deepEqual(Object.keys(post.paths['/v1/acessos'] ?? {}), ['post']);
  assert.deepEqual(Object.keys(post.components?.schemas ?? {}).sort(), ['NovoAcesso', 'Pessoa']);
  const get = extractOperation(SPEC, { method: 'GET', path: '/v1/perfis/{id}' });
  assert.deepEqual(Object.keys(get.paths['/v1/perfis/{id}'] ?? {}).sort(), ['get', 'parameters']);
  assert.equal(get.components, undefined);
});

test('etapas: cópia congelada no primeiro uso, --add-dir e seção Referências nos prompts', () => {
  const { db, home, project, root } = setupProject(ITEM('- tela: cadastro\n- api: acessos criarAcesso'));
  writeReference(root, 'telas/cadastro/tela.png', 'png-v1');
  writeReference(root, 'api/acessos.openapi.json', JSON.stringify(SPEC));
  syncBacklog(db, project);
  const item = getItem(db, project.id, 1);
  assert.ok(item);
  const ctx = { home, project, item, worktree: root };

  const plan = planPrompt(ctx);
  const frozen = join(home, 'items', item.id, 'referencias');
  assert.match(plan, /## Referências\n/);
  assert.ok(plan.includes(`\`${join(frozen, 'telas/cadastro/tela.png')}\``));
  assert.ok(plan.includes(`\`${join(frozen, 'api/acessos--POST-v1-acessos.json')}\``));
  const operation = JSON.parse(readFileSync(join(frozen, 'api/acessos--POST-v1-acessos.json'), 'utf8'));
  assert.deepEqual(Object.keys(operation.components.schemas).sort(), ['NovoAcesso', 'Pessoa']);

  // A segunda entrada lê a cópia do início, mesmo com o arquivo da raiz mudado.
  writeReference(root, 'telas/cadastro/tela.png', 'png-v2');
  const request = stageRequest(ctx, 'execute', 'e');
  assert.deepEqual(request.addDirs, [frozen]);
  assert.equal(readFileSync(join(frozen, 'telas/cadastro/tela.png'), 'utf8'), 'png-v1');
  const args = claudeArgs(request);
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', frozen]);

  assert.match(executePrompt(ctx, { plan: PLAN as PlanOutput, attempt: 1 }), /## Referências\n/);
  assert.match(reviewPrompt(ctx, { plan: PLAN as PlanOutput, execution: EXECUTION }), /## Referências\n/);
});

test('refinamento: sem cópia nem --add-dir; o prompt lista os arquivos da raiz', () => {
  const { db, home, project, root } = setupProject(ITEM('- tela: cadastro'));
  writeReference(root, 'telas/cadastro/tela.png', 'png');
  syncBacklog(db, project);
  const item = getItem(db, project.id, 1);
  assert.ok(item);
  const request = stageRequest({ home, project, item, worktree: root }, 'refine', 'r');
  assert.equal(request.addDirs, undefined);
  assert.equal(existsSync(join(home, 'items', item.id, 'referencias')), false);
  assert.match(refinePrompt(item, root), /- tela: cadastro\n {2}- `\.mabel\/referencias\/telas\/cadastro\/tela\.png`/);
});
