import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createLogger } from '@aipehub/core'
import { MemoryFileHandle } from '../src/handle.js'
import type { MemoryFileConfig } from '../src/config.js'
import { kindFile } from '../src/paths.js'

const logger = createLogger('memory-file-handle-test', { disabled: true })
const allKinds: MemoryFileConfig = {
  kinds: ['episodic', 'semantic', 'working'],
}
const owner = { kind: 'agent', id: 'writer-zh' } as const

let rootDir: string
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'aipe-mem-handle-'))
})
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

function newHandle(cfg: MemoryFileConfig = allKinds): MemoryFileHandle {
  return new MemoryFileHandle({ rootDir, owner, config: cfg, logger })
}

describe('remember / list / recall', () => {
  it('remember returns the entry with id + ts filled', async () => {
    const h = newHandle()
    const e = await h.remember({ kind: 'episodic', text: 'asked about coffee' })
    expect(e.id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/)
    expect(e.ts).toBeGreaterThan(0)
    expect(e.text).toBe('asked about coffee')
  })

  it('persists to the right jsonl file', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'asked about coffee' })
    const raw = await readFile(kindFile(rootDir, owner, 'episodic'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).text).toBe('asked about coffee')
  })

  it('list returns newest first', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'first' })
    // Force monotonic ts so we don't depend on sub-ms ordering.
    await new Promise((r) => setTimeout(r, 5))
    await h.remember({ kind: 'episodic', text: 'second' })
    const items = await h.list({ kind: 'episodic' })
    expect(items.map((x) => x.text)).toEqual(['second', 'first'])
  })

  it('list across kinds', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'e1' })
    await h.remember({ kind: 'semantic', text: 's1' })
    await h.remember({ kind: 'working', text: 'w1' })
    const items = await h.list({})
    expect(items.map((x) => x.text).sort()).toEqual(['e1', 's1', 'w1'])
  })

  it('recall filters by case-insensitive substring', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'GrabPay reconciliation' })
    await h.remember({ kind: 'episodic', text: '客户复购' })
    const matches = await h.recall({ text: 'grabpay' })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.text).toMatch(/GrabPay/)
  })

  it('recall filters by since', async () => {
    const h = newHandle()
    const a = await h.remember({ kind: 'episodic', text: 'old' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await h.remember({ kind: 'episodic', text: 'new' })
    const matches = await h.recall({ since: b.ts })
    expect(matches).toHaveLength(1)
    expect(matches[0]!.id).toBe(b.id)
    expect(matches[0]!.id).not.toBe(a.id)
  })

  it('recall caps k', async () => {
    const h = newHandle()
    for (let i = 0; i < 10; i++) {
      await h.remember({ kind: 'episodic', text: `entry-${i}` })
    }
    const matches = await h.recall({ k: 3 })
    expect(matches).toHaveLength(3)
  })

  it('recall enforces config.kinds (intersect with query.kinds)', async () => {
    const h = newHandle({ kinds: ['episodic'] })
    // remember on disallowed kind throws
    await expect(h.remember({ kind: 'semantic', text: 'x' })).rejects.toThrow(/not allowed/)
    await h.remember({ kind: 'episodic', text: 'e' })
    // recall asking for semantic returns nothing (it's not in config.kinds)
    const matches = await h.recall({ kinds: ['semantic'] })
    expect(matches).toHaveLength(0)
  })

  it('recall preserves meta when present', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'x', meta: { taskId: 't1' } })
    const [got] = await h.recall({ k: 1 })
    expect(got?.meta).toEqual({ taskId: 't1' })
  })

  it('forget removes the entry by id', async () => {
    const h = newHandle()
    const a = await h.remember({ kind: 'episodic', text: 'a' })
    await h.remember({ kind: 'episodic', text: 'b' })
    await h.forget(a.id)
    const items = await h.list({ kind: 'episodic' })
    expect(items.map((x) => x.text)).toEqual(['b'])
  })

  it('forget is a no-op when id is unknown', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'a' })
    await expect(h.forget('nonexistent')).resolves.not.toThrow()
  })

  it('clear() removes all kinds', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'e' })
    await h.remember({ kind: 'semantic', text: 's' })
    await h.clear()
    const items = await h.list({})
    expect(items).toHaveLength(0)
  })

  it('clear(kind) removes one kind only', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'e' })
    await h.remember({ kind: 'semantic', text: 's' })
    await h.clear('working')   // working is empty — no error
    await h.clear('episodic')
    const items = await h.list({})
    expect(items.map((x) => x.text)).toEqual(['s'])
  })
})

