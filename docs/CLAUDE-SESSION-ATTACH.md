# Connecting Claude conversations

Research date: 2026-10-21. This note separates the supported resume workflow from a possible future connection to an already-running process.

## Current scope

Local Review offers a new conversation, a picker for a specific saved conversation, and a launch command for a separate terminal. Resuming preserves the selected conversation's history and loads Local Review's MCP and hook configuration for the new process. It does **not** attach to the old terminal process.

The old process must finish or be exited before the same conversation is resumed. For a terminal managed by Local Review, the explicit **Unterhaltung wechseln** action may close that review terminal after the user chooses the next conversation mode and preparation succeeds. Cancelling either picker or a preparation failure preserves it. An unmanaged terminal process is never killed by Local Review; the user exits it themselves. Local Review must not run a second writer against the same conversation automatically. Launch-time `--settings` and `--mcp-config` arguments must be passed again on resume; Claude does not restore those flags from conversation history. See [Claude session restoration](https://code.claude.com/docs/en/sessions#what-a-resumed-session-restores).

## Evidence for a future live connection

Read-only inspection of the installed Claude Code **2.1.70** CLI and bundled implementation found:

- `--resume [value]` accepts a session ID or opens Claude's picker. `--continue` selects the latest conversation in the current directory. Neither is an arbitrary running-process attachment API.
- `/mcp reconnect <name>` searches the session's existing MCP clients. It reports an unknown server rather than registering a new one.
- `/reload-plugins` clears plugin caches, reloads enabled plugins and their hooks, and triggers plugin MCP connection refresh. Its result includes hook and MCP server counts.
- The settings watcher excludes the `--settings` source. In this version, it initially watches settings directories containing an existing settings file. Creating configuration after launch is therefore insufficient as a general attachment strategy.

Official documentation supports [reloading plugin components in an active session](https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins) and [connecting plugin-provided MCP servers when changes apply](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers). A generated local Claude plugin containing Local Review's existing MCP server and hooks is consequently a plausible way to connect the original running conversation without restarting it. It has **not** been verified end to end and is not a shipped hot-attach feature.

The candidate setup is a local marketplace/plugin installation scoped to this repository, followed by `/reload-plugins` in the intended conversation. [Local plugin scope](https://code.claude.com/docs/en/discover-plugins#choose-an-install-scope) keeps enablement in `.claude/settings.local.json`. Existing configuration and credentials must be preserved.

Current documentation also describes `claude attach` for background sessions. That command was absent from the inspected 2.1.70 top-level help; newer background-session behavior must not be assumed on this installation.

## Constraints before implementation

- **Conversation ownership:** several Claude conversations can share a workspace. A plugin installation applies to that workspace, so delivery needs an explicit selected session and must never let another session acknowledge its feedback.
- **Idle activation:** loading hooks does not itself replay `SessionStart`. A deliberate initial user turn can arm the existing `UserPromptSubmit` hook. An idle conversation is ready only after its receiver registers, not when plugin installation succeeds.
- **Tool names:** plugin MCP servers are namespaced. Hook guidance and tool lookup must work with the plugin's actual registered names rather than assuming the standalone `local-review` prefix.
- **Lifecycle:** reconnecting, extension reload, terminal exit, switching the chosen conversation and removing the plugin must preserve pending events and avoid duplicate receivers or acknowledgments.

## Validation required

Use a disposable project, isolated Claude configuration and controlled replies first. Start a conversation before installing the plugin; reload it in place and confirm the process and session ID remain unchanged, hooks and MCP tools become available, and one initial turn arms delivery. Test two simultaneous sessions and prove that only the selected session receives feedback. Repeat with a separate terminal, reconnects, pending comments and plugin removal. Finally verify the same sequence with an authenticated Claude conversation before claiming live attachment is supported.

No private transcripts or credentials were inspected, and no authenticated conversation, installation or configuration change was performed for this research.
