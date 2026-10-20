import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createReviewBridge } from '../src/bridge.js';
import type { CodeAnchor, ReviewBridge, ReviewStore } from '../src/contracts.js';
import { createReviewStore } from '../src/store.js';
import { parseThread, readBatch, record } from '../src/connection.js';
import { maximumConversationMessages, maximumReviewTextLength } from '../src/limits.js';

/** Start a real loopback bridge over isolated durable storage for each test. */
async function fixture(t: TestContext): Promise<{ store: ReviewStore; bridge: ReviewBridge; headers: Record<string, string> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'local-review-bridge-'));
  const store = await createReviewStore(path.join(root, 'review.json'), root);
  const bridge = await createReviewBridge(store);
  t.after(async () => {
    bridge.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return {
    store, bridge,
    headers: { Authorization: `Bearer ${bridge.descriptor.token}`, 'Content-Type': 'application/json' },
  };
}

/** Supply a minimal valid code anchor for HTTP transport tests. */
function anchor(): CodeAnchor {
  return {
    path: 'example.ts', startLine: 1, endLine: 1, selectedText: 'return 1;',
    contextBefore: '', contextAfter: '', documentHash: 'hash', side: 'working', baseRevision: 'HEAD',
  };
}

/** Wait until an authenticated request reaches the bridge. */
function waitForConnection(bridge: ReviewBridge): Promise<void> {
  return new Promise((resolve) => {
    const subscription = bridge.onChange(() => {
      if (bridge.state.connected) {
        subscription.dispose();
        resolve();
      }
    });
  });
}

test('requires authentication and publishes a random-port loopback descriptor', async (t) => {
  const { bridge, store, headers } = await fixture(t);
  assert.match(bridge.descriptor.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(bridge.descriptor.token.length, 64);
  const unauthorized = await fetch(`${bridge.descriptor.url}/health`);
  assert.equal(unauthorized.status, 401);
  assert.equal(bridge.state.connected, false);
  const wrongToken = await fetch(`${bridge.descriptor.url}/health`, {
    headers: { Authorization: 'Bearer incorrect' },
  });
  assert.equal(wrongToken.status, 401);
  const health = await fetch(`${bridge.descriptor.url}/health`, { headers });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { workspaceRoot: store.workspaceRoot });
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(bridge.state.connected, true);
  assert.equal(typeof bridge.state.lastSeenAt, 'number');
});

test('keeps acknowledged unfinished work recoverable until answered or resolved', async (t) => {
  const { bridge, store, headers } = await fixture(t);
  const thread = await store.submit(anchor(), 'Why this return value?', 'ask');
  const events = await fetch(`${bridge.descriptor.url}/events?after=0`, { headers });
  assert.equal(events.status, 200);
  assert.deepEqual(await events.json(), {
    events: store.events, threads: store.threads, workspaceRoot: store.workspaceRoot,
  });
  const acknowledged = await fetch(`${bridge.descriptor.url}/update`, {
    method: 'POST', headers,
    body: JSON.stringify({ eventId: thread.latestEventId, status: 'received' }),
  });
  assert.equal(acknowledged.status, 200);
  assert.deepEqual(await acknowledged.json(), { thread: store.threads[0] });
  const pending = await fetch(`${bridge.descriptor.url}/pending`, { headers });
  assert.deepEqual(await pending.json(), {
    events: store.events, threads: store.threads, workspaceRoot: store.workspaceRoot,
  });
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'working' });
  const working = await fetch(`${bridge.descriptor.url}/pending`, { headers });
  assert.deepEqual(await working.json(), {
    events: store.events, threads: store.threads, workspaceRoot: store.workspaceRoot,
  });
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'answered', text: 'This preserves ordering.' });
  const answered = await fetch(`${bridge.descriptor.url}/pending`, { headers });
  assert.deepEqual(await answered.json(), {
    events: [], threads: [], workspaceRoot: store.workspaceRoot,
  });
  await store.resolve(thread.id, true);
  const resolved = await fetch(`${bridge.descriptor.url}/pending`, { headers });
  assert.deepEqual(await resolved.json(), { events: [], threads: [], workspaceRoot: store.workspaceRoot });
});

