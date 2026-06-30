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
import {
  buildInvertedIndex,
  closedMeta,
  composeReviewers,
  consolidate,
  DEFAULT_REINFORCE_WEIGHT,
  DEFAULT_SALIENCE_HALF_LIFE_MS,
  dreamingReviewer,
  effectiveSalience,
  invertedIndexRetriever,
  isActive,
  isClosed,
  isProfile,
  lexicalRetriever,
  linkReviewer,
  linksOf,
  budgetReviewer,
  MemoryReviewParticipant,
  MemoryToolset,
  META_LINKS,
  queryDiversityOf,
  queryHitMeta,
  reconcileReviewer,
  recallCountOf,
  reinforcedMeta,
  renderFrozenBlock,
  supersedesOf,
  type DreamRecord,
  type MemoryLinkWriter,
  type MemoryQueryHitWriter,
  type MemoryReinforcer,
  type MemoryRetriever,
  type MemorySummarizer,
  type MemoryValidityWriter,
  type RetrieverOptions,
} from '@aipehub/personal-memory'
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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

/**
 * The butler's default recall, index-backed (MR1). The inverted index ranks over
 * EVERY remembered fact, so one older than the recency window still surfaces — the
 * gap `lexicalRetriever` (newest-`wideK` only) left open. In production the host
 * keeps the index fresh against the jsonl and rebuilds only when a file changed
 * (`FileBackedInvertedIndex`); against this tiny in-memory demo we just rebuild
 * from the handle each call — same ranking, simpler. Ranking is still
 * `relevanceScore`, so the only change vs. lexical is COVERAGE, not order.
 */
function indexedRetriever(memory: DemoMemory, opts?: RetrieverOptions): MemoryRetriever {
  return {
    retrieve: async (query) => {
      const all = await memory.list({ limit: 100_000 })
      return invertedIndexRetriever(buildInvertedIndex(all), opts).retrieve(query)
    },
  }
}

