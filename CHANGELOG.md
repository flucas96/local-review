# Changelog

## 0.2.0

- Add a controlled feedback composer with visible live `/a`, `/i`, and `/r` mode switching and one explicit send action.
- Save unsent drafts in workspace storage and offer explicit draft recovery.
- Keep submitted conversations inline and open replies through the same composer.
- Support feedback shortcuts on original-side Local Review documents.
- Add a separate preview-and-publish action for summaries and unresolved questions on the current branch's GitHub PR, with managed-comment updates.
- Revise the staged demo to begin with Claude coding, then review feedback, and add an original quiet ambient soundtrack.

## 0.1.1

- Preserve comment drafts when submission fails.
- Restore threads only on confirmed code locations and display saved context when uncertain.
- Keep comparison editors open while navigating review conversations.
- Reconnect after Claude exits, and rearm delivery after tool use.
- Bound new feedback before persistence and isolate legacy oversized review context.
- Recover unfinished work when a channel reconnects.
- Summarize existing threads without requiring additional text.
- Show renamed files as separate deletion and addition for complete local review.
- Add targeted regression cases, GitHub installation/publishing documentation, and a staged demo.

## 0.1.0

Native inline reviews with automatic per-comment delivery to Claude Code, persistent threads, explicit acknowledgments, and replies in the editor.
