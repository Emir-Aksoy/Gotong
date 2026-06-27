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
      _Currently `2027-05-12` — RFC 9116-compliant; refresh before
      spring 2027._
- [x] **Decide PGP policy** — **Decided: no PGP.** The "no PGP, use
      GitHub advisory's TLS channel" stance is already shipped in
      `SECURITY.md` ("What about PGP?") and `.well-known/security.txt`
      (note 3). If you ever change your mind, publish a key at
      `https://aipehub.dev/security.asc` and update both files.

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

> **Distribution review 2026-06-08:** Maintainer affirmed *"no change
> now."* Through 1.0 — while the repo is private and `main` still changes
> schema freely — Docker + source-only stay the **only** channel:
> publishing to any registry would impose a SemVer-compat contract that
> fights the project's "no backward-compat pre-1.0" stance. At 1.0 (API
> frozen + repo public) the preferred order is ① **pre-built binaries**
> (infra already done — highest value for the "5-minutes, no code" end
> user), ② **JSR** (native TS + GitHub OAuth, no separate npm account/2FA;
> all 17 publishable packages already ship `exports`/`files`/
> `publishConfig`), ③ **PyPI** alongside (`pyproject.toml` ready),
> ④ **npmjs.com** lowest priority. All gated on the repo going public.

Decisions (updated 2026-06-08) — each is independent and any can stay
"no" indefinitely:

- [x] **Pick a JS registry** — **Decided 2026-06-08:** source-only
      (Option 1) now, **JSR (Option 2) at 1.0** (see the distribution-review
      note above). Options kept for reference:
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
- [x] **PyPI publish for `aipehub`** — **Decided 2026-06-08:** defer to
      1.0, publish **alongside JSR** (`pyproject.toml` is already
      PyPI-ready). Currently `pip install -e python-sdk/` is the only path.
      Referenced in [`python-sdk/README.md`](../python-sdk/README.md)
      and [`docs/AGENT.md`](../docs/AGENT.md). If you publish to a JS
      registry, doing PyPI alongside keeps consistency.
- [ ] **Pre-built single-file binaries** for macOS (arm64 + x64) and
      Windows x64. Non-blocking — Docker covers cross-platform
      "click and run" today. **Build infrastructure is already in
      place** — only an actual release tag + (optional) code-signing
      remain:
  - ✅ Implemented: [`workflows/release.yml`](workflows/release.yml)
    cuts binaries for all 5 targets via `bun build … --compile` on a
    GitHub Actions matrix (`packages/host/bin/aipehub-host.js`), then
    attaches `SHA256SUMS` + SLSA provenance + a CycloneDX SBOM.
  - ✅ Blocker resolved: static assets are inlined at build time by
    `packages/web/scripts/build-static-assets.mjs`, and the host
    detects binary mode via `isCompiledBinary()` — no companion
    `static/` directory ships. The old "≈100 lines of build-step
    work" note is obsolete.
  - Remaining: ① cut the first GitHub Release tag to trigger the
    workflow (gated on the GitHub-upload freeze); ② optional macOS +
    Windows code-signing (paid certs — see the "Deferred" footer in
    `release.yml`).
  - ⚠️ **Capability caveat (proven 2026-06-25).** The `bun --compile`
    single-file binaries boot the web server but **drop the identity
    layer**: `better-sqlite3` (the one native addon) can't be `dlopen`'d
    from the embedded `/$bunfs/` FS, so only the memory/artifact plugins
    seed (`BINARY_SAFE_PLUGINS`), not `datastore-sqlite`. For a
    **full-capability** zero-Node/Docker artifact there is now
    [`scripts/build-portable.mjs`](../scripts/build-portable.mjs) — an
    embedded-runtime portable bundle (pinned Node + `pnpm deploy --prod`
    host + real on-disk `node_modules`, double-click via the tier-0
    branch in [`deploy/AipeHub.command`](../deploy/AipeHub.command)).
    Real Node → `isCompiledBinary()` false → host runs the full
    identity-backed path. Built on demand, **not committed** (`dist-portable/`
    is gitignored); macOS arm64 this round. Write-up:
    [`docs/zh/PORTABLE-BUNDLE.md`](../docs/zh/PORTABLE-BUNDLE.md).

## Documentation polish

- [ ] **Replace `hub.example.com` example URLs** in docs with whatever
      domain hosts the project's own public-preview / demo deployment.
