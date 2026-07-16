/**
 * NET-M2 承重门(e2e)— ask_peer 走真双 hub 全环。
 *
 * butler-ask-peer.test.ts 单测了闸的大脑;这一门证明它接在真的 mesh 上:
 * 两台真 Hub 用 `createInprocHubLinkPair` + 真 `installPeerLink`(真
 * RemoteHubViaLink wrapper——outboundCaps 白名单、origin 盖章、owner 审批
 * 装饰全是生产件,零 mock),管家是真 PersonalButlerAgent(确定性 mock
 * provider),park→/me→approve 走 main.ts 同款 suspendNotifier 缝。
 * 边的装法镜像 peer-registry(G-M1 advertise=authorize:outboundCaps 同时
 * 就是 wrapper 的广告能力)。载荷断言:
 *
 *   1. 策展边全环:成员一句「问一下爸爸的 hub…」→ 管家 park(未批前
 *      **零字节出网**)→ 成员 /me 批准 → capability 路由出网 → 对端 agent
 *      应答 → 答案回到成员的同一轮;
 *   2. 对端收到的 task **origin.orgId = 本方 hubId**(wrapper 盖真章,不是
 *      'local' 不是空)+ origin.userId = 提问成员;
 *   3. 未策展 null 边在 classify 就拒(诚实指路「请管理员策展」)——这条门
 *      钉住 e2e 抓出的教训:explicit 过线后对端路由不了,假路由不如实拒;
 *   4. 锁死边同样 classify 就拒——不 park、不写收件箱、零字节出网;
 *   5. owner 双闸(ApprovalGatedParticipant 装饰 wrapper):成员批后拿到
 *      「还差 owner 一道」的诚实文案,owner 收件箱真躺着一条;owner 批准后
 *      任务才真正跨界落到对端。
 */

import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AgentParticipant,
  Hub,
  createInprocHubLinkPair,
  installPeerLink,
  type Logger,
  type Task,
} from '@gotong/core'
import { openIdentityStore, MASTER_KEY_LEN_BYTES, type IdentityStore } from '@gotong/identity'
import { FileInboxStore, NEVER_RESUME_AT } from '@gotong/inbox'
import type { LlmProvider, LlmRequest, LlmStreamChunk } from '@gotong/llm'
import { PersonalButlerAgent } from '@gotong/personal-butler'
import { Space } from '@gotong/core'

import { HostInboxService } from '../src/inbox-service.js'
import { ApprovalGatedParticipant } from '../src/outbound-approval.js'
import { buildButlerAskPeerToolset } from '../src/personal-butler-ask-peer.js'
import { butlerApprovalItemFor } from '../src/personal-butler-escalation.js'
import { openButlerMemory } from '../src/personal-butler-memory.js'
import type { ButlerPeerRow, ButlerPeerSurface } from '../src/personal-butler-peers.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return silentLogger
  },
}
const USER = 'user_me'
const SELF_HUB = 'hub-me'
const PEER_HUB = 'hub-dad'

/** 对端的应答 agent——记录收到的 task,好断言 origin 真章。 */
class DadAgent extends AgentParticipant {
  invocations = 0
  lastTask?: Task
  constructor(capabilities: readonly string[]) {
    super({ id: 'dad-agent', capabilities })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.invocations++
    this.lastTask = task
    return { text: '有空,回来吃饭。' }
  }
}

/** 确定性 mock provider:见「问…hub」就出 ask_peer;tool 结果回来就复述。 */
class AskPeerProvider implements LlmProvider {
  readonly name = 'ask-peer-e2e'
  async *stream(req: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    const content = last?.content
    if (Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')) {
      const blob = JSON.stringify(content)
      yield { type: 'text', text: blob.includes('isError') && blob.includes('true') ? `没成:${blob.slice(0, 200)}` : `帮你问到了:${blob.slice(0, 300)}` }
      yield { type: 'end', stopReason: 'end_turn' }
      return
    }
    const text = typeof content === 'string' ? content : ''
    if (text.includes('问')) {
      yield {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: 'ap-1', name: 'ask_peer', input: { peerId: PEER_HUB, message: '今晚有空吗?' } },
      }
      yield { type: 'end', stopReason: 'tool_use' }
      return
    }
    yield { type: 'text', text: '好的。' }
    yield { type: 'end', stopReason: 'end_turn' }
  }
}

