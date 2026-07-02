/**
 * butler-diagnose — Track A BE-M2. The resident butler's BENIGN "check my agents
 * for problems" eye (`diagnose_my_agents`), plus the ONE boundary that keeps it
 * honest: which proposals it can offer to FIX itself vs. only advise on.
 *
 * The load-bearing properties, in isolation from the real RES engine (a fake
 * `ButlerAdaptationSource` hands the toolset crafted proposals so each branch is
 * exercised exactly):
 *
 *   1. 守边界 — the ONLY butler-enactable fix is `switch_provider` to a NATIVE
 *      provider (`applicable:true` on a switch). Crucially, a `use_local_endpoint`
 *      proposal is `applicable:true` TOO (RES-M3's admin panel can apply it), yet
 *      the butler must treat it as ADVISORY: a member can't wire an
 *      openai-compatible+baseURL agent by hand, so neither can the butler. This
 *      test pins that distinction — admin-applicable ≠ butler-enactable.
 *   2. The fix it names is the EXISTING governed `edit_agent`; it invents no verb.
 *   3. NO-LEAK — the toolset only ever passes ITS OWN member's id to `listOwned`.
 *   4. Fail-closed — a read fault reports the failure, never implies "all healthy".
 *
 * Deterministic: fake surfaces + direct `callTool`, no LLM, no clock. The
 * full-stack diagnose→edit_agent→approve→真改 loop is proven separately in
 * butler-diagnose-e2e.test.ts against the real engine + real HostMeAgentService.
 */

import { describe, expect, it } from 'vitest'

import {
  buildButlerDiagnoseToolset,
  type ButlerOwnedAgent,
  type ButlerOwnedAgentSource,
  type ButlerAdaptationSource,
} from '../src/personal-butler-diagnose.js'
import type { AdaptationProposal } from '../src/resource-adaptation.js'

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('')
}

/** A fake owned-agent lister that records every userId it was asked for. */
function fakeOwned(byUser: Record<string, ButlerOwnedAgent[]>): {
  surface: ButlerOwnedAgentSource
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    surface: {
      async listOwned(userId) {
        calls.push(userId)
        return byUser[userId] ?? []
      },
    },
  }
}

/** A fake adaptation engine that records the agents it was fed and returns a fixture. */
function fakeAdapt(proposals: AdaptationProposal[]): {
  surface: ButlerAdaptationSource
  fed: ButlerOwnedAgent[][]
} {
  const fed: ButlerOwnedAgent[][] = []
  return {
    fed,
    surface: {
      async propose({ agents }) {
        fed.push([...agents])
        return proposals
      },
    },
  }
}

// --- proposal fixtures, one per kind ---------------------------------------

const switchNative: AdaptationProposal = {
  kind: 'switch_provider',
  id: 'adapt:switch_provider:me.alice.x:anthropic',
  agentId: 'me.alice.x',
  fromProvider: 'deepseek',
  toProvider: 'anthropic',
  keySource: 'env',
  applicable: true, // native → butler-enactable
  title: '把「me.alice.x」切到已配好密钥的 anthropic',
  detail: 'deepseek 没有密钥，anthropic 已配好。',
}

const switchAdvisory: AdaptationProposal = {
  kind: 'switch_provider',
  id: 'adapt:switch_provider:me.alice.y:mimo',
  agentId: 'me.alice.y',
  fromProvider: 'openai',
  toProvider: 'mimo',
  keySource: 'vault',
  applicable: false, // openai-compatible target → needs baseURL → advisory
  title: '把「me.alice.y」切到已配好密钥的 mimo',
  detail: 'mimo 是 openai 兼容提供方，需要 baseURL。',
}

// The crux of 守边界: RES-M3's admin panel CAN apply this (applicable:true), but
// the butler must NOT — wiring an openai-compatible baseURL is operator infra.
const useLocal: AdaptationProposal = {
  kind: 'use_local_endpoint',
  id: 'adapt:use_local_endpoint:me.alice.z:Ollama',
  agentId: 'me.alice.z',
  fromProvider: 'openai',
  endpointLabel: 'Ollama',
  suggestedBaseURL: 'http://127.0.0.1:11434/v1',
  applicable: true,
  title: '让「me.alice.z」改用本地 Ollama',
  detail: '本机 Ollama 在跑。',
}

