/**
 * personal-butler — runnable demo of the resident butler (M5, turnkey).
 *
 * A butler is a `MemoryAugmentedAgent` (memory across sessions) + a bounded,
 * governance-gated tool-loop (sensitive actions wait for a human). This demo
 * proves the three things that make it a butler, deterministically and with NO
 * API key:
 *
 *   [1] MEMORY ACROSS SESSIONS — session 1 the user tells the butler some
 *       facts; they're captured (M2) and consolidated into a durable profile
 *       (M3); a BRAND-NEW session reads that profile from its frozen block (M1)
 *       and recalls it.
 *   [2] BENIGN TOOLS RUN INLINE — "check my calendar" runs straight away; no
 *       approval, no friction.
 *   [3] SENSITIVE ACTIONS ARE GATED — "delete the mailer agent" PARKS the task
 *       (→ a /me inbox item) before anything happens. Approve → it runs.
 *       Decline → it fails closed and nothing is deleted.
 *
 * The classifier (which actions are dangerous) and the executor (what they
 * actually do) are injected here — in production the host wires hub-steward's
 * tiering and the real member services. Approval is simulated inline; the
 * full-stack version (real Hub + suspendNotifier + StewardApprovalBroker +
 * HostInboxService) is the M6 acceptance gate.
 *
 * Run:  pnpm demo:personal-butler
 */

import { SuspendTaskError, type Task } from '@aipehub/core'
import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@aipehub/llm'
import { consolidate } from '@aipehub/personal-memory'
import {
  GovernedActionToolset,
  PersonalButlerAgent,
  readButlerGateState,
  type ButlerDecision,
} from '@aipehub/personal-butler'

import { inMemoryHandle, type DemoMemory } from './memory.js'
import { ButlerMockProvider } from './provider.js'

const BUTLER_SYSTEM =
  '你是用户的私人管家。你有长期记忆,会主动帮忙;但凡要改动系统、花钱、对外发送或删除东西,先请示主人再做。'

// A benign tool — runs inline, no approval.
function benignToolset(): LlmAgentToolset {
  return {
    listTools(): LlmToolDefinition[] {
      return [{ name: 'check_calendar', description: '查看今天的日程安排', inputSchema: { type: 'object', properties: {} } }]
    },
    async callTool(): Promise<LlmToolCallResult> {
      return { content: [{ type: 'text', text: '今天没有日程安排。' }] }
    },
  }
}

// The sensitive actions. `delete_agent` is classified dangerous → it parks for a
// human; the executor mutates the (fake) agent registry only after approval.
function governedToolset(registry: Set<string>): GovernedActionToolset {
  return new GovernedActionToolset({
    tools: [
      {
        name: 'delete_agent',
        description: '永久删除一个托管 agent',
        inputSchema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
      },
    ],
    // The host would wire hub-steward's classifyStewardAction here.
    classify: async (name) =>
      name === 'delete_agent'
        ? { decision: 'approve', reason: '危险动作——会永久删除一个 agent' }
        : { decision: 'allow' },
    execute: async (_name, args) => {
      const handle = String(args.handle)
      if (!registry.has(handle)) return { text: `没有名为 ${handle} 的 agent`, isError: true }
      registry.delete(handle)
      return { text: `deleted ${handle}` }
    },
  })
}

function task(id: string, prompt: string): Task {
  return {
    id,
    from: 'user:alice',
    strategy: { kind: 'explicit', to: 'butler' },
    payload: prompt,
    createdAt: Date.now(),
  }
}

