import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvedVisibilityKey, ReviewVisibility } from '../src/reviewVisibility.js';
import { FakeMemento } from './fakes/vscode.js';

test('hides completed conversations by default and restores an explicit workspace preference', async () => {
  const storage = new FakeMemento();
  const visibility = new ReviewVisibility(storage);
  assert.equal(visibility.showResolved, false);
  assert.equal(visibility.includes({ resolved: false }), true);
  assert.equal(visibility.includes({ resolved: true }), false);

  await visibility.setShowResolved(true);
  const restored = new ReviewVisibility(storage);
  assert.equal(restored.showResolved, true);
  assert.equal(restored.includes({ resolved: true }), true);

  await restored.setShowResolved(false);
  assert.equal(new ReviewVisibility(storage).showResolved, false);
  assert.equal(restored.includes({ resolved: false }), true);
});

test('does not treat malformed workspace values as permission to restore completed threads', async () => {
  const storage = new FakeMemento();
  await storage.update(resolvedVisibilityKey, 'true');
  assert.equal(new ReviewVisibility(storage).showResolved, false);
});

test('a conversation becomes visible again when the human reopens it without changing the filter', () => {
  const visibility = new ReviewVisibility(new FakeMemento());
  const thread = { resolved: true };
  assert.equal(visibility.includes(thread), false);
  thread.resolved = false;
  assert.equal(visibility.includes(thread), true);
  assert.equal(visibility.showResolved, false);
});

test('serializes rapid show and hide changes and exposes only saved state', async () => {
  const storage = new FakeMemento();
  let release = (): void => {};
  const pause = new Promise<void>((resolve) => { release = resolve; });
  const writes: boolean[] = [];
  const originalUpdate = storage.update.bind(storage);
  storage.update = async (key: string, value: unknown): Promise<void> => {
    assert.equal(key, resolvedVisibilityKey);
    assert.ok(typeof value === 'boolean');
    writes.push(value);
    if (writes.length === 1) await pause;
    await originalUpdate(key, value);
  };
  const visibility = new ReviewVisibility(storage);
  const show = visibility.setShowResolved(true);
  const hide = visibility.setShowResolved(false);
  await Promise.resolve();
  assert.deepEqual(writes, [true]);
  assert.equal(visibility.showResolved, false);
  release();
  await Promise.all([show, hide]);
  assert.deepEqual(writes, [true, false]);
  assert.equal(visibility.showResolved, false);
  assert.equal(new ReviewVisibility(storage).showResolved, false);
});

test('retains the previous filter after a failed save and permits a later retry', async () => {
  const storage = new FakeMemento();
  const originalUpdate = storage.update.bind(storage);
  let fail = true;
  storage.update = async (key: string, value: unknown): Promise<void> => {
    if (fail) throw new Error('Workspace storage unavailable');
    await originalUpdate(key, value);
  };
  const visibility = new ReviewVisibility(storage);
  await assert.rejects(visibility.setShowResolved(true), /Workspace storage unavailable/u);
  assert.equal(visibility.showResolved, false);
  fail = false;
  await visibility.setShowResolved(true);
  assert.equal(visibility.showResolved, true);
});
