#!/usr/bin/env node
// `gh` falso para os testes da entrega. As respostas vêm de `FAKE_GH_SCENARIO` (JSON com
// chaves "<comando> <subcomando>", como "pr create", e valores `{ stdout, code }`); sem
// resposta, sai com 0 e nada no stdout. Cada chamada vai para `FAKE_GH_LOG`, com o corpo
// do PR quando há `--body-file`.
import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const scenario = process.env.FAKE_GH_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_GH_SCENARIO, 'utf8')) : {};
const response = scenario[argv.slice(0, 2).join(' ')] ?? {};
const bodyAt = argv.indexOf('--body-file');
const body = bodyAt >= 0 ? readFileSync(argv[bodyAt + 1], 'utf8') : undefined;
if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, `${JSON.stringify({ argv, body })}\n`);
if (response.stdout) process.stdout.write(response.stdout);
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.code ?? 0);
