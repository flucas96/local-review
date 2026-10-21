import type * as vscode from 'vscode';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { hashDocumentText } from '../src/anchors.js';
import { createCodeNavigation, openCommentCodeCommand, type ReviewCodeNavigation } from '../src/codeNavigation.js';
import { openCodeCommand } from '../src/codeReferences.js';
import type { ReviewMessage, ReviewStore, ReviewThread } from '../src/contracts.js';
import { commands, FakeTextDocument, resetFakeEditor, resetFakeWindow, settle, Uri, ViewColumn, window, workspace } from './fakes/vscode.js';

const navigators: ReviewCodeNavigation[] = [];

afterEach(() => {
  for (const navigation of navigators.splice(0)) navigation.dispose();
  resetFakeEditor();
  resetFakeWindow();
});

/** Build a durable discussion while leaving unrelated persistence operations unavailable. */
function fixture(text: string, selectedText = 'value();'): { store: ReviewStore; threads: ReviewThread[]; thread: ReviewThread; message: ReviewMessage } {
  const message: ReviewMessage = { id: 'message-1', author: 'claude', text, createdAt: '2026-10-21T10:00:00.000Z' };
  const thread: ReviewThread = {
    id: 'thread-1',
    anchor: {
      path: 'src/example.ts', startLine: 2, endLine: 2, selectedText,
      contextBefore: 'before\n', contextAfter: 'after', documentHash: hashDocumentText(`before\n${selectedText}\nafter`),
      side: 'working', baseRevision: 'a'.repeat(40),
    },
    messages: [message], intent: 'ask', status: 'answered', resolved: false, outdated: false, latestEventId: 'event-1',
  };
  const threads = [thread];
  const unavailable = async (): Promise<never> => { throw new Error('Persistence is outside this navigation test.'); };
  const store: ReviewStore = {
    workspaceRoot: '/workspace', threads, events: [], pendingEvents: [],
    submit: unavailable, updateFromAgent: unavailable, resolve: unavailable, setOutdated: unavailable,
    onChange: () => ({ dispose(): void {} }), flush: async () => undefined,
  };
  return { store, threads, thread, message };
}

/** Bind the real native comment object exactly as the review controller does. */
function commentFor(navigator: ReviewCodeNavigation, thread: ReviewThread, message: ReviewMessage): vscode.Comment & { body: vscode.MarkdownString } {
  const comment = { body: navigator.markdown(thread, message), author: { name: 'Claude' }, mode: 1 };
  navigator.bindComment(thread, message, comment);
  return comment;
}

/** Dispose every real navigator even when an assertion fails. */
async function navigation(store: ReviewStore): Promise<ReviewCodeNavigation> {
  const result = await createCodeNavigation(store);
  navigators.push(result);
  return result;
}

/** Pause individual editor operations to verify the command's actual completion boundary. */
function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test('generated code action opens the uniquely matching range in live unsaved source', async () => {
  const { store, thread, message } = fixture('Suggested code:\n```\nvalue();\n```');
  const document = new FakeTextDocument(Uri.file('/workspace/src/example.ts'), 'unsaved insertion\nbefore\nvalue();\nafter', 'typescript');
  document.isDirty = true;
  workspace.textDocuments.push(document);
  window.visibleTextEditors.push({ document, viewColumn: 2 });
  const navigator = await navigation(store);
  const comment = commentFor(navigator, thread, message);
  const markdown = comment.body;
  assert.equal(markdown.supportThemeIcons, true);
  assert.equal(markdown.supportHtml, true);
  assert.equal(markdown.isTrusted, undefined);
  assert.equal(comment.contextValue, 'localReview.code');
  assert.equal(markdown.value.includes('command:localReview.'), false);
  assert.equal(markdown.value.includes('```typescript\nvalue();'), true);

  await commands.executeCommand(openCommentCodeCommand, comment);

  assert.equal(window.shownDocuments.length, 1);
  assert.equal(window.shownDocuments[0]?.document, document);
  assert.equal(window.shownDocuments[0]?.options?.viewColumn, 2);
  assert.deepEqual(window.shownDocuments[0]?.options?.selection?.start, { line: 2, character: 0 });
  assert.deepEqual(window.shownDocuments[0]?.options?.selection?.end, { line: 2, character: 8 });
  assert.equal(window.statusMessages.length, 0);
});

