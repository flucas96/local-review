import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, mock } from 'node:test';
import { runInNewContext } from 'node:vm';

import type { CodeAnchor } from '../src/contracts.js';
import { GitHubReviewClient, type GitHubHandoffTarget } from '../src/github.js';
import { previewHtml, registerPrExport } from '../src/prExportController.js';
import { createReviewStore } from '../src/store.js';
import { commands, env, extensionContext, FakeElement, resetFakeEditor, resetFakeWindow, settle, window } from './fakes/vscode.js';

const target: GitHubHandoffTarget = {
  pullRequest: { host: 'github.com', owner: 'example', repository: 'review', number: 42,
    url: 'https://github.com/example/review/pull/42', title: 'Review changes', branch: 'feature' },
  viewerLogin: 'reviewer',
};
const draft = { markdown: '## Review\n\nOriginal question.', summaryCount: 0, questionCount: 1, pendingSummaryCount: 0, capturedAt: '2026-10-21T12:00:00.000Z' };
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  mock.restoreAll();
  resetFakeEditor();
  resetFakeWindow();
});

/** Add only the standard form state consumed by the production handoff script. */
class PreviewElement extends FakeElement {
  readOnly = false;
  className = '';
  readonly classList = { toggle: (): void => undefined };

  /** Model a keyboard-triggered click through the same disabled-state guard. */
  click(): void { this.fire('click'); }
}

/** Execute actual preview JavaScript without accessing GitHub or an editor window. */
class PreviewBrowser {
  readonly messages: unknown[] = [];
  readonly elements = new Map<string, PreviewElement>();
  private receiveMessage: ((event: { readonly data: unknown }) => void) | undefined;

  constructor(html = previewHtml(draft, target)) {
    for (const match of html.matchAll(/\bid="([^"]+)"/gu)) {
      if (match[1] !== undefined) this.elements.set(match[1], new PreviewElement());
    }
    this.element('body').value = decodeHtml(/<textarea[^>]*>([\s\S]*?)<\/textarea>/u.exec(html)?.[1] ?? '');
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    assert.ok(script);
    runInNewContext(script, {
      acquireVsCodeApi: () => ({ postMessage: (message: unknown): void => { this.messages.push(message); } }),
      document: { getElementById: (id: string): PreviewElement => this.element(id) },
      window: { addEventListener: (_type: string, listener: (event: { readonly data: unknown }) => void): void => { this.receiveMessage = listener; } },
    });
  }

  /** Return one actual preview control instead of inventing missing markup. */
  element(id: string): PreviewElement {
    const element = this.elements.get(id);
    assert.ok(element, `Missing preview element: ${id}`);
    return element;
  }

  /** Deliver the real host publication states to the embedded script. */
  receive(message: unknown): void { this.receiveMessage?.({ data: message }); }

  /** Edit the preview through its actual input event. */
  edit(value: string): void {
    this.element('body').value = value;
    this.element('body').fire('input');
  }
}

/** Decode only the five entities used by the production HTML escaper. */
function decodeHtml(value: string): string {
  return value.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&');
}

test('publishing immediately locks the preview and subsequent edits clearly become unpublished', () => {
  const browser = new PreviewBrowser();
  browser.element('publish').click();
  browser.element('publish').click();
  assert.equal(browser.messages.length, 1);
  assert.equal(browser.element('body').readOnly, true);
  browser.receive({ kind: 'published', message: 'Published.' });
  browser.receive({ kind: 'idle' });
  assert.equal(browser.element('publish').disabled, true);
  assert.equal(browser.element('status').className, 'status success');

  browser.edit('## Review\n\nRevised question.');
  assert.equal(browser.element('status').textContent, 'Nicht veröffentlichte Änderungen');
  assert.equal(browser.element('status').className, 'status muted');
  assert.equal(browser.element('publish').disabled, false);
  browser.edit(draft.markdown);
  assert.equal(browser.element('status').textContent, 'Dieser Stand ist im PR.');
  assert.equal(browser.element('publish').disabled, true);
});

