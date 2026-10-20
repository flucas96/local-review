import assert from 'node:assert/strict';
import test from 'node:test';

import { SubmissionGate } from '../src/submissionGate.js';

/** Hold a submission open so concurrent calls can be checked without timing assumptions. */
function pendingWork(): { readonly promise: Promise<void>; readonly complete: () => void } {
  let complete = (): void => { throw new Error('The pending promise has not been initialized.'); };
  const promise = new Promise<void>((resolve) => { complete = resolve; });
  return { promise, complete };
}

test('registers pending state before work begins and shares the exact submission promise', async () => {
  const gate = new SubmissionGate<object>();
  const thread = {};
  const pending = pendingWork();
  let calls = 0;
  const submission = gate.run(thread, async () => {
    calls += 1;
    assert.equal(gate.isPending(thread), true);
    await pending.promise;
  });
  const duplicate = gate.run(thread, async () => { assert.fail('Concurrent work must not start.'); });
  assert.strictEqual(duplicate, submission);
  assert.equal(gate.isPending(thread), true);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  pending.complete();
  await submission;
  assert.equal(gate.isPending(thread), false);
});

test('shares a failure and permits a fresh retry after rejection', async () => {
  const gate = new SubmissionGate<string>();
  const failure = new Error('Storage unavailable');
  let calls = 0;
  const submission = gate.run('thread', async () => {
    calls += 1;
    throw failure;
  });
  const duplicate = gate.run('thread', async () => { assert.fail('A duplicate must observe the same failure.'); });
  assert.strictEqual(duplicate, submission);
  await assert.rejects(submission, (error: unknown) => error === failure);
  assert.equal(gate.isPending('thread'), false);
  const retry = gate.run('thread', async () => { calls += 1; });
  assert.notStrictEqual(retry, submission);
  await retry;
  assert.equal(calls, 2);
  assert.equal(gate.isPending('thread'), false);
});

test('allows different threads to submit independently', async () => {
  const gate = new SubmissionGate<string>();
  const first = pendingWork();
  const second = pendingWork();
  const firstSubmission = gate.run('first', () => first.promise);
  const secondSubmission = gate.run('second', () => second.promise);
  assert.notStrictEqual(firstSubmission, secondSubmission);
  assert.equal(gate.isPending('first'), true);
  assert.equal(gate.isPending('second'), true);
  first.complete();
  await firstSubmission;
  assert.equal(gate.isPending('first'), false);
  assert.equal(gate.isPending('second'), true);
  second.complete();
  await secondSubmission;
  assert.equal(gate.isPending('second'), false);
});

test('clears pending state when work throws before returning a promise', async () => {
  const gate = new SubmissionGate<string>();
  const failure = new Error('Invalid draft');
  const submission = gate.run('thread', () => { throw failure; });
  assert.equal(gate.isPending('thread'), true);
  await assert.rejects(submission, (error: unknown) => error === failure);
  assert.equal(gate.isPending('thread'), false);
});
