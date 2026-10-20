# Share local feedback with a GitHub PR

PR handoff is a separate action. `/r` continues to ask Claude for a local conversation summary; it does not publish anything.

## Preview and publish

Install the [GitHub CLI](https://cli.github.com/) and sign in with `gh auth login`. Open the local branch that already has an open PR. In VS Code's Review toolbar choose **Local Review: An GitHub-PR übergeben**.

Choose the available summaries and unresolved questions to include. The preview identifies the destination repository and PR and lets you edit the Markdown before publishing. It is a snapshot: later Claude replies or local comments do not silently change what you are about to send. Reopen the action to prepare an updated snapshot.

Use the explicit publish/update button after reviewing the text. Closing the preview does not publish. Sharing does not mark local work delivered, resolve a conversation, commit files, push the branch, or create a PR.

## What appears on GitHub

The handoff creates one discussion comment in the PR. Later handoffs update the managed part of that same user-owned comment, preserving text outside the markers. A failed or uncertain request is reconciled against those markers before another create attempt. Duplicate managed comments require attention rather than an arbitrary overwrite.

Completed summaries come from Claude's actual replies to `/r` events. You may explicitly select a summary from a resolved conversation; those conversations are not preselected. A requested summary without a reply is not invented. Summaries made before later discussion are identified as older context. Active questions come from unresolved local conversations; an answered question can still remain open for human acceptance.

Captured file paths, line numbers and Git revisions describe local context. They are not presented as verified positions in the pushed PR diff. Native inline PR review comments need a later change that validates the PR head and maps diff sides accurately.

## If handoff needs attention

- No open PR: open the branch with the intended PR, or create the PR through your normal workflow first.
- Missing CLI or authentication: install GitHub CLI and sign in from your terminal, then reopen the action.
- Branch or destination changed: refresh the preview before publishing.
- Comment too long: remove sections or shorten the preview; content is not silently truncated.
- Publishing failed: the preview remains available; retry after checking the error. Existing managed comments are checked before creating another.

Only the content you review and explicitly publish leaves the local review store through this action. The feature does not automatically synchronize future comments.
