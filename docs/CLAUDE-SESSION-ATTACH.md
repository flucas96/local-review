# Connecting Claude conversations

Research date: 2026-10-21. This note separates the supported resume workflow from a possible future connection to an already-running process.

## Current scope

Local Review offers a new conversation, a picker for a specific saved conversation, and a launch command for a separate terminal. Resuming preserves the selected conversation's history and loads Local Review's MCP and hook configuration for the new process. It does **not** attach to the old terminal process.

The old process must finish or be exited before the same conversation is resumed. For a terminal managed by Local Review, the explicit **Unterhaltung wechseln** action may close that review terminal after the user chooses the next conversation mode and preparation succeeds. Cancelling either picker or a preparation failure preserves it. An unmanaged terminal process is never killed by Local Review; the user exits it themselves. Local Review must not run a second writer against the same conversation automatically. Launch-time `--settings` and `--mcp-config` arguments must be passed again on resume; Claude does not restore those flags from conversation history. See [Claude session restoration](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores).

## Verified resume workflow

On 2026-10-21, the verified installed **Local Review 0.4.8** bundle was exercised in VS Code **1.143.0** on macOS using the isolated `review-lab-ux-check` project. Its integrated terminal resolved npm-global **Claude Code 2.1.280** and used the configured Sonnet 5 gateway. The earlier research below inspected a different installed binary, version 2.1.70; its implementation details should not be assumed identical to the terminal's version.

Native clicks verified both copied command variants, cancellation at both switching pickers, reopening the same managed terminal, and explicit replacement with a new conversation. The existing-conversation command contains `--resume`; the new-conversation command contains neither `--resume` nor `--continue`.

The authenticated QA conversation was instructed to remember `teal lighthouse`. Switching to **Unterhaltung auswählen** opened Claude's real resume picker, where that QA conversation was selected. A subsequent native `/a` comment requested the remembered phrase without repeating it. Claude returned `teal lighthouse` to the same inline thread, with the event acknowledged and the thread marked `answered`. This establishes retained conversational context and automatic feedback delivery after selecting and resuming that conversation.

Bare uppercase `/R`, sent with Cmd+Enter in that native thread, then produced a summarize event and a formatted Claude summary retaining the phrase. The heading became **Zusammenfassung · Beantwortet**. Human resolution removed the editor card; hiding completed discussions removed the completed list row. The terminal panel became visible and focused after summary submission for an unconfirmed reason, so editor-focus preservation is not established by this run.

Evidence: [Claude resume picker](evidence/2026-10-21-claude-resume-picker.png), [resumed conversation's native reply](evidence/2026-10-21-claude-resumed-reply.png), [complete UX verification record](UX-REVIEW-2026-10-21.md).

The first copy attempt failed with a generic Node startup message; a later attempt succeeded. The cause remains unknown. The prepared 0.4.9 follow-up adds bounded process diagnostics and a shorter picker hint; its installation is awaiting explicit confirmation following an automatic approval rejection. Its full automated suite has 229 passing tests, with typecheck and the 21 setup tests passing after the final wording change.

A separate Terminal.app round trip, busy-agent delivery, full VS Code restart, and ownership with two live sessions remain unverified. In-place attachment to an already-running process is still a future feature.

## Evidence for a future live connection

Earlier read-only inspection of a Claude Code **2.1.70** CLI and its bundled implementation found:

- `--resume [value]` accepts a session ID or opens Claude's picker. `--continue` selects the latest conversation in the current directory. Neither is an arbitrary running-process attachment API.
- `/mcp reconnect <name>` searches the session's existing MCP clients. It reports an unknown server rather than registering a new one.
- `/reload-plugins` clears plugin caches, reloads enabled plugins and their hooks, and triggers plugin MCP connection refresh. Its result includes hook and MCP server counts.
- The settings watcher excludes the `--settings` source. In this version, it initially watches settings directories containing an existing settings file. Creating configuration after launch is therefore insufficient as a general attachment strategy.

Official documentation supports [reloading plugin components in an active session](https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins) and [connecting plugin-provided MCP servers when changes apply](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers). A generated local Claude plugin containing Local Review's existing MCP server and hooks is consequently a plausible way to connect the original running conversation without restarting it. It has **not** been verified end to end and is not a shipped hot-attach feature.

The candidate setup is a local marketplace/plugin installation scoped to this repository, followed by `/reload-plugins` in the intended conversation. [Local plugin scope](https://code.claude.com/docs/en/discover-plugins#choose-an-install-scope) keeps enablement in `.claude/settings.local.json`. Existing configuration and credentials must be preserved.

Current documentation also describes `claude attach` for background sessions. That command was absent from the inspected 2.1.70 top-level help. Background-session attachment was not tested in the separate 2.1.280 resume walkthrough.

## Constraints before implementation

- **Conversation ownership:** several Claude conversations can share a workspace. A plugin installation applies to that workspace, so delivery needs an explicit selected session and must never let another session acknowledge its feedback.
- **Idle activation:** loading hooks does not itself replay `SessionStart`. A deliberate initial user turn can arm the existing `UserPromptSubmit` hook. An idle conversation is ready only after its receiver registers, not when plugin installation succeeds.
- **Tool names:** plugin MCP servers are namespaced. Hook guidance and tool lookup must work with the plugin's actual registered names rather than assuming the standalone `local-review` prefix.
- **Lifecycle:** reconnecting, extension reload, terminal exit, switching the chosen conversation and removing the plugin must preserve pending events and avoid duplicate receivers or acknowledgments.

## Validation required

Use a disposable project, isolated Claude configuration and controlled replies first. Start a conversation before installing the plugin; reload it in place and confirm the process and session ID remain unchanged, hooks and MCP tools become available, and one initial turn arms delivery. Test two simultaneous sessions and prove that only the selected session receives feedback. Repeat with a separate terminal, reconnects, pending comments and plugin removal. Finally verify the same sequence with an authenticated Claude conversation before claiming live attachment is supported.

The earlier 2.1.70 research was read-only: no private transcripts or credentials were inspected, and it did not change configuration or use an authenticated conversation. The separately authorized 2.1.280 QA walkthrough above exercised the shipped resume workflow; it did not install or validate the proposed live-attachment plugin.
