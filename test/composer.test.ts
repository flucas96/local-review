import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { createComposer, type ComposerRequest, type ComposerSubmission, type ReviewComposer } from '../src/composer.js';
import type { CodeAnchor } from '../src/contracts.js';
import { extensionContext, FakeMemento, resetFakeWindow, settle, window, type FakeBrowser, type FakePanel } from './fakes/vscode.js';

const composers: ReviewComposer[] = [];

afterEach(() => {
  for (const composer of composers.splice(0)) composer.dispose();
  resetFakeWindow();
});

/** Create different immutable code targets with recognizable code and context. */
function request(id: string, overrides: Partial<ComposerRequest> = {}): ComposerRequest {
  const anchor: CodeAnchor = {
    path: `${id}.ts`, startLine: 4, endLine: 4, selectedText: `${id}();`,
    contextBefore: 'before();\n', contextAfter: 'after();', documentHash: `${id}-hash`,
    baseRevision: 'a'.repeat(40), side: 'working',
  };
  return { id, title: 'Feedback schreiben', path: anchor.path, code: `before();\n${anchor.selectedText}\nafter();`, intent: 'ask', anchor, ...overrides };
}

/** Start the real host and its embedded webview script using fake editor surfaces. */
async function openComposer(
  initial = request('first'),
  submit: (submission: ComposerSubmission) => Promise<void> = async () => undefined,
): Promise<{ readonly composer: ReviewComposer; readonly panel: FakePanel; readonly browser: FakeBrowser; readonly storage: FakeMemento }> {
  const storage = new FakeMemento();
  const composer = createComposer(extensionContext(storage), submit);
  composers.push(composer);
  await composer.open(initial);
  const panel = window.panels.at(-1);
  assert.ok(panel);
  const browser = panel.startBrowser();
  await settle();
  return { composer, panel, browser, storage };
}

/** Narrow stored drafts so assertions inspect actual persisted user text. */
function savedDrafts(storage: FakeMemento): readonly { readonly id: string; readonly text: string }[] {
  return storage.get<{ readonly drafts: readonly { readonly id: string; readonly text: string }[] }>('localReview.composerDrafts.v1')?.drafts ?? [];
}

test('selection following does not open a composer before the reviewer asks for one', async () => {
  const composer = createComposer(extensionContext(), async () => undefined);
  composers.push(composer);
  await composer.followSelection(request('first'));
  assert.equal(composer.isOpen(), false);
  assert.equal(window.panels.length, 0);
});

test('an empty composer follows selected code without revealing the panel or focusing input', async () => {
  const { composer, panel, browser } = await openComposer();
  const targets: (ComposerRequest | undefined)[] = [];
  const listener = composer.onDidChangeTarget((target) => targets.push(target));
  const initialFocus = browser.element('feedback').focusCount;
  const initialReveals = panel.revealCalls.length;

  await composer.followSelection(request('second'));
  await settle();

  assert.equal(browser.element('path').textContent, 'second.ts:4');
  assert.equal(browser.element('code').textContent, 'second();');
  assert.equal(browser.element('contextCode').textContent, 'before();\nsecond();\nafter();');
  assert.equal(browser.element('feedback').focusCount, initialFocus);
  assert.equal(panel.revealCalls.length, initialReveals);
  assert.equal(targets.at(-1)?.id, 'second');
  listener.dispose();
});

test('typed browser text pins its context even before its change message reaches the host', async () => {
  const { composer, browser, storage } = await openComposer();
  browser.type('Why a fixed delay?');
  await composer.followSelection(request('second'));
  await settle();

  assert.equal(browser.element('path').textContent, 'first.ts:4');
  assert.equal(browser.element('feedback').value, 'Why a fixed delay?');
  assert.equal(browser.element('selection').hidden, false);
  assert.equal(browser.element('selectionPath').textContent, 'second.ts:4');
  assert.equal(savedDrafts(storage).find((draft) => draft.id === 'first')?.text, 'Why a fixed delay?');
});

test('explicitly using a pending selection saves the prior draft and starts distinct feedback', async () => {
  const { composer, browser, storage } = await openComposer();
  browser.type('/i Use exponential backoff.');
  await composer.followSelection(request('second'));
  await settle();
  browser.element('takeSelection').fire('click');
  await settle();

  assert.equal(browser.element('path').textContent, 'second.ts:4');
  assert.equal(browser.element('feedback').value, '');
  assert.equal(browser.element('selection').hidden, true);
  assert.equal(savedDrafts(storage).find((draft) => draft.id === 'first')?.text, 'Use exponential backoff.');
  assert.equal(savedDrafts(storage).find((draft) => draft.id === 'second')?.text, '');

  await composer.open(request('first'));
  await settle();
  assert.equal(browser.element('feedback').value, 'Use exponential backoff.');
  assert.equal(browser.element('send').textContent, 'Änderung anfordern');
});

