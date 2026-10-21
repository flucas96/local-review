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

test('generates opaque native actions that resolve only to stored identities', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('```typescript\nconst secret = 1;\n```');
  const [action] = references.actions(thread, message, 'javascript');
  assert.ok(action);
  assert.equal(openCodeCommand, 'localReview.openCode');
  assert.match(action.handle, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u);
  assert.equal(action.label, 'Code 1 · typescript');
  assert.equal(action.description, 'const secret = 1;');
  assert.deepEqual(references.resolve(action.handle), { threadId: thread.id, messageId: message.id, blockIndex: 0 });
  for (const privateValue of ['secret', thread.anchor.path, thread.id, message.id]) {
    assert.equal(action.handle.includes(privateValue), false);
  }
});

test('renders code cards without generating a command link or body action row', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('Before.\n\n```typescript\nvalue();\n```\n\nAfter.');
  references.actions(thread, message, 'typescript');
  const rendered = references.render(thread, message, 'typescript');
  assert.ok(rendered.startsWith('Before.\n\n'));
  assert.ok(rendered.includes('```typescript\nvalue();\n```'));
  assert.ok(rendered.endsWith('\n\nAfter.'));
  assert.equal(rendered.includes('command:'), false);
  assert.equal(rendered.includes('$(go-to-file)'), false);
});

test('reuses action handles across rerenders while keeping messages distinct', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('```\nvalue();\n```');
  const [first] = references.actions(thread, message, 'typescript');
  assert.ok(first);
  references.render(thread, message, 'typescript');
  assert.equal(references.actions(thread, message, 'javascript')[0]?.handle, first.handle);
  const another = { ...message, id: 'message-2' };
  const [different] = references.actions(thread, another, 'typescript');
  assert.ok(different);
  assert.notEqual(different.handle, first.handle);
  assert.deepEqual(references.resolve(different.handle), { threadId: thread.id, messageId: another.id, blockIndex: 0 });
});

test('rejects unknown handles, caller-constructed identities and disposed handles', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('```\nvalue();\n```');
  const handle = references.actions(thread, message, 'typescript')[0]?.handle;
  assert.ok(handle);
  for (const invalid of [undefined, null, 0, [], {}, { threadId: thread.id, messageId: message.id, blockIndex: 0 }, 'message-1', 'unknown']) {
    assert.equal(references.resolve(invalid), undefined);
  }
  assert.equal(new CodeReferences().resolve(handle), undefined);
  references.dispose();
  assert.equal(references.resolve(handle), undefined);
});

test('offers a selected-context action for Claude prose without adding it to the body', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('Please inspect `retry()` in the selected code.');
  const [action] = references.actions(thread, message, 'javascript');
  assert.ok(action);
  assert.equal(action.label, 'Codekontext');
  assert.equal(action.description, thread.anchor.path);
  assert.deepEqual(references.resolve(action.handle), { threadId: thread.id, messageId: message.id });
  assert.equal(references.render(thread, message, 'javascript'), message.text);
  const human = { ...message, author: 'human' as const };
  assert.deepEqual(references.actions(thread, human, 'javascript'), []);
  assert.equal(references.render(thread, human, 'javascript'), message.text);
});

test('uses display-only fallback languages for cards and actions without mutating durable text', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('Inspect this:\n```\nvalue();\n```', 'human');
  const before = JSON.stringify(thread);
  const rendered = references.render(thread, message, 'typescript');
  const [action] = references.actions(thread, message, 'typescript');
  assert.ok(action);
  assert.ok(rendered.includes('```typescript\nvalue();\n```'));
  assert.equal(action.label, 'Code 1 · typescript');
  assert.equal(JSON.stringify(thread), before);
  assert.deepEqual(references.resolve(action.handle), { threadId: thread.id, messageId: message.id, blockIndex: 0 });
  assert.equal(references.actions(thread, message, '')[0]?.label, 'Code 1 · Code');
});

test('repairs legacy declarations into one card and preserves mixed block action indexes', () => {
  const references = new CodeReferences();
  const code = "import { setTimeout as delay } from 'node:timers/promises';\n\nexport async function withRetry(operation) { return operation(); }";
  const { thread, message } = fixture(`Implemented:\n\n${code}\n\nMore context.\n\n\`\`\`python\nprint('done')\n\`\`\``);
  const before = JSON.stringify(thread);
  const rendered = references.render(thread, message, 'javascript');
  const actions = references.actions(thread, message, 'javascript');
  assert.ok(rendered.includes(`~~~javascript\n${code}\n~~~`));
  assert.ok(rendered.includes('More context.'));
  assert.equal(rendered.includes('command:'), false);
  assert.equal(JSON.stringify(thread), before);
  assert.deepEqual(actions.map(action => action.label), ['Code 1 · javascript', 'Code 2 · python']);
  assert.deepEqual(actions.map(action => references.resolve(action.handle)?.blockIndex), [0, 1]);
});

test('skips empty blocks, preserves original indexes and caps native actions at twenty', () => {
  const references = new CodeReferences();
  const nonempty = Array.from({ length: 23 }, (_, index) => `\`\`\`js\nvalue${index}();\n\`\`\``);
  const { thread, message } = fixture(['```\n```', '~~~\n \t\n~~~', ...nonempty].join('\n'));
  const actions = references.actions(thread, message, 'typescript');
  assert.equal(actions.length, 20);
  assert.equal(actions[0]?.label, 'Code 3 · js');
  assert.equal(references.resolve(actions[0]?.handle)?.blockIndex, 2);
  assert.equal(references.resolve(actions.at(-1)?.handle)?.blockIndex, 21);
  const empty = fixture('```\n \t\n```');
  assert.deepEqual(references.actions(empty.thread, empty.message, 'js'), []);
});

test('uses the first nonempty line for a bounded preview description', () => {
  const references = new CodeReferences();
  const firstLine = 'x'.repeat(200);
  const { thread, message } = fixture(`\`\`\`js\n \t\n  ${firstLine}\nignored();\n\`\`\``);
  assert.equal(references.actions(thread, message, 'javascript')[0]?.description, firstLine.slice(0, 160));
});

test('offers native actions for unclosed code without inserting body command links', () => {
  const references = new CodeReferences();
  const { thread, message } = fixture('Before\n```\nconst value = 1;');
  const rendered = references.render(thread, message, 'typescript');
  const [action] = references.actions(thread, message, 'typescript');
  assert.ok(action);
  assert.ok(rendered.startsWith('Before\n'));
  assert.ok(rendered.includes('```typescript\nconst value = 1;\n```'));
  assert.equal(rendered.includes('command:'), false);
  assert.deepEqual(references.resolve(action.handle), { threadId: thread.id, messageId: message.id, blockIndex: 0 });
});

test('original model command links stay visible but never become extension-owned action handles', () => {
  const references = new CodeReferences();
  const attackerHandle = 'caller-constructed-handle';
  const malicious = `[Pretend](command:${openCodeCommand}?${encodeURIComponent(JSON.stringify([attackerHandle]))})`;
  const { thread, message } = fixture(`${malicious}\n\n\`\`\`js\nvalue();\n\`\`\``);
  const rendered = references.render(thread, message, 'javascript');
  const actions = references.actions(thread, message, 'javascript');
  assert.equal(rendered.includes(malicious), true);
  assert.equal((rendered.match(/command:localReview\.openCode/gu) ?? []).length, 1);
  assert.equal(references.resolve(attackerHandle), undefined);
  assert.equal(actions.length, 1);
  assert.equal(references.resolve(actions[0]?.handle)?.blockIndex, 0);
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
