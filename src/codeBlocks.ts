import { maximumReplyLength, maximumReviewTextLength } from './limits.js';

/** A fenced code snippet in its original order, without its Markdown delimiters. */
export interface CodeBlock {
  index: number;
  code: string;
  language: string;
}

interface FencedBlock extends CodeBlock {
  markerEnd: number;
  start: number;
  end: number;
  closed: boolean;
  fence: string;
}

interface MarkdownLine {
  text: string;
  start: number;
  end: number;
}

function* lines(markdown: string): Generator<MarkdownLine> {
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const end = newline < 0 ? markdown.length : newline + 1;
    const contentEnd = newline < 0 ? end : newline;
    const text = markdown.slice(start, contentEnd).replace(/\r$/, '');
    yield { text, start, end };
    start = end;
  }
}

function fallbackToken(language: string | undefined): string {
  const token = language?.trim() ?? '';
  return /^[\w#+.-]{1,64}$/u.test(token) ? token : '';
}

function fencedBlocks(markdown: string): FencedBlock[] {
  if (markdown.length > maximumReviewTextLength) return [];
  const blocks: FencedBlock[] = [];
  let opening: { marker: string; length: number; codeStart: number; markerEnd: number; language: string; start: number } | undefined;
  for (const line of lines(markdown)) {
    if (opening !== undefined) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u.exec(line.text)?.[1];
      if (closing?.[0] === opening.marker && closing.length >= opening.length) {
        blocks.push({
          index: blocks.length, code: markdown.slice(opening.codeStart, line.start),
          language: opening.language, markerEnd: opening.markerEnd,
          start: opening.start, end: line.end,
          closed: true, fence: opening.marker.repeat(opening.length),
        });
        opening = undefined;
      }
      continue;
    }
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line.text);
    const indentation = match?.[1];
    const fence = match?.[2];
    const info = match?.[3];
    if (indentation === undefined || fence === undefined || info === undefined) continue;
    if (fence[0] === '`' && info.includes('`')) continue;
    opening = {
      marker: fence[0] ?? '', length: fence.length, codeStart: line.end,
      markerEnd: line.start + indentation.length + fence.length,
      language: info.trim().split(/\s/u, 1)[0] ?? '',
      start: line.start,
    };
  }
  if (opening !== undefined) {
    blocks.push({
      index: blocks.length, code: markdown.slice(opening.codeStart),
      language: opening.language, markerEnd: opening.markerEnd,
      start: opening.start, end: markdown.length,
      closed: false, fence: opening.marker.repeat(opening.length),
    });
  }
  return blocks;
}

/**
 * Read fenced snippets without changing code whitespace or line endings.
 * Unclosed fences extend to the end; oversized messages are left as plain text.
 */
export function readCodeBlocks(markdown: string, fallbackLanguage?: string): CodeBlock[] {
  const fallback = fallbackToken(fallbackLanguage);
  return fencedBlocks(markdown).map(({ index, code, language }) => ({ index, code, language: language || fallback }));
}

/** Add a safe fallback language to unlabeled fences for display, preserving all other bytes. */
export function withCodeBlockLanguages(markdown: string, fallbackLanguage: string): string {
  const fallback = fallbackToken(fallbackLanguage);
  if (fallback === '') return markdown;
  const unlabeled = fencedBlocks(markdown).filter(block => block.language === '');
  let result = '';
  let start = 0;
  for (const block of unlabeled) {
    result += markdown.slice(start, block.markerEnd) + fallback;
    start = block.markerEnd;
  }
  return result + markdown.slice(start);
}

/** Neutralize original HTML while preserving single-line inline code, autolinks, entities, and blockquotes. */
function escapeProseHtml(markdown: string): string {
  let escaped = '';
  let offset = 0;
  while (offset < markdown.length) {
    if (markdown[offset] === '`') {
      let precedingSlashes = 0;
      for (let index = offset - 1; index >= 0 && markdown[index] === '\\'; index -= 1) precedingSlashes += 1;
      if (precedingSlashes % 2 === 1) {
        escaped += '`';
        offset += 1;
        continue;
      }
      let end = offset + 1;
      while (markdown[end] === '`') end += 1;
      const fence = markdown.slice(offset, end);
      let closing = markdown.indexOf(fence, end);
      while (closing >= 0 && (markdown[closing - 1] === '`' || markdown[closing + fence.length] === '`')) {
        closing = markdown.indexOf(fence, closing + fence.length);
      }
      if (closing >= 0) {
        const span = markdown.slice(offset, closing + fence.length);
        escaped += /[\r\n]/u.test(span) ? span.replaceAll('<', '&lt;') : span;
        offset = closing + fence.length;
        continue;
      }
      escaped += fence;
      offset = end;
      continue;
    }
    if (markdown[offset] === '<') {
      const link = /^<(?:[A-Za-z][A-Za-z\d+.-]{1,31}:[^<>\s]*|[A-Za-z\d.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z\d](?:[A-Za-z\d.-]*[A-Za-z\d])?)>/u.exec(markdown.slice(offset))?.[0];
      if (link !== undefined) {
        escaped += link;
        offset += link.length;
        continue;
      }
      escaped += '&lt;';
    } else {
      escaped += markdown[offset];
    }
    offset += 1;
  }
  return escaped;
}

