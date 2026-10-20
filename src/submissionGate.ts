/** Share one pending submission per native thread until its success or failure is known. */
export class SubmissionGate<Key> {
  readonly #pending = new Map<Key, Promise<void>>();

  /** Register work before starting it and return the same promise to concurrent callers. */
  run(key: Key, work: () => Promise<void>): Promise<void> {
    const existing = this.#pending.get(key);
    if (existing !== undefined) return existing;
    const submission = Promise.resolve().then(work).finally(() => {
      this.#pending.delete(key);
    });
    this.#pending.set(key, submission);
    return submission;
  }

  /** Report whether discarding or resubmitting this key would race an active submission. */
  isPending(key: Key): boolean {
    return this.#pending.has(key);
  }
}
