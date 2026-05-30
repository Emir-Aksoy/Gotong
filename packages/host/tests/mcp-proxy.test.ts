/**
 * Cross-hub MCP proxy — provider side (#2-M3.2).
 *
 * McpProxyHost.respond answers the two wire methods against the hub
 * registry, enforcing the `shared` ACL on every call. A stub toolset is
 * injected so the test never spawns a real MCP subprocess — the unit
 * under test is the ACL + dispatch + cache, not McpToolset itself.
 */

import { describe, expect, it } from 'vitest'

import { createInprocHubLinkPair, type HubLink, type HubMcpServerRecord } from '@aipehub/core'

import {
  McpProxyHost,
  MCP_PROXY_METHODS,
  RemoteMcpToolset,
  parseRemoteMcpRef,
  fetchPeerSharedMcp,
  type ProxyToolset,
} from '../src/mcp-proxy.js'

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
const sharedDocs: HubMcpServerRecord = {
  spec: { name: 'docs', transport: 'http', url: 'https://internal.example/mcp' },
  createdAt: '2026-05-30T00:00:00.000Z',
  description: 'company docs search',
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

describe('McpProxyHost.listShared (#2-M3.4b)', () => {
  it('returns only shared servers, name + description', async () => {
    const { proxy } = setup([sharedFs, sharedDocs, privateSrv])
    const out = (await proxy.respond({
      method: MCP_PROXY_METHODS.listShared,
      params: {},
    })) as Array<{ name: string; description?: string }>
    expect(out).toEqual([
      { name: 'fs' },
      { name: 'docs', description: 'company docs search' },
    ])
  })

  it('never leaks the spec (no command / url / env crosses)', async () => {
    const { proxy } = setup([sharedDocs])
    const out = (await proxy.respond({
      method: MCP_PROXY_METHODS.listShared,
      params: {},
    })) as Array<Record<string, unknown>>
    expect(out[0]).not.toHaveProperty('spec')
    expect(JSON.stringify(out)).not.toContain('internal.example')
  })

  it('returns [] when nothing is shared, builds no toolset', async () => {
    const { proxy, factoryCalls } = setup([privateSrv])
    expect(await proxy.respond({ method: MCP_PROXY_METHODS.listShared, params: {} })).toEqual([])
    expect(factoryCalls()).toBe(0)
  })
})

describe('parseRemoteMcpRef (#2-M3.3)', () => {
  it('splits a <peer>:<server> ref', () => {
    expect(parseRemoteMcpRef('hub_a1b2c3d4:filesystem')).toEqual({
      peer: 'hub_a1b2c3d4',
      server: 'filesystem',
    })
  })
  it('returns null for a bare (local) name', () => {
    expect(parseRemoteMcpRef('filesystem')).toBeNull()
  })
  it('returns null when either side is empty', () => {
    expect(parseRemoteMcpRef(':filesystem')).toBeNull()
    expect(parseRemoteMcpRef('hub_x:')).toBeNull()
  })
  it('splits on the FIRST colon only', () => {
    expect(parseRemoteMcpRef('hub_x:a:b')).toEqual({ peer: 'hub_x', server: 'a:b' })
  })
})

describe('RemoteMcpToolset (#2-M3.3, consumer)', () => {
  // A fake HubLink exposing only what RemoteMcpToolset touches (status + rpc).
  function fakeLink(opts: {
    status?: 'open' | 'closed'
    rpc?: (method: string, params: unknown) => Promise<unknown>
  }): HubLink {
    return {
      status: opts.status ?? 'open',
      rpc: opts.rpc ?? (async () => null),
    } as unknown as HubLink
  }

  it('listTools forwards over the link and returns the tools', async () => {
    const seen: Array<{ method: string; params: unknown }> = []
    const link = fakeLink({
      rpc: async (method, params) => {
        seen.push({ method, params })
        return [{ name: 'fs__read', description: 'r', inputSchema: { type: 'object' } }]
      },
    })
    const ts = new RemoteMcpToolset({ peer: 'hub_x', server: 'fs', resolveLink: () => link })
    const tools = await ts.listTools()
    expect(tools[0]!.name).toBe('fs__read')
    expect(seen).toEqual([{ method: MCP_PROXY_METHODS.listTools, params: { server: 'fs' } }])
  })

  it('callTool forwards name + args and returns the result', async () => {
    const seen: Array<{ method: string; params: unknown }> = []
    const link = fakeLink({
      rpc: async (method, params) => {
        seen.push({ method, params })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const ts = new RemoteMcpToolset({ peer: 'hub_x', server: 'fs', resolveLink: () => link })
    const out = await ts.callTool('fs__read', { path: 'x' })
    expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(seen[0]).toEqual({
      method: MCP_PROXY_METHODS.callTool,
      params: { server: 'fs', name: 'fs__read', args: { path: 'x' } },
    })
  })

  it('listTools returns [] when the peer link is absent', async () => {
    const ts = new RemoteMcpToolset({ peer: 'hub_x', server: 'fs', resolveLink: () => null })
    expect(await ts.listTools()).toEqual([])
  })

  it('listTools returns [] when the peer link is not open', async () => {
    const ts = new RemoteMcpToolset({
      peer: 'hub_x',
      server: 'fs',
      resolveLink: () => fakeLink({ status: 'closed' }),
    })
    expect(await ts.listTools()).toEqual([])
  })

  it('callTool returns an isError result when the peer is offline', async () => {
    const ts = new RemoteMcpToolset({ peer: 'hub_x', server: 'fs', resolveLink: () => null })
    const out = await ts.callTool('fs__read', {})
    expect(out.isError).toBe(true)
    expect(String((out.content as Array<{ text?: string }>)[0]?.text)).toMatch(/offline/)
  })

  it('callTool returns an isError result when the remote rpc rejects', async () => {
    const ts = new RemoteMcpToolset({
      peer: 'hub_x',
      server: 'fs',
      resolveLink: () => fakeLink({ rpc: async () => { throw new Error('not shared') } }),
    })
    const out = await ts.callTool('fs__read', {})
    expect(out.isError).toBe(true)
    expect(String((out.content as Array<{ text?: string }>)[0]?.text)).toMatch(/not shared/)
  })
})

describe('fetchPeerSharedMcp (#2-M3.4b, consumer)', () => {
  it('forwards the listShared rpc and returns the list', async () => {
    const seen: Array<{ method: string; params: unknown }> = []
    const link = {
      status: 'open' as const,
      rpc: async (method: string, params: unknown) => {
        seen.push({ method, params })
        return [{ name: 'fs' }, { name: 'docs', description: 'd' }]
      },
    } as unknown as HubLink
    const out = await fetchPeerSharedMcp(link)
    expect(out).toEqual([{ name: 'fs' }, { name: 'docs', description: 'd' }])
    expect(seen).toEqual([{ method: MCP_PROXY_METHODS.listShared, params: {} }])
  })

  it('returns [] when the peer answers null', async () => {
    const link = { status: 'open', rpc: async () => null } as unknown as HubLink
    expect(await fetchPeerSharedMcp(link)).toEqual([])
  })
})

describe('cross-hub MCP proxy — end to end (#2-M3.3)', () => {
  // Consumer RemoteMcpToolset → inproc HubLink → provider McpProxyHost →
  // (stub) local toolset → back. The whole proxy, no mocks on the seam.
  function wire(records: HubMcpServerRecord[], server = 'fs') {
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'provider', bPeerId: 'consumer' })
    const proxy = new McpProxyHost({
      space: { mcpServers: async () => records },
      secrets: () => undefined,
      toolsetFactory: () => ({
        async connect() {},
        async disconnect() {},
        listTools() {
          return [{ name: 'fs__read', description: 'read', inputSchema: { type: 'object' as const } }]
        },
        async callTool(name: string, args: Record<string, unknown>) {
          return { content: [{ type: 'text', text: `${name}(${JSON.stringify(args)})` }] }
        },
      }),
    })
    // Provider answers rpc on its link end; consumer uses the other end.
    a.on('rpc', proxy.respond)
    const remote = new RemoteMcpToolset({ peer: 'provider', server, resolveLink: () => b })
    return { remote, close: () => Promise.all([a.close(), proxy.close()]) }
  }

  it('lists + calls a shared peer server through the live link', async () => {
    const { remote, close } = wire([sharedFs])
    const tools = await remote.listTools()
    expect(tools[0]!.name).toBe('fs__read')
    const out = await remote.callTool('fs__read', { path: 'README.md' })
    expect((out.content as Array<{ text: string }>)[0]!.text).toBe('fs__read({"path":"README.md"})')
    await close()
  })

  it('a non-shared server surfaces the ACL rejection to the consumer', async () => {
    const { remote, close } = wire([privateSrv], 'private')
    // listTools degrades to [] (peer rejected); callTool surfaces isError.
    expect(await remote.listTools()).toEqual([])
    const out = await remote.callTool('private__x', {})
    expect(out.isError).toBe(true)
    expect(String((out.content as Array<{ text?: string }>)[0]?.text)).toMatch(/not shared/)
    await close()
  })

  it('discovers a peer\'s shared servers over the live link (#2-M3.4b)', async () => {
    const { a, b } = createInprocHubLinkPair({ aPeerId: 'provider', bPeerId: 'consumer' })
    const proxy = new McpProxyHost({
      space: { mcpServers: async () => [sharedFs, sharedDocs, privateSrv] },
      secrets: () => undefined,
    })
    a.on('rpc', proxy.respond)
    const shared = await fetchPeerSharedMcp(b)
    expect(shared).toEqual([{ name: 'fs' }, { name: 'docs', description: 'company docs search' }])
    await Promise.all([a.close(), proxy.close()])
  })
})
