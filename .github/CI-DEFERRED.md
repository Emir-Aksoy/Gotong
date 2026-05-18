# CI / Release — deferred work

This document tracks workflow strengthening items that were
intentionally **not** done in the v3.3 hardening pass. Each item has a
specific blocker (missing infra, paid certs, large refactor) — the
goal here is to record the rationale so a future pass can pick them
up without re-litigating the decision.

This file is purely informational. CI does not read it.

---

## C7 — Test coverage (lcov)

**Blocker.** Adding `vitest --coverage` requires installing
`@vitest/coverage-v8` (or `@vitest/coverage-istanbul`) as a
devDependency in every package that runs vitest. Today there are
16 such packages and none have the dep. The smaller path
(`@vitest/coverage-v8` only at the workspace root) doesn't work
because each package's vitest binary resolves its provider against
that package's own `node_modules`.

**Cost.** 16 `package.json` edits + lockfile churn + ~5MB extra in
each package's `node_modules` after install. CI runtime adds ~30s per
matrix leg (v8 coverage instrumentation is fast but not free).

**Value.** Surfaces gaps in test coverage. Not security-critical
since we don't gate merges on coverage thresholds. Most useful as a
red-flag signal when a PR introduces a large untested module.

**When to pick up.** When we have a clear policy on coverage
(e.g. "new code must be ≥80% covered, existing code is grandfathered")
and a willingness to wire codecov.io for diff annotation. Pure lcov
without codecov uploads is mostly cosmetic.

---

## C12 — Lint check (ESLint / Prettier)

**Blocker.** No ESLint / Prettier configuration exists in the repo.
Adding a lint workflow without a config would be a no-op; adding
configs is a project-wide style decision that needs human input on
the rule set (which `eslint-config-*` preset, how strict on
`no-explicit-any`, etc.).

**Cost.** One round of config bikeshedding + a likely sweep of
existing files to fix the first wave of findings. Probably 1-2
person-days of cleanup before the workflow can be enforced.

**Value.** Catches a long tail of style + correctness issues that
typecheck + tests miss (unused vars, missing await, etc.). CodeQL's
`security-and-quality` query suite (added in v3.3) overlaps with
some of this — see `.github/workflows/codeql.yml`.

**When to pick up.** When someone has a concrete preference on
which ESLint preset to adopt. A reasonable starting point is
`@typescript-eslint/recommended` + `eslint-plugin-vitest` for the
test files.

---

## C10 — Slack notify on red main

**Blocker.** Needs a `SLACK_WEBHOOK_URL` repository secret. Owner
hasn't decided which Slack workspace + channel the notifications
should go to (or whether the project has a Slack at all yet).

**Cost.** One workflow file + one secret. Trivial once the
destination is known.

**Value.** Faster awareness of post-merge breakages. With pre-merge
CI already required (`ci-passed` branch protection gate), main
should rarely go red — so this is a low-frequency signal.

**When to pick up.** When the project gains a permanent Slack
presence and an owner who's willing to triage red-main pages. Sketch:

```yaml
# Add to ci.yml under the ci-passed job:
- name: Notify Slack on red main
  if: failure() && github.event_name == 'push' && github.ref == 'refs/heads/main'
  uses: slackapi/slack-github-action@<pinned-sha>
  with:
    webhook: ${{ secrets.SLACK_WEBHOOK_URL }}
    webhook-type: incoming-webhook
    payload: |
      { "text": "🚨 CI failed on main: ${{ github.event.head_commit.message }}" }
```

---

## C13 — `pnpm --filter` / nx / turborepo (affected-only builds)

**Blocker.** Large refactor. To get value out of "build only what
changed", we'd need either:

- pnpm's `--filter ...[origin/main]` syntax wired through every CI
  step (achievable, but pnpm's heuristic is conservative — when in
  doubt it builds everything, so the speedup on small PRs is modest).
