/**
 * CARE-M8 承重门(e2e)— outbox 补投走 startImBridges 的真 onReachable 缝。
 *
 * butler-outbox.test.ts 单测了 ButlerOutbox 类本身;这一门证明它**接对了线**:
 *   1. startImBridges 把 `pushToMember` 接成 outbox.deliver —— out-of-band 推送
 *      失败(桥重连中)不再只是一行日志,而是落盘;
 *   2. 成员下次说话,生产入站路径(dispatchSafely → recordReachable → onReachable)
 *      触发 outbox.flush,把失联期间攒下的话补投到同一个 chat;
 *   3. 不给 outboxDir → 退回旧 best-effort:失败仍诚实报未投达,但不入盘
 *      (存量部署字节不变)。
 *
 * hermetic:makeBridge 注入 FakeBridge(不 long-poll 真 API),真 Hub + 真
 * IdentityStore + echo agent。断/复由 FakeBridge.failSends 布尔翻转;flush 是
 * fire-and-forget,用有界轮询等它落地,不靠壁钟。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Logger, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'

import { startImBridges } from '../src/im-bridge.js'

const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

/** In-memory bridge; `failSends` simulates a bridge mid-reconnect (send throws). */
class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly outbound: Array<{ to: ImUser; text: string; chatId?: string }> = []
  failSends = false
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(to: ImUser, text: string, options?: { attachments?: ImAttachment[]; chatId?: string }): Promise<void> {
    if (this.failSends) throw new Error('bridge mid-reconnect (503)')
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

class EchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'chat', capabilities: ['chat'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const p = task.payload
    const text = typeof p === 'object' && p !== null && 'text' in p ? String((p as { text: unknown }).text) : ''
    return { text: `echo: ${text}` }
  }
}

describe('CARE-M8 — outbox 补投(startImBridges 真 onReachable 缝)', () => {
  let dir: string
  let hub: Hub
  let identity: IdentityStore
  let handle: Awaited<ReturnType<typeof startImBridges>>
  let fake: FakeBridge
  let aliceId: string
  let bindCode: string
  const prevToken = process.env.GOTONG_TELEGRAM_BOT_TOKEN

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const ALICE: ImUser = { platform: 'telegram', platformUserId: '2001', displayName: 'Alice' }
  const msgFrom = (text: string): ImMessage => ({ from: ALICE, text, chatId: 'private:2001', ts: 1_700_000_000_000 })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-outbox-e2e-'))
    hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent())
    identity = openIdentityStore({ dbPath: ':memory:' })
    const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
    aliceId = alice.id
    bindCode = identity.issueImBindingCode({ userId: alice.id }).code
    // A live telegram token makes the factory fire; makeBridge keeps it hermetic.
    process.env.GOTONG_TELEGRAM_BOT_TOKEN = 'test-token-care-m8'
    fake = new FakeBridge()
  })

  afterEach(async () => {
    await handle?.stop()
    handle = undefined
    await hub.stop()
    identity.close()
    if (prevToken === undefined) delete process.env.GOTONG_TELEGRAM_BOT_TOKEN
    else process.env.GOTONG_TELEGRAM_BOT_TOKEN = prevToken
    rmSync(dir, { recursive: true, force: true })
  })

  /** Start the bridges and bind alice through the REAL inbound path (learns her route). */
  async function startAndBind(opts: { outbox: boolean }): Promise<void> {
    handle = await startImBridges({
      hub,
      identity,
      log: silentLogger,
      makeBridge: () => fake,
      reachableDir: join(dir, 'butler', 'reachable'),
      ...(opts.outbox ? { outboxDir: join(dir, 'butler', 'outbox') } : {}),
    })
    await fake.inject(msgFrom(`/bind ${bindCode}`))
    for (let i = 0; i < 50 && !fake.outbound.some((o) => o.text.includes('Bound')); i++) await delay(2)
    expect(fake.outbound.some((o) => o.text.includes('Bound'))).toBe(true)
    fake.outbound.length = 0 // forget the bind reply
  }

  it('推送失败入盘 → 成员再说话触发 onReachable flush → 补投,队列清空', async () => {
    await startAndBind({ outbox: true })
    const outboxFile = join(dir, 'butler', 'outbox', `${aliceId}.json`)

    // 桥断了(重连中):一次 out-of-band 推送失败 → pushToMember 报未投达,但落盘。
    fake.failSends = true
    const r = await handle!.pushToMember!(aliceId, '大脑坏了,我先按规则答你')
    expect(r.delivered).toBe(false)
    expect(existsSync(outboxFile)).toBe(true) // 入盘,没丢

    // 桥恢复 + 成员说话 → 真 onReachable → flush → 补投到同一个 chat。
    fake.failSends = false
    await fake.inject(msgFrom('在吗?'))
    for (let i = 0; i < 100 && !fake.outbound.some((o) => o.text.includes('大脑坏了')); i++) await delay(2)

    const redelivered = fake.outbound.find((o) => o.text.includes('大脑坏了'))
    expect(redelivered).toBeDefined()
    expect(redelivered!.chatId).toBe('private:2001') // 补到她自己那条最近的聊天
    expect(existsSync(outboxFile)).toBe(false) // 队列排空,不留空壳
  })

  it('outboxDir 缺省 → 失败只记日志、不入盘(旧 best-effort 字节不变)', async () => {
    await startAndBind({ outbox: false })

    fake.failSends = true
    const r = await handle!.pushToMember!(aliceId, 'x')
    expect(r.delivered).toBe(false) // 仍诚实报未投达

    // outbox 概念整块未接线 —— 目录都不该被创建。
    expect(existsSync(join(dir, 'butler', 'outbox'))).toBe(false)
  })
})
