<!--
  Thanks for the PR! A few quick prompts to help the review go fast.
  Delete anything that doesn't apply.
-->

## What does this change?

<!-- One-sentence summary. "Add X to Y so that Z." -->

## Why?

<!-- Link the issue (`Closes #NNN`) or describe the motivation. -->

## How was it tested?

<!--
  - `pnpm -r typecheck` clean? (required)
  - `pnpm -r test` clean? (required for code changes)
  - End-to-end smoke (host boot, dispatch a task, admin UI loads)? (recommended for UI / host changes)
  - Manual checks specific to this change?
-->

## Checklist

- [ ] Reads `CONTRIBUTING.md` "Ground rules" — keeps the Hub dumb
- [ ] Tests added or updated where relevant
- [ ] Docs updated (`README.md`, `docs/*.md`, package READMEs) if user-facing
- [ ] `CHANGELOG.md` updated under the appropriate "Unreleased" section
- [ ] If the wire protocol changed: `docs/PROTOCOL.md` updated + version bump considered
- [ ] If a new env var, route, or `Space` file shape: a `RELEASE-CHECKLIST.md` line added

## Screenshots / clips (UI changes only)

<!-- Drag and drop a PNG or short GIF. Recorded with scripts/demo-60s.sh? Even better. -->
