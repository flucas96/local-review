import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { parseComposerInput } from './composerIntent.js';
import type { CodeAnchor, ReviewIntent } from './contracts.js';
import { maximumIdentifierLength, maximumPathLength, maximumReviewTextLength } from './limits.js';

/** Immutable context shown beside the code while a human writes feedback. */
export interface ComposerRequest {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly code: string;
  readonly text?: string;
  readonly intent: ReviewIntent;
  readonly threadId?: string;
  readonly anchor?: CodeAnchor;
}

/** Explicitly submitted feedback; typing alone never creates an agent event. */
export interface ComposerSubmission extends ComposerRequest {
  readonly text: string;
}

/** Controlled composer lifecycle, including recovery of locally saved drafts. */
export interface ReviewComposer extends vscode.Disposable {
  /** Announce an accepted target change or closure for persistent editor decoration. */
  readonly onDidChangeTarget: vscode.Event<ComposerRequest | undefined>;
  /** Report whether selection tracking has an existing composer to update. */
  isOpen(): boolean;
  open(request: ComposerRequest): Promise<void>;
  /** Offer selected code without opening a panel, taking focus, or moving typed text. */
  followSelection(request: ComposerRequest): Promise<void>;
  resume(): Promise<void>;
}

interface SavedDraft extends ComposerSubmission {
  readonly updatedAt: number;
}

const storageKey = 'localReview.composerDrafts.v1';

/** Accept persisted and webview data only after narrowing its actual shape. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Recognize only the three human-selectable feedback intents. */
function isIntent(value: unknown): value is ReviewIntent {
  return value === 'ask' || value === 'implement' || value === 'summarize';
}

/** Bound locally restored strings before they reach a composer or review request. */
function isText(value: unknown, maximum: number, required = false): value is string {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0') && (!required || value.trim().length > 0);
}

/** Validate captured metadata without reading or opening the captured path. */
function readAnchor(value: unknown): CodeAnchor | undefined {
  const candidate = record(value);
  if (candidate === undefined
    || !isText(candidate['path'], maximumPathLength, true)
    || path.posix.isAbsolute(candidate['path']) || path.win32.isAbsolute(candidate['path'])
    || candidate['path'].replaceAll('\\', '/').split('/').includes('..')
    || typeof candidate['startLine'] !== 'number' || !Number.isSafeInteger(candidate['startLine']) || candidate['startLine'] < 1
    || typeof candidate['endLine'] !== 'number' || !Number.isSafeInteger(candidate['endLine']) || candidate['endLine'] < candidate['startLine']
    || !isText(candidate['selectedText'], maximumReviewTextLength)
    || !isText(candidate['contextBefore'], maximumReviewTextLength)
    || !isText(candidate['contextAfter'], maximumReviewTextLength)
    || !isText(candidate['documentHash'], maximumIdentifierLength, true)
    || !isText(candidate['baseRevision'], maximumPathLength)
    || (candidate['side'] !== 'working' && candidate['side'] !== 'original')) {
    return undefined;
  }
  return {
    path: candidate['path'], startLine: candidate['startLine'], endLine: candidate['endLine'],
    selectedText: candidate['selectedText'], contextBefore: candidate['contextBefore'], contextAfter: candidate['contextAfter'],
    documentHash: candidate['documentHash'], side: candidate['side'], baseRevision: candidate['baseRevision'],
  };
}

/** Recover a complete draft only when its context and intent remain valid. */
function readDraft(value: unknown): SavedDraft | undefined {
  const candidate = record(value);
  if (candidate === undefined || !isText(candidate['id'], maximumIdentifierLength, true)
    || !isText(candidate['title'], 512, true) || !isText(candidate['path'], maximumPathLength, true)
    || !isText(candidate['code'], maximumReviewTextLength * 3)
    || !isText(candidate['text'], maximumReviewTextLength) || !isIntent(candidate['intent'])
    || typeof candidate['updatedAt'] !== 'number' || !Number.isFinite(candidate['updatedAt'])
    || (candidate['threadId'] !== undefined && !isText(candidate['threadId'], maximumIdentifierLength, true))) {
    return undefined;
  }
  const anchor = candidate['anchor'] === undefined ? undefined : readAnchor(candidate['anchor']);
  if (candidate['anchor'] !== undefined && (anchor === undefined || anchor.path !== candidate['path'])) {
    return undefined;
  }
  return {
    id: candidate['id'], title: candidate['title'], path: candidate['path'], code: candidate['code'],
    text: candidate['text'], intent: candidate['intent'], updatedAt: candidate['updatedAt'],
    ...(candidate['threadId'] === undefined ? {} : { threadId: candidate['threadId'] }),
    ...(anchor === undefined ? {} : { anchor }),
  };
}

