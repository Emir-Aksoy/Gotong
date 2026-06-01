# Public-release checklist

Things that are **placeholders today** and must be replaced / activated
before the first public 1.0 release (or before publishing to npm).

Each item links to where it appears in the repo so a `grep` against the
list keeps the checklist honest.

## Security contact

> **Decided 2026-06-01 (Phase 19 P3-M3):** no email channel pre-1.0.
> GitHub Private Vulnerability Reporting is the **sole** disclosure
> channel. The `security@aipehub.dev` placeholder has been removed from
> the advertised contacts (`SECURITY.md` → "No email channel",
> `security.txt` → no `mailto:` line) rather than dangle a dead address.
> Standing up a real mailbox stays a 1.0 *option*, not a blocker.

- [ ] **(Optional, post-1.0) Activate a security mailbox** — only if a
      non-GitHub channel proves necessary. Would need DNS MX, an
      autoresponder pointing at the advisory URL, and on-call routing,
      then re-adding the `mailto:` to `SECURITY.md` + `security.txt`.
- [ ] **Enable Private Vulnerability Reporting** on
      `github.com/Emir-Aksoy/AipeHub` (Settings → Security & analysis).
      Without this the `/security/advisories/new` URL returns 404 for
      external reporters.
- [ ] **Refresh `Expires:` in `security.txt`** to a date < 1 year out
      whenever you update the file. Renewal cadence: every spring.
- [ ] **Decide PGP policy** — current stance is "no PGP, use GitHub
      advisory's TLS channel". If you change your mind, publish a key
      at `https://aipehub.dev/security.asc` and update both
      `SECURITY.md` and `security.txt`.

## Domain & DNS

- [ ] **Register `aipehub.dev`** (or whichever domain is canonical).
      Until then, `aipehub.dev` in this repo is **aspirational**, not
      authoritative.
- [ ] **Set up Caddy** or equivalent in front of any public demo —
      the `docs/DEPLOY.md` C-shape pattern is the reference.

## Distribution decision (was: npm / PyPI publish)

The "publish to npmjs.com + pypi.org" plan was **descoped from the
v1.0 critical path** in v2.1 (see CHANGELOG → Unreleased v2.1 →
Distribution). Source-only + Docker now cover both Quick-start paths.

> **Reaffirmed 2026-06-01 (Phase 19 P3-M3):** Docker + source stay the
> primary (and only *supported*) distribution. A JS registry, PyPI, and
> pre-built binaries remain independent post-1.0 options — any can stay
> "no" indefinitely without blocking a release.

Three open decisions remain — each is independent and any of them
can stay "no" indefinitely:

- [ ] **Pick a JS registry**:
  - **Option 1 — Source-only (status quo).** Users `git clone` +
    `pnpm install && pnpm build`. Zero registry maintenance. README
    Quick-start `B` already documents this. Choose this and delete
    this checklist item.
  - **Option 2 — JSR (jsr.io).** GitHub OAuth login (no separate
    npm account), native TypeScript, works with npm / pnpm / Bun /
    Deno. Suggested if `npm install`-equivalent UX matters. Requires
    `@aipehub` scope reservation on jsr.io and minor `package.json`
    `exports` cleanup per package.
  - **Option 3 — GitHub Packages.** Same `@aipehub/*` scope as the
    GitHub org. Standard `npm publish` workflow. Lower install UX
    than JSR — users must put `@aipehub:registry=https://npm.pkg.github.com`
    in `.npmrc` first. Choose this if you want zero-tooling change.
  - **Option 4 — npmjs.com.** The original plan. Requires npm
    account + 2FA + `@aipehub` org reservation. Best install UX (`pnpm
    add @aipehub/workflow`) but most setup overhead.
- [ ] **PyPI publish for `aipehub`**: same source-only-vs-published
      call. Currently `pip install -e python-sdk/` is the only path.
      Referenced in [`python-sdk/README.md`](../python-sdk/README.md)
      and [`docs/AGENT.md`](../docs/AGENT.md). If you publish to a JS
      registry, doing PyPI alongside keeps consistency.
- [ ] **Pre-built single-file binaries** for macOS (arm64 + x64) and
      Windows x64. Non-blocking — Docker covers cross-platform
      "click and run" today. If pursued:
  - Bun `--compile` is the leading candidate (one cross-compile
    command per target on a single Mac).
  - Blocker: `packages/web/src/server.ts` reads static assets via
    runtime `readFile` from `<package>/static/`. The static files
    need to be inlined into the bundle (≈100 lines of build-step
    work) before the binary is self-contained.
  - Distribution channel: GitHub Releases (no separate hosting
    needed). Workflow: build on tag push via GitHub Actions matrix
    (linux/macos/windows runners), upload artifacts to the release.

## Documentation polish

- [ ] **Replace `hub.example.com` example URLs** in docs with whatever
      domain hosts the project's own public-preview / demo deployment.
- [ ] **Translate** the remaining `docs/zh/` queue —
      see [`docs/zh/README.md`](../docs/zh/README.md) "翻译状态" table.
      Priority: AGENT → DEPLOY → FEDERATION → LICENSE-FAQ.
- [ ] **Refresh `Adapted:` dates** in `templates/community/agents/*.yaml`
      headers if the prompts get a re-pass before launch.

## Repo hygiene

- [x] Add `.github/ISSUE_TEMPLATE/` (bug / feature / docs) and
      `.github/PULL_REQUEST_TEMPLATE.md`. Done — four issue forms
      (`bug_report.yml`, `feature_request.yml`, `documentation.yml`,
      `config.yml`) plus the PR template.
- [ ] Enable GitHub Discussions; seed categories: Q&A, Show & Tell, Ideas.
- [x] Add `.github/dependabot.yml` for npm + pnpm + GitHub Actions
      updates. Done — weekly cadence, grouped by `patch-and-minor` /
      `test-tooling` / `actions`. First batch (#4–#11) landed
      2026-05-17; `vitest` major is `ignore`d until vite 5→6 is
      coordinated, `actions/setup-node` major is `ignore`d until the
      v6 prebuild-libc detection issue with `better-sqlite3@12`
      resolves upstream.
- [x] Decide on a CI provider — GitHub Actions, live in
      `.github/workflows/ci.yml`. Three jobs now: Node 20/22 (`pnpm
      -r build typecheck test`), Python 3.10/3.11/3.12 (`pytest
      python-sdk`), and the production Docker image smoke build
      added 2026-05-17 (catches `pnpm-workspace.yaml` vs Dockerfile
      drift). Template parse check is covered by `pnpm -r test`.
      Concurrency cancels in-flight PR runs but lets post-merge
      `main` runs finish.

## Operational

- [ ] Pick a CVE numbering authority arrangement — GitHub Security
      Advisories can request CVEs on your behalf; confirm the workflow.
- [x] Decide a "supported versions" policy concrete enough to put in
      `SECURITY.md`. **Decided 2026-06-01 (Phase 19 P3-M3):** current
      `main` only, no LTS branch — already the stated policy in
      `SECURITY.md` → "Supported versions". Revisit if/when a 1.0 tag
      creates a stable line worth backporting to.
- [ ] Run one tabletop exercise of "high-severity report comes in at
      Friday 19:00" to validate the 72-hour ack target.

---

Once every box is checked, delete this file. Its absence == "we shipped
the placeholder cleanup".

Last reviewed: 2026-06-01.
