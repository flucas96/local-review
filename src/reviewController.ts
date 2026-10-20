import * as path from 'node:path';
import * as vscode from 'vscode';

import { capturedCodeContext, hashDocumentText, locateCodeAnchor, type AnchorLocation } from './anchors.js';
import type { CodeAnchor, ReviewIntent, ReviewMessage, ReviewStore, ReviewThread } from './contracts';
import { getHeadRevision, isWorkspaceRelativePath, listChangedFiles, readGitBase } from './git';

const controllerId = 'localReview';
const baseScheme = 'local-review-base';
const contextScheme = 'local-review-context';
const intentLabels: Record<ReviewIntent, string> = {
  ask: 'Fragen',
  implement: 'Umsetzen',
  summarize: 'Zusammenfassen',
};
const statusLabels: Record<ReviewThread['status'], string> = {
  queued: 'Wartet auf Claude',
  received: 'Empfangen',
  working: 'In Bearbeitung',
  answered: 'Antwort erhalten',
  ready: 'Bereit zur Prüfung',
};

interface BaseReference {
  readonly relativePath: string;
  readonly revision: string;
  readonly emptyWorking: boolean;
}

interface ThreadBinding {
  readonly native: vscode.CommentThread;
  startOffset: number;
  endOffset: number;
  documentVersion: number;
  currentHash: string;
}

interface LocatedDocument {
  readonly document: vscode.TextDocument;
  readonly range: vscode.Range;
  readonly captured: boolean;
}

/** Hash the full document so restored comments never silently change versions. */
function documentHash(document: vscode.TextDocument): string {
  return hashDocumentText(document.getText());
}

/** Convert a confirmed line location into the native editor's full-line range. */
function locationRange(document: vscode.TextDocument, location: AnchorLocation): vscode.Range {
  return document.validateRange(new vscode.Range(location.startLine - 1, 0, location.endLine - 1, Number.MAX_SAFE_INTEGER));
}

/** Identify the saved excerpt separately from both the Git base and mutable working code. */
function contextUri(thread: ReviewThread): vscode.Uri {
  return vscode.Uri.from({
    scheme: contextScheme,
    path: `/${thread.anchor.path}`,
    query: new URLSearchParams({ thread: thread.id }).toString(),
  });
}

/** Read and validate the metadata of a review-owned virtual document. */
function baseReference(uri: vscode.Uri): BaseReference | undefined {
  if (uri.scheme !== baseScheme) {
    return undefined;
  }
  const query = new URLSearchParams(uri.query);
  const relativePath = query.get('path');
  const revision = query.get('revision');
  if (relativePath === null || !isWorkspaceRelativePath(relativePath)
    || revision === null || !(revision === 'unborn' || /^[a-f\d]{40,64}$/u.test(revision))) {
    return undefined;
  }
  return { relativePath, revision, emptyWorking: query.get('emptyWorking') === 'true' };
}

/** Build an immutable original document, or an empty side for a deleted file. */
function baseUri(relativePath: string, revision: string, emptyWorking = false): vscode.Uri {
  return vscode.Uri.from({
    scheme: baseScheme,
    path: `/${relativePath}`,
    query: new URLSearchParams({ path: relativePath, revision, emptyWorking: String(emptyWorking) }).toString(),
  });
}

/** Limit comments to local files and snapshots belonging to this workspace. */
function workspacePath(uri: vscode.Uri, workspaceRoot: string): string | undefined {
  if (uri.scheme === baseScheme) {
    return baseReference(uri)?.relativePath;
  }
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const relativePath = path.relative(workspaceRoot, uri.fsPath);
  return isWorkspaceRelativePath(relativePath) ? relativePath.split(path.sep).join('/') : undefined;
}

/** Keep a full line selection so gutter comments retain useful code context. */
function lineRange(document: vscode.TextDocument, range: vscode.Range): vscode.Range {
  const valid = document.validateRange(range);
  const lastLine = valid.end.character === 0 && valid.end.line > valid.start.line
    ? valid.end.line - 1
    : valid.end.line;
  return new vscode.Range(valid.start.line, 0, lastLine, document.lineAt(lastLine).text.length);
}

