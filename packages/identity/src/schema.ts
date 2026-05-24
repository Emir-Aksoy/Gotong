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
