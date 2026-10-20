import * as vscode from 'vscode';

import { maximumReviewTextLength } from './limits.js';

/** Recognize a native inline thread without relying on extension-host internals. */
function isNativeThread(value: unknown): value is vscode.CommentThread {
  if (typeof value !== 'object' || value === null
    || !('uri' in value) || !(value.uri instanceof vscode.Uri)
    || !('range' in value) || !(value.range instanceof vscode.Range)
    || !('comments' in value) || !Array.isArray(value.comments)
    || !('dispose' in value) || typeof value.dispose !== 'function'
    || !('collapsibleState' in value)
    || (value.collapsibleState !== undefined
      && value.collapsibleState !== vscode.CommentThreadCollapsibleState.Collapsed
      && value.collapsibleState !== vscode.CommentThreadCollapsibleState.Expanded)
    || !('canReply' in value)) return false;
  const author = value.canReply;
  return typeof author === 'boolean'
    || (typeof author === 'object' && author !== null && 'name' in author && typeof author.name === 'string');
}

/** Preserve the native thread identity while narrowing an inline command's reply argument. */
export function normalizeInlineReply(argument: unknown): vscode.CommentReply | undefined {
  if (typeof argument !== 'object' || argument === null
    || !('thread' in argument) || !isNativeThread(argument.thread)
    || !('text' in argument) || typeof argument.text !== 'string'
    || argument.text.length > maximumReviewTextLength || argument.text.includes('\0')) return undefined;
  return { thread: argument.thread, text: argument.text };
}
