import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

