import { runInNewContext } from 'node:vm';
import type * as vscode from 'vscode';

/** Small event source used by the real composer host through the VS Code alias. */
export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => unknown>();
  readonly event: vscode.Event<T> = (listener, thisArgs: unknown, disposables) => {
    const callback = (value: T): unknown => listener.call(thisArgs, value);
    this.listeners.add(callback);
    const disposable = { dispose: (): void => { this.listeners.delete(callback); } };
    disposables?.push(disposable);
    return disposable;
  };

  /** Deliver an event in registration order. */
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }

  /** Release all subscriptions when the host or panel closes. */
  dispose(): void {
    this.listeners.clear();
  }
}

interface BrowserEvent {
  readonly data?: unknown;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly key?: string;
  readonly isComposing?: boolean;
  preventDefault(): void;
}

/** Minimal form control sufficient to execute the production webview script. */
export class FakeElement {
  value = '';
  textContent = '';
  disabled = false;
  hidden = false;
  selectionStart = 0;
  selectionEnd = 0;
  focusCount = 0;
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, ((event: BrowserEvent) => void)[]>();

  /** Remember the handlers registered by the actual composer webview. */
  addEventListener(type: string, listener: (event: BrowserEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  /** Count focus changes so automatic selection updates cannot steal focus. */
  focus(): void {
    this.focusCount += 1;
  }

  /** Retain accessibility state used by the mode buttons. */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Support the caret preservation performed by slash-mode handling. */
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  /** Dispatch a browser event without allowing clicks on disabled controls. */
  fire(type: string): void {
    if (this.disabled) return;
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault(): void {} });
  }
}

/** Run the real self-contained webview JavaScript against simple browser controls. */
export class FakeBrowser {
  readonly elements = new Map<string, FakeElement>();
  readonly outgoing: unknown[] = [];
  state: unknown;
  private readonly messages = new EventEmitter<BrowserEvent>();

  constructor(html: string, receive: (value: unknown) => void) {
    for (const match of html.matchAll(/\bid="([^"]+)"/gu)) {
      if (match[1] !== undefined) this.elements.set(match[1], new FakeElement());
    }
    const modes = ['ask', 'implement', 'summarize'].map((mode) => {
      const element = new FakeElement();
      element.dataset['mode'] = mode;
      return element;
    });
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    if (script === undefined) throw new Error('The composer did not render its browser script.');
    runInNewContext(script, {
      acquireVsCodeApi: () => ({
        postMessage: (value: unknown): void => {
          this.outgoing.push(value);
          queueMicrotask(() => receive(value));
        },
        setState: (value: unknown): void => { this.state = value; },
      }),
      document: {
        getElementById: (id: string) => this.element(id),
        querySelectorAll: () => modes,
      },
      navigator: { platform: 'MacIntel' },
      window: {
        addEventListener: (type: string, listener: (event: BrowserEvent) => unknown): void => {
          if (type === 'message') this.messages.event(listener);
        },
      },
    });
  }

  /** Return a concrete rendered control, failing clearly for changed markup. */
  element(id: string): FakeElement {
    const element = this.elements.get(id);
    if (element === undefined) throw new Error(`No rendered composer element: ${id}`);
    return element;
  }

  /** Deliver an extension-host message to the production browser handler. */
  receive(data: unknown): void {
    this.messages.fire({ data, preventDefault(): void {} });
  }

  /** Enter text and let the real input handler persist and interpret it. */
  type(text: string): void {
    const input = this.element('feedback');
    if (input.disabled) throw new Error('The composer input is disabled.');
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.fire('input');
  }
}

/** Simulated panel exposing only the lifecycle and browser boundary under test. */
export class FakePanel {
  readonly sent: unknown[] = [];
  readonly revealCalls: { readonly column: number | undefined; readonly preserveFocus: boolean | undefined }[] = [];
  readonly viewColumn = 2;
  disposed = false;
  browser: FakeBrowser | undefined;
  private readonly received = new EventEmitter<unknown>();
  private readonly closed = new EventEmitter<void>();
  readonly onDidDispose = this.closed.event;
  readonly webview = {
    html: '',
    onDidReceiveMessage: this.received.event,
    postMessage: async (message: unknown): Promise<boolean> => {
      if (this.disposed) return false;
      this.sent.push(message);
      this.browser?.receive(message);
      return true;
    },
  };

