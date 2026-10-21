import { locateCodeAnchor, type AnchorLocation } from './anchors.js';
import type { CodeAnchor } from './contracts.js';
import { maximumReviewTextLength } from './limits.js';

/** Normalize line endings while retaining all meaningful code whitespace. */
function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

/** Locate a complete, unambiguous code block without guessing from saved line numbers. */
export function locateCodeBlock(source: string, code: string, anchor?: CodeAnchor): AnchorLocation | undefined {
  if (code.length > maximumReviewTextLength) {
    return undefined;
  }
  const normalizedSource = normalizeLineEndings(source);
  const normalizedCode = normalizeLineEndings(code);
  if (normalizedCode.trim().length === 0) {
    return undefined;
  }
  if (anchor !== undefined && normalizedCode === normalizeLineEndings(anchor.selectedText)) {
    const confirmed = locateCodeAnchor(source, anchor);
    if (confirmed !== undefined) {
      return confirmed;
    }
  }
  const selectedCode = normalizedCode.replace(/\n$/u, '');
  if (anchor !== undefined && selectedCode !== normalizedCode && selectedCode === normalizeLineEndings(anchor.selectedText)) {
    const confirmed = locateCodeAnchor(source, anchor);
    if (confirmed !== undefined) {
      return confirmed;
    }
  }
  let match: number | undefined;
  let offset = normalizedSource.indexOf(selectedCode);
  while (offset !== -1) {
    const end = offset + selectedCode.length;
    if ((offset === 0 || normalizedSource[offset - 1] === '\n')
      && (end === normalizedSource.length || normalizedSource[end] === '\n')) {
      if (match !== undefined) {
        return undefined;
      }
      match = offset;
    }
    offset = normalizedSource.indexOf(selectedCode, offset + 1);
  }
  if (match === undefined) {
    return undefined;
  }
  const startLine = normalizedSource.slice(0, match).split('\n').length;
  return { startLine, endLine: startLine + selectedCode.split('\n').length - 1 };
}
