import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { readCodeBlocks, withCodeBlockCards, withDetectedCodeBlocks } from './codeBlocks.js';
import type { ReviewMessage, ReviewThread } from './contracts.js';

export const openCodeCommand = 'localReview.openCode';

/** Durable identities resolved from an extension-owned, opaque action handle. */
export interface CodeReference {
  readonly threadId: string;
  readonly messageId: string;
  readonly blockIndex?: number;
}

/** A native editor action whose opaque handle reveals no captured source or file path. */
export interface CodeAction {
  readonly handle: string;
  readonly label: string;
  readonly description: string;
}

/** Render bounded code actions while keeping model-authored links unprivileged. */
export class CodeReferences {
  private readonly references = new Map<string, CodeReference>();
  private readonly handles = new Map<string, string>();

  /** Render display-only code cards without adding command links to the conversation body. */
  render(thread: ReviewThread, message: ReviewMessage, fallbackLanguage: string): string {
    const displayText = withDetectedCodeBlocks(message.text, fallbackLanguage);
    return withCodeBlockCards(displayText, fallbackLanguage,
      (block) => `${basename(thread.anchor.path)} · ${block.language || 'Code'}`);
  }

  /** Offer bounded native actions using only stored message identities and code previews. */
  actions(thread: ReviewThread, message: ReviewMessage, fallbackLanguage: string): readonly CodeAction[] {
    const displayText = withDetectedCodeBlocks(message.text, fallbackLanguage);
    const blocks = readCodeBlocks(displayText, fallbackLanguage);
    const actionable = blocks.filter((block) => block.code.trim().length > 0).slice(0, 20);
    const actions: CodeAction[] = actionable.map((block) => ({
      handle: this.handle({ threadId: thread.id, messageId: message.id, blockIndex: block.index }),
      label: `Code ${block.index + 1} · ${block.language || 'Code'}`,
      description: (block.code.split(/\r?\n/u).find(line => line.trim().length > 0)?.trim() ?? '').slice(0, 160),
    }));
    if (blocks.length === 0 && message.author === 'claude') {
      actions.push({
        handle: this.handle({ threadId: thread.id, messageId: message.id }),
        label: 'Codekontext', description: thread.anchor.path,
      });
    }
    return actions;
  }

  /** Resolve only handles generated during this extension session. */
  resolve(handle: unknown): CodeReference | undefined {
    return typeof handle === 'string' ? this.references.get(handle) : undefined;
  }

  /** Release session handles when the extension's review UI is disposed. */
  dispose(): void {
    this.references.clear();
    this.handles.clear();
  }

  /** Reuse an opaque handle for stable rerenders of the same immutable snippet. */
  private handle(reference: CodeReference): string {
    const key = JSON.stringify([reference.threadId, reference.messageId, reference.blockIndex ?? null]);
    let handle = this.handles.get(key);
    if (handle === undefined) {
      handle = randomUUID();
      this.handles.set(key, handle);
      this.references.set(handle, Object.freeze(reference));
    }
    return handle;
  }
}
