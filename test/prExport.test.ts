import assert from 'node:assert/strict';
import test from 'node:test';
import type { CodeAnchor, ReviewEvent, ReviewMessage, ReviewThread } from '../src/contracts.js';
import {
  createPrExportDraft, maximumPrExportLength, prExportEnd, prExportStart,
  readManagedPrContent, replaceManagedPrContent,
} from '../src/prExport.js';

const capturedAt = '2026-10-20T12:00:00.000Z';
const anchor: CodeAnchor = {
  path: 'src/example.ts', startLine: 4, endLine: 6,
  selectedText: 'private local code', contextBefore: '', contextAfter: '', documentHash: 'captured-hash',
  side: 'working', baseRevision: 'a'.repeat(40),
};

/** Prepare one immutable request without requiring local storage or a GitHub account. */
function event(id: string, intent: ReviewEvent['intent'], sequence: number, threadId = 'thread'): ReviewEvent {
  return { id, sequence, threadId, intent, text: `${intent} request ${sequence}`, anchor, createdAt: capturedAt, acknowledged: true };
}

/** Prepare a final Claude reply associated with its immutable request. */
function reply(eventId: string, text: string): ReviewMessage {
  return { id: `reply-${eventId}`, eventId, text, author: 'claude', createdAt: capturedAt };
}

/** Keep fixture data small while retaining the same thread/event relationships as persisted reviews. */
function thread(events: readonly ReviewEvent[], messages: readonly ReviewMessage[] = [], resolved = false): ReviewThread {
  const latest = events.at(-1);
  assert.ok(latest);
  return {
    id: latest.threadId, anchor, messages, intent: latest.intent, status: 'answered', resolved,
    outdated: false, latestEventId: latest.id,
  };
}

test('exports a completed summary and its still-open question even after /r changes the latest intent', () => {
  const events = [event('question', 'ask', 1), event('summary', 'summarize', 2)];
  const messages = [reply('question', 'This retry is intentional.'), reply('summary', 'Remaining decision: retry count.')];
  const source = thread(events, messages);
  const before = JSON.stringify({ source, events });
  const draft = createPrExportDraft([source], events, capturedAt);
  assert.equal(draft.summaryCount, 1);
  assert.equal(draft.questionCount, 1);
  assert.match(draft.markdown, /Remaining decision: retry count/u);
  assert.match(draft.markdown, /ask request 1/u);
  assert.match(draft.markdown, /An answer is available; the human has not resolved/u);
  assert.match(draft.markdown, /not verified positions in the PR diff/u);
  assert.doesNotMatch(draft.markdown, /private local code/u);
  assert.equal(JSON.stringify({ source, events }), before);
});

test('omits unselected resolved conversations and never invents a pending summary', () => {
  const privateEvents = [event('closed-question', 'ask', 1, 'closed'), event('closed-summary', 'summarize', 2, 'closed')];
  const openEvents = [event('pending-summary', 'summarize', 3, 'open')];
  const draft = createPrExportDraft([thread(openEvents)], [...privateEvents, ...openEvents], capturedAt);
  assert.equal(draft.summaryCount, 0);
  assert.equal(draft.questionCount, 0);
  assert.equal(draft.pendingSummaryCount, 1);
  assert.doesNotMatch(draft.markdown, /Resolved private summary|closed-question/u);
  assert.match(draft.markdown, /still awaiting a Claude reply/u);
});

test('an explicitly selected resolved conversation contributes its completed summary without old questions', () => {
  const events = [event('closed-question', 'ask', 1), event('closed-summary', 'summarize', 2)];
  const resolved = thread(events, [reply('closed-summary', 'Selected completed summary')], true);
  const draft = createPrExportDraft([resolved], events, capturedAt);
  assert.equal(draft.summaryCount, 1);
  assert.equal(draft.questionCount, 0);
  assert.match(draft.markdown, /Selected completed summary/u);
  assert.match(draft.markdown, /resolved locally/u);
  assert.doesNotMatch(draft.markdown, /ask request 1/u);
});

