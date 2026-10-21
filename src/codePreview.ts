import * as path from 'node:path';
import highlight from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import typescript from 'highlight.js/lib/languages/typescript';

highlight.registerLanguage('bash', bash);
highlight.registerLanguage('javascript', javascript);
highlight.registerLanguage('json', json);
highlight.registerLanguage('python', python);
highlight.registerLanguage('typescript', typescript);

const languages: Readonly<Record<string, string>> = {
  '.bash': 'bash', '.sh': 'bash', '.zsh': 'bash',
  '.cjs': 'javascript', '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.py': 'python', '.pyi': 'python', '.pyw': 'python',
  '.cts': 'typescript', '.mts': 'typescript', '.ts': 'typescript', '.tsx': 'typescript',
};
const tokenClasses = new Set([
  'hljs-attr', 'hljs-built_in', 'hljs-char', 'hljs-code', 'hljs-comment', 'hljs-doctag',
  'hljs-keyword', 'hljs-literal', 'hljs-meta', 'hljs-number', 'hljs-operator', 'hljs-params',
  'hljs-property', 'hljs-punctuation', 'hljs-regexp', 'hljs-string', 'hljs-subst', 'hljs-symbol',
  'hljs-title', 'hljs-type', 'hljs-variable',
  'class_', 'constant_', 'escape_', 'function_', 'inherited__', 'invoke__', 'language_', 'prompt_',
]);
const entities: Readonly<Record<string, string>> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };

/** Escape source bytes before they become generated preview markup. */
function escapeCode(code: string): string {
  return code.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#x27;');
}

/** Accept only balanced, known token spans with escaped source text matching the original. */
function safeMarkup(html: string, code: string): boolean {
  let depth = 0;
  let offset = 0;
  let source = '';
  for (const match of html.matchAll(/<[^>]*>|[^<]+/gu)) {
    if (match.index !== offset) return false;
    const part = match[0];
    offset += part.length;
    if (part === '</span>') {
      depth -= 1;
      if (depth < 0) return false;
    } else if (part.startsWith('<')) {
      const classes = /^<span class="([a-z_ -]+)">$/u.exec(part)?.[1]?.split(' ');
      if (classes === undefined || classes.some((token) => !tokenClasses.has(token))) return false;
      depth += 1;
    } else {
      if (part.replace(/&(?:amp|lt|gt|quot|#x27);/gu, '').includes('&')) return false;
      source += part.replace(/&(?:amp|lt|gt|quot|#x27);/gu, (entity) => entities[entity] ?? entity);
    }
  }
  return offset === html.length && depth === 0 && source === code;
}

/** Highlight bounded, known source languages using escaped, allowlisted markup only. */
export function codePreviewHtml(code: string, filePath: string): string {
  const language = languages[path.extname(filePath).toLowerCase()];
  if (language === undefined || code.length > 20_000) return escapeCode(code);
  try {
    const { value } = highlight.highlight(code, { language, ignoreIllegals: true });
    return safeMarkup(value, code) ? value : escapeCode(code);
  } catch {
    return escapeCode(code);
  }
}

/** Editor-like palettes follow VS Code's current light, dark and contrast webview classes. */
export const codePreviewStyles = `
body { --review-code-keyword: #569cd6; --review-code-string: #ce9178; --review-code-comment: #6a9955; --review-code-number: #b5cea8; --review-code-type: #4ec9b0; --review-code-function: #dcdcaa; --review-code-variable: #9cdcfe; --review-code-meta: #c586c0; }
body.vscode-light, body.vscode-high-contrast-light { --review-code-keyword: #0000ff; --review-code-string: #a31515; --review-code-comment: #008000; --review-code-number: #098658; --review-code-type: #267f99; --review-code-function: #795e26; --review-code-variable: #001080; --review-code-meta: #800000; }
body.vscode-high-contrast { --review-code-keyword: #569cd6; --review-code-string: #ce9178; --review-code-comment: #7ca668; --review-code-number: #b5cea8; --review-code-type: #4ec9b0; --review-code-function: #dcdcaa; --review-code-variable: #9cdcfe; --review-code-meta: #d78fde; }
.hljs-keyword, .hljs-literal { color: var(--review-code-keyword); }
.hljs-string, .hljs-regexp, .hljs-char { color: var(--vscode-debugTokenExpression-string, var(--review-code-string)); }
.hljs-comment, .hljs-doctag { color: var(--review-code-comment); }
.hljs-number { color: var(--vscode-debugTokenExpression-number, var(--review-code-number)); }
.hljs-type, .hljs-built_in, .hljs-title.class_ { color: var(--vscode-debugTokenExpression-type, var(--review-code-type)); }
.hljs-title.function_ { color: var(--review-code-function); }
.hljs-property, .hljs-variable, .hljs-attr { color: var(--review-code-variable); }
.hljs-meta { color: var(--review-code-meta); }
.hljs-subst, .hljs-params, .hljs-punctuation, .hljs-operator { color: var(--vscode-editor-foreground); }
`;
