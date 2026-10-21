import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';
import type * as vscode from 'vscode';

import { createReviewController } from '../src/reviewController.js';
import { createReviewStore } from '../src/store.js';
import type { ReviewStore, ReviewThread } from '../src/contracts.js';
import {
  commands, comments, type FakeCommentController, type FakeCommentThread,
  extensionContext, FakeInteractiveEditor, FakeTextDocument, resetFakeEditor,
  resetFakeWindow, Selection, settle, Uri, window, workspace,
} from './fakes/vscode.js';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  resetFakeEditor();
  resetFakeWindow();
});

/** Start the production controller with actual durable storage and a native editor surface. */
async function fixture(projectThreads?: (threads: readonly ReviewThread[]) => readonly ReviewThread[]): Promise<{
  readonly store: ReviewStore;
  readonly document: FakeTextDocument;
  readonly editor: FakeInteractiveEditor;
  readonly controller: FakeCommentController;
}> {
  const root = await mkdtemp(join(tmpdir(), 'local-review-native-'));
  const store = await createReviewStore(join(root, 'review.json'), root);
  const document = new FakeTextDocument(Uri.file(join(root, 'example.ts')), 'before\noriginal();\nafter', 'typescript');
  const editor = new FakeInteractiveEditor(document);
  editor.selection = new Selection(1, 0, 1, 11);
  workspace.textDocuments.push(document);
  window.visibleTextEditors.push(editor);
  window.activeTextEditor = editor;
  commands.handlers.set('setContext', () => undefined);
  const context = {
    ...extensionContext(), extensionUri: Uri.file('/extension'), subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const presentedStore: ReviewStore = projectThreads === undefined ? store : {
    workspaceRoot: store.workspaceRoot,
    get threads() { return projectThreads(store.threads); },
    get events() { return store.events; },
    get pendingEvents() { return store.pendingEvents; },
    submit: store.submit.bind(store), updateFromAgent: store.updateFromAgent.bind(store),
    resolve: store.resolve.bind(store), setOutdated: store.setOutdated.bind(store),
    onChange: store.onChange.bind(store), flush: store.flush.bind(store),
  };
  const registered = await createReviewController(presentedStore, context);
  cleanup.push(async () => {
    registered.dispose();
    await store.flush();
    await rm(root, { recursive: true, force: true });
  });
  const controller = comments.controllers[0];
  assert.ok(controller);
  return { store, document, editor, controller };
}

/** Finish ordered store writes and the controller's asynchronous native refresh. */
async function refresh(store: ReviewStore): Promise<void> {
  await store.flush();
  await settle();
  await store.flush();
  await settle();
}

/** Create a draft through the exact command used by the editor title action. */
async function addDraft(controller: FakeCommentController): Promise<FakeCommentThread> {
  await commands.executeCommand('localReview.addComment');
  const draft = controller.threads.at(-1);
  assert.ok(draft);
  assert.equal(draft.comments.length, 0);
  return draft;
}

test('native progress updates preserve existing comment objects and appending a reply only renders the new message', async () => {
  const { store, controller } = await fixture();
  const draft = await addDraft(controller);
  await commands.executeCommand('localReview.submitInline', { thread: draft, text: '/A Explain this code' });
  await refresh(store);
  const thread = store.threads[0];
  assert.ok(thread);
  const initial = draft.comments;
  const first = initial[0];
  assert.ok(first);
  const writes = draft.commentsWrites;

  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'working' });
  await refresh(store);
  assert.equal(draft.label, 'Frage · Claude arbeitet');
  assert.strictEqual(draft.comments, initial);
  assert.equal(draft.commentsWrites, writes);

  await store.submit(thread.anchor, 'An unrelated review', 'ask');
  await refresh(store);
  assert.strictEqual(draft.comments, initial);
  assert.equal(draft.commentsWrites, writes);

  await store.updateFromAgent({ eventId: thread.latestEventId, status: 'answered', text: 'The original function is called.' });
  await refresh(store);
  assert.equal(draft.comments.length, 2);
  assert.strictEqual(draft.comments[0], first);
  assert.match(String((draft.comments[1]?.body as vscode.MarkdownString).value), /The original function is called\./u);
  assert.equal(draft.commentsWrites, writes + 1);
  const answer = draft.comments[1];
  assert.ok(answer);
  assert.equal(answer.contextValue, 'localReview.code');
  await store.setOutdated(thread.id, true);
  await refresh(store);
  assert.strictEqual(draft.comments[1], answer);
  await commands.executeCommand('localReview.openCommentCode', answer);
  assert.equal(window.shownDocuments.at(-1)?.document.uri.scheme, 'file');
  assert.equal(window.shownDocuments.at(-1)?.options?.selection?.start.line, 1);
});

