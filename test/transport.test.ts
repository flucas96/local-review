import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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
  readonly stdout: string;
  readonly stderr: string;
}

type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse' | 'Stop';

interface TransportFixture {
  readonly store: ReviewStore;
  readonly bridge: ReviewBridge;
  readonly startHook: (sessionId: string, event?: HookEvent, agentId?: string) => HookProcess;
  readonly runningHooks: () => readonly HookProcess[];
  readonly restartBridge: () => Promise<ReviewBridge>;
}

/** Exercise the packaged hook against a real local bridge and isolated durable storage. */
async function fixture(t: TestContext): Promise<TransportFixture> {
  const hookPath = path.resolve('dist', 'hook-waiter.cjs');
  await access(hookPath);
  const root = await mkdtemp(path.join(tmpdir(), 'local-review-transport-'));
  const store = await createReviewStore(path.join(root, 'review.json'), root);
  let bridge = await createReviewBridge(store);
  const bridges = [bridge];
  const connectionPath = path.join(root, 'connection.json');
  const hooks: HookProcess[] = [];
  await writeFile(connectionPath, JSON.stringify(bridge.descriptor), { mode: 0o600 });
  t.after(async () => {
    const running = runningHooks();
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
    for (const server of bridges) server.dispose();
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });

  /** Supply the same stdin session envelope as a Claude command hook. */
  function startHook(sessionId: string, event: HookEvent = 'Stop', agentId?: string): HookProcess {
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
      ...(agentId === undefined ? {} : { agent_id: agentId }),
    }));
    const hook: HookProcess = {
      process: child, completed,
      get stdout() { return stdout; },
      get stderr() { return stderr; },
    };
    hooks.push(hook);
    return hook;
  }

  /** Count live hook children directly, including duplicate hooks that have not exited yet. */
  function runningHooks(): readonly HookProcess[] {
    return hooks.filter((hook) => hook.process.exitCode === null && hook.process.signalCode === null);
  }

  return {
    store, startHook, runningHooks,
    get bridge() { return bridge; },
    restartBridge: async () => {
      bridge.dispose();
      bridge = await createReviewBridge(store);
      bridges.push(bridge);
      await writeFile(connectionPath, JSON.stringify(bridge.descriptor), { mode: 0o600 });
      return bridge;
    },
  };
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

/** Observe authenticated hook requests so silence is checked after startup and snapshot filtering. */
function waitForRequests(bridge: ReviewBridge, count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let remaining = count;
    const timeout = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`The hook did not make ${count} authenticated bridge requests.`));
    }, 5_000);
    const subscription = bridge.onChange(() => {
      if (!bridge.state.connected) return;
      remaining -= 1;
      if (remaining > 0) return;
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    });
  });
}

/** Require an already-connected watcher to remain alive and emit no wake-up feedback. */
async function assertQuietWatcher(hook: HookProcess): Promise<void> {
  const stopped = await Promise.race([
    hook.completed,
    delay(400).then(() => undefined),
  ]);
  assert.equal(stopped, undefined, 'The watcher must keep waiting when only an already-emitted event exists.');
  assert.equal(hook.process.exitCode, null);
  assert.equal(hook.process.signalCode, null);
  assert.equal(hook.stdout, '');
  assert.equal(hook.stderr, '');
}

test('delivers queued feedback through hook exit 2 without acknowledging it before Claude does', { timeout: 15_000 }, async (t) => {
  const { store, bridge, startHook } = await fixture(t);
  const connected = waitForConnection(bridge);
  const hook = startHook('review-session');
  await connected;
  assert.equal(bridge.state.deliveryReady, true);
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
  assert.match(result.stderr, /Fence all code, including imports and one-line functions, with a language tag/u);
  assert.match(result.stderr, /Preserve indentation and real newlines/u);
  assert.doesNotMatch(result.stderr, /functions that happen to fit on one line/u);
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
  assert.deepEqual(answered.threads, []);
  assert.equal(store.threads[0]?.messages.at(-1)?.text, 'Der Wert wurde bereits berechnet.');
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

test('does not repeat unacknowledged comments on Stop and PostToolUse while delivering genuinely new feedback', { timeout: 15_000 }, async (t) => {
  const { store, startHook } = await fixture(t);
  const first = await store.submit(anchor(), 'Die erste Frage bitte nur einmal zustellen.', 'ask');
  assert.equal((await startHook('active-session', 'SessionStart').completed).code, 2);

  const second = await store.submit(anchor(), 'Die zweite Frage ist ein neuer Auftrag.', 'ask');
  const afterStop = await startHook('active-session', 'Stop').completed;
  assert.equal(afterStop.code, 2);
  assert.ok(afterStop.stderr.includes(second.latestEventId));
  assert.ok(!afterStop.stderr.includes(first.latestEventId));

  const third = await store.submit(anchor(), 'Die dritte Frage kam nach dem Tool.', 'ask');
  const afterTool = await startHook('active-session', 'PostToolUse').completed;
  assert.equal(afterTool.code, 2);
  assert.ok(afterTool.stderr.includes(third.latestEventId));
  assert.ok(!afterTool.stderr.includes(first.latestEventId));
  assert.ok(!afterTool.stderr.includes(second.latestEventId));
  assert.ok(store.events.every((event) => !event.acknowledged));
  assert.ok(store.threads.every((thread) => thread.status === 'queued'));
});

test('replays unfinished work after SessionStart in the same resumed session and in a new session', { timeout: 15_000 }, async (t) => {
  const { store, startHook } = await fixture(t);
  const thread = await store.submit(anchor(), 'Nach einem Abbruch bitte wieder aufnehmen.', 'implement');
  const first = await startHook('resumed-session', 'SessionStart').completed;
  assert.equal(first.code, 2);
  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'working' });

  const resumed = await startHook('resumed-session', 'SessionStart').completed;
  assert.equal(resumed.code, 2);
  assert.ok(resumed.stderr.includes(thread.latestEventId));
  const another = await startHook('new-session', 'SessionStart').completed;
  assert.equal(another.code, 2);
  assert.ok(another.stderr.includes(thread.latestEventId));
  assert.equal(store.threads[0]?.status, 'working');
});

