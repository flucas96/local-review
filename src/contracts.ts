/** Intent attached to an individual human review comment. */
export type ReviewIntent = 'ask' | 'implement' | 'summarize';

/** Processing state; only the human can resolve a thread. */
export type ReviewStatus = 'queued' | 'received' | 'working' | 'answered' | 'ready';

/** Immutable code context captured when a comment is submitted. */
export interface CodeAnchor {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly selectedText: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly documentHash: string;
  readonly side: 'working' | 'original';
  readonly baseRevision: string;
}

/** A comment displayed in a native VS Code thread. */
export interface ReviewMessage {
  readonly id: string;
  readonly eventId?: string;
  readonly author: 'human' | 'claude';
  readonly text: string;
  readonly createdAt: string;
}

/** Durable review thread, independent of the agent transport. */
export interface ReviewThread {
  readonly id: string;
  readonly anchor: CodeAnchor;
  readonly messages: readonly ReviewMessage[];
  readonly intent: ReviewIntent;
  readonly status: ReviewStatus;
  readonly resolved: boolean;
  readonly outdated: boolean;
  readonly latestEventId: string;
}

/** A single immutable work item sent to Claude at least once. */
export interface ReviewEvent {
  readonly id: string;
  readonly sequence: number;
  readonly threadId: string;
  readonly intent: ReviewIntent;
  readonly text: string;
  readonly anchor: CodeAnchor;
  readonly createdAt: string;
  readonly acknowledged: boolean;
}

/** Snapshot persisted to workspace-scoped extension storage. */
export interface ReviewSnapshot {
  readonly version: 1;
  readonly workspaceRoot: string;
  readonly threads: readonly ReviewThread[];
  readonly events: readonly ReviewEvent[];
}

/** Loopback connection descriptor, stored outside the source repository. */
export interface ConnectionDescriptor {
  readonly version: 1;
  readonly url: string;
  readonly token: string;
  readonly workspaceRoot: string;
}

/** Agent response tied to an immutable event to reject obsolete updates. */
export interface AgentUpdate {
  readonly eventId: string;
  readonly status: Exclude<ReviewStatus, 'queued'>;
  readonly text?: string;
}

/** Handles used by the native editor and extension lifecycle. */
export interface Disposable {
  dispose(): void;
}

/** Storage interface shared by UI and local transport. */
export interface ReviewStore {
  readonly threads: readonly ReviewThread[];
  readonly events: readonly ReviewEvent[];
  readonly workspaceRoot: string;
  readonly pendingEvents: readonly ReviewEvent[];
  submit(anchor: CodeAnchor, text: string, intent: ReviewIntent, threadId?: string): Promise<ReviewThread>;
  updateFromAgent(update: AgentUpdate): Promise<ReviewThread>;
  resolve(threadId: string, resolved: boolean): Promise<void>;
  setOutdated(threadId: string, outdated: boolean): Promise<void>;
  onChange(listener: () => void): Disposable;
  flush(): Promise<void>;
}

/** Local client activity shown in VS Code, separate from acknowledgment of any review. */
export interface BridgeState {
  readonly connected: boolean;
  /** A feedback receiver was recently active; this never acknowledges a comment. */
  readonly deliveryReady?: boolean;
  readonly lastSeenAt?: number;
}

/** Loopback server lifecycle without a dependency on the VS Code module. */
export interface ReviewBridge extends Disposable {
  readonly descriptor: ConnectionDescriptor;
  readonly state: BridgeState;
  onChange(listener: () => void): Disposable;
}