async function main(): Promise<void> {
  const memory: DemoMemory = inMemoryHandle()
  const provider = new ButlerMockProvider()
  const registry = new Set(['mailer', 'billing', 'notifier'])
  const benign = benignToolset()
  const governed = governedToolset(registry)

  // A fresh butler session — same memory handle, so memory persists across them.
  const newSession = (): PersonalButlerAgent =>
    new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory,
      system: BUTLER_SYSTEM,
      benign,
      governed,
      maxToolRounds: 6,
    })

  // ── helpers ──
  const say = async (agent: PersonalButlerAgent, id: string, prompt: string): Promise<string> => {
    const res = await agent.onTask(task(id, prompt))
    if (res.kind !== 'ok') throw new Error(`'${prompt}' → expected ok, got '${res.kind}'`)
    const reply = (res.output as { text: string }).text
    console.log(`  用户> ${prompt}\n  管家> ${reply}\n`)
    return reply
  }
  const sayExpectPark = async (
    agent: PersonalButlerAgent,
    id: string,
    prompt: string,
  ): Promise<{ task: Task; state: unknown }> => {
    const t = task(id, prompt)
    try {
      await agent.onTask(t)
      throw new Error(`'${prompt}' → expected a PARK (sensitive action), but it completed inline`)
    } catch (e) {
      if (!(e instanceof SuspendTaskError)) throw e
      const gate = readButlerGateState(e.state)
      if (!gate?.pending) throw new Error('parked without a pending approval context')
      console.log(`  用户> ${prompt}`)
      console.log(`  [/me 收件箱] 需要你确认: ${gate.pending.approval.title}`)
      console.log(`               原因: ${gate.pending.approval.reason}\n`)
      return { task: t, state: e.state }
    }
  }
  const resume = async (
    agent: PersonalButlerAgent,
    t: Task,
    state: unknown,
    decision: ButlerDecision,
  ): Promise<string> => {
    // Mirrors HostInboxService.resumeChild: inject the decision under `answer`.
    const res = await agent.onResume(t, { ...(state as object), answer: decision })
    if (res.kind !== 'ok') throw new Error(`resume → expected ok, got '${res.kind}'`)
    const reply = (res.output as { text: string }).text
    console.log(`  [主人${decision.approved ? '批准 ✅' : '拒绝 ✋'}]\n  管家> ${reply}\n`)
    return reply
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('━━━ [1] 跨会话记忆 ━━━\n')
  // Session 1: the user tells the butler two facts. Each turn is captured to
  // episodic memory (M2, captureTurns default).
  const s1 = newSession()
  await say(s1, 't1', '记住:我叫阿明。')
  await say(s1, 't2', '另外,我最近在忙一个奶茶店的创业。')
  const episodic = await memory.recall({ kinds: ['episodic'], k: 50 })
  if (episodic.length < 2) throw new Error(`[1] expected ≥2 episodic captures, got ${episodic.length}`)

  // Consolidate (M3): distill the episodic backlog into a durable semantic
  // profile. (The summarizer is the LLM call; deterministic stand-in here.)
  const result = await consolidate({
    memory,
    force: true,
    keepRecent: 1,
    now: () => 2_000_000,
    summarize: async () => '主人名叫阿明;正在做一个奶茶店创业项目。',
  })
  if (!result) throw new Error('[1] consolidate did nothing')
  const semantic = await memory.recall({ kinds: ['semantic'], k: 50 })
  if (!semantic.some((p) => p.text.includes('奶茶店'))) throw new Error('[1] no semantic profile written')
  console.log(`  [系统] 已把 ${result.consolidatedCount} 条 episodic 蒸馏成长期档案:「${result.profile.text}」\n`)

  // Session 2: a BRAND-NEW butler session. Its frozen block carries the profile.
  const s2 = newSession()
  const recalled = await say(s2, 't3', '我之前那个项目叫啥来着?')
  if (!recalled.includes('奶茶店')) throw new Error(`[1] session 2 failed to recall the project: ${recalled}`)

  // ═══════════════════════════════════════════════════════════════════════
  console.log('━━━ [2] 良性工具内联执行(无需审批) ━━━\n')
  const s3 = newSession()
  await say(s3, 't4', '帮我看看今天的日程安排。') // calls check_calendar inline; if it had parked, say() throws

  // ═══════════════════════════════════════════════════════════════════════
  console.log('━━━ [3] 敏感动作必须人工批准 ━━━\n')
  // Approve path.
  const park = await sayExpectPark(newSession(), 't5', '帮我把 mailer 这个 agent 删掉吧。')
  if (!registry.has('mailer')) throw new Error('[3] mailer was deleted BEFORE approval — the gate failed!')
  const s4 = newSession()
  await resume(s4, park.task, park.state, { approved: true })
  if (registry.has('mailer')) throw new Error('[3] approved, but mailer is still present')

  // Decline path → fail closed.
  const park2 = await sayExpectPark(newSession(), 't6', '顺便把 billing 也删了。')
  const s5 = newSession()
  await resume(s5, park2.task, park2.state, { approved: false, note: '这个还要留着' })
  if (!registry.has('billing')) throw new Error('[3] declined, but billing was deleted — fail-closed is broken!')

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('✅ 管家三条不变量全部成立:')
  console.log('   [1] 跨会话记住了「奶茶店项目」')
  console.log('   [2] 良性工具(查日程)内联执行,无需审批')
  console.log('   [3] 删除 agent 先 park 等批准 — 批准才删 mailer,拒绝则 billing 原封不动')
  console.log(`   (剩余 agent: ${[...registry].join(', ')})`)
}

main().catch((err) => {
  console.error('[personal-butler] fatal:', err)
  process.exit(1)
})
