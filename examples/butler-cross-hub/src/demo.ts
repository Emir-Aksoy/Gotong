/**
 * butler-cross-hub — the resident butler asks a PEER HUB on the member's behalf.
 *
 * 北极星第 1 层和第 2 层在这里握手:个人管家(「我的 AI」)把「我」接进
 * mesh(跨 hub 协作)。成员一句大白话「问一下爸爸的 hub 今晚有没有空」,
 * 管家转述、成员在自己的 /me 确认、任务跨过 hub 边界、对端应答回到同一轮
 * 对话。
 *
 * The whole road already shipped — this demo adds ZERO new mechanism:
 *
 *   - the mesh edge is a REAL `installPeerLink` (real RemoteHubViaLink
 *     wrapper): the outbound capability allowlist and the origin stamp in this
 *     demo are production parts, not mocks. The edge is installed exactly the
 *     way the host's peer-registry does it (G-M1 advertise = authorize: the
 *     curated `outboundCaps` list is ALSO what the wrapper advertises, so a
 *     capability dispatch can route to the edge and the same list authorizes
 *     the cross).
 *   - cross-hub addressing is CAPABILITY, not id (the wrapper forwards the
 *     task's strategy verbatim; the far hub re-dispatches by that same
 *     strategy — an explicit aimed at OUR wrapper id names nobody over
 *     there). That's why only a CURATED edge is askable: an uncurated
 *     (legacy, outboundCaps=null) edge advertises nothing and the honest
 *     answer is a refusal that points at curation, not a fake route.
 *   - the member's own confirmation is the butler's governed gate
 *     (@gotong/personal-butler): leaving the hub is consequential — it spends
 *     the far side's resources and crosses a data boundary — so ask_peer
 *     always PARKS for the member's own /me approval first. 未批前零字节出网.
 *
 * What this demo proves end to end (deterministic, no API key):
 *
 *   [1] ask → PARK: the butler turns the member's line into a governed
 *       ask_peer; the turn suspends into the member's /me. Dad's hub has seen
 *       NOTHING yet.
 *   [2] approve → cross → answer in the same turn: the member approves; the
 *       ask rides capability dispatch through the real wrapper, which stamps
 *       the TRUE origin ({orgId: 'hub-me', userId}) — the receiver knows
 *       who-from-which-hub is asking; dad's agent answers; the reply lands
 *       back in the member's conversation.
 *   [3] reject → fail-closed: same park, the member declines; the peer is
 *       NEVER contacted and the butler says so honestly.
 *   [4] uncurated edge → honest refusal BEFORE parking: asking a peer whose
 *       edge has no curated outboundCaps is refused in the same turn with
 *       guidance (请管理员策展), wasting neither an approval nor a byte.
 *
 * This is host-free on purpose (same precedent as cross-hub-workflow /
 * personal-butler): the ~50-line governed toolset below is a readable mirror
 * of the host's `packages/host/src/personal-butler-ask-peer.ts` (which adds
 * the full route ladder: capability arg selection, local-cap collision and
 * multi-edge ambiguity pre-flight, posture re-resolution on execute, six
 * TaskResult mappings). In production the roster is NET-M1's sanitized
 * projection (`buildButlerPeerSurface`) and the park lands in the real /me
 * inbox via the host's suspendNotifier — same machinery, same order.
 *
 * Run:  pnpm demo:butler-cross-hub
 */

import {
  Hub,
  InMemoryStorage,
  SuspendTaskError,
  createInprocHubLinkPair,
  installPeerLink,
  type ParticipantId,
  type Task,
  type TaskResult,
} from '@gotong/core'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import {
  GovernedActionToolset,
  PersonalButlerAgent,
  readButlerGateState,
  type ButlerDecision,
} from '@gotong/personal-butler'
import type { MemoryEntry, MemoryHandle, MemoryKind, NewMemoryEntry } from '@gotong/services-sdk'

const USER = 'user_me'
const SELF_HUB = 'hub-me'
const PEER_HUB = 'hub-dad'
const PEER_CAP = 'dad-chat'