test('wakes an existing long poll when a new comment is committed', async (t) => {
  const { bridge, store, headers } = await fixture(t);
  const connected = waitForConnection(bridge);
  const waiting = fetch(`${bridge.descriptor.url}/events?after=0`, {
    headers, signal: AbortSignal.timeout(3_000),
  });
  await connected;
  await store.submit(anchor(), 'Please explain this.', 'ask');
  const response = await waiting;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    events: store.events, threads: store.threads, workspaceRoot: store.workspaceRoot,
  });
});

test('applies agent answers to their event and prevents agent-side resolution', async (t) => {
  const { bridge, store, headers } = await fixture(t);
  const first = await store.submit(anchor(), 'Explain this.', 'ask');
  await store.submit(anchor(), 'And its tradeoff?', 'ask', first.id);
  const staleProgress = await fetch(`${bridge.descriptor.url}/update`, {
    method: 'POST', headers,
    body: JSON.stringify({ eventId: first.latestEventId, status: 'working' }),
  });
  assert.equal(staleProgress.status, 409);
  const historical = await fetch(`${bridge.descriptor.url}/update`, {
    method: 'POST', headers,
    body: JSON.stringify({ eventId: first.latestEventId, status: 'answered', text: 'Original answer.' }),
  });
  assert.equal(historical.status, 200);
  assert.equal(store.threads[0]?.status, 'queued');
  assert.equal(store.threads[0]?.messages.at(-1)?.text, 'Original answer.');
  const agentResolve = await fetch(`${bridge.descriptor.url}/update`, {
    method: 'POST', headers,
    body: JSON.stringify({ eventId: first.latestEventId, status: 'ready', resolved: true }),
  });
  assert.equal(agentResolve.status, 400);
  assert.equal(store.threads[0]?.resolved, false);
});

test('rejects invalid cursors, JSON, content types, and browser origins', async (t) => {
  const { bridge, headers } = await fixture(t);
  for (const cursor of ['', '-1', '1.2', 'NaN', '9007199254740992', '0&after=1']) {
    const response = await fetch(`${bridge.descriptor.url}/events?after=${cursor}`, { headers });
    assert.equal(response.status, 400);
  }
  const invalidJson = await fetch(`${bridge.descriptor.url}/update`, {
    method: 'POST', headers, body: '{invalid',
  });
  assert.equal(invalidJson.status, 400);
  const invalidType = await fetch(`${bridge.descriptor.url}/update`, {
    method: 'POST', headers: { Authorization: headers['Authorization'] ?? '' }, body: '{}',
  });
  assert.equal(invalidType.status, 415);
  const browser = await fetch(`${bridge.descriptor.url}/pending`, {
    headers: { ...headers, Origin: 'https://example.com' },
  });
  assert.equal(browser.status, 403);
  assert.equal(browser.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${bridge.descriptor.url}/pending`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 401);
});

test('bounds both declared-length and chunked request bodies', async (t) => {
  const { bridge, headers } = await fixture(t);
  const oversized = await fetch(`${bridge.descriptor.url}/update`, {
    method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(256 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${bridge.descriptor.url}/update`, {
      method: 'POST', headers,
    }, (response) => {
      response.resume();
      response.once('end', () => { resolve(response.statusCode ?? 0); });
    });
    request.once('error', reject);
    request.write('x'.repeat(200 * 1024));
    request.end('y'.repeat(100 * 1024));
  });
  assert.equal(status, 413);
});

test('disposal ends outstanding polls and closes the loopback listener', async (t) => {
  const { bridge, headers } = await fixture(t);
  const connected = waitForConnection(bridge);
  const waiting = fetch(`${bridge.descriptor.url}/events?after=0`, {
    headers, signal: AbortSignal.timeout(3_000),
  });
  await connected;
  bridge.dispose();
  await assert.rejects(fetch(`${bridge.descriptor.url}/health`, {
    headers, signal: AbortSignal.timeout(1_000),
  }));
  const response = await waiting.catch(() => undefined);
  if (response !== undefined) {
    assert.equal(response.status, 503);
  }
  assert.equal(bridge.state.connected, false);
  bridge.dispose();
});

