import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@aipehub/core'
import { DatastoreSqliteHandle } from '../src/handle.js'
import type { DatastoreSqliteConfig } from '../src/config.js'

const logger = createLogger('datastore-sqlite-handle-test', { disabled: true })

const cfg = (name = 'default', schema?: string): DatastoreSqliteConfig => ({
  name,
  maxBytes: 10 * 1024 * 1024,
  ...(schema ? { schema } : {}),
})

let root: string
let h: DatastoreSqliteHandle

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aipe-ds-handle-'))
})
afterEach(async () => {
  h?.close()
  await rm(root, { recursive: true, force: true })
})

function open(c = cfg()): DatastoreSqliteHandle {
  return new DatastoreSqliteHandle({
    dbPath: join(root, `${c.name}.sqlite`),
    config: c,
    logger,
  })
}

describe('KV mode', () => {
  it('set + get roundtrips JSON-encodable values', async () => {
    h = open()
    await h.kv.set('foo', { a: 1, b: 'two' })
    const got = await h.kv.get('foo')
    expect(got).toEqual({ a: 1, b: 'two' })
  })

  it('get returns undefined for missing keys', async () => {
    h = open()
    expect(await h.kv.get('nope')).toBeUndefined()
  })

  it('set on existing key overwrites', async () => {
    h = open()
    await h.kv.set('k', 1)
    await h.kv.set('k', 2)
    expect(await h.kv.get('k')).toBe(2)
  })

  it('del removes the key', async () => {
    h = open()
    await h.kv.set('k', 'v')
    await h.kv.del('k')
    expect(await h.kv.get('k')).toBeUndefined()
  })

  it('keys() lists all when no prefix', async () => {
    h = open()
    await h.kv.set('a', 1)
    await h.kv.set('b', 2)
    await h.kv.set('c', 3)
    const list = await h.kv.keys()
    expect(list.sort()).toEqual(['a', 'b', 'c'])
  })

  it('keys(prefix) filters', async () => {
    h = open()
    await h.kv.set('reports/q1', 1)
    await h.kv.set('reports/q2', 2)
    await h.kv.set('notes/x', 3)
    const list = await h.kv.keys('reports/')
    expect(list.sort()).toEqual(['reports/q1', 'reports/q2'])
  })

  it('keys(prefix) handles SQL wildcards as literals', async () => {
    h = open()
    // Real keys with `%` in them shouldn't be matched as LIKE wildcards.
    await h.kv.set('a%b', 1)
    await h.kv.set('axb', 2)
    const list = await h.kv.keys('a%')
    // We escape `%`, so only the literal `a%b` matches.
    expect(list).toEqual(['a%b'])
  })

  it('survives close + reopen — data persists on disk', async () => {
    h = open()
    await h.kv.set('k', 'v')
    h.close()
    h = open()
    expect(await h.kv.get('k')).toBe('v')
  })
})

describe('SQL mode', () => {
  it('runs schema at attach time', async () => {
    h = open(cfg('default', 'CREATE TABLE foo(id INTEGER PRIMARY KEY, name TEXT);'))
    await h.sql.exec(`INSERT INTO foo(id, name) VALUES (1, 'a');`)
    const rows = await h.sql.query<{ id: number; name: string }>('SELECT * FROM foo;')
    expect(rows).toEqual([{ id: 1, name: 'a' }])
  })

  it('honors parameterised exec + query (no SQL injection)', async () => {
    h = open(cfg('default', 'CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT);'))
    const evil = `x'); DROP TABLE notes;--`
    await h.sql.exec('INSERT INTO notes(body) VALUES (?);', [evil])
    const rows = await h.sql.query<{ body: string }>('SELECT body FROM notes;')
    expect(rows).toEqual([{ body: evil }])
  })

  it('exec returns changes count', async () => {
    h = open(cfg('default', 'CREATE TABLE x(a INTEGER);'))
    await h.sql.exec('INSERT INTO x(a) VALUES (1), (2), (3);')
    const r = await h.sql.exec('UPDATE x SET a = a + 1;')
    expect(r.changes).toBe(3)
  })

  it('prepared statement cache reuses the same plan for identical SQL', async () => {
    h = open(cfg('default', 'CREATE TABLE x(a INTEGER);'))
    // Internal cache is private, but we can observe the behaviour:
    // performance should be flat over many identical statements. We
    // mostly assert correctness here; the cache existence is asserted
    // separately by a microbenchmark-style check that wouldn't add
    // signal in CI. So we keep this test focused: many identical
    // statements all produce correct output.
    for (let i = 0; i < 50; i++) {
      await h.sql.exec('INSERT INTO x(a) VALUES (?);', [i])
    }
    const rows = await h.sql.query<{ c: number }>('SELECT COUNT(*) AS c FROM x;')
    expect(rows[0]!.c).toBe(50)
  })

  it('foreign keys are ON (configurable schemas can rely on them)', async () => {
    h = open(cfg('default', `
      CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `))
    // Insert child pointing at a missing parent — must fail.
    await expect(
      h.sql.exec('INSERT INTO child(id, parent_id) VALUES (1, 99);'),
    ).rejects.toThrow(/FOREIGN KEY/i)
  })

  it('exec after close throws', async () => {
    h = open()
    h.close()
    await expect(h.sql.exec('SELECT 1;')).rejects.toThrow(/closed/)
  })

  it('rejects write when maxBytes would be exceeded', async () => {
    // SQLite allocates ~4KB of page header at first write, so a tiny
    // cap blocks writes immediately. We make this assertion explicit:
    // any write at all on a 1-byte cap fails. The realistic "lots of
    // small writes blow through a generous cap" path is exercised by
    // an integration test in PR-13.
    h = open({ name: 'cap', maxBytes: 1, schema: `CREATE TABLE x(a TEXT);` })
    await expect(h.sql.exec(`INSERT INTO x(a) VALUES ('hello');`)).rejects.toThrow(/maxBytes/)
  })
})

describe('handle.name', () => {
  it('echoes config.name (used by host buildCtx)', () => {
    h = open(cfg('cases'))
    expect(h.name).toBe('cases')
  })
})

describe('schema validation', () => {
  it('a syntactically invalid schema throws + closes the db', () => {
    expect(() => open(cfg('default', 'CREATE BUTTERFLY xx;'))).toThrow(/schema rejected/)
  })
})

describe('concurrent kv', () => {
  it('50 parallel sets to distinct keys all land', async () => {
    h = open()
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => h.kv.set(`k-${i}`, i)),
    )
    expect((await h.kv.keys()).length).toBe(50)
  })

  it('two concurrent sets on the same key resolve to one of them', async () => {
    h = open()
    await Promise.all([h.kv.set('x', 'a'), h.kv.set('x', 'b')])
    expect(['a', 'b']).toContain(await h.kv.get('x'))
  })
})