/** Provide a theme-aware composer with immediate, reversible slash-mode previews. */
export function createComposer(
  context: vscode.ExtensionContext,
  onSubmit: (submission: ComposerSubmission) => Promise<void>,
): ReviewComposer {
  const persisted = record(context.workspaceState.get<unknown>(storageKey));
  const candidates: unknown[] = persisted?.['version'] === 1 && Array.isArray(persisted['drafts']) ? persisted['drafts'] : [];
  const drafts = new Map<string, SavedDraft>();
  for (const candidate of candidates) {
    const draft = readDraft(candidate);
    if (draft !== undefined) drafts.set(draft.id, draft);
  }
  let panel: vscode.WebviewPanel | undefined;
  let currentId: string | undefined;
  let ready = false;
  let disposed = false;
  let saving = Promise.resolve();
  const submitting = new Set<string>();
  const targetChanged = new vscode.EventEmitter<ComposerRequest | undefined>();
  let pendingSelection: ComposerRequest | undefined;

  /** Persist draft changes in order so delayed writes cannot resurrect sent text. */
  function persist(): Promise<void> {
    const snapshot = { version: 1, drafts: [...drafts.values()] };
    saving = saving.catch(() => undefined).then(async () => context.workspaceState.update(storageKey, snapshot));
    return saving;
  }

  /** Make a storage failure visible while keeping the current text in memory. */
  function reportStorageFailure(error: unknown): void {
    void vscode.window.showErrorMessage(`Der Review-Entwurf konnte nicht lokal gespeichert werden: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`);
    void panel?.webview.postMessage({ type: 'storageError' });
  }

  /** Send only display fields; the webview cannot replace captured anchor metadata. */
  function showDraft(focus = false): void {
    const draft = currentId === undefined ? undefined : drafts.get(currentId);
    if (ready && draft !== undefined) {
      void panel?.webview.postMessage({
        type: 'open', id: draft.id, title: draft.title,
        path: draft.anchor === undefined ? draft.path : `${draft.path}:${draft.anchor.startLine}${draft.anchor.endLine === draft.anchor.startLine ? '' : `–${draft.anchor.endLine}`}`,
        code: draft.anchor?.selectedText ?? draft.code,
        contextCode: draft.anchor === undefined ? '' : draft.code,
        text: draft.text, intent: draft.intent, existingThread: draft.threadId !== undefined,
        busy: submitting.has(draft.id), focus,
      });
    }
  }

  /** Offer a candidate without replacing text that is still inside the webview. */
  function showSelection(): void {
    if (ready && pendingSelection !== undefined) {
      void panel?.webview.postMessage({
        type: 'selection', selectionId: pendingSelection.id,
        path: pendingSelection.anchor === undefined ? pendingSelection.path
          : `${pendingSelection.path}:${pendingSelection.anchor.startLine}${pendingSelection.anchor.endLine === pendingSelection.anchor.startLine ? '' : `–${pendingSelection.anchor.endLine}`}`,
      });
    }
  }

  /** Atomically save the browser's current text before accepting a different target. */
  async function acceptSelection(message: Record<string, unknown>): Promise<void> {
    const request = pendingSelection;
    if (request === undefined || message['selectionId'] !== request.id || message['id'] !== currentId
      || !isText(message['text'], maximumReviewTextLength) || !isIntent(message['intent'])) return;
    const existing = currentId === undefined ? undefined : drafts.get(currentId);
    if (existing?.threadId !== undefined || (currentId !== undefined && submitting.has(currentId))) return;
    if (existing !== undefined) {
      const current = { ...existing, text: message['text'], intent: message['intent'], updatedAt: Date.now() };
      drafts.set(current.id, current);
      if (message['explicit'] !== true && current.text.trim().length > 0) {
        await persist();
        showSelection();
        return;
      }
      if (current.id !== request.id && current.text.trim().length === 0) drafts.delete(current.id);
    }
    const previous = drafts.get(request.id);
    const draft = readDraft({ ...request, text: previous?.text ?? '', intent: previous?.intent ?? message['intent'], updatedAt: Date.now() });
    if (draft === undefined) return;
    drafts.set(draft.id, draft);
    currentId = draft.id;
    pendingSelection = undefined;
    targetChanged.fire(draft);
    showDraft(message['explicit'] === true);
    await persist();
  }

  /** Process an explicit send only after saving the final immutable submission. */
  async function submit(draft: SavedDraft): Promise<void> {
    if (submitting.has(draft.id)) return;
    const parsed = parseComposerInput(draft.text, draft.intent, true);
    const text = parsed.text.trim();
    if (text.length === 0 && !(parsed.intent === 'summarize' && draft.threadId !== undefined)) {
      void panel?.webview.postMessage({ type: 'error', id: draft.id, text: 'Schreibe dein Feedback, bevor du es absendest.' });
      return;
    }
    submitting.add(draft.id);
    void panel?.webview.postMessage({ type: 'busy', id: draft.id, busy: true });
    try {
      await persist();
      await onSubmit({ ...draft, text, intent: parsed.intent });
      drafts.delete(draft.id);
      try {
        await persist();
      } catch (error: unknown) {
        reportStorageFailure(error);
      }
      if (currentId === draft.id) {
        void panel?.webview.postMessage({ type: 'submitted', id: draft.id });
        showSelection();
      }
    } catch (error: unknown) {
      void panel?.webview.postMessage({ type: 'error', id: draft.id, text: error instanceof Error ? error.message : 'Der Kommentar konnte nicht abgesendet werden.' });
    } finally {
      submitting.delete(draft.id);
      void panel?.webview.postMessage({ type: 'busy', id: draft.id, busy: false });
    }
  }

  /** Validate browser messages and retain context exclusively in the extension host. */
  async function receive(value: unknown): Promise<void> {
    const message = record(value);
    if (message?.['type'] === 'ready') {
      ready = true;
      showDraft(true);
      showSelection();
      return;
    }
    if (message === undefined || typeof message['id'] !== 'string') return;
    if (message['type'] === 'follow') {
      await acceptSelection(message);
      return;
    }
    const existing = drafts.get(message['id']);
    if (existing === undefined || submitting.has(existing.id)) return;
    if (message['type'] === 'discard') {
      drafts.delete(existing.id);
      try {
        await persist();
      } catch (error: unknown) {
        drafts.set(existing.id, existing);
        reportStorageFailure(error);
        void panel?.webview.postMessage({ type: 'error', id: existing.id, text: 'Der Entwurf konnte nicht verworfen werden. Dein Text bleibt geöffnet.' });
        return;
      }
      if (currentId === existing.id) panel?.dispose();
      return;
    }
    if (message['type'] !== 'change' && message['type'] !== 'submit') return;
    if (!isText(message['text'], maximumReviewTextLength) || !isIntent(message['intent'])) {
      void panel?.webview.postMessage({ type: 'error', id: existing.id, text: 'Das Feedback enthält ungültige Zeichen oder ist zu lang. Dein Entwurf bleibt geöffnet.' });
      return;
    }
    const draft: SavedDraft = { ...existing, text: message['text'], intent: message['intent'], updatedAt: Date.now() };
    drafts.set(draft.id, draft);
    if (message['type'] === 'submit') {
      await submit(draft);
    } else {
      await persist();
      void panel?.webview.postMessage({ type: 'saved', id: draft.id, revision: message['revision'] });
    }
  }

  /** Reuse one editor column while retaining independent drafts for each conversation. */
  async function open(request: ComposerRequest): Promise<void> {
    if (disposed) return;
    const previous = drafts.get(request.id);
    const draft = readDraft({ ...request, text: previous?.text ?? request.text ?? '', intent: previous?.intent ?? request.intent, updatedAt: Date.now() });
    if (draft === undefined) throw new Error('Der Review-Entwurf enthält keinen gültigen Codekontext. Wähle den Code erneut aus.');
    drafts.set(draft.id, draft);
    currentId = draft.id;
    pendingSelection = undefined;
    targetChanged.fire(draft);
    if (panel === undefined) {
      panel = vscode.window.createWebviewPanel('localReview.composer', 'Review-Kommentar', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
        enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [],
      });
      ready = false;
      const activePanel = panel;
      const messages = activePanel.webview.onDidReceiveMessage((value: unknown) => { void receive(value).catch(reportStorageFailure); });
      const closed = activePanel.onDidDispose(() => {
        messages.dispose();
        closed.dispose();
        if (panel === activePanel) {
          panel = undefined;
          ready = false;
          currentId = undefined;
          pendingSelection = undefined;
          targetChanged.fire(undefined);
        }
      });
      activePanel.webview.html = composerHtml();
    } else {
      panel.reveal(panel.viewColumn, false);
    }
    showDraft(true);
    await persist();
  }

  return {
    onDidChangeTarget: targetChanged.event,
    isOpen: () => panel !== undefined,
    open,
    async followSelection(request: ComposerRequest): Promise<void> {
      if (disposed || panel === undefined || request.threadId !== undefined) return;
      const current = currentId === undefined ? undefined : drafts.get(currentId);
      if (current?.threadId !== undefined) return;
      if (current?.id === request.id) {
        pendingSelection = undefined;
        void panel.webview.postMessage({ type: 'clearSelection' });
        return;
      }
      if (readDraft({ ...request, text: '', updatedAt: Date.now() }) === undefined) return;
      pendingSelection = request;
      showSelection();
    },
    async resume(): Promise<void> {
      const latest = [...drafts.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (latest === undefined) {
        void vscode.window.showInformationMessage('Es gibt keinen ungesendeten Review-Entwurf.');
        return;
      }
      await open(latest);
    },
    dispose(): void {
      disposed = true;
      panel?.dispose();
      targetChanged.dispose();
    },
  };
}