/** Preserve supported slash shortcuts without leaking them into the feedback text. */
function parseIntent(text: string, fallback: ReviewIntent): { readonly text: string; readonly intent: ReviewIntent } {
  const trimmed = text.trim();
  const match = /^\/(a|i|r)(?:\s+|$)/u.exec(trimmed);
  const shortcuts: Record<string, ReviewIntent> = { a: 'ask', i: 'implement', r: 'summarize' };
  const shortcut = match?.[1];
  return {
    text: match === null ? trimmed : trimmed.slice(match[0].length).trim(),
    intent: shortcut === undefined ? fallback : shortcuts[shortcut] ?? fallback,
  };
}

/** Render untrusted review text without allowing executable Markdown links. */
function nativeComment(message: ReviewMessage): vscode.Comment {
  return {
    body: new vscode.MarkdownString(message.text),
    author: { name: message.author === 'human' ? 'Du' : 'Claude' },
    mode: vscode.CommentMode.Preview,
    timestamp: new Date(message.createdAt),
  };
}

/** Map an existing boundary through an edit while preserving surrounding selections. */
function mapOffset(offset: number, change: vscode.TextDocumentContentChangeEvent, endBoundary: boolean): number {
  const changeEnd = change.rangeOffset + change.rangeLength;
  if (offset < change.rangeOffset) {
    return offset;
  }
  if (offset > changeEnd) {
    return offset + change.text.length - change.rangeLength;
  }
  return change.rangeOffset + (endBoundary ? change.text.length : 0);
}

/** Compact native sidebar entry linked to its original review conversation. */
class ReviewItem extends vscode.TreeItem {
  readonly threadId: string;

  constructor(thread: ReviewThread) {
    const firstMessage = thread.messages[0]?.text.replaceAll(/\s+/gu, ' ') ?? 'Review-Kommentar';
    super(`${intentLabels[thread.intent]} · ${firstMessage.slice(0, 90)}`, vscode.TreeItemCollapsibleState.None);
    this.threadId = thread.id;
    this.id = thread.id;
    this.description = thread.resolved ? 'Erledigt' : `${statusLabels[thread.status]}${thread.outdated ? ' · Kontext geändert' : ''}`;
    this.contextValue = thread.resolved ? 'localReview.resolved' : 'localReview.open';
    this.iconPath = new vscode.ThemeIcon(thread.resolved ? 'pass' : thread.outdated ? 'warning' : thread.status === 'working' ? 'sync~spin' : 'comment-discussion');
    this.command = { command: 'localReview.revealThread', title: 'Zum Kommentar springen', arguments: [thread.id] };
    this.tooltip = new vscode.MarkdownString()
      .appendText(`${thread.anchor.path}:${thread.anchor.startLine}\n${this.description}\n\n${firstMessage}`);
  }
}

/** Expose durable review conversations through VS Code's native tree view. */
class ReviewTree implements vscode.TreeDataProvider<ReviewItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<ReviewItem | undefined>();
  readonly onDidChangeTreeData = this.changes.event;

  constructor(private readonly store: ReviewStore) {}

  /** Invalidate the native list after review storage changes. */
  refresh(): void {
    this.changes.fire(undefined);
  }

  /** Return the already prepared native entry. */
  getTreeItem(item: ReviewItem): vscode.TreeItem {
    return item;
  }

  /** Show open conversations before those accepted by the human reviewer. */
  getChildren(): ReviewItem[] {
    return [...this.store.threads]
      .sort((left, right) => Number(left.resolved) - Number(right.resolved))
      .map((thread) => new ReviewItem(thread));
  }

  /** Release the tree's event emitter. */
  dispose(): void {
    this.changes.dispose();
  }
}

