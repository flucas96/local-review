# Local Review

### Review local code. Give Claude feedback where it belongs.

GitHub-style review conversations, directly in VS Code. Select a line in your local changes, ask a question or request a change, and send it straight to Claude Code in your terminal. Replies return to the same inline thread.

[Install the preview](docs/INSTALL.md) · [Download a VSIX](https://github.com/flucas96/local-review/releases) · [Report an issue](https://github.com/flucas96/local-review/issues/new/choose)

[![Watch the Local Review demo](docs/media/local-review-poster.jpg)](docs/media/local-review-demo.mp4)

**Demo:** staged interface with simulated Claude responses. It illustrates the intended workflow; it is not a recording of a verified live integration.

## A review that becomes a conversation

Open a diff, leave feedback, and keep reviewing. Each submitted comment reaches your connected agent automatically—there is no separate review submission.

| Action | What Claude is asked to do |
| --- | --- |
| **Ask `/a`** | Explain a decision or discuss the code. |
| **Implement `/i`** | Make the requested change, then return it for your review. |
| **Summarize `/r`** | Condense the conversation and its remaining decisions. |

Native VS Code comments keep the conversation next to the code. The Review sidebar shows what is waiting, received, in progress, or ready for you. Claude can reply and report progress; **you decide when a thread is resolved**.

## Start in a minute

Download a `.vsix` from [GitHub Releases](https://github.com/flucas96/local-review/releases), then choose **Extensions → … → Install from VSIX…** in VS Code. The extension is not published on the Marketplace yet.

Open a trusted local Git repository and run **Local Review: Mit Claude verbinden**. Choose a new conversation or continue the last one. Open **Local Review: Änderungen reviewen**, select code, and add a comment with **⌘⌥M** on macOS or **Ctrl+Alt+M** on Linux. Use **Fragen**, **Umsetzen**, or **Zusammenfassen** to send it. The current interface uses German labels.

Requires **VS Code 1.100+**, **Node.js 22+**, **Git**, and an installed, authenticated **Claude Code with `asyncRewake` support**. macOS is the primary target; Linux is unverified. Automatic connection is currently unavailable on Windows. [Installation and troubleshooting →](docs/INSTALL.md)

## How the connection works

The default connection combines Claude hooks with MCP. A background hook watches a private queue on your computer and wakes Claude when feedback arrives. MCP tools acknowledge receipt and return replies to VS Code. Feedback does not interrupt a tool already running.

Connection files and submitted threads live in VS Code's workspace storage. The extension passes configuration to the session it launches, without editing your repository's `.claude` files or `.mcp.json`. Claude's existing tool permissions still apply; `/a` and `/r` are instructions to avoid edits, not a separate permission sandbox.

Code context is captured when you submit feedback. If an old location cannot be identified safely, the thread opens its saved context. Renamed files appear as a deletion and an addition.

## Preview status

This is an early preview. The **0.1.1 bundle builds successfully**. Type checking, automated tests, and a complete VS Code + authenticated Claude walkthrough are **pending verification**. The demo uses simulated responses. [Review findings and remaining limits →](docs/REVIEW.md)

- One local workspace folder and one intended agent session.
- The background watcher expires after 24 hours; reconnect or send Claude a prompt to rearm it.
- Submitted comments persist. Unsent composer text is not durably autosaved by the extension.
- Delivery is at least once. Event IDs reduce duplicate responses; agent side effects cannot be guaranteed exactly once after a crash.

## Contribute

[Development guide](CONTRIBUTING.md) · [Review tracker](docs/REVIEW.md) · [Marketplace publishing guide](docs/PUBLISHING.md)

The manual GitHub workflows can validate and package the extension or prepare a draft release. They require explicit approval to run checks and never publish to the Marketplace.

Built on the [VS Code Comments API](https://code.visualstudio.com/api/references/vscode-api#CommentController), [Claude hooks](https://code.claude.com/docs/en/hooks), and [MCP](https://code.claude.com/docs/en/mcp).
