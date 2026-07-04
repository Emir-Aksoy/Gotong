/**
 * v5 C-M1 — callable-knowledge-base isolation acceptance gate.
 *
 * Same north-star as the P4 isolation gate ("a hub network is a free graph,
 * not a hierarchy tree — restricting one peer must never bleed onto another"),
 * but for the KB dimension. The shared MCP servers (knowledge bases) a peer may
 * DISCOVER + CALL cross the link as `mcp.listShared` / `mcp.callTool` rpc, NOT
 * as `hub.dispatch` — so this pins the rpc-responder seam, the way the dispatch
 * seam is pinned in peer-isolation-e2e.test.ts.
 *
 * One home hub shares two KBs (`kb-a`, `kb-b`) behind a single peer-agnostic
 * responder (the real `McpProxyHost.respond` shape). Two peers connect over
 * inproc link pairs, each threading its own contract from a real identity row
 * the SAME way `PeerRegistry.kbGatedResponder` does:
 *
 *   - orgX is clamped to `allowedKnowledgeBases: ['kb-a']`.
 *   - orgY is unrestricted (null row → legacy, all callable).
 *
 * We then prove the orgX clamp leaves orgY untouched:
 *   1. orgX's `mcp.listShared` shows ONLY kb-a; orgY's shows both.
 *   2. orgX may `mcp.callTool` on kb-a but is DENIED kb-b; orgY calls both.
 *
 * The gate itself is unit-tested in peer-kb-gate.test.ts; what THIS pins is the
 * host bridge — identity row → per-link responder threading → independent
 * verdicts — plus the isolation guarantee no single-edge test can show.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, createInprocHubLinkPair, installPeerLink } from '@gotong/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
  type PeerRegistration,
} from '@gotong/identity'

import { gateKnowledgeBaseRpc, type RpcResponder } from '../src/peer-kb-gate.js'
import { MCP_PROXY_METHODS } from '../src/mcp-proxy.js'

/**
 * The single shared, peer-AGNOSTIC responder — the McpProxyHost.respond shape.
 * It serves both shared KBs to anyone; the per-link gate is the only thing that
 * narrows it. (`callTool` would normally re-check `shared`; here both are shared
 * so it just echoes, isolating the test to the GATE's behaviour.)
 */
const sharedResponder: RpcResponder = async (call) => {
  switch (call.method) {
    case MCP_PROXY_METHODS.listShared:
      return [
        { name: 'kb-a', description: 'A' },
        { name: 'kb-b', description: 'B' },
      ]
    case MCP_PROXY_METHODS.callTool:
      return { ok: true, server: (call.params as { server: string }).server }
    default:
      throw new Error(`shared: unknown method ${call.method}`)
  }
}

/** Thread a peer row into the rpc responder the verbatim PeerRegistry way. */
function rpcOptsFromRow(row: PeerRegistration): { rpcResponder: RpcResponder } {
  if (!row.allowedKnowledgeBases) return { rpcResponder: sharedResponder }
  return { rpcResponder: gateKnowledgeBaseRpc(sharedResponder, row.allowedKnowledgeBases) }
}

