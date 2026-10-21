import assert from 'node:assert/strict';
import test from 'node:test';

import { codePreviewHtml } from '../src/codePreview.js';

/** Recover preview source after removing only generated span markup. */
function sourceText(html: string): string {
  const entities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };
  return html.replace(/<\/?span(?: class="[a-z_ -]+")?>/gu, '')
    .replace(/&(?:amp|lt|gt|quot|#x27);/gu, (entity) => entities[entity] ?? entity);
}

test('Python preview highlights decorators, strings, definitions and types without changing indentation', () => {
  const code = '@field_validator("days")\n@classmethod\ndef validate_days(cls, days: int) -> int:\n    """Keep the selected range valid."""\n    return max(1, days)\n';
  const html = codePreviewHtml(code, 'src/review_lab/models.py');
  assert.match(html, /class="hljs-meta">@field_validator/u);
  assert.match(html, /class="hljs-string">&quot;days&quot;/u);
  assert.match(html, /class="hljs-keyword">def/u);
  assert.match(html, /class="hljs-title function_">validate_days/u);
  assert.match(html, /class="hljs-built_in">int/u);
  assert.equal(sourceText(html), code);
});

test('source that resembles active HTML remains escaped inside every highlighted language', () => {
  const code = 'value = "</code><img src=x onerror=alert(1)><script>bad()</script>&amp;"\r\n';
  for (const extension of ['py', 'js', 'ts', 'json', 'sh']) {
    const html = codePreviewHtml(code, `example.${extension}`);
    assert.doesNotMatch(html, /<(?!\/?span\b)/u);
    assert.doesNotMatch(html, /<span[^>]*(?:onerror|style|src)=/u);
    assert.equal(sourceText(html), code);
  }
});

test('known filename variants select a grammar and unsupported files remain plain source', () => {
  for (const extension of ['PY', 'pyi', 'pyw']) {
    assert.match(codePreviewHtml('return False', `example.${extension}`), /class="hljs-keyword">return/u);
  }
  for (const extension of ['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx']) {
    assert.match(codePreviewHtml('const result = 2;', `example.${extension}`), /class="hljs-keyword">const/u);
  }
  const code = 'if x < 2 & y > 1\n  "Unrecognized language"';
  const html = codePreviewHtml(code, 'example.unknown');
  assert.doesNotMatch(html, /<span/u);
  assert.equal(sourceText(html), code);
});

test('large source and incomplete selections stay intact without blocking on syntax detection', () => {
  const large = 'x = "<value>"\n'.repeat(2_000);
  const html = codePreviewHtml(large, 'large.py');
  assert.doesNotMatch(html, /<span/u);
  assert.equal(sourceText(html), large);
  for (const code of ['', '@field_validator("days")', 'def validate(', '    """unfinished', '𝛑 = "🦆"\r\n']) {
    assert.equal(sourceText(codePreviewHtml(code, 'snippet.py')), code);
  }
});
