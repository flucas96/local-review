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

## Verification still required

- Run strict TypeScript checking and the automated tests after human approval. These checks have not run; the successful bundle build does not establish type safety or runtime correctness.
- Install the resulting VSIX in a real VS Code extension host. Exercise comment creation, all three actions, empty-thread summary behavior, reply, resolve, reopen, and sidebar navigation.
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
| Drafts | Submitted threads persist; unsent native composer text is not durably autosaved. |
| Delivery | At least once. Acknowledgment and reply IDs reduce duplicates; arbitrary edits are not exactly-once operations. |
| Permissions | Ask and summarize are agent instructions. They do not create a separate filesystem permission boundary. |
| Demo | Staged interface and simulated responses, not live integration evidence. |

## Release status

Open work is tracked in GitHub: [validation and live integration #1](https://github.com/flucas96/local-review/issues/1), [Marketplace publisher and listing #2](https://github.com/flucas96/local-review/issues/2), and [large-backlog pagination #3](https://github.com/flucas96/local-review/issues/3).

The `0.1.1` bundle was built successfully with `npm run build`. Type checking, automated tests, and the live end-to-end walkthrough remain pending. Publisher registration and Marketplace publication are pending. Manual workflows are prepared but have not been run as part of this review. Record future verification with the commit, platform, command or scenario, result, and a link to the workflow run or issue.
