import type * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import type { TestContext } from 'node:test';

import type { ReviewBridge } from '../src/contracts.js';
import { prepareConnection, registerClaudeLauncher } from '../src/setup.js';
import { commands, FakeTerminal, resetFakeEditor, resetFakeWindow, window, workspace } from './fakes/vscode.js';

const registrations: vscode.Disposable[] = [];

afterEach(() => {
  for (const registration of registrations.splice(0)) registration.dispose();
  resetFakeEditor();
  resetFakeWindow();
});

/** Provide a valid private connection without starting or interrupting a real Claude session. */
function bridge(workspaceRoot: string, connected = true, deliveryReady = connected): ReviewBridge {
  return {
    descriptor: { version: 1, url: 'http://127.0.0.1:32123', token: 'test-private-token', workspaceRoot },
    state: { connected, deliveryReady },
    onChange: () => ({ dispose() {} }),
    dispose() {},
  };
}

/** Isolate generated integration files from reviewed repositories and user settings. */
async function fixture(t: TestContext): Promise<{ root: string; context: vscode.ExtensionContext }> {
  const root = await mkdtemp(join(tmpdir(), 'local-review-setup-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, context: { extensionPath: '/installed/local-review' } as vscode.ExtensionContext };
}

test('reuses this project\'s latest managed Claude terminal after the extension is recreated', async (t) => {
  const { root, context } = await fixture(t);
  const earlier = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  Object.defineProperty(terminal, 'name', { value: 'Claude — current task' });
  window.terminals.push(earlier, terminal);
  const initial = registerClaudeLauncher(context, bridge(root), root);
  initial.dispose();
  registrations.push(registerClaudeLauncher(context, bridge(root), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.terminals.length, 2);
  assert.equal(earlier.showCalls, 0);
  assert.equal(earlier.disposed, false);
  assert.equal(terminal.showCalls, 1);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.deepEqual(window.quickPicks[0]?.map((item) => item.label), ['Terminal anzeigen', 'Verbindung neu starten']);
  assert.deepEqual(await readdir(root), []);
});

test('does not adopt another project\'s terminal or dispose it when connection setup is cancelled', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: join(root, 'another-project') });
  window.terminals.push(terminal);
  window.quickPickIndex = undefined;
  registrations.push(registerClaudeLauncher(context, bridge(root), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(terminal.showCalls, 0);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(window.quickPicks[0]?.map((item) => item.label), ['Letzte Unterhaltung fortsetzen', 'Neue Review-Unterhaltung']);
  assert.deepEqual(await readdir(root), []);
});

test('finds a managed terminal restored after extension activation without launching a duplicate', async (t) => {
  const { root, context } = await fixture(t);
  registrations.push(registerClaudeLauncher(context, bridge(root), root));
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.showCalls, 1);
  assert.deepEqual(terminal.sendTextCalls, []);
});

test('cancelling reconnect keeps the recovered conversation and performs no runtime writes', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  window.quickPickIndex = undefined;
  registrations.push(registerClaudeLauncher(context, bridge(root, false), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.deepEqual(await readdir(root), []);
});

test('a tool-only connection offers recovery before reopening the existing inactive delivery terminal', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  window.quickPickIndex = undefined;
  registrations.push(registerClaudeLauncher(context, bridge(root, true, false), root));

  await commands.executeCommand('localReview.startClaude');

  assert.deepEqual(window.quickPicks[0]?.map((item) => item.label), ['Verbindung neu starten', 'Terminal anzeigen']);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
});

test('a failed replacement setup preserves the existing Claude conversation', async (t) => {
  const { root, context } = await fixture(t);
  const terminal = new FakeTerminal({ name: 'Claude · Local Review', cwd: root });
  window.terminals.push(terminal);
  workspace.configurationValues.set('localReview.claudePath', join(root, 'missing-claude'));
  registrations.push(registerClaudeLauncher(context, bridge(root, false), root));

  await commands.executeCommand('localReview.startClaude');

  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.disposed, false);
  assert.deepEqual(terminal.sendTextCalls, []);
  assert.match(window.errors[0] ?? '', /wurde nicht gefunden/u);
  assert.deepEqual(await readdir(root), []);
});

for (const resume of [true, false]) {
  test(`starts ${resume ? 'a resumed' : 'a new'} conversation with private integration arguments in the correct project`, async (t) => {
    const { root, context } = await fixture(t);
    workspace.configurationValues.set('localReview.claudePath', process.execPath);
    workspace.configurationValues.set('localReview.nodePath', process.execPath);
    window.quickPickIndex = resume ? 0 : 1;
    registrations.push(registerClaudeLauncher(context, bridge(root, false), root));

    await commands.executeCommand('localReview.startClaude');

    assert.deepEqual(window.errors, []);
    assert.equal(window.terminals.length, 1);
    const terminal = window.terminals[0];
    assert.ok(terminal);
    assert.equal(terminal.creationOptions.cwd, root);
    assert.equal(terminal.showCalls, 1);
    assert.equal(terminal.sendTextCalls.length, 1);
    const command = terminal.sendTextCalls[0]?.text ?? '';
    assert.ok(command.includes(`'--mcp-config' '${join(root, 'mcp.json')}'`));
    assert.ok(command.includes(`'--settings' '${join(root, 'hooks.json')}'`));
    assert.equal(command.includes("'--continue'"), resume);
    assert.equal(command.includes('dangerously-load-development-channels'), false);
  });
}

test('rewriting private integration files replaces permissive old files and preserves complete JSON for readers', async (t) => {
  const { root, context } = await fixture(t);
  const source = bridge(root);
  const prepared = await prepareConnection(context, source, root, process.execPath);
  const connectionPath = join(root, 'connection.json');
  const files = [connectionPath, prepared.mcpPath, prepared.hooksPath];
  await Promise.all(files.map((path) => chmod(path, 0o644)));
  let complete = false;
  let reads = 0;
  const reading = (async () => {
    while (!complete) {
      for (const path of files) {
        const content: unknown = JSON.parse(await readFile(path, 'utf8'));
        assert.ok(typeof content === 'object' && content !== null);
        reads += 1;
      }
    }
  })();
  try {
    for (let update = 0; update < 8; update += 1) {
      await prepareConnection(context, source, root, process.execPath);
    }
  } finally {
    complete = true;
    await reading;
  }

  assert.ok(reads > 0);
  assert.deepEqual(JSON.parse(await readFile(connectionPath, 'utf8')), source.descriptor);
  for (const path of files) assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ['connection.json', 'hooks.json', 'mcp.json']);
});
