import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CaptureError,
  captureApi,
  captureFigma,
  captureScreenFile,
  describeFrame,
  openApiUrl,
  parseFigmaUrl,
  renderReferences,
} from '../src/capture.ts';
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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('parseFigmaUrl: chave do arquivo e nó; link sem node-id ou de outro site é recusado', () => {
  assert.deepEqual(
    parseFigmaUrl('https://www.figma.com/design/3nMA92NWxgkIzhW5riWgvZ/We.Go---Acessos?node-id=2696-108134&t=abc'),
    { fileKey: '3nMA92NWxgkIzhW5riWgvZ', nodeId: '2696:108134' },
  );
  assert.throws(() => parseFigmaUrl('https://www.figma.com/design/abc/x'), /não tem node-id/);
  assert.throws(() => parseFigmaUrl('https://example.com/design/abc/x?node-id=1-2'), /não é um link de arquivo do Figma/);
});

test('describeFrame: textos visíveis na ordem e cores sólidas com contagem', () => {
  const frame = {
    type: 'FRAME',
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
    children: [
      { type: 'TEXT', characters: 'Cadastrar\nacesso', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }] },
      { type: 'TEXT', characters: 'Oculto', visible: false },
      { type: 'TEXT', characters: 'CPF', fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 0.5 }] },
      { type: 'RECTANGLE', fills: [{ type: 'GRADIENT_LINEAR' }, { type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }] },
    ],
  };
  assert.deepEqual(describeFrame(frame), {
    texts: ['Cadastrar / acesso', 'CPF'],
    colors: [['#FFFFFF', 2], ['#000000', 1], ['#00000080', 1]],
  });
});

test('referencia tela: exporta o PNG e o tela.md pelo Figma; sem token, erro com a alternativa; PNG local sem rede', async () => {
  const { root } = setupProject();
  const requests: { url: string; token?: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', token: req.headers['x-figma-token'] as string | undefined });
    const port = (server.address() as AddressInfo).port;
    if (req.url?.startsWith('/v1/images/')) {
      res.end(JSON.stringify({ err: null, images: { '2696:108134': `http://127.0.0.1:${port}/render.png` } }));
    } else if (req.url?.startsWith('/v1/files/')) {
      res.end(JSON.stringify({
        name: 'We.Go Acessos',
        nodes: { '2696:108134': { document: {
          type: 'FRAME', name: 'Cadastro', absoluteBoundingBox: { width: 1440, height: 1024 },
          children: [{ type: 'TEXT', characters: 'Novo acesso' }],
        } } },
      }));
    } else if (req.url === '/render.png') {
      res.end(PNG);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = { api: process.env.MABEL_FIGMA_API, token: process.env.FIGMA_TOKEN };
  const link = 'https://www.figma.com/design/3nMA92NWxgkIzhW5riWgvZ/x?node-id=2696-108134';
  try {
    process.env.MABEL_FIGMA_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    delete process.env.FIGMA_TOKEN;
    await assert.rejects(captureFigma(root, 'cadastro', link), /FIGMA_TOKEN[\s\S]*caminho do arquivo/);

    process.env.FIGMA_TOKEN = 'token-de-teste';
    const capture = await captureFigma(root, 'cadastro', link, 2, new Date('2026-10-22T12:00:00Z'));
    assert.deepEqual(readFileSync(join(capture.dir, 'tela.png')), PNG);
    const md = readFileSync(join(capture.dir, 'tela.md'), 'utf8');
    assert.match(md, /frame "Cadastro" \(2696:108134\)/);
    assert.match(md, /Tamanho: 1440 × 1024 \(PNG em escala 2\)/);
    assert.match(md, /## Textos\n\n- Novo acesso/);
    assert.ok(!md.includes('token-de-teste'));
    assert.equal(requests[0]?.url, '/v1/images/3nMA92NWxgkIzhW5riWgvZ?ids=2696%3A108134&format=png&scale=2');
    assert.equal(requests[0]?.token, 'token-de-teste');
    assert.equal(requests.find((r) => r.url === '/render.png')?.token, undefined);
  } finally {
    server.close();
    for (const [key, value] of [['MABEL_FIGMA_API', env.api], ['FIGMA_TOKEN', env.token]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const file = join(root, 'exportado.png');
  writeFileSync(file, PNG);
  const manual = captureScreenFile(root, 'manual', file);
  assert.deepEqual(readFileSync(join(manual.dir, 'tela.png')), PNG);
  writeFileSync(file, 'não é png');
  assert.throws(() => captureScreenFile(root, 'manual', file), /não é um PNG/);
});

test('capturar tela: link do Figma ou caminho de PNG no mesmo argumento; --escala só com link; --png saiu', () => {
  const { root, cli } = setupProject();
  writeFileSync(join(root, 'exportado.png'), PNG);
  const local = cli('capturar', 'tela', 'manual', 'exportado.png');
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /Tela \.mabel\/referencias\/telas\/manual\/ gravada/);
  assert.deepEqual(readFileSync(join(root, '.mabel', 'referencias', 'telas', 'manual', 'tela.png')), PNG);
  const scaled = cli('capturar', 'tela', 'outra', 'exportado.png', '--escala', '3');
  assert.equal(scaled.status, 1);
  assert.match(scaled.stderr, /--escala vale só com o link do Figma/);
  assert.equal(cli('capturar', 'tela', 'outra', '--png', 'exportado.png').status, 1);
});
