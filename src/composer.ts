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
  open(request: ComposerRequest): Promise<void>;
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
  function showDraft(): void {
    const draft = currentId === undefined ? undefined : drafts.get(currentId);
    if (ready && draft !== undefined) {
      void panel?.webview.postMessage({
        type: 'open', id: draft.id, title: draft.title,
        path: draft.anchor === undefined ? draft.path : `${draft.path}:${draft.anchor.startLine}${draft.anchor.endLine === draft.anchor.startLine ? '' : `–${draft.anchor.endLine}`}`,
        code: draft.code,
        text: draft.text, intent: draft.intent, existingThread: draft.threadId !== undefined,
        busy: submitting.has(draft.id),
      });
    }
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
        panel?.dispose();
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
      showDraft();
      return;
    }
    if (message === undefined || typeof message['id'] !== 'string') return;
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
        }
      });
      activePanel.webview.html = composerHtml();
    } else {
      panel.reveal(panel.viewColumn, false);
    }
    showDraft();
    await persist();
  }

  return {
    open,
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
* { box-sizing: border-box; } body { margin: 0; padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); }
main { max-width: 760px; margin: auto; } .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
h1 { font-size: 20px; font-weight: 600; line-height: 1.3; margin: 6px 0 4px; } #path { overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); margin: 0 0 18px; }
details { border: 1px solid var(--vscode-widget-border, var(--vscode-input-border, transparent)); border-radius: 6px; padding: 10px 12px; margin-bottom: 22px; } summary { cursor: pointer; } pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; margin-bottom: 0; font: var(--vscode-editor-font-size)/1.5 var(--vscode-editor-font-family); }
.modes { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; } button { font: inherit; cursor: pointer; border: 1px solid transparent; border-radius: 4px; padding: 7px 12px; } button:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.mode { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); } .mode:hover { background: var(--vscode-button-secondaryHoverBackground); } .mode[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); } kbd { opacity: .75; font: inherit; margin-left: 5px; }
#modeHint { min-height: 42px; color: var(--vscode-descriptionForeground); margin: 8px 0 12px; } label { display: block; font-weight: 600; } textarea { width: 100%; min-height: 190px; resize: vertical; border-radius: 5px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 12px; font: inherit; line-height: 1.6; }
textarea:disabled { opacity: .7; } .footer { display: flex; gap: 12px; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-top: 10px; } .muted { color: var(--vscode-descriptionForeground); font-size: 12px; } #send { color: var(--vscode-button-foreground); background: var(--vscode-button-background); min-width: 132px; } #send:hover { background: var(--vscode-button-hoverBackground); } button:disabled { cursor: default; opacity: .5; } #discard { color: var(--vscode-descriptionForeground); background: transparent; padding-left: 0; } #discard:hover { color: var(--vscode-foreground); text-decoration: underline; } #error { color: var(--vscode-errorForeground); min-height: 24px; margin: 10px 0; } .help { border-top: 1px solid var(--vscode-widget-border, transparent); padding-top: 16px; margin-top: 22px; }
</style></head><body><main>
<div class="eyebrow">Local Review</div><h1 id="title">Review-Kommentar</h1><p id="path"></p>
<details open><summary>Ausgewählter Code · gespeicherter Kontext</summary><pre id="code"></pre></details>
<label>Was soll Claude tun?</label><div class="modes" role="group" aria-label="Review-Modus">
<button type="button" class="mode" data-mode="ask" aria-pressed="true">Fragen <kbd>/a</kbd></button>
<button type="button" class="mode" data-mode="implement" aria-pressed="false">Umsetzen <kbd>/i</kbd></button>
<button type="button" class="mode" data-mode="summarize" aria-pressed="false">Zusammenfassen <kbd>/r</kbd></button></div>
<p id="modeHint" role="status" aria-live="polite"></p><label for="feedback">Dein Feedback</label>
<textarea id="feedback" maxlength="${maximumReviewTextLength}" placeholder="Schreibe dein Feedback oder wechsle mit /a, /i oder /r den Modus." aria-describedby="modeHint error deliveryHint" spellcheck="true"></textarea>
<div class="footer"><span id="saved" class="muted" role="status">Entwurf bleibt lokal</span><button id="send" type="button">Frage senden</button></div>
<p class="muted" id="shortcut"></p><p id="error" role="alert"></p><button type="button" id="discard">Entwurf verwerfen</button>
<p id="deliveryHint" class="muted help">Erst beim Senden geht dein Feedback an Claude. Beim Schließen bleibt dein Entwurf lokal gespeichert.</p>
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
function paint() {
  const effective = parseInput(input.value, selectedIntent);
  for (const button of buttons) { button.setAttribute('aria-pressed', String(button.dataset.mode === effective.intent)); button.disabled = busy; }
  document.getElementById('modeHint').textContent = hints[effective.intent];
  const finalized = parseInput(input.value, selectedIntent, true);
  send.textContent = busy ? (discarding ? 'Wird verworfen …' : 'Wird gesendet …') : labels[effective.intent];
  send.disabled = busy || !active || (!finalized.text.trim() && !(finalized.intent === 'summarize' && active.existingThread));
  input.disabled = busy;
  document.getElementById('discard').disabled = busy;
}
function changed() {
  if (!active || busy) return;
  revision += 1;
  saved.textContent = 'Wird lokal gespeichert …';
  error.textContent = '';
  vscode.setState({ id: active.id, text: input.value, intent: selectedIntent });
  vscode.postMessage({ type: 'change', id: active.id, text: input.value, intent: selectedIntent, revision });
  paint();
}
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
    discarding = false;
    document.getElementById('title').textContent = message.title;
    document.getElementById('path').textContent = message.path;
    document.getElementById('code').textContent = message.code;
    saved.textContent = 'Entwurf bleibt lokal';
    error.textContent = '';
    paint();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (message.type === 'storageError') {
    saved.textContent = 'Speichern fehlgeschlagen · Fenster offen lassen';
  } else if (active && message.id === active.id) {
    if (message.type === 'saved' && message.revision === revision) saved.textContent = 'Entwurf lokal gespeichert';
    if (message.type === 'busy') { busy = message.busy; paint(); }
    if (message.type === 'error') { busy = false; discarding = false; error.textContent = message.text; paint(); input.focus(); }
    if (message.type === 'submitted') vscode.setState(undefined);
  }
});
document.getElementById('shortcut').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ Enter zum Senden · /a fragen · /i umsetzen · /r zusammenfassen' : 'Strg + Enter zum Senden · /a fragen · /i umsetzen · /r zusammenfassen';
paint();
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