- [x] **Translate** the `docs/zh/` queue — **Done (REL-5, 2026-06).**
      AGENT + DEPLOY + **FEDERATION** + **LICENSE-FAQ** all shipped
      bilingual (`docs/FEDERATION.md` 184 / `docs/zh/FEDERATION.md` 176;
      `docs/LICENSE-FAQ.md` 182 / `docs/zh/LICENSE-FAQ.md` 161). The
      `docs/zh/README.md` "翻译状态" table is updated to ✅. ARCHITECTURE /
      PROTOCOL stay intentionally low-priority (English-source reference).
- [x] **Bilingual UI (中英双语)** — **Done (REL-6→REL-9, 2026-06).** Full
      `/me` + admin SPA i18n retrofit (1290-key `I18N.zh`/`I18N.en` at
      parity), client-authoritative language detection (`lang` cookie >
      `navigator.language` > server `defaultLang` > `zh`), cross-surface
      cookie persistence (invite / offline / worker pages read the same
      cookie). See [`docs/zh/I18N-PLAN.md`](../docs/zh/I18N-PLAN.md).
- [ ] **Refresh `Adapted:` dates** in `templates/community/agents/*.yaml`
      headers if the prompts get a re-pass before launch.

## Repo hygiene

- [x] Add `.github/ISSUE_TEMPLATE/` (bug / feature / docs) and
      `.github/PULL_REQUEST_TEMPLATE.md`. Done — four issue forms
      (`bug_report.yml`, `feature_request.yml`, `documentation.yml`,
      `config.yml`) plus the PR template.
- [ ] Enable GitHub Discussions (a repo **Settings → Features** toggle — the
      one human action left; CI can't flip it). Scaffolding is already in the
      repo and auto-activates the moment it's on: three discussion forms
      (`.github/DISCUSSION_TEMPLATE/q-a.yml`, `ideas.yml`, `show-and-tell.yml`)
      attach to GitHub's default Q&A / Ideas / Show-and-tell categories, the
      issue-config "💬 Question or discussion" link stops 404'ing, and a
      ready-to-paste welcome post + enable steps live in
      [`docs/zh/COMMUNITY-DISCUSSIONS.md`](../docs/zh/COMMUNITY-DISCUSSIONS.md).
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
- [ ] **(Optional) Add live-LLM CI gate secrets** — if you want the
      nightly real-LLM smoke ([`workflows/live.yml`](workflows/live.yml),
      Route B P1-M13c) to actually run rather than skip-clean, add
      `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENAI_BASE_URL` to repo
      secrets (Settings → Secrets and variables → Actions). Without them
      the gate skips cleanly and never reports a false red — so this is
      strictly optional and never blocks a release.

## Going public + cutting 1.0 — the final gate

> **This is the one decision the maintainer must make in person.** Nothing
> below is automatable: an agent does not flip a repo to public, does not
> create a `v1.0.0` tag, and does not push to a public remote. Those are
> the maintainer's explicit, in-session go/no-go.

**State as of the last review (2026-06-14):**

- Push freeze: **lifted for the PRIVATE remote only** (`origin =
  github.com/Emir-Aksoy/AipeHub`, private). Going public is still frozen.
- REL-1 → REL-9 are **done** (freeze lift + ops debt + doc translation +
  full bilingual UI). REL-10 (this file) is the closeout.
- All remaining unchecked boxes above are **maintainer-only external
  actions** (register `aipehub.dev`, enable GitHub Private Vulnerability
  Reporting, enable GitHub Discussions, optional binaries/registry/CI
  secrets, optional demo-domain URL swap, CVE authority, tabletop). None
  block correctness; they gate the *public* posture.

**Pre-flight before flipping public (each is yours to do):**

1. Decide which "Operational / Repo hygiene / Domain" boxes are
   *go-live blockers* vs *post-1.0 follow-ups* (most are non-blocking).
2. Enable **Private Vulnerability Reporting** so the advertised
   `/security/advisories/new` channel resolves (currently the sole
   disclosure path).
3. (Optional) register `aipehub.dev` + swap demo URLs if you want the
   docs' `hub.example.com` placeholders to point at a real preview.
4. Flip the repo to **public** (GitHub Settings → General → Danger zone).
5. Cut the **`v1.0.0`** tag — this triggers
   [`workflows/release.yml`](workflows/release.yml) (binaries + SBOM +
   provenance). Then (optionally) JSR / PyPI per the Distribution section.

**Confirmation required:** the agent will not perform steps 4–5 (or push
to any public remote) without an explicit "go public + tag 1.0" from the
maintainer in-session.

---

Once every box is checked, delete this file. Its absence == "we shipped
the placeholder cleanup".

Last reviewed: 2026-06-14 (REL-10 closeout — consolidated REL-5→REL-9
completions; remaining items are maintainer-only external actions).
