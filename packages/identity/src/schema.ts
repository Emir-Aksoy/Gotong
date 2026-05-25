/**
 * Schema migration registry.
 *
 * Add new versions by APPENDING to `MIGRATIONS`. Never edit a published
 * version's SQL — once a host has migrated past v=N, the only safe
 * forward path is appending v=N+1.
 *
 * `applyMigrations(db)` runs every missing migration inside a
 * transaction and records the version in `schema_migrations`. Safe to
 * call on every host startup; the function short-circuits when
 * everything is already applied.
 */

import { transaction, type SqliteDb } from './db.js'

interface Migration {
  version: number
  name: string
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-users-credentials-memberships-sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        identifier TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        UNIQUE(kind, identifier)
      );
      CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id);

      CREATE TABLE IF NOT EXISTS memberships (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON auth_sessions(expires_at);
    `,
  },
  {
    // V4-AUDIT-06: identity audit log table.
    //
    // Every owner-gated mutation (login success/failure, logout, role
    // change, password set, api-key issue, credential revoke, user
    // create) writes one row here. The web layer is the canonical
    // call-site because that's where the actor's IP / user-agent /
    // auth source are known — the store layer cannot infer those.
    //
    // Schema:
    //   - `actor_user_id` is nullable because `login_failure` records the
    //     attempt before any user has been resolved (the failure metadata
    //     holds the attempted email).
    //   - `actor_source` is the auth surface that produced the actor.
    //     Current vocabulary: 'v4-session' | 'v4-bearer' | 'anonymous' |
    //     'system' | 'federated'. Pre-A2.2 rows may carry the now-removed
    //     'v3-admin' value; `rowToAuditLog` clamps unknown values to
    //     'system' on read.
    //   - `target_user_id` / `target_credential_id` reference the object
    //     of the action (also nullable — `login_failure` has neither).
    //     NO foreign keys — we want the audit row to survive even after
    //     the referenced user / credential is deleted (the whole point
    //     of an audit log).
    //   - `metadata` is a JSON blob for per-action extras (attempted
    //     email on login failure, role transition pairs, label of
    //     newly-issued credentials). Caller passes a plain object; the
    //     store JSON.stringifies it.
    //   - `success` is 1 / 0 — most actions only write on success but
    //     login records both, so we use the explicit column rather than
    //     a 'login_failure' action string alone, to make filtering
    //     "show me all failures" trivial.
    //
    // Indexes:
    //   - idx_audit_ts: the list query is "give me the most recent N",
    //     so a descending index on ts is the hot path.
    //   - idx_audit_target_user: future per-user-history view ("show
    //     everything that's been done TO this user").
    //   - idx_audit_action: filter-by-action queries (e.g. "show me all
    //     credential revocations").
    version: 2,
    name: 'identity-audit-log',
    sql: `
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        actor_user_id TEXT,
        actor_source TEXT NOT NULL,
        action TEXT NOT NULL,
        target_user_id TEXT,
        target_credential_id TEXT,
        ip TEXT,
        user_agent TEXT,
        metadata TEXT,
        success INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_target_user ON audit_log(target_user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    `,
  },
  {
    // Invitations table (Phase 3 — user invitation flow).
    //
    // Each row is a one-time invite that an owner mints for a
    // prospective user. The raw token is shown to the owner ONCE at
    // creation (out-of-band delivery: Signal, 1Password, etc) — only
    // sha256(token) is persisted, mirroring the api_key / admin_token
    // pattern in `credentials.identifier`.
    //
    // Schema notes:
    //   - `token_hash` is UNIQUE — collisions on 192-bit randoms are
    //     mathematically impossible at any scale, but the constraint is
    //     defence-in-depth.
    //   - `email` is the email the invite will assign at accept time.
    //     COLLATE NOCASE so a re-invite of the same address (different
    //     case) collides on the index lookup.
    //   - `role` is the role the new user is assigned at accept time.
    //   - `invited_by` is the inviting v4 user id, nullable for system-
    //     initiated invites (no human actor). NO FK — keeping the audit
    //     trail intact if the inviter is later deleted.
    //   - `status` transitions: pending → accepted | revoked. Expiry
    //     is computed on read (`expires_at < now`) so a row never sits
    //     in an "expired" state requiring a sweeper to flip it.
    //   - `accepted_user_id` ties the invite to the freshly-created
    //     user row. Informational only; no FK so user deletion doesn't
    //     cascade out the invite history.
    //
    // Indexes:
    //   - idx_invitations_email_pending: lets `createInvitation` cheaply
    //     refuse "you already have a pending invite for this email".
    //   - idx_invitations_status: list-pending is the admin UI's hot
    //     query.
    version: 3,
    name: 'invitations',
    sql: `
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL COLLATE NOCASE,
        role TEXT NOT NULL,
        invited_by TEXT,
        display_name TEXT,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        accepted_at INTEGER,
        accepted_user_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_invitations_email_pending
        ON invitations(email) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_invitations_status
        ON invitations(status);
    `,
  },
  {
    // A1 (v4 Phase 5) — vault table for two-way (encrypted, recoverable)
    // secrets. Distinct from `credentials`, which holds one-way HASHED
    // auth material for user login. Different threat models, different
    // primitives.
    //
    // What lives here:
    //   - LLM provider keys (Anthropic / OpenAI / DeepSeek) — must be
    //     readable to call the upstream API.
    //   - MCP server tokens (github / brave-search / private MCP) — same.
    //   - Peer-hub mutual-auth tokens — read at HubLink connection time.
    //   - Generic third-party API tokens.
    //
    // Schema notes:
    //   - `owner_kind` is 'user' | 'org' | 'peer' (mirrors the unified
    //     OwnerRef model that A3 will roll out across memory/artifact).
    //   - `owner_id` is NULL when owner_kind == 'org' (the host itself
    //     is the implicit org). For 'user' / 'peer' it holds the
    //     respective foreign id. NO FK because owner_kind switches the
    //     referenced table (users / peer_registry-not-yet-built /
    //     conceptual self-org). Integrity is application-layer at
    //     create time.
    //   - `secret_enc` holds the AES-256-GCM blob in format
    //     `v1.gcm$<nonce>$<ct>$<tag>` (see crypto.ts). Plaintext is
    //     never persisted, never logged.
    //   - `revoked_at` is a timestamp, NULL when active. Soft-delete:
    //     rows survive forever for audit forensics; the active-rows hot
    //     path filters `WHERE revoked_at IS NULL`.
    //   - `metadata` is a JSON blob for provider-specific context
    //     (e.g. {provider: 'anthropic', model: 'claude-opus-4'}).
    //     Optional; clamped to 8KB at write time (same as audit_log).
    //
    // Indexes:
    //   - idx_vault_kind: filter "show me all llm_provider entries".
    //   - idx_vault_owner: lookup by (owner_kind, owner_id) tuple.
    //   - idx_vault_active: hot-path partial index for "currently active".
    version: 4,
    name: 'vault',
    sql: `
      CREATE TABLE IF NOT EXISTS vault (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        owner_kind TEXT NOT NULL,
        owner_id TEXT,
        label TEXT,
        secret_enc TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_vault_kind ON vault(kind);
      CREATE INDEX IF NOT EXISTS idx_vault_owner ON vault(owner_kind, owner_id);
      CREATE INDEX IF NOT EXISTS idx_vault_active
        ON vault(revoked_at) WHERE revoked_at IS NULL;
    `,
  },
  {
    // B2.1 (v4 Phase 5) — per-user usage counters for quota enforcement.
    //
    // One row per (user_id, metric, period). Holds the CURRENT period's
    // cumulative `used` plus the configured `quota` cap. When the
    // period boundary passes, the next checkAndIncrement resets
    // `used=0` and advances `period_start`. Older period values are
    // not retained here — audit_log carries the event-level trail.
    //
    // Why composite PK (no surrogate id): every read / write is by
    // exactly the (user_id, metric, period) tuple. A surrogate id
    // would force a secondary unique index + JOIN — net loss for a
    // hot-path table.
    //
    // `quota` is nullable: NULL means "unlimited" (counter still ticks
    // for visibility). `used` defaults to 0 so a fresh INSERT reads
    // correctly without a coalesce.
    //
    // `metric` is free-form TEXT (≤64 chars at write time) so future
    // subsystems can add new counters without a migration. `period`
    // is constrained to the UsagePeriod enum at the application
    // layer — no SQL CHECK so we can extend it without a migration
    // either.
    //
    // FK ON DELETE CASCADE: a deleted user's quota rows vanish too —
    // keeps the table tied to its principal lifecycle.
    version: 5,
    name: 'usage-counters',
    sql: `
      CREATE TABLE IF NOT EXISTS usage_counters (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        metric TEXT NOT NULL,
        period TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        quota INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, metric, period)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_counters(user_id);
    `,
  },
]

export function applyMigrations(db: SqliteDb): { applied: number[] } {
  // Bootstrap the migrations table itself. This is the chicken-and-egg
  // moment — we can't read it to know what's applied if it doesn't
  // exist. Idempotent CREATE IF NOT EXISTS does the right thing.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
  const appliedVersions = new Set<number>(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  )
  const newlyApplied: number[] = []
  for (const m of MIGRATIONS) {
    if (appliedVersions.has(m.version)) continue
    transaction(db, () => {
      db.exec(m.sql)
      db.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)',
      ).run(m.version, m.name, Date.now())
    })
    newlyApplied.push(m.version)
  }
  return { applied: newlyApplied }
}

export function latestSchemaVersion(): number {
  let max = 0
  for (const m of MIGRATIONS) {
    if (m.version > max) max = m.version
  }
  return max
}
