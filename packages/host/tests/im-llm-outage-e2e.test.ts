/**
 * CARE-M2 — 断供不失联的验收门(hermetic,同 im-bridge-e2e 姿态)。
 *
 * FakeBridge + 真 Hub + 真 IdentityStore;chat agent 可切「病」:
 * 401 / 超时 / 认不出的业务错 / 正常。载荷断言(计划验收逐条):
 *   1. provider 病 → 自由文本得 canned 大白话(含翻译文案 + 命令面提示),不崩;
 *   2. 连续两条消息只播报一次(边沿 dedup);
 *   3. 恢复后恢复播报恰一次,状态文件清掉;
 *   4. 断供期间 IM 命令面(/help)照常;
 *   5. 认不出的失败走老 `⚠️ Task failed:` 路径(不装懂),不碰断供状态;
 *   6. 零 LLM:整个 canned/播报路径没有任何 provider——文案全部来自
 *      CARE-M1 纯翻译表(结构性成立;agent 调用数 = dispatch 数)。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentParticipant, Hub, type Logger, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'

import {
  handleImMessage,
  makeIdentityImBindingResolver,
  startImBridges,
  type HostImConfig,
} from '../src/im-bridge.js'
import { LlmOutageTracker } from '../src/llm-outage.js'

const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly outbound: Array<{ to: ImUser; text: string; chatId?: string }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(to: ImUser, text: string, options?: { attachments?: ImAttachment[]; chatId?: string }): Promise<void> {
    this.outbound.push({ to, text, chatId: options?.chatId })
  }
  onMessage(listener: (msg: ImMessage) => void | Promise<void>): () => void {
    this.listener = listener
    return () => { this.listener = null }
  }
  async inject(msg: ImMessage): Promise<void> {
    if (this.listener) await this.listener(msg)
  }
}

/** 可切病的 chat agent——「provider 病」在 hub 边界只剩 err.message 字符串,
 *  这里 throw 的 message 就按真实 SDK 的措辞造。 */