async function main(): Promise<void> {
  const memory: DemoMemory = inMemoryHandle()
  const provider = new ButlerMockProvider()
  const registry = new Set(['mailer', 'billing', 'notifier'])
  const benign = benignToolset()
  const governed = governedToolset(registry)

  // A fresh butler session — same memory handle, so memory persists across them.
  // The `recall` tool defaults to the whole-store inverted index (MR1) scoped to
  // facts in effect NOW (D): it spans EVERY remembered fact — not just the recency
  // window — and never surfaces closed history. Ranking stays Chinese-aware
  // `relevanceScore` (C), so it finds non-contiguous CJK matches the substring
  // backend misses too. This is exactly what the host wires; it doesn't change
  // [1]-[3] (the mock never calls recall).
  const newSession = (): PersonalButlerAgent =>
    new PersonalButlerAgent({
      id: 'butler',
      provider,
      memory,
      memoryRetriever: indexedRetriever(memory, { activeOnly: true }),
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

  // ═══════════════════════════════════════════════════════════════════════
  // [4] 长期记忆增强 (C/F/E/G/D) — the resident butler's memory does more than
  // store facts: it recalls them in Chinese (C), fades / strengthens them (F),
  // cross-links them (E), remembers HOW-TOs (G) and tracks WHEN a fact held
  // (D). The package ships these as pure passes + injected writers; THIS is the
  // wiring layer (what the host composes), proven end-to-end and deterministic.
  console.log('━━━ [4] 长期记忆增强 (C/F/E/G/D) ━━━\n')

  // ── [4a] C — Chinese-aware recall finds what substring matching misses ──
  const cMem = inMemoryHandle()
  await cMem.remember({ kind: 'semantic', text: '主人在卖奶茶的店上班' })
  const substringMiss = await cMem.recall({ kinds: ['semantic'], text: '奶茶店', k: 5 })
  const lexicalHit = await lexicalRetriever(cMem).retrieve({ kinds: ['semantic'], text: '奶茶店', k: 5 })
  assert(substringMiss.length === 0, '[4a] C: substring backend should MISS the non-contiguous 「奶茶店」')
  assert(
    lexicalHit.some((e) => e.text.includes('卖奶茶的店')),
    '[4a] C: lexical retriever should find 「卖奶茶的店」for query 「奶茶店」',
  )
  console.log('  [4a] C 中文召回: 子串匹配漏掉「卖奶茶的店」, 词法检索命中 ✓')

  // ── [4b] D — activeOnly recall returns CURRENT truth, history stays on disk ──
  const dMem = inMemoryHandle()
  await dMem.remember({ kind: 'semantic', text: '主人现住吉隆坡', meta: { validFrom: 0, validTo: 300 } })
  await dMem.remember({ kind: 'semantic', text: '主人现住槟城', meta: { validFrom: 300 } })
  const currentOnly = await lexicalRetriever(dMem, { activeOnly: true, now: () => 500 }).retrieve({
    kinds: ['semantic'],
    k: 10,
  })
  const everything = await lexicalRetriever(dMem).retrieve({ kinds: ['semantic'], k: 10 })
  assert(
    currentOnly.some((e) => e.text.includes('槟城')) && !currentOnly.some((e) => e.text.includes('吉隆坡')),
    '[4b] D: activeOnly should keep 槟城 (live) and drop 吉隆坡 (closed)',
  )
  assert(everything.length === 2, '[4b] D: without activeOnly the closed history is still retrievable')
  console.log('  [4b] D 双时态: activeOnly 只回当前的「槟城」, 关掉过滤仍能翻出「吉隆坡」历史 ✓')

  // ── the long-term memory the heartbeat curates, + the three injected writers ──
  // These writers are what the host wires (butlerMemoryWriters): they patch meta
  // IN PLACE via the handle's `patchMeta` (Z-M1), so a reviewer can close an
  // interval / reinforce / grow links without minting a new id. Default off →
  // no writer = the pass is inert; here they make C/F/E/G/D real in the demo.
  const ltm = inMemoryHandle()
  const patch = ltm.patchMeta!.bind(ltm)
  const closeEntry: MemoryValidityWriter = (e, validTo) =>
    Promise.resolve(patch(e.id, closedMeta(undefined, validTo))).then(() => {})
  const reinforcer: MemoryReinforcer = (e, now) =>
    Promise.resolve(patch(e.id, reinforcedMeta(e, now))).then(() => {})
  const linkWriter: MemoryLinkWriter = (updates) =>
    Promise.all(updates.map((u) => patch(u.id, { [META_LINKS]: u.links }))).then(() => {})

  const NOW = 5_000_000
  await ltm.remember({ kind: 'semantic', text: '主人在做奶茶店创业', meta: { importance: 4 } })
  await ltm.remember({ kind: 'semantic', text: '奶茶店的珍珠供货商是城南批发', meta: { importance: 3 } })
  const kl = await ltm.remember({ kind: 'semantic', text: '主人现住吉隆坡', meta: { importance: 3, validFrom: 1_000_000 } })
  await ltm.remember({ kind: 'semantic', text: '主人随口提过喜欢蓝色', meta: { importance: 1 } })
  // A captured turn so the heartbeat review gate (episodic count) fires — and it
  // is the very turn that triggers the reconciliation below.
  await ltm.remember({ kind: 'episodic', text: '主人说他从吉隆坡搬到槟城了' })

  // ── [4c] E + D — one heartbeat tick composes reconcile + link ──
  // Deterministic reconcile stand-in (the LLM curator in production): the user
  // moved to Penang → UPDATE the stale residence fact. In bitemporal mode the
  // old fact is CLOSED (history kept), not overwritten.
  const reconcileSummarize: MemorySummarizer = async ({ user }) => {
    const m = user.match(/^- (\S+): 主人现住吉隆坡/m)
    return m
      ? `{"ops":[{"op":"update","id":"${m[1]}","text":"主人现住槟城(从吉隆坡搬来)","importance":3}]}`
      : '{"ops":[{"op":"noop"}]}'
  }
  const curate = composeReviewers(
    reconcileReviewer({ summarize: reconcileSummarize, bitemporal: true, closeEntry, triggerEntries: 2 }),
    linkReviewer({ write: linkWriter, triggerEntries: 2 }),
  )
  // minEpisodic:1 lets the semantic passes run (the coarse episodic gate would
  // otherwise starve them — see composeReviewers' contract).
  const review = new MemoryReviewParticipant({ memory: ltm, reviewer: curate, policy: { minEpisodic: 1 }, now: () => NOW })
  await review.review()

  const afterCurate = await ltm.list({ limit: 50 })
  const find = (s: string): (typeof afterCurate)[number] => {
    const hit = afterCurate.find((e) => e.text.includes(s))
    assert(hit, `[4] expected a fact containing 「${s}」`)
    return hit
  }
  const klAfter = afterCurate.find((e) => e.id === kl.id)
  assert(
    klAfter !== undefined && isClosed(klAfter) && !isActive(klAfter, NOW),
    '[4c] D: the superseded 吉隆坡 fact must be CLOSED (history kept, not deleted)',
  )
  const penang = find('槟城')
  assert(
    supersedesOf(penang) === kl.id && isActive(penang, NOW),
    '[4c] D: the new 槟城 fact must be active and supersede 吉隆坡',
  )
  const project = find('奶茶店创业')
  const supplier = find('供货商')
  assert(
    linksOf(project).includes(supplier.id) && linksOf(supplier).includes(project.id),
    '[4c] E: 奶茶店项目 and 供货商 must be symmetrically linked',
  )
  console.log('  [4c] E 关联 + D 时间边: 项目↔供货商 双向建链, 吉隆坡 被封存(supersedes), 槟城 现行 ✓')

  // ── [4d] F — reinforcement raises an entry's keep-value ──
  const SAL = { halfLifeMs: DEFAULT_SALIENCE_HALF_LIFE_MS, reinforceWeight: DEFAULT_REINFORCE_WEIGHT }
  // patchMeta replaces the array slot, so always re-read the CURRENT object — a
  // snapshot taken earlier still points at the pre-patch copy.
  const reread = async (s: string): Promise<(typeof afterCurate)[number]> => {
    const hit = (await ltm.list({ limit: 50 })).find((e) => e.text.includes(s))
    assert(hit, `[4] expected a fact containing 「${s}」`)
    return hit
  }
  const supBefore = await reread('供货商')
  const salBefore = effectiveSalience(supBefore, NOW, SAL)
  await reinforcer(supBefore, NOW) // recall it once …
  await reinforcer(await reread('供货商'), NOW) // … and again
  const supAfter = await reread('供货商')
  assert(
    recallCountOf(supAfter) === 2 && effectiveSalience(supAfter, NOW, SAL) > salBefore,
    '[4d] F: reinforcing a fact must raise its keep-value (recallCount 2, salience up)',
  )
  console.log(`  [4d] F 强化: 供货商被回想 2 次, keep-value 由 ${salBefore.toFixed(2)} 升到 ${effectiveSalience(supAfter, NOW, SAL).toFixed(2)} ✓`)

  // ── [4d'] D-M3 — budget eviction drops dead history FIRST ──
  // A count-based budget (one entry = one unit) makes the eviction order legible
  // without byte arithmetic. evictExpiredFirst means the CLOSED 吉隆坡 (expired
  // at NOW) is dropped before any live entry — even ones of LOWER importance,
  // like the imp-1 「喜欢蓝色」 throwaway, which survives this tick.
  const budgetTick = new MemoryReviewParticipant({
    memory: ltm,
    reviewer: budgetReviewer({
      budgetBytes: 5, // ceiling = 5 entries (see measure)
      measure: (es) => es.length,
      evictExpiredFirst: true,
      salience: SAL,
      protectRecentEpisodic: 0,
    }),
    policy: { minEpisodic: 1 },
    now: () => NOW,
  })
  await budgetTick.review()
  const afterBudget = await ltm.list({ limit: 50 })
  assert(
    !afterBudget.some((e) => e.id === kl.id),
    "[4d'] D-M3: the expired 吉隆坡 history must be evicted first under budget pressure",
  )
  assert(
    afterBudget.some((e) => e.text.includes('喜欢蓝色')),
    "[4d'] D-M3: a LIVE low-importance fact outlives expired history (evict-expired-first)",
  )
  console.log("  [4d'] D-M3 预算: 过期的「吉隆坡」史料先被驱逐, 在岗的低优先级事实反而留下 ✓")

  // ── [4e] G — the frozen block lifts how-tos into their own section ──
  const gMem = inMemoryHandle()
  await gMem.remember({ kind: 'semantic', text: '主人的身高体重', meta: { importance: 2 } })
  await gMem.remember({
    kind: 'semantic',
    text: '怎么给加班费定金额',
    meta: { importance: 3, form: 'procedure', steps: ['查当日倍率', '按时薪×倍率×时长', '报店长确认'] },
  })
  const gBlock = renderFrozenBlock(await gMem.recall({ kinds: ['semantic'], k: 50 }), { showProcedures: true })
  assert(
    gBlock.includes('Things I know how to do') &&
      gBlock.includes('怎么给加班费定金额') &&
      gBlock.includes('查当日倍率'),
    '[4e] G: the frozen block must lift procedures into a how-to section with their steps',
  )
  console.log('  [4e] G 程序记忆: 冻结块把「怎么给加班费定金额」连步骤抽进「会做的事」小节 ✓\n')

  // ── [4f] MR1 — the default recall index spans the WHOLE store ──
  // The prior default (lexicalRetriever) ranks only the newest ~wideK entries, so
  // a relevant fact older than that window is never even a candidate. The inverted
  // index indexes every fact, so it finds the buried one — the real recall gap for
  // a resident butler who has been remembering for months. (`indexedRetriever` is
  // exactly the default wired into every butler session above.)
  const wMem = inMemoryHandle()
  await wMem.remember({ kind: 'semantic', text: '主人最爱的奶茶店叫春水堂' }) // oldest by write order
  for (let i = 0; i < 60; i++) await wMem.remember({ kind: 'episodic', text: `日常闲聊第${i}条` })
  const wQuery = { text: '奶茶店', k: 5 } as const
  const windowMiss = await lexicalRetriever(wMem).retrieve(wQuery)
  const indexHit = await indexedRetriever(wMem).retrieve(wQuery)
  assert(windowMiss.length === 0, '[4f] MR1: the recency-window retriever must MISS the buried old fact')
  assert(
    indexHit.some((e) => e.text.includes('春水堂')),
    '[4f] MR1: the inverted index must FIND the relevant fact older than the window',
  )
  console.log('  [4f] MR1 默认召回索引: 60 条新记录埋住的「春水堂」, 窗口检索漏掉、倒排索引翻出 ✓\n')

  // ── [4g] MR2 — the dreaming sweep promotes what gets asked-about, prunes chatter ──
  // The full loop, end to end: recall STAMPS each question's fingerprint on the
  // fact it matched (so a fact asked about in many DIFFERENT ways earns
  // query-diversity), then the 6h "dreaming" sweep scores every episodic by
  // salience × recall × diversity — promoting the high-value one into a distilled
  // profile and pruning the stale, never-asked chatter. This is the OpenClaw-style
  // background consolidation, but bounded and reversible (promote distills; prune
  // only touches stale, zero-diversity, low-value entries).
  const drMem = inMemoryHandle()
  const drPatch = drMem.patchMeta!.bind(drMem)
  const queryHit: MemoryQueryHitWriter = (e, fp) => {
    const delta = queryHitMeta(e, fp)
    return delta ? Promise.resolve(drPatch(e.id, delta)).then(() => {}) : Promise.resolve()
  }
  const hotFact = await drMem.remember({ kind: 'episodic', text: '主人最爱春水堂的珍珠奶茶', meta: { importance: 5 } })
  await drMem.remember({ kind: 'episodic', text: '随口闲聊一句今天天气', meta: { importance: 1 } })

  // The butler's own recall tool, wired with the query-hit writer (what the host
  // wires as butlerMemoryWriters.queryHit). Two DIFFERENT questions about the same
  // fact → its query-diversity rises to 2; a re-asked question would not count.
  const drTools = new MemoryToolset({ memory: drMem, queryHit })
  await drTools.callTool('recall', { query: '奶茶', kinds: ['episodic'] })
  await drTools.callTool('recall', { query: '春水堂', kinds: ['episodic'] })
  const hotAfterAsk = (await drMem.list({ limit: 50 })).find((e) => e.id === hotFact.id)!
  assert(queryDiversityOf(hotAfterAsk) === 2, '[4g] MR2: two distinct questions must raise query-diversity to 2')

  const DREAM_NOW = 5_000_000
  const dreamLog: DreamRecord[] = []
  const dreamSummarize: MemorySummarizer = async () => '主人偏好: 春水堂的珍珠奶茶(常被问起)'
  // staleMs:1000 so the demo's small timestamps count as stale; promoteGate 8 lets
  // the diversity-3 hot fact (5×1×3=15) through while the chatter (1×1×1=1) doesn't.
  const dreamTick = new MemoryReviewParticipant({
    memory: drMem,
    reviewer: dreamingReviewer({
      summarize: dreamSummarize,
      promoteGate: 8,
      pruneGate: 1,
      staleMs: 1000,
      diary: (rec) => {
        dreamLog.push(rec)
      },
    }),
    policy: { minEpisodic: 1 },
    now: () => DREAM_NOW,
  })
  await dreamTick.review()

  const afterDream = await drMem.list({ limit: 50 })
  const dreamedProfile = afterDream.find((e) => isProfile(e) && e.text.includes('春水堂'))
  assert(dreamedProfile !== undefined, '[4g] MR2: the asked-about fact must be promoted into a distilled profile')
  assert(!afterDream.some((e) => e.id === hotFact.id), '[4g] MR2: the promoted episodic must be folded away')
  assert(!afterDream.some((e) => e.text.includes('天气')), '[4g] MR2: the stale never-asked chatter must be pruned')
  assert(
    dreamLog.length === 1 && dreamLog[0]!.promoted.length === 1 && dreamLog[0]!.pruned.length === 1,
    '[4g] MR2: the sweep must record one diary entry (1 promoted, 1 pruned)',
  )
  console.log('  [4g] MR2 后台复盘: 被反复问起的「春水堂」升进画像, 没人问的「天气」闲聊被封存, 复盘日记记下 1 升 1 封 ✓\n')

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('✅ 管家不变量 + 长期记忆增强全部成立:')
  console.log('   [1] 跨会话记住了「奶茶店项目」')
  console.log('   [2] 良性工具(查日程)内联执行,无需审批')
  console.log('   [3] 删除 agent 先 park 等批准 — 批准才删 mailer,拒绝则 billing 原封不动')
  console.log('   [4] 长期记忆: 中文召回(C) · 衰减强化(F) · 关联(E) · 程序(G) · 双时态(D) 全接通')
  console.log('   [MR1] 默认召回索引跨整个 store, 翻出窗口外的旧记忆')
  console.log('   [MR2] 后台复盘把被问起的记忆升进画像、把没人问的闲聊封存')
  console.log(`   (剩余 agent: ${[...registry].join(', ')})`)
}

main().catch((err) => {
  console.error('[personal-butler] fatal:', err)
  process.exit(1)
})
