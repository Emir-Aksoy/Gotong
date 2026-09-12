import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from '@gotong/core'
import { buildTurnCapture, prepareEvidenceCorrection } from '@gotong/personal-memory'
import { kindFile, ownerDir } from '@gotong/service-memory-file'
import { openButlerMemory } from '../src/personal-butler-memory.js'

const logger = createLogger('correction-foundation-test', { disabled: true })
const temporal = { v: 1 as const, observedAt: Date.parse('2026-09-01T00:00:00Z'), timeZone: 'UTC', basis: 'turn-start' as const }
const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })

describe('butler correction foundation with a real owner store', () => {
  it('finds an old source beyond interactive limits, isolates owners, and does not write the plan', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gotong-correction-foundation-'))
    roots.push(rootDir)
    const owner = { kind: 'user', id: 'alice' } as const
    await mkdir(ownerDir(rootDir, owner), { recursive: true })
    const old = { ...buildTurnCapture({ userText: '上周我吃了烤肉', replyText: 'Wrong date in assistant reply', temporal, meta: { userId: 'alice' } })!, id: 'old', ts: 0 }
    const filler = Array.from({ length: 10000 }, (_, i) => ({ id: `filler-${i}`, kind: 'episodic', text: `Synthetic unrelated record ${i}`, ts: i + 1 }))
    const path = kindFile(rootDir, owner, 'episodic')
    const diskBefore = [old, ...filler].map(e => JSON.stringify(e)).join('\n') + '\n'
    await writeFile(path, diskBefore)
    const alice = openButlerMemory({ rootDir, userId: 'alice', logger })
    const bob = openButlerMemory({ rootDir, userId: 'bob', logger })
    await bob.remember({ ...buildTurnCapture({ userText: '上周我吃了烤肉', replyText: '', temporal, meta: { userId: 'bob' } })!, id: 'bob-same-quote' })

    expect((await alice.list({ limit: 10000 })).some(e => e.id === 'old')).toBe(false)
    const snapshot = await alice.snapshot()
    expect(snapshot.entries).toHaveLength(10001)
    expect(snapshot.entries.some(e => e.id === 'bob-same-quote')).toBe(false)
    const plan = prepareEvidenceCorrection(snapshot.entries, {
      userId: 'alice', target: { quote: '上周我吃了烤肉' }, maxEntryBytes: 4096,
      replacement: { sourceId: 'correction-turn', text: '2026-08-29我吃了烤肉', temporal: { ...temporal, observedAt: Date.parse('2026-09-11T00:00:00Z') } },
    })
    expect(plan.status).toBe('ready')
    if (plan.status !== 'ready') throw new Error('expected ready')
    expect(plan.remove).toEqual([{ id: 'old', kind: 'episodic' }])
    expect(plan.untraced).toHaveLength(10000)
    expect(JSON.stringify(plan)).not.toContain('上周我吃了烤肉')
    expect(await readFile(path, 'utf8')).toBe(diskBefore)
    expect((await alice.snapshot()).revision).toBe(snapshot.revision)
    expect((await bob.snapshot()).entries.map(e => e.id)).toEqual(['bob-same-quote'])
  })
})
