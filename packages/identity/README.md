# @aipehub/identity

AipeHub **v4** identity layer — users, credentials, memberships, sessions.
SQLite-backed, zero-dep on other workspace packages so it can be wired into
`@aipehub/host` / `@aipehub/web` (and later `@aipehub/cli`) without pulling
the rest of the runtime into a circular dependency.

## Why this exists

v3 has a single admin model: one host = one `admin-token` minted at first
launch. Good enough for solo developer use, **not enough** for organisations
where multiple humans need different views into the same hub.

v4 introduces an identity layer that:

- distinguishes **users** (humans with email + display name)
- gives each user a **role** in the host's organisation
  (`owner` / `admin` / `member` / `viewer`)
- supports three credential kinds in one consistent API:
  - `password` — scrypt-hashed (node built-in `crypto`, zero deps)
  - `admin_token` — opaque token that grants owner-level access, sha256
    hashed at rest (the v3 first-launch admin URL token lives here after
    migration)
  - `api_key` — opaque token for programmatic clients, sha256 hashed
- issues **sessions** with explicit expiry, last-seen tracking, and
  per-token revocation

## Design choices (and what they aren't)

This package is **deliberately small**. It is:

- **Single-tenant per process.** One host = one organisation. Cross-org
  collaboration goes through `HubLink` federation, not a multi-tenant
  schema. (See `docs/zh/ledger/V4-ARCH.md` for the full rationale.)
- **A pure library.** No HTTP, no cookies, no middleware. The web layer
  wraps it. This keeps it testable as pure functions over a SQLite file.
- **Zero workspace deps.** Imports only `better-sqlite3` (peer) + node
  built-ins. The host depends on us; we depend on nothing.

What it is **not**:

- Not an OAuth server. SSO / OIDC providers come in a later phase as
  separate `@aipehub/identity-oauth-*` packages plugging in via the
  `credentials` table's `kind` column.
- Not a permission engine. We model **role assignment**; the host /
  web layer maps roles to feature gates. (Why: permission semantics
  belong to the surface that enforces them.)
- Not a multi-org tenant store. Federation is the answer.

## Quick start

```ts
import { openIdentityStore } from '@aipehub/identity'

// One file per host, lives alongside the existing .aipehub/ workspace.
const store = openIdentityStore({ dbPath: '.aipehub/identity.sqlite' })

// First-run bootstrap: takes the v3 admin token (if there is one) and
// turns it into a real user with role 'owner'. Idempotent — running it
// twice with the same token does nothing on the second call.
store.bootstrap({ adminToken: process.env.AIPE_LEGACY_ADMIN_TOKEN })

// Create a new user with a password.
const alice = store.createUser({
  email: 'alice@acme.local',
  displayName: 'Alice',
  password: 'correct horse battery staple',
  role: 'member',
})

// Authenticate.
const session = store.authenticatePassword({
  email: 'alice@acme.local',
  password: 'correct horse battery staple',
})
// → { token: '...', user: {...}, role: 'member', expiresAt: ... }

// Issue an API key for a programmatic client.
const { key, credentialId } = store.issueApiKey({
  userId: alice.id,
  label: 'CI runner',
})
// `key` is shown ONCE; only its sha256 is stored.

// Validate a request later.
const got = store.getSessionByToken(session.token)
// → { user, role, expiresAt } | null
```

## Schema

Four tables + one meta table for migrations:

```
users           id PK, email UNIQUE, display_name, created_at, last_login_at
credentials     id PK, user_id FK, kind, identifier, secret_hash, label,
                created_at, last_used_at  (UNIQUE on (kind, identifier))
memberships     id PK, user_id FK UNIQUE, role, created_at
                  (one role per user in the single-org-per-host model)
auth_sessions   token PK, user_id FK, expires_at, created_at, last_seen_at
schema_migrations  version PK, name, applied_at
```

When v4 grows beyond one-org-per-host, `memberships` is the table that
gains an `org_id` column. The other three are org-neutral by design.

## Layout

```
packages/identity/
├── src/
│   ├── index.ts        # public re-exports
│   ├── types.ts        # User / Role / Session / CredentialKind
│   ├── errors.ts       # IdentityError taxonomy
│   ├── schema.ts       # CREATE TABLE DDL + migrations registry
│   ├── db.ts           # better-sqlite3 wrapper, mirrors service-datastore-sqlite
│   ├── credentials.ts  # scrypt + sha256 hashing primitives
│   ├── tokens.ts       # random opaque token mint
│   └── store.ts        # IdentityStore class — single public entry point
└── tests/
    ├── store.test.ts
    ├── credentials.test.ts
    └── bootstrap.test.ts
```

## Concurrency

Same constraints as `@aipehub/service-datastore-sqlite`: one host
process per workspace, WAL mode on, FK enforced. Multiple processes
pointing at the same `identity.sqlite` is unsupported.

## Versioning

`0.1.0` — alpha. API surface may shift through v4-P1 → v4-P2. Promoted
to `1.0.0` once the host + web integration ships in Phase 2.