- nx or turborepo, which is a full build-system swap: every package
  gets an `nx.json` or `turbo.json` entry, build outputs are
  enumerated for caching, and the workspace gains a new top-level
  config to maintain.

**Cost.** A full week of investigation + migration. Risks introducing
caching bugs that mask broken builds.

**Value.** CI runtime on small PRs would drop from ~6min to ~2min
in the happy case. Modest speedup that's only material for the
"change one line in a leaf package" scenario.

**When to pick up.** When the workspace grows past ~30 packages
(currently 16 TS + 1 Python). At that scale the full `pnpm -r build`
becomes the dominant CI cost.

---

## R6 — macOS code-signing + Windows Authenticode

**Blocker.** Both need paid certificates that cost real money and
require enrolment paperwork:

- **macOS (Apple Developer ID Application):** ~$99/year. Without it,
  Gatekeeper marks the binary as "from an unidentified developer"
  and users must right-click → Open on first launch.
- **Windows (Authenticode code-signing cert):** ~$200-500/year from
  DigiCert/Sectigo. Without it, SmartScreen shows a "Windows
  protected your PC" interstitial.

Both certs need to be stored as repo secrets (base64'd P12 for
macOS, PFX for Windows) plus passwords. macOS additionally needs
notarytool credentials (`AC_USERNAME` + `AC_PASSWORD` / API key)
for notarisation.

**Cost.** Setup is several hours per OS once the certs are in hand.
Annual renewal touches the same secrets — manageable but recurring.

**Value.** Removes a real first-run friction for users on macOS +
Windows. End users today work around it (right-click → Open on
macOS, "Run anyway" on Windows) but it's a confidence hit on a
fresh install.

**When to pick up.** When the project has enough adoption to justify
the cert spend. Sketch of the macOS flow:

```yaml
# In release.yml, after the bun-compile step on macOS targets:
- name: Import codesign certificate
  uses: apple-actions/import-codesign-certs@<sha>
  with:
    p12-file-base64: ${{ secrets.APPLE_DEVELOPER_ID_P12 }}
    p12-password: ${{ secrets.APPLE_DEVELOPER_ID_P12_PASSWORD }}

- name: Sign + notarise
  run: |
    codesign --force --options runtime --sign "$APPLE_TEAM_ID" \
      --timestamp ${{ matrix.target.artifact }}
    xcrun notarytool submit ${{ matrix.target.artifact }} \
      --apple-id "$APPLE_ID" --password "$APPLE_NOTARY_PW" \
      --team-id "$APPLE_TEAM_ID" --wait
```

---

## Private-repo gates (auto-activate on public-flip)

Three workflows / jobs gracefully skip on user-owned private repos
because the underlying GitHub feature requires public visibility or
GitHub Advanced Security:

| Workflow / job | Gate | Reason |
| --- | --- | --- |
| `dependency-review.yml` (job) | `!github.event.repository.private` | Dependency-review-action 404s on private free-tier repos |
| `codeql.yml` (analyze) | `!github.event.repository.private` | SARIF upload to Security tab needs GHAS on private |
| `release.yml` → `provenance` | `!github.event.repository.private` | `Feature not available for user-owned private repositories` from the attestation API |

These are not deferred work — they're already implemented and
parked. The moment the repo flips to public (or GHAS is enabled),
all three activate with no further edits.

## Summary table

| ID | Item | Blocker | Estimated cost | Priority |
| --- | --- | --- | --- | --- |
| C7 | Test coverage | needs `@vitest/coverage-v8` in 16 pkgs | M | low |
| C12 | ESLint / Prettier | no config exists, needs style decision | M-L | medium |
| C10 | Slack notify | needs `SLACK_WEBHOOK_URL` + channel | XS | low |
| C13 | nx / turbo | full build-system swap | XL | low (defer until ~30 pkgs) |
| R6 | Code-signing | needs Apple + Windows paid certs | M (setup) + recurring | medium |