test('replacing a message object refreshes its body and navigation actions even when its durable ID is unchanged', async () => {
  let replacement: ReviewThread | undefined;
  const { store, controller } = await fixture((threads) => replacement === undefined ? threads : [replacement]);
  const draft = await addDraft(controller);
  await commands.executeCommand('localReview.submitInline', { thread: draft, text: 'Explain this code' });
  await refresh(store);
  const original = store.threads[0];
  const originalMessage = original?.messages[0];
  assert.ok(original);
  assert.ok(originalMessage);
  const first = draft.comments[0];
  assert.ok(first);
  replacement = {
    ...original,
    messages: [{ ...originalMessage, author: 'claude', text: '```typescript\nreplacement();\n```' }],
  };
  await store.setOutdated(original.id, true);
  await refresh(store);
  const updated = draft.comments[0];
  assert.ok(updated);
  assert.notStrictEqual(updated, first);
  assert.equal(updated.author.name, 'Claude');
  assert.equal(updated.contextValue, 'localReview.code');
  assert.match((updated.body as vscode.MarkdownString).value, /replacement\(\);/u);
  await commands.executeCommand('localReview.openCommentCode', updated);
  assert.equal(window.shownDocuments.at(-1)?.document.uri.scheme, 'local-review-snippet');
  assert.equal(window.shownDocuments.at(-1)?.document.getText(), 'replacement();\n');
});

test('an explicit native draft keeps its captured code when the source changes while the reviewer types', async () => {
  const { store, document, controller } = await fixture();
  const draft = await addDraft(controller);
  document.text = 'before\nreplacement();\nafter';
  document.version += 1;

  await commands.executeCommand('localReview.submitInline', { thread: draft, text: '/i Add a timeout' });
  await refresh(store);
  const thread = store.threads[0];
  assert.ok(thread);
  assert.equal(thread.anchor.selectedText, 'original();');
  assert.equal(thread.intent, 'implement');
  assert.equal(thread.outdated, true);
  assert.equal(store.events[0]?.anchor.selectedText, 'original();');
  assert.equal(document.text, 'before\nreplacement();\nafter');
  assert.equal(draft.disposed, true);
  const visible = controller.threads.filter((candidate) => !candidate.disposed);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.uri.scheme, 'local-review-context');
  assert.match(visible[0]?.label ?? '', /Gespeicherter Kontext/u);
  assert.equal(window.shownDocuments.at(-1)?.document.getText(), 'before\noriginal();\nafter');
});

test('an explicit native draft follows uniquely matched code after an insertion without changing its original event anchor', async () => {
  const { store, document, controller } = await fixture();
  const draft = await addDraft(controller);
  document.text = 'inserted();\nbefore\noriginal();\nafter';
  document.version += 1;

  await commands.executeCommand('localReview.submitInline', { thread: draft, text: 'Explain this code' });
  await refresh(store);
  assert.equal(draft.disposed, false);
  assert.equal(draft.range.start.line, 2);
  assert.equal(store.threads[0]?.anchor.startLine, 2);
  assert.equal(store.threads[0]?.anchor.selectedText, 'original();');
  assert.equal(store.threads[0]?.outdated, true);
});

test('native uppercase summary shortcut summarizes the existing conversation and human resolve hides it until explicitly shown or reopened', async () => {
  const { store, controller } = await fixture();
  const draft = await addDraft(controller);
  await commands.executeCommand('localReview.submitInline', { thread: draft, text: '/i Add a timeout' });
  await commands.executeCommand('localReview.submitInline', { thread: draft, text: '/R' });
  await refresh(store);
  const thread = store.threads[0];
  assert.ok(thread);
  assert.equal(store.threads.length, 1);
  assert.equal(thread.intent, 'summarize');
  assert.equal(store.events.at(-1)?.text, 'Fasse diese Unterhaltung und ihren aktuellen Stand zusammen.');
  assert.equal(draft.comments.length, 2);

  await commands.executeCommand('localReview.resolve', draft);
  await refresh(store);
  assert.equal(draft.disposed, true);
  const tree = window.trees[0];
  assert.ok(tree);
  assert.deepEqual(await tree.provider.getChildren(), []);
  assert.match(tree.message, /Alle Kommentare erledigt/u);

  await commands.executeCommand('localReview.showResolved');
  const items = await tree.provider.getChildren();
  assert.equal(items?.length, 1);
  assert.match(String(items?.[0]?.label), /^example\.ts:2 · /u);
  assert.match(String(items?.[0]?.description), /Erledigt/u);
  const restored = controller.threads.at(-1);
  assert.ok(restored);
  assert.equal(restored.canReply, false);
  await commands.executeCommand('localReview.reopen', restored);
  await commands.executeCommand('localReview.hideResolved');
  await refresh(store);
  assert.equal(store.threads[0]?.resolved, false);
  assert.equal(restored.disposed, false);
  assert.deepEqual(restored.canReply, { name: 'Du', iconPath: Uri.file('/extension/resources/reviewer.svg') });
  assert.equal((await tree.provider.getChildren())?.length, 1);
});

test('empty mode-only native feedback fails without disposing or persisting the draft', async () => {
  const { store, controller } = await fixture();
  const draft = await addDraft(controller);
  await assert.rejects(commands.executeCommand('localReview.submitInline', { thread: draft, text: '/i' }), /Schreibe dein Feedback/u);
  assert.equal(store.events.length, 0);
  assert.equal(draft.disposed, false);
  assert.equal(draft.comments.length, 0);
  await commands.executeCommand('localReview.submitInline', { thread: draft, text: '/i Add a timeout' });
  await refresh(store);
  assert.equal(store.events.length, 1);
  assert.equal(store.threads[0]?.intent, 'implement');
});
