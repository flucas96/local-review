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

export const ViewColumn = { Beside: -2 } as const;
export const window = {
  panels: [] as FakePanel[],
  errors: [] as string[],
  information: [] as string[],
  createWebviewPanel(): FakePanel {
    const panel = new FakePanel();
    this.panels.push(panel);
    return panel;
  },
  async showErrorMessage(message: string): Promise<void> { this.errors.push(message); },
  async showInformationMessage(message: string): Promise<void> { this.information.push(message); },
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
}

/** Drain host messages and ordered persistence microtasks without wall-clock sleeps. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