/** Register native inline conversations, review navigation, and local Git diffs. */
export async function createReviewController(
  store: ReviewStore,
  context: vscode.ExtensionContext,
): Promise<vscode.Disposable> {
  const controller = vscode.comments.createCommentController(controllerId, 'Lokales Review');
  controller.options = { prompt: 'Fragen, Änderungen anfordern oder die Unterhaltung zusammenfassen', placeHolder: 'Feedback · /a fragen · /i umsetzen · /r zusammenfassen' };
  const bindings = new Map<string, ThreadBinding>();
  const tree = new ReviewTree(store);
  const view = vscode.window.createTreeView('localReview.threads', { treeDataProvider: tree, showCollapseAll: false });
  const disposables: vscode.Disposable[] = [controller, tree, view];
  let disposed = false;
  let syncPending = Promise.resolve();
  let reviewColumn: vscode.ViewColumn | undefined;
  let contextColumn: vscode.ViewColumn | undefined;

  /** Surface failures without discarding the user's existing review text. */
  function reportError(error: unknown): void {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Das Review konnte nicht aktualisiert werden.');
  }

  /** Reconstruct the document associated with a persisted immutable anchor. */
  function anchorUri(anchor: CodeAnchor): vscode.Uri {
    return anchor.side === 'original'
      ? baseUri(anchor.path, anchor.baseRevision)
      : vscode.Uri.file(path.join(store.workspaceRoot, anchor.path));
  }

  /** Restore a thread on confirmed current code, or on its immutable captured excerpt. */
  async function openAnchorDocument(thread: ReviewThread): Promise<LocatedDocument> {
    try {
      const uri = anchorUri(thread.anchor);
      if (uri.scheme === 'file') {
        await vscode.workspace.fs.stat(uri);
      }
      const document = await vscode.workspace.openTextDocument(uri);
      const location = locateCodeAnchor(document.getText(), thread.anchor);
      if (location !== undefined) {
        return { document, range: locationRange(document, location), captured: false };
      }
    } catch {
      // A missing source or Git object cannot justify attaching the thread to another line.
    }
    const document = await vscode.workspace.openTextDocument(contextUri(thread));
    return { document, range: locationRange(document, capturedCodeContext(thread.anchor)), captured: true };
  }

  /** Copy durable status into the native comment controls. */
  function updateNative(thread: ReviewThread, native: vscode.CommentThread): void {
    native.comments = thread.messages.map(nativeComment);
    native.contextValue = thread.resolved ? 'localReview.resolved' : 'localReview.open';
    native.state = thread.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    native.canReply = !thread.resolved;
    const contextLabel = native.uri.scheme === contextScheme ? ' · Gespeicherter Kontext' : thread.outdated ? ' · Kontext geändert' : '';
    native.label = `${intentLabels[thread.intent]} · ${thread.resolved ? 'Erledigt' : statusLabels[thread.status]}${contextLabel}`;
  }

  /** Attach a native comment control and remember its current document boundaries. */
  function bindThread(thread: ReviewThread, native: vscode.CommentThread, document: vscode.TextDocument): void {
    const range = native.range ?? new vscode.Range(0, 0, 0, 0);
    bindings.set(thread.id, {
      native,
      startOffset: document.offsetAt(range.start),
      endOffset: document.offsetAt(range.end),
      documentVersion: document.version,
      currentHash: documentHash(document),
    });
    updateNative(thread, native);
  }

  /** Restore only missing controls so agent replies never move live editor anchors. */
  async function synchronize(): Promise<void> {
    if (disposed) {
      return;
    }
    tree.refresh();
    const queued = store.pendingEvents.length;
    view.title = queued === 0 ? 'Review' : `Review · ${queued} wartend`;
    for (const thread of store.threads) {
      const binding = bindings.get(thread.id);
      if (binding !== undefined) {
        updateNative(thread, binding.native);
        continue;
      }
      try {
        const located = await openAnchorDocument(thread);
        if (disposed || bindings.has(thread.id)) {
          continue;
        }
        const native = controller.createCommentThread(located.document.uri, located.range, []);
        bindThread(thread, native, located.document);
        if (!thread.outdated && (located.captured || documentHash(located.document) !== thread.anchor.documentHash)) {
          await store.setOutdated(thread.id, true);
        }
      } catch {
        if (!thread.outdated) {
          await store.setOutdated(thread.id, true);
        }
      }
    }
  }

  /** Serialize refreshes because restoring native documents is asynchronous. */
  function scheduleSync(): void {
    syncPending = syncPending.then(synchronize).catch(reportError);
  }

  /** Reconfirm an anchor when edits occurred outside the known live document history. */
  function reconcileBinding(id: string, binding: ThreadBinding, document: vscode.TextDocument): void {
    const thread = store.threads.find((candidate) => candidate.id === id);
    const location = thread === undefined ? undefined : locateCodeAnchor(document.getText(), thread.anchor);
    if (location === undefined) {
      binding.native.dispose();
      bindings.delete(id);
      scheduleSync();
    } else {
      const range = locationRange(document, location);
      binding.native.range = range;
      binding.startOffset = document.offsetAt(range.start);
      binding.endOffset = document.offsetAt(range.end);
      binding.documentVersion = document.version;
      binding.currentHash = documentHash(document);
    }
    if (thread !== undefined && !thread.outdated) {
      void store.setOutdated(id, true).catch(reportError);
    }
  }

  /** Mark contexts as uncertain when their Git base has changed. */
  async function validateRevisions(): Promise<void> {
    const revision = await getHeadRevision(store.workspaceRoot) ?? 'unborn';
    for (const thread of store.threads) {
      if (!thread.outdated && thread.anchor.baseRevision !== revision) {
        await store.setOutdated(thread.id, true);
      }
    }
  }

  /** Capture an immutable code snapshot rather than trusting mutable line numbers. */
  async function captureAnchor(native: vscode.CommentThread): Promise<{ readonly anchor: CodeAnchor; readonly document: vscode.TextDocument; readonly documentVersion: number }> {
    const relativePath = workspacePath(native.uri, store.workspaceRoot);
    if (relativePath === undefined) {
      throw new Error('Wähle eine Datei in diesem Arbeitsbereich, um Feedback hinzuzufügen.');
    }
    const document = await vscode.workspace.openTextDocument(native.uri);
    const range = lineRange(document, native.range ?? new vscode.Range(0, 0, 0, 0));
    native.range = range;
    const reference = baseReference(native.uri);
    const documentVersion = document.version;
    const selectedText = document.getText(range);
    const contextBefore = document.getText(new vscode.Range(Math.max(0, range.start.line - 3), 0, range.start.line, 0));
    const contextAfter = range.end.line + 1 >= document.lineCount ? '' : document.getText(new vscode.Range(range.end.line + 1, 0, Math.min(document.lineCount - 1, range.end.line + 3), Number.MAX_SAFE_INTEGER));
    const hash = documentHash(document);
    const revision = reference?.revision ?? await getHeadRevision(store.workspaceRoot) ?? 'unborn';
    return {
      document,
      documentVersion,
      anchor: {
        path: relativePath,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        selectedText,
        contextBefore,
        contextAfter,
        documentHash: hash,
        side: reference !== undefined && !reference.emptyWorking ? 'original' : 'working',
        baseRevision: revision,
      },
    };
  }

  /** Find a persisted thread from either a native control or a sidebar action. */
  function threadId(argument: unknown): string | undefined {
    if (typeof argument === 'string') {
      return store.threads.some((thread) => thread.id === argument) ? argument : undefined;
    }
    if (argument instanceof ReviewItem) {
      return argument.threadId;
    }
    for (const [id, binding] of bindings) {
      if (binding.native === argument) {
        return id;
      }
    }
    return undefined;
  }

  /** Submit native composer text with an explicit human-selected intent. */
  async function submit(reply: vscode.CommentReply | undefined, fallback: ReviewIntent): Promise<void> {
    if (reply === undefined) {
      throw new Error('Öffne einen Review-Kommentar, um Feedback abzusenden.');
    }
    const parsed = parseIntent(reply.text, fallback);
    const existingId = threadId(reply.thread);
    const existing = store.threads.find((thread) => thread.id === existingId);
    const text = parsed.text || (parsed.intent === 'summarize' && existing !== undefined ? 'Fasse diese Unterhaltung und ihren aktuellen Stand zusammen.' : '');
    if (text.length === 0) {
      throw new Error('Schreibe dein Feedback hinter das Kürzel.');
    }
    if (existing?.resolved === true) {
      throw new Error('Öffne diese Unterhaltung wieder, bevor du eine weitere Anfrage sendest.');
    }
    const captured = existing === undefined ? await captureAnchor(reply.thread) : undefined;
    const anchor = existing?.anchor ?? captured?.anchor;
    if (anchor === undefined) {
      throw new Error('Der Codekontext konnte nicht erfasst werden. Dein Kommentar wurde nicht abgesendet.');
    }
    const thread = await store.submit(anchor, text, parsed.intent, existingId);
    if (captured !== undefined) {
      const restored = bindings.get(thread.id);
      if (restored !== undefined && restored.native !== reply.thread) {
        restored.native.dispose();
      }
      bindThread(thread, reply.thread, captured.document);
      if (captured.document.version !== captured.documentVersion) {
        await store.setOutdated(thread.id, true);
      }
    }
    updateNative(thread, reply.thread);
    reply.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    scheduleSync();
  }

  /** Find an existing comparison so navigation keeps the user's review editor group. */
  function existingDiffGroup(original: vscode.Uri, modified: vscode.Uri): vscode.TabGroup | undefined {
    return vscode.window.tabGroups.all.find((group) => group.tabs.some((tab) => tab.input instanceof vscode.TabInputTextDiff
      && tab.input.original.toString() === original.toString()
      && tab.input.modified.toString() === modified.toString()));
  }

  /** Reuse the review comparison instead of replacing it with a standalone file. */
  async function openReviewDiff(relativePath: string, revision: string): Promise<void> {
    const original = baseUri(relativePath, revision);
    const current = vscode.Uri.file(path.join(store.workspaceRoot, relativePath));
    let modified = current;
    try {
      await vscode.workspace.fs.stat(current);
    } catch {
      modified = baseUri(relativePath, revision, true);
    }
    const existing = existingDiffGroup(original, modified);
    const remembered = vscode.window.tabGroups.all.some((group) => group.viewColumn === reviewColumn) ? reviewColumn : undefined;
    await vscode.commands.executeCommand('vscode.diff', original, modified, `${relativePath} · Lokales Review`, {
      preview: true,
      viewColumn: existing?.viewColumn ?? remembered ?? vscode.ViewColumn.Active,
    });
    reviewColumn = existingDiffGroup(original, modified)?.viewColumn;
  }

  /** Keep an immutable context excerpt beside the full code comparison when needed. */
  async function revealBesideDiff(document: vscode.TextDocument, range: vscode.Range): Promise<void> {
    const remembered = contextColumn !== reviewColumn
      && vscode.window.tabGroups.all.some((group) => group.viewColumn === contextColumn) ? contextColumn : undefined;
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: remembered ?? vscode.ViewColumn.Beside,
      preview: true,
      selection: range,
    });
    contextColumn = editor.viewColumn;
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Reveal the conversation while retaining its comparison and confirmed code context. */
  async function reveal(argument: unknown): Promise<void> {
    const id = threadId(argument);
    const thread = store.threads.find((candidate) => candidate.id === id);
    if (thread === undefined) {
      return;
    }
    let binding = bindings.get(thread.id);
    if (binding?.native.uri.scheme === 'file') {
      try {
        await vscode.workspace.fs.stat(binding.native.uri);
      } catch {
        binding.native.dispose();
        bindings.delete(thread.id);
        binding = undefined;
      }
    }
    if (binding === undefined) {
      const located = await openAnchorDocument(thread);
      const native = controller.createCommentThread(located.document.uri, located.range, []);
      bindThread(thread, native, located.document);
      binding = bindings.get(thread.id);
      if (located.captured && !thread.outdated) {
        await store.setOutdated(thread.id, true);
      }
    }
    if (binding === undefined || binding.native.range === undefined) {
      throw new Error('Die Position dieses Review-Kommentars konnte nicht geöffnet werden.');
    }
    const range = binding.native.range;
    const document = await vscode.workspace.openTextDocument(binding.native.uri);
    binding.native.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    await openReviewDiff(thread.anchor.path, thread.anchor.baseRevision);
    const visible = vscode.window.visibleTextEditors.filter((candidate) => candidate.document.uri.toString() === document.uri.toString());
    const editor = visible.find((candidate) => candidate.viewColumn === reviewColumn)
      ?? visible.find((candidate) => candidate === vscode.window.activeTextEditor) ?? visible[0];
    if (editor === undefined || document.uri.scheme === contextScheme) {
      await revealBesideDiff(document, range);
    } else {
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  /** Open one local file against its immutable HEAD version, including new files. */
  async function openChanges(argument: unknown): Promise<void> {
    await validateRevisions();
    let relativePath = argument instanceof vscode.Uri ? workspacePath(argument, store.workspaceRoot) : undefined;
    if (relativePath === undefined) {
      const files = await listChangedFiles(store.workspaceRoot);
      if (files.length === 0) {
        void vscode.window.showInformationMessage('Es gibt keine lokalen Änderungen zum Prüfen.');
        return;
      }
      relativePath = files.length === 1 ? files[0] : await vscode.window.showQuickPick(files, { title: 'Lokale Änderungen prüfen', placeHolder: 'Wähle eine geänderte Datei' });
    }
    if (relativePath === undefined) {
      return;
    }
    const revision = await getHeadRevision(store.workspaceRoot) ?? 'unborn';
    await openReviewDiff(relativePath, revision);
  }

  disposables.push(vscode.workspace.registerTextDocumentContentProvider(baseScheme, {
    provideTextDocumentContent: async (uri) => {
      const reference = baseReference(uri);
      if (reference === undefined) {
        throw new Error('Die gespeicherte Codeversion ist ungültig.');
      }
      return reference.emptyWorking ? '' : await readGitBase(store.workspaceRoot, reference.relativePath, reference.revision);
    },
  }));
  disposables.push(vscode.workspace.registerTextDocumentContentProvider(contextScheme, {
    provideTextDocumentContent: (uri) => {
      const id = new URLSearchParams(uri.query).get('thread');
      const thread = store.threads.find((candidate) => candidate.id === id);
      if (thread === undefined) {
        throw new Error('Der gespeicherte Review-Kontext wurde nicht gefunden.');
      }
      return capturedCodeContext(thread.anchor).text;
    },
  }));
  controller.commentingRangeProvider = {
    provideCommentingRanges: (document) => workspacePath(document.uri, store.workspaceRoot) === undefined
      ? []
      : [new vscode.Range(0, 0, document.lineCount - 1, 0)],
  };

  const register = (id: string, callback: (argument: unknown) => Promise<void>): void => {
    disposables.push(vscode.commands.registerCommand(`localReview.${id}`, (argument: unknown) => callback(argument).catch(reportError)));
  };
  register('addComment', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined || workspacePath(editor.document.uri, store.workspaceRoot) === undefined) {
      void vscode.window.showInformationMessage('Markiere Code in diesem Arbeitsbereich, um einen Review-Kommentar hinzuzufügen.');
      return;
    }
    const range = lineRange(editor.document, editor.selection);
    const draft = controller.createCommentThread(editor.document.uri, range, []);
    draft.contextValue = 'localReview.draft';
    draft.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    draft.label = 'Neuer Review-Kommentar';
  });
  register('cancelDraft', async (argument) => {
    if (typeof argument !== 'object' || argument === null) {
      return;
    }
    const draft = 'thread' in argument ? argument.thread : argument;
    if (typeof draft === 'object' && draft !== null
      && 'comments' in draft && Array.isArray(draft.comments) && draft.comments.length === 0
      && 'uri' in draft && draft.uri instanceof vscode.Uri
      && workspacePath(draft.uri, store.workspaceRoot) !== undefined
      && 'dispose' in draft && typeof draft.dispose === 'function'
      && threadId(draft) === undefined) {
      draft.dispose();
    }
  });
  register('openChanges', openChanges);
  register('revealThread', reveal);
  for (const [suffix, intent] of [['Ask', 'ask'], ['Implement', 'implement'], ['Summary', 'summarize']] as const) {
    for (const prefix of ['submit', 'reply']) {
      disposables.push(vscode.commands.registerCommand(`localReview.${prefix}${suffix}`, async (reply: vscode.CommentReply | undefined) => {
        try {
          await submit(reply, intent);
        } catch (error: unknown) {
          reportError(error);
          throw error;
        }
      }));
    }
  }
  for (const [command, resolved] of [['resolve', true], ['reopen', false]] as const) {
    register(command, async (argument) => {
      const id = threadId(argument);
      if (id !== undefined) {
        await store.resolve(id, resolved);
      }
    });
  }
  disposables.push(store.onChange(scheduleSync));
  disposables.push(vscode.window.onDidChangeWindowState((state) => {
    if (state.focused) {
      void validateRevisions().catch(reportError);
    }
  }));
  disposables.push(vscode.workspace.onDidOpenTextDocument((document) => {
    for (const [id, binding] of bindings) {
      if (binding.native.uri.toString() !== document.uri.toString()) {
        continue;
      }
      const hash = documentHash(document);
      if (hash !== binding.currentHash) {
        reconcileBinding(id, binding, document);
        continue;
      }
      const range = document.validateRange(binding.native.range ?? new vscode.Range(0, 0, 0, 0));
      binding.startOffset = document.offsetAt(range.start);
      binding.endOffset = document.offsetAt(range.end);
      binding.documentVersion = document.version;
      binding.currentHash = hash;
      binding.native.range = range;
    }
  }));
  disposables.push(vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.contentChanges.length === 0) {
      return;
    }
    const changes = [...event.contentChanges].sort((left, right) => right.rangeOffset - left.rangeOffset);
    const currentHash = documentHash(event.document);
    for (const [id, binding] of bindings) {
      if (binding.native.uri.toString() !== event.document.uri.toString()) {
        continue;
      }
      if (event.document.version !== binding.documentVersion + 1) {
        reconcileBinding(id, binding, event.document);
        continue;
      }
      let outdated = false;
      for (const change of changes) {
        const end = change.rangeOffset + change.rangeLength;
        const overlaps = change.rangeLength === 0
          ? change.rangeOffset >= binding.startOffset && change.rangeOffset <= binding.endOffset
          : binding.startOffset === binding.endOffset
            ? change.rangeOffset <= binding.startOffset && end >= binding.startOffset
            : change.rangeOffset < binding.endOffset && end > binding.startOffset;
        outdated ||= overlaps;
        binding.startOffset = mapOffset(binding.startOffset, change, false);
        binding.endOffset = mapOffset(binding.endOffset, change, true);
      }
      binding.startOffset = Math.max(0, binding.startOffset);
      binding.endOffset = Math.max(binding.startOffset, binding.endOffset);
      binding.native.range = new vscode.Range(event.document.positionAt(binding.startOffset), event.document.positionAt(binding.endOffset));
      binding.documentVersion = event.document.version;
      binding.currentHash = currentHash;
      if (outdated && !store.threads.find((thread) => thread.id === id)?.outdated) {
        void store.setOutdated(id, true).catch(reportError);
      }
    }
  }));

  await synchronize();
  await validateRevisions().catch(reportError);
  const disposable = new vscode.Disposable(() => {
    disposed = true;
    for (const item of disposables.reverse()) {
      item.dispose();
    }
    bindings.clear();
  });
  context.subscriptions.push(disposable);
  return disposable;
}
