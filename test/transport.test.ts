import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createReviewBridge } from '../src/bridge.js';
import { readBatch } from '../src/connection.js';
import type { ReviewBatch } from '../src/connection.js';
import type { CodeAnchor, ReviewBridge, ReviewStore } from '../src/contracts.js';
import { createReviewStore } from '../src/store.js';

interface HookResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface HookProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly completed: Promise<HookResult>;
}

type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';

interface TransportFixture {
  readonly store: ReviewStore;
  readonly bridge: ReviewBridge;
  readonly startHook: (sessionId: string, event?: HookEvent) => HookProcess;
}

/** Exercise the packaged hook against a real local bridge and isolated durable storage. */
async function fixture(t: TestContext): Promise<TransportFixture> {
  const hookPath = path.resolve('dist', 'hook-waiter.cjs');
  await access(hookPath);
  const root = await mkdtemp(path.join(tmpdir(), 'local-review-transport-'));
  const store = await createReviewStore(path.join(root, 'review.json'), root);
  const bridge = await createReviewBridge(store);
  const connectionPath = path.join(root, 'connection.json');
  const hooks: HookProcess[] = [];
  await writeFile(connectionPath, JSON.stringify(bridge.descriptor), { mode: 0o600 });
  t.after(async () => {
    const running = hooks.filter((hook) => hook.process.exitCode === null && hook.process.signalCode === null);
    for (const hook of running) {
      hook.process.kill('SIGTERM');
    }
    const forceStop = setTimeout(() => {
      for (const hook of running) {
        if (hook.process.exitCode === null && hook.process.signalCode === null) {
          hook.process.kill('SIGKILL');
        }
      }
    }, 1_000);
    forceStop.unref();
    await Promise.allSettled(hooks.map((hook) => hook.completed));
    clearTimeout(forceStop);
    bridge.dispose();
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });

  /** Supply the same stdin session envelope as a Claude command hook. */
  function startHook(sessionId: string, event: HookEvent = 'Stop'): HookProcess {
    const child = spawn(process.execPath, [hookPath, '--connection', connectionPath], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') stdout += chunk;
    });
    child.stderr.on('data', (chunk: unknown) => {
      if (typeof chunk === 'string') stderr += chunk;
    });
    const completed = new Promise<HookResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { resolve({ code, signal, stdout, stderr }); });
    });
    child.stdin.end(JSON.stringify({
      session_id: sessionId,
      cwd: root,
      hook_event_name: event,
    }));
    const hook = { process: child, completed };
    hooks.push(hook);
    return hook;
  }
  return { store, bridge, startHook };
}

/** Capture the source excerpt that must arrive unchanged in hook feedback. */
function anchor(): CodeAnchor {
  return {
    path: 'src/example.ts',
    startLine: 2,
    endLine: 2,
    selectedText: 'return cachedValue;',
    contextBefore: 'function example() {\n',
    contextAfter: '\n}',
    documentHash: 'captured-source-hash',
    side: 'working',
    baseRevision: 'unborn',
  };
}

/** Read recoverable work through the same authenticated endpoint used by Claude. */
async function pendingReviews(store: ReviewStore, bridge: ReviewBridge): Promise<ReviewBatch> {
  const response = await fetch(`${bridge.descriptor.url}/pending`, {
    headers: { Authorization: `Bearer ${bridge.descriptor.token}` },
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  const payload: unknown = await response.json();
  return readBatch(payload, store.workspaceRoot);
}

/** Wait for the hook's first authenticated poll instead of relying on timing guesses. */
function waitForConnection(bridge: ReviewBridge): Promise<void> {
  if (bridge.state.connected) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error('The hook did not connect to the local review bridge.'));
    }, 5_000);
    const subscription = bridge.onChange(() => {
      if (bridge.state.connected) {
        clearTimeout(timeout);
        subscription.dispose();
        resolve();
      }
    });
  });
}

