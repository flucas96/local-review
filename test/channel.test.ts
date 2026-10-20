import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createReviewBridge } from '../src/bridge.js';
import { record } from '../src/connection.js';
import type { CodeAnchor, ReviewBridge, ReviewStore } from '../src/contracts.js';
import { createReviewStore } from '../src/store.js';

interface ChannelFixture {
  readonly store: ReviewStore;
  readonly connect: () => Promise<void>;
  readonly waitForReview: (eventId: string, deliveryCount?: number) => Promise<string>;
  readonly restartBridge: () => Promise<void>;
  readonly deliveries: ReadonlyMap<string, readonly string[]>;
}

/** Connect the packaged MCP server to a real client without involving an LLM. */
async function fixture(t: TestContext): Promise<ChannelFixture> {
  const channelPath = path.resolve('dist', 'channel.cjs');
  await access(channelPath);
  const root = await mkdtemp(path.join(tmpdir(), 'local-review-channel-'));
  const store = await createReviewStore(path.join(root, 'review.json'), root);
  const connectionPath = path.join(root, 'connection.json');
  const bridges: ReviewBridge[] = [await createReviewBridge(store)];
  const first = bridges[0];
  assert.ok(first);
  await writeFile(connectionPath, JSON.stringify(first.descriptor), { mode: 0o600 });
  const client = new Client({ name: 'local-review-tests', version: '1.0.0' }, { capabilities: {} });
  const deliveries = new Map<string, string[]>();
  const listeners = new Set<() => void>();
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method !== 'notifications/claude/channel') return;
    const params = record(notification.params);
    const eventId = record(params?.meta)?.event_id;
    const content = params?.content;
    if (typeof eventId !== 'string' || typeof content !== 'string') return;
    const received = deliveries.get(eventId) ?? [];
    received.push(content);
    deliveries.set(eventId, received);
    for (const listener of listeners) listener();
  };
  const transport = new StdioClientTransport({
    command: process.execPath, args: [channelPath, '--connection', connectionPath], stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  t.after(async () => {
    await client.close();
    for (const bridge of bridges) bridge.dispose();
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });

  /** Wait for a specific delivery, including notifications received before registration. */
  function waitForReview(eventId: string, deliveryCount = 1): Promise<string> {
    return new Promise((resolve, reject) => {
      const finish = (): void => {
        const content = deliveries.get(eventId)?.[deliveryCount - 1];
        if (content === undefined) return;
        clearTimeout(timer);
        listeners.delete(finish);
        resolve(content);
      };
      const timer = setTimeout(() => {
        listeners.delete(finish);
        reject(new Error(`Review ${eventId} was not delivered ${deliveryCount} time(s).`));
      }, 5_000);
      listeners.add(finish);
      finish();
    });
  }

  return {
    store, deliveries, waitForReview,
    connect: () => client.connect(transport),
    restartBridge: async () => {
      for (const bridge of bridges) bridge.dispose();
      const bridge = await createReviewBridge(store);
      bridges.push(bridge);
      await writeFile(connectionPath, JSON.stringify(bridge.descriptor), { mode: 0o600 });
    },
  };
}

/** Supply the captured code context required for a durable review event. */
function anchor(): CodeAnchor {
  return {
    path: 'example.ts', startLine: 1, endLine: 1, selectedText: 'return 1;',
    contextBefore: '', contextAfter: '', documentHash: 'hash', side: 'working', baseRevision: 'HEAD',
  };
}

test('recovers acknowledged unfinished reviews when the MCP channel starts', { timeout: 15_000 }, async (t) => {
  const { store, connect, waitForReview, deliveries } = await fixture(t);
  const received = await store.submit(anchor(), 'An accepted question.', 'ask');
  await store.updateFromAgent({ eventId: received.latestEventId, status: 'received' });
  const working = await store.submit(anchor(), 'An interrupted implementation.', 'implement');
  await store.updateFromAgent({ eventId: working.latestEventId, status: 'working' });
  const answered = await store.submit(anchor(), 'An already completed question.', 'ask');
  await store.updateFromAgent({ eventId: answered.latestEventId, status: 'answered', text: 'Done.' });
  await connect();
  const [question, implementation] = await Promise.all([
    waitForReview(received.latestEventId), waitForReview(working.latestEventId),
  ]);
  assert.ok(question.includes('An accepted question.'));
  assert.ok(implementation.includes('An interrupted implementation.'));
  const next = await store.submit(anchor(), 'Feedback submitted after recovery.', 'ask');
  assert.ok((await waitForReview(next.latestEventId)).includes('Feedback submitted after recovery.'));
  assert.equal(deliveries.has(answered.latestEventId), false);
});

test('recovers unfinished work again after the extension connection changes', { timeout: 15_000 }, async (t) => {
  const { store, connect, waitForReview, restartBridge } = await fixture(t);
  const thread = await store.submit(anchor(), 'Resume this after reconnecting.', 'implement');
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'working' });
  await connect();
  await waitForReview(thread.latestEventId);
  await restartBridge();
  assert.ok((await waitForReview(thread.latestEventId, 2)).includes('Resume this after reconnecting.'));
});
