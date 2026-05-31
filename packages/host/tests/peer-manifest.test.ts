/**
 * Peer capability manifest — provider + consumer (Phase 18 A-M1).
 *
 * buildLocalManifest aggregates LOCAL participant capabilities (deduped,
 * sorted) while excluding peer wrappers; PeerManifestHost.respond answers
 * the one wire method; fetchPeerManifest forwards the rpc. The end-to-end
 * case runs the whole thing over an inproc HubLink pair (no mocks on the
 * seam), mirroring mcp-proxy.test.ts.
 */

import { describe, expect, it } from 'vitest'

import { createInprocHubLinkPair, type HubLink, type Participant } from '@aipehub/core'

import {
  PeerManifestHost,
  PEER_MANIFEST_METHODS,
  PEER_MANIFEST_VERSION,
  buildLocalManifest,
  fetchPeerManifest,
  createPeerManifestFederation,
  type ManifestHubView,
  type ManifestPeerRegistryView,
  type PeerManifest,
} from '../src/peer-manifest.js'

/** Minimal Participant fake — buildLocalManifest reads only id + capabilities. */
function fakeParticipant(id: string, capabilities: string[]): Participant {
  return { id, kind: 'agent', capabilities } as unknown as Participant
}

function hubWith(participants: Participant[]): ManifestHubView {
  return { participants: () => participants }
}

describe('buildLocalManifest (Phase 18 A-M1)', () => {
  it('dedupes + sorts capabilities across local participants', () => {
    const hub = hubWith([
      fakeParticipant('writer', ['draft', 'review']),
      fakeParticipant('planner', ['plan', 'review']), // 'review' duplicated
    ])
    const m = buildLocalManifest(hub, 'hub_self', new Set())
    expect(m.capabilities).toEqual(['draft', 'plan', 'review'])
    expect(m.hubId).toBe('hub_self')
    expect(m.protocolVersion).toBe(PEER_MANIFEST_VERSION)
  })

  it('excludes peer-wrapper participants (never re-advertise a neighbour)', () => {
    const hub = hubWith([
      fakeParticipant('writer', ['draft']),
      fakeParticipant('hub_neighbour', ['vendor-quote', 'remote-only']), // a wrapper
    ])
    const m = buildLocalManifest(hub, 'hub_self', new Set(['hub_neighbour']))
    expect(m.capabilities).toEqual(['draft'])
  })

  it('returns an empty list when no local participant serves anything', () => {
    const hub = hubWith([fakeParticipant('hub_neighbour', ['x'])])
    const m = buildLocalManifest(hub, 'hub_self', new Set(['hub_neighbour']))
    expect(m.capabilities).toEqual([])
  })
})

describe('PeerManifestHost.respond (Phase 18 A-M1)', () => {
  function setup(participants: Participant[], wrappers: string[] = []) {
    return new PeerManifestHost({
      hub: hubWith(participants),
      hubId: 'hub_provider',
      peerWrapperIds: () => new Set(wrappers),
    })
  }

  it('answers peer.manifest with the local manifest', async () => {
    const host = setup([fakeParticipant('a', ['cap-b', 'cap-a'])])
    const out = await host.respond({ method: PEER_MANIFEST_METHODS.get, params: {} })
    expect(out).toEqual({
      hubId: 'hub_provider',
      capabilities: ['cap-a', 'cap-b'],
      protocolVersion: PEER_MANIFEST_VERSION,
    })
  })

  it('reflects the CURRENT wrapper set on every call (thunk, not snapshot)', async () => {
    let wrappers: string[] = []
    const host = new PeerManifestHost({
      hub: hubWith([fakeParticipant('a', ['x']), fakeParticipant('hub_n', ['y'])]),
      hubId: 'hub_provider',
      peerWrapperIds: () => new Set(wrappers),
    })
    const before = (await host.respond({ method: PEER_MANIFEST_METHODS.get, params: {} })) as {
      capabilities: string[]
    }
    expect(before.capabilities).toEqual(['x', 'y'])
    wrappers = ['hub_n'] // a peer connected since the first call
    const after = (await host.respond({ method: PEER_MANIFEST_METHODS.get, params: {} })) as {
      capabilities: string[]
    }
    expect(after.capabilities).toEqual(['x'])
  })

  it('rejects an unknown method', async () => {
    const host = setup([fakeParticipant('a', ['x'])])
    await expect(host.respond({ method: 'peer.deleteEverything', params: {} })).rejects.toThrow(
      /unknown peer manifest method/,
    )
  })
})

describe('fetchPeerManifest (Phase 18 A-M1, consumer)', () => {
  it('forwards the peer.manifest rpc and returns the manifest', async () => {
    const seen: Array<{ method: string; params: unknown }> = []
    const link = {
      status: 'open' as const,
      rpc: async (method: string, params: unknown) => {
        seen.push({ method, params })
        return { hubId: 'hub_x', capabilities: ['a'], protocolVersion: '1' }
      },
    } as unknown as HubLink
    const out = await fetchPeerManifest(link)
    expect(out).toEqual({ hubId: 'hub_x', capabilities: ['a'], protocolVersion: '1' })
    expect(seen).toEqual([{ method: PEER_MANIFEST_METHODS.get, params: {} }])
  })

  it('returns null when the peer answers null', async () => {
    const link = { status: 'open', rpc: async () => null } as unknown as HubLink
    expect(await fetchPeerManifest(link)).toBeNull()
  })
})

