import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { maximumIdentifierLength, maximumPathLength, maximumReplyLength, maximumReviewTextLength } from './limits.js';

import type {
  AgentUpdate,
  CodeAnchor,
  Disposable,
  ReviewEvent,
  ReviewIntent,
  ReviewMessage,
  ReviewSnapshot,
  ReviewStatus,
  ReviewStore,
  ReviewThread,
} from './contracts.js';

const intents: readonly ReviewIntent[] = ['ask', 'implement', 'summarize'];
const statuses: readonly ReviewStatus[] = ['queued', 'received', 'working', 'answered', 'ready'];
const statusRank: Readonly<Record<ReviewStatus, number>> = {
  queued: 0,
  received: 1,
  working: 2,
  answered: 3,
  ready: 3,
};

/** A validation or review conflict that can be reported to the local client. */
export class ReviewStoreError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ReviewStoreError';
    this.statusCode = statusCode;
  }
}

/** Validate an untrusted agent update without allowing human-only operations. */
export function parseAgentUpdate(value: unknown): AgentUpdate {
  const record = readObject(value, 'agent update');
  checkKeys(record, ['eventId', 'status', 'text']);
  const status = readStatus(record['status']);
  if (status === 'queued') {
    throw new ReviewStoreError('Agents cannot queue review comments.');
  }
  const update = { eventId: readId(record['eventId']), status };
  return record['text'] === undefined
    ? Object.freeze(update)
    : Object.freeze({ ...update, text: readBoundedText(record['text'], 'Antwort', maximumReplyLength, true) });
}

/** Open durable review storage, rejecting corrupt or unrelated workspace data. */
export async function createReviewStore(storageFile: string, workspaceRoot: string): Promise<ReviewStore> {
  const root = path.resolve(readNonemptyText(workspaceRoot, 'workspaceRoot'));
  const file = path.resolve(readNonemptyText(storageFile, 'storageFile'));
  let snapshot: ReviewSnapshot;
  try {
    const contents = await readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(contents);
    snapshot = readSnapshot(parsed, root);
  } catch (error: unknown) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
    snapshot = freezeSnapshot({ version: 1, workspaceRoot: root, threads: [], events: [] });
  }
  return new FileReviewStore(file, snapshot);
}

/** Serialize durable mutations so concurrent editor and agent updates cannot race. */
class FileReviewStore implements ReviewStore {
  readonly #storageFile: string;
  readonly #listeners = new Set<() => void>();
  #snapshot: ReviewSnapshot;
  #pending: Promise<void> = Promise.resolve();

  constructor(storageFile: string, snapshot: ReviewSnapshot) {
    this.#storageFile = storageFile;
    this.#snapshot = snapshot;
  }

  get workspaceRoot(): string {
    return this.#snapshot.workspaceRoot;
  }

  get threads(): readonly ReviewThread[] {
    return this.#snapshot.threads;
  }

  get events(): readonly ReviewEvent[] {
    return this.#snapshot.events;
  }