test('ignores subagent hooks before they can claim the workspace watcher', { timeout: 15_000 }, async (t) => {
  const { store, startHook } = await fixture(t);
  const subagent = await startHook('parent-session', 'PostToolUse', 'review-subagent').completed;
  assert.equal(subagent.code, 0);
  assert.equal(subagent.stdout, '');
  assert.equal(subagent.stderr, '');
  const thread = await store.submit(anchor(), 'Dieser Kommentar gehört in den Hauptchat.', 'ask');
  const parent = await startHook('parent-session', 'Stop').completed;
  assert.equal(parent.code, 2);
  assert.ok(parent.stderr.includes(thread.latestEventId));
  assert.equal(store.events[0]?.acknowledged, false);
});

test('keeps an unacknowledged old event quiet through idle Stop rearming and duplicate PostToolUse hooks', { timeout: 15_000 }, async (t) => {
  const { store, bridge, startHook, runningHooks } = await fixture(t);
  const old = await store.submit(anchor(), 'Diese Frage ist bereits einmal zugestellt.', 'ask');
  const initial = await startHook('idle-session', 'SessionStart').completed;
  assert.equal(initial.code, 2);
  assert.ok(initial.stderr.includes(old.latestEventId));
  assert.equal(store.events[0]?.acknowledged, false);

  const polling = waitForRequests(bridge, 2);
  const waiting = startHook('idle-session', 'Stop');
  await polling;
  await assertQuietWatcher(waiting);
  const duplicate = await startHook('idle-session', 'PostToolUse').completed;
  assert.deepEqual(duplicate, { code: 0, signal: null, stdout: '', stderr: '' });
  assert.deepEqual(runningHooks(), [waiting]);
  await assertQuietWatcher(waiting);

  const fresh = await store.submit(anchor(), 'Diese neue Frage soll den wartenden Chat wecken.', 'ask');
  const delivered = await waiting.completed;
  assert.equal(delivered.code, 2);
  assert.equal(delivered.signal, null);
  assert.equal(delivered.stdout, '');
  assert.ok(delivered.stderr.includes(fresh.latestEventId));
  assert.ok(!delivered.stderr.includes(old.latestEventId));
  assert.equal(delivered.stderr.split('BEGIN REVIEW DATA (JSON)').length - 1, 1);
  assert.deepEqual(store.events.map((event) => event.acknowledged), [false, false]);

  const rearmedPolling = waitForRequests(bridge, 2);
  const rearmed = startHook('idle-session', 'Stop');
  await rearmedPolling;
  await assertQuietWatcher(rearmed);
  assert.deepEqual(runningHooks(), [rearmed]);
});

test('preserves same-session emission receipts through a live bridge restart and delivers only new feedback', { timeout: 15_000 }, async (t) => {
  const context = await fixture(t);
  const { store, startHook, runningHooks } = context;
  const old = await store.submit(anchor(), 'Ein Verbindungswechsel soll diese Frage nicht wiederholen.', 'ask');
  assert.equal((await startHook('reconnecting-session', 'SessionStart').completed).code, 2);

  const polling = waitForRequests(context.bridge, 2);
  const waiting = startHook('reconnecting-session', 'Stop');
  await polling;
  await assertQuietWatcher(waiting);
  const previous = context.bridge.descriptor;
  const replacement = await context.restartBridge();
  assert.notEqual(replacement.descriptor.token, previous.token);
  await waitForConnection(replacement);
  await assertQuietWatcher(waiting);
  assert.deepEqual(runningHooks(), [waiting]);
  assert.equal(store.events[0]?.acknowledged, false);

  const fresh = await store.submit(anchor(), 'Nach dem Wiederverbinden ist dies der neue Auftrag.', 'implement');
  const delivered = await waiting.completed;
  assert.equal(delivered.code, 2);
  assert.equal(delivered.signal, null);
  assert.equal(delivered.stdout, '');
  assert.ok(delivered.stderr.includes(fresh.latestEventId));
  assert.ok(!delivered.stderr.includes(old.latestEventId));
  assert.equal(delivered.stderr.split('BEGIN REVIEW DATA (JSON)').length - 1, 1);
  assert.deepEqual(store.events.map((event) => event.acknowledged), [false, false]);
});