  /** Execute the real browser script only after extension initialization. */
  startBrowser(): FakeBrowser {
    this.browser = new FakeBrowser(this.webview.html, (message) => this.receive(message));
    return this.browser;
  }

  /** Send an untrusted webview message to the real host receiver. */
  receive(message: unknown): void {
    this.received.fire(message);
  }

  /** Record explicit reveals separately from selection-follow updates. */
  reveal(column?: number, preserveFocus?: boolean): void {
    this.revealCalls.push({ column, preserveFocus });
  }

  /** Close once, matching the lifecycle event used by the host. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closed.fire();
    this.closed.dispose();
  }
}

/** URI values needed by real document navigation without accessing the filesystem. */
export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
    readonly query = '',
    readonly authority = '',
    readonly fragment = '',
  ) {}

  /** Create a project file resource without interpreting path characters as URI syntax. */
  static file(path: string): Uri { return new Uri('file', path); }

  /** Create a readonly preview resource from explicit components. */
  static from(components: { readonly scheme: string; readonly path?: string; readonly query?: string; readonly authority?: string; readonly fragment?: string }): Uri {
    return new Uri(components.scheme, components.path ?? '', components.query, components.authority, components.fragment);
  }

  /** Retain a consistent document identity across document-provider registration. */
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}${this.query === '' ? '' : `?${this.query}`}${this.fragment === '' ? '' : `#${this.fragment}`}`;
  }

  /** Expose the local path only for file-oriented test assertions. */
  get fsPath(): string { return this.path; }
}

/** Preserve the actual editor range selected by production content matching. */
export class Range {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };

  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter };
    this.end = { line: endLine, character: endCharacter };
  }
}

/** Carry rendered Markdown and its command trust boundary through real navigation. */
export class MarkdownString {
  isTrusted: boolean | { readonly enabledCommands: readonly string[] } | undefined;

  constructor(readonly value = '') {}
}

/** In-memory document preserving unsaved source separately from immutable previews. */
export class FakeTextDocument {
  isDirty = false;

  constructor(readonly uri: Uri, public text: string, public languageId = 'plaintext', readonly isReadonly = false) {}

  /** Return the current in-memory source, including unsaved editor changes. */
  getText(): string { return this.text; }

  /** Clamp the production selection to real line lengths as the editor would. */
  validateRange(range: Range): Range {
    const lines = this.text.replaceAll('\r\n', '\n').split('\n');
    const startLine = Math.max(0, Math.min(range.start.line, lines.length - 1));
    const endLine = Math.max(startLine, Math.min(range.end.line, lines.length - 1));
    return new Range(startLine, Math.min(range.start.character, lines[startLine]?.length ?? 0), endLine, Math.min(range.end.character, lines[endLine]?.length ?? 0));
  }
}

interface FakeTextEditor {
  readonly document: FakeTextDocument;
  readonly viewColumn: number;
}

interface FakeContentProvider {
  provideTextDocumentContent(uri: Uri): string | PromiseLike<string>;
}

/** Exercise real navigator provider registration and cached in-memory documents. */
export const workspace = {
  textDocuments: [] as FakeTextDocument[],
  providers: new Map<string, FakeContentProvider>(),
  beforeOpen: undefined as (() => Promise<void>) | undefined,

  /** Return unsaved documents first, or obtain exact text from the registered readonly provider. */
  async openTextDocument(uri: Uri): Promise<FakeTextDocument> {
    await this.beforeOpen?.();
    const existing = this.textDocuments.find((document) => document.uri.toString() === uri.toString());
    if (existing !== undefined) return existing;
    const provider = this.providers.get(uri.scheme);
    if (provider === undefined) throw new Error(`No document or content provider for ${uri.toString()}`);
    const document = new FakeTextDocument(uri, await provider.provideTextDocumentContent(uri), 'plaintext', true);
    this.textDocuments.push(document);
    return document;
  },

  /** Keep provider lifecycle observable when the extension is recreated. */
  registerTextDocumentContentProvider(scheme: string, provider: FakeContentProvider): vscode.Disposable {
    this.providers.set(scheme, provider);
    return { dispose: (): void => { if (this.providers.get(scheme) === provider) this.providers.delete(scheme); } };
  },
};

/** Invoke registered production commands with their original asynchronous return values. */
export const commands = {
  handlers: new Map<string, (...arguments_: unknown[]) => unknown>(),

  /** Register the real command handler without wrapping or changing its promise. */
  registerCommand(id: string, handler: (...arguments_: unknown[]) => unknown): vscode.Disposable {
    this.handlers.set(id, handler);
    return { dispose: (): void => { if (this.handlers.get(id) === handler) this.handlers.delete(id); } };
  },

  /** Await all navigation work returned by the real command handler. */
  async executeCommand<T = unknown>(id: string, ...arguments_: unknown[]): Promise<T> {
    const handler = this.handlers.get(id);
    if (handler === undefined) throw new Error(`No registered command: ${id}`);
    return await handler(...arguments_) as T;
  },
};

/** Simulate installed language IDs while letting production code choose aliases. */
export const languages = {
  async getLanguages(): Promise<string[]> { return ['plaintext', 'javascript', 'typescript', 'python']; },
  async setTextDocumentLanguage(document: FakeTextDocument, languageId: string): Promise<FakeTextDocument> {
    document.languageId = languageId;
    return document;
  },
};

export const ViewColumn = { Beside: -2, One: 1 } as const;
export const window = {
  panels: [] as FakePanel[],
  errors: [] as string[],
  information: [] as string[],
  visibleTextEditors: [] as FakeTextEditor[],
  shownDocuments: [] as { readonly document: FakeTextDocument; readonly options: vscode.TextDocumentShowOptions | undefined }[],
  statusMessages: [] as string[],
  beforeShow: undefined as (() => Promise<void>) | undefined,
  createWebviewPanel(): FakePanel {
    const panel = new FakePanel();
    this.panels.push(panel);
    return panel;
  },
  async showErrorMessage(message: string): Promise<void> { this.errors.push(message); },
  async showInformationMessage(message: string): Promise<void> { this.information.push(message); },

  /** Record only completed reveals so command completion can be tested accurately. */
  async showTextDocument(document: FakeTextDocument, options?: vscode.TextDocumentShowOptions): Promise<FakeTextEditor> {
    await this.beforeShow?.();
    this.shownDocuments.push({ document, options });
    const editor = this.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === document.uri.toString())
      ?? { document, viewColumn: options?.viewColumn ?? ViewColumn.One };
    if (!this.visibleTextEditors.includes(editor)) this.visibleTextEditors.push(editor);
    return editor;
  },

  /** Retain the user-visible explanation for standalone code proposals. */
  setStatusBarMessage(message: string): vscode.Disposable {
    this.statusMessages.push(message);
    return { dispose(): void {} };
  },
};

/** Workspace storage with actual ordered async updates and snapshot inspection. */
export class FakeMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  /** Return stored state without inventing defaults. */
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  /** List existing storage entries for the editor's memento contract. */
  keys(): readonly string[] { return [...this.values.keys()]; }

  /** Capture independent JSON state as the workspace persistence boundary would. */
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

/** Build the single extension-context field consumed by the real composer. */
export function extensionContext(workspaceState = new FakeMemento()): vscode.ExtensionContext {
  return { workspaceState } as unknown as vscode.ExtensionContext;
}

/** Reset surfaces between tests without mutating application source. */
export function resetFakeWindow(): void {
  for (const panel of window.panels) panel.dispose();
  window.panels.length = 0;
  window.errors.length = 0;
  window.information.length = 0;
  window.visibleTextEditors.length = 0;
  window.shownDocuments.length = 0;
  window.statusMessages.length = 0;
  window.beforeShow = undefined;
}

/** Clear only editor navigation state after its production providers are disposed. */
export function resetFakeEditor(): void {
  workspace.textDocuments.length = 0;
  workspace.providers.clear();
  workspace.beforeOpen = undefined;
  commands.handlers.clear();
}

/** Drain host messages and ordered persistence microtasks without wall-clock sleeps. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
