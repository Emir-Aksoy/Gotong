/**
 * Audit L3-1 — `applyMigrations` must re-check the migrations registry INSIDE
 * the write transaction, not merely trust the snapshot it read before the loop.
 *
 * The failure it guards against: two hosts share one identity db and boot at
 * the same time. Both read `schema_migrations`, both see version N missing, so
 * both queue to apply it. `BEGIN IMMEDIATE` serializes the two writers — the
 * winner applies the (non-idempotent) ALTER and records the row — but
 * serializing alone doesn't save the loser, whose in-memory snapshot still says
 * "N is missing." Without a re-check under the held lock the loser re-runs the
 * ALTER and crashes boot with a duplicate-column error.
 *
 * better-sqlite3 is synchronous, so a genuine in-process interleave is
 * impossible to stage. Instead we reproduce the loser's EXACT runtime condition
 * deterministically: a fully-migrated real db wrapped in a Proxy that forces
 * just the outer snapshot query to return `[]` (the stale read), while the
 * inner per-version re-check and every write pass straight through to the real,
 * already-migrated db.
 *   - OLD code (no re-check): trusts the empty snapshot → re-INSERTs version 1
 *     into schema_migrations → UNIQUE/PK violation → throws.
 *   - NEW code (re-check under lock): finds each version already recorded →
 *     skips them all → { applied: [] }, no throw.
 */
import { describe, expect, it } from 'vitest'

import { openDb, type SqliteDb, type SqliteStmt } from '../src/db.js'
import { applyMigrations } from '../src/schema.js'

// The one query applyMigrations uses to learn what's already applied. Stubbing
// ONLY this (not the per-version `SELECT 1 ... WHERE version = ?` re-check) is
// what makes the snapshot stale while the lock-held re-check stays truthful.
const SNAPSHOT_SQL = 'SELECT version FROM schema_migrations'

/**
 * Wrap a real, fully-migrated db so the snapshot query returns an empty set —
 * exactly what a second host sees when it read the registry before the first
 * host's INSERT landed. Everything else (the re-check, BEGIN IMMEDIATE, exec,
 * INSERT) hits the real db unchanged.
 */
function withStaleSnapshot(real: SqliteDb): SqliteDb {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string): SqliteStmt => {
          const stmt = target.prepare(sql)
          if (sql !== SNAPSHOT_SQL) return stmt
          return new Proxy(stmt, {
            get(s, p) {
              if (p === 'all') return (): unknown[] => [] // the stale read
              const fn = Reflect.get(s, p)
              return typeof fn === 'function' ? fn.bind(s) : fn
            },
          })
        }
      }
      // Reflect.get without a receiver defaults `this` to the real db, so
      // native getters (open/inTransaction) and methods (exec) stay bound to it.
      const v = Reflect.get(target, prop)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

describe('applyMigrations — re-checks under the write lock (audit L3-1)', () => {
  it('a stale "nothing applied" snapshot does NOT re-run migrations', () => {
    const real = openDb(':memory:')
    try {
      // Winner host: fully migrate the shared db.
      const first = applyMigrations(real)
      expect(first.applied.length).toBeGreaterThan(0)

      // Loser host: same store, but its registry read comes back empty. The
      // re-check-under-lock must notice every version is in fact already
      // recorded and skip them all — instead of re-applying and crashing.
      const staleDb = withStaleSnapshot(real)
      let result: { applied: number[] } | undefined
      expect(() => {
        result = applyMigrations(staleDb)
      }).not.toThrow()
      expect(result).toEqual({ applied: [] })
    } finally {
      real.close()
    }
  })
})
