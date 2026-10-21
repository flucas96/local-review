import assert from 'node:assert/strict';
import test from 'node:test';
import { hashDocumentText } from '../src/anchors.js';
import { locateCodeBlock } from '../src/codeLocation.js';
import type { CodeAnchor } from '../src/contracts.js';
import { maximumReviewTextLength } from '../src/limits.js';

/** Capture one complete selected line and its immediate neighbors. */
function capture(source: string, line: number): CodeAnchor {
  const lines = source.split('\n');
  return {
    path: 'src/example.ts',
    startLine: line,
    endLine: line,
    selectedText: lines[line - 1] ?? '',
    contextBefore: line > 1 ? `${lines[line - 2] ?? ''}\n` : '',
    contextAfter: lines[line] ?? '',
    documentHash: hashDocumentText(source),
    side: 'working',
    baseRevision: 'a'.repeat(40),
  };
}

test('locates a unique complete multiline block and removes one fence newline', () => {
  assert.deepEqual(locateCodeBlock('before\nfirst();\nsecond();\nafter', 'first();\nsecond();\n'), {
    startLine: 2, endLine: 3,
  });
  assert.deepEqual(locateCodeBlock('only();', 'only();'), { startLine: 1, endLine: 1 });
});

test('rejects repeated blocks instead of picking the first match', () => {
  assert.equal(locateCodeBlock('before\nvalue();\nafter\nvalue();', 'value();'), undefined);
});

test('requires full lines and preserves indentation', () => {
  assert.equal(locateCodeBlock('prefix value();\nvalue(); suffix', 'value();'), undefined);
  assert.equal(locateCodeBlock('  value();', 'value();'), undefined);
  assert.equal(locateCodeBlock('value();', '  value();'), undefined);
  assert.deepEqual(locateCodeBlock('  value();', '  value();'), { startLine: 1, endLine: 1 });
});

test('normalizes CRLF in source and code without changing positions', () => {
  assert.deepEqual(locateCodeBlock('before\r\n  first();\r\nsecond();\r\nafter', '  first();\r\nsecond();\r\n'), {
    startLine: 2, endLine: 3,
  });
});

test('ignores exactly one trailing fence newline rather than trimming blank code lines', () => {
  assert.equal(locateCodeBlock('value();\nafter', 'value();\n\n'), undefined);
  assert.deepEqual(locateCodeBlock('value();\n\nafter', 'value();\n\n'), { startLine: 1, endLine: 2 });
});

test('uses confirmed surrounding context to disambiguate the captured selection', () => {
  const source = 'first\nvalue();\nend-first\nsecond\nvalue();\nend-second';
  const anchor = capture(source, 5);
  assert.deepEqual(locateCodeBlock(`inserted\n${source}`, 'value();\n', anchor), { startLine: 6, endLine: 6 });
});

test('can retain an exact document anchor when identical surrounding context repeats', () => {
  const source = 'before\nvalue();\nafter\nbefore\nvalue();\nafter';
  assert.deepEqual(locateCodeBlock(source, 'value();', capture(source, 5)), { startLine: 5, endLine: 5 });
});

test('preserves a captured final blank line before stripping a fence newline', () => {
  const source = 'before\nvalue();\n\nafter\nbefore\nvalue();\n\nafter';
  const anchor: CodeAnchor = {
    ...capture(source, 6), selectedText: 'value();\n', endLine: 7,
    contextBefore: 'before\n', contextAfter: 'after',
  };
  assert.deepEqual(locateCodeBlock(source, anchor.selectedText, anchor), { startLine: 6, endLine: 7 });
});

test('uses unique captured context for a final blank line after source lines move', () => {
  const source = 'first\nvalue();\n\nend-first\nsecond\nvalue();\n\nend-second';
  const anchor: CodeAnchor = {
    ...capture(source, 6), selectedText: 'value();\n', endLine: 7,
    contextBefore: 'second\n', contextAfter: 'end-second',
  };
  assert.deepEqual(locateCodeBlock(`inserted\n${source}`, anchor.selectedText, anchor), { startLine: 7, endLine: 8 });
});

test('never uses stale line numbers when code was replaced or its context is ambiguous', () => {
  const anchor = capture('before\nvalue();\nafter', 2);
  assert.equal(locateCodeBlock('before\nother();\nafter', 'value();', anchor), undefined);
  assert.equal(locateCodeBlock('before\nvalue();\nafter\nbefore\nvalue();\nafter', 'value();', anchor), undefined);
});

test('does not use an anchor to disambiguate a different suggested code block', () => {
  const source = 'before\nvalue();\nafter\nother();\nother();';
  assert.equal(locateCodeBlock(source, 'other();', capture(source, 2)), undefined);
});

test('rejects empty, whitespace, missing and oversized blocks', () => {
  assert.equal(locateCodeBlock('source', ''), undefined);
  assert.equal(locateCodeBlock(' \n\t', ' \n\t\n'), undefined);
  assert.equal(locateCodeBlock('source', 'missing'), undefined);
  const oversized = 'x'.repeat(maximumReviewTextLength + 1);
  assert.equal(locateCodeBlock(oversized, oversized), undefined);
});
