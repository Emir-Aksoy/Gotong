# Security policy

## How to report a vulnerability

**Please do not open a public GitHub issue, discussion, or PR for security
issues.** Use a private channel:

### Preferred — GitHub private vulnerability reporting

Open a private advisory at:

> **<https://github.com/Emir-Aksoy/AipeHub/security/advisories/new>**

GitHub's built-in form gives you:

- end-to-end private thread with the maintainers (no email leakage)
- attachments + reproduction steps in one place
- a tracked timeline from report → fix → public CVE assignment

This is the channel we read first and answer fastest. You'll need a
free GitHub account; that's the only prerequisite.

### No email channel (pre-1.0)

There is deliberately **no security email** during the v0.x period.
`security@aipehub.dev` appears in older revisions of this repo as an
*aspirational* address — the domain isn't registered and the mailbox
isn't activated, so mail to it goes nowhere. We've stopped advertising
it as a fallback rather than dangle a dead contact someone might trust
with a real report.

GitHub Private Vulnerability Reporting (above) is the **sole** channel
today: free, private, and the one we read first. Whether a real mailbox
is worth standing up is a [release-checklist](.github/RELEASE-CHECKLIST.md#security-contact)
decision deferred to the 1.0 run-up; until then, please use the advisory
form.

If you genuinely cannot use GitHub, open a **non-security** GitHub
Discussion asking a maintainer to reach out — without any vulnerability
detail — and we'll arrange a private channel for that one report.

Include in your advisory:

- a description of the issue
- precise reproduction steps
- the commit hash you tested against (`git rev-parse HEAD`)
- (optional) a proposed fix or patch
- (optional) the name / handle you want credited in the advisory

### What about PGP?

We do **not** publish a PGP key today. Reasons:

- GitHub's private-advisory channel is already TLS-encrypted end-to-end
  between you and the maintainer notification, so PGP adds little.
- Maintaining a PGP key for an early project is more failure modes
  (lost keys, expired keys, signing ceremonies) than benefit.

If your organization's policy requires PGP-encrypted disclosure, please
contact us via the GitHub channel first and we will arrange an
out-of-band PGP exchange for that single report.

---

## Response timeline

| Phase | Target |
|---|---|
| Acknowledge receipt | within **72 hours** of report |
| First triage + severity assessment | within **7 days** |
| Fix or mitigation in `main` | high-severity: **7 days**, medium: **30 days**, low: best effort |
| Public disclosure | **7–14 days** after the fix lands (or by mutual agreement) |

You'll get an update at every transition. If you don't hear from us
within the 72-hour acknowledgment window, that itself is a bug —
please escalate via a GitHub Discussion (general, not security
content), tagging a maintainer.

---

## Supported versions

AipeHub is pre-1.0 internally (the v2.0 / v2.1 labels you see in
`CHANGELOG.md` refer to the file-first rewrite generation, not the
SemVer 1.0 threshold). We patch security issues on the current `main`
branch only. There is **no LTS branch**.

If you need long-term stability, pin to a commit you've audited and
budget for in-place patches; we can't backport indefinitely.

---

## Threat model

AipeHub is designed for **small, trusted, single-tenant** deployments —
a research lab, a project team, a small public-preview group. The
defaults assume the room is operated by people who trust each other.

In-scope (we accept reports about):

- ✅ Unauthenticated access to admin endpoints
- ✅ Token / cookie disclosure (across users, across rooms, across processes)
- ✅ Encryption / decryption bugs in `secrets.enc.json` and the master-key file
- ✅ Authorization bypass — e.g. a worker reaching admin-only routes
- ✅ CSRF / clickjacking / XSS in the bundled admin UI
- ✅ Resource exhaustion that requires *no* authentication (anonymous DOS)
- ✅ Wire-protocol parsing bugs that crash the host or corrupt the transcript
- ✅ Privilege escalation in the `TeamBridgeAgent` (e.g. local team gaining unintended visibility into upstream)
- ✅ Confused-deputy issues in the LocalAgentPool / managed-agent spawn path

Out of scope (low priority — patches welcome, but not handled as security):

- ❌ **Untrusted admins.** Once an account holds admin role, it can do
  anything the admin role exposes. If you need internal admin firewalling,
  open a feature request.
- ❌ **Application-layer DDoS** by an *authenticated* user. Rate limiting
  is per-IP and resets on restart; not a defence against deliberate
  internal abuse.
- ❌ **Huge task payloads** causing memory pressure. No quotas yet.
- ❌ **Side-channel timing attacks** outside token comparison (token
  comparison itself is constant-time).
- ❌ Issues that require physical / shell access to the host machine.
- ❌ Findings against the `templates/community/` upstream sources — those
  are third-party prompt repositories under their own licenses and
  governance; report to them directly.

If your finding sits on the boundary, send it via the GitHub advisory
channel and we'll triage.

---

## In-place mitigations (so you know what defenses already exist)

When evaluating an issue, check whether one of these already covers it:

- **Token storage**: admin / worker tokens are hashed with SHA-256
  before being written to disk. Plaintext is shown exactly once on mint.
  Verification uses constant-time comparison.
- **Cookie storage**: HttpOnly always; `SameSite=Strict` + `Secure` when
  `AIPE_COOKIE_SECURE=1` (required behind HTTPS).
- **CSRF**: `AIPE_ALLOWED_HOSTS` enforces both `Host:` and `Origin:`
  checks on every state-changing method. **Set it on every production
  deployment.** Unset means "loopback only is safe".
- **Rate limiting**: `AIPE_ADMIN_RATE_MAX` / `_SEC` caps admin-token
  verification attempts per IP per sliding window. Defaults 10 / 60s.
- **Security headers**: `X-Frame-Options: DENY`, a strict CSP,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`
  on every response.
- **Admission gating**: `AIPE_GATING=admin-approval` (default) requires
  every remote agent to be human-approved before joining. `gating=open`
  is **dev only** and is rejected in production with a startup warning.
- **API-key encryption**: workspace and per-agent API keys live in
  `<space>/secrets.enc.json`, AES-256-GCM, master key in
  `<space>/runtime/secret.key` (0600) or `AIPE_SECRET_KEY` env. The
  encrypted file alone is not enough to recover keys.
- **Per-agent identity binding (v0.4)**: `authenticate()` can return
  `{ ok: true, allowedAgents: [...] }` so a leaked API key can't
  impersonate an arbitrary agent id — only the ones it's bound to.
- **Transcript is append-only**: there is no API to delete or rewrite
  transcript entries from the runtime. Tampering requires filesystem
  access (which is out of scope; see "out of scope" above).

---

## Coordinated disclosure

We follow standard coordinated disclosure:

1. You send details privately (GitHub advisory channel preferred).
2. Maintainers confirm, scope, develop and test a fix.
3. The fix lands on `main` (and a backport branch if any LTS commitment
   has been made).
4. Public disclosure 7–14 days later, with:
   - a CVE id (we'll request one if appropriate)
   - credit to you in the advisory, unless you ask to stay anonymous
   - a summary of impact + mitigation in `CHANGELOG.md`

If you disclose publicly before we've shipped a fix, we will still ship
the fix, but the advisory's credit field will note "uncoordinated".

---

## Security checklist for operators

If you're **running** a hub, not reporting bugs against it, the
deployment-side hardening checklist lives in
[`docs/DEPLOY.md` § "Production checklist"](docs/DEPLOY.md#production-checklist).

In short:

- [ ] `AIPE_COOKIE_SECURE=1` when fronted by HTTPS
- [ ] `AIPE_ALLOWED_HOSTS` set to your real hostnames
- [ ] `AIPE_GATING=admin-approval` (never `open` on the public internet)
- [ ] Caddy / nginx terminates TLS; backend bound to `127.0.0.1`
- [ ] `runtime/secret.key` (chmod 600) or `AIPE_SECRET_KEY` env is set
- [ ] Backups exist for the `<space>/` directory
- [ ] At least 2 admin accounts so you can recover a lockout
- [ ] `/healthz` monitored

---

Thanks for keeping the project honest. Most reporters never see what's
on the other side of a private advisory — but every one we get makes
the next deployment a little safer.