test('IME confirmation cannot publish and a failed publication preserves editable text for retry', () => {
  const browser = new PreviewBrowser();
  const body = browser.element('body');
  body.fire('compositionstart');
  browser.edit('Erklärung zum Review');
  body.fire('keydown', { metaKey: true, key: 'Enter', isComposing: true });
  assert.equal(browser.messages.some((message) => (message as { action: string }).action === 'publish'), false);
  body.fire('compositionend');
  body.fire('keydown', { metaKey: true, key: 'Enter' });
  assert.equal(browser.element('publish').disabled, true);
  browser.receive({ kind: 'error', message: 'Connection lost.' });
  browser.receive({ kind: 'idle' });
  assert.equal(body.value, 'Erklärung zum Review');
  assert.equal(body.readOnly, false);
  assert.equal(browser.element('publish').disabled, false);
  assert.equal(browser.element('status').textContent, 'Connection lost.');
});

test('restored preview text and previous publication cannot escape the inline script', () => {
  const text = '</script><script>throw new Error("injected")</script> & <edited>';
  const browser = new PreviewBrowser(previewHtml(draft, target, text, text));
  assert.equal(browser.element('body').value, text);
  assert.equal(browser.element('publish').disabled, true);
  browser.edit(`${text}\nNew local edit`);
  assert.equal(browser.element('publish').disabled, false);
});

test('closing and reopening an edited handoff restores its exact snapshot without publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-review-handoff-'));
  const store = await createReviewStore(join(root, 'review.json'), root);
  const anchor: CodeAnchor = { path: 'example.ts', startLine: 1, endLine: 1, selectedText: 'example();',
    contextBefore: '', contextAfter: '', documentHash: 'original', side: 'working', baseRevision: '' };
  const thread = await store.submit(anchor, 'Original question?', 'ask');
  let publishes = 0;
  mock.method(GitHubReviewClient, 'connect', async () => ({
    readTarget: async () => target,
    publish: async () => { publishes += 1; throw new Error('No real publication is allowed in this fixture.'); },
  } as unknown as GitHubReviewClient));
  const registered = registerPrExport(extensionContext(), store);
  cleanup.push(async () => { registered.dispose(); await store.flush(); await rm(root, { recursive: true, force: true }); });
  await commands.executeCommand('localReview.exportToPr');
  const firstPanel = window.panels.at(-1);
  assert.ok(firstPanel);
  firstPanel.receive({ action: 'openPr', url: 'https://example.invalid/wrong-target' });
  await settle();
  assert.equal(env.opened[0]?.toString(), target.pullRequest.url);
  const original = decodeHtml(/<textarea[^>]*>([\s\S]*?)<\/textarea>/u.exec(firstPanel.webview.html)?.[1] ?? '');
  const edited = `${original}\n\nMy additional review note.`;
  firstPanel.receive({ action: 'draft', body: edited });
  firstPanel.dispose();
  await store.submit(anchor, 'Later discussion is separate.', 'ask', thread.id);

  await commands.executeCommand('localReview.exportToPr');
  const restored = window.panels.at(-1);
  assert.ok(restored);
  assert.notEqual(restored, firstPanel);
  assert.equal(new PreviewBrowser(restored.webview.html).element('body').value, edited);
  assert.doesNotMatch(restored.webview.html, /Later discussion is separate/u);
  assert.equal(publishes, 0);
  assert.equal(store.threads[0]?.resolved, false);

  restored.receive({ action: 'publish', body: edited });
  await settle();
  assert.equal(publishes, 1);
  restored.dispose();
  await commands.executeCommand('localReview.exportToPr');
  const retry = window.panels.at(-1);
  assert.ok(retry);
  assert.equal(new PreviewBrowser(retry.webview.html).element('body').value, edited);

  retry.dispose();
  await store.submit(anchor, 'A separate new question?', 'ask');
  window.quickPickIndex = 1;
  await commands.executeCommand('localReview.exportToPr');
  const fresh = window.panels.at(-1);
  assert.ok(fresh);
  assert.match(fresh.webview.html, /A separate new question/u);
  assert.doesNotMatch(fresh.webview.html, /My additional review note/u);
  assert.equal(publishes, 1);
});
