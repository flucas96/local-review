import assert from 'node:assert/strict';
import test from 'node:test';
import { CodeReferences, openCodeCommand } from '../src/codeReferences.js';
import type { ReviewMessage, ReviewThread } from '../src/contracts.js';

/** Create immutable review identities without involving VS Code or persistence. */
function fixture(text: string, author: ReviewMessage['author'] = 'claude'): { thread: ReviewThread; message: ReviewMessage } {
  const message: ReviewMessage = {
    id: 'message-1', author, text, createdAt: '2026-10-21T10:00:00.000Z',
  };
  const thread: ReviewThread = {
    id: 'thread-1',
    anchor: {
      path: 'src/private-path.ts', startLine: 4, endLine: 4,
      selectedText: 'privateSource();', contextBefore: '', contextAfter: '',
      documentHash: 'hash', side: 'working', baseRevision: 'a'.repeat(40),
    },
    messages: [message], intent: 'ask', status: 'answered', resolved: false, outdated: false,
    latestEventId: 'event-1',
  };
  return { thread, message };
}

/** Decode generated command arguments exactly as VS Code would pass them. */
function handles(markdown: string): unknown[] {
  return [...markdown.matchAll(/\]\(command:localReview\.openCode\?([^\s)]+)(?: "[^"]*")?\)/gu)]
    .flatMap((match) => JSON.parse(decodeURIComponent(match[1] ?? '')) as unknown[]);
}

test('generates opaque handles that resolve only to stored identities', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('```typescript\nconst secret = 1;\n```');
  const rendered = references.render(thread, message, 'javascript');
  const [handle] = handles(rendered);
  assert.match(rendered, /^\[\$\(go-to-file\)\]\(command:localReview\.openCode\?\S+ "Code im Editor öffnen"\)/u);
  assert.equal(openCodeCommand, 'localReview.openCode');
  assert.match(String(handle), /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u);
  assert.deepEqual(references.resolve(handle), { threadId: thread.id, messageId: message.id, blockIndex: 0 });
  assert.equal(String(handle).includes('secret'), false);
  assert.equal(String(handle).includes(thread.anchor.path), false);
  assert.equal(String(handle).includes(thread.id), false);
  assert.equal(String(handle).includes(message.id), false);
});

test('reuses handles for stable rerenders while keeping messages distinct', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('```\nvalue();\n```');
  const first = references.render(thread, message, 'typescript');
  assert.deepEqual(handles(references.render(thread, message, 'javascript')), handles(first));
  const another = { ...message, id: 'message-2' };
  const [different] = handles(references.render(thread, another, 'typescript'));
  assert.notEqual(different, handles(first)[0]);
  assert.deepEqual(references.resolve(different), { threadId: thread.id, messageId: another.id, blockIndex: 0 });
});

test('rejects unknown handles, caller-constructed identities and disposed handles', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('```\nvalue();\n```');
  const [handle] = handles(references.render(thread, message, 'typescript'));
  for (const invalid of [undefined, null, 0, [], {}, { threadId: thread.id, messageId: message.id, blockIndex: 0 }, 'message-1', 'unknown']) {
    assert.equal(references.resolve(invalid), undefined);
  }
  const otherSession = new CodeReferences();
  assert.equal(otherSession.resolve(handle), undefined);
  references.dispose();
  assert.equal(references.resolve(handle), undefined);
});

test('adds a context action to Claude prose while preserving human prose exactly', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('Please inspect `retry()` in the selected code.');
  const rendered = references.render(thread, message, 'javascript');
  assert.match(rendered, /^\[\$\(go-to-file\)\]\(command:localReview\.openCode\?\S+ "Codekontext im Editor öffnen"\)/u);
  assert.equal(rendered.endsWith(message.text), true);
  assert.deepEqual(references.resolve(handles(rendered)[0]), { threadId: thread.id, messageId: message.id });
  assert.equal(references.render(thread, { ...message, author: 'human' }, 'javascript'), message.text);
});

