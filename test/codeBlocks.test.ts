import assert from 'node:assert/strict';
import test from 'node:test';
import { readCodeBlocks, withCodeBlockLanguages, withDetectedCodeBlocks } from '../src/codeBlocks.js';
import { maximumReviewTextLength } from '../src/limits.js';

test('extracts language-tagged code in message order without inline code or prose', () => {
  const markdown = 'Inspect `retry()` first.\n\n```javascript title="retry.js"\nconst retry = () => 1;\n```\nThen:\n~~~python\nprint("done")\n~~~';
  assert.deepEqual(readCodeBlocks(markdown), [
    { index: 0, code: 'const retry = () => 1;\n', language: 'javascript' },
    { index: 1, code: 'print("done")\n', language: 'python' },
  ]);
});

test('uses a fallback only for unlabeled fences and preserves original Markdown bytes', () => {
  const markdown = 'A\n  ```  \n  retry();\n ```\n\n~~~python extra\nprint(1)\n~~~\n~~~\n  done();\n~~~\n';
  assert.deepEqual(readCodeBlocks(markdown, 'typescript'), [
    { index: 0, code: '  retry();\n', language: 'typescript' },
    { index: 1, code: 'print(1)\n', language: 'python' },
    { index: 2, code: '  done();\n', language: 'typescript' },
  ]);
  assert.equal(withCodeBlockLanguages(markdown, 'typescript'),
    'A\n  ```typescript  \n  retry();\n ```\n\n~~~python extra\nprint(1)\n~~~\n~~~typescript\n  done();\n~~~\n');
  assert.equal(markdown, 'A\n  ```  \n  retry();\n ```\n\n~~~python extra\nprint(1)\n~~~\n~~~\n  done();\n~~~\n');
});

test('keeps shorter or mismatched fences and non-closing delimiter lines inside code', () => {
  const markdown = '````js\n```\n~~~\n```` text\n    ````\nconst n = 1;\n`````\n';
  assert.deepEqual(readCodeBlocks(markdown), [{
    index: 0, code: '```\n~~~\n```` text\n    ````\nconst n = 1;\n', language: 'js',
  }]);
});

test('preserves CRLF, trailing whitespace, blank lines, and indented code exactly', () => {
  const markdown = 'Before\r\n ```\r\n\tconst a = 1;  \r\n\r\n  return a;\r\n ```\r\nAfter';
  assert.deepEqual(readCodeBlocks(markdown, 'js'), [{
    index: 0, code: '\tconst a = 1;  \r\n\r\n  return a;\r\n', language: 'js',
  }]);
  assert.equal(withCodeBlockLanguages(markdown, 'js'), markdown.replace(' ```\r\n', ' ```js\r\n'));
});

test('treats an unclosed fence as code through the end without inventing a newline', () => {
  const markdown = 'Before\n~~~ c++\nint main() {\n  return 0;\n}';
  assert.deepEqual(readCodeBlocks(markdown), [{
    index: 0, code: 'int main() {\n  return 0;\n}', language: 'c++',
  }]);
  assert.equal(withCodeBlockLanguages(markdown, 'js'), markdown);
  assert.equal(withCodeBlockLanguages('```', 'js'), '```js');
});

test('retains empty blocks with stable indexes', () => {
  assert.deepEqual(readCodeBlocks('```\n```\n~~~js\n~~~\n```'), [
    { index: 0, code: '', language: '' },
    { index: 1, code: '', language: 'js' },
    { index: 2, code: '', language: '' },
  ]);
});

test('ignores inline delimiters, four-space indentation, and invalid backtick info', () => {
  const markdown = 'Inline ```example```\n    ```js\n    text\n    ```\n```js `invalid`\nnormal text';
  assert.deepEqual(readCodeBlocks(markdown), []);
  assert.equal(withCodeBlockLanguages(markdown, 'js'), markdown);
});

test('leaves prose and explicitly labeled fences unchanged', () => {
  const prose = 'The value is `undefined`.\n\nTry retry.js:8.';
  assert.equal(withCodeBlockLanguages(prose, 'javascript'), prose);
  assert.deepEqual(readCodeBlocks(prose), []);
  const labeled = '```typescript\nretry();\n```';
  assert.equal(withCodeBlockLanguages(labeled, 'javascript'), labeled);
});

test('rejects fallback text that could introduce Markdown syntax', () => {
  const markdown = '```\nretry();\n```';
  for (const language of ['', 'js\nmalicious', 'js title=x', '`js`', 'x'.repeat(65)]) {
    assert.equal(withCodeBlockLanguages(markdown, language), markdown);
    assert.equal(readCodeBlocks(markdown, language)[0]?.language, '');
  }
  assert.equal(readCodeBlocks(markdown, ' c# ')[0]?.language, 'c#');
});

test('bounds parsing without truncating oversized display content', () => {
  const markdown = '```\n' + 'x'.repeat(maximumReviewTextLength) + '\n```';
  assert.deepEqual(readCodeBlocks(markdown, 'js'), []);
  assert.equal(withCodeBlockLanguages(markdown, 'js'), markdown);
});