test('delivers queued feedback through hook exit 2 without acknowledging it before Claude does', { timeout: 15_000 }, async (t) => {
  const { store, bridge, startHook } = await fixture(t);
  const connected = waitForConnection(bridge);
  const hook = startHook('review-session');
  await connected;
  const feedback = 'Warum wird hier der gespeicherte Wert verwendet?';
  const thread = await store.submit(anchor(), feedback, 'ask');
  const result = await hook.completed;

  assert.equal(result.code, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr.includes(thread.latestEventId));
  assert.ok(result.stderr.includes(feedback));
  assert.ok(result.stderr.includes('src/example.ts'));
  assert.ok(result.stderr.includes('return cachedValue;'));
  assert.equal(store.events[0]?.acknowledged, false);
  assert.equal(store.threads[0]?.status, 'queued');

  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'received' });
  assert.equal(store.events[0]?.acknowledged, true);
  assert.equal(store.threads[0]?.status, 'received');
  const received = await pendingReviews(store, bridge);
  assert.deepEqual(received.events, store.events);
  assert.equal(received.events[0]?.acknowledged, true);

  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'answered', text: 'Der Wert wurde bereits berechnet.' });
  const answered = await pendingReviews(store, bridge);
  assert.deepEqual(answered.events, []);
  assert.equal(answered.threads[0]?.messages.at(-1)?.text, 'Der Wert wurde bereits berechnet.');
});

test('recovers acknowledged but unfinished feedback when a Claude session starts', { timeout: 15_000 }, async (t) => {
  const { store, startHook } = await fixture(t);
  const thread = await store.submit(anchor(), 'Bitte behebe diesen Fehler.', 'implement');
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'working' });

  const recovered = await startHook('resumed-session', 'SessionStart').completed;

  assert.equal(recovered.code, 2);
  assert.equal(recovered.signal, null);
  assert.ok(recovered.stderr.includes(thread.latestEventId));
  assert.ok(recovered.stderr.includes('Bitte behebe diesen Fehler.'));
  assert.equal(store.events[0]?.acknowledged, true);
  assert.equal(store.threads[0]?.status, 'working');
});

test('delivers a second comment after a tool finishes without waiting for the current turn to stop', { timeout: 15_000 }, async (t) => {
  const { store, startHook } = await fixture(t);
  const first = await store.submit(anchor(), 'Bitte prüfe die Berechnung.', 'implement');
  const initial = await startHook('active-session', 'SessionStart').completed;
  assert.equal(initial.code, 2);
  assert.ok(initial.stderr.includes(first.latestEventId));
  await store.updateFromAgent({ eventId: first.latestEventId, status: 'working' });

  const rearmed = startHook('active-session', 'PostToolUse');
  const second = await store.submit(anchor(), 'Berücksichtige außerdem leere Eingaben.', 'implement');
  const delivered = await rearmed.completed;

  assert.equal(delivered.code, 2);
  assert.equal(delivered.signal, null);
  assert.ok(delivered.stderr.includes(second.latestEventId));
  assert.ok(delivered.stderr.includes('Berücksichtige außerdem leere Eingaben.'));
  assert.ok(!delivered.stderr.includes(first.latestEventId));
  assert.equal(store.events[0]?.acknowledged, true);
  assert.equal(store.events[1]?.acknowledged, false);
});

test('exits a duplicate workspace watcher cleanly while its owner continues waiting', { timeout: 15_000 }, async (t) => {
  const { store, bridge, startHook } = await fixture(t);
  const connected = waitForConnection(bridge);
  const owner = startHook('original-session');
  await connected;
  const duplicate = startHook('another-session');
  const result = await duplicate.completed;

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(owner.process.exitCode, null);
  assert.equal(owner.process.signalCode, null);

  const thread = await store.submit(anchor(), 'Bitte erkläre diese Entscheidung.', 'ask');
  const delivered = await owner.completed;
  assert.equal(delivered.code, 2);
  assert.ok(delivered.stderr.includes(thread.latestEventId));
  assert.equal(store.events[0]?.acknowledged, false);
});