/** 成员眼里的互联名单 — 生产里这是 NET-M1 `buildButlerPeerSurface` 的脱敏投影。 */
interface PeerRow {
  peerId: string
  label: string
  /** null = 未策展(legacy 边,广告为空,派不出去)/ 列表 = 白名单(即广告)。 */
  outboundCaps: string[] | null
}

const ROSTER: PeerRow[] = [
  { peerId: PEER_HUB, label: '爸爸的 hub', outboundCaps: [PEER_CAP] },
  // 未策展边:拒绝发生在 classify(出网之前),所以连 link 都不用装——
  // 这正是要证的点:一个字节都不会走到线上。
  { peerId: 'hub-uncle', label: '叔叔的 hub', outboundCaps: null },
]

/** 对端 hub 上的应答 agent — 记录收到的 task,好断言 origin 真章。 */
class DadAgent {
  readonly kind = 'agent' as const
  readonly id = 'dad-agent' as ParticipantId
  readonly capabilities = [PEER_CAP]
  readonly seen: Task[] = []
  async onTask(task: Task): Promise<TaskResult> {
    this.seen.push(task)
    return { kind: 'ok', taskId: task.id, by: this.id, ts: 1, output: { text: '有空,回来吃饭。' } }
  }
}

/** 最小内存 MemoryHandle — 本 demo 不演记忆,只要管家能开机。 */
function minimalMemory(): MemoryHandle {
  const entries: MemoryEntry[] = []
  let seq = 0
  return {
    async recall() {
      return []
    },
    async remember(ne: NewMemoryEntry) {
      const e: MemoryEntry = { id: ne.id ?? `m${++seq}`, kind: ne.kind, text: ne.text, ts: seq }
      entries.push(e)
      return e
    },
    async list(opts: { kind?: MemoryKind; limit?: number } = {}) {
      return entries.filter((e) => !opts.kind || e.kind === opts.kind).slice(0, opts.limit ?? 100)
    },
    async forget() {},
    async clear() {},
  }
}

/**
 * 确定性 mock provider:见「叔叔」问 hub-uncle,见「问」问 hub-dad;
 * tool 结果回来就复述。生产里换任何 LlmProvider,闸与回路一字不变。
 */
class AskPeerMockProvider implements LlmProvider {
  readonly name = 'butler-cross-hub-mock'
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    const content = last?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      const failed = blob.includes('"isError":true') || blob.includes('没发') || blob.includes('拒绝')
      yield { type: 'text', text: failed ? `这次没问成:${extractToolText(content)}` : `帮你问到了 — ${extractToolText(content)}` }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }
    const text = typeof content === 'string' ? content : ''
    if (text.includes('问')) {
      const peerId = text.includes('叔叔') ? 'hub-uncle' : PEER_HUB
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'ap-1', name: 'ask_peer', input: { peerId, message: '今晚有空吗?' } },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

function extractToolText(content: unknown[]): string {
  for (const b of content) {
    const tr = b as { type?: string; content?: unknown }
    if (tr.type !== 'tool_result') continue
    // 管家的 tool-loop 会把工具输出压平成一个字符串;兜一手块数组形状。
    if (typeof tr.content === 'string') return tr.content
    if (Array.isArray(tr.content)) {
      return tr.content.map((c) => (c as { text?: string }).text ?? '').join(' ')
    }
  }
  return '(无内容)'
}

/**
 * 管家的 governed ask_peer 闸 — host 真件
 * `packages/host/src/personal-butler-ask-peer.ts` 的教学镜像(那边还有
 * capability 参数选择、本地抢路/多边歧义预检、execute 姿态重解析、六种
 * TaskResult 文案;这里只留骨架,好看清「出网必须成员点头」的肌理)。
 */
