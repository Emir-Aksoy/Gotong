/**
 * H2 regression — datastore:sqlite KV write must respect maxBytes.
 *
 * Pre-3.4 only `sql.exec` ran through the size cap. The KV surface
 * (`kv.set`) called straight into the prepared statement, so an agent
 * could pour unbounded data through the KV API and silently blow past
 * `cfg.maxBytes`. Multi-tenant Hubs rely on that cap to keep one
 * runaway agent from filling shared disk; bypassing it was a quota
 * escape.
 *
 * The fix lifts `writeGuard` out of `makeSqlHandle` so both the KV
 * and SQL surfaces invoke the SAME function — one chokepoint for
 * "is this write allowed?".
 *
 * See AUDIT-v3.3.md finding H2.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@aipehub/core'
import { DatastoreSqliteHandle } from '../src/handle.js'
import type { DatastoreSqliteConfig } from '../src/config.js'

const logger = createLogger('h2-test', { disabled: true })

let root: string
let h: DatastoreSqliteHandle | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aipe-h2-'))
})
afterEach(async () => {
  h?.close()
  h = undefined
  await rm(root, { recursive: true, force: true })
})

function open(cfg: DatastoreSqliteConfig): DatastoreSqliteHandle {
  return new DatastoreSqliteHandle({
    dbPath: join(root, `${cfg.name}.sqlite`),
    config: cfg,
    logger,
  })
}

describe('H2 — kv.set runs through the writeGuard', () => {
  it('rejects kv.set when the db is already over maxBytes', async () => {
    // Open with a generous cap, write a bunch of data, then re-open
    // the SAME file with a tiny cap — that's the moment the guard
    // should bite. (We can't just open with a 1-byte cap and call
    // kv.set directly because SQLite hasn't yet allocated header
    // bytes; the audit's reproducer also stages data first.)
    h = open({ name: 'fill', maxBytes: 10 * 1024 * 1024 })
    for (let i = 0; i < 200; i++) {
      await h.kv.set(`k-${i}`, 'x'.repeat(1024))
    }
    h.close()

    h = open({ name: 'fill', maxBytes: 1 }) // re-open same file, tiny cap
    await expect(h.kv.set('one-more', 'small')).rejects.toThrow(/maxBytes/)
  })

  it('rejects kv.set immediately when an over-quota file is opened', async () => {
    // Edge case: brand-new handle, first write goes through the guard.
    h = open({ name: 'overflow', maxBytes: 10 * 1024 * 1024 })
    // Inflate the file way past the cap we'll re-open with.
    await h.sql.exec('CREATE TABLE big(v TEXT);')
    for (let i = 0; i < 100; i++) {
      await h.sql.exec('INSERT INTO big(v) VALUES (?);', ['x'.repeat(4096)])
    }
    h.close()

    h = open({ name: 'overflow', maxBytes: 1 })
    await expect(h.kv.set('blocked', 'no')).rejects.toThrow(/maxBytes/)
  })

  it('still accepts kv.set when the db is under the cap', async () => {
    // Smoke-test the happy path: a brand-new file (size ~0 / a few KB
    // of header) under a generous cap accepts writes normally.
    h = open({ name: 'happy', maxBytes: 10 * 1024 * 1024 })
    await h.kv.set('foo', 'bar')
    expect(await h.kv.get('foo')).toBe('bar')
  })

  it('kv.set after close() throws (read paths share the same closed check)', async () => {
    h = open({ name: 'closed', maxBytes: 10 * 1024 * 1024 })
    h.close()
    await expect(h.kv.set('k', 'v')).rejects.toThrow(/closed/)
  })

  it('sql.exec still rejects over-cap (no regression in the SQL path)', async () => {
    // Belt-and-braces: lifting writeGuard out must not weaken the
    // existing SQL gate.
    h = open({ name: 'sql', maxBytes: 10 * 1024 * 1024 })
    await h.sql.exec('CREATE TABLE big(v TEXT);')
    for (let i = 0; i < 100; i++) {
      await h.sql.exec('INSERT INTO big(v) VALUES (?);', ['x'.repeat(4096)])
    }
    h.close()
    h = open({ name: 'sql', maxBytes: 1 })
    await expect(h.sql.exec("INSERT INTO big(v) VALUES ('nope');")).rejects.toThrow(/maxBytes/)
  })

  it('kv.del is intentionally NOT gated by the writeGuard (lets operators recover)', async () => {
    // If the db is over quota, blocking deletes would leave the user
    // with no in-band way to free space. We accept the trade: writes
    // are gated, deletes are not. Document the behaviour so a future
    // tightening doesn't accidentally regress it.
    h = open({ name: 'recover', maxBytes: 10 * 1024 * 1024 })
    await h.kv.set('k', 'v')
    h.close()

    h = open({ name: 'recover', maxBytes: 1 })
    await expect(h.kv.del('k')).resolves.toBeUndefined()
  })

  it('kv reads (get / keys) stay open on an over-quota file', async () => {
    // Same reasoning as `del`: reads must work so an operator can
    // dump / migrate the data off a full database.
    h = open({ name: 'read-over', maxBytes: 10 * 1024 * 1024 })
    await h.kv.set('a', 1)
    await h.kv.set('b', 2)
    h.close()

    h = open({ name: 'read-over', maxBytes: 1 })
    expect(await h.kv.get('a')).toBe(1)
    expect((await h.kv.keys()).sort()).toEqual(['a', 'b'])
  })
})