  /** Expose undelivered events only while their human-owned thread remains open. */
  get pendingEvents(): readonly ReviewEvent[] {
    const openThreads = new Set(this.#snapshot.threads.filter((thread) => !thread.resolved).map((thread) => thread.id));
    return this.#snapshot.events.filter((event) => !event.acknowledged && openThreads.has(event.threadId));
  }

  /** Capture a human comment as a new immutable event and reopen its thread. */
  submit(anchor: CodeAnchor, text: string, intent: ReviewIntent, threadId?: string): Promise<ReviewThread> {
    const capturedAnchor = readAnchor(anchor);
    const capturedText = readBoundedText(text, 'Kommentar', maximumReviewTextLength, true);
    const capturedIntent = readIntent(intent);
    const capturedThreadId = threadId === undefined ? undefined : readId(threadId);
    return this.#mutate((snapshot) => {
      const existing = capturedThreadId === undefined
        ? undefined
        : requireThread(snapshot, capturedThreadId);
      if (existing === undefined) validateNewAnchor(capturedAnchor);
      const id = existing?.id ?? randomUUID();
      const threadAnchor = existing?.anchor ?? capturedAnchor;
      const createdAt = new Date().toISOString();
      const previousSequence = snapshot.events.at(-1)?.sequence ?? 0;
      if (previousSequence >= Number.MAX_SAFE_INTEGER) {
        throw new ReviewStoreError('Review event sequence is exhausted.', 409);
      }
      const event: ReviewEvent = {
        id: randomUUID(),
        sequence: previousSequence + 1,
        threadId: id,
        intent: capturedIntent,
        text: capturedText,
        anchor: threadAnchor,
        createdAt,
        acknowledged: false,
      };
      const message: ReviewMessage = {
        id: randomUUID(), eventId: event.id, author: 'human', text: capturedText, createdAt,
      };
      const thread: ReviewThread = {
        id,
        anchor: threadAnchor,
        messages: [...(existing?.messages ?? []), message],
        intent: capturedIntent,
        status: 'queued',
        resolved: false,
        outdated: existing?.outdated ?? false,
        latestEventId: event.id,
      };
      return [
        {
          ...snapshot,
          threads: existing === undefined
            ? [...snapshot.threads, thread]
            : snapshot.threads.map((candidate) => candidate.id === id ? thread : candidate),
          events: [...snapshot.events, event],
        },
        thread,
      ];
    });
  }

  /** Acknowledge delivery while preserving historical replies without changing current work. */
  updateFromAgent(update: AgentUpdate): Promise<ReviewThread> {
    const captured = parseAgentUpdate(update);
    return this.#mutate((snapshot) => {
      const event = snapshot.events.find((candidate) => candidate.id === captured.eventId);
      if (event === undefined) {
        throw new ReviewStoreError('Review event was not found.', 404);
      }
      const thread = requireThread(snapshot, event.threadId);
      if (thread.resolved && captured.status === 'working') {
        throw new ReviewStoreError('The human has resolved this review thread.', 409);
      }
      const current = thread.latestEventId === event.id;
      const acknowledgmentOnly = captured.status === 'received' && captured.text === undefined;
      const historicalReply = (captured.status === 'answered' || captured.status === 'ready')
        && captured.text !== undefined;
      if (!current && !acknowledgmentOnly && !historicalReply) {
        throw new ReviewStoreError('This review event has been superseded by a newer comment.', 409);
      }
      const events = event.acknowledged
        ? snapshot.events
        : snapshot.events.map((candidate) => candidate.id === event.id
          ? { ...candidate, acknowledged: true }
          : candidate);
      const messages = captured.text !== undefined && !hasEventReply(thread, event.id, captured.text)
        ? [...thread.messages, {
          id: randomUUID(), author: 'claude' as const, text: captured.text,
          createdAt: new Date().toISOString(), eventId: event.id,
        }]
        : thread.messages;
      const status = current && statusRank[captured.status] > statusRank[thread.status]
        ? captured.status
        : thread.status;
      const nextThread = messages === thread.messages && status === thread.status
        ? thread
        : { ...thread, messages, status };
      if (events === snapshot.events && nextThread === thread) {
        return [snapshot, thread];
      }
      return [{
        ...snapshot,
        events,
        threads: snapshot.threads.map((candidate) => candidate.id === thread.id ? nextThread : candidate),
      }, nextThread];
    });
  }

  /** Set resolution from an explicit human editor action. */
  resolve(threadId: string, resolved: boolean): Promise<void> {
    const id = readId(threadId);
    const value = readBoolean(resolved, 'resolved');
    return this.#mutate((snapshot) => {
      const thread = requireThread(snapshot, id);
      return thread.resolved === value
        ? [snapshot, undefined]
        : [replaceThread(snapshot, { ...thread, resolved: value }), undefined];
    });
  }

  /** Update the editor's assessment of the captured code context. */
  setOutdated(threadId: string, outdated: boolean): Promise<void> {
    const id = readId(threadId);
    const value = readBoolean(outdated, 'outdated');
    return this.#mutate((snapshot) => {
      const thread = requireThread(snapshot, id);
      return thread.outdated === value
        ? [snapshot, undefined]
        : [replaceThread(snapshot, { ...thread, outdated: value }), undefined];
    });
  }

  /** Subscribe to committed storage changes. */
  onChange(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  /** Wait until every previously submitted mutation has completed. */
  flush(): Promise<void> {
    return this.#pending;
  }

  /** Commit first, then publish an immutable snapshot to editor listeners. */
  #mutate<T>(mutation: (snapshot: ReviewSnapshot) => readonly [ReviewSnapshot, T]): Promise<T> {
    const result = this.#pending.then(async () => {
      const [next, value] = mutation(this.#snapshot);
      if (next !== this.#snapshot) {
        const frozen = freezeSnapshot(next);
        await saveSnapshot(this.#storageFile, frozen);
        this.#snapshot = frozen;
        for (const listener of this.#listeners) {
          try {
            listener();
          } catch {
            // A view listener cannot invalidate an already committed mutation.
          }
        }
      }
      return value;
    });
    this.#pending = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Replace exactly one known thread while preserving the event log. */
function replaceThread(snapshot: ReviewSnapshot, thread: ReviewThread): ReviewSnapshot {
  return { ...snapshot, threads: snapshot.threads.map((candidate) => candidate.id === thread.id ? thread : candidate) };
}

/** Find a thread or report a stable not-found error to the caller. */
function requireThread(snapshot: ReviewSnapshot, threadId: string): ReviewThread {
  const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) {
    throw new ReviewStoreError('Review thread was not found.', 404);
  }
  return thread;
}

