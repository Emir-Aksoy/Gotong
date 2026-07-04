import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileStorage } from '../src/storage/file.js'
import { InMemoryStorage } from '../src/storage/memory.js'
import type { Storage } from '../src/storage/index.js'
import {
  DEFAULT_TENANT,
  TenantIdError,
  assertTenantId,
  normalizeNamespace,
  tenantRoot,
} from '../src/tenant.js'
import { Transcript } from '../src/transcript.js'
import type { TranscriptEntry } from '../src/types.js'

function joinEntry(seq: number, id: string): TranscriptEntry {
  return {
    seq,
    ts: 1_000 + seq,
    kind: 'participant_joined',
    data: { id, participantKind: 'agent', capabilities: ['x'] },
  }
}

describe('tenant primitive (Route B P0-M1)', () => {
  describe('tenantRoot', () => {
    const base = '/srv/gotong'

    it('the default tenant resolves to the bare base root (zero behaviour change)', () => {
      // This is the zero-behaviour-change guarantee: a default-tenant
      // deployment's files land exactly where they did before the dimension
      // existed — no `tenants/` segment is injected. If this short-circuit
      // ever breaks, every existing single-tenant workspace silently moves.
      expect(tenantRoot(base)).toBe(base)
      expect(tenantRoot(base, DEFAULT_TENANT)).toBe(base)
      expect(tenantRoot(base, 'default')).toBe(base)
    })

    it('a non-default tenant lands under <base>/tenants/<id>', () => {
      expect(tenantRoot(base, 'alpha')).toBe(join(base, 'tenants', 'alpha'))
      expect(tenantRoot(base, 'beta')).toBe(join(base, 'tenants', 'beta'))
    })

    it('distinct tenants resolve to distinct, isolated roots', () => {
      const a = tenantRoot(base, 'alpha')
      const b = tenantRoot(base, 'beta')
      expect(a).not.toBe(b)
      expect(a).not.toBe(base)
      expect(b).not.toBe(base)
    })

    it('rejects an unsafe tenant id before composing a path', () => {
      expect(() => tenantRoot(base, '../escape')).toThrow(TenantIdError)
      expect(() => tenantRoot(base, 'a/b')).toThrow(TenantIdError)
    })
  })

  describe('assertTenantId', () => {
    it('accepts lowercase alphanumeric ids with - and _', () => {
      for (const ok of ['default', 'alpha', 'team-1', 't_2', 'a', '0', '9z', 'org-2026_q1']) {
        expect(() => assertTenantId(ok)).not.toThrow()
      }
    })

    it('rejects path-traversal and separator chars (the isolation guard)', () => {
      for (const bad of ['..', '../x', 'a/b', 'a\\b', '.hidden', 'a b']) {
        expect(() => assertTenantId(bad)).toThrow(TenantIdError)
      }
    })

    it('rejects uppercase (case-insensitive-FS collision footgun)', () => {
      // `Alpha` and `alpha` would collide on macOS/APFS + Windows/NTFS.
      const err = (() => {
        try {
          assertTenantId('Alpha')
          return undefined
        } catch (e) {
          return e as TenantIdError
        }
      })()
      expect(err).toBeInstanceOf(TenantIdError)
      expect(err?.code).toBe('tenant_id_charset')
    })

    it('rejects empty, over-long, and non-string ids with specific codes', () => {
      const code = (fn: () => void): string | undefined => {
        try {
          fn()
          return undefined
        } catch (e) {
          return (e as TenantIdError).code
        }
      }
      expect(code(() => assertTenantId(''))).toBe('tenant_id_empty')
      expect(code(() => assertTenantId('a'.repeat(65)))).toBe('tenant_id_too_long')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(code(() => assertTenantId(7 as any))).toBe('tenant_id_not_string')
    })
  })

  describe('normalizeNamespace', () => {
    it('maps undefined to the default tenant and validates the rest', () => {
      expect(normalizeNamespace()).toBe(DEFAULT_TENANT)
      expect(normalizeNamespace(undefined)).toBe('default')
      expect(normalizeNamespace('alpha')).toBe('alpha')
      expect(() => normalizeNamespace('Bad/Id')).toThrow(TenantIdError)
    })
  })
})

