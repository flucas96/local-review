# Demo beat sheet

**Audience:** Developers reviewing AI-generated local changes in VS Code.

**Promise:** Move from Claude's first edit to precise feedback, reviewed changes, and a PR handoff in the same workspace.

**Format:** 45 seconds · 1920 × 1080 · 30 fps · English captions · original quiet ambient soundtrack.

**Disclosure:** Staged VS Code-style UI. Coding, agent replies, and PR publication are simulated. No real LLM invocation, user session, or GitHub write.

| Time | Beat | Visible proof |
| --- | --- | --- |
| 00:00–00:07.9 | Claude makes the first change | The terminal reads and edits `retry.py`; code appears progressively with a blinking editor caret. |
| 00:07.9–00:11.65 | Switch into Review | The pointer clicks the Review tab and selects line 18 in the diff. A controlled composer appears beside the code. |
| 00:11.65–00:16.6 | Make the intent explicit | Type `/i`: Implement is selected immediately. The prefix clears after a space, then the feedback appears with natural typing cadence and a blinking caret. |
| 00:16.6–00:21.5 | Send feedback once | The pointer clicks Send feedback. Queued, Received, and Working states appear in the original code thread and connected terminal. |
| 00:21.5–00:23.8 | Agent action | Working holds on screen; the staging disclosure remains visible. |
| 00:23.8–00:28.15 | Review and resolve | The original thread receives a response; the diff changes to `time.sleep(2 ** attempt)`. The human clicks Mark resolved. One separate Ask question stays open. |
| 00:28.15–00:30.25 | Start the PR handoff | A distinct Publish to PR action opens a preview. `/r` remains Summarize. |
| 00:30.25–00:35.95 | Preview before publication | The summary and one unresolved question remain readable. Nothing publishes until the explicit Publish review button is clicked. |
| 00:35.95–00:41.8 | Handoff result | A simulated PR publish confirmation appears. No real GitHub write occurs. |
| 00:41.8–00:45 | Closing message | “Your review. In the loop.” The three comment intents, separate PR handoff, and VSIX/README installation cue remain visible. |

## Soundtrack

“Quiet Current” is synthesized from original sine-based chord voicings, gentle harmonic overtones, slow changes, and a restrained stereo field. It has no vocals, percussion, borrowed samples, or recordings. The master fades in over 2.5 seconds and out over 3.8 seconds, with peak level below −22 dBFS. The final AAC track is decoded for clipping, level, channel, and fade inspection.

## Quality review

The contact sheet spans the entire timeline and includes typing completion, mode switching, pointer click moments, camera endpoints, handoff states, changed code, human resolution, PR preview, explicit publication, and the closing card. Full-size keyframes are extracted from the final MP4. The interface uses one camera wrapper and a continuous cursor; the cursor fades before the closing card.
