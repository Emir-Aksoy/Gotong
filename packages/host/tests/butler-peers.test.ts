/**
 * NET-M1 承重门 — the butler's benign network eye (`list_peers`).
 *
 * The butler could see runs / helpers / usage (BE-M1) but was blind to the
 * mesh. This gate pins the projection's contract before NET-M2 builds the
 * outbound ACTION on the same surface:
 *
 *   1. sanitize red line — endpointUrl / token / ACL detail sneaked into a row
 *      (sloppy upstream) must NEVER reach the rendered text;
 *   2. outbound posture renders its REAL semantics (peer-acl + G-M1
 *      advertise=authorize) — null=未策展(routes nothing until curated) /
 *      []=锁死 / list=白名单 — never an invented fourth state;
 *   3. the surface join drops disabled / revoked edges (an edge the operator
 *      turned off must not be offered as reachable);
 *   4. absence is honest — no surface → no tool; empty roster / read failure →
 *      friendly text, never a crash.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerPeerSurface,
  buildButlerPeersToolset,
  type ButlerPeerRow,
  type ButlerPeerSurface,
} from '../src/personal-butler-peers.js'

const surfaceOf = (rows: ButlerPeerRow[]): ButlerPeerSurface => ({
  listForButler: async () => rows,
})

const textOf = (r: { content: Array<{ type: string; text?: string }> }): string =>
  r.content.map((c) => c.text ?? '').join('\n')

describe('NET-M1 — list_peers(管家网络眼睛)', () => {
  it('renders online/offline + the three outbound postures with real semantics', async () => {
    const toolset = buildButlerPeersToolset({
      peers: surfaceOf([
        { peerId: 'hub-dad', label: '爸爸的 hub', connected: true, lastSeenAt: 1, outboundCaps: null, trustTier: 'T2', pinned: true },
        { peerId: 'hub-office', label: null, connected: false, lastSeenAt: null, outboundCaps: ['research', 'translate'], trustTier: null, pinned: false },
        { peerId: 'hub-locked', label: '封存', connected: true, lastSeenAt: 2, outboundCaps: [], trustTier: 'T3', pinned: false },
      ]),
    })

    const out = textOf(await toolset.callTool('list_peers', {}))

    expect(out).toContain('互联的 hub(3 个)')
    expect(out).toContain('hub-dad(爸爸的 hub) — 在线')
    expect(out).toContain('出站未策展')                    // null → 广告为空,派不出;不是「未限制随便发」
    expect(out).toContain('hub-office — 离线')
    expect(out).toContain('可请求能力:research、translate') // 白名单如实列出
    expect(out).toContain('出站已锁死')                     // [] → lockdown
    // SEN-M2 — trust grade renders GT's real semantics per edge.
    expect(out).toContain('信任档 T2·已锚定签名公钥')       // graded + owner PIN fact
    expect(out).toContain('信任档未分级(按 T1 对待)')       // null → floor, never invented
    expect(out).toContain('信任档 T3')                      // graded, no PIN suffix
  })

  it('sanitize: sneaky endpoint/token fields on a row never reach the text', async () => {
    // A sloppy upstream could hand rows with extra fields — the renderer must
    // only read the declared shape. Cast simulates that structural leak.
    const dirty = [
      {
        peerId: 'hub-x',
        label: null,
        connected: true,
        lastSeenAt: null,
        outboundCaps: null,
        trustTier: null,
        pinned: false,
        endpointUrl: 'wss://secret-internal:7443',
        token: 'peer-token-abc123',
      } as unknown as ButlerPeerRow,
    ]
    const out = textOf(await buildButlerPeersToolset({ peers: surfaceOf(dirty) }).callTool('list_peers', {}))

    expect(out).toContain('hub-x')
    expect(out).not.toContain('secret-internal')
    expect(out).not.toContain('peer-token-abc123')
    expect(out).not.toContain('wss://')
  })

  it('empty roster → honest line; surface throw → friendly error, no crash', async () => {
    const empty = textOf(await buildButlerPeersToolset({ peers: surfaceOf([]) }).callTool('list_peers', {}))
    expect(empty).toContain('还没有互联任何对端 hub')

    const broken = buildButlerPeersToolset({
      peers: { listForButler: async () => { throw new Error('registry down') } },
    })
    const err = await broken.callTool('list_peers', {})
    expect(err.isError).toBe(true)
    expect(textOf(err)).toContain('暂时读不到')
  })

  it('unknown tool name → typed refusal', async () => {
    const r = await buildButlerPeersToolset({ peers: surfaceOf([]) }).callTool('rm_rf', {})
    expect(r.isError).toBe(true)
  })
})

describe('NET-M1 — buildButlerPeerSurface(host 侧拼接)', () => {
  const status = [
    { peerRowId: 'r1', peerId: 'hub-a', label: 'A', connected: true, lastSeenAt: 111 },
    { peerRowId: 'r2', peerId: 'hub-b', label: null, connected: false, lastSeenAt: null },
    { peerRowId: 'r3', peerId: 'hub-revoked', label: null, connected: false, lastSeenAt: null },
    { peerRowId: 'r4', peerId: 'hub-disabled', label: null, connected: false, lastSeenAt: null },
  ]
  const KID = 'x'.repeat(43) // RFC 7638 thumbprint shape (43 base64url chars)
  const rows = [
    { id: 'r1', enabled: true, revocationState: 'active', outboundCaps: ['chat'], trustTier: 'T2', pinnedKid: KID },
    { id: 'r2', enabled: true, revocationState: 'active', outboundCaps: null, trustTier: null, pinnedKid: null },
    { id: 'r3', enabled: true, revocationState: 'revoked', outboundCaps: null, trustTier: null, pinnedKid: null },
    { id: 'r4', enabled: false, revocationState: 'active', outboundCaps: null, trustTier: null, pinnedKid: null },
  ]

  it('joins live state with trust rows; drops revoked + disabled edges', async () => {
    const roster = await buildButlerPeerSurface({ status: () => status, rows: () => rows }).listForButler()

    expect(roster.map((r) => r.peerId)).toEqual(['hub-a', 'hub-b'])
    expect(roster[0]).toEqual({
      peerId: 'hub-a',
      label: 'A',
      connected: true,
      lastSeenAt: 111,
      outboundCaps: ['chat'],
      trustTier: 'T2',
      pinned: true,
    })
    expect(roster[1]!.outboundCaps).toBeNull()
    expect(roster[1]!.trustTier).toBeNull() // un-graded passes through as null (floor semantics live in the renderer)
  })

  it('SEN-M2 sanitize: pinnedKid folds to a boolean — the thumbprint never enters the projection or the text', async () => {
    const roster = await buildButlerPeerSurface({ status: () => status, rows: () => rows }).listForButler()
    expect(roster[0]!.pinned).toBe(true)
    expect(roster[1]!.pinned).toBe(false)
    // Structural red line: the projection row has no pinnedKid field at all.
    expect('pinnedKid' in roster[0]!).toBe(false)
    const out = textOf(await buildButlerPeersToolset({ peers: surfaceOf(roster) }).callTool('list_peers', {}))
    expect(out).toContain('已锚定签名公钥')
    expect(out).not.toContain(KID)
  })

  it('copies outboundCaps defensively — mutating the projection never touches the row', async () => {
    const roster = await buildButlerPeerSurface({ status: () => status, rows: () => rows }).listForButler()
    roster[0]!.outboundCaps!.push('hacked')
    expect(rows[0]!.outboundCaps).toEqual(['chat'])
  })

  it('a status row with no matching trust row is dropped (defensive join)', async () => {
    const roster = await buildButlerPeerSurface({
      status: () => [{ peerRowId: 'ghost', peerId: 'hub-ghost', label: null, connected: true, lastSeenAt: null }],
      rows: () => [],
    }).listForButler()
    expect(roster).toEqual([])
  })
})