/** Recognize retried replies by immutable event and visible response text. */
function hasEventReply(thread: ReviewThread, eventId: string, text: string): boolean {
  return thread.messages.some((message) => message.author === 'claude' && message.eventId === eventId && message.text === text);
}

/** Atomically replace storage using an exclusive temporary file in the same directory. */
async function saveSnapshot(file: string, snapshot: ReviewSnapshot): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(snapshot)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporaryFile, file);
  } finally {
    await unlink(temporaryFile).catch(() => undefined);
  }
}

/** Freeze nested collections so callers cannot alter captured review context. */
function freezeSnapshot(snapshot: ReviewSnapshot): ReviewSnapshot {
  for (const thread of snapshot.threads) {
    Object.freeze(thread.anchor);
    thread.messages.forEach(Object.freeze);
    Object.freeze(thread.messages);
    Object.freeze(thread);
  }
  for (const event of snapshot.events) {
    Object.freeze(event.anchor);
    Object.freeze(event);
  }
  Object.freeze(snapshot.threads);
  Object.freeze(snapshot.events);
  return Object.freeze(snapshot);
}

/** Validate and reconstruct a persisted snapshot rather than trusting JSON shapes. */
function readSnapshot(value: unknown, workspaceRoot: string): ReviewSnapshot {
  const record = readObject(value, 'snapshot');
  checkKeys(record, ['version', 'workspaceRoot', 'threads', 'events']);
  if (record['version'] !== 1 || record['workspaceRoot'] !== workspaceRoot) {
    throw new ReviewStoreError('Review storage belongs to another workspace or unsupported version.');
  }
  const threads = readArray(record['threads'], 'threads').map(readThread);
  const events = readArray(record['events'], 'events').map(readEvent);
  assertUnique(threads.map((thread) => thread.id), 'thread');
  assertUnique(events.map((event) => event.id), 'event');
  assertUnique(threads.flatMap((thread) => thread.messages.map((message) => message.id)), 'message');
  const threadIds = new Set(threads.map((thread) => thread.id));
  const latestEvents = new Map<string, ReviewEvent>();
  const eventThreads = new Map(events.map((event) => [event.id, event.threadId]));
  let sequence = 0;
  for (const event of events) {
    if (!threadIds.has(event.threadId) || event.sequence <= sequence) {
      throw new ReviewStoreError('Review storage contains inconsistent events.');
    }
    sequence = event.sequence;
    latestEvents.set(event.threadId, event);
  }
  for (const thread of threads) {
    if (latestEvents.get(thread.id)?.id !== thread.latestEventId) {
      throw new ReviewStoreError('Review storage contains an inconsistent thread cursor.');
    }
    if (thread.messages.some((message) => message.eventId !== undefined
      && eventThreads.get(message.eventId) !== thread.id)) {
      throw new ReviewStoreError('Review storage contains a message for an unrelated event.');
    }
  }
  return freezeSnapshot({ version: 1, workspaceRoot, threads, events });
}