describe('remember validation', () => {
  it('rejects empty text', async () => {
    const h = newHandle()
    await expect(h.remember({ kind: 'episodic', text: '' })).rejects.toThrow(/non-empty/)
  })
})

describe('concurrent writes are serialised (no jsonl corruption)', () => {
  it('appends 50 concurrent remembers without interleaving', async () => {
    const h = newHandle()
    const writes = Array.from({ length: 50 }, (_, i) =>
      h.remember({ kind: 'episodic', text: `parallel-${i}` }),
    )
    const results = await Promise.all(writes)
    expect(new Set(results.map((r) => r.id)).size).toBe(50)
    const raw = await readFile(kindFile(rootDir, owner, 'episodic'), 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(50)
    // Each line must parse independently.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})

describe('owner isolation', () => {
  it('two owners do not see each other', async () => {
    const h1 = new MemoryFileHandle({
      rootDir, owner: { kind: 'agent', id: 'a-1' }, config: allKinds, logger,
    })
    const h2 = new MemoryFileHandle({
      rootDir, owner: { kind: 'agent', id: 'a-2' }, config: allKinds, logger,
    })
    await h1.remember({ kind: 'episodic', text: 'a1-data' })
    await h2.remember({ kind: 'episodic', text: 'a2-data' })
    expect((await h1.list({})).map((x) => x.text)).toEqual(['a1-data'])
    expect((await h2.list({})).map((x) => x.text)).toEqual(['a2-data'])
  })

  it('same id under different owner kinds is isolated', async () => {
    const agentHandle = new MemoryFileHandle({
      rootDir, owner: { kind: 'agent', id: 'same' }, config: allKinds, logger,
    })
    const sharedHandle = new MemoryFileHandle({
      rootDir, owner: { kind: 'shared', id: 'same' }, config: allKinds, logger,
    })
    await agentHandle.remember({ kind: 'episodic', text: 'agent-side' })
    expect((await sharedHandle.list({}))).toHaveLength(0)
  })
})

describe('truncation', () => {
  it('drops oldest ~50% when episodic exceeds maxEpisodicBytes', async () => {
    const cfg: MemoryFileConfig = {
      kinds: ['episodic'],
      // Each entry is a JSON of {"id","kind","text","ts"} ≈ 60-80 bytes.
      // 600 bytes ≈ ~8 entries; we'll write 10 and expect trim to ~5.
      maxEpisodicBytes: 600,
    }
    const h = new MemoryFileHandle({ rootDir, owner, config: cfg, logger })
    for (let i = 0; i < 10; i++) {
      await h.remember({ kind: 'episodic', text: `entry-${i}` })
    }
    const path = kindFile(rootDir, owner, 'episodic')
    const sizeAfter = (await stat(path)).size
    expect(sizeAfter).toBeLessThan(600 * 2)   // generous upper bound
    const items = await h.list({ kind: 'episodic', limit: 100 })
    // We kept the second half; oldest entries are dropped.
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThan(10)
    // The most recent ones should still be there.
    expect(items.map((x) => x.text)).toContain('entry-9')
  })
})

describe('corrupt lines tolerated', () => {
  it('list skips a corrupt line and reads the rest', async () => {
    const h = newHandle()
    await h.remember({ kind: 'episodic', text: 'good-1' })
    // Inject a bad line in the middle.
    const path = kindFile(rootDir, owner, 'episodic')
    const before = await readFile(path, 'utf8')
    await writeFile(path, before + 'not-json{\n', 'utf8')
    await h.remember({ kind: 'episodic', text: 'good-2' })
    const items = await h.list({ kind: 'episodic' })
    expect(items.map((x) => x.text).sort()).toEqual(['good-1', 'good-2'])
  })
})

describe('empty state', () => {
  it('list on empty owner returns []', async () => {
    const h = newHandle()
    expect(await h.list({})).toEqual([])
  })

  it('recall on empty owner returns []', async () => {
    const h = newHandle()
    expect(await h.recall({ text: 'anything' })).toEqual([])
  })

  it('clear on empty owner does not throw', async () => {
    const h = newHandle()
    await expect(h.clear()).resolves.not.toThrow()
  })
})
