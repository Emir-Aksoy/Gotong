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
    //   - `actor_user_id` is nullable because (a) v3-admin Bearer/cookie
    //     hits the identity routes WITHOUT a v4 user binding, and
    //     (b) `login_failure` records the attempt before any user has
    //     been resolved (the failure metadata holds the attempted email).
    //   - `actor_source` is the auth surface that produced the actor
    //     ('v3-admin' | 'v4-session' | 'v4-bearer' | 'anonymous' | 'system').
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