/** Render a self-contained, network-free webview; user text is inserted as text only. */
function composerHtml(): string {
  const nonce = randomBytes(24).toString('base64');
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Review-Kommentar</title><style nonce="${nonce}">
* { box-sizing: border-box; } body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.4 var(--vscode-font-family); }
main { max-width: 680px; margin: auto; } .topbar { display: flex; align-items: center; gap: 8px; min-height: 22px; margin-bottom: 9px; } .eyebrow { color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; white-space: nowrap; } #path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; margin: 0; font-size: 12px; } #targetState { color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent)); border-radius: 10px; padding: 1px 6px; font-size: 10px; white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
details { border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent)); border-radius: 5px; padding: 5px 8px; margin: 0 0 8px; } summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px; } pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 84px; overflow: auto; margin: 6px 0 2px; font: 12px/1.4 var(--vscode-editor-font-family); } #context { margin: 6px 0 0; padding: 4px 6px; border-style: dashed; }
.selection { border-left: 2px solid var(--vscode-focusBorder); padding: 6px 8px; margin: 0 0 8px; background: var(--vscode-textBlockQuote-background); font-size: 11px; } .selection p { margin: 0 0 4px; } .selection button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); } .selection[hidden], details[hidden] { display: none; }
.modes { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; margin: 0 0 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent)); border-radius: 6px; background: var(--vscode-editorWidget-background); } button { font: inherit; font-size: 11px; cursor: pointer; border: 1px solid transparent; border-radius: 4px; padding: 4px 8px; min-height: 26px; } button:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.mode { color: var(--vscode-descriptionForeground); background: transparent; min-height: 26px; } .mode:hover { color: var(--vscode-foreground); background: var(--vscode-button-secondaryHoverBackground); } .mode[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-contrastActiveBorder, transparent); } kbd { opacity: .65; font: inherit; margin-left: 4px; }
textarea { display: block; width: 100%; min-height: 90px; max-height: 180px; field-sizing: content; resize: vertical; border-radius: 6px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 8px 10px; font: inherit; line-height: 1.45; }
textarea:disabled { opacity: .7; } .footer { display: flex; gap: 8px; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-top: 7px; } .actions { display: flex; align-items: center; gap: 6px; } .muted { color: var(--vscode-descriptionForeground); font-size: 11px; } #send { color: var(--vscode-button-foreground); background: var(--vscode-button-background); min-height: 28px; padding: 4px 10px; } #send:hover { background: var(--vscode-button-hoverBackground); } button:disabled { cursor: default; opacity: .5; } #discard { color: var(--vscode-descriptionForeground); background: transparent; padding: 3px 5px; } #discard:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); } #error { color: var(--vscode-errorForeground); margin: 7px 0 0; font-size: 12px; } #error:empty { display: none; } #shortcut { white-space: nowrap; }
@media (max-width: 380px) { .eyebrow { display: none; } .topbar { gap: 5px; } .footer { gap: 4px; } .actions { gap: 3px; } kbd { display: none; } }
</style></head><body><main>
<div class="topbar"><span class="eyebrow">LOCAL REVIEW</span><p id="path"></p><span id="targetState" role="status">Auswahl folgt</span></div><h1 id="title" class="sr-only">Review-Kommentar</h1>
<aside id="selection" class="selection" hidden aria-live="polite"><p><strong>Neue Auswahl:</strong> <span id="selectionPath"></span></p><p class="muted">Dein aktueller Entwurf bleibt an seinem Code. Du kannst ihn später fortsetzen.</p><button type="button" id="takeSelection">Neue Auswahl kommentieren</button></aside>
<details><summary>Ausgewählten Code ansehen</summary><pre id="code"></pre>
<details id="context" hidden><summary>Umgebender Kontext · gespeichert</summary><pre id="contextCode"></pre></details>
</details><div class="modes" role="group" aria-label="Review-Modus">
<button type="button" class="mode" data-mode="ask" aria-pressed="true">Fragen <kbd>/a</kbd></button>
<button type="button" class="mode" data-mode="implement" aria-pressed="false">Umsetzen <kbd>/i</kbd></button>
<button type="button" class="mode" data-mode="summarize" aria-pressed="false">Zusammenfassen <kbd>/r</kbd></button></div>
<p id="modeHint" class="sr-only" role="status" aria-live="polite"></p><label for="feedback" class="sr-only">Dein Feedback</label>
<textarea id="feedback" maxlength="${maximumReviewTextLength}" placeholder="Feedback schreiben … /a fragen · /i umsetzen · /r zusammenfassen" aria-describedby="modeHint error deliveryHint" spellcheck="true"></textarea>
<div class="footer"><span id="saved" class="muted" role="status">Entwurf bleibt lokal</span><div class="actions"><span id="shortcut" class="muted"></span><button type="button" id="discard" title="Entwurf verwerfen">Verwerfen</button><button id="send" type="button">Frage senden</button></div></div>
<p id="error" role="alert"></p>
<p id="deliveryHint" class="sr-only">Markiere weiteren Code, um hier neues Feedback zu schreiben. Sobald du schreibst, bleibt der Entwurf an seiner Auswahl. Erst beim Senden geht dein Feedback an Claude. Beim Schließen bleibt dein Entwurf lokal gespeichert.</p>
</main><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const parseInput = ${parseComposerInput.toString()};
const input = document.getElementById('feedback');
const send = document.getElementById('send');
const error = document.getElementById('error');
const saved = document.getElementById('saved');
const buttons = [...document.querySelectorAll('[data-mode]')];
const labels = { ask: 'Frage senden', implement: 'Änderung anfordern', summarize: 'Zusammenfassung anfordern' };
const hints = { ask: 'Fragen · Claude erklärt und antwortet in dieser Unterhaltung.', implement: 'Umsetzen · Claude darf die angefragte Änderung am Code umsetzen.', summarize: 'Zusammenfassen · Claude fasst die Unterhaltung und offene Punkte zusammen.' };
let active;
let selectedIntent = 'ask';
let busy = false;
let discarding = false;
let revision = 0;
let sent = false;
let pendingSelection;
let changingSelection = false;
function paint() {
  const effective = parseInput(input.value, selectedIntent);
  for (const button of buttons) { button.setAttribute('aria-pressed', String(button.dataset.mode === effective.intent)); button.disabled = busy || sent || changingSelection; }
  document.getElementById('modeHint').textContent = hints[effective.intent];
  document.getElementById('targetState').textContent = sent ? 'Gesendet' : active && active.existingThread ? 'Antwort fixiert' : input.value.trim() ? 'Entwurf fixiert' : 'Auswahl folgt';
  const finalized = parseInput(input.value, selectedIntent, true);
  send.textContent = busy ? (discarding ? 'Wird verworfen …' : 'Wird gesendet …') : labels[effective.intent];
  send.disabled = busy || sent || changingSelection || !active || (!finalized.text.trim() && !(finalized.intent === 'summarize' && active.existingThread));
  input.disabled = busy || sent || changingSelection || !active;
  document.getElementById('discard').disabled = busy || sent || changingSelection || !active;
  document.getElementById('selection').hidden = !pendingSelection;
  document.getElementById('takeSelection').disabled = busy || changingSelection;
}
function changed() {
  if (!active || busy || sent || changingSelection) return;
  revision += 1;
  saved.textContent = 'Wird lokal gespeichert …';
  error.textContent = '';
  vscode.setState({ id: active.id, text: input.value, intent: selectedIntent });
  vscode.postMessage({ type: 'change', id: active.id, text: input.value, intent: selectedIntent, revision });
  paint();
  if (!input.value.trim()) considerSelection();
}
function takeSelection(explicit) {
  if (!pendingSelection || !active || busy || changingSelection) return;
  changingSelection = true;
  paint();
  vscode.postMessage({ type: 'follow', id: active.id, selectionId: pendingSelection.selectionId,
    text: sent ? '' : input.value, intent: parseInput(input.value, selectedIntent).intent, explicit });
}
function considerSelection() {
  if (pendingSelection && !busy && (sent || !input.value.trim())) takeSelection(false);
}
document.getElementById('takeSelection').addEventListener('click', () => takeSelection(true));
input.addEventListener('input', () => {
  const result = parseInput(input.value, selectedIntent);
  if (result.removedCharacters) {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = result.text;
    input.setSelectionRange(Math.max(0, start - result.removedCharacters), Math.max(0, end - result.removedCharacters));
    selectedIntent = result.selectedIntent;
  }
  changed();
});
for (const button of buttons) button.addEventListener('click', () => {
  if (busy) return;
  const result = parseInput(input.value, selectedIntent, true);
  const start = input.selectionStart;
  const end = input.selectionEnd;
  input.value = result.text;
  selectedIntent = button.dataset.mode;
  input.focus();
  input.setSelectionRange(Math.max(0, start - result.removedCharacters), Math.max(0, end - result.removedCharacters));
  changed();
});
function submit() {
  if (!active || send.disabled || busy) return;
  busy = true;
  paint();
  vscode.postMessage({ type: 'submit', id: active.id, text: input.value, intent: selectedIntent });
}
send.addEventListener('click', submit);
input.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit(); } });
document.getElementById('discard').addEventListener('click', () => { if (active && !busy) { busy = true; discarding = true; paint(); vscode.setState(undefined); vscode.postMessage({ type: 'discard', id: active.id }); } });
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'open') {
    active = message;
    selectedIntent = message.intent;
    input.value = message.text;
    busy = message.busy;
    sent = false;
    changingSelection = false;
    pendingSelection = undefined;
    discarding = false;
    document.getElementById('title').textContent = message.title;
    document.getElementById('path').textContent = message.path;
    document.getElementById('path').setAttribute('title', message.path);
    document.getElementById('code').textContent = message.code;
    document.getElementById('contextCode').textContent = message.contextCode;
    document.getElementById('context').hidden = !message.contextCode || message.contextCode === message.code;
    saved.textContent = 'Entwurf bleibt lokal';
    error.textContent = '';
    paint();
    if (message.focus) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  } else if (message.type === 'selection') {
    pendingSelection = message;
    changingSelection = false;
    document.getElementById('selectionPath').textContent = message.path;
    paint();
    considerSelection();
  } else if (message.type === 'clearSelection') {
    pendingSelection = undefined;
    changingSelection = false;
    paint();
  } else if (message.type === 'storageError') {
    saved.textContent = 'Speichern fehlgeschlagen · Fenster offen lassen';
  } else if (active && message.id === active.id) {
    if (message.type === 'saved' && message.revision === revision) saved.textContent = 'Entwurf lokal gespeichert';
    if (message.type === 'busy') { busy = message.busy; paint(); considerSelection(); }
    if (message.type === 'error') { busy = false; discarding = false; error.textContent = message.text; paint(); input.focus(); }
    if (message.type === 'submitted') {
      sent = true;
      busy = false;
      input.value = '';
      saved.textContent = 'Gesendet · Neue Auswahl markieren';
      document.getElementById('title').textContent = 'Feedback gesendet';
      vscode.setState(undefined);
      paint();
      considerSelection();
    }
  }
});
document.getElementById('shortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ ↵' : 'Strg ↵';
document.getElementById('shortcut').setAttribute('title', 'Senden · /a fragen · /i umsetzen · /r zusammenfassen');
paint();
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
