import type { ReviewEvent, ReviewMessage, ReviewThread } from './contracts.js';

/** Conservative limit that leaves room for managed markers in a GitHub comment. */
export const maximumPrExportLength = 60_000;

/** Markers delimit only the section owned by Local Review in a PR conversation. */
export const prExportStart = '<!-- local-review:handoff:v1:start -->';
export const prExportEnd = '<!-- local-review:handoff:v1:end -->';

/** Frozen handoff content that does not alter local delivery or resolution state. */
export interface PrExportDraft {
  readonly markdown: string;
  readonly summaryCount: number;
  readonly questionCount: number;
  readonly pendingSummaryCount: number;
  readonly capturedAt: string;
}

/** Distinguish the exact managed section from any manually added surrounding text. */
export interface ManagedPrContent {
  readonly before: string;
  readonly content: string;
  readonly after: string;
}

/** Prepare summaries from selected conversations and questions only from unresolved conversations. */
export function createPrExportDraft(
  threads: readonly ReviewThread[],
  events: readonly ReviewEvent[],
  capturedAt = new Date().toISOString(),
): PrExportDraft {
  const eventsByThread = new Map<string, ReviewEvent[]>();
  for (const event of events) {
    const existing = eventsByThread.get(event.threadId);
    if (existing === undefined) eventsByThread.set(event.threadId, [event]);
    else existing.push(event);
  }
  const summaries: string[] = [];
  const questions: string[] = [];
  let pendingSummaryCount = 0;
  for (const thread of threads) {
    const threadEvents = [...(eventsByThread.get(thread.id) ?? [])].sort((left, right) => left.sequence - right.sequence);
    const latestSummary = threadEvents.findLast((event) => event.intent === 'summarize');
    if (latestSummary !== undefined) {
      const summary = latestReply(thread, latestSummary.id);
      if (summary === undefined) {
        if (!thread.resolved) pendingSummaryCount += 1;
      } else {
        const laterRequest = threadEvents.some((event) => event.sequence > latestSummary.sequence && event.intent !== 'summarize');
        const laterMessage = thread.messages.indexOf(summary) < thread.messages.length - 1;
        const warning = laterRequest || laterMessage
          ? '\n\n*This summary predates later discussion and may not include its latest questions or decisions.*'
          : '';
        summaries.push(`${location(thread)}${warning}\n\n${exportText(summary.text)}\n\n*Claude summary · ${summary.createdAt}*`);
      }
    }
    if (thread.resolved) continue;
    const latestDiscussion = threadEvents.findLast((event) => event.intent !== 'summarize');
    if (latestDiscussion?.intent !== 'ask') continue;
    const answer = latestReply(thread, latestDiscussion.id);
    questions.push([
      location(thread),
      `**Question**\n\n${exportText(latestDiscussion.text)}`,
      answer === undefined
        ? '*Awaiting an answer. The local conversation remains open.*'
        : `**Claude’s answer**\n\n${exportText(answer.text)}\n\n*An answer is available; the human has not resolved this conversation.*`,
    ].join('\n\n'));
  }
  const sections = [
    '## Local review handoff',
    `Snapshot prepared in VS Code at ${capturedAt}. Only selected local conversations are included. Resolved conversations contribute summaries only.`,
    'File names and line ranges below describe captured local code, which may include unpublished edits. They are not verified positions in the PR diff.',
  ];
  if (summaries.length > 0) sections.push(`### Conversation summaries\n\n${summaries.join('\n\n---\n\n')}`);
  if (questions.length > 0) sections.push(`### Open questions\n\n${questions.join('\n\n---\n\n')}`);
  if (pendingSummaryCount > 0) sections.push(`*${pendingSummaryCount} requested ${pendingSummaryCount === 1 ? 'summary is' : 'summaries are'} still awaiting a Claude reply and ${pendingSummaryCount === 1 ? 'is' : 'are'} not included.*`);
  return {
    markdown: sections.join('\n\n'), summaryCount: summaries.length,
    questionCount: questions.length, pendingSummaryCount, capturedAt,
  };
}

