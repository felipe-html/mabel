import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  daysUntil,
  expired,
  expiryWarning,
  expiryWarnings,
  isDate,
  renderCredentials,
  setExpiry,
} from '../src/credentials.ts';
import { setupProject } from './helpers.ts';

const at = (text: string) => new Date(`${text}T10:00:00`);

test('isDate e daysUntil: datas do calendário e dias até o vencimento no fuso local', () => {
  assert.ok(isDate('2027-01-20'));
  assert.ok(!isDate('2027-02-30'));
  assert.ok(!isDate('20/01/2027'));
  assert.equal(daysUntil('2027-01-20', at('2026-10-22')), 90);
  assert.equal(daysUntil('2027-01-20', at('2027-01-20')), 0);
  assert.equal(daysUntil('2027-01-20', at('2027-01-21')), -1);
});

test('validade: sem aviso longe do fim; aviso a 14 dias, no dia e depois de vencer', () => {
  const home = mkdtempSync(join(tmpdir(), 'mabel-cred-'));
  assert.equal(expiryWarning(home, 'figma', at('2026-10-22')), null);
  setExpiry(home, 'figma', '2027-01-20', at('2026-10-22'));
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'credenciais.json'), 'utf8')).figma.expira, '2027-01-20');
  assert.equal(expiryWarning(home, 'figma', at('2027-01-05')), null);
  assert.match(String(expiryWarning(home, 'figma', at('2027-01-06'))), /FIGMA_TOKEN vence em 14 dias \(20\/01\/2027\)/);
  assert.match(String(expiryWarning(home, 'figma', at('2027-01-19'))), /vence amanhã/);
  assert.match(String(expiryWarning(home, 'figma', at('2027-01-20'))), /vence hoje/);
  assert.match(String(expiryWarning(home, 'figma', at('2027-01-21'))), /venceu em 20\/01\/2027: crie outro .*mabel credenciar figma --expira/);
  assert.equal(expired(home, 'figma', at('2027-01-20')), false);
  assert.equal(expired(home, 'figma', at('2027-01-21')), true);
  assert.equal(expiryWarnings(home, at('2027-01-21')).length, 1);
  assert.match(renderCredentials(home, { FIGMA_TOKEN: 'x' }, at('2026-10-22'))[0] ?? '', /figma · FIGMA_TOKEN definido · vence em 20\/01\/2027 \(90 dias\)/);
  assert.match(renderCredentials(mkdtempSync(join(tmpdir(), 'mabel-cred-')), {}, at('2026-10-22'))[0] ?? '', /ausente · validade não registrada/);
});

test('credencial pelo CLI: registra, recusa data inválida e o status avisa perto do fim', () => {
  const { cli, env } = setupProject();
  assert.equal(cli('credenciar', 'figma', '--expira', '2027-02-30').status, 1);
  assert.equal(cli('credenciar', 'github', '--expira', '2027-01-20').status, 1);
  const soon = new Date(Date.now() + 3 * 86_400_000);
  const date = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
  const result = cli('credenciar', 'figma', '--expira', date);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Validade de figma registrada: .* \(3 dias\)\.\nFIGMA_TOKEN vence em 3 dias/);
  assert.match(cli('credenciar').stdout, /figma · FIGMA_TOKEN (definido|ausente) · vence em/);
  assert.match(cli('conferir').stdout, /FIGMA_TOKEN vence em 3 dias/);
  assert.ok(env().MABEL_HOME);
});
