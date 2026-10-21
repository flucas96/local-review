import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { requireNodeRuntime } from '../src/executables.js';

/** Exercise real child-process failures using local executables without a Claude session. */
async function runtime(t: TestContext, source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-review-runtime-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const executable = join(root, 'node fixture');
  await writeFile(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return executable;
}

test('accepts a supported Node runtime', async () => {
  await requireNodeRuntime(process.execPath);
});

test('reports the selected missing executable and preserves its spawn error', async (t) => {
  const executable = `${await runtime(t, '')}-missing`;

  await assert.rejects(requireNodeRuntime(executable), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /ENOENT/u);
    assert.ok(error.message.includes(executable));
    assert.ok(error.cause instanceof Error && 'code' in error.cause);
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
});

test('reports an unsuccessful exit without including process output', async (t) => {
  const executable = await runtime(t, "process.stderr.write('PRIVATE_RUNTIME_OUTPUT'); process.exit(7);");

  await assert.rejects(requireNodeRuntime(executable), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Exit-Code 7/u);
    assert.ok(error.message.includes(executable));
    assert.doesNotMatch(error.message, /PRIVATE_RUNTIME_OUTPUT|Prüfe den Node-Pfad/u);
    assert.ok(error.cause instanceof Error && 'code' in error.cause);
    assert.equal(error.cause.code, 7);
    return true;
  });
});

test('distinguishes a terminating signal from the runtime timeout', async (t) => {
  const executable = await runtime(t, "process.kill(process.pid, 'SIGTERM');");

  await assert.rejects(requireNodeRuntime(executable), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Signal SIGTERM/u);
    assert.doesNotMatch(error.message, /Zeitlimit/u);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

test('identifies the existing five-second timeout', { timeout: 10_000 }, async (t) => {
  const executable = await runtime(t, 'setInterval(() => {}, 1_000);');

  await assert.rejects(requireNodeRuntime(executable), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /nicht rechtzeitig.*Zeitlimit: 5 s/u);
    assert.ok(error.message.includes(executable));
    assert.ok(error.cause instanceof Error && 'killed' in error.cause);
    assert.equal(error.cause.killed, true);
    return true;
  });
});

test('bounds diagnostic paths and removes embedded control characters', async () => {
  const executable = join(tmpdir(), `missing\n${'x'.repeat(1_000)}`);

  await assert.rejects(requireNodeRuntime(executable), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length < 700);
    assert.doesNotMatch(error.message, /[\r\n]/u);
    assert.match(error.message, /…/u);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

test('keeps the existing actionable message for unsupported Node versions', async (t) => {
  const executable = await runtime(t, "process.stdout.write('v20.19.0\\n');");

  await assert.rejects(requireNodeRuntime(executable), /Node\.js 22 oder neuer; gefunden wurde v20\.19\.0/u);
});