/** Escape a generated HTML header as plain text, including theme-icon syntax. */
function cardTitle(text: string): string {
  return text.slice(0, 512).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('$', '&#36;').replace(/[\r\n]/gu, ' ');
}

/**
 * Wrap fenced code in theme-aware native-comment cards and neutralize all original HTML.
 * Generated markup is display-only; navigation must continue reading undecorated Markdown.
 */
export function withCodeBlockCards(
  markdown: string,
  fallbackLanguage: string,
  headerForBlock: (block: CodeBlock) => string = block => block.language || 'Code',
): string {
  const display = withCodeBlockLanguages(markdown, fallbackLanguage);
  let result = '';
  let copied = 0;
  for (const block of fencedBlocks(display)) {
    const newline = display.slice(block.start, block.end).includes('\r\n') ? '\r\n' : '\n';
    let fenced = display.slice(block.start, block.end);
    if (!block.closed) fenced += (fenced.endsWith('\n') ? '' : newline) + block.fence;
    const header = cardTitle(headerForBlock({ index: block.index, code: block.code, language: block.language }));
    // Native Markdown strips CSS borders and padding; approved layout-cell spacing supplies both.
    result += escapeProseHtml(display.slice(copied, block.start))
      + '<div><span style="background-color:var(--vscode-editorWidget-border);display:inline-block;border-radius:6px;"><table><tr><td>'
      + '<span style="background-color:var(--vscode-editor-background);display:inline-block;border-radius:5px;"><table>'
      + '<tr><td width="8"></td><td height="4"></td><td width="8"></td></tr><tr><td></td><td>'
      + '<span style="color:var(--vscode-descriptionForeground);">' + header + '</span>'
      + newline + newline + fenced + newline + newline
      + '</td><td></td></tr><tr><td></td><td height="4"></td><td></td></tr></table></span></td></tr></table></span>'
      + newline + '</div>' + newline + newline;
    copied = block.end;
  }
  return result + escapeProseHtml(display.slice(copied));
}

interface CodeToken {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Tokenize bounded candidates without evaluating code or interpreting quoted delimiters. */
function codeTokens(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let offset = 0;
  while (offset < code.length) {
    const start = offset;
    const character = code[offset] ?? '';
    if (/\s/u.test(character)) {
      offset += 1;
      continue;
    }
    if (code.startsWith('//', offset)) {
      const newline = code.indexOf('\n', offset + 2);
      offset = newline < 0 ? code.length : newline + 1;
      continue;
    }
    if (code.startsWith('/*', offset)) {
      const closing = code.indexOf('*/', offset + 2);
      if (closing < 0) break;
      offset = closing + 2;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      offset += 1;
      let closed = false;
      while (offset < code.length) {
        const next = code[offset];
        if (next === '\\') {
          offset += 2;
        } else if (next === character) {
          offset += 1;
          closed = true;
          break;
        } else if (character !== '`' && (next === '\n' || next === '\r')) {
          break;
        } else {
          offset += 1;
        }
      }
      if (!closed) break;
    } else if (/[\w$]/u.test(character)) {
      offset += 1;
      while (offset < code.length && /[\w$]/u.test(code[offset] ?? '')) offset += 1;
    } else {
      offset += 1;
    }
    tokens.push({ value: code.slice(start, offset), start, end: offset });
  }
  return tokens;
}

function identifier(token: CodeToken | undefined): boolean {
  return token !== undefined && /^[A-Za-z_$][\w$]*$/u.test(token.value);
}

/** Recognize quoted import declarations rather than prose beginning with the word import. */
function importEnd(tokens: readonly CodeToken[], start: number): number | undefined {
  let index = start + 1;
  const quoted = (token: CodeToken | undefined): boolean => token !== undefined && /^["']/u.test(token.value);
  if (!quoted(tokens[index])) {
    if (tokens[index]?.value === 'type') index += 1;
    let hasBinding = false;
    if (identifier(tokens[index]) && tokens[index]?.value !== 'from') {
      hasBinding = true;
      index += 1;
      if (tokens[index]?.value === ',') index += 1;
    }
    if (tokens[index]?.value === '{') {
      hasBinding = true;
      index += 1;
      while (tokens[index]?.value !== '}') {
        if (tokens[index]?.value === 'type' && identifier(tokens[index + 1])) index += 1;
        if (!identifier(tokens[index])) return undefined;
        index += 1;
        if (tokens[index]?.value === 'as') {
          index += 1;
          if (!identifier(tokens[index])) return undefined;
          index += 1;
        }
        if (tokens[index]?.value === ',') index += 1;
        else if (tokens[index]?.value !== '}') return undefined;
      }
      index += 1;
    } else if (tokens[index]?.value === '*') {
      hasBinding = true;
      if (tokens[index + 1]?.value !== 'as' || !identifier(tokens[index + 2])) return undefined;
      index += 3;
    }
    if (!hasBinding || tokens[index]?.value !== 'from' || !quoted(tokens[index + 1])) return undefined;
    index += 1;
  }
  index += 1;
  return tokens[index]?.value === ';' ? index + 1 : index;
}

/** Match delimiters while string and comment contents remain opaque. */
function groupEnd(tokens: readonly CodeToken[], start: number): number | undefined {
  const closing: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index]?.value ?? '';
    const expected = Object.hasOwn(closing, value) ? closing[value] : undefined;
    if (expected !== undefined) stack.push(expected);
    else if (value === ')' || value === ']' || value === '}') {
      if (stack.pop() !== value) return undefined;
      if (stack.length === 0) return index + 1;
    }
  }
  return undefined;
}