/** Validate a stored review thread and its nested messages. */
function readThread(value: unknown): ReviewThread {
  const record = readObject(value, 'thread');
  checkKeys(record, ['id', 'anchor', 'messages', 'intent', 'status', 'resolved', 'outdated', 'latestEventId']);
  const messages = readArray(record['messages'], 'messages').map(readMessage);
  if (messages.length === 0 || messages[0]?.author !== 'human') {
    throw new ReviewStoreError('Review threads must start with a human comment.');
  }
  return {
    id: readId(record['id']), anchor: readAnchor(record['anchor']), messages,
    intent: readIntent(record['intent']), status: readStatus(record['status']),
    resolved: readBoolean(record['resolved'], 'resolved'),
    outdated: readBoolean(record['outdated'], 'outdated'), latestEventId: readId(record['latestEventId']),
  };
}

/** Validate an event's immutable work payload and delivery marker. */
function readEvent(value: unknown): ReviewEvent {
  const record = readObject(value, 'event');
  checkKeys(record, ['id', 'sequence', 'threadId', 'intent', 'text', 'anchor', 'createdAt', 'acknowledged']);
  return {
    id: readId(record['id']), sequence: readPositiveInteger(record['sequence'], 'sequence'),
    threadId: readId(record['threadId']), intent: readIntent(record['intent']),
    text: readNonemptyText(record['text'], 'text'), anchor: readAnchor(record['anchor']),
    createdAt: readTimestamp(record['createdAt']), acknowledged: readBoolean(record['acknowledged'], 'acknowledged'),
  };
}

/** Validate a stored human or Claude message. */
function readMessage(value: unknown): ReviewMessage {
  const record = readObject(value, 'message');
  checkKeys(record, ['id', 'author', 'text', 'createdAt', 'eventId']);
  if (record['author'] !== 'human' && record['author'] !== 'claude') {
    throw new ReviewStoreError('Invalid message author.');
  }
  const message: ReviewMessage = {
    id: readId(record['id']), author: record['author'], text: readNonemptyText(record['text'], 'text'),
    createdAt: readTimestamp(record['createdAt']),
  };
  return record['eventId'] === undefined
    ? message
    : { ...message, eventId: readId(record['eventId']) };
}

/** Copy and validate line coordinates and workspace-relative code context. */
function readAnchor(value: unknown): CodeAnchor {
  const record = readObject(value, 'anchor');
  checkKeys(record, ['path', 'startLine', 'endLine', 'selectedText', 'contextBefore', 'contextAfter', 'documentHash', 'side', 'baseRevision']);
  const filePath = readNonemptyText(record['path'], 'path').replaceAll('\\', '/');
  if (path.posix.isAbsolute(filePath) || path.win32.isAbsolute(filePath)
    || filePath.split('/').includes('..') || filePath.includes('\0') || path.posix.normalize(filePath) === '.') {
    throw new ReviewStoreError('Anchor path must stay inside the workspace.');
  }
  const startLine = readPositiveInteger(record['startLine'], 'startLine');
  const endLine = readPositiveInteger(record['endLine'], 'endLine');
  if (endLine < startLine || (record['side'] !== 'working' && record['side'] !== 'original')) {
    throw new ReviewStoreError('Invalid anchor range or side.');
  }
  return Object.freeze({
    path: path.posix.normalize(filePath), startLine, endLine,
    selectedText: readText(record['selectedText'], 'selectedText'),
    contextBefore: readText(record['contextBefore'], 'contextBefore'),
    contextAfter: readText(record['contextAfter'], 'contextAfter'),
    documentHash: readNonemptyText(record['documentHash'], 'documentHash'), side: record['side'],
    baseRevision: readText(record['baseRevision'], 'baseRevision'),
  });
}

