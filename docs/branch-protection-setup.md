# Branch Protection Setup

One-time GitHub configuration required after the CI workflows are in place.

## Required CI Workflows

These workflows must exist in `.github/workflows/`:

**`ci.yml`** — runs typecheck and tests on every PR targeting `main`:
```yaml
name: CI

on:
  pull_request:
    branches:
      - main

jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck && npm test
```

**`version-bump.yml`** — auto-bumps `package.json` on every PR targeting `main` based on conventional commits. See `.github/workflows/version-bump.yml` for the full script.

**`release.yml`** — runs semantic-release on push to `main` to create the git tag and GitHub release. Must NOT include `@semantic-release/git` or `@semantic-release/changelog` — these attempt a direct push to the protected branch and will fail with `GH013`.

## GitHub Branch Protection Configuration

Go to: **GitHub repo → Settings → Branches → Add rule** (or Edit if a rule for `main` already exists).

Set the following:

| Setting | Value |
|---|---|
| Branch name pattern | `main` |
| Require a pull request before merging | ✓ |
| Require status checks to pass before merging | ✓ |
| Status check: | `CI / verify` |
| Require branches to be up to date before merging | ✓ |
| Do not allow bypassing the above settings | ✓ (recommended) |

The status check name `CI / verify` is derived from the workflow name (`CI`) and job id (`verify`) in `ci.yml`. If you rename either, update this value to match.

## How Releases Work

No manual steps required after this setup:

1. Developer opens PR with conventional commits (`feat:`, `fix:`, etc.)
2. `CI / verify` runs typecheck + tests — must pass before merge is allowed
3. `version-bump` workflow commits the next version to `package.json` on the branch
4. PR merges to `main`
5. `release` workflow runs semantic-release → creates git tag + GitHub Release

## AGENTS.md / CLAUDE.md Updates

Add the following section to `AGENTS.md` (or `CLAUDE.md` if there is no `AGENTS.md`) in the repo root:

```markdown
## File Delivery

When the user asks to copy, download, or share a file (any type), always use the SendUserFile tool to deliver it — never print the contents inline.
```

This cannot be automated via hooks (hooks fire on tool events, not message intent) — it must live in the agent instructions file so every session picks it up.

If the repo uses `CLAUDE.md` with `@AGENTS.md`, add the section to `AGENTS.md`. If it uses only `CLAUDE.md`, add it there.

## Conventional Commit → Version Mapping

| Commit prefix | Version bump |
|---|---|
| `fix:` | patch (1.0.0 → 1.0.1) |
| `feat:` | minor (1.0.0 → 1.1.0) |
| `feat!:` or `BREAKING CHANGE` in body | major (1.0.0 → 2.0.0) |
| `chore:`, `docs:`, `refactor:`, etc. | no release |