const setEnv: AdaptationProposal = {
  kind: 'set_env_key',
  id: 'adapt:set_env_key:me.alice.w',
  agentId: 'me.alice.w',
  provider: 'deepseek',
  envVar: 'DEEPSEEK_API_KEY',
  applicable: false,
  title: '为「me.alice.w」配置 DEEPSEEK_API_KEY',
  detail: '设置环境变量后重启。',
}

const wireMcp: AdaptationProposal = {
  kind: 'wire_mcp_server',
  id: 'adapt:wire_mcp:kb:chroma',
  slotName: 'kb',
  candidateServer: 'chroma',
  applicable: false,
  title: '知识库槽位「kb」可接已装的 chroma',
  detail: 'chroma 已装。',
}

const OWNED: Record<string, ButlerOwnedAgent[]> = {
  alice: [{ id: 'me.alice.x', provider: 'deepseek' }],
}

describe('butler-diagnose — 守边界: butler-enactable vs advisory', () => {
  it('a native switch is counted as butler-enactable and names edit_agent', async () => {
    const owned = fakeOwned(OWNED)
    const adapt = fakeAdapt([switchNative])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    const out = textOf(await tools.callTool('diagnose_my_agents', {}))
    expect(out).toContain('我能帮你改') // enactable head
    expect(out).toContain('其中 1 处')
    expect(out).toContain('edit_agent') // the existing governed verb, not a new one
    expect(out).toContain('anthropic')
    expect(out).toContain('/me') // "先送 /me 让你点批准"
  })

  it('a use_local_endpoint (applicable:true for admin) is butler-ADVISORY, not enactable', async () => {
    // The whole 守边界 decision in one assertion: an admin-applicable local-endpoint
    // proposal must NOT count toward the butler's enactable total, and its hint must
    // point at the admin panel / operator — never at edit_agent.
    const owned = fakeOwned(OWNED)
    const adapt = fakeAdapt([useLocal])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    const out = textOf(await tools.callTool('diagnose_my_agents', {}))
    expect(out).toContain('都需要你或管理员手动处理') // advisory head, 0 enactable
    expect(out).not.toContain('我能帮你改')
    expect(out).toContain('资源适配') // points at the admin panel
    expect(out).not.toContain('edit_agent') // butler will NOT enact it
  })

  it('counts ONLY native switches as enactable when kinds are mixed', async () => {
    // switchNative enactable; useLocal(applicable:true) + setEnv advisory → 1 of 3.
    const owned = fakeOwned(OWNED)
    const adapt = fakeAdapt([switchNative, useLocal, setEnv])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    const out = textOf(await tools.callTool('diagnose_my_agents', {}))
    expect(out).toContain('体检发现 3 处')
    expect(out).toContain('其中 1 处我能帮你改')
  })

  it('renders a distinct plain-language next-step for each advisory kind', async () => {
    const owned = fakeOwned(OWNED)
    const adapt = fakeAdapt([switchAdvisory, useLocal, setEnv, wireMcp])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    const out = textOf(await tools.callTool('diagnose_my_agents', {}))
    expect(out).toContain('都需要你或管理员手动处理') // 0 enactable
    // switch_provider applicable:false → openai-compatible baseURL note
    expect(out).toContain('openai 兼容')
    // use_local_endpoint → admin 资源适配 panel
    expect(out).toContain('资源适配')
    // set_env_key → env var
    expect(out).toContain('DEEPSEEK_API_KEY')
    // wire_mcp_server → useMcpServers
    expect(out).toContain('useMcpServers')
  })
})

describe('butler-diagnose — no-leak scoping', () => {
  it("only ever asks listOwned for its OWN member's id", async () => {
    const owned = fakeOwned({
      alice: [{ id: 'me.alice.x', provider: 'deepseek' }],
      bob: [{ id: 'me.bob.y', provider: 'deepseek' }],
    })
    const adapt = fakeAdapt([switchNative])
    const aliceTools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    await aliceTools.callTool('diagnose_my_agents', {})
    expect(owned.calls.every((u) => u === 'alice')).toBe(true)
    expect(owned.calls).not.toContain('bob')
    // And only alice's agent was fed to the engine — bob's never surfaces.
    expect(adapt.fed.flat().every((a) => a.id.startsWith('me.alice.'))).toBe(true)
  })
})