/** Reject newly captured context that the agent transport cannot deliver. */
function validateNewAnchor(anchor: CodeAnchor): void {
  readBoundedText(anchor.path, 'Dateipfad', maximumPathLength, true);
  readBoundedText(anchor.selectedText, 'Codeauswahl', maximumReviewTextLength);
  readBoundedText(anchor.contextBefore, 'Codekontext vor der Auswahl', maximumReviewTextLength);
  readBoundedText(anchor.contextAfter, 'Codekontext nach der Auswahl', maximumReviewTextLength);
  readBoundedText(anchor.documentHash, 'Dokumentkennung', maximumIdentifierLength, true);
  readBoundedText(anchor.baseRevision, 'Git-Referenz', maximumPathLength);
}

/** Match wire limits for new data without rejecting older stored snapshots. */
function readBoundedText(value: unknown, label: string, maximum: number, required = false): string {
  const text = required ? readNonemptyText(value, label) : readText(value, label);
  if (text.length > maximum) {
    throw new ReviewStoreError(`${label} ist zu groß (maximal ${maximum.toLocaleString('de-DE')} Zeichen). Verkleinere die Auswahl oder teile dein Feedback auf.`);
  }
  if (text.includes('\0')) {
    throw new ReviewStoreError(`${label} enthält ein nicht unterstütztes Nullzeichen.`);
  }
  return text;
}

/** Narrow an untrusted record before inspecting individual properties. */
function readObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReviewStoreError(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

/** Reject unexpected fields, including attempts to resolve threads through the agent API. */
function checkKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(record).some((key) => !keys.has(key))) {
    throw new ReviewStoreError('Unexpected review data fields.');
  }
}

/** Validate an untrusted JSON array. */
function readArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ReviewStoreError(`Invalid ${label}.`);
  }
  return value as readonly unknown[];
}

/** Validate text while preserving whitespace in captured code. */
function readText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ReviewStoreError(`Invalid ${label}.`);
  }
  return value;
}

/** Validate required text without changing user-authored content. */
function readNonemptyText(value: unknown, label: string): string {
  const text = readText(value, label);
  if (text.trim().length === 0) {
    throw new ReviewStoreError(`${label} cannot be empty.`);
  }
  return text;
}

/** Accept UUID identifiers generated by the review store. */
function readId(value: unknown): string {
  const id = readText(value, 'id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new ReviewStoreError('Invalid review identifier.');
  }
  return id;
}

/** Accept only supported user intents. */
function readIntent(value: unknown): ReviewIntent {
  const intent = intents.find((candidate) => candidate === value);
  if (intent === undefined) {
    throw new ReviewStoreError('Invalid review intent.');
  }
  return intent;
}

/** Accept only supported processing states. */
function readStatus(value: unknown): ReviewStatus {
  const status = statuses.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new ReviewStoreError('Invalid review status.');
  }
  return status;
}

/** Validate booleans without coercing untrusted values. */
function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ReviewStoreError(`Invalid ${label}.`);
  }
  return value;
}

/** Validate positive coordinates and sequence numbers. */
function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ReviewStoreError(`Invalid ${label}.`);
  }
  return value;
}

/** Accept the canonical ISO timestamps written by this store. */
function readTimestamp(value: unknown): string {
  const timestamp = readText(value, 'createdAt');
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) {
    throw new ReviewStoreError('Invalid review timestamp.');
  }
  return timestamp;
}

/** Reject duplicate durable identities before they can make updates ambiguous. */
function assertUnique(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new ReviewStoreError(`Duplicate review ${label} identifiers.`);
  }
}

/** Recognize filesystem errors without assuming an Error object's shape. */
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
