import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { getHeadRevision, listChangedFiles, readGitBase } from '../src/git.js';

const executeFile = promisify(execFile);

/** Run a fixture Git command directly without shell expansion. */
async function git(root: string, args: readonly string[]): Promise<void> {
  await executeFile('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
}

test('keeps both sides of a staged rename available with the correct original contents', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-review-git-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '--quiet']);
  const original = 'export const cachedValue = 42;\n';
  await writeFile(path.join(root, 'before.ts'), original);
  await git(root, ['add', '--', 'before.ts']);
  await git(root, [
    '-c', 'user.name=Local Review Test', '-c', 'user.email=local-review@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`,
    'commit', '--quiet', '-m', 'create fixture',
  ]);
  const revision = await getHeadRevision(root);
  assert.ok(revision !== undefined);
  await git(root, ['mv', '--', 'before.ts', 'after.ts']);

  assert.deepEqual(await listChangedFiles(root), ['after.ts', 'before.ts']);
  assert.equal(await readGitBase(root, 'before.ts', revision), original);
  assert.equal(await readGitBase(root, 'after.ts', revision), '');
});
