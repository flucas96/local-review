import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import type { CodeAnchor, ReviewStore } from '../src/contracts.js';
import { createReviewStore, parseAgentUpdate, ReviewStoreError } from '../src/store.js';
import { maximumReplyLength, maximumReviewTextLength } from '../src/limits.js';

/** Create isolated storage and register cleanup with the test lifecycle. */
async function fixture(t: TestContext): Promise<{ store: ReviewStore; file: string; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'local-review-store-'));
  const file = path.join(root, 'storage', 'review.json');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { store: await createReviewStore(file, root), file, root };
}

/** Supply captured code context shared by storage behavior tests. */
function anchor(): CodeAnchor {
  return {
    path: 'src/example.ts', startLine: 3, endLine: 4,
    selectedText: 'return value;', contextBefore: 'function example() {', contextAfter: '}',
    documentHash: 'captured-document-hash', side: 'working', baseRevision: 'HEAD',
  };
}

test('captures immutable context and restores comments after restart', async (t) => {
  const { store, file, root } = await fixture(t);
  const context = { ...anchor() };
  const pending = store.submit(context, 'Why is this needed?', 'ask');
  context.selectedText = 'changed after submission';
  const thread = await pending;
  assert.equal(thread.status, 'queued');
  assert.equal(thread.resolved, false);
  assert.equal(store.events[0]?.anchor.selectedText, 'return value;');
  assert.ok(Object.isFrozen(thread));
  assert.ok(Object.isFrozen(thread.messages));
  assert.ok(Object.isFrozen(store.events));
  const reopened = await createReviewStore(file, root);
  assert.deepEqual(reopened.threads, store.threads);
  assert.deepEqual(reopened.events, store.events);
  assert.equal((await readdir(path.dirname(file))).filter((name) => name.endsWith('.tmp')).length, 0);
});

test('serializes concurrent submissions into a strictly increasing durable event log', async (t) => {
  const { store, file, root } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.submit(anchor(), `Comment ${index}`, 'ask')));
  await store.flush();
  assert.deepEqual(store.events.map((event) => event.sequence), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(new Set(store.events.map((event) => event.id)).size, 12);
  const reopened = await createReviewStore(file, root);
  assert.equal(reopened.threads.length, 12);
  assert.deepEqual(reopened.events, store.events);
});

test('acknowledges each event idempotently without downgrading progress', async (t) => {
  const { store } = await fixture(t);
  const thread = await store.submit(anchor(), 'Please fix this.', 'implement');
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'working' });
  let changes = 0;
  const subscription = store.onChange(() => { changes += 1; });
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'received' });
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'received' });
  assert.equal(store.events[0]?.acknowledged, true);
  assert.equal(store.threads[0]?.status, 'working');
  assert.equal(changes, 0);
  subscription.dispose();
});

test('accepts old acknowledgments and preserves old replies without changing newer work', async (t) => {
  const { store } = await fixture(t);
  const first = await store.submit(anchor(), 'Please refactor this.', 'implement');
  const second = await store.submit(anchor(), 'Also preserve the public signature.', 'implement', first.id);
  await store.updateFromAgent({ eventId: first.latestEventId, status: 'received' });
  await assert.rejects(store.updateFromAgent({ eventId: first.latestEventId, status: 'working' }),
    (error: unknown) => error instanceof ReviewStoreError && error.statusCode === 409);
  const historical = await store.updateFromAgent({
    eventId: first.latestEventId, status: 'ready', text: 'The original refactor is ready.',
  });
  assert.equal(historical.latestEventId, second.latestEventId);
  assert.equal(historical.status, 'queued');
  assert.equal(historical.messages.at(-1)?.eventId, first.latestEventId);
  assert.equal(historical.messages.at(-1)?.text, 'The original refactor is ready.');
  assert.equal(store.events[0]?.acknowledged, true);
  assert.equal(store.events[1]?.acknowledged, false);
});

test('deduplicates replies across retries and restarts', async (t) => {
  const { store, file, root } = await fixture(t);
  const thread = await store.submit(anchor(), 'Explain this.', 'ask');
  const reply = { eventId: thread.latestEventId, status: 'answered' as const, text: 'This preserves ordering.' };
  await store.updateFromAgent(reply);
  await store.updateFromAgent(reply);
  const reopened = await createReviewStore(file, root);
  await reopened.updateFromAgent(reply);
  assert.equal(reopened.threads[0]?.messages.length, 2);
  assert.equal(reopened.threads[0]?.status, 'answered');
});

test('only a human resolves a thread and follow-ups preserve its original code context', async (t) => {
  const { store } = await fixture(t);
  const thread = await store.submit(anchor(), 'Fix this.', 'implement');
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'ready', text: 'Ready to review.' });
  assert.equal(store.threads[0]?.resolved, false);
  await store.resolve(thread.id, true);
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'ready', text: 'Additional context.' });
  assert.equal(store.threads[0]?.resolved, true);
  await store.setOutdated(thread.id, true);
  assert.equal(store.threads[0]?.outdated, true);
  const newAnchor = { ...anchor(), selectedText: 'changed code;', documentHash: 'new-document-hash' };
  const reopened = await store.submit(newAnchor, 'One more point.', 'ask', thread.id);
  assert.equal(reopened.resolved, false);
  assert.equal(reopened.outdated, true);
  assert.deepEqual(reopened.anchor, thread.anchor);
  assert.deepEqual(store.events.at(-1)?.anchor, thread.anchor);
  assert.equal(reopened.status, 'queued');
});