test('repairs the unfenced import and flattened exported function from an agent response', () => {
  const code = "import { setTimeout as delay } from 'node:timers/promises';\n\nexport async function withRetry(operation) { for (let attempt = 1; attempt <= 3; attempt++) { try { return await operation(); } catch (error) { if (attempt === 3) throw error; await delay(1000); } } }";
  const markdown = `Du kannst das so lösen:\n\n${code}\n\nVerhalten: maximal drei Versuche.`;
  const repaired = withDetectedCodeBlocks(markdown, 'javascript');
  assert.equal(repaired, `Du kannst das so lösen:\n\n~~~javascript\n${code}\n~~~\n\nVerhalten: maximal drei Versuche.`);
  assert.equal(withDetectedCodeBlocks(repaired, 'javascript'), repaired);
  assert.deepEqual(readCodeBlocks(repaired), [{ index: 0, code: `${code}\n`, language: 'javascript' }]);
  assert.equal(markdown, `Du kannst das so lösen:\n\n${code}\n\nVerhalten: maximal drei Versuche.`);
});

test('recognizes multiline exported functions while keeping quoted and commented delimiters opaque', () => {
  const code = 'export async function example(operation: () => unknown) {\n  // Ignore } and ) here.\n  const label = "} ] )";\n\n  /* Preserve { and ] in comments. */\n  const template = `value: ${label}`;\n  return operation();\n}';
  const markdown = `Before.\n\n${code}\n\nAfter.`;
  assert.equal(withDetectedCodeBlocks(markdown, 'typescript'), `Before.\n\n~~~typescript\n${code}\n~~~\n\nAfter.`);
});

test('handles ordinary property identifiers without mistaking object prototype names for delimiters', () => {
  const code = 'export function example(value) { return value.toString(); }';
  assert.equal(withDetectedCodeBlocks(code, 'javascript'), `~~~javascript\n${code}\n~~~`);
});

test('recognizes common import forms and preserves source ending in a newline', () => {
  const code = "import 'side-effect';\nimport value from 'default';\nimport value, { type Item, retry as again } from 'named';\nimport * as tools from 'namespace';\n";
  const repaired = withDetectedCodeBlocks(code, 'ts');
  assert.equal(repaired, `~~~typescript\n${code.trimEnd()}\n~~~\n`);
  assert.deepEqual(readCodeBlocks(repaired), [{ index: 0, code, language: 'typescript' }]);
});

test('keeps ordinary prose, inline mentions, lists, and mixed code-prose paragraphs unchanged', () => {
  const cases = [
    'Import this value from another file.',
    'import the new value from your project.',
    'export async function describes an asynchronous export.',
    'Use export async function retry() { return 1; } for clarity.',
    '- export async function retry() { return 1; }',
    'export async function retry() { return 1; }\nThis is an explanation.',
    "import { retry } from 'module'; This explanation follows on the same line.",
    "import from 'module';",
  ];
  for (const markdown of cases) assert.equal(withDetectedCodeBlocks(markdown, 'javascript'), markdown);
});

test('does not repair incomplete declarations, strings, comments, or delimiter groups', () => {
  const cases = [
    'export async function retry() {\n return 1;',
    'export function retry() { return "unterminated; }',
    'export function retry() { /* unterminated }',
    'export function retry() { return [1, 2); }',
    "import { retry from 'module';",
    "import { retry } from 'unterminated;",
  ];
  for (const markdown of cases) assert.equal(withDetectedCodeBlocks(markdown, 'javascript'), markdown);
});

test('preserves existing fenced code and detects only separate unfenced declarations', () => {
  const existing = "```text\nimport { example } from 'module';\n\nexport function example() { return 1; }\n```";
  const code = 'export function other() { return 2; }';
  const markdown = `${existing}\n\nSeparate example:\n\n${code}`;
  assert.equal(withDetectedCodeBlocks(markdown, 'javascript'), `${existing}\n\nSeparate example:\n\n~~~javascript\n${code}\n~~~`);
  const unclosed = `~~~text\n${code}`;
  assert.equal(withDetectedCodeBlocks(unclosed, 'javascript'), unclosed);
});

test('preserves CRLF and horizontal whitespace when adding display-only fences', () => {
  const code = "import { retry } from 'module';  \r\n\r\nexport function example() {\r\n  return retry();\r\n}\t";
  const markdown = `Before.\r\n\r\n${code}\r\n\r\nAfter.`;
  assert.equal(withDetectedCodeBlocks(markdown, 'javascript'), `Before.\r\n\r\n~~~javascript\r\n${code}\r\n~~~\r\n\r\nAfter.`);
});

test('keeps apparent existing fences intact even inside an unfenced code-looking comment', () => {
  const code = 'export function example() {\n  /*\n~~~\n  */\n  return 1;\n}';
  assert.equal(withDetectedCodeBlocks(code, 'javascript'), code);
});

test('bounds detection and leaves oversized source text unchanged', () => {
  const markdown = `export function example() { return 1; }\n\n${'x'.repeat(maximumReviewTextLength)}`;
  assert.equal(withDetectedCodeBlocks(markdown, 'javascript'), markdown);
});
