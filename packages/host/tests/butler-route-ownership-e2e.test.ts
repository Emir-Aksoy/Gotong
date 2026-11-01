/**
 * 消息和文件只发给现在还绑着这个账号的成员(e2e)。
 *
 * 可达表记的是成员上次从哪说话,解绑和换绑都不会更新它,重启后还在。发出去的东西收
 * 不回来,所以这一门走 startImBridges 的真接线和真 IdentityStore,证明文字推送和文件
 * 发送都核对绑定,对不上或读不出来都不发。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentParticipant, Hub, type Logger, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import type { ImBridge, ImMessage, ImOutboundFile, ImUser } from '@gotong/im-adapter'

import { ButlerOutbox } from '../src/butler-outbox.js'
import { startImBridges } from '../src/im-bridge.js'

const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const FILE: ImOutboundFile = { bytes: new Uint8Array([1, 2, 3]), filename: '报告.docx' }
const SECRET = '你的体检报告有异常,记得复查'
const NOT_OWNED = { delivered: false, reason: 'unknown_member' }
const OUTBOX_SWEEP_MS = 2 * 60 * 1000

class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly texts: Array<{ to: string; text: string; chatId?: string }> = []
  readonly files: Array<{ to: string; chatId?: string }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(to: ImUser, text: string, options?: { chatId?: string }): Promise<void> {
    this.texts.push({ to: to.platformUserId, text, ...(options?.chatId ? { chatId: options.chatId } : {}) })
  }
  async sendFile(to: ImUser, _file: ImOutboundFile, options?: { chatId?: string }): Promise<void> {
    this.files.push({ to: to.platformUserId, ...(options?.chatId ? { chatId: options.chatId } : {}) })
  }
  onMessage(listener: (msg: ImMessage) => void | Promise<void>): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
  async inject(msg: ImMessage): Promise<void> {
    if (this.listener) await this.listener(msg)
  }
}

class EchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'chat', capabilities: ['chat'] })
  }
  protected async handleTask(_task: Task): Promise<unknown> {
    return { text: 'ok' }
  }
}

const account = (id: string): ImUser => ({ platform: 'telegram', platformUserId: id, displayName: id })

describe('路由归属 — 不发给已经不属于成员的账号', () => {
  let dir: string
  let hub: Hub
  let identity: IdentityStore
  let handle: Awaited<ReturnType<typeof startImBridges>> | undefined
  let fake: FakeBridge
  let alice: string
  let bob: string
  const prevToken = process.env.GOTONG_TELEGRAM_BOT_TOKEN

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const secrets = () => fake.texts.filter((t) => t.text === SECRET)

  /** 文字和文件走同一处核对,每个场景两条都要过。 */
  const channels = [
    {
      name: '文字推送',
      send: (userId: string) => {
        const push = handle?.pushToMember
        if (!push) throw new Error('pushToMember 没接上')
        return push(userId, SECRET)
      },
      sent: () => secrets().map(({ to, chatId }) => ({ to, chatId })),
    },
    {
      name: '文件发送',
      send: (userId: string) => {
        const files = handle?.memberFiles
        if (!files) throw new Error('memberFiles 没接上')
        return files.push(userId, FILE)
      },
      sent: () => fake.files,
    },
  ]

  async function start(extra: Partial<Parameters<typeof startImBridges>[0]> = {}): Promise<void> {
    handle = await startImBridges({
      hub,
      identity,
      log: silentLogger,
      makeBridge: () => fake,
      reachableDir: join(dir, 'butler', 'reachable'),
      ...extra,
    })
  }

  /** 走真入站路径说一句话,可达表因此学到这个账号的私聊路由。 */
  async function speak(from: ImUser, text: string): Promise<void> {
    await fake.inject({
      from,
      text,
      chatId: `dm-${from.platformUserId}`,
      chatKind: 'direct',
      ts: 1_700_000_000_000,
    })
  }

  async function bind(userId: string, from: ImUser): Promise<void> {
    const { code } = identity.issueImBindingCode({ userId })
    fake.texts.length = 0
    await speak(from, `/bind ${code}`)
    for (let i = 0; i < 50 && !fake.texts.some((t) => t.text.includes('Bound')); i++) await delay(2)
    expect(fake.texts.some((t) => t.text.includes('Bound'))).toBe(true)
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-route-ownership-'))
    hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent())
    identity = openIdentityStore({ dbPath: ':memory:' })
    alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' }).id
    bob = identity.createUser({ email: 'bob@example.com', displayName: 'Bob' }).id
    process.env.GOTONG_TELEGRAM_BOT_TOKEN = 'test-token-route-ownership'
    fake = new FakeBridge()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await handle?.stop()
    handle = undefined
    await hub.stop()
    identity.close()
    if (prevToken === undefined) delete process.env.GOTONG_TELEGRAM_BOT_TOKEN
    else process.env.GOTONG_TELEGRAM_BOT_TOKEN = prevToken
    rmSync(dir, { recursive: true, force: true })
  })

  describe.each(channels)('$name', ({ send, sent }) => {
    beforeEach(async () => {
      await start()
    })

    it('绑定着:发到本人私聊', async () => {
      await bind(alice, account('2001'))
      expect(await send(alice)).toEqual({ delivered: true })
      expect(sent()).toEqual([{ to: '2001', chatId: 'dm-2001' }])
    })

    it('解绑后不发', async () => {
      await bind(alice, account('2001'))
      identity.removeImBinding('telegram', '2001')
      expect(await send(alice)).toEqual(NOT_OWNED)
      expect(sent()).toEqual([])
    })

    it('解绑后账号绑给别人:原成员的不发,新主人照常收', async () => {
      await bind(alice, account('2001'))
      identity.removeImBinding('telegram', '2001')
      await bind(bob, account('2001'))

      expect(await send(alice)).toEqual(NOT_OWNED)
      expect(sent()).toEqual([])

      expect(await send(bob)).toEqual({ delivered: true })
      expect(sent()).toEqual([{ to: '2001', chatId: 'dm-2001' }])
    })

    it('没解绑就被别人直接绑走:原成员的同样不发', async () => {
      await bind(alice, account('2001'))
      await bind(bob, account('2001'))
      expect(identity.getUserIdByImBinding('telegram', '2001')).toBe(bob)
      expect(await send(alice)).toEqual(NOT_OWNED)
      expect(sent()).toEqual([])
    })

    it('成员换了新账号:发到新账号', async () => {
      await bind(alice, account('2001'))
      identity.removeImBinding('telegram', '2001')
      await bind(alice, account('3001'))
      expect(await send(alice)).toEqual({ delivered: true })
      expect(sent()).toEqual([{ to: '3001', chatId: 'dm-3001' }])
    })

    it('重启后旧路由从盘上恢复,仍然要核对', async () => {
      await bind(alice, account('2001'))
      // 路由是异步落盘的,等它写完再重启。
      const routeFile = join(dir, 'butler', 'reachable', `${alice}.json`)
      const routeSaved = () => {
        try {
          return !!JSON.parse(readFileSync(routeFile, 'utf8'))
        } catch {
          return false
        }
      }
      for (let i = 0; i < 100 && !routeSaved(); i++) await delay(2)
      await handle?.stop()
      await start()
      // 对照:路由确实恢复了,下面的拒绝才是绑定核对挡下来的。
      expect(handle?.memberFiles?.canPush(alice)).toEqual({ ok: true })

      identity.removeImBinding('telegram', '2001')
      expect(await send(alice)).toEqual(NOT_OWNED)
      expect(sent()).toEqual([])
    })

    it('绑定查询失败时不发', async () => {
      await bind(alice, account('2001'))
      vi.spyOn(identity, 'getUserIdByImBinding').mockImplementation(() => {
        throw new Error('database is locked')
      })
      expect(await send(alice)).toEqual(NOT_OWNED)
      expect(sent()).toEqual([])
    })

    it('从没说过话的成员没有路由', async () => {
      expect(await send(alice)).toEqual(NOT_OWNED)
    })
  })

  it('文件探测跟着绑定变化', async () => {
    await start()
    await bind(alice, account('2001'))
    expect(handle?.memberFiles?.canPush(alice)).toEqual({ ok: true })
    identity.removeImBinding('telegram', '2001')
    expect(handle?.memberFiles?.canPush(alice)).toEqual({ ok: false, reason: 'unknown_member' })
  })

  describe('outbox', () => {
    const outboxFile = () => join(dir, 'butler', 'outbox', `${alice}.json`)

    it('换绑后排队的消息不补投给新主人,等本人回来发到新账号', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const sweep = vi.spyOn(ButlerOutbox.prototype, 'flushAll')
      await start({ outboxDir: join(dir, 'butler', 'outbox') })
      await bind(alice, account('2001'))
      identity.removeImBinding('telegram', '2001')

      expect(await handle?.pushToMember?.(alice, SECRET)).toEqual(NOT_OWNED)
      expect(readFileSync(outboxFile(), 'utf8')).toContain(SECRET)

      // 新主人绑定时只冲自己的队列;巡检会冲所有人的,也不能把 alice 的发出去。
      await bind(bob, account('2001'))
      vi.advanceTimersByTime(OUTBOX_SWEEP_MS)
      expect(sweep).toHaveBeenCalledTimes(1)
      await sweep.mock.results[0]?.value
      expect(secrets()).toEqual([])
      expect(readFileSync(outboxFile(), 'utf8')).toContain(SECRET)

      await bind(alice, account('3001'))
      for (let i = 0; i < 100 && secrets().length === 0; i++) await delay(2)
      expect(secrets().map(({ to, chatId }) => ({ to, chatId }))).toEqual([{ to: '3001', chatId: 'dm-3001' }])
    })
  })

  describe('Web Push 兜底', () => {
    it('路由失效时走成员自己的 Web Push,不发 IM', async () => {
      const tap = vi.fn(async () => ({ delivered: true as const }))
      await start({ webPushFallback: tap })
      await bind(alice, account('2001'))
      await bind(bob, account('2001'))

      expect(await handle?.pushToMember?.(alice, SECRET)).toEqual({ delivered: true })
      expect(tap).toHaveBeenCalledWith(alice)
      expect(secrets()).toEqual([])
    })
  })
})
