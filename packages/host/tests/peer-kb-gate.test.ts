/**
 * v5 C-M1 — unit tests for the pure callable-knowledge-base gate.
 *
 * The gate wraps a shared rpcResponder so a peer only discovers + calls the
 * shared MCP servers (KBs) named in its allowlist. These tests pin the three
 * behaviours that matter: listShared is FILTERED (the peer never learns the
 * off-list servers exist), listTools/callTool are DENIED off-list (fail-closed
 * backstop), and every other method passes through untouched.
 */

import { describe, expect, it, vi } from 'vitest'

import { gateKnowledgeBaseRpc } from '../src/peer-kb-gate.js'
import { MCP_PROXY_METHODS } from '../src/mcp-proxy.js'

/** A stand-in shared responder: listShared returns three servers; the call
 *  methods echo their server so a passthrough is observable. */
const innerResponder = async (call: { method: string; params: unknown }) => {
  switch (call.method) {
    case MCP_PROXY_METHODS.listShared:
      return [
        { name: 'kb-a', description: 'alpha' },
        { name: 'kb-b' },
        { name: 'kb-c', description: 'gamma' },
      ]
    case MCP_PROXY_METHODS.listTools:
      return { tools: [`tools-of-${(call.params as { server: string }).server}`] }
    case MCP_PROXY_METHODS.callTool:
      return { ok: true, server: (call.params as { server: string }).server }
    case 'peer.manifest':
      return { hubId: 'hub_self', capabilities: ['chat'] }
    default:
      throw new Error(`inner: unknown method ${call.method}`)
  }
}

describe('gateKnowledgeBaseRpc — discovery filtering', () => {
  it('filters mcp.listShared to the allowlist (off-list servers are invisible)', async () => {
    const gated = gateKnowledgeBaseRpc(innerResponder, ['kb-a', 'kb-c'])
    const out = (await gated({ method: MCP_PROXY_METHODS.listShared, params: {} })) as Array<{ name: string }>
    expect(out.map((r) => r.name)).toEqual(['kb-a', 'kb-c'])
    // description carried through for the surviving rows
    expect(out.find((r) => r.name === 'kb-a')).toMatchObject({ description: 'alpha' })
  })

  it('[] lockdown → listShared returns nothing', async () => {
    const gated = gateKnowledgeBaseRpc(innerResponder, [])
    const out = (await gated({ method: MCP_PROXY_METHODS.listShared, params: {} })) as unknown[]
    expect(out).toEqual([])
  })

  it('non-array listShared result is returned as-is (defensive)', async () => {
    const weird = async () => ({ not: 'an array' })
    const gated = gateKnowledgeBaseRpc(weird, ['kb-a'])
    const out = await gated({ method: MCP_PROXY_METHODS.listShared, params: {} })
    expect(out).toEqual({ not: 'an array' })
  })
})

describe('gateKnowledgeBaseRpc — call enforcement', () => {
  it('passes listTools / callTool through when the server is on the allowlist', async () => {
    const gated = gateKnowledgeBaseRpc(innerResponder, ['kb-a'])
    expect(await gated({ method: MCP_PROXY_METHODS.listTools, params: { server: 'kb-a' } })).toEqual({
      tools: ['tools-of-kb-a'],
    })
    expect(
      await gated({ method: MCP_PROXY_METHODS.callTool, params: { server: 'kb-a', name: 't', args: {} } }),
    ).toEqual({ ok: true, server: 'kb-a' })
  })

  it('denies callTool on an off-list server (fail-closed throw, inner never called)', async () => {
    const inner = vi.fn(innerResponder)
    const gated = gateKnowledgeBaseRpc(inner, ['kb-a'])
    await expect(
      gated({ method: MCP_PROXY_METHODS.callTool, params: { server: 'kb-b', name: 't' } }),
    ).rejects.toThrow(/kb-b.*not callable/)
    expect(inner).not.toHaveBeenCalled()
  })

  it('denies listTools on an off-list server', async () => {
    const gated = gateKnowledgeBaseRpc(innerResponder, ['kb-a'])
    await expect(
      gated({ method: MCP_PROXY_METHODS.listTools, params: { server: 'kb-c' } }),
    ).rejects.toThrow(/kb-c.*not callable/)
  })

  it('[] lockdown → every callTool throws', async () => {
    const gated = gateKnowledgeBaseRpc(innerResponder, [])
    await expect(
      gated({ method: MCP_PROXY_METHODS.callTool, params: { server: 'kb-a', name: 't' } }),
    ).rejects.toThrow(/not callable/)
  })

  it('throws on a missing / non-string server param', async () => {
    const gated = gateKnowledgeBaseRpc(innerResponder, ['kb-a'])
    await expect(gated({ method: MCP_PROXY_METHODS.callTool, params: {} })).rejects.toThrow(/not callable/)
    await expect(gated({ method: MCP_PROXY_METHODS.callTool, params: null })).rejects.toThrow(/not callable/)
  })
})

describe('gateKnowledgeBaseRpc — passthrough', () => {
  it('forwards non-MCP methods untouched (peer.manifest)', async () => {
    const gated = gateKnowledgeBaseRpc(innerResponder, []) // even a hard lockdown
    expect(await gated({ method: 'peer.manifest', params: {} })).toEqual({
      hubId: 'hub_self',
      capabilities: ['chat'],
    })
  })
})
