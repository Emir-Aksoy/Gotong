# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in AipeHub, please **do
not** open a public GitHub issue.

Email **security@aipehub.example** (placeholder — replace with the real
maintainer address before your first public release) with:

- a description of the issue
- steps to reproduce
- the commit hash you tested against
- (optional) a proposed fix

We will acknowledge receipt within 72 hours and aim to have a fix or a
plan within 7 days for high-severity issues.

If you need to encrypt: a PGP key for the security address is published
at <https://aipehub.example/security.asc> (placeholder).

## Supported versions

AipeHub is pre-1.0 internally (v2.0 in the SemVer marketing label refers
to the file-first rewrite). We patch security issues on the current
`main` branch only; there is no LTS branch yet. Pin to a commit you've
audited if you need long-term stability.

## Threat model

AipeHub is designed for **small, trusted, single-tenant** deployments —
a research lab, a project team, a small体验版 group of users. In
particular it is **not** hardened against:

- Untrusted insider admins (an admin can do anything an admin can do)
- DDoS at the application layer (rate limiting is per-IP in-memory and
  resets on restart)
- Resource exhaustion via huge task payloads (no quotas yet)
- Side-channel timing attacks on workers / agents (token comparison is
  constant-time; everything else isn't audited)

If your use case crosses those lines, talk to us first.

## In-place mitigations

- **Token storage**: admin / worker tokens are hashed (SHA-256) before
  being written to disk; plaintext is returned exactly once on mint.
- **Cookie storage**: HttpOnly, SameSite=Strict (HTTPS) / Lax (HTTP),
  Secure flag when `AIPE_COOKIE_SECURE=1`.
- **CSRF**: `AIPE_ALLOWED_HOSTS` enforces Host + Origin checks on all
  state-changing methods. Set this on every production deployment.
- **Rate limiting**: `AIPE_ADMIN_RATE_MAX` / `_SEC` caps token
  verification attempts per IP per window. Defaults to 10 / 60s.
- **Security headers**: X-Frame-Options, Content-Security-Policy,
  Referrer-Policy, X-Content-Type-Options on every response.
- **Admission gating**: `AIPE_GATING=admin-approval` (default) requires
  every remote agent to be human-approved before joining.

## Disclosure timeline

We follow standard coordinated disclosure:

1. Reporter sends details privately.
2. Maintainers confirm and develop a fix.
3. Fix lands on `main` plus a backport branch if needed.
4. Public disclosure 7–14 days after the fix, with credit to the
   reporter (unless they ask to stay anonymous).

Thanks for keeping the project honest.
