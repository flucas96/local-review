import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { ReviewEvent } from '../src/contracts.js';
import { createHookDeliveryLedger } from '../src/hookDelivery.js';

/** Provide isolated session metadata without a network server or review-store mutations. */
async function fixture(t: TestContext): Promise<{ root: string; connectionPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'local-review-delivery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, connectionPath: join(root, 'connection.json') };
}

/** Capture a minimal immutable event whose identifier must remain transport-only metadata. */
function event(id: string, sequence = 1, acknowledged = false): ReviewEvent {
  return {
    id, sequence, threadId: `thread-${id}`, text: `Feedback ${id}`, intent: 'ask', acknowledged,
    createdAt: '2026-10-21T08:00:00.000Z',
    anchor: {
      path: 'example.ts', startLine: 1, endLine: 1, selectedText: 'return 1;',
      contextBefore: '', contextAfter: '', documentHash: 'hash', side: 'working', baseRevision: 'HEAD',
    },
  };
}

test('remembers emitted IDs across same-session rearming while preserving new and restored event IDs', async (t) => {
  const { root, connectionPath } = await fixture(t);
  const first = event('first', 8);
  const initial = await createHookDeliveryLedger(connectionPath, root, 'session');
  assert.deepEqual(initial.select([first], false), [first]);
  await initial.record([first]);

  const next = await createHookDeliveryLedger(connectionPath, root, 'session');
  const restored = event('restored', 2);
  const fresh = event('fresh', 9);
  assert.deepEqual(next.select([first, restored, fresh], false), [restored, fresh]);
  assert.deepEqual(first, event('first', 8));
  assert.equal(first.acknowledged, false);
});

test('recovers unfinished events explicitly on SessionStart even in the same resumed session', async (t) => {
  const { root, connectionPath } = await fixture(t);
  const first = event('first');
  const initial = await createHookDeliveryLedger(connectionPath, root, 'session');
  initial.select([first], false);
  await initial.record([first]);

  const resumed = await createHookDeliveryLedger(connectionPath, root, 'session');
  const acknowledged = event('first', 1, true);
  assert.deepEqual(resumed.select([acknowledged], false), []);
  assert.deepEqual(resumed.select([acknowledged], true), [acknowledged]);
  const another = await createHookDeliveryLedger(connectionPath, root, 'new-session');
  assert.deepEqual(another.select([first], false), [first]);
});

test('keeps receipt paths hashed and private and prunes absent IDs from complete pending snapshots', async (t) => {
  const { root, connectionPath } = await fixture(t);
  const first = event('first');
  const ledger = await createHookDeliveryLedger(connectionPath, root, '../../session/private');
  ledger.select([first], false);
  await ledger.record([first]);
  const names = await readdir(root);
  assert.equal(names.length, 1);
  const name = names[0];
  assert.ok(name);
  assert.match(name, /^delivery-[a-f\d]{20}-[a-f\d]{32}\.json$/u);
  assert.equal((await stat(join(root, name))).mode & 0o777, 0o600);
  ledger.select([], false);
  await ledger.record([]);
  const stored: unknown = JSON.parse(await readFile(join(root, name), 'utf8'));
  assert.deepEqual(stored, { version: 1, workspaceRoot: root, sessionId: '../../session/private', eventIds: [] });
  const reopened = await createHookDeliveryLedger(connectionPath, root, '../../session/private');
  assert.deepEqual(reopened.select([first], false), [first]);
});

test('fails open for corrupt or unrelated emission metadata without acknowledging pending work', async (t) => {
  const { root, connectionPath } = await fixture(t);
  const first = event('first');
  const initial = await createHookDeliveryLedger(connectionPath, root, 'session');
  initial.select([first], false);
  await initial.record([first]);
  const name = (await readdir(root))[0];
  assert.ok(name);
  const path = join(root, name);
  for (const raw of ['{broken', JSON.stringify({ version: 1, workspaceRoot: '/another-workspace', sessionId: 'session', eventIds: ['first'] }),
    JSON.stringify({ version: 1, workspaceRoot: root, sessionId: 'session', eventIds: ['first', 'first'] })]) {
    await writeFile(path, raw);
    const recovered = await createHookDeliveryLedger(connectionPath, root, 'session');
    assert.deepEqual(recovered.select([first], false), [first]);
    assert.equal(first.acknowledged, false);
  }
});

test('does not record work before emission and refuses IDs outside a complete pending snapshot', async (t) => {
  const { root, connectionPath } = await fixture(t);
  const first = event('first');
  const initial = await createHookDeliveryLedger(connectionPath, root, 'session');
  assert.deepEqual(initial.select([first], false), [first]);
  const rearmedAfterCrash = await createHookDeliveryLedger(connectionPath, root, 'session');
  assert.deepEqual(rearmedAfterCrash.select([first], false), [first]);
  await assert.rejects(() => rearmedAfterCrash.record([event('unknown')]), /outside the current pending/u);
  assert.deepEqual(await readdir(root), []);
});