test('sending keeps the composer open and the next selection starts a new comment', async () => {
  const submissions: ComposerSubmission[] = [];
  const { composer, panel, browser, storage } = await openComposer(request('first'), async (submission) => { submissions.push(submission); });
  browser.type('Why a fixed delay?');
  browser.element('send').fire('click');
  await settle();

  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.anchor?.selectedText, 'first();');
  assert.equal(panel.disposed, false);
  assert.equal(composer.isOpen(), true);
  assert.equal(browser.element('feedback').value, '');
  assert.match(browser.element('saved').textContent, /Gesendet/u);
  assert.equal(savedDrafts(storage).some((draft) => draft.id === 'first'), false);

  await composer.followSelection(request('second'));
  await settle();
  assert.equal(browser.element('path').textContent, 'second.ts:4');
  assert.equal(browser.element('feedback').disabled, false);
  assert.equal(submissions.length, 1);
});

test('failed sends retain draft text and the original context for a retry', async () => {
  const { composer, panel, browser, storage } = await openComposer(request('first'), async () => { throw new Error('Delivery unavailable'); });
  browser.type('Please explain this.');
  browser.element('send').fire('click');
  await settle();
  await composer.followSelection(request('second'));
  await settle();

  assert.equal(panel.disposed, false);
  assert.equal(browser.element('path').textContent, 'first.ts:4');
  assert.equal(browser.element('feedback').value, 'Please explain this.');
  assert.equal(browser.element('feedback').disabled, false);
  assert.equal(browser.element('error').textContent, 'Delivery unavailable');
  assert.equal(savedDrafts(storage).find((draft) => draft.id === 'first')?.text, 'Please explain this.');
});

test('replies remain attached to their conversation until sent, then accept a new selection', async () => {
  const submissions: ComposerSubmission[] = [];
  const { composer, browser } = await openComposer(request('first', { threadId: 'conversation' }), async (submission) => { submissions.push(submission); });
  await composer.followSelection(request('second'));
  await settle();
  assert.equal(browser.element('path').textContent, 'first.ts:4');
  assert.equal(browser.element('selection').hidden, true);

  browser.type('Can you explain that choice?');
  browser.element('send').fire('click');
  await settle();
  assert.equal(submissions[0]?.threadId, 'conversation');
  await composer.followSelection(request('second'));
  await settle();
  assert.equal(browser.element('path').textContent, 'second.ts:4');
});

test('selection changes during a send preserve the submitted anchor and follow only the latest code', async () => {
  let finish: (() => void) | undefined;
  const submissions: ComposerSubmission[] = [];
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { composer, browser } = await openComposer(request('first'), async (submission) => { submissions.push(submission); await pending; });
  browser.type('Change this.');
  browser.element('send').fire('click');
  await settle();
  await composer.followSelection(request('second'));
  await composer.followSelection(request('third'));
  await settle();
  assert.equal(browser.element('path').textContent, 'first.ts:4');
  assert.equal(submissions[0]?.id, 'first');
  assert.equal(submissions[0]?.anchor?.selectedText, 'first();');
  assert.ok(finish);
  finish();
  await settle();
  assert.equal(browser.element('path').textContent, 'third.ts:4');
  assert.equal(browser.element('feedback').disabled, false);
});

test('rapid selection offers settle on the latest target and ignore a delayed obsolete acceptance', async () => {
  const { composer, panel, browser } = await openComposer();
  await composer.followSelection(request('second'));
  await composer.followSelection(request('third'));
  await settle();
  panel.receive({ type: 'follow', id: 'first', selectionId: 'second', text: '', intent: 'ask', explicit: false });
  await settle();
  assert.equal(browser.element('path').textContent, 'third.ts:4');
  assert.equal(browser.element('feedback').disabled, false);
});

test('closing invalidates pending selections and does not let delayed messages create a new panel', async () => {
  const { composer, panel } = await openComposer();
  await composer.followSelection(request('second'));
  panel.dispose();
  panel.receive({ type: 'follow', id: 'first', selectionId: 'second', text: '', intent: 'ask', explicit: false });
  await composer.followSelection(request('third'));
  await settle();
  assert.equal(composer.isOpen(), false);
  assert.equal(window.panels.length, 1);
});
