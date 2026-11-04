#!/usr/bin/env node
// `curl` falso para os testes da entrega no Bitbucket. As respostas vêm de
// `FAKE_CURL_SCENARIO` (JSON com chaves "<MÉTODO> <caminho>", como
// "POST /repositories/ws/app/pullrequests", e valores `{ status, body }`); sem resposta,
// 404. Cada chamada vai para `FAKE_CURL_LOG` com o método, o caminho, a configuração lida
// do stdin (onde fica a credencial), os argumentos e o corpo enviado.
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const config = readFileSync(0, 'utf8');
const method = argv[argv.indexOf('-X') + 1];
const url = argv[argv.length - 1];
const path = url.replace(/^https:\/\/api\.bitbucket\.org\/2\.0/, '');
const dataAt = argv.indexOf('--data-binary');
const body = dataAt >= 0 ? JSON.parse(readFileSync(argv[dataAt + 1].slice(1), 'utf8')) : undefined;
const scenario = process.env.FAKE_CURL_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_CURL_SCENARIO, 'utf8')) : {};
const response = scenario[`${method} ${path}`] ?? { status: 404, body: { type: 'error', error: { message: 'Not found' } } };
if (process.env.FAKE_CURL_LOG) appendFileSync(process.env.FAKE_CURL_LOG, `${JSON.stringify({ method, path, config, argv, body })}\n`);
process.stdout.write(`${response.body === undefined ? '' : JSON.stringify(response.body)}\n${response.status ?? 200}`);
process.exit(0);
