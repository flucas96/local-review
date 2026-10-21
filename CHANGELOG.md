# Changelog

## 0.3.1

- Add distinct human and Claude avatars to native conversations, including the identity beside inline replies.
- Shorten thread headings and status labels while preserving delivery and review states.
- Restyle the optional side composer with a single rounded input card, mint accents, quieter code context, clearer file hierarchy and compact actions.
- Preserve theme colors, visible keyboard focus, explicit high-contrast borders and narrow-panel wrapping. Native comment layout remains controlled by VS Code.

## 0.3.0

- Make native inline input the default: gutter plus, direct replies, one send action and `/a`, `/i`, `/r` shortcuts evaluated on send.
- Restore commenting ranges on local files and both sides of Local Review diffs.
- Keep the optional side composer open after sending, follow explicit new selections without focus changes, and preserve written drafts on their original code.
- Highlight the accepted selected lines independently of editor focus and separate selected code from surrounding context.
- Make the side composer smaller with a compact header, mode buttons, bounded code preview and content-sized input.
- Require Markdown code fences, indentation and real line breaks in agent replies; add a formatted-code MCP round-trip regression.
- Share in-flight inline submissions, preserve replies on saved code context, and prevent discarding a draft during submission.
- Add ten composer protocol regressions and four submission gate regressions. Strict TypeScript checking and all 73 automated tests pass.

## 0.2.1

- Add a mint-on-navy extension icon matching the demo's code-and-conversation identity.
- Include a matching monochrome Review view icon and package both assets in the VSIX.

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
