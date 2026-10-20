# Demo beat sheet

**Audience:** Developers reviewing AI-generated local changes in VS Code.

**Promise:** Keep feedback, the agent reply, and your review decision attached to the code.

**Format:** 30 seconds · 1920 × 1080 · 30 fps · silent · English captions.

**Disclosure:** Staged VS Code-style UI; simulated Claude responses. No real LLM invocation, user session, or installation is shown.

| Time | Beat | Visible proof |
| --- | --- | --- |
| 00:00–00:03.2 | Hook: review the change in context | A connected terminal and local diff; the pointer approaches line 18. |
| 00:03.2–00:05.6 | Place feedback directly on the line | The comment composer opens; insertion focus and blinking caret appear. |
| 00:05.6–00:10.8 | State the intent | Human-paced typing: “Use exponential backoff instead of a fixed delay.” The completed sentence rests on screen. |
| 00:10.8–00:14.25 | Choose Implement and post once | `/i` is visibly selected; pointer-down ripple lands on Post comment. |
| 00:14.25–00:17.8 | Automatic handoff | The thread moves through Queued, Received, then Working; the terminal mirrors the handoff. |
| 00:17.8–00:21.8 | Agent action | Working state rests long enough to read. Responses are simulated and labeled. |
| 00:21.8–00:25.55 | Read the result and review the diff | The original thread receives a reply; `time.sleep(1)` changes to `time.sleep(2 ** attempt)`. Ready for review remains open. |
| 00:25.55–00:27.3 | Human resolution | The pointer clicks Mark resolved; the thread and open count update. |
| 00:27.3–00:30 | Call to action | “Your review. In the loop.” The three intents and VSIX/README installation cue remain visible. |

## Visual quality review

Capture covers pointer arrival and click moments, camera zoom endpoints, completed typing, handoff states, changed code, human resolution, and the ending. Review the contact sheet and the full-size extracted frames before sharing. The render uses one continuous camera and one continuous pointer within the editor scene; the pointer fades out before the end card.
