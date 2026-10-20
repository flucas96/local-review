import assert from 'node:assert/strict';
import test from 'node:test';
import { capturedCodeContext, hashDocumentText, locateCodeAnchor } from '../src/anchors.js';
import type { CodeAnchor } from '../src/contracts.js';

/** Capture a full-line review selection with neighboring code for restoration tests. */
function anchor(text: string, startLine: number, endLine = startLine): CodeAnchor {
  const lines = text.split('\n');
  return {
    path: 'src/example.ts', startLine, endLine,
    selectedText: lines.slice(startLine - 1, endLine).join('\n'),
    contextBefore: lines.slice(Math.max(0, startLine - 4), startLine - 1).map((line) => `${line}\n`).join(''),
    contextAfter: lines.slice(endLine, endLine + 3).join('\n'),
    documentHash: hashDocumentText(text), side: 'working', baseRevision: 'a'.repeat(40),
  };
}

test('retains identical-document positions even when complete code blocks repeat', () => {
  const text = 'before\nvalue();\nafter\nbefore\nvalue();\nafter';
  assert.deepEqual(locateCodeAnchor(text, anchor(text, 5)), { startLine: 5, endLine: 5 });
});

test('restores a shifted multiline selection without reusing its old line numbers', () => {
  const text = 'before\nfirst();\nsecond();\nafter';
  const captured = anchor(text, 2, 3);
  assert.deepEqual(locateCodeAnchor(`inserted\n${text}`, captured), { startLine: 3, endLine: 4 });
});

test('uses neighboring code to disambiguate repeated selections', () => {
  const text = 'first\nvalue();\nend-first\nsecond\nvalue();\nend-second';
  assert.deepEqual(locateCodeAnchor(`inserted\n${text}`, anchor(text, 5)), { startLine: 6, endLine: 6 });
});

test('rejects matching code when its surrounding context remains ambiguous', () => {
  const block = 'a\nb\nc\nvalue();\nd\ne\nf';
  const captured = anchor(block, 4);
  assert.equal(locateCodeAnchor(`${block}\n${block}`, captured), undefined);
});

test('does not attach replaced code to the former line number or a substring', () => {
  const captured = anchor('before\nvalue();\nafter', 2);
  assert.equal(locateCodeAnchor('before\nother();\nafter', captured), undefined);
  assert.equal(locateCodeAnchor('before\nnew_value();\nafter', captured), undefined);
});

test('does not mistake a unique reused code fragment with different context for the original', () => {
  const captured = anchor('old function\n}\nold next function', 2);
  assert.equal(locateCodeAnchor('other function\n}\nother next function', captured), undefined);
});

test('tolerates line-ending changes without ignoring code whitespace', () => {
  const text = 'before\n  first();\n  second();\nafter';
  const captured = anchor(text, 2, 3);
  assert.deepEqual(locateCodeAnchor(text.replaceAll('\n', '\r\n'), captured), { startLine: 2, endLine: 3 });
  assert.equal(locateCodeAnchor(text.replace('  first();', 'first();'), captured), undefined);
});

test('does not choose one of several indistinguishable empty lines', () => {
  const captured = anchor('a\nb\nc\n\nd\ne\nf', 4);
  const context = 'a\nb\nc\n\nd\ne\nf';
  assert.equal(locateCodeAnchor(`${context}\n${context}`, captured), undefined);
});

test('requires captured neighboring context before reusing even a unique empty line', () => {
  const captured = anchor('before\n\nafter', 2);
  assert.equal(locateCodeAnchor('other\n\ndifferent', captured), undefined);
  assert.deepEqual(locateCodeAnchor('inserted\nbefore\n\nafter', captured), { startLine: 3, endLine: 3 });
});

test('keeps the saved selection inside a correctly positioned read-only excerpt', () => {
  const text = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join('\n');
  const captured = anchor(text, 9, 10);
  const snapshot = capturedCodeContext(captured);
  assert.equal(snapshot.text, 'line 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13');
  assert.deepEqual({ startLine: snapshot.startLine, endLine: snapshot.endLine }, { startLine: 4, endLine: 5 });
  assert.equal(captured.startLine, 9);
});