function askPeerToolset(hub: Hub): GovernedActionToolset {
  return new GovernedActionToolset({
    tools: [
      {
        name: 'ask_peer',
        description: '替成员向一个互联的对端 hub 发一句请求,拿到回答带回来。会先送 /me 等成员确认。',
        inputSchema: {
          type: 'object',
          properties: { peerId: { type: 'string' }, message: { type: 'string' } },
          required: ['peerId', 'message'],
        },
      },
    ],
    // park 前的服务端权威分级:无效目标 / 未策展边在这里就拒,绝不浪费
    // 成员一次审批;有效 → approve(出网必须成员点头,绝无 inline allow)。
    classify: async (_name, args) => {
      const peer = ROSTER.find((r) => r.peerId === args.peerId)
      if (!peer) {
        return { decision: 'refuse', reason: `「${String(args.peerId)}」不是互联的对端。互联的有:${ROSTER.map((r) => r.peerId).join('、')}。` }
      }
      if (peer.outboundCaps === null) {
        return { decision: 'refuse', reason: `到「${peer.label}」的这条边还没策展可出网的能力,现在派不出请求;请管理员给这条边配 outboundCaps(策展即授权)。` }
      }
      return { decision: 'approve', reason: `要出网发给对端「${peer.peerId}(${peer.label})」——先请你确认` }
    },
    // 成员批准之后才走到这里:capability 派发、不带 origin(真 wrapper 盖章)。
    execute: async (_name, args) => {
      const peer = ROSTER.find((r) => r.peerId === args.peerId)
      if (!peer || peer.outboundCaps === null) return { text: '批准后情况变了,这次没发出去。', isError: true }
      const result = await hub.dispatch({
        from: USER,
        strategy: { kind: 'capability', capabilities: [peer.outboundCaps[0]!] },
        payload: args.message,
        title: `出网问「${peer.label}」— ${USER}`,
      })
      if (result.kind === 'ok') {
        const text = (result.output as { text?: string })?.text ?? JSON.stringify(result.output)
        return { text: `对端「${peer.peerId}(${peer.label})」回复:${text}` }
      }
      return { text: `对端没能完成(${result.kind})。`, isError: true }
    },
    describe: (_name, args) => `出网询问对端「${String(args.peerId)}」:${String(args.message)}`,
  })
}