test('adds a display-only fallback language without mutating durable review text', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('Inspect this:\n```\nvalue();\n```', 'human');
  const before = JSON.stringify(thread);
  const rendered = references.render(thread, message, 'typescript');
  assert.ok(rendered.startsWith('[$(go-to-file)]'));
  assert.ok(rendered.includes('Inspect this:'));
  assert.ok(rendered.includes('```typescript\nvalue();\n```'));
  assert.equal(JSON.stringify(thread), before);
  assert.deepEqual(references.resolve(handles(rendered)[0]), { threadId: thread.id, messageId: message.id, blockIndex: 0 });
});

test('repairs legacy declarations into one code box and preserves mixed block action indexes', () => {
  const references = new CodeReferences();
  const code = "import { setTimeout as delay } from 'node:timers/promises';\n\nexport async function withRetry(operation) { return operation(); }";
  const { thread, message } = fixture(`Implemented:\n\n${code}\n\nMore context.\n\n\`\`\`python\nprint('done')\n\`\`\``);
  const before = JSON.stringify(thread);
  const rendered = references.render(thread, message, 'javascript');
  assert.ok(rendered.includes(`~~~javascript\n${code}\n~~~`));
  assert.ok(rendered.includes('More context.'));
  assert.equal(JSON.stringify(thread), before);
  const actions = handles(rendered);
  assert.match(rendered, /^\[\$\(go-to-file\) 1\]\(command:localReview\.openCode\?\S+ "Code 1 im Editor öffnen"\) · \[\$\(go-to-file\) 2\]\(command:localReview\.openCode\?\S+ "Code 2 im Editor öffnen"\)/u);
  assert.deepEqual(actions.map((handle) => references.resolve(handle)?.blockIndex), [0, 1]);
});

test('skips empty blocks, preserves original indexes and caps actions at twenty', () => {
  const references = new CodeReferences();
  const nonempty = Array.from({ length: 23 }, (_, index) => `\`\`\`js\nvalue${index}();\n\`\`\``);
  const { thread, message } = fixture(['```\n```', '~~~\n \t\n~~~', ...nonempty].join('\n'));
  const rendered = references.render(thread, message, 'typescript');
  const generated = handles(rendered);
  assert.equal(generated.length, 20);
  assert.equal(references.resolve(generated[0])?.blockIndex, 2);
  assert.equal(references.resolve(generated.at(-1))?.blockIndex, 21);
  assert.equal(rendered.includes('Codekontext im Editor öffnen'), false);
  const empty = fixture('```\n \t\n```');
  assert.equal(handles(references.render(empty.thread, empty.message, 'js')).length, 0);
});

test('prepends clickable actions before unclosed fences', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('Before\n```\nconst value = 1;');
  const rendered = references.render(thread, message, 'typescript');
  assert.equal(rendered.startsWith('[$(go-to-file)](command:'), true);
  assert.equal(rendered.indexOf('](command:') < rendered.indexOf('```typescript'), true);
  assert.ok(rendered.includes('Before\n'));
  assert.ok(rendered.includes('```typescript\nconst value = 1;\n```'));
  assert.deepEqual(references.resolve(handles(rendered)[0]), { threadId: thread.id, messageId: message.id, blockIndex: 0 });
});

test('original command links do not become extension-owned handles', () => {
  const references = new CodeReferences();
  const attackerHandle = 'caller-constructed-handle';
  const malicious = `[Pretend](command:${openCodeCommand}?${encodeURIComponent(JSON.stringify([attackerHandle]))})`;
  const { thread, message } = fixture(`${malicious}\n\n\`\`\`js\nvalue();\n\`\`\``);
  const rendered = references.render(thread, message, 'javascript');
  assert.equal(rendered.includes(malicious), true);
  assert.equal(references.resolve(attackerHandle), undefined);
  assert.equal(references.resolve(handles(rendered)[0])?.blockIndex, 0);
});

test('enables only generated card markup while preserving source and neutralizing model HTML', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('<img src="https://example.invalid/track">\n\n```html\n<div>source</div>\n```');
  const before = JSON.stringify(thread);
  const rendered = references.render(thread, message, 'html');
  assert.ok(rendered.includes('&lt;img'));
  assert.ok(!rendered.includes('<img'));
  assert.ok(rendered.includes('<span style="background-color:var(--vscode-editor-background);display:inline-block;border-radius:5px;">'));
  assert.ok(rendered.includes('```html\n<div>source</div>\n```'));
  assert.equal(JSON.stringify(thread), before);
});
