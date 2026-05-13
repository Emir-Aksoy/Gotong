# Public-release checklist

Things that are **placeholders today** and must be replaced / activated
before the first public 1.0 release (or before publishing to npm).

Each item links to where it appears in the repo so a `grep` against the
list keeps the checklist honest.

## Security contact

- [ ] **Activate `security@aipehub.dev` mailbox** — DNS MX, autoresponder
      pointing reporters to the GitHub advisory URL, on-call routing.
      Appears in:
  - [`SECURITY.md`](../SECURITY.md) → "Backup — email"
  - [`.well-known/security.txt`](../.well-known/security.txt) → `Contact: mailto:` line
- [ ] **Enable Private Vulnerability Reporting** on
      `github.com/AipeHub/AipeHub` (Settings → Security & analysis).
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

## npm / PyPI publish

- [ ] **Publish `@aipehub/host` to npm public registry** so
      `npx @aipehub/host` (advertised in `README.md` Quick start) starts
      working. Until then the Quick-start carries a "queued for v2.1"
      caveat.
- [ ] Same for the other `@aipehub/*` packages — currently only
      buildable from source.
- [ ] **Publish `aipehub` to PyPI** — referenced in
      [`python-sdk/README.md`](../python-sdk/README.md) and
      [`docs/AGENT.md`](../docs/AGENT.md).

## Documentation polish

- [ ] **Replace `hub.example.com` example URLs** in docs with whatever
      domain hosts the project's own public-preview / demo deployment.
- [ ] **Translate** the remaining `docs/zh/` queue —
      see [`docs/zh/README.md`](../docs/zh/README.md) "翻译状态" table.
      Priority: AGENT → DEPLOY → FEDERATION → LICENSE-FAQ.
- [ ] **Refresh `Adapted:` dates** in `templates/community/agents/*.yaml`
      headers if the prompts get a re-pass before launch.

## Repo hygiene

- [ ] Add `.github/ISSUE_TEMPLATE/` (bug / feature / docs) and
      `.github/PULL_REQUEST_TEMPLATE.md`.
- [ ] Enable GitHub Discussions; seed categories: Q&A, Show & Tell, Ideas.
- [ ] Add `.github/dependabot.yml` for npm + pnpm + GitHub Actions
      updates.
- [x] Decide on a CI provider — GitHub Actions, live in
      `.github/workflows/ci.yml`. Two jobs: Node 20/22 (`pnpm -r build
      typecheck test`) + Python 3.10/3.11/3.12 (`pytest python-sdk`).
      Concurrency cancels in-flight PR runs but lets post-merge `main`
      runs finish. Template parse check is covered by `pnpm -r test`.

## Operational

- [ ] Pick a CVE numbering authority arrangement — GitHub Security
      Advisories can request CVEs on your behalf; confirm the workflow.
- [ ] Decide a "supported versions" policy concrete enough to put in
      `SECURITY.md` (currently "current `main` branch only").
- [ ] Run one tabletop exercise of "high-severity report comes in at
      Friday 19:00" to validate the 72-hour ack target.

---

Once every box is checked, delete this file. Its absence == "we shipped
the placeholder cleanup".

Last reviewed: 2026-05-12.
