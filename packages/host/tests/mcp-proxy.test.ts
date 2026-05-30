/**
 * Cross-hub MCP proxy — provider side (#2-M3.2).
 *
 * McpProxyHost.respond answers the two wire methods against the hub
 * registry, enforcing the `shared` ACL on every call. A stub toolset is
 * injected so the test never spawns a real MCP subprocess — the unit
 * under test is the ACL + dispatch + cache, not McpToolset itself.
 */

import { describe, expect, it } from 'vitest'

import type { HubMcpServerRecord } from '@aipehub/core'

import { McpProxyHost, MCP_PROXY_METHODS, type ProxyToolset } from '../src/mcp-proxy.js'

function fakeToolset() {
  const calls = { connect: 0, disconnect: 0, listTools: 0, callTool: [] as Array<{ name: string; args: unknown }> }
  const ts: ProxyToolset & { calls: typeof calls } = {
    calls,
    async connect() { calls.connect++ },
    async disconnect() { calls.disconnect++ },
    listTools() {
      calls.listTools++
      return [{ name: 'fs__read', description: 'read a file', inputSchema: { type: 'object' as const } }]
    },
    async callTool(name: string, args: Record<string, unknown>) {
      calls.callTool.push({ name, args })
      return { content: [{ type: 'text', text: `called ${name}` }] }
    },
  }
  return ts
}

function setup(records: HubMcpServerRecord[]) {
  const made: Array<ReturnType<typeof fakeToolset>> = []
  let factoryCalls = 0
  const proxy = new McpProxyHost({
    space: { mcpServers: async () => records },
    secrets: () => undefined,
    toolsetFactory: () => {
      factoryCalls++
      const ts = fakeToolset()
      made.push(ts)
      return ts
    },
  })
  return { proxy, made, factoryCalls: () => factoryCalls }
}

const sharedFs: HubMcpServerRecord = {
  spec: { name: 'fs', command: 'npx', args: ['-y', 'srv'] },
  createdAt: '2026-05-30T00:00:00.000Z',
  shared: true,
}
const privateSrv: HubMcpServerRecord = {
  spec: { name: 'private', command: 'npx' },
  createdAt: '2026-05-30T00:00:00.000Z',
  // no `shared` → local-only
}

describe('McpProxyHost (#2-M3.2)', () => {
  it('listTools returns the shared server tools', async () => {
    const { proxy } = setup([sharedFs])
    const tools = await proxy.respond({ method: MCP_PROXY_METHODS.listTools, params: { server: 'fs' } })
    expect(Array.isArray(tools)).toBe(true)
    expect((tools as Array<{ name: string }>)[0]!.name).toBe('fs__read')
  })

  it('callTool forwards name + args and returns the result', async () => {
    const { proxy, made } = setup([sharedFs])
    const out = await proxy.respond({
      method: MCP_PROXY_METHODS.callTool,
      params: { server: 'fs', name: 'fs__read', args: { path: 'README.md' } },
    })
    expect(out).toEqual({ content: [{ type: 'text', text: 'called fs__read' }] })
    expect(made[0]!.calls.callTool).toEqual([{ name: 'fs__read', args: { path: 'README.md' } }])
  })

  it('rejects a server that is not shared (ACL)', async () => {
    const { proxy, factoryCalls } = setup([privateSrv])
    await expect(
      proxy.respond({ method: MCP_PROXY_METHODS.listTools, params: { server: 'private' } }),
    ).rejects.toThrow(/not shared/)
    expect(factoryCalls()).toBe(0) // never even built a toolset
  })

  it('rejects an unknown server', async () => {
    const { proxy } = setup([sharedFs])
    await expect(
      proxy.respond({ method: MCP_PROXY_METHODS.listTools, params: { server: 'ghost' } }),
    ).rejects.toThrow(/not found/)
  })

  it('rejects an unknown method', async () => {
    const { proxy } = setup([sharedFs])
    await expect(proxy.respond({ method: 'mcp.deleteEverything', params: {} })).rejects.toThrow(
      /unknown mcp proxy method/,
    )
  })

  it('rejects callTool without a tool name', async () => {
    const { proxy } = setup([sharedFs])
    await expect(
      proxy.respond({ method: MCP_PROXY_METHODS.callTool, params: { server: 'fs' } }),
    ).rejects.toThrow(/requires a tool name/)
  })

  it('caches the toolset across calls (one connect per server)', async () => {
    const { proxy, made, factoryCalls } = setup([sharedFs])
    await proxy.respond({ method: MCP_PROXY_METHODS.listTools, params: { server: 'fs' } })
    await proxy.respond({ method: MCP_PROXY_METHODS.callTool, params: { server: 'fs', name: 'fs__read' } })
    expect(factoryCalls()).toBe(1)
    expect(made[0]!.calls.connect).toBe(1)
  })

  it('evicts + disconnects a cached toolset when the server is un-shared', async () => {
    const records = [{ ...sharedFs }]
    const { proxy, made } = setup(records)
    await proxy.respond({ method: MCP_PROXY_METHODS.listTools, params: { server: 'fs' } })
    expect(made[0]!.calls.disconnect).toBe(0)
    // Un-share it; the next call must re-check the ACL, reject, and drop
    // the live connection.
    records[0]!.shared = false
    await expect(
      proxy.respond({ method: MCP_PROXY_METHODS.listTools, params: { server: 'fs' } }),
    ).rejects.toThrow(/not shared/)
    expect(made[0]!.calls.disconnect).toBe(1)
  })

  it('close() disconnects every cached toolset', async () => {
    const { proxy, made } = setup([sharedFs])
    await proxy.respond({ method: MCP_PROXY_METHODS.listTools, params: { server: 'fs' } })
    await proxy.close()
    expect(made[0]!.calls.disconnect).toBe(1)
  })
})