type Illness = 'ok' | 'auth' | 'timeout' | 'weird'
class FlakyChatAgent extends AgentParticipant {
  illness: Illness = 'ok'
  calls = 0
  constructor() {
    super({ id: 'chat', capabilities: ['chat'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    this.calls++
    if (this.illness === 'auth') throw new Error('401 Incorrect API key provided: sk-bad')
    if (this.illness === 'timeout') throw new Error('Request timed out.')
    if (this.illness === 'weird') throw new Error('novel exploding business logic')
    const payload = task.payload
    const text =
      typeof payload === 'object' && payload !== null && 'text' in payload
        ? String((payload as { text: unknown }).text)
        : '(no text)'
    return { text: `echo: ${text}` }
  }
}

const ALICE: ImUser = { platform: 'telegram', platformUserId: '1001', displayName: 'Alice' }
const imMsg = (text: string): ImMessage => ({ from: ALICE, text, chatId: 'private:1001', ts: 1_700_000_000_000 })
const last = (b: FakeBridge) => b.outbound[b.outbound.length - 1]!

describe('CARE-M2 — 断供不失联(IM 自由文本 canned 回复 + 边沿播报)', () => {
  let dir: string
  let outageFile: string
  let hub: Hub
  let identity: IdentityStore
  let bridge: FakeBridge
  let agent: FlakyChatAgent
  let announced: string[]

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-im-outage-'))
    outageFile = join(dir, 'runtime', 'llm-outage.json')
    hub = Hub.inMemory()
    await hub.start()
    agent = new FlakyChatAgent()
    hub.register(agent)

    identity = openIdentityStore({ dbPath: ':memory:' })
    const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
    const code = identity.issueImBindingCode({ userId: alice.id }).code

    bridge = new FakeBridge()
    announced = []
    const config: HostImConfig = {
      hub,
      resolver: makeIdentityImBindingResolver(identity),
      freeTextCapability: 'chat',
      onUnbind: async (platform, platformUserId) => ({ removed: identity.removeImBinding(platform, platformUserId) > 0 }),
      log: silentLogger,
      llmOutage: {
        tracker: new LlmOutageTracker(outageFile),
        lang: 'zh',
        announce: async (text) => { announced.push(text) },
      },
    }
    bridge.onMessage((m) => handleImMessage(bridge, m, config))
    await bridge.inject(imMsg(`/bind ${code}`))
    expect(last(bridge).text).toContain('Bound')
  })

  afterEach(async () => {
    await hub.stop()
    identity.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('401 → canned 大白话 + 播一次;连发两条不重播;/help 照常;恢复播恰一次', async () => {
    // ① 断供:401 病
    agent.illness = 'auth'
    await bridge.inject(imMsg('帮我总结今天'))
    expect(last(bridge).text).toContain('API key')          // CARE-M1 auth 文案
    expect(last(bridge).text).toContain('命令照常可用')      // 命令面提示
    expect(last(bridge).text).not.toContain('Task failed')  // 不是原始异常转发
    expect(announced).toHaveLength(1)                        // 断供边沿播一次
    expect(announced[0]).toContain('管家大脑')
    expect(announced[0]).toContain('API key')

    // ② 第二条消息:canned 照答,播报不重复(dedup)
    await bridge.inject(imMsg('在吗'))
    expect(last(bridge).text).toContain('API key')
    expect(announced).toHaveLength(1)

    // ③ 断供期间命令面照常
    await bridge.inject(imMsg('/help'))
    expect(last(bridge).text).toContain('Gotong IM bridge')

    // ④ 恢复:正常回答 + 恢复播报恰一次 + 状态文件清掉
    agent.illness = 'ok'
    await bridge.inject(imMsg('好了吗'))
    expect(last(bridge).text).toBe('echo: 好了吗')
    expect(announced).toHaveLength(2)
    expect(announced[1]).toContain('恢复')
    expect(existsSync(outageFile)).toBe(false)

    // ⑤ 继续正常聊,不重复报平安
    await bridge.inject(imMsg('再聊一句'))
    expect(last(bridge).text).toBe('echo: 再聊一句')
    expect(announced).toHaveLength(2)

    // ⑥ 零 LLM 断言的结构面:agent 被调次数 = 自由文本条数(4),
    //    canned/播报文案没有任何一次额外调用(它们来自纯翻译表)。
    expect(agent.calls).toBe(4)
  })

  it('超时病 → canned 含超时文案;新一场断供重新播报', async () => {
    agent.illness = 'timeout'
    await bridge.inject(imMsg('慢死了'))
    expect(last(bridge).text).toContain('超时')
    expect(announced).toHaveLength(1)
    expect(announced[0]).toContain('超时')
  })

  it('认不出的业务错 → 走老 Task failed 路径(不装懂),不碰断供状态', async () => {
    agent.illness = 'weird'
    await bridge.inject(imMsg('干点啥'))
    expect(last(bridge).text).toContain('Task failed')
    expect(last(bridge).text).toContain('novel exploding business logic') // 原文兜底
    expect(announced).toHaveLength(0)                                     // 不算断供
    expect(existsSync(outageFile)).toBe(false)
  })

  it('llmOutage 未接线 → 老路径字节不变(加环节不惊扰存量部署)', async () => {
    // 重新拉一条不带 llmOutage 的 config——historic host 的形状。
    const bareBridge = new FakeBridge()
    const config: HostImConfig = {
      hub,
      resolver: makeIdentityImBindingResolver(identity),
      freeTextCapability: 'chat',
      onUnbind: async () => ({ removed: false }),
      log: silentLogger,
    }
    bareBridge.onMessage((m) => handleImMessage(bareBridge, m, config))
    agent.illness = 'auth'
    await bareBridge.inject(imMsg('hello'))
    expect(last(bareBridge).text).toContain('Task failed') // 原样转发,与今天一致
  })
})

/**
 * CARE-M5 — 主动恢复探活的接线门。补上 CARE-M2「恢复只在下一条用户消息成功
 * 时才播」的缺口:startImBridges 在 llmOutage.probeLiveness 存在时 arm 一个
 * cadence 定时器,断供期间自己探 provider 活体。全程零消息注入——证明 provider
 * 半夜恢复、无人发消息也能被发现。
 *
 * 用真定时器 + 极短注入节律(probeIntervalMs=5)+ promise 信号,避开 fake
 * timers 撞真 fs I/O(tracker 读盘)的死角;确定性靠「探针被调=resolve 一个
 * promise」与 stop() 同步 clearInterval,不靠壁钟。
 */
describe('CARE-M5 — 主动恢复探活(startImBridges 定时器,零消息注入)', () => {
  let dir: string
  let outageFile: string
  let hub: Hub
  let identity: IdentityStore
  let handle: Awaited<ReturnType<typeof startImBridges>>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-im-recover-'))
    outageFile = join(dir, 'runtime', 'llm-outage.json')
    hub = Hub.inMemory()
    await hub.start()
    identity = openIdentityStore({ dbPath: ':memory:' })
    handle = undefined
  })
  afterEach(async () => {
    await handle?.stop() // 幂等:clearInterval + 停桥。未 stop 的用例兜底,防定时器泄漏
    await hub.stop()
    identity.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
  /** 无 env 桥也返回 handle(hotStart)+ reachable 在 → 定时器 gate 全过;5ms 节律。 */
  const startWithProbe = (probeLiveness: () => Promise<boolean>) =>
    startImBridges({
      hub,
      identity,
      log: silentLogger,
      hotStart: true,
      reachableDir: join(dir, 'reachable'),
      llmOutage: {
        file: outageFile,
        lang: 'zh',
        butlerMemoryRoot: join(dir, 'butler', 'memory'),
        probeLiveness,
        probeIntervalMs: 5,
      },
    })

  it('断供中定时器自己探 provider(零消息)→ 探针被调;stop() 后不再探', async () => {
    // 预置一场 network 断供(file-first;host 的 tracker 会读到它)。
    expect(await new LlmOutageTracker(outageFile).onProviderFailure('network')).toBe('announce')
    expect(existsSync(outageFile)).toBe(true)

    let probeCalls = 0
    let resolveProbed!: () => void
    const probed = new Promise<void>((r) => { resolveProbed = r })
    handle = await startWithProbe(async () => {
      probeCalls++
      resolveProbed()
      return true
    })
    expect(handle).toBeDefined()

    await probed // 定时器自己触发了一次探活——全程没注入任何 IM 消息
    expect(probeCalls).toBeGreaterThanOrEqual(1)

    // stop() 同步 clearInterval;之后再等几个节律,探针数冻结。
    await handle!.stop()
    handle = undefined
    const frozen = probeCalls
    await delay(40) // 8 个 5ms 节律的真实窗口
    expect(probeCalls).toBe(frozen)
  })

  it('探针通 → tracker 边沿清断供文件(主动恢复的可观测副作用,零消息)', async () => {
    expect(await new LlmOutageTracker(outageFile).onProviderFailure('timeout')).toBe('announce')

    let resolveProbed!: () => void
    const probed = new Promise<void>((r) => { resolveProbed = r })
    handle = await startWithProbe(async () => {
      resolveProbed()
      return true
    })
    await probed
    // 探针在 checkOutageRecovery 里先于 onProviderSuccess;给恢复动作一点真实窗口落地。
    for (let i = 0; i < 20 && existsSync(outageFile); i++) await delay(5)
    expect(existsSync(outageFile)).toBe(false) // 主动清了——没有任何用户消息
  })

  it('健康(无断供文件)→ 定时器早退不探 provider(零成本)', async () => {
    let probeCalls = 0
    handle = await startWithProbe(async () => {
      probeCalls++
      return true
    })
    await delay(40) // 多个节律的真实窗口
    expect(probeCalls).toBe(0) // snapshot()=null 早退,根本不探
  })

  it('断供 kind = quota → skipped_kind,定时器不探,文件仍在(留给反应式)', async () => {
    expect(await new LlmOutageTracker(outageFile).onProviderFailure('quota')).toBe('announce')

    let probeCalls = 0
    handle = await startWithProbe(async () => {
      probeCalls++
      return true
    })
    await delay(40)
    expect(probeCalls).toBe(0) // 只读探针证伪不了配额恢复,不探
    expect(existsSync(outageFile)).toBe(true) // 断供仍在,等下一条真派发成功
  })

  it('probeLiveness 缺省 → 不 arm 定时器(存量部署零新增行为)', async () => {
    expect(await new LlmOutageTracker(outageFile).onProviderFailure('network')).toBe('announce')
    // 不传 probeLiveness:走 CARE-M2 老形状,主动路径整块不接。
    handle = await startImBridges({
      hub,
      identity,
      log: silentLogger,
      hotStart: true,
      reachableDir: join(dir, 'reachable'),
      llmOutage: {
        file: outageFile,
        lang: 'zh',
        butlerMemoryRoot: join(dir, 'butler', 'memory'),
        probeIntervalMs: 5,
      },
    })
    await delay(40)
    expect(existsSync(outageFile)).toBe(true) // 没有主动探活 → 断供纹丝不动
  })
})
