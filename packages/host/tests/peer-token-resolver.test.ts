/**
 * Audit #154 — unit test for `buildPeerTokenResolver`.
 *
 * The resolver runs on every inbound peer HELLO and decides which
 * shared token to verify against. Before #154, all rejection paths
 * (unknown peer / disabled / no token / identity throws) returned
 * null silently, leaving operators chasing "why won't peer X connect"
 * with zero signal. Now each path emits a structured log:
 *   - debug: routine rejects (unknown / disabled)
 *   - warn:  abnormal (no token vaulted / identity throws)
 *
 * The transport-ws close is still silent by design; the log is local
 * only, so anti-enumeration is preserved on the wire.
 */

import { describe, expect, it } from 'vitest'

import {
  buildPeerTokenResolver,
  type PeerTokenResolverIdentity,
} from '../src/peer-registry.js'

type LogEntry = { level: 'debug' | 'warn'; msg: string; ctx: unknown }

interface IdentityStub extends PeerTokenResolverIdentity {
  // Same shape — typed alias for inline construction.
}

function makeResolver(identity: IdentityStub): {
  resolve: (peerId: string) => string | null
  logs: LogEntry[]
} {
  const logs: LogEntry[] = []
  const resolve = buildPeerTokenResolver(identity, (level, msg, ctx) =>
    logs.push({ level, msg, ctx }),
  )
  return { resolve, logs }
}

describe('buildPeerTokenResolver (Audit #154)', () => {
  it('unknown peer: returns null + debug log', () => {
    const { resolve, logs } = makeResolver({
      getPeerByPeerId: () => null,
      getPeerToken: () => {
        throw new Error('should not be called')
      },
    } as IdentityStub)
    expect(resolve('hubA')).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe('debug')
    expect(logs[0]!.msg).toContain('unknown peer')
    expect((logs[0]!.ctx as { claimedPeerId: string }).claimedPeerId).toBe('hubA')
  })

  it('disabled peer: returns null + debug log with rowId', () => {
    const { resolve, logs } = makeResolver({
      getPeerByPeerId: () =>
        ({
          id: 'row-xyz',
          peerHubId: 'hubA',
          endpoint: 'wss://x',
          label: null,
          enabled: false,
          createdAt: 0,
          updatedAt: 0,
        }) as unknown as ReturnType<PeerTokenResolverIdentity['getPeerByPeerId']>,
      getPeerToken: () => {
        throw new Error('should not be called')
      },
    } as IdentityStub)
    expect(resolve('hubA')).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe('debug')
    expect(logs[0]!.msg).toContain('peer disabled')
    expect((logs[0]!.ctx as { rowId: string }).rowId).toBe('row-xyz')
  })

  it('revoked peer: returns null + debug log (Phase 19 P4-M4)', () => {
    // A revoked link is refused at the wire — the earliest of the three
    // revocation gates, so the link is never even allocated.
    const { resolve, logs } = makeResolver({
      getPeerByPeerId: () =>
        ({
          id: 'row-xyz',
          peerHubId: 'hubA',
          endpoint: 'wss://x',
          label: null,
          enabled: true,
          revocationState: 'revoked',
          createdAt: 0,
          updatedAt: 0,
        }) as unknown as ReturnType<PeerTokenResolverIdentity['getPeerByPeerId']>,
      getPeerToken: () => {
        throw new Error('should not be called')
      },
    } as IdentityStub)
    expect(resolve('hubA')).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe('debug')
    expect(logs[0]!.msg).toContain('peer revoked')
    expect((logs[0]!.ctx as { rowId: string }).rowId).toBe('row-xyz')
  })

  it('no token vaulted: returns null + warn log (operator action needed)', () => {
    const { resolve, logs } = makeResolver({
      getPeerByPeerId: () =>
        ({
          id: 'row-xyz',
          peerHubId: 'hubA',
          endpoint: 'wss://x',
          label: null,
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        }) as unknown as ReturnType<PeerTokenResolverIdentity['getPeerByPeerId']>,
      getPeerToken: () => null,
    } as IdentityStub)
    expect(resolve('hubA')).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe('warn')
    expect(logs[0]!.msg).toContain('no token vaulted')
  })

  it('empty-string token from vault: still rejected as no-token (warn)', () => {
    // Audit #154 specifically called out empty-string as a corner case
    // — a corrupt vault row that decrypts to ''.
    const { resolve, logs } = makeResolver({
      getPeerByPeerId: () =>
        ({
          id: 'row-xyz',
          peerHubId: 'hubA',
          endpoint: 'wss://x',
          label: null,
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        }) as unknown as ReturnType<PeerTokenResolverIdentity['getPeerByPeerId']>,
      getPeerToken: () => '',
    } as IdentityStub)
    expect(resolve('hubA')).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe('warn')
  })

  it('identity throws: returns null + warn log including err msg', () => {
    const { resolve, logs } = makeResolver({
      getPeerByPeerId: () => {
        throw new Error('SQLITE_CORRUPT: catastrophe')
      },
      getPeerToken: () => {
        throw new Error('should not be reached')
      },
    } as IdentityStub)
    expect(resolve('hubA')).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]!.level).toBe('warn')
    expect(logs[0]!.msg).toContain('resolver failure')
    expect((logs[0]!.ctx as { err: string }).err).toContain('SQLITE_CORRUPT')
  })

  it('happy path: returns the token + emits NO log', () => {
    const { resolve, logs } = makeResolver({
      getPeerByPeerId: () =>
        ({
          id: 'row-xyz',
          peerHubId: 'hubA',
          endpoint: 'wss://x',
          label: null,
          enabled: true,
          createdAt: 0,
          updatedAt: 0,
        }) as unknown as ReturnType<PeerTokenResolverIdentity['getPeerByPeerId']>,
      getPeerToken: () => 'shhhhh',
    } as IdentityStub)
    expect(resolve('hubA')).toBe('shhhhh')
    expect(logs).toEqual([])
  })
})
