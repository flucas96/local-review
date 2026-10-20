# Review findings and verification

Reviewed on 20 October 2026. **Fixed** means a source change has been made. **Verified** requires recorded execution evidence; a static review or a staged demo does not establish it.

## Findings

| ID | Priority | Finding | Source status | Verification |
| --- | --- | --- | --- | --- |
| LR-001 | P1 | A failed submission could clear the native draft because the command swallowed its rejection. | Fixed: report the error and preserve the rejected promise. | Pending: native composer walkthrough with failed persistence. |
| LR-002 | P2 | After reload, a moved comment could attach to its old line number in unrelated code. | Fixed: match the captured context or show a saved excerpt. | Pending: anchor tests and extension-host walkthrough. |
| LR-003 | P2 | Reconnect only revealed a terminal after Claude had exited. | Fixed: observe command completion and offer an explicit restart. | Pending: exit, failed startup, and reconnect walkthrough. |
| LR-004 | P2 | An oversized field could poison the transport batch and block unrelated comments. | Fixed: shared field bounds and bounded projection of legacy data. | Pending: boundary and recovery tests. |
| LR-005 | P2 | Growing conversation history was forwarded without a context budget. | Fixed: quote up to 20 recent messages within 100,000 characters. | Pending: context-budget tests. |
| LR-006 | P2 | The summary action was disabled when an existing thread's composer was empty. | Fixed: `/r` can summarize the existing conversation. | Pending: native comment-action walkthrough. |
| LR-007 | P2 | Sidebar navigation opened a plain file rather than the review diff. | Fixed: thread navigation restores the review diff when possible. | Pending: native diff navigation walkthrough. |
| LR-008 | P2 | Rename detection hid the original path, leaving the new path with an empty base. | Fixed: represent a rename as deletion plus addition. | Pending: staged-rename regression. |
| LR-009 | P2 | A transport test expected unfinished acknowledged work to disappear from recovery. | Fixed: expect it until an actual answer arrives. | Pending: test execution. |
| LR-010 | P2 | Watcher rearming during ongoing tool use needed additional robustness coverage. | Fixed: also arm on `PostToolUse`; a live-host delivery failure has not been reproduced. | Pending: hook regression and consecutive-comment walkthrough. |
| LR-011 | P2 | Channels startup or reconnection skipped acknowledged but unfinished work. | Fixed: recover from `/pending` before polling new events. | Pending: channels recovery test and live walkthrough. |

Implementation and tests are in [src](../src) and [test](../test). Use the issue IDs above when recording follow-up work.

## Daily-workflow usability audit

