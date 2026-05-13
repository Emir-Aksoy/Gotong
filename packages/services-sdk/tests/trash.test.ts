import { describe, expect, it } from 'vitest'
import {
  isExpired,
  makeTrashRef,
  TRASH_BUCKET_MS,
  TRASH_DEFAULT_RETENTION_MS,
  trashId,
} from '../src/trash.js'
import type { Owner } from '../src/owner.js'

const sampleOwner: Owner = { kind: 'agent', id: 'writer-zh' }

describe('trashId', () => {
  it('is 16 hex chars', async () => {
    const id = await trashId({
      type: 'memory',
      impl: 'file',
      owner: sampleOwner,
      deletedAt: 1_700_000_000_000,
    })
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic for same (type, impl, owner, day)', async () => {
    const t = 1_700_000_000_000
    const a = await trashId({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t })
    const b = await trashId({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t + 1234 })
    expect(b).toBe(a)
  })

  it('differs across different days', async () => {
    const t = 1_700_000_000_000
    const a = await trashId({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t })
    const b = await trashId({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t + TRASH_BUCKET_MS })
    expect(b).not.toBe(a)
  })

  it('differs across types even when other fields match', async () => {
    const t = 1_700_000_000_000
    const a = await trashId({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t })
    const b = await trashId({ type: 'artifact', impl: 'file', owner: sampleOwner, deletedAt: t })
    expect(b).not.toBe(a)
  })

  it('differs across owner kinds with same id', async () => {
    const t = 1_700_000_000_000
    const a = await trashId({ type: 'memory', impl: 'file', owner: { kind: 'agent', id: 'x' }, deletedAt: t })
    const b = await trashId({ type: 'memory', impl: 'file', owner: { kind: 'shared', id: 'x' }, deletedAt: t })
    expect(b).not.toBe(a)
  })
})

describe('makeTrashRef', () => {
  it('fills expiresAt = deletedAt + default retention', async () => {
    const t = 1_700_000_000_000
    const ref = await makeTrashRef({
      type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t,
    })
    expect(ref.expiresAt).toBe(t + TRASH_DEFAULT_RETENTION_MS)
  })

  it('honors custom retentionMs', async () => {
    const t = 1_700_000_000_000
    const ref = await makeTrashRef({
      type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t,
      retentionMs: 3_600_000, // 1 hour
    })
    expect(ref.expiresAt).toBe(t + 3_600_000)
  })

  it('carries reason when provided', async () => {
    const ref = await makeTrashRef({
      type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: 1,
      reason: 'admin deleted agent',
    })
    expect(ref.reason).toBe('admin deleted agent')
  })

  it('omits reason key when not provided', async () => {
    const ref = await makeTrashRef({
      type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: 1,
    })
    expect('reason' in ref).toBe(false)
  })

  it('id matches trashId() output', async () => {
    const t = 1_700_000_000_000
    const ref = await makeTrashRef({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t })
    const expected = await trashId({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: t })
    expect(ref.id).toBe(expected)
  })
})

describe('isExpired', () => {
  it('false before expiresAt', async () => {
    const ref = await makeTrashRef({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: 1000 })
    expect(isExpired(ref, ref.expiresAt - 1)).toBe(false)
  })

  it('true exactly at expiresAt', async () => {
    const ref = await makeTrashRef({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: 1000 })
    expect(isExpired(ref, ref.expiresAt)).toBe(true)
  })

  it('true after expiresAt', async () => {
    const ref = await makeTrashRef({ type: 'memory', impl: 'file', owner: sampleOwner, deletedAt: 1000 })
    expect(isExpired(ref, ref.expiresAt + 1)).toBe(true)
  })
})