test('sends only discussions for the returned events and preserves message event identity', async (t) => {
  const { bridge, store, headers } = await fixture(t);
  const answered = await store.submit(anchor(), 'An already answered question.', 'ask');
  await store.updateFromAgent({ eventId: answered.latestEventId, status: 'answered', text: 'An earlier answer.' });
  const current = await store.submit(anchor(), 'The new question.', 'ask');
  const response = await fetch(`${bridge.descriptor.url}/pending`, { headers });
  const payload: unknown = await response.json();
  const batch = readBatch(payload, store.workspaceRoot);
  assert.deepEqual(batch.events.map((event) => event.id), [current.latestEventId]);
  assert.deepEqual(batch.threads.map((thread) => thread.id), [current.id]);
  assert.equal(batch.threads[0]?.messages[0]?.eventId, current.latestEventId);
});

test('projects legacy oversized text without changing its stored original or blocking replies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-review-legacy-'));
  const file = path.join(root, 'review.json');
  const original = await createReviewStore(file, root);
  const submitted = await original.submit(anchor(), 'Legacy feedback.', 'ask');
  const oversized = 'x'.repeat(maximumReviewTextLength + 1);
  const legacyAnchor = { ...anchor(), selectedText: oversized };
  await writeFile(file, JSON.stringify({
    version: 1, workspaceRoot: root,
    threads: original.threads.map((thread) => ({
      ...thread, anchor: legacyAnchor, messages: thread.messages.map((message) => ({ ...message, text: oversized })),
    })),
    events: original.events.map((event) => ({ ...event, anchor: legacyAnchor, text: oversized })),
  }));
  const store = await createReviewStore(file, root);
  const bridge = await createReviewBridge(store);
  t.after(async () => { bridge.dispose(); await rm(root, { recursive: true, force: true }); });
  const headers = { Authorization: `Bearer ${bridge.descriptor.token}`, 'Content-Type': 'application/json' };
  const pending = await fetch(`${bridge.descriptor.url}/pending`, { headers });
  const payload: unknown = await pending.json();
  const batch = readBatch(payload, root);
  assert.equal(batch.events[0]?.anchor.selectedText.length, maximumReviewTextLength);
  assert.match(batch.events[0]?.anchor.selectedText ?? '', /Local Review: text truncated/u);
  assert.match(batch.events[0]?.text ?? '', /Local Review: text truncated/u);
  const reply = await fetch(`${bridge.descriptor.url}/update`, {
    method: 'POST', headers,
    body: JSON.stringify({ eventId: submitted.latestEventId, status: 'answered', text: 'The result.' }),
  });
  assert.equal(reply.status, 200);
  const response: unknown = await reply.json();
  const thread = parseThread(record(response)?.thread);
  assert.equal(thread.messages.at(-1)?.eventId, submitted.latestEventId);
  assert.equal(store.threads[0]?.anchor.selectedText, oversized);
  assert.equal(store.events[0]?.text, oversized);
});

test('marks older omitted discussion while keeping the latest request and original history', async (t) => {
  const { bridge, store, headers } = await fixture(t);
  let thread = await store.submit(anchor(), 'First question.', 'ask');
  for (let index = 0; index < maximumConversationMessages; index += 1) {
    await store.updateFromAgent({ eventId: thread.latestEventId, status: 'answered', text: `Answer ${index}.` });
    thread = await store.submit(anchor(), `Follow-up ${index}.`, 'ask', thread.id);
  }
  const response = await fetch(`${bridge.descriptor.url}/pending`, { headers });
  const payload: unknown = await response.json();
  const batch = readBatch(payload, store.workspaceRoot);
  assert.equal(batch.threads[0]?.messages.length, maximumConversationMessages);
  assert.match(batch.threads[0]?.messages[0]?.text ?? '', /earlier conversation omitted/u);
  assert.equal(batch.events[0]?.text, `Follow-up ${maximumConversationMessages - 1}.`);
  assert.equal(store.threads[0]?.messages.length, maximumConversationMessages * 2 + 1);
});