Three independent read-only audits of preview `0.1.1` (`1765984`) identified the following open gaps. These are source findings; host behavior still needs the live walkthrough in [#1](https://github.com/flucas96/local-review/issues/1). Acceptance criteria and implementation options are tracked in [daily-workflow usability #4](https://github.com/flucas96/local-review/issues/4).

| ID | Priority | Open gap | Recommended change |
| --- | --- | --- | --- |
| LR-012 | P1 | Claude cannot directly open the original review thread. | An authenticated `open_review(event_id)` MCP tool reusing existing diff/thread navigation. |
| LR-013 | P1 | Replies update the UI but have no unread state or next-answer action. | Unread/ready count, optional actionable notification, and keyboard navigation without automatic focus changes. |
| LR-014 | P1 | MCP heartbeat can show connected independently of a working wake hook. | Separate connection, watcher readiness, and explicit delivery acknowledgment; provide diagnostics and repair. |
| LR-015 | P2 | Setup launches only an integrated terminal and cannot attach arbitrary running Claude processes. | Keep the launcher and offer a generated launch/resume command for an external local terminal. |
| LR-016 | P2 | Session ownership is implicit, and resume chooses the latest conversation. | Explicit conversation selection, visible owner, and controlled takeover. |
| LR-017 | P2 | Required Claude wake capability is not checked during setup. | Capability/version preflight with an actionable compatibility error. |
| LR-018 | P2 | Review file selection is HEAD-relative and opens one file at a time. | A stable review baseline and next/previous-file navigation; committed work must remain reviewable. |
| LR-019 | P2 | The flat queue hides filename/line in a tooltip and includes all resolved threads. | Visible locations, open/unread filters, and quick resolve/reopen actions. |
| LR-020 | P2 | A slash prefix can override the clicked intent button without a preview. | Source fixed in 0.2.0: controlled composer previews live mode and uses one send action; native walkthrough pending. |
| LR-021 | P2 | Add-comment shortcut and context action exclude original-side virtual documents. | Source fixed in 0.2.0: include `local-review-base`; removed/original-line walkthrough pending. |

The recommended first pass is direct thread navigation, reply visibility, and truthful delivery readiness. Both integrated and separate local terminal apps should use the same review protocol. Claude's built-in `/ide` connection does not by itself install this extension's review hooks or MCP tools.

## Live modes and PR handoff

Preview 0.2.0 adds a controlled composer beside the diff because stable native comments expose text only when a comment is submitted. Typing an exact `/a`, `/i`, or `/r` previews the mode immediately; whitespace commits the shortcut. `/api` and `/index` remain ordinary text. Mode buttons explicitly override a pending prefix. Closing the composer keeps its local draft; submitted conversations remain native inline threads. These source changes and tests are not evidence of a completed native walkthrough.

The separate PR action selects conversation summaries and unresolved questions, prepares an editable snapshot, and publishes one managed user-owned PR discussion comment. Summaries from resolved conversations are available only through explicit selection and are not preselected. It does not fabricate summaries, map unpushed lines to the PR diff, or resolve local threads. Managed markers support retry recovery and updates, but concurrent clients can still race; duplicate managed comments require manual attention. Validation and the updated demo are tracked in [feature issue #5](https://github.com/flucas96/local-review/issues/5).

## 0.3.0 usability and verification

The user selected native GitHub-style inline input as the default, accepting mode interpretation at send time. The gutter provider is restored, inline replies are enabled, and one **Senden** action parses `/a`, `/i`, `/r`. The smaller side composer remains available as an explicit alternative, with live mode switching, local draft storage, selection following and a persistent accepted-range decoration. Written drafts and replies do not silently retarget.

The side composer now shows the exact selected lines; surrounding context is separate and collapsed. Native replies use VS Code's Markdown renderer. Inspection of the playground's existing reply metadata confirmed real newlines but no fenced code blocks. Shared agent instructions and tool metadata now require fenced, language-labeled code. Existing reply bodies remain unchanged.

With user approval on 20 October 2026, strict TypeScript checking passes and **73 automated tests pass**. This includes ten tests executing the actual composer host and embedded browser script with a minimal VS Code/DOM fake, four submission gate regressions, and an MCP/bridge/storage round trip preserving fenced multiline JavaScript. The first restricted run could not open loopback ports; rerunning with loopback access succeeded. One old transport test incorrectly expected a completed thread in the pending-only payload and now checks durable storage instead.

On macOS, the 0.3.0 VSIX was installed over 0.2.0 in the user's VS Code and the playground window reloaded. The add-comment shortcut opened a native field on line 6; entering `/i ` enabled the single **Senden** button. The temporary text was cleared and its draft discarded. Clicking the visible gutter plus on the same line also opened a focused native field with the shared slash-command placeholder and one disabled send button while empty. No test feedback was sent to the authenticated Claude session. Existing stored conversations remained visible after reload.

## Verification still required

- Repeat the relevant checks after future changes. Current 0.3.0 strict TypeScript checking and all 73 tests pass; this does not replace native extension-host or authenticated integration validation.
- Continue the native walkthrough beyond the verified installation, shortcut, gutter-plus and input checks. Exercise live side-composer mode switching, `/index` text, local draft recovery, failed submission, all three submitted actions, empty-thread summary, reply, resolve, reopen, original-side commenting and sidebar navigation.
- Exercise PR handoff with no PR, missing CLI/authentication, selected summaries/questions, stale summaries, unpushed code, editable preview, successful publication, managed updates, changed destination/account, retry after uncertain publication and duplicate managed comments. Confirm publication does not change local delivery or resolution.
- Connect an authenticated Claude terminal. Confirm idle wake-up, a second comment during ongoing work, explicit acknowledgment, progress, and a reply in the correct thread.
- Reload the extension, move code, rename and delete files, and confirm safe thread recovery. Verify that a stalled or exited session can reconnect.
- Exercise Linux before claiming support. Windows connection requires implementation and a dedicated walkthrough.

## Current limits

| Area | Limit |
| --- | --- |
| Session | First local workspace folder and one intended Claude session. Remote and concurrent agent sessions are unsupported. |
| Platform | macOS is primary. Linux is unverified. Automatic connection is blocked on Windows. |
| Idle watcher | 24-hour timeout. Reconnect or send Claude a prompt afterward. |
| Agent context | Up to 20 recent conversation messages and 100,000 quoted characters. Individual review fields are bounded at 200,000 characters; replies at 20,000. |
| Large backlog | Aggregate transport responses still have a 10,000,000-character ceiling and no pagination. A sufficiently large open queue can exceed it. |
| Drafts | Submitted threads and optional side-composer drafts persist. Native draft recovery is managed by VS Code. If side-draft cleanup fails after a successful send, a stale draft can remain after restart; it is never automatically replayed. |
| Delivery | At least once. Acknowledgment and reply IDs reduce duplicates; arbitrary edits are not exactly-once operations. |
| Permissions | Ask and summarize are agent instructions. They do not create a separate filesystem permission boundary. |
| Demo | Staged interface and simulated responses, not live integration evidence. |

## Release status

Open work is tracked in GitHub: [validation and live integration #1](https://github.com/flucas96/local-review/issues/1), [Marketplace publisher and listing #2](https://github.com/flucas96/local-review/issues/2), [large-backlog pagination #3](https://github.com/flucas96/local-review/issues/3), [daily-workflow usability #4](https://github.com/flucas96/local-review/issues/4), and [live modes, PR handoff and demo #5](https://github.com/flucas96/local-review/issues/5).

The `0.3.0` bundle and strict TypeScript checking pass, as do all 73 automated tests. The icon was visually reviewed at 32, 64, 128 and 256 pixels; packaging includes its PNG and monochrome view SVG. The live authenticated end-to-end walkthrough, publisher registration and Marketplace publication remain pending. Manual workflows have not been run. Record future verification with the commit, platform, command or scenario, result, and a link to the workflow run or issue.
