/**
 * Cross-hub MCP federation (代理转发) — two hubs in one process.
 *
 * Run with: pnpm --filter @gotong/example-cross-hub-mcp start
 * (build workspace deps first — see ../README.md)
 *
 * The story: hub A owns an MCP server ("calc") and shares it with peers.
 * An agent on hub B calls that server's tools over the federation link —
 * the tool's subprocess + credentials never leave A ("凭证各归各家"). B
 * only ever sees the tool's NAME and RESULT.
 *
 *   hub-b / mathbot (LlmAgent tool-use loop)
 *     → RemoteMcpToolset.listTools / callTool
 *       → federation link rpc (mcp.listTools / mcp.callTool)
 *         → hub-a McpProxyHost  (ACL: shared===true, every call)
 *           → hub-a local calc toolset = real impl + real creds
 *           ← result travels back; spec/creds never cross
 *
 * Three acts: (1) B discovers what A shares — the same call that backs the
 * admin browse-UI; (2) an agent on B calls hub-a:calc through the link;
 * (3) A un-shares calc and the next remote call is refused mid-flight.
 *
 * The proxy classes (McpProxyHost / RemoteMcpToolset / fetchPeerSharedMcp)
 * are the REAL host implementation, imported via `@gotong/host/mcp-proxy`
 * — no reimplementation, no drift.
 */

import {
  Hub,
  createInprocHubLinkPair,
  type HubMcpServerRecord,
} from '@gotong/core'
import {
  LlmAgent,
  MockLlmProvider,
  type LlmToolCallResult,
  type LlmToolDefinition,
} from '@gotong/llm'
import {
  McpProxyHost,
  RemoteMcpToolset,
  fetchPeerSharedMcp,
  type ProxyToolset,
} from '@gotong/host/mcp-proxy'

// ---------------------------------------------------------------------------
// Hub A's "calc" MCP server. Stands in for a REAL MCP server (filesystem,
// internal database, a paid API…). In production McpProxyHost builds this
// from the registry spec via `McpToolset`, spawning a subprocess / opening
// an http client using A's own credentials. We inline a pure-JS adder so the
// demo needs no external process, no network, and no API keys — but the
// boundary it illustrates is identical: this code only ever runs on hub A.
// ---------------------------------------------------------------------------

function calcToolset(): ProxyToolset {
  return {
    async connect() {},
    async disconnect() {},
    listTools(): LlmToolDefinition[] {
      return [
        {
          name: 'calc__add',
          description: 'Add two numbers a + b',
          inputSchema: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b'],
          },
        },
      ]
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
      if (name !== 'calc__add') {
        return { content: [{ type: 'text', text: `unknown tool '${name}'` }], isError: true }
      }
      const sum = Number(args.a) + Number(args.b)
      console.log(`   [hub-a/calc] computed ${args.a} + ${args.b} = ${sum}  ← runs on HUB A`)
      return { content: [{ type: 'text', text: String(sum) }] }
    },
  }
}

