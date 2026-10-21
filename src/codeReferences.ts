import { randomUUID } from 'node:crypto';
import { readCodeBlocks, withCodeBlockLanguages, withDetectedCodeBlocks } from './codeBlocks.js';
import type { ReviewMessage, ReviewThread } from './contracts.js';

export const openCodeCommand = 'localReview.openCode';

/** Durable identities resolved from an extension-owned, opaque action handle. */
export interface CodeReference {
  readonly threadId: string;
  readonly messageId: string;
  readonly blockIndex?: number;
}

/** Render bounded code actions while keeping model-authored links unprivileged. */
export class CodeReferences {
  private readonly references = new Map<string, CodeReference>();
  private readonly handles = new Map<string, string>();

  /** Prepend trusted code actions without mutating the original review text. */
  render(thread: ReviewThread, message: ReviewMessage, fallbackLanguage: string): string {
    const displayText = withDetectedCodeBlocks(message.text, fallbackLanguage);
    const blocks = readCodeBlocks(displayText);
    const actionable = blocks.filter((block) => block.code.trim().length > 0).slice(0, 20);
    const actions = actionable.map((block) => this.link(
      actionable.length === 1 ? 'Code im Editor öffnen' : `Code ${block.index + 1} im Editor öffnen`,
      { threadId: thread.id, messageId: message.id, blockIndex: block.index },
    ));
    if (blocks.length === 0 && message.author === 'claude') {
      actions.push(this.link('Codekontext im Editor öffnen', { threadId: thread.id, messageId: message.id }));
    }
    const markdown = withCodeBlockLanguages(displayText, fallbackLanguage);
    return actions.length === 0 ? markdown : `${actions.join(' · ')}\n\n${markdown}`;
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
  private link(label: string, reference: CodeReference): string {
    const key = JSON.stringify([reference.threadId, reference.messageId, reference.blockIndex ?? null]);
    let handle = this.handles.get(key);
    if (handle === undefined) {
      handle = randomUUID();
      this.handles.set(key, handle);
      this.references.set(handle, Object.freeze(reference));
    }
    return `[${label}](command:${openCodeCommand}?${encodeURIComponent(JSON.stringify([handle]))})`;
  }
}