describe('peer manifest — end to end over a live link (Phase 18 A-M1)', () => {
  it('a consumer fetches a provider hub manifest through the inproc link', async () => {
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'provider', bPeerId: 'consumer' })
    const host = new PeerManifestHost({
      hub: hubWith([
        fakeParticipant('writer', ['draft', 'review']),
        fakeParticipant('consumer', ['remote-only']), // the consumer's wrapper on the provider
      ]),
      hubId: 'provider',
      peerWrapperIds: () => new Set(['consumer']),
    })
    a.on('rpc', host.respond)
    const manifest = await fetchPeerManifest(b)
    expect(manifest).toEqual({
      hubId: 'provider',
      capabilities: ['draft', 'review'],
      protocolVersion: PEER_MANIFEST_VERSION,
    })
    await a.close()
  })
})

describe('createPeerManifestFederation (Phase 18 A-M2)', () => {
  type Row = { peerId: string; label: string | null; connected: boolean }

  function manifestLink(manifest: PeerManifest | null): HubLink {
    return { status: 'open', rpc: async () => manifest } as unknown as HubLink
  }
  function throwingLink(): HubLink {
    return {
      status: 'open',
      rpc: async () => {
        throw new Error('link rpc boom')
      },
    } as unknown as HubLink
  }

  /** Stub registry whose rows are mutable so a test can flip connectivity. */
  function stub(rows: Row[], links: Record<string, HubLink | null>): ManifestPeerRegistryView {
    return {
      status: () => rows,
      linkForHub: (peerId) => links[peerId] ?? null,
    }
  }

  const manifest = (caps: string[]): PeerManifest => ({
    hubId: 'hub_x',
    capabilities: caps,
    protocolVersion: '1',
  })

  it('lists every peer as unknown before any refresh', async () => {
    const fed = createPeerManifestFederation(
      stub([{ peerId: 'p1', label: 'Partner', connected: true }], {}),
    )
    const rows = await fed.list()
    expect(rows).toEqual([
      { peer: 'p1', label: 'Partner', online: true, stale: false, capabilities: [], lastFetchedAt: null },
    ])
  })

  it('refresh fetches connected peers and caches caps + timestamp', async () => {
    const fed = createPeerManifestFederation(
      stub([{ peerId: 'p1', label: null, connected: true }], { p1: manifestLink(manifest(['a', 'b'])) }),
      { now: () => 1000 },
    )
    await fed.refresh()
    const rows = await fed.list()
    expect(rows[0]).toEqual({
      peer: 'p1',
      label: null,
      online: true,
      stale: false,
      capabilities: ['a', 'b'],
      lastFetchedAt: 1000,
    })
  })

  it('skips offline peers on refresh (no link, no cache)', async () => {
    const fed = createPeerManifestFederation(
      stub([{ peerId: 'p1', label: null, connected: false }], { p1: manifestLink(manifest(['a'])) }),
    )
    await fed.refresh()
    expect((await fed.list())[0]!.capabilities).toEqual([])
  })

  it('marks a peer stale once it goes offline but keeps its cached caps', async () => {
    const rows: Row[] = [{ peerId: 'p1', label: null, connected: true }]
    const fed = createPeerManifestFederation(stub(rows, { p1: manifestLink(manifest(['a'])) }), {
      now: () => 1000,
    })
    await fed.refresh()
    rows[0]!.connected = false // the peer disconnected since the fetch
    const row = (await fed.list())[0]!
    expect(row.online).toBe(false)
    expect(row.stale).toBe(true)
    expect(row.capabilities).toEqual(['a']) // last-known caps retained
    expect(row.lastFetchedAt).toBe(1000)
  })

  it('refresh(peerId) only refetches the named peer', async () => {
    const seen: string[] = []
    const linkFor = (id: string, caps: string[]): HubLink =>
      ({
        status: 'open',
        rpc: async () => {
          seen.push(id)
          return manifest(caps)
        },
      }) as unknown as HubLink
    const fed = createPeerManifestFederation(
      stub(
        [
          { peerId: 'p1', label: null, connected: true },
          { peerId: 'p2', label: null, connected: true },
        ],
        { p1: linkFor('p1', ['a']), p2: linkFor('p2', ['b']) },
      ),
    )
    await fed.refresh('p2')
    expect(seen).toEqual(['p2'])
    const rows = await fed.list()
    expect(rows.find((r) => r.peer === 'p1')!.capabilities).toEqual([])
    expect(rows.find((r) => r.peer === 'p2')!.capabilities).toEqual(['b'])
  })

  it('keeps the prior cache when a refresh fetch throws', async () => {
    const links: Record<string, HubLink | null> = { p1: manifestLink(manifest(['a'])) }
    const fed = createPeerManifestFederation(stub([{ peerId: 'p1', label: null, connected: true }], links), {
      now: () => 1000,
    })
    await fed.refresh() // caches ['a']
    links.p1 = throwingLink() // next fetch fails
    await fed.refresh()
    expect((await fed.list())[0]!.capabilities).toEqual(['a']) // unchanged, not blanked
  })
})
