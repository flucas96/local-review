import type { ReviewIntent } from './contracts.js';

/** Effective mode and text after interpreting a composer shortcut. */
export interface ComposerInput {
  readonly text: string;
  readonly intent: ReviewIntent;
  readonly selectedIntent: ReviewIntent;
  readonly removedCharacters: number;
}

/** Preview ASCII shortcuts regardless of case and consume them only at a boundary or send. */
export function parseComposerInput(text: string, selectedIntent: ReviewIntent, finalize = false): ComposerInput {
  const match = /^\s*\/([aAiIrR])(\s+|$)/u.exec(text);
  const shortcuts = { a: 'ask', i: 'implement', r: 'summarize' } as const;
  const shortcut = match?.[1]?.toLowerCase();
  if (match === null || (shortcut !== 'a' && shortcut !== 'i' && shortcut !== 'r')) {
    return { text, intent: selectedIntent, selectedIntent, removedCharacters: 0 };
  }
  const intent = shortcuts[shortcut];
  if (match[2] === '' && !finalize) {
    return { text, intent, selectedIntent, removedCharacters: 0 };
  }
  return {
    text: text.slice(match[0].length),
    intent,
    selectedIntent: intent,
    removedCharacters: match[0].length,
  };
}