describe('v5 C-M1 — callable-KB contracts are isolated across peers', () => {
  let store: IdentityStore
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-peer-kb-iso-'))
    store = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
  })
  afterEach(async () => {
    store.close()
    await rm(tmp, { recursive: true, force: true })
  })

  it('clamping orgX to [kb-a] leaves orgY (unrestricted) seeing + calling both', async () => {
    // orgX — clamped to kb-a only.
    store.addPeer({
      peerId: 'orgX',
      endpointUrl: 'wss://x.example',
      peerToken: 'tok-orgx-12345678',
      kind: 'organization',
      allowedKnowledgeBases: ['kb-a'],
    })
    // orgY — wide open (no KB clamp); the legacy all-callable peer.
    store.addPeer({
      peerId: 'orgY',
      endpointUrl: 'wss://y.example',
      peerToken: 'tok-orgy-12345678',
      kind: 'organization',
    })
    const rowX = store.getPeerByPeerId('orgX')!
    const rowY = store.getPeerByPeerId('orgY')!

    const home = Hub.inMemory()
    await home.start()

    // home ←→ orgX and home ←→ orgY inproc pairs. The home side (a) installs
    // the per-link responder; the peer side (b) drives rpc against it.
    const pairX = createInprocHubLinkPair({ aPeerId: 'orgX', bPeerId: 'orgHome' })
    const pairY = createInprocHubLinkPair({ aPeerId: 'orgY', bPeerId: 'orgHome' })

    installPeerLink({ hub: home, link: pairX.a, selfHubId: 'orgHome', ...rpcOptsFromRow(rowX) })
    installPeerLink({ hub: home, link: pairY.a, selfHubId: 'orgHome', ...rpcOptsFromRow(rowY) })

    // --- (1) DISCOVERY isolation ---------------------------------------------
    const xShared = (await pairX.b.rpc(MCP_PROXY_METHODS.listShared, {})) as Array<{ name: string }>
    expect(xShared.map((r) => r.name)).toEqual(['kb-a']) // orgX never learns kb-b exists

    const yShared = (await pairY.b.rpc(MCP_PROXY_METHODS.listShared, {})) as Array<{ name: string }>
    expect(yShared.map((r) => r.name).sort()).toEqual(['kb-a', 'kb-b']) // orgY sees both

    // --- (2) CALL isolation ---------------------------------------------------
    // orgX may call kb-a...
    expect(await pairX.b.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-a', name: 'q', args: {} })).toEqual({
      ok: true,
      server: 'kb-a',
    })
    // ...but is fail-closed on kb-b (the off-list server).
    await expect(
      pairX.b.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-b', name: 'q', args: {} }),
    ).rejects.toThrow(/kb-b.*not callable/)

    // orgY, unrestricted, calls BOTH — proving the orgX clamp never touched it.
    expect(await pairY.b.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-a', name: 'q', args: {} })).toEqual({
      ok: true,
      server: 'kb-a',
    })
    expect(await pairY.b.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-b', name: 'q', args: {} })).toEqual({
      ok: true,
      server: 'kb-b',
    })

    await home.stop()
  })

  it('[] lockdown denies a peer every KB while a sibling stays open', async () => {
    store.addPeer({
      peerId: 'orgLock',
      endpointUrl: 'wss://lock.example',
      peerToken: 'tok-lock-12345678',
      kind: 'organization',
      allowedKnowledgeBases: [], // hard lockdown
    })
    store.addPeer({
      peerId: 'orgOpen',
      endpointUrl: 'wss://open.example',
      peerToken: 'tok-open-12345678',
      kind: 'organization',
    })
    const rowLock = store.getPeerByPeerId('orgLock')!
    const rowOpen = store.getPeerByPeerId('orgOpen')!

    const home = Hub.inMemory()
    await home.start()
    const pairLock = createInprocHubLinkPair({ aPeerId: 'orgLock', bPeerId: 'orgHome' })
    const pairOpen = createInprocHubLinkPair({ aPeerId: 'orgOpen', bPeerId: 'orgHome' })
    installPeerLink({ hub: home, link: pairLock.a, selfHubId: 'orgHome', ...rpcOptsFromRow(rowLock) })
    installPeerLink({ hub: home, link: pairOpen.a, selfHubId: 'orgHome', ...rpcOptsFromRow(rowOpen) })

    // Locked peer discovers nothing and can call nothing.
    expect(await pairLock.b.rpc(MCP_PROXY_METHODS.listShared, {})).toEqual([])
    await expect(
      pairLock.b.rpc(MCP_PROXY_METHODS.callTool, { server: 'kb-a', name: 'q', args: {} }),
    ).rejects.toThrow(/not callable/)

    // The sibling is untouched.
    const openShared = (await pairOpen.b.rpc(MCP_PROXY_METHODS.listShared, {})) as Array<{ name: string }>
    expect(openShared.map((r) => r.name).sort()).toEqual(['kb-a', 'kb-b'])

    await home.stop()
  })
})