describe('NET-M2 e2e — ask_peer 真双 hub 全环', () => {
  let tmp: string
  let hubA: Hub
  let hubB: Hub
  let identity: IdentityStore
  let inboxStore: FileInboxStore
  let inboxService: HostInboxService
  let dad: DadAgent

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-ask-peer-e2e-'))
    const { space } = await Space.init(tmp, { name: 'ask-peer-e2e' })
    identity = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    inboxStore = new FileInboxStore(tmp)
    inboxStore.ensureDirs()
    // main.ts 同款缝:park 持久化 + 管家 governed park 翻成 /me approval 项。
    hubA = new Hub({
      space,
      suspendNotifier: async (task, by, s) => {
        identity.persistSuspendedTask({
          taskId: task.id,
          agentId: by,
          hubId: 'local',
          originUserId: task.origin?.userId ?? null,
          resumeAt: s.resumeAt,
          state: s.state,
          taskJson: JSON.stringify(task),
        })
        const approver = task.origin?.userId
        if (approver) {
          const item = butlerApprovalItemFor(task, by, s.state, { approver })
          if (item) await inboxStore.write(item)
        }
      },
    })
    hubB = Hub.inMemory()
    await Promise.all([hubA.start(), hubB.start()])
    inboxService = new HostInboxService({ hub: hubA, store: inboxStore, identity })
    // dad 由各场景自己注册(能力集因场景而异,也避免重复注册)。
  })

  afterEach(async () => {
    await hubA.stop().catch(() => {})
    await hubB.stop().catch(() => {})
    identity.close()
    await rm(tmp, { recursive: true, force: true })
  })

  /** 对端注册一个 dad(能力集按场景给)。 */
  function registerDad(capabilities: readonly string[]): void {
    dad = new DadAgent(capabilities)
    hubB.register(dad)
  }

  /**
   * 装一条 A→B 的真 mesh 边;返回 roster 行(镜像 NET-M1 面会给的投影)。
   * 装法逐字镜像 peer-registry:outboundCaps 既是出站白名单又是 wrapper 的
   * 广告能力(G-M1 advertise=authorize);null 边广告为空。
   */
  function linkAB(opts: {
    outboundCaps?: string[]
    wrapApproval?: { approver: string }
  }): ButlerPeerRow {
    const { a, b } = createInprocHubLinkPair({ aPeerId: PEER_HUB, bPeerId: SELF_HUB })
    installPeerLink({
      hub: hubA,
      link: a,
      selfHubId: SELF_HUB,
      // 真 originResolver:wrapper 给出网 task 盖 {orgId: SELF_HUB, userId}。
      originResolver: async (from) => (from ? { userId: from } : null),
      ...(opts.outboundCaps
        ? { outboundCaps: opts.outboundCaps, remoteCapabilities: opts.outboundCaps }
        : {}),
      ...(opts.wrapApproval
        ? {
            wrapOutbound: (inner) =>
              new ApprovalGatedParticipant({
                inner,
                store: inboxStore,
                approver: opts.wrapApproval!.approver,
                peerLabel: PEER_HUB,
              }),
          }
        : {}),
    })
    installPeerLink({ hub: hubB, link: b, remoteCapabilities: [] })
    return {
      peerId: PEER_HUB,
      label: '爸爸的 hub',
      connected: true,
      lastSeenAt: null,
      outboundCaps: opts.outboundCaps ? [...opts.outboundCaps] : null,
      trustTier: null,
      pinned: false,
    }
  }

  function butlerWith(roster: ButlerPeerRow[]): PersonalButlerAgent {
    const peers: ButlerPeerSurface = { listForButler: async () => roster }
    const b = new PersonalButlerAgent({
      id: 'butler:me',
      provider: new AskPeerProvider(),
      memory: openButlerMemory({ rootDir: join(tmp, 'mem'), userId: USER, logger: silentLogger }),
      system: '你是管家。',
      governed: buildButlerAskPeerToolset({ userId: USER, peers, hub: hubA }),
      maxToolRounds: 4,
    })
    hubA.register(b)
    return b
  }

  const askViaIm = () =>
    hubA.dispatch({
      from: `user:${USER}`,
      strategy: { kind: 'explicit', to: 'butler:me' },
      payload: '帮我问一下爸爸的 hub 今晚有没有空。',
      origin: { orgId: 'local', userId: USER },
    })

  it('① 策展边全环:park(零字节出网)→ 成员批准 → capability 出网 → 对端答 → origin 真章', async () => {
    registerDad(['dad-chat'])
    const roster = [linkAB({ outboundCaps: ['dad-chat'] })]
    butlerWith(roster)

    const parked = await askViaIm()
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected park')
    expect(dad.invocations).toBe(0) // 未批前零字节出网

    const pending = await inboxStore.listPending(USER)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.prompt).toContain(PEER_HUB) // 批的是「发给谁」
    expect(pending[0]!.prompt).toContain('今晚有空吗')

    await inboxService.resolve({ itemId: parked.taskId, userId: USER, decision: { kind: 'approval', approved: true } })

    expect(dad.invocations).toBe(1) // 批准后真跨界了
    expect(dad.lastTask?.payload).toBe('今晚有空吗?')
    // wrapper 盖的真章:orgId = 本方 hubId(不是 'local' 不是空),userId = 提问成员。
    expect(dad.lastTask?.origin).toEqual({ orgId: SELF_HUB, userId: USER })

    const final = hubA.taskResult(parked.taskId)
    expect(final?.kind).toBe('ok')
    if (final?.kind === 'ok') {
      expect(JSON.stringify(final.output)).toContain('有空,回来吃饭')
    }
  })

  it('② 未策展 null 边 classify 就拒(诚实指路策展):不 park、零字节出网', async () => {
    // e2e 抓出的教训钉在这:null 边 wrapper 广告为空,capability 选不中它,
    // explicit 过线后对端也路由不了——诚实答案是当场拒 + 指路,绝不假路由。
    registerDad(['chat'])
    const roster = [linkAB({})] // outboundCaps 缺省 → null 边
    butlerWith(roster)

    const done = await askViaIm()
    expect(done.kind).toBe('ok') // 管家当轮回话(拒绝理由),没有 park
    if (done.kind === 'ok') expect(JSON.stringify(done.output)).toContain('策展')
    expect(await inboxStore.listPending(USER)).toHaveLength(0)
    expect(dad.invocations).toBe(0)
  })

  it('③ 锁死边 classify 就拒:不 park、收件箱为空、零字节出网', async () => {
    registerDad(['dad-chat'])
    const roster = [linkAB({ outboundCaps: [] })]
    butlerWith(roster)

    const done = await askViaIm()
    expect(done.kind).toBe('ok') // 管家当轮就回话(拒绝理由),没有 park
    expect(await inboxStore.listPending(USER)).toHaveLength(0)
    expect(dad.invocations).toBe(0)
  })

  it('④ owner 双闸:成员批后诚实「还差 owner 一道」,owner 批完才真跨界', async () => {
    const OWNER = 'user_owner'
    registerDad(['dad-chat'])
    const roster = [linkAB({ outboundCaps: ['dad-chat'], wrapApproval: { approver: OWNER } })]
    butlerWith(roster)

    const parked = await askViaIm()
    expect(parked.kind).toBe('suspended')
    if (parked.kind !== 'suspended') throw new Error('expected member park')

    // 第一道:成员自己批。
    await inboxService.resolve({ itemId: parked.taskId, userId: USER, decision: { kind: 'approval', approved: true } })

    // 成员的轮次完成,文案诚实说还差 owner 一道;对端仍零字节。
    const final = hubA.taskResult(parked.taskId)
    expect(final?.kind).toBe('ok')
    if (final?.kind === 'ok') expect(JSON.stringify(final.output)).toContain('还需要 hub 管理员')
    expect(dad.invocations).toBe(0)

    // 第二道:owner 的收件箱真躺着一条出站审批。
    const ownerPending = await inboxStore.listPending(OWNER)
    expect(ownerPending).toHaveLength(1)
    expect(ownerPending[0]!.kind).toBe('approval')

    // owner 批准 → 出站真正放行,任务落到对端。
    await inboxService.resolve({
      itemId: ownerPending[0]!.itemId,
      userId: OWNER,
      decision: { kind: 'approval', approved: true },
    })
    expect(dad.invocations).toBe(1)
    expect(dad.lastTask?.origin).toEqual({ orgId: SELF_HUB, userId: USER })
  })
})
