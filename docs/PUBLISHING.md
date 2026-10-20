# Releases and Marketplace publishing

The extension is not published to the VS Code Marketplace yet. `local-review-dev` is a development placeholder, not a claim of publisher ownership.

## Register the publisher

Use the owner's Microsoft account to sign in to [Marketplace publisher management](https://marketplace.visualstudio.com/manage) and create a publisher. Choose the identifier carefully: it is unique and cannot be changed. Set `package.json` → `publisher` to that exact ID, then rebuild the VSIX. The publisher's display name is a separate field. [Official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher)

For the first release, browser upload is the simplest route: package the extension, open the publisher's management page, and upload the VSIX as a VS Code extension. This uses the signed-in account; no CLI personal access token is needed for this route. Review the listing and confirm its published status before adding a Marketplace install link. [Manual upload instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-an-extension)

Account sign-in, publisher creation, and acceptance of Marketplace terms belong to the account owner. Do not commit credentials. Automated Marketplace publishing is not configured.

## Prepare a GitHub release

Update the version in `package.json` and its lockfile, and describe the change in `CHANGELOG.md`. Resolve the source findings and complete the checks recorded in [REVIEW.md](REVIEW.md). Before Marketplace upload, also settle the publisher ID, licensing, repository metadata, and listing assets.

A developer preview can be shared earlier for evaluation when its release notes explicitly list unfinished verification. The initial 0.1.1 GitHub prerelease follows this route: packaging succeeded, while type checking, automated tests, and a live authenticated Claude walkthrough remain pending. It is not a validated stable release.

The **Validate and package** workflow is manual. On the repository's **Actions** page, select it, choose the intended branch, and explicitly approve the checks. It installs locked dependencies, runs type checking and tests, builds the extension, and uploads the VSIX as a workflow artifact. A successful run is evidence for that commit only.

The **Prepare release** workflow is also manual. Run it on `main`, supply the version already committed in `package.json`, and approve checks and draft-release creation. It validates, packages, and creates a **draft GitHub prerelease** with the VSIX attached. Review the draft, install its VSIX, record the live smoke-test result, then publish the release in GitHub when ready. The workflow never uploads to the Marketplace.

Run these workflows only after human approval. They are deliberately not triggered by pushes, pull requests, or tags. GitHub explains [how to run a manual workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

## Listing assets

The README links to a staged demo with simulated Claude replies. Keep that disclosure when sharing it. Relative README images need a reachable repository URL when rendered on the Marketplace; if the repository is private, use an appropriate public HTTPS image location before packaging a public listing.