/** Recognize exactly one complete managed section, rejecting ambiguous marker collisions. */
export function readManagedPrContent(body: string): ManagedPrContent | undefined {
  const start = body.indexOf(prExportStart);
  const end = body.indexOf(prExportEnd);
  if (start < 0 && end < 0) return undefined;
  if (start < 0 || end < start + prExportStart.length
    || body.indexOf(prExportStart, start + prExportStart.length) >= 0
    || body.indexOf(prExportEnd, end + prExportEnd.length) >= 0) {
    throw new Error('Der vorhandene Local-Review-Kommentar enthält unklare Markierungen. Prüfe ihn auf GitHub, bevor du ihn aktualisierst.');
  }
  return {
    before: body.slice(0, start),
    content: body.slice(start + prExportStart.length, end).trim(),
    after: body.slice(end + prExportEnd.length),
  };
}

/** Replace only the managed content and preserve manually authored surrounding text. */
export function replaceManagedPrContent(body: string | undefined, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('Die PR-Übergabe ist leer. Ergänze Text, bevor du veröffentlichst.');
  if (trimmed.length > maximumPrExportLength) {
    throw new Error(`Die Übergabe ist zu lang. Kürze den Entwurf auf höchstens ${maximumPrExportLength.toLocaleString('de-DE')} Zeichen.`);
  }
  if (trimmed.includes(prExportStart) || trimmed.includes(prExportEnd)) {
    throw new Error('Entferne die reservierten Local-Review-Markierungen aus deinem Entwurf.');
  }
  const managed = body === undefined ? undefined : readManagedPrContent(body);
  if (body !== undefined && managed === undefined) {
    throw new Error('Dieser GitHub-Kommentar gehört nicht zu Local Review und wird nicht überschrieben.');
  }
  const wrapped = `${prExportStart}\n${trimmed}\n${prExportEnd}`;
  const result = managed === undefined ? wrapped : `${managed.before}${wrapped}${managed.after}`;
  if (result.length > maximumPrExportLength + prExportStart.length + prExportEnd.length + 2) {
    throw new Error('Der vorhandene Kommentar mit deinen Ergänzungen ist zu lang. Kürze ihn auf GitHub oder kürze diesen Entwurf.');
  }
  return result;
}

/** Select only a reply tied to the immutable request being handed off. */
function latestReply(thread: ReviewThread, eventId: string): ReviewMessage | undefined {
  return thread.messages.findLast((message) => message.author === 'claude' && message.eventId === eventId);
}

/** Keep locations honest when local files or their comparison base have moved. */
function location(thread: ReviewThread): string {
  const anchor = thread.anchor;
  const lines = anchor.startLine === anchor.endLine ? String(anchor.startLine) : `${anchor.startLine}–${anchor.endLine}`;
  const revision = /^[a-f\d]{40,64}$/u.test(anchor.baseRevision) ? anchor.baseRevision.slice(0, 12) : 'uncommitted repository';
  return `#### ${codeSpan(`${anchor.path}:${lines}`)}\n\n*Captured ${anchor.side === 'working' ? 'working file' : 'original file'} · base ${revision}${thread.outdated ? ' · local context changed' : ''}${thread.resolved ? ' · resolved locally' : ''}*`;
}

/** Render an arbitrary file name without allowing it to break a Markdown code span. */
function codeSpan(value: string): string {
  const text = exportText(value).replaceAll(/[\r\n]/gu, ' ');
  const runs = text.match(/`+/gu) ?? [];
  const delimiter = '`'.repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  return `${delimiter} ${text} ${delimiter}`;
}

/** Keep quoted user or agent text from creating a managed-section boundary. */
function exportText(text: string): string {
  return text.replaceAll(prExportStart, '&lt;!-- local-review:handoff:v1:start --&gt;')
    .replaceAll(prExportEnd, '&lt;!-- local-review:handoff:v1:end --&gt;');
}