describe('butler-diagnose — empty / healthy', () => {
  it('says so plainly when the member owns no agents (engine never runs)', async () => {
    const owned = fakeOwned({})
    const adapt = fakeAdapt([switchNative])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    const res = await tools.callTool('diagnose_my_agents', {})
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('还没有可体检的助手')
    expect(adapt.fed).toHaveLength(0) // no proposals engine call at all
  })

  it('reports healthy when the engine finds nothing to adapt', async () => {
    const owned = fakeOwned(OWNED)
    const adapt = fakeAdapt([])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    const res = await tools.callTool('diagnose_my_agents', {})
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('都能正常用')
  })
})

describe('butler-diagnose — focus filter', () => {
  it('feeds only the focused agent to the engine', async () => {
    const owned = fakeOwned({
      alice: [
        { id: 'me.alice.x', provider: 'deepseek' },
        { id: 'me.alice.y', provider: 'openai' },
      ],
    })
    const adapt = fakeAdapt([switchNative])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    await tools.callTool('diagnose_my_agents', { agentId: 'me.alice.x' })
    expect(adapt.fed).toHaveLength(1)
    expect(adapt.fed[0]!.map((a) => a.id)).toEqual(['me.alice.x'])
  })

  it('says so plainly when the focused agent is not owned', async () => {
    const owned = fakeOwned(OWNED)
    const adapt = fakeAdapt([switchNative])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    const res = await tools.callTool('diagnose_my_agents', { agentId: 'me.alice.nope' })
    expect(res.isError).toBeFalsy()
    expect(textOf(res)).toContain('没找到你拥有的助手')
    expect(adapt.fed).toHaveLength(0)
  })

  it('skips agents with no declared provider', async () => {
    const owned = fakeOwned({ alice: [{ id: 'me.alice.blank', provider: '' }] })
    const adapt = fakeAdapt([switchNative])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: adapt.surface,
    })
    const res = await tools.callTool('diagnose_my_agents', {})
    // Nothing to feed → treated as "no agents to check", engine never called.
    expect(textOf(res)).toContain('还没有可体检的助手')
    expect(adapt.fed).toHaveLength(0)
  })
})

describe('butler-diagnose — fail-closed', () => {
  it('reports a read failure when listOwned throws (never implies healthy)', async () => {
    const adapt = fakeAdapt([switchNative])
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: {
        async listOwned() {
          throw new Error('db down')
        },
      },
      adaptation: adapt.surface,
    })
    const res = await tools.callTool('diagnose_my_agents', {})
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('读不到你的助手')
    expect(textOf(res)).not.toContain('正常用')
  })

  it('reports a diagnosis failure when the engine throws (never implies healthy)', async () => {
    const owned = fakeOwned(OWNED)
    const tools = buildButlerDiagnoseToolset({
      userId: 'alice',
      ownedAgents: owned.surface,
      adaptation: {
        async propose() {
          throw new Error('engine boom')
        },
      },
    })
    const res = await tools.callTool('diagnose_my_agents', {})
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('体检暂时跑不了')
    expect(textOf(res)).not.toContain('都能正常用')
  })
})

describe('butler-diagnose — tool gating', () => {
  it('offers the tool only when BOTH surfaces are wired', () => {
    const owned = fakeOwned({}).surface
    const adapt = fakeAdapt([]).surface

    expect(buildButlerDiagnoseToolset({ userId: 'a', ownedAgents: owned, adaptation: adapt })
      .listTools().map((t) => t.name)).toEqual(['diagnose_my_agents'])

    // Missing either surface → invisible (never offer a tool that can't fire).
    expect(buildButlerDiagnoseToolset({ userId: 'a', ownedAgents: owned }).listTools()).toEqual([])
    expect(buildButlerDiagnoseToolset({ userId: 'a', adaptation: adapt }).listTools()).toEqual([])
    expect(buildButlerDiagnoseToolset({ userId: 'a' }).listTools()).toEqual([])
  })
})
