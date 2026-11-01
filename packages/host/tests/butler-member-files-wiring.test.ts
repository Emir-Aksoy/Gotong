/**
 * 文档只发给现在还绑着这个账号的成员(e2e)。
 *
 * 可达表记的是成员上次从哪说话,解绑和换绑都不会更新它,重启后还在。文件发出去收不
 * 回来,所以这一门走 startImBridges 的真接线和真 IdentityStore,证明 `memberFiles`
 * 在探测和发送前都核对绑定,对不上或读不出来都不发。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentParticipant, Hub, type Logger, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import type { ImBridge, ImMessage, ImOutboundFile, ImUser } from '@gotong/im-adapter'

import { startImBridges } from '../src/im-bridge.js'

const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const FILE: ImOutboundFile = { bytes: new Uint8Array([1, 2, 3]), filename: '报告.docx' }
const NOT_OWNED = { delivered: false, reason: 'unknown_member' }

class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly texts: string[] = []
  readonly files: Array<{ to: string; chatId?: string }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(_to: ImUser, text: string): Promise<void> {
    this.texts.push(text)
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

describe('memberFiles 接线 — 文件不发给已经不属于成员的账号', () => {
  let dir: string
  let hub: Hub
  let identity: IdentityStore
  let handle: Awaited<ReturnType<typeof startImBridges>> | undefined
  let fake: FakeBridge
  let alice: string
  let bob: string
  const prevToken = process.env.GOTONG_TELEGRAM_BOT_TOKEN

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const files = () => {
    const f = handle?.memberFiles
    if (!f) throw new Error('memberFiles 没接上')
    return f
  }

  async function start(): Promise<void> {
    handle = await startImBridges({
      hub,
      identity,
      log: silentLogger,
      makeBridge: () => fake,
      reachableDir: join(dir, 'butler', 'reachable'),
    })
  }

  /** 走真入站路径绑定,可达表因此学到这个账号的私聊路由。 */
  async function bind(userId: string, from: ImUser): Promise<void> {
    const { code } = identity.issueImBindingCode({ userId })
    fake.texts.length = 0
    await fake.inject({
      from,
      text: `/bind ${code}`,
      chatId: `dm-${from.platformUserId}`,
      chatKind: 'direct',
      ts: 1_700_000_000_000,
    })
    for (let i = 0; i < 50 && !fake.texts.some((t) => t.includes('Bound')); i++) await delay(2)
    expect(fake.texts.some((t) => t.includes('Bound'))).toBe(true)
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gotong-member-files-'))
    hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent())
    identity = openIdentityStore({ dbPath: ':memory:' })
    alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' }).id
    bob = identity.createUser({ email: 'bob@example.com', displayName: 'Bob' }).id
    process.env.GOTONG_TELEGRAM_BOT_TOKEN = 'test-token-member-files'
    fake = new FakeBridge()
    await start()
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

  it('绑定着:探测通过,文件发到本人私聊', async () => {
    await bind(alice, account('2001'))
    expect(files().canPush(alice)).toEqual({ ok: true })
    expect(await files().push(alice, FILE)).toEqual({ delivered: true })
    expect(fake.files).toEqual([{ to: '2001', chatId: 'dm-2001' }])
  })

  it('解绑后:探测和发送都拒绝,什么也没发出去', async () => {
    await bind(alice, account('2001'))
    identity.removeImBinding('telegram', '2001')
    expect(files().canPush(alice)).toEqual({ ok: false, reason: 'unknown_member' })
    expect(await files().push(alice, FILE)).toEqual(NOT_OWNED)
    expect(fake.files).toEqual([])
  })

  it('账号换绑给别人后,原成员的文件不会发到这个账号', async () => {
    await bind(alice, account('2001'))
    identity.removeImBinding('telegram', '2001')
    await bind(bob, account('2001'))

    expect(files().canPush(alice)).toEqual({ ok: false, reason: 'unknown_member' })
    expect(await files().push(alice, FILE)).toEqual(NOT_OWNED)
    expect(fake.files).toEqual([])

    // 现在的主人照常能收。
    expect(await files().push(bob, FILE)).toEqual({ delivered: true })
    expect(fake.files).toEqual([{ to: '2001', chatId: 'dm-2001' }])
  })

  it('成员换了新账号:发到新账号', async () => {
    await bind(alice, account('2001'))
    identity.removeImBinding('telegram', '2001')
    await bind(alice, account('3001'))
    expect(await files().push(alice, FILE)).toEqual({ delivered: true })
    expect(fake.files).toEqual([{ to: '3001', chatId: 'dm-3001' }])
  })

  it('重启后旧路由从盘上恢复,仍然要核对绑定', async () => {
    await bind(alice, account('2001'))
    // 路由是异步落盘的,等它写完再重启。
    const routeFile = join(dir, 'butler', 'reachable', `${alice}.json`)
    for (let i = 0; i < 100 && !existsSync(routeFile); i++) await delay(2)
    await handle?.stop()
    await start()
    // 对照:路由确实恢复了,下面的拒绝才是绑定核对挡下来的。
    expect(files().canPush(alice)).toEqual({ ok: true })

    identity.removeImBinding('telegram', '2001')
    expect(await files().push(alice, FILE)).toEqual(NOT_OWNED)
    expect(fake.files).toEqual([])
  })

  it('绑定查询失败时不发', async () => {
    await bind(alice, account('2001'))
    const lookup = vi.spyOn(identity, 'getUserIdByImBinding').mockImplementation(() => {
      throw new Error('database is locked')
    })
    expect(files().canPush(alice)).toEqual({ ok: false, reason: 'unknown_member' })
    expect(await files().push(alice, FILE)).toEqual(NOT_OWNED)
    expect(fake.files).toEqual([])
    lookup.mockRestore()
  })

  it('从没说过话的成员没有路由', async () => {
    expect(files().canPush(alice)).toEqual({ ok: false, reason: 'unknown_member' })
    expect(await files().push(alice, FILE)).toEqual(NOT_OWNED)
  })
})