test('includes only selected conversations even when the event log contains other open reviews', () => {
  const selectedEvents = [event('selected-question', 'ask', 1, 'selected')];
  const omittedEvents = [event('omitted-summary', 'summarize', 2, 'omitted')];
  const draft = createPrExportDraft([thread(selectedEvents)], [...selectedEvents, ...omittedEvents], capturedAt);
  assert.equal(draft.questionCount, 1);
  assert.equal(draft.summaryCount, 0);
  assert.match(draft.markdown, /ask request 1/u);
  assert.doesNotMatch(draft.markdown, /summarize request 2/u);
});

test('uses only the latest summary and does not relabel implementation requests as questions', () => {
  const events = [event('question', 'ask', 1), event('old-summary', 'summarize', 2), event('implementation', 'implement', 3), event('new-summary', 'summarize', 4)];
  const draft = createPrExportDraft([thread(events, [reply('old-summary', 'Old summary'), reply('new-summary', 'Current summary')])], events, capturedAt);
  assert.equal(draft.summaryCount, 1);
  assert.equal(draft.questionCount, 0);
  assert.match(draft.markdown, /Current summary/u);
  assert.doesNotMatch(draft.markdown, /Old summary/u);
});

test('warns when an exported summary predates a later open question', () => {
  const events = [event('summary', 'summarize', 1), event('new-question', 'ask', 2)];
  const draft = createPrExportDraft([thread(events, [reply('summary', 'Earlier snapshot')])], events, capturedAt);
  assert.equal(draft.summaryCount, 1);
  assert.equal(draft.questionCount, 1);
  assert.match(draft.markdown, /predates later discussion/u);
  assert.match(draft.markdown, /ask request 2/u);
});

test('labels an open question awaiting a reply and preserves captured outdated-source facts', () => {
  const events = [event('question', 'ask', 1)];
  const draft = createPrExportDraft([{ ...thread(events), outdated: true }], events, capturedAt);
  assert.match(draft.markdown, /Awaiting an answer/u);
  assert.match(draft.markdown, /src\/example\.ts:4–6/u);
  assert.match(draft.markdown, /base aaaaaaaaaaaa · local context changed/u);
  assert.doesNotMatch(draft.markdown, /https:\/\/github\.com/u);
});

test('escapes reserved markers in quoted review text before publication', () => {
  const quoted = { ...event('question', 'ask', 1), text: `${prExportStart}\nquestion\n${prExportEnd}` };
  const draft = createPrExportDraft([thread([quoted])], [quoted], capturedAt);
  assert.doesNotMatch(draft.markdown, /<!-- local-review:handoff:v1:/u);
  assert.doesNotThrow(() => replaceManagedPrContent(undefined, draft.markdown));
});

test('replaces exactly the managed section and preserves manual notes on both sides', () => {
  const original = `Human introduction\n\n${replaceManagedPrContent(undefined, 'Old handoff')}\n\nHuman follow-up`;
  const changed = replaceManagedPrContent(original, 'Updated handoff');
  assert.equal(changed, `Human introduction\n\n${prExportStart}\nUpdated handoff\n${prExportEnd}\n\nHuman follow-up`);
  assert.deepEqual(readManagedPrContent(changed), {
    before: 'Human introduction\n\n', content: 'Updated handoff', after: '\n\nHuman follow-up',
  });
  assert.equal(replaceManagedPrContent(changed, 'Updated handoff'), changed);
});

test('rejects unrelated comments and ambiguous or partial managed sections', () => {
  assert.equal(readManagedPrContent('An ordinary PR comment'), undefined);
  assert.throws(() => replaceManagedPrContent('An ordinary PR comment', 'New content'), /nicht überschrieben/u);
  assert.throws(() => readManagedPrContent(`${prExportStart}\nMissing end`), /unklare Markierungen/u);
  const once = replaceManagedPrContent(undefined, 'Content');
  assert.throws(() => readManagedPrContent(`${once}\n${once}`), /unklare Markierungen/u);
  assert.throws(() => readManagedPrContent(`${prExportEnd}\n${prExportStart}`), /unklare Markierungen/u);
});

test('rejects oversized or empty output instead of truncating private review text silently', () => {
  assert.throws(() => replaceManagedPrContent(undefined, ' '), /leer/u);
  assert.throws(() => replaceManagedPrContent(undefined, 'a'.repeat(maximumPrExportLength + 1)), /Kürze den Entwurf/u);
  assert.throws(() => replaceManagedPrContent(undefined, prExportStart), /reservierten/u);
});