test('human resolution withdraws queued work and prevents a late agent start', async (t) => {
  const { store } = await fixture(t);
  const thread = await store.submit(anchor(), 'Please change this.', 'implement');
  assert.equal(store.pendingEvents.length, 1);
  await store.resolve(thread.id, true);
  assert.equal(store.pendingEvents.length, 0);
  assert.equal(store.events[0]?.acknowledged, false);
  await assert.rejects(store.updateFromAgent({ eventId: thread.latestEventId, status: 'working' }),
    (error: unknown) => error instanceof ReviewStoreError && error.statusCode === 409);
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'ready', text: 'A late result.' });
  assert.equal(store.threads[0]?.resolved, true);
  assert.equal(store.threads[0]?.messages.at(-1)?.text, 'A late result.');
});

test('rejects invalid agent data and unsafe captured anchors', async (t) => {
  const { store } = await fixture(t);
  for (const update of [null, [], {}, { eventId: randomUUID(), status: 'queued' },
    { eventId: randomUUID(), status: 'ready', resolved: true },
    { eventId: randomUUID(), status: 'answered', text: '  ' }]) {
    assert.throws(() => parseAgentUpdate(update), ReviewStoreError);
  }
  for (const filePath of ['../outside.ts', '/tmp/outside.ts', 'C:\\outside.ts', 'src/../../outside.ts']) {
    assert.throws(() => store.submit({ ...anchor(), path: filePath }, 'Review this.', 'ask'), ReviewStoreError);
  }
  assert.throws(() => store.submit({ ...anchor(), startLine: 0 }, 'Review this.', 'ask'), ReviewStoreError);
  assert.throws(() => store.submit({ ...anchor(), endLine: 2 }, 'Review this.', 'ask'), ReviewStoreError);
  assert.throws(() => store.submit(anchor(), '  ', 'ask'), ReviewStoreError);
  await assert.rejects(store.updateFromAgent({ eventId: randomUUID(), status: 'received' }),
    (error: unknown) => error instanceof ReviewStoreError && error.statusCode === 404);
});

test('rejects corrupt or cross-workspace storage without overwriting it', async (t) => {
  const { store, file, root } = await fixture(t);
  await store.submit(anchor(), 'Persist me.', 'ask');
  const contents = await readFile(file, 'utf8');
  await assert.rejects(createReviewStore(file, path.join(root, 'another-workspace')), ReviewStoreError);
  assert.equal(await readFile(file, 'utf8'), contents);
  await writeFile(file, '{invalid JSON');
  await assert.rejects(createReviewStore(file, root), SyntaxError);
  assert.equal(await readFile(file, 'utf8'), '{invalid JSON');
});

test('failed persistence leaves the live snapshot untouched and later writes recover', async (t) => {
  const { store, file } = await fixture(t);
  await mkdir(file, { recursive: true });
  await assert.rejects(store.submit(anchor(), 'This write must fail.', 'ask'));
  assert.equal(store.events.length, 0);
  assert.equal(store.threads.length, 0);
  await rm(file, { recursive: true });
  const thread = await store.submit(anchor(), 'This write can succeed.', 'ask');
  assert.equal(store.events[0]?.sequence, 1);
  assert.equal(store.threads[0]?.id, thread.id);
});

test('rejects oversized new feedback and code before committing any work', async (t) => {
  const { store, file } = await fixture(t);
  const oversized = 'x'.repeat(maximumReviewTextLength + 1);
  assert.throws(() => store.submit(anchor(), oversized, 'ask'), /Kommentar ist zu groß/u);
  for (const field of ['selectedText', 'contextBefore', 'contextAfter'] as const) {
    await assert.rejects(store.submit({ ...anchor(), [field]: oversized }, 'Explain this.', 'ask'), /ist zu groß/u);
  }
  assert.throws(() => store.submit(anchor(), 'Bad\0feedback', 'ask'), /Nullzeichen/u);
  assert.equal(store.events.length, 0);
  await assert.rejects(readFile(file), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT');
  const text = 'x'.repeat(maximumReviewTextLength);
  const thread = await store.submit({ ...anchor(), selectedText: text }, text, 'ask');
  assert.equal(thread.anchor.selectedText.length, maximumReviewTextLength);
  assert.equal(store.events[0]?.text.length, maximumReviewTextLength);
});

test('uses the MCP reply limit for direct bridge updates too', async (t) => {
  const { store } = await fixture(t);
  const thread = await store.submit(anchor(), 'Explain this.', 'ask');
  assert.throws(() => store.updateFromAgent({
    eventId: thread.latestEventId, status: 'answered', text: 'x'.repeat(maximumReplyLength + 1),
  }), /Antwort ist zu groß/u);
  assert.equal(store.events[0]?.acknowledged, false);
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'answered', text: 'x'.repeat(maximumReplyLength) });
  assert.equal(store.threads[0]?.messages.at(-1)?.text.length, maximumReplyLength);
});

test('keeps oversized legacy snapshots readable and accepts follow-ups', async (t) => {
  const { store, file, root } = await fixture(t);
  const thread = await store.submit(anchor(), 'Original feedback.', 'ask');
  const legacyAnchor = { ...anchor(), selectedText: 'x'.repeat(maximumReviewTextLength + 1) };
  await writeFile(file, JSON.stringify({
    version: 1, workspaceRoot: root,
    threads: store.threads.map((candidate) => ({ ...candidate, anchor: legacyAnchor })),
    events: store.events.map((event) => ({ ...event, anchor: legacyAnchor })),
  }));
  const reopened = await createReviewStore(file, root);
  assert.equal(reopened.threads[0]?.anchor.selectedText, legacyAnchor.selectedText);
  const followup = await reopened.submit(legacyAnchor, 'And this case?', 'ask', thread.id);
  assert.equal(followup.messages.length, 2);
  assert.equal(followup.anchor.selectedText, legacyAnchor.selectedText);
});