test('a proposal opens beside the native discussion instead of replacing its document', async () => {
  const { store, thread, message } = fixture('```ts\nproposed();\n```');
  const document = new FakeTextDocument(Uri.file('/workspace/src/example.ts'), 'before\nvalue();\nafter', 'typescript');
  workspace.textDocuments.push(document);
  window.visibleTextEditors.push({ document, viewColumn: 1 });
  const navigator = await navigation(store);

  await commands.executeCommand(openCommentCodeCommand, commentFor(navigator, thread, message));

  assert.equal(window.shownDocuments[0]?.options?.viewColumn, ViewColumn.Beside);
  assert.equal(window.shownDocuments[0]?.document.uri.scheme, 'local-review-snippet');
});

test('legacy code boxes open their displayed snippet and recover it after a reload', async () => {
  const code = "import { setTimeout as delay } from 'node:timers/promises';\n\nexport async function withRetry(operation) { return operation(); }";
  const { store, thread, message } = fixture(`Implemented:\n\n${code}\n\nExplanation.`);
  const navigator = await navigation(store);
  await commands.executeCommand(openCommentCodeCommand, commentFor(navigator, thread, message));
  const document = window.shownDocuments.at(-1)?.document;
  assert.ok(document);
  assert.equal(document.uri.scheme, 'local-review-snippet');
  assert.equal(document.getText(), `${code}\n`);
  navigator.dispose();
  workspace.textDocuments.splice(0);
  await navigation(store);
  const recovered = await workspace.openTextDocument(document.uri);
  assert.equal(recovered.getText(), `${code}\n`);
});

test('opening composer code beside a lone chat preserves its only editor group', async () => {
  const { store, thread } = fixture('Discussion');
  workspace.textDocuments.push(new FakeTextDocument(Uri.file('/workspace/src/example.ts'), 'before\nvalue();\nafter', 'typescript'));
  const navigator = await navigation(store);

  await navigator.openAnchor(thread.anchor);

  assert.equal(window.shownDocuments[0]?.options?.viewColumn, ViewColumn.Beside);
  assert.equal(window.shownDocuments[0]?.document.uri.scheme, 'file');
});

test('missing or ambiguous code opens exact readonly snippets with the installed fence language', async () => {
  const { store, thread, message } = fixture('```py\n  value();\n\n```', 'unrelated();');
  workspace.textDocuments.push(new FakeTextDocument(Uri.file('/workspace/src/example.ts'), '  value();\n\nafter\n  value();\n\nend', 'typescript'));
  const navigator = await navigation(store);
  const comment = commentFor(navigator, thread, message);

  await commands.executeCommand(openCommentCodeCommand, comment);

  const ambiguous = window.shownDocuments[0]?.document;
  assert.ok(ambiguous);
  assert.equal(ambiguous.uri.scheme, 'local-review-snippet');
  assert.match(ambiguous.uri.path, /\/Codevorschau – example\.ts$/u);
  assert.equal(ambiguous.getText(), '  value();\n\n');
  assert.equal(ambiguous.isReadonly, true);
  assert.equal(ambiguous.languageId, 'python');
  assert.equal(workspace.providers.has(ambiguous.uri.scheme), true);
  assert.match(window.statusMessages[0] ?? '', /Kein eindeutiger Treffer/u);

  workspace.textDocuments.splice(0);
  await commands.executeCommand(openCommentCodeCommand, comment);
  const missing = window.shownDocuments.at(-1)?.document;
  assert.ok(missing);
  assert.equal(missing.uri.scheme, 'local-review-snippet');
  assert.equal(missing.getText(), '  value();\n\n');
  assert.equal(missing.languageId, 'python');
});

