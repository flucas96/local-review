import assert from 'node:assert/strict';
import test from 'node:test';
import { parseComposerInput } from '../src/composerIntent.js';

test('previews ask and implement as soon as their exact shortcut is typed', () => {
  assert.deepEqual(parseComposerInput('/i', 'ask'), {
    text: '/i', intent: 'implement', selectedIntent: 'ask', removedCharacters: 0,
  });
  assert.equal(parseComposerInput('/a', 'implement').intent, 'ask');
});

test('does not eat paths or words typed incrementally through a shortcut prefix', () => {
  assert.equal(parseComposerInput('/i', 'ask').intent, 'implement');
  for (const text of ['/in', '/index', '/api', '/root']) {
    assert.deepEqual(parseComposerInput(text, 'ask'), {
      text, intent: 'ask', selectedIntent: 'ask', removedCharacters: 0,
    });
  }
});

test('commits a shortcut at whitespace and preserves the remaining multiline feedback', () => {
  assert.deepEqual(parseComposerInput('/i Add retries\nKeep the timeout.', 'ask'), {
    text: 'Add retries\nKeep the timeout.', intent: 'implement', selectedIntent: 'implement', removedCharacters: 3,
  });
});

test('switches an already selected mode without leaking the shortcut into sent text', () => {
  assert.deepEqual(parseComposerInput('  /a\nWhy?', 'implement', true), {
    text: 'Why?', intent: 'ask', selectedIntent: 'ask', removedCharacters: 5,
  });
});

test('finalizes a bare summary shortcut so an existing conversation can be summarized', () => {
  assert.deepEqual(parseComposerInput('/r', 'ask', true), {
    text: '', intent: 'summarize', selectedIntent: 'summarize', removedCharacters: 2,
  });
});

test('leaves embedded shortcuts and their surrounding text unchanged', () => {
  const text = 'Please inspect /i and /a handling.';
  assert.deepEqual(parseComposerInput(text, 'ask', true), {
    text, intent: 'ask', selectedIntent: 'ask', removedCharacters: 0,
  });
});

test('preserves a chosen mode after a committed shortcut has been removed', () => {
  const committed = parseComposerInput('/i ', 'ask');
  assert.equal(parseComposerInput('Add retries.', committed.selectedIntent).intent, 'implement');
  assert.equal(parseComposerInput('', committed.selectedIntent).intent, 'implement');
});
