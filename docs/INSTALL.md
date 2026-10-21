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

The native inline field opens at the selected lines. You can also use the gutter **+** directly. Type `/a` to ask, `/i` to request implementation, or `/r` to summarize, followed by your feedback, then choose **Senden**. The prefix switches the request mode when sending. Bare `/r` on an existing thread can summarize it without additional text. Typing alone does not send anything.

Reply directly in the existing thread. The shortcut and editor action also support the original side of Local Review diffs. Native unsent drafts are managed by VS Code; the extension does not guarantee their recovery after a reload.

For live mode buttons and locally saved drafts, run **Local Review: Feedback in Seitenansicht schreiben**. This compact optional composer stays open after sending and follows new nonempty mouse/keyboard selections without stealing focus. Written drafts and existing replies stay pinned; use **Neue Auswahl kommentieren** to start another draft while keeping the old one. A simple click or focus change does not retarget feedback. **Local Review: Entwurf fortsetzen** restores the latest side-composer draft.

New Claude replies are instructed to use Markdown code fences with a language label and real line breaks. Clearly recognized standalone JavaScript/TypeScript imports and exported functions are shown in a code box even in older unfenced replies; stored answer text remains unchanged. Ambiguous syntax and other languages still need explicit Markdown fences. Restart the connected Claude session after updating so its loaded tools and hooks receive the latest formatting contract.

Use the small **editor icon** in the reply header beside the author or beside the optional composer's code preview. Hover it for the **Code im Editor öffnen** label. Confirmed source opens in the project editor without closing the discussion. Hover symbols, use **Cmd-click** on macOS / **Ctrl-click** elsewhere, or press **F12** for definitions as supported by the language extension. If the reply is proposed code or cannot be uniquely located, **Codevorschau** opens a read-only snapshot with syntax colors; project navigation is limited. Original and captured snippets are never applied to a file by this action. A preview of an unsent draft may need reopening from that draft after a window reload.

Wait for explicit receipt and Claude's reply. **Zur Prüfung** means the implementation is ready for your review. Use the **✓ Als erledigt markieren** action on the thread or Review list entry when you accept it. Completed threads disappear from the editor, Comments panel and Review list by default. Use the Review toolbar's **eye · Erledigte anzeigen**, then **Wieder öffnen** to continue one. The visibility preference is saved per workspace; all discussion remains stored. Human and Claude messages use distinct avatars; VS Code controls the native card layout.

## Share selected feedback with an open PR

Install the GitHub CLI and sign in with `gh auth login` if you want PR handoffs. In the Review toolbar choose **An GitHub-PR übergeben**, select summaries and unresolved questions, review/edit the preview, and explicitly publish. This action does not acknowledge or resolve local feedback. See [PR handoff](PR-HANDOFF.md).

## If the connection needs attention

| Symptom | What to try |
| --- | --- |
| Claude or Node cannot be found | Set **Local Review: Claude Path** or **Local Review: Node Path** to the full executable path. |
| Multiple Claude installations | Set the Claude path explicitly; different terminals may resolve different versions. |
| Claude has exited but the terminal remains | Run **Mit Claude verbinden** again. Use **Verbindung neu starten** when offered. |
| A comment remains waiting | Open the connected terminal and check Claude's startup and tool approval prompts. A live bridge is not proof that Claude acknowledged the event. |
| Repeated “Stop hook feedback” | Update the extension and reconnect Claude once. Normal hook rearming remembers events already announced in that session. Starting/resuming a session intentionally recovers unfinished work. The generic hook heading belongs to Claude Code; the message beneath it identifies the feedback. |
| More than 24 hours of idle time | Reconnect or send a prompt to Claude to rearm the watcher. |
| Context has changed | Open the thread. A saved excerpt is used when the original location cannot be matched safely. |

Keep **Local Review: Transport** set to **hooks** for the default connection. The optional **channels** mode uses Claude's development-channel interface and depends on account availability, organization policy, and startup confirmation. Choose it before connecting a new session.

For unresolved problems, [open an issue](https://github.com/flucas96/local-review/issues/new/choose) with your extension, VS Code, Node, and Claude versions plus reproducible steps. Remove credentials and private code from logs before sharing them.
