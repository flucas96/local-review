import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { createReviewBridge } from '../src/bridge.js';
import { record } from '../src/connection.js';
import type { CodeAnchor, ReviewBridge, ReviewStore } from '../src/contracts.js';
import { createReviewStore } from '../src/store.js';

interface ChannelFixture {
  readonly store: ReviewStore;
  readonly bridge: ReviewBridge;
  readonly connect: () => Promise<void>;
  readonly waitForReview: (eventId: string, deliveryCount?: number) => Promise<string>;
  readonly restartBridge: () => Promise<void>;
  readonly deliveries: ReadonlyMap<string, readonly string[]>;
  readonly reply: (eventId: string, text: string) => Promise<void>;
  readonly listTools: () => Promise<ListToolsResult>;
  readonly listPending: () => Promise<void>;
}

/** Connect the packaged MCP server to a real client without involving an LLM. */
async function fixture(t: TestContext, noPush = false): Promise<ChannelFixture> {
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
    command: process.execPath, args: [channelPath, '--connection', connectionPath, ...(noPush ? ['--no-push'] : [])], stderr: 'pipe',
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
    get bridge() { return bridges.at(-1) ?? first; },
    listTools: () => client.listTools(),
    listPending: async () => {
      const result = await client.callTool({ name: 'list_pending_reviews', arguments: {} });
      assert.notEqual(result.isError, true);
    },
    connect: () => client.connect(transport),
    reply: async (eventId, text) => {
      const response = await client.callTool({ name: 'reply_to_review', arguments: { event_id: eventId, text, status: 'answered' } });
      assert.notEqual(response.isError, true);
    },
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
  const { store, bridge, connect, waitForReview, deliveries } = await fixture(t);
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
  assert.equal(bridge.state.deliveryReady, true);
});

test('the hook-mode MCP process exposes tools without claiming an active feedback receiver', { timeout: 15_000 }, async (t) => {
  const { store, bridge, connect, deliveries, listPending } = await fixture(t, true);
  const thread = await store.submit(anchor(), 'This still needs an active hook.', 'ask');
  await connect();
  await listPending();

  assert.equal(bridge.state.connected, true);
  assert.equal(bridge.state.deliveryReady, false);
  assert.equal(deliveries.size, 0);
  assert.equal(store.events[0]?.acknowledged, false);
  assert.equal(store.threads.find((candidate) => candidate.id === thread.id)?.status, 'queued');
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

test('preserves fenced reply code, indentation, and actual newlines through the MCP bridge', { timeout: 15_000 }, async (t) => {
  const { store, connect, waitForReview, reply, listTools } = await fixture(t);
  await connect();
  const tools = await listTools();
  const replyTool = tools.tools.find((tool) => tool.name === 'reply_to_review');
  const replyText = record(record(replyTool?.inputSchema.properties)?.text);
  const instructions = replyText?.description;
  assert.ok(typeof instructions === 'string');
  assert.match(instructions, /import statements, doc comments, incomplete function headers/u);
  assert.match(instructions, /functions that happen to fit on one line/u);
  assert.match(instructions, /each logical code line.*separate lines/u);
  assert.match(instructions, /indentation and actual newlines/u);
  const thread = await store.submit(anchor(), 'How would you calculate the retry delay?', 'ask');
  const event = await waitForReview(thread.latestEventId);
  assert.match(event, /Fence all code, including imports and one-line functions, with a language tag/u);
  assert.match(event, /Preserve indentation and real newlines/u);
  assert.doesNotMatch(event, /functions that happen to fit on one line/u);
  const markdown = [
    'The delay doubles after each attempt:',
    '',
    '```javascript',
    'if (attempt > 0) {',
    '  const delayMs = 1000 * 2 ** attempt;',
    '  await delay(delayMs);',
    '}',
    '```',
    '',
    'Keep `attempt` bounded by the retry limit.',
  ].join('\n');

  await reply(thread.latestEventId, markdown);

  assert.equal(store.threads.find((candidate) => candidate.id === thread.id)?.messages.at(-1)?.text, markdown);
  assert.equal(store.threads.find((candidate) => candidate.id === thread.id)?.status, 'answered');
});