describe('storage namespace (Route B P0-M1)', () => {
  it('FileStorage defaults to the default tenant and exposes an explicit one', () => {
    expect(new FileStorage(join(tmpdir(), 'ns-a.jsonl')).namespace).toBe('default')
    expect(new FileStorage(join(tmpdir(), 'ns-b.jsonl'), 'alpha').namespace).toBe('alpha')
  })

  it('FileStorage validates an explicit namespace at construction', () => {
    expect(() => new FileStorage(join(tmpdir(), 'ns-c.jsonl'), 'BAD/NS')).toThrow(
      TenantIdError,
    )
  })

  it('InMemoryStorage defaults to / reflects its namespace', () => {
    expect(new InMemoryStorage().namespace).toBe('default')
    expect(new InMemoryStorage('beta').namespace).toBe('beta')
  })

  it('Transcript.namespace() reflects the storage, falling back to default', () => {
    expect(new Transcript(new InMemoryStorage()).namespace()).toBe('default')
    expect(new Transcript(new InMemoryStorage('alpha')).namespace()).toBe('alpha')
    // A bare external Storage that predates the dimension (no namespace field).
    const legacy: Storage = {
      async loadTranscript() {
        return []
      },
      async appendTranscriptEntry() {},
    }
    expect(new Transcript(legacy).namespace()).toBe('default')
  })
})

describe('tenant isolation round-trip (acceptance — A/B + default byte-identity)', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'gotong-tenant-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('the default tenant writes to the bare root path, no tenants/ segment', async () => {
    // Pins the zero-behaviour-change contract end-to-end: the on-disk file a
    // default-tenant transcript produces is exactly <base>/transcript.jsonl,
    // the same path a tenant-unaware caller produced before P0-M1.
    const expectedPath = join(base, 'transcript.jsonl')
    expect(join(tenantRoot(base, DEFAULT_TENANT), 'transcript.jsonl')).toBe(expectedPath)

    const s = new FileStorage(expectedPath, DEFAULT_TENANT)
    await s.appendTranscriptEntry(joinEntry(1, 'root'))
    await s.close()

    expect(existsSync(expectedPath)).toBe(true)
    // The tenants/ subtree must NOT have been created for the default tenant.
    expect(existsSync(join(base, 'tenants'))).toBe(false)
    const raw = await readFile(expectedPath, 'utf8')
    expect(raw).toContain('"id":"root"')
  })

  it('tenant A and tenant B transcripts are physically isolated', async () => {
    const rootA = tenantRoot(base, 'alpha')
    const rootB = tenantRoot(base, 'beta')
    const pathA = join(rootA, 'transcript.jsonl')
    const pathB = join(rootB, 'transcript.jsonl')
    expect(pathA).not.toBe(pathB)

    const a = new FileStorage(pathA, 'alpha')
    const b = new FileStorage(pathB, 'beta')
    await a.appendTranscriptEntry(joinEntry(1, 'only-in-a'))
    await b.appendTranscriptEntry(joinEntry(1, 'only-in-b'))
    await a.close()
    await b.close()

    // Re-open fresh storages at the same paths and prove no cross-bleed.
    const a2 = new FileStorage(pathA, 'alpha')
    const b2 = new FileStorage(pathB, 'beta')
    const loadedA = await a2.loadTranscript()
    const loadedB = await b2.loadTranscript()

    expect(loadedA.map((e) => (e.data as { id: string }).id)).toEqual(['only-in-a'])
    expect(loadedB.map((e) => (e.data as { id: string }).id)).toEqual(['only-in-b'])
    expect(a2.namespace).toBe('alpha')
    expect(b2.namespace).toBe('beta')
    expect(existsSync(join(base, 'tenants', 'alpha'))).toBe(true)
    expect(existsSync(join(base, 'tenants', 'beta'))).toBe(true)
  })
})
