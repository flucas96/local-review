# Project instructions

Analyze the project structure before making changes. Keep the native VS Code review workflow simple and preserve existing behavior.

## Code

- Use strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Reuse existing helpers and keep persisted review data independent of the transport.
- Add doc comments for exported behavior. Do not number implementation steps in comments.
- Use clear system sans-serif fonts for extension UI and monospace fonts for code. Never use Comic Sans or handwritten novelty fonts.
- Treat transport data as unknown until validated.
- Ask before running lint, type checks, or tests in approval-gated sessions. Builds and packaging are separate operations.

## Product invariants

- Submitted comments are delivered automatically. Unsent keystrokes are not agent instructions.
- Native inline input is the default, with one send action and `/a`, `/i`, `/r` interpreted when sending. The optional compact side composer previews modes while typing.
- Keep inline conversations anchored to their code. In the side composer, empty drafts may follow new explicit selections; written drafts and replies must not silently change targets.
- `ask` and `summarize` request discussion without edits; `implement` requests scoped code changes.
- `/r` summarizes a local conversation. Publishing to a GitHub PR is a separate preview-and-publish action.
- PR handoff publishes the reviewed snapshot only and does not acknowledge delivery or resolve local threads.
- Only the human can resolve a thread. An agent response is not human acceptance.
- Preserve immutable event IDs and original code context across edits and restarts.
- A transport connection is not a delivery acknowledgment.
- Do not silently attach uncertain comments to another line of code.
- Code actions open current project code only after a confirmed content match. Proposed, missing or ambiguous snippets stay read-only; Markdown code blocks do not claim native editor semantics.
- Generated editor links use opaque session handles and a single allowlisted command. Model-provided paths or command arguments cannot select navigation targets.
- Keep connection credentials outside the repository and preserve existing Claude configuration.

## Commands

Use `npm ci --ignore-scripts` for dependencies, `npm run build` for bundles, and `npm run package` for the installable VSIX. Type checking and targeted tests are `npm run typecheck` and `npm test` when authorized.

Use Python through `uv run` if a supporting media task requires it.

## Tracking

Record user-visible changes in `CHANGELOG.md`. Keep installation, publishing, review findings, and known limitations current in `README.md` and `docs/`.

Commit messages use `<type>(<scope>): <lowercase subject>` with `!` before the colon for breaking changes.
