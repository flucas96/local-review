import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isIdentifier, record } from './connection.js';
import type { ReviewEvent } from './contracts.js';

const maximumReceiptEvents = 10_000;
const maximumReceiptBytes = 3_000_000;
const maximumReceiptSessions = 32;
const receiptLifetimeMs = 30 * 24 * 60 * 60 * 1000;

/** Session-local emission memory, separate from the review store's explicit ACK. */
export interface HookDeliveryLedger {
  /** Select unseen events from a complete pending snapshot, or explicitly recover all of it. */
  select(events: readonly ReviewEvent[], recover: boolean): readonly ReviewEvent[];
  /** Persist pruning and successfully emitted IDs after the hook output has been flushed. */
  record(events: readonly ReviewEvent[]): Promise<void>;
}

/** Keep path components opaque even when session identifiers contain separators. */
function hash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** Accept only bounded metadata belonging to this exact workspace and Claude session. */
function readReceipt(value: unknown, workspaceRoot: string, sessionId: string): Set<string> {
  const data = record(value);
  if (data === undefined || data.version !== 1 || data.workspaceRoot !== workspaceRoot
    || data.sessionId !== sessionId || !Array.isArray(data.eventIds)
    || data.eventIds.length > maximumReceiptEvents
    || !data.eventIds.every((id: unknown): id is string => isIdentifier(id))) {
    return new Set();
  }
  const ids = new Set<string>(data.eventIds);
  return ids.size === data.eventIds.length ? ids : new Set();
}

/** Load local emission memory without letting missing or corrupt metadata hide review work. */
export async function createHookDeliveryLedger(
  connectionPath: string, workspaceRoot: string, sessionId: string,
): Promise<HookDeliveryLedger> {
  const prefix = `delivery-${hash(workspaceRoot, 20)}-`;
  const path = join(dirname(connectionPath), `${prefix}${hash(sessionId, 32)}.json`);
  let ids = new Set<string>();
  try {
    const info = await stat(path);
    if (info.isFile() && info.size <= maximumReceiptBytes && Date.now() - info.mtimeMs <= receiptLifetimeMs) {
      const value: unknown = JSON.parse(await readFile(path, 'utf8'));
      ids = readReceipt(value, workspaceRoot, sessionId);
    }
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && record(error)?.code !== 'ENOENT') throw error;
  }
  return new FileHookDeliveryLedger(path, prefix, workspaceRoot, sessionId, ids);
}

/** Serialize bounded session receipts under the hook's existing workspace watcher lock. */
class FileHookDeliveryLedger implements HookDeliveryLedger {
  #emitted: Set<string>;
  #pending = new Set<string>();
  #dirty = false;

  constructor(
    private readonly path: string,
    private readonly prefix: string,
    private readonly workspaceRoot: string,
    private readonly sessionId: string,
    emitted: Set<string>,
  ) {
    this.#emitted = emitted;
  }

  /** Prune only against an authoritative complete snapshot, never a partial long poll. */
  select(events: readonly ReviewEvent[], recover: boolean): readonly ReviewEvent[] {
    if (events.length > maximumReceiptEvents) throw new Error('The pending review snapshot exceeds the hook delivery limit.');
    this.#pending = new Set(events.map((event) => event.id));
    const retained = new Set([...this.#emitted].filter((id) => this.#pending.has(id)));
    if (retained.size !== this.#emitted.size) this.#dirty = true;
    this.#emitted = retained;
    return recover ? events : events.filter((event) => !event.acknowledged && !this.#emitted.has(event.id));
  }

  /** Record emission without changing acknowledgments, statuses, or immutable review data. */
  async record(events: readonly ReviewEvent[]): Promise<void> {
    for (const event of events) {
      if (!this.#pending.has(event.id)) throw new Error('Cannot record an event outside the current pending review snapshot.');
      if (!this.#emitted.has(event.id)) this.#dirty = true;
      this.#emitted.add(event.id);
    }
    if (!this.#dirty) return;
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({
        version: 1, workspaceRoot: this.workspaceRoot, sessionId: this.sessionId, eventIds: [...this.#emitted],
      }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
      this.#dirty = false;
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (record(error)?.code !== 'ENOENT') throw error;
      });
    }
    await this.#pruneSessions().catch(() => {});
  }

  /** Bound optional emission metadata; expired sessions still recover through durable pending work. */
  async #pruneSessions(): Promise<void> {
    const directory = dirname(this.path);
    const names = (await readdir(directory)).filter((name) => name.startsWith(this.prefix)
      && /^[a-f\d]{32}\.json$/u.test(name.slice(this.prefix.length)) && join(directory, name) !== this.path);
    const entries = await Promise.all(names.map(async (name) => ({ name, info: await stat(join(directory, name)) })));
    entries.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);
    await Promise.all(entries.filter((entry, index) => index >= maximumReceiptSessions - 1
      || Date.now() - entry.info.mtimeMs > receiptLifetimeMs)
      .map((entry) => unlink(join(directory, entry.name))));
  }
}
