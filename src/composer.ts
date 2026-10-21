import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { parseComposerInput } from './composerIntent.js';
import type { CodeAnchor, ReviewIntent } from './contracts.js';
import { maximumIdentifierLength, maximumPathLength, maximumReviewTextLength } from './limits.js';
import { webviewFontStyles } from './webviewStyles.js';

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
  onOpenCode?: (request: ComposerRequest) => Promise<void>,
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
        canOpenCode: onOpenCode !== undefined && draft.anchor !== undefined,
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
    if (message['type'] === 'openCode') {
      if (existing === undefined || existing.id !== currentId || existing.anchor === undefined || onOpenCode === undefined) return;
      try {
        await onOpenCode(existing);
      } catch (error: unknown) {
        void panel?.webview.postMessage({
          type: 'codeError', id: existing.id,
          text: error instanceof Error ? error.message : 'Der Code konnte nicht im Editor geöffnet werden.',
        });
      }
      return;
    }
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
${webviewFontStyles}
:root { --review-line: var(--vscode-widget-border, var(--vscode-panel-border, #80808045)); --review-accent: var(--vscode-localReview-selectionBorder, var(--vscode-focusBorder)); --review-tint: var(--vscode-localReview-selectionBackground, var(--vscode-textBlockQuote-background)); --review-surface: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
* { box-sizing: border-box; } body { margin: 0; padding: 16px 14px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.5 var(--review-font-ui); }
main { max-width: 620px; margin: auto; } .topbar { display: flex; align-items: center; gap: 9px; min-height: 32px; margin-bottom: 13px; } .brand { width: 28px; height: 28px; display: grid; place-items: center; flex-shrink: 0; border: 1px solid var(--review-accent); border-radius: 9px; background: var(--review-tint); } .brand svg { width: 16px; height: 16px; } .target { flex: 1; min-width: 0; } .eyebrow { margin: 0 0 1px; color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 500; } #path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0; font-size: 12px; font-weight: 600; } #targetState { display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); border: 1px solid var(--review-line); border-radius: 20px; padding: 2px 7px; font-size: 10px; white-space: nowrap; } #targetState::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--review-accent); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.code-context { display: flex; align-items: flex-start; gap: 6px; margin-bottom: 10px; } .code-context > details { flex: 1; min-width: 0; margin: 0; } details { border: 1px solid var(--review-line); border-radius: 8px; padding: 7px 10px; margin: 0 0 10px; background: var(--review-surface); } summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px; } .code-mark { margin: 0 5px 0 2px; color: var(--vscode-foreground); font: 11px var(--review-font-code); } pre { white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; max-height: 84px; overflow: auto; margin: 8px 0 1px; padding: 8px 9px; border: 1px solid var(--review-line); border-radius: 5px; background: var(--vscode-editor-background); font: 12px/1.55 var(--review-font-code); } #context { margin: 8px 0 0; padding: 5px 7px; background: transparent; } #openCode { flex-shrink: 0; white-space: nowrap; margin: 2px 0; color: var(--vscode-textLink-foreground); background: transparent; } #openCode:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); } #openCode[hidden] { display: none; }
.selection { border: 1px solid var(--review-accent); border-radius: 8px; padding: 8px 10px; margin: 0 0 10px; background: var(--review-tint); font-size: 11px; } .selection p { margin: 0 0 5px; } .selection button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); } .selection[hidden], details[hidden] { display: none; }
.compose-card { border: 1px solid var(--review-line); border-radius: 11px; background: var(--review-surface); box-shadow: 0 3px 12px #00000012; overflow: hidden; } .compose-card:focus-within { border-color: var(--vscode-focusBorder); } .compose-toolbar { padding: 7px 8px 0; } .modes { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 7px; background: var(--vscode-editor-background); } button { font: inherit; font-size: 11px; cursor: pointer; border: 1px solid transparent; border-radius: 6px; padding: 4px 8px; min-height: 26px; } button:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
.mode { color: var(--vscode-descriptionForeground); background: transparent; min-height: 26px; } .mode:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); } .mode[aria-pressed="true"] { color: var(--vscode-foreground); background: var(--review-tint); border-color: var(--review-accent); font-weight: 600; } kbd { color: var(--vscode-descriptionForeground); font: 10px var(--review-font-code); margin-left: 5px; }
textarea { display: block; width: calc(100% - 16px); min-height: 90px; max-height: 180px; field-sizing: content; resize: vertical; border-radius: 5px; border: 1px solid transparent; color: var(--vscode-foreground); background: transparent; margin: 7px 8px 0; padding: 7px 5px; font: inherit; line-height: 1.6; } textarea::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); } textarea:disabled { opacity: .7; }
.footer { display: flex; gap: 8px; flex-wrap: wrap; justify-content: space-between; align-items: center; border-top: 1px solid var(--review-line); padding: 7px 9px; margin-top: 5px; } .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 6px; max-width: 100%; margin-left: auto; } .muted { color: var(--vscode-descriptionForeground); font-size: 10px; } #saved { flex: 1 1 100px; } #send { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-contrastActiveBorder, transparent); border-radius: 6px; min-height: 28px; padding: 4px 10px; font-weight: 600; } #send::after { content: ''; width: 6px; height: 6px; border-top: 1.5px solid currentColor; border-right: 1.5px solid currentColor; transform: rotate(45deg); margin: 0 2px 0 0; } #send:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); } button:disabled { cursor: default; opacity: .5; } #discard { color: var(--vscode-descriptionForeground); background: transparent; padding: 3px 5px; } #discard:hover:not(:disabled) { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); } #error { color: var(--vscode-errorForeground); margin: 8px 2px 0; font-size: 12px; } #error:empty { display: none; } #shortcut { white-space: nowrap; font: 10px var(--review-font-code); padding: 1px 4px; border: 1px solid var(--review-line); border-radius: 4px; }
.vscode-high-contrast .compose-card, .vscode-high-contrast-light .compose-card, .vscode-high-contrast details, .vscode-high-contrast-light details { border-color: var(--vscode-contrastBorder); box-shadow: none; } .vscode-high-contrast .mode[aria-pressed="true"], .vscode-high-contrast-light .mode[aria-pressed="true"] { border-color: var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); } .vscode-high-contrast textarea, .vscode-high-contrast-light textarea { border-color: var(--vscode-input-border, var(--vscode-contrastBorder)); }
@media (max-width: 380px) { body { padding: 12px 10px; } .topbar { gap: 7px; } .brand { width: 25px; height: 25px; } .footer { gap: 6px; } .actions { gap: 4px; } kbd { display: none; } #targetState { font-size: 9px; padding: 2px 5px; } }
</style></head><body><main>
<header class="topbar"><span class="brand" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l-3 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7z"/><path d="M10 8l-2 2 2 2m4-4l2 2-2 2"/></svg></span><div class="target"><p class="eyebrow">Local Review</p><p id="path"></p></div><span id="targetState" role="status">Auswahl folgt</span></header><h1 id="title" class="sr-only">Review-Kommentar</h1>
<aside id="selection" class="selection" hidden aria-live="polite"><p><strong>Neue Auswahl:</strong> <span id="selectionPath"></span></p><p class="muted">Aktueller Entwurf bleibt gespeichert.</p><button type="button" id="takeSelection">Neue Auswahl kommentieren</button></aside>
<div class="code-context"><details><summary><span class="code-mark" aria-hidden="true">&lt;/&gt;</span>Ausgewählten Code ansehen</summary><pre id="code"></pre>
<details id="context" hidden><summary>Umgebender Kontext · gespeichert</summary><pre id="contextCode"></pre></details>
</details><button type="button" id="openCode" hidden title="Ausgewählten Code im Editor öffnen" aria-label="Ausgewählten Code im Editor öffnen"><svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5H5v14h14v-8M13 3h8v8m0-8L10 14"/></svg></button></div><section class="compose-card" aria-label="Feedback an Claude"><div class="compose-toolbar"><div class="modes" role="group" aria-label="Review-Modus">
<button type="button" class="mode" data-mode="ask" aria-pressed="true">Fragen <kbd>/a</kbd></button>
<button type="button" class="mode" data-mode="implement" aria-pressed="false">Umsetzen <kbd>/i</kbd></button>
<button type="button" class="mode" data-mode="summarize" aria-pressed="false">Zusammenfassen <kbd>/r</kbd></button></div></div>
<p id="modeHint" class="sr-only" role="status" aria-live="polite"></p><label for="feedback" class="sr-only">Dein Feedback</label>
<textarea id="feedback" maxlength="${maximumReviewTextLength}" placeholder="Was möchtest du Claude mitgeben?" aria-describedby="modeHint error deliveryHint" spellcheck="true"></textarea>
<div class="footer"><span id="saved" class="muted" role="status">Entwurf bleibt lokal</span><div class="actions"><span id="shortcut" class="muted"></span><button type="button" id="discard" title="Entwurf verwerfen">Verwerfen</button><button id="send" type="button">Frage senden</button></div></div>
</section><p id="error" role="alert"></p>
<p id="deliveryHint" class="sr-only">Markiere weiteren Code, um hier neues Feedback zu schreiben. Sobald du schreibst, bleibt der Entwurf an seiner Auswahl. Erst beim Senden geht dein Feedback an Claude. Beim Schließen bleibt dein Entwurf lokal gespeichert.</p>
</main><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const parseInput = ${parseComposerInput.toString()};
const input = document.getElementById('feedback');
const send = document.getElementById('send');
const openCode = document.getElementById('openCode');
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
  openCode.hidden = !active || !active.canOpenCode;
  openCode.disabled = !active || !active.canOpenCode || changingSelection;
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
openCode.addEventListener('click', () => {
  if (!active || openCode.disabled) return;
  error.textContent = '';
  vscode.postMessage({ type: 'openCode', id: active.id });
});
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
    if (message.type === 'codeError') { error.textContent = message.text; }
    if (message.type === 'submitted') {
      sent = true;
      busy = false;
      active.canOpenCode = false;
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
