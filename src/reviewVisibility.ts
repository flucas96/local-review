import type * as vscode from 'vscode';

import type { ReviewThread } from './contracts.js';

export const resolvedVisibilityKey = 'localReview.showResolved';

/** Keep resolved reviews hidden by default without changing their durable conversations. */
export class ReviewVisibility {
  private resolvedVisible: boolean;
  private pending = Promise.resolve();

  constructor(private readonly storage: vscode.Memento) {
    this.resolvedVisible = storage.get<unknown>(resolvedVisibilityKey) === true;
  }

  /** Report the last successfully saved workspace visibility preference. */
  get showResolved(): boolean {
    return this.resolvedVisible;
  }

  /** Apply the same visibility rule to native editor threads and sidebar entries. */
  includes(thread: Pick<ReviewThread, 'resolved'>): boolean {
    return !thread.resolved || this.resolvedVisible;
  }

  /** Save explicit changes in order, retaining the prior preference if storage fails. */
  setShowResolved(visible: boolean): Promise<void> {
    const update = this.pending.then(async () => {
      await this.storage.update(resolvedVisibilityKey, visible);
      this.resolvedVisible = visible;
    });
    this.pending = update.catch(() => undefined);
    return update;
  }
}