async function main(): Promise<void> {
  console.log('\n=== Gotong case: butler-cross-hub — 管家出网 (北极星 第 1+2 层握手) ===\n')

  // --- 两台真 hub + 一条真 mesh 边 --------------------------------------------
  section('[0] 连接两台 hub (real installPeerLink, 装法镜像 peer-registry)')
  const hubA = new Hub({ storage: new InMemoryStorage() }) // 我的主权 hub
  const hubB = new Hub({ storage: new InMemoryStorage() }) // 爸爸的 hub
  await Promise.all([hubA.start(), hubB.start()])
  const dad = new DadAgent()
  hubB.register(dad)

  const { a, b } = createInprocHubLinkPair({ aPeerId: PEER_HUB, bPeerId: SELF_HUB })
  installPeerLink({
    hub: hubA,
    link: a,
    selfHubId: SELF_HUB,
    // 真 originResolver:出网 task 未带 origin 时,wrapper 盖 {orgId: SELF_HUB, userId}。
    originResolver: async (from) => (from ? { userId: from } : null),
    // G-M1 advertise = authorize:同一份策展列表,既让 capability 派发路由到
    // 这条边(广告),又授权它跨界(白名单)。
    outboundCaps: [PEER_CAP],
    remoteCapabilities: [PEER_CAP],
  })
  installPeerLink({ hub: hubB, link: b, selfHubId: PEER_HUB })
  console.log(`  ${SELF_HUB} → ${PEER_HUB} linked;策展能力 [${PEER_CAP}](未策展的 hub-uncle 只在名单里,证拒绝不需要线)`)

  // --- 真管家(governed ask_peer)---------------------------------------------
  const butler = new PersonalButlerAgent({
    id: 'butler:me',
    provider: new AskPeerMockProvider(),
    memory: minimalMemory(),
    system: '你是这位成员的管家。出网的事,先请成员本人确认。',
    governed: askPeerToolset(hubA),
    maxToolRounds: 4,
  })

  const ask = (id: string, prompt: string): Task => ({
    id,
    from: `user:${USER}`,
    strategy: { kind: 'explicit', to: 'butler:me' },
    payload: prompt,
    origin: { orgId: 'local', userId: USER },
    createdAt: 1,
  })

  /** 成员在 /me 里做决定 → 管家续跑(镜像 HostInboxService 注入 answer 的姿态)。 */
  const decide = async (t: Task, state: unknown, decision: ButlerDecision): Promise<string> => {
    const res = await butler.onResume(t, { ...(state as object), answer: decision })
    if (res.kind !== 'ok') throw new Error(`resume → expected ok, got '${res.kind}'`)
    const reply = (res.output as { text: string }).text
    console.log(`  [成员${decision.approved ? '批准 ✅' : '拒绝 ✋'}]\n  管家> ${reply}\n`)
    return reply
  }

  // --- [1] 问 → park:未批前零字节出网 ----------------------------------------
  section('[1] 「帮我问一下爸爸的 hub 今晚有没有空」→ 管家 park 进成员自己的 /me')
  const t1 = ask('t1', '帮我问一下爸爸的 hub 今晚有没有空。')
  let parkedState: unknown
  try {
    await butler.onTask(t1)
    throw new Error('expected the ask to PARK for the member, but it completed inline')
  } catch (e) {
    if (!(e instanceof SuspendTaskError)) throw e
    parkedState = e.state
    const gate = readButlerGateState(e.state)
    if (!gate?.pending) throw new Error('parked without a pending approval context')
    console.log(`  用户> ${t1.payload as string}`)
    console.log(`  [/me 收件箱] ${gate.pending.approval.title}`)
    console.log(`               原因: ${gate.pending.approval.reason}\n`)
  }
  const crossedBeforeApproval: number = dad.seen.length
  if (crossedBeforeApproval !== 0) throw new Error('nothing should have crossed before approval')
  console.log(`  对端 hub 到目前为止收到的任务数: ${crossedBeforeApproval}(未批前零字节出网)`)

  // --- [2] 成员批准 → 跨界 → 答案回同一轮 -------------------------------------
  section('[2] 成员批准 → capability 出网 → 真 wrapper 盖 origin → 对端应答带回')
  const reply = await decide(t1, parkedState, { approved: true })

  // --- [3] fail-closed:成员拒绝,对端永不被联系 --------------------------------
  section('[3] 再问一次,这回成员拒绝 → fail-closed,对端从未被联系')
  const t2 = ask('t2', '再帮我问问爸爸的 hub 周末呢?')
  let parked2: unknown
  try {
    await butler.onTask(t2)
    throw new Error('expected a park')
  } catch (e) {
    if (!(e instanceof SuspendTaskError)) throw e
    parked2 = e.state
  }
  const rejectReply = await decide(t2, parked2, { approved: false })

  // --- [4] 未策展边:classify 就拒,同一轮回话 ---------------------------------
  section('[4] 「问一下叔叔的 hub」(未策展边)→ classify 当场拒 + 指路策展,零 park')
  const t3 = ask('t3', '帮我问一下叔叔的 hub 有没有空。')
  const r3 = await butler.onTask(t3) // 不该 park —— refuse 是当轮回话
  if (r3.kind !== 'ok') throw new Error(`expected an inline refusal turn, got '${r3.kind}'`)
  const refuseReply = (r3.output as { text: string }).text
  console.log(`  用户> ${t3.payload as string}\n  管家> ${refuseReply}\n`)

  // --- self-assertions (this demo doubles as a smoke test) ---------------------
  section('[verify]')
  assert(dad.seen.length === 1, '对端只被联系了一次 — 恰在成员批准之后')
  assert(dad.seen[0]!.payload === '今晚有空吗?', '成员的话原样跨过了边界')
  const origin = dad.seen[0]!.origin
  assert(
    origin?.orgId === SELF_HUB && origin?.userId === USER,
    `对端看到的 origin 是真章 {orgId:'${SELF_HUB}', userId:'${USER}'} — 不是 'local' 不是空`,
  )
  assert(reply.includes('有空,回来吃饭'), '对端的回答落回成员的同一轮对话')
  assert(rejectReply.includes('没'), '拒绝后管家如实说没发出去')
  assert(refuseReply.includes('策展'), '未策展边的拒绝带着可行动的指路(请管理员策展)')
  assert(dad.seen.length === 1, '拒绝与未策展边都零字节出网(对端计数不变)')
  console.log('  all checks passed.')

  await Promise.all([hubA.stop(), hubB.stop()])

  section('done')
  console.log('  个人管家把「我」接进 mesh:问 → 成员确认 → 出网 → 答案带回同一轮 — 第 1+2 层握手.\n')
  process.exit(0)
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`)
  console.log(`  ✓ ${label}`)
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
