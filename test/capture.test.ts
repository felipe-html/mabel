import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { CaptureError, captureApi, openApiUrl, renderReferences } from '../src/capture.ts';
import { getItem, syncBacklog } from '../src/items.ts';
import { snapshotPath } from '../src/references.ts';
import { setupProject } from './helpers.ts';

const spec = (paths: Record<string, unknown>) => ({ openapi: '3.0.3', info: { title: 'Acessos', version: '2' }, paths });

/** Servidor local que responde o corpo da vez; `body` muda entre as chamadas. */
async function serve(state: { body: string; status?: number }): Promise<{ url: string; server: Server }> {
  const server = createServer((_, res) => {
    res.writeHead(state.status ?? 200, { 'content-type': 'application/json' });
    res.end(state.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/q/swagger-ui/`, server };
}

test('openApiUrl: swagger-ui do Quarkus vira /q/openapi?format=json; outra URL fica como está', () => {
  assert.equal(
    openApiUrl('https://api.exemplo.com/q/swagger-ui/'),
    'https://api.exemplo.com/q/openapi?format=json',
  );
  assert.equal(openApiUrl('https://api.exemplo.com/v3/api-docs'), 'https://api.exemplo.com/v3/api-docs');
});

test('referencia api: grava o snapshot, mantém as notas, relata operações novas e removidas e itens afetados', async () => {
  const { db, project, root } = setupProject(`
## Listar acessos
Lista.

Referências:
- api: acessos GET /v1/acessos
`);
  const state = { body: JSON.stringify(spec({ '/v1/acessos': { get: {}, post: {} } })) };
  const { url, server } = await serve(state);
  try {
    const first = await captureApi(db, project, 'acessos', url, new Date('2026-10-22T10:00:00Z'));
    assert.match(first.url, /\/q\/openapi\?format=json$/);
    assert.deepEqual([first.added, first.removed], [[], []]);
    const path = snapshotPath(root, 'acessos');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).info.version, '2');
    const md = path.replace(/\.openapi\.json$/, '.md');
    assert.match(readFileSync(md, 'utf8'), /Capturado em: 2026-10-22T10:00:00.000Z[\s\S]*Operações: 2/);
    syncBacklog(db, project);
    assert.equal(getItem(db, project.id, 1)?.status, 'ready');

    writeFileSync(md, `${readFileSync(md, 'utf8')}Ambiente dev, sem autenticação.\n`);
    state.body = JSON.stringify(spec({ '/v1/acessos': { post: {} }, '/v1/perfis': { get: {} } }));
    const second = await captureApi(db, project, 'acessos', url);
    assert.deepEqual(second.added, ['GET /v1/perfis']);
    assert.deepEqual(second.removed, ['GET /v1/acessos']);
    assert.deepEqual(second.broken.map(({ item, entry }) => [item.number, entry]), [[1, 'api: acessos GET /v1/acessos']]);
    assert.match(readFileSync(md, 'utf8'), /<!-- notas -->\nAmbiente dev, sem autenticação\.\n$/);

    syncBacklog(db, project);
    assert.match(String(getItem(db, project.id, 1)?.statusReason), /GET \/v1\/acessos não existe no snapshot acessos/);
    assert.match(renderReferences(db, project).join('\n'), /acessos · 2 operações · itens #1/);
  } finally {
    server.close();
  }
});

test('referencia api: recusa resposta que não é OpenAPI em JSON e status de erro, sem gravar', async () => {
  const { db, project, root } = setupProject();
  const state: { body: string; status?: number } = { body: '<html>swagger</html>' };
  const { url, server } = await serve(state);
  try {
    await assert.rejects(captureApi(db, project, 'acessos', url), (error: Error) =>
      error instanceof CaptureError && /não devolveu OpenAPI em JSON/.test(error.message));
    state.status = 404;
    await assert.rejects(captureApi(db, project, 'acessos', url), /respondeu 404/);
    await assert.rejects(captureApi(db, project, 'Acessos', url), /Nome "Acessos" inválido/);
    assert.throws(() => readFileSync(snapshotPath(root, 'acessos')));
  } finally {
    server.close();
  }
});
