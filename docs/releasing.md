# Releasing Arbor

Pushing a tag like `v1.2.0` runs the [release workflow](../.github/workflows/release.yml). It builds the desktop app on six runners (macOS, Windows and Linux, each for x64 and arm64), then publishes a GitHub release with the installers and a `SHA256SUMS.txt`. Installed copies of Arbor check GitHub's latest release on launch and offer the new version.

## Before you start

- You're on `main`, the working tree is clean, and you've pulled the latest commits:

  ```bash
  git switch main && git pull && git status
  ```

- CI is green for that commit. Check the Actions tab or run `gh run list --branch main --limit 3`.
- Pick the version. Use `MAJOR.MINOR.PATCH` with no suffix, because the workflow only triggers on tags of that form:
  - **Patch** (`1.1.0` → `1.1.1`): bug fixes only.
  - **Minor** (`1.1.0` → `1.2.0`): new features, and old projects still open.
  - **Major** (`1.1.0` → `2.0.0`): something users have to act on, such as a project format change or a new live protocol version.
- The version must be higher than the last release (`git tag --sort=-v:refname | head -1`). Installed apps only offer an update when the new version is higher than the one they have.

## 1. Bump the version

```bash
npm version 1.2.0 --no-git-tag-version   # updates package.json and package-lock.json
git commit -am "Release v1.2.0"
git push
```

The workflow would also set the version from the tag on its own. Committing the bump keeps `main` and local builds reporting the same version as the release.

Wait for CI on this commit to pass before you tag it.

## 2. Optional: try a local build

```bash
npm run build:desktop
```

Open the installer from `release/` and check that the app starts, opens a project and connects to the mock robot (`npm run mock-robot -- --project examples/demo_project`). This build is for your machine's platform only. CI covers the others.

## 3. Tag and push

```bash
git tag -a v1.2.0 -m "Arbor v1.2.0"
git push origin v1.2.0
```

Pushing the tag starts the release workflow.

## 4. Watch the workflow

```bash
gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')
```

Each of the six build jobs typechecks, runs the tests and packages its platform. The **Publish release** job runs only after all six have passed.

## 5. Check the release

```bash
gh release view v1.2.0
```

It should contain seven files:

| File | Count |
|---|---|
| `Arbor-1.2.0-mac-arm64.dmg`, `Arbor-1.2.0-mac-x64.dmg` | 2 |
| `Arbor-1.2.0-win-arm64.exe`, `Arbor-1.2.0-win-x64.exe` | 2 |
| `Arbor-1.2.0-linux-arm64.AppImage`, `Arbor-1.2.0-linux-x64.AppImage` | 2 |
| `SHA256SUMS.txt` | 1 |

Then:

- Read the generated notes (`gh release edit v1.2.0 --notes-file NOTES.md` replaces them). Call out anything users must do, such as a project format change.
- Install the release on at least one platform and check that it runs.
- Open an older installed version. On launch it should say "Arbor 1.2.0 is available".

## If something goes wrong

**A build job failed and nothing was published.** The release only appears after every build passes.
- If the failure looks transient (a runner hiccup or a download timeout), use **Re-run failed jobs** on the workflow run.
- If the code needs a fix, delete the tag, fix and commit on `main`, then tag again:

  ```bash
  git tag -d v1.2.0
  git push origin :refs/tags/v1.2.0
  # fix, commit, push, wait for CI
  git tag -a v1.2.0 -m "Arbor v1.2.0"
  git push origin v1.2.0
  ```

**The release was published but is broken.** Don't reuse the version. Installed copies may already have it, and they'd never be offered a fixed build with the same number. Release the next patch version (`1.2.1`) with the fix.
- To steer people away from the broken release in the meantime, add a note at the top of its description with `gh release edit v1.2.0 --notes "..."`.
- You can also mark it as a pre-release with `gh release edit v1.2.0 --prerelease`. GitHub then stops returning it as the latest release, so installed apps stop offering it.

**Publish failed with "release already exists".** A release for that tag is already on GitHub, possibly from an earlier run. Delete it with `gh release delete v1.2.0` if it's incomplete, then re-run the **Publish release** job.

## Notes

- Releases aren't code-signed with a Developer ID or notarized. macOS and Windows show a warning on first launch; the README's Quick start tells users how to get past it.
- The release notes come from `--generate-notes`, which lists any pull requests merged since the previous tag and links to the full comparison. Commits pushed straight to `main` don't appear individually, so write notes by hand when that's how the changes landed.
