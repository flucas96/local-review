# Install Local Review

Local Review is distributed as a VSIX preview. A Marketplace listing is not available yet.

## Requirements

| Requirement | Current support |
| --- | --- |
| VS Code | 1.100 or newer, trusted local workspace |
| Node.js | 22 or newer, available to Claude and its hooks |
| Git | Available on your computer |
| Claude Code | Installed, authenticated, with `asyncRewake` support |
| Operating system | macOS primary; Linux unverified; automatic connection blocked on Windows |

## Install the extension

1. Open [GitHub Releases](https://github.com/flucas96/local-review/releases) and download the attached `.vsix`. Preview releases may be marked **Pre-release**. If no release is available, a maintainer must first publish one.
2. In VS Code, open **Extensions**, choose **… → Install from VSIX…**, and select the downloaded file.
3. Open your local Git repository in a trusted VS Code window.

VS Code also supports `code --install-extension /path/to/local-review-VERSION.vsix`. See the [official VSIX installation instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions).

## Connect Claude

Run **Local Review: Mit Claude verbinden** from the Command Palette. Choose **Neue Review-Unterhaltung** for a new conversation or **Letzte Unterhaltung fortsetzen** to continue the latest one. Close any existing Claude process using that conversation before continuing it here.

The extension starts Claude in an integrated terminal with the review connection attached. Complete any normal Claude trust or tool-permission prompts. An arbitrary Claude terminal opened earlier is not attached automatically.

## Leave your first comment

Run **Local Review: Änderungen reviewen** and select a changed file. Select a line or block, then use **Local Review: Kommentar hinzufügen**, the editor context menu, or **⌘⌥M / Ctrl+Alt+M**.

Choose **Fragen `/a`**, **Umsetzen `/i`**, or **Zusammenfassen `/r`**. You can also prefix your text with the shortcut. `/r` on an existing thread can summarize it without additional text. A submitted comment is queued immediately.

Wait for explicit receipt and Claude's reply. **Bereit zur Prüfung** means the implementation is ready for your review. Use **Als erledigt markieren** when you accept it, or **Wieder öffnen** to continue a resolved conversation.

## If the connection needs attention

| Symptom | What to try |
| --- | --- |
| Claude or Node cannot be found | Set **Local Review: Claude Path** or **Local Review: Node Path** to the full executable path. |
| Multiple Claude installations | Set the Claude path explicitly; different terminals may resolve different versions. |
| Claude has exited but the terminal remains | Run **Mit Claude verbinden** again. Use **Verbindung neu starten** when offered. |
| A comment remains waiting | Open the connected terminal and check Claude's startup and tool approval prompts. A live bridge is not proof that Claude acknowledged the event. |
| More than 24 hours of idle time | Reconnect or send a prompt to Claude to rearm the watcher. |
| Context has changed | Open the thread. A saved excerpt is used when the original location cannot be matched safely. |

Keep **Local Review: Transport** set to **hooks** for the default connection. The optional **channels** mode uses Claude's development-channel interface and depends on account availability, organization policy, and startup confirmation. Choose it before connecting a new session.

For unresolved problems, [open an issue](https://github.com/flucas96/local-review/issues/new/choose) with your extension, VS Code, Node, and Claude versions plus reproducible steps. Remove credentials and private code from logs before sharing them.