test('unknown and model-authored handles cannot open documents, and removed messages invalidate old actions', async () => {
  const malicious = `[Open](command:${openCodeCommand}?${encodeURIComponent(JSON.stringify(['model-handle']))})`;
  const { store, threads, thread, message } = fixture(`${malicious}\n\n\`\`\`js\nvalue();\n\`\`\``);
  const navigator = await navigation(store);
  const comment = commentFor(navigator, thread, message);
  for (const invalid of ['model-handle', 'thread-1', { threadId: thread.id, messageId: message.id, blockIndex: 0 }]) {
    await commands.executeCommand(openCodeCommand, invalid);
  }
  for (const invalid of [null, 'message-1', { ...comment }, { comment }]) {
    await commands.executeCommand(openCommentCodeCommand, invalid);
  }
  assert.equal(comment.body.isTrusted, undefined);
  threads.splice(0);
  await commands.executeCommand(openCommentCodeCommand, comment);
  assert.equal(window.shownDocuments.length, 0);
  assert.equal(workspace.textDocuments.length, 0);
  assert.equal(window.errors.length, 4);
});

test('the header action selects one of several code blocks and cancellation leaves the editor alone', async () => {
  const { store, thread, message } = fixture('```ts\nfirstProposal();\n```\n\n```js\nsecondProposal();\n```');
  const navigator = await navigation(store);
  const comment = commentFor(navigator, thread, message);
  window.quickPickIndex = undefined;

  await commands.executeCommand(openCommentCodeCommand, comment);

  assert.equal(window.quickPicks.length, 1);
  assert.equal(window.shownDocuments.length, 0);
  assert.deepEqual(window.quickPicks[0]?.map(({ description }) => description), ['firstProposal();', 'secondProposal();']);
  window.quickPickIndex = 1;

  await commands.executeCommand(openCommentCodeCommand, comment);

  assert.equal(window.shownDocuments.length, 1);
  assert.equal(window.shownDocuments[0]?.document.getText(), 'secondProposal();\n');
  assert.equal(window.shownDocuments[0]?.document.languageId, 'javascript');
});

test('Claude prose opens its captured context directly while human prose has no code action', async () => {
  const { store, thread, message } = fixture('Explanation.');
  const navigator = await navigation(store);
  const human = commentFor(navigator, thread, { ...message, author: 'human' });
  assert.equal(human.contextValue, undefined);
  await commands.executeCommand(openCommentCodeCommand, human);
  assert.equal(window.shownDocuments.length, 0);

  const comment = commentFor(navigator, thread, message);
  await commands.executeCommand(openCommentCodeCommand, comment);
  assert.equal(window.quickPicks.length, 0);
  assert.equal(window.shownDocuments[0]?.document.getText(), thread.anchor.selectedText);
});

test('durable readonly preview recovers from stored review content after navigator recreation', async () => {
  const { store, thread, message } = fixture('```js\nnewProposal();\n```');
  const first = await navigation(store);
  await commands.executeCommand(openCommentCodeCommand, commentFor(first, thread, message));
  const preview = window.shownDocuments[0]?.document;
  assert.ok(preview);
  const savedUri = preview.uri;
  first.dispose();
  workspace.textDocuments.splice(0);
  assert.equal(workspace.providers.has('local-review-snippet'), false);

  await navigation(store);
  const restored = await workspace.openTextDocument(savedUri);

  assert.equal(restored.getText(), 'newProposal();\n');
  assert.equal(restored.isReadonly, true);
  assert.equal(restored.uri.toString(), savedUri.toString());
});

test('command promise waits for both asynchronous document loading and editor reveal', async () => {
  const { store, thread, message } = fixture('```ts\nvalue();\n```');
  workspace.textDocuments.push(new FakeTextDocument(Uri.file('/workspace/src/example.ts'), 'before\nvalue();\nafter', 'typescript'));
  const navigator = await navigation(store);
  const documentReady = deferred();
  const editorReady = deferred();
  workspace.beforeOpen = () => documentReady.promise;
  window.beforeShow = () => editorReady.promise;
  let completed = false;
  const pending = commands.executeCommand(openCommentCodeCommand, commentFor(navigator, thread, message)).then(() => { completed = true; });
  await settle();
  assert.equal(completed, false);
  assert.equal(window.shownDocuments.length, 0);

  documentReady.resolve();
  await settle();
  assert.equal(completed, false);
  assert.equal(window.shownDocuments.length, 0);

  editorReady.resolve();
  await pending;
  assert.equal(completed, true);
  assert.equal(window.shownDocuments.length, 1);
});
