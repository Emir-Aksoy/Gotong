/**
 * Migrations are forward-only, which makes DOWNGRADE the dangerous direction:
 * roll the binary back after an upgrade and the old host finds every migration
 * it knows about already applied, short-circuits, and boots — clean logs, no
 * crash, old code now reading and writing a schema it was never compiled
 * against. That is silent data damage, and it is exactly what an operator does
 * when an upgrade looks bad and they reach for the previous release.
 *
 * So `applyMigrations` refuses a store that records versions this build has no
 * migration for. These tests pin both halves of that contract: it fires when
 * the store is genuinely ahead, and it stays out of the way on every normal
 * path (fresh db, already-migrated db, re-open).
 */
import { describe, expect, it } from 'vitest'

import { openDb } from '../src/db.js'
import { IdentityError } from '../src/errors.js'
import { applyMigrations, latestSchemaVersion } from '../src/schema.js'

/**
 * Stage what a newer Gotong leaves behind: the current schema, plus a
 * migration row from a version this build has never heard of. We can't run the
 * future migration's SQL (it doesn't exist yet), but the guard reads the
 * registry, not the columns — the recorded version IS the signal.
 */
function migratedByNewerBuild(db: ReturnType<typeof openDb>, futureVersion: number): void {
  applyMigrations(db)
  db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)').run(
    futureVersion,
    'add_something_from_the_future',
    Date.now(),
  )
}

describe('applyMigrations — refuses a store newer than the binary', () => {
  it('throws schema_from_the_future when the registry records an unknown version', () => {
    const db = openDb(':memory:')
    try {
      const future = latestSchemaVersion() + 1
      migratedByNewerBuild(db, future)

      let caught: unknown
      try {
        applyMigrations(db)
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(IdentityError)
      expect((caught as IdentityError).code).toBe('schema_from_the_future')
      // The message is what an operator mid-rollback actually acts on, so it
      // has to name both numbers and point at the runbook.
      const msg = (caught as IdentityError).message
      expect(msg).toContain(String(future))
      expect(msg).toContain(`v${latestSchemaVersion()}`)
      expect(msg).toContain('UPGRADE-RUNBOOK')
    } finally {
      db.close()
    }
  })

  it('reports every unknown version, not just the first', () => {
    const db = openDb(':memory:')
    try {
      const a = latestSchemaVersion() + 1
      const b = latestSchemaVersion() + 2
      migratedByNewerBuild(db, b) // insert out of order to prove it sorts
      db.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES(?, ?, ?)').run(
        a,
        'another_future_one',
        Date.now(),
      )

      expect(() => applyMigrations(db)).toThrow(new RegExp(`${a}, ${b}`))
    } finally {
      db.close()
    }
  })

  it('refuses BEFORE applying anything — a downgraded host must not half-migrate', () => {
    const db = openDb(':memory:')
    try {
      // A store that is ahead AND missing an old version is pathological, but
      // it is the shape a hand-edited registry takes. The guard must win: no
      // write may happen on a store we are about to reject.
      migratedByNewerBuild(db, latestSchemaVersion() + 1)
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(1)

      expect(() => applyMigrations(db)).toThrow(IdentityError)
      const rows = db.prepare('SELECT version FROM schema_migrations WHERE version = 1').all()
      expect(rows).toHaveLength(0) // v1 was NOT re-applied on the way out
    } finally {
      db.close()
    }
  })

  it('stays silent on the normal paths: fresh db, re-open, idempotent re-run', () => {
    const db = openDb(':memory:')
    try {
      const first = applyMigrations(db)
      expect(first.applied.length).toBeGreaterThan(0)
      expect(first.applied).toContain(latestSchemaVersion())

      // Same binary, same store, second open — the everyday case.
      expect(() => applyMigrations(db)).not.toThrow()
      expect(applyMigrations(db)).toEqual({ applied: [] })
    } finally {
      db.close()
    }
  })
})