async function main(): Promise<void> {
  banner('Cross-hub MCP federation (代理转发)')

  // Hub A's registry: one shared MCP server. In a full host this is the
  // PERSISTED hub registry read via `space.mcpServers()`; here a mutable
  // array so Act 3 can un-share it live and you can watch the ACL react.
  const aRegistry: HubMcpServerRecord[] = [
    {
      spec: { name: 'calc', command: 'npx', args: ['-y', '@example/mcp-calc'] },
      description: 'arithmetic over the federation',
      createdAt: '2026-05-30T00:00:00.000Z',
      shared: true,
    },
  ]

  // Hub A's proxy: answers peer rpc, re-checks the `shared` ACL on EVERY
  // call, and expands `${ENV}` credentials LOCALLY (here: none). Nothing
  // about the spec — command, url, env — ever crosses the link.
  const proxy = new McpProxyHost({
    space: { mcpServers: async () => aRegistry },
    secrets: () => undefined,
    toolsetFactory: () => calcToolset(),
  })

  // The federation boundary: one inproc link. A answers rpc on its end;
  // B holds the other end. (In production this link is a WebSocket peer
  // connection wired by the peer registry — the rpc seam is identical.)
  const { a: providerLink, b: consumerLink } = createInprocHubLinkPair({
    aPeerId: 'hub-b', // a's view of its peer (B)
    bPeerId: 'hub-a', // b's view of its peer (A) — the id B references as `hub-a:calc`
  })
  providerLink.on('rpc', proxy.respond)
  console.log('[hub-a] shares MCP server "calc"; proxy listening on the federation link')

  // Hub B (consumer): a real hub running a real agent.
  const bHub = Hub.inMemory()
  await bHub.start()
  console.log('[hub-b] hub started\n')

  // ─── Act 1 — discovery (exactly what the admin browse-UI calls) ──────────
  banner('1. Hub B discovers what Hub A shares')
  const shared = await fetchPeerSharedMcp(consumerLink)
  for (const s of shared) {
    console.log(`   hub-a shares: ${s.name}${s.description ? ` — ${s.description}` : ''}`)
  }
  console.log('   ↳ an admin on B would pick `hub-a:calc` from this list in the agent form.\n')

  // ─── Act 2 — an agent on B calls the remote tool through the link ────────
  banner('2. An agent on Hub B calls hub-a:calc')
  // The agent's `useMcpServers` would carry the ref "hub-a:calc"; the host
  // turns that into this RemoteMcpToolset. Here we build it directly.
  const remoteCalc = new RemoteMcpToolset({
    peer: 'hub-a',
    server: 'calc',
    resolveLink: () => consumerLink,
  })
  // Mock LLM scripted to (round 1) call calc__add, then (round 2) answer.
  // Swap MockLlmProvider for AnthropicProvider / OpenAIProvider and the
  // model picks the tool on its own — the federation plumbing is unchanged.
  const provider = new MockLlmProvider({
    script: [
      {
        kind: 'tool_use',
        text: 'Let me add those on the shared calculator.',
        toolUses: [{ type: 'tool_use', id: 't1', name: 'calc__add', input: { a: 21, b: 21 } }],
      },
      { kind: 'text', text: 'The sum is 42 — computed on hub-a, over the federation link.' },
    ],
    reply: '(fallback)',
  })
  const agent = new LlmAgent({
    id: 'mathbot',
    capabilities: ['math'],
    provider,
    tools: remoteCalc,
    system: 'Use calc__add for arithmetic.',
    maxToolRounds: 3,
  })
  bHub.register(agent)
  console.log('[hub-b] registered agent "mathbot" (tools: hub-a:calc)\n')

  const res = await bHub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['math'] },
    payload: 'What is 21 + 21?',
  })
  if (res.kind !== 'ok') {
    console.error('  ✖ agent task failed:', JSON.stringify(res, null, 2))
    await teardown(bHub, providerLink, proxy)
    process.exit(1)
  }
  const out = res.output as { text: string; toolRounds?: number }
  console.log(`   [hub-b/mathbot] answered after ${out.toolRounds ?? 0} tool round(s):`)
  console.log(`   "${out.text}"`)
  console.log('   ↳ the calc subprocess + any credentials never left hub-a (凭证各归各家).\n')

  // ─── Act 3 — per-call ACL: un-share on A → the next call is refused ──────
  banner('3. Hub A un-shares calc → the next remote call is refused')
  aRegistry[0]!.shared = false
  console.log('[hub-a] set calc.shared = false (no redeploy, no reconnect)')
  const afterTools = await remoteCalc.listTools()
  console.log(`   hub-b listTools(hub-a:calc) now returns ${afterTools.length} tool(s)  (degrades to [])`)
  const afterCall = await remoteCalc.callTool('calc__add', { a: 1, b: 2 })
  console.log(`   hub-b callTool → isError=${afterCall.isError === true}, msg="${textOf(afterCall)}"`)
  const sharedAfter = await fetchPeerSharedMcp(consumerLink)
  console.log(`   hub-a discovery now lists ${sharedAfter.length} shared server(s)\n`)

  banner('Demo complete')
  await teardown(bHub, providerLink, proxy)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textOf(result: LlmToolCallResult): string {
  const first = result.content[0] as { text?: string } | undefined
  return first?.text ?? ''
}

async function teardown(
  bHub: Hub,
  providerLink: { close(): Promise<void> },
  proxy: McpProxyHost,
): Promise<void> {
  await bHub.stop()
  await Promise.all([providerLink.close(), proxy.close()])
}

function banner(text: string): void {
  const line = '═'.repeat([...text].length + 4)
  console.log(line)
  console.log(`  ${text}  `)
  console.log(line)
}

main().catch((err) => {
  console.error('[demo] fatal:', err)
  process.exit(1)
})