function declarationEnd(tokens: readonly CodeToken[], start: number): number | undefined {
  if (tokens[start]?.value === 'import') return importEnd(tokens, start);
  if (tokens[start]?.value !== 'export') return undefined;
  let index = start + 1;
  if (tokens[index]?.value === 'default') index += 1;
  if (tokens[index]?.value === 'async') index += 1;
  if (tokens[index]?.value !== 'function') return undefined;
  index += 1;
  if (tokens[index]?.value === '*') index += 1;
  if (!identifier(tokens[index]) || tokens[index + 1]?.value !== '(') return undefined;
  const parametersEnd = groupEnd(tokens, index + 1);
  if (parametersEnd === undefined || tokens[parametersEnd]?.value !== '{') return undefined;
  const bodyEnd = groupEnd(tokens, parametersEnd);
  if (bodyEnd === undefined) return undefined;
  return tokens[bodyEnd]?.value === ';' ? bodyEnd + 1 : bodyEnd;
}

/** Recognize complete standalone declarations, including adjacent code paragraphs. */
function detectedCodeEnd(text: string): number | undefined {
  const tokens = codeTokens(text.slice(0, maximumReplyLength));
  let index = 0;
  let end: number | undefined;
  while (index < tokens.length) {
    const next = declarationEnd(tokens, index);
    if (next === undefined) break;
    end = tokens[next - 1]?.end;
    if (end === undefined) return undefined;
    const nextStart = tokens[next]?.start ?? text.length;
    const gap = text.slice(end, nextStart);
    if (gap.trim().length !== 0) break;
    index = next;
  }
  if (end === undefined) return undefined;
  const rest = text.slice(end);
  if (!/^(?:[\t ]*(?:\r?\n[\t ]*){2}|[\t \r\n]*$)/u.test(rest)) return undefined;
  return end + (/^[\t ]*/u.exec(rest)?.[0].length ?? 0);
}

/** Repair only obvious standalone JS/TS import and exported-function paragraphs for display. */
export function withDetectedCodeBlocks(markdown: string, fallbackLanguage: string): string {
  if (markdown.length > maximumReviewTextLength) return markdown;
  const requested = fallbackToken(fallbackLanguage).toLowerCase();
  const language = requested === 'typescript' || requested === 'ts' || requested === 'typescriptreact' || requested === 'tsx'
    ? 'typescript' : 'javascript';
  const protectedBlocks = fencedBlocks(markdown);
  let result = '';
  let copied = 0;
  let protectedIndex = 0;
  let previousBlank = true;
  let attempts = 0;
  for (const line of lines(markdown)) {
    const protectedBlock = protectedBlocks[protectedIndex];
    if (protectedBlock !== undefined && line.start >= protectedBlock.end) protectedIndex += 1;
    const currentBlock = protectedBlocks[protectedIndex];
    if (line.start < copied || (currentBlock !== undefined && line.start >= currentBlock.start && line.start < currentBlock.end)) {
      previousBlank = line.text.trim().length === 0;
      continue;
    }
    if (previousBlank && /^ {0,3}(?:import\s|export\s+(?:default\s+)?(?:async\s+)?function\b)/u.test(line.text) && attempts < 64) {
      attempts += 1;
      const limit = currentBlock?.start ?? markdown.length;
      const candidate = markdown.slice(line.start, limit);
      const detectedEnd = detectedCodeEnd(candidate);
      if (detectedEnd !== undefined) {
        const end = line.start + detectedEnd;
        const code = markdown.slice(line.start, end);
        const newline = code.includes('\r\n') ? '\r\n' : '\n';
        result += markdown.slice(copied, line.start) + '~~~' + language + newline + code + newline + '~~~';
        copied = end;
      }
    }
    previousBlank = line.text.trim().length === 0;
  }
  return result + markdown.slice(copied);
}
