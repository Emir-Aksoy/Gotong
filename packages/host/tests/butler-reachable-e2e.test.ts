/**
 * F1 承重门 — the resident butler's outbound-push FOUNDATION.
 *
 * Inbound IM is reactive: the bot only ever replies on the message it was just
 * handed. The next butler milestones (approval push-back, reminders, morning
 * brief) need the opposite — reach a member OUT of band, with no inbound message
 * in hand. F1 is the primitive that closes that loop:
 *
 *   1. every inbound message from a BOUND member, driven through the REAL
 *      production router (`handleImMessage`), teaches the registry that member's
 *      freshest chat via `config.onReachable`;
 *   2. `registry.push(userId, text)` then delivers a line back to exactly that
 *      chat through the same bridge — the full learn-then-push loop;
 *   3. routes persist to `<dir>/<userId>.json` and rehydrate on `load()`, so a
 *      reminder set before a restart still has somewhere to fire after it;
 *   4. push returns a TYPED result (unknown_member / no_bridge / send_failed) so a
 *      caller can log an undeliverable reminder instead of losing it silently;
 *   5. no-leak by construction: a push reaches only that member's own chat.
 *
 * Drives the registry THROUGH `handleImMessage` (not just unit-poking `record`),
 * because F1's contract is "the production inbound path populates it" — the seam a
 * later milestone relies on. The hub is a one-method stub (the `free` branch only
 * calls `hub.dispatch`), so this stays hermetic: no real bridge, no token.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Hub, TaskResult } from '@gotong/core'
import type {
  ImBindingResolver,
  ImBridge,
  ImMessage,
  ImUser,
  ImOutboundFile,
} from '@gotong/im-adapter'

import {
  ButlerReachableRegistry,
  type ButlerReachableOptions,
} from '../src/butler-reachable.js'
import { handleImMessage, type HostImConfig, type ImLogger } from '../src/im-bridge.js'

const silentLogger: ImLogger = { info() {}, warn() {}, error() {} }

/** A fake bridge that records every outbound send — the target a push lands on. */
class FakeBridge implements ImBridge {
  readonly sent: Array<{ to: ImUser; text: string; chatId?: string }> = []
  private failNextSend = false
  constructor(readonly platform: string = 'telegram') {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(
    to: ImUser,
    text: string,
    options?: { chatId?: string },
  ): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false
      throw new Error('platform 503')
    }
    this.sent.push({ to, text, ...(options?.chatId !== undefined ? { chatId: options.chatId } : {}) })
  }
  onMessage(): () => void {
    return () => {}
  }
  /** Make the NEXT sendMessage throw once — to exercise the send_failed result. */
  failOnce(): void {
    this.failNextSend = true
  }
}

/**
 * A Map-backed binding resolver: `codes` maps a 6-digit code → userId (consumed by
 * `/bind`), `bindings` maps `platform:platformUserId` → userId (the live binding).
 */
function fakeResolver(bindings: Map<string, string>, codes: Map<string, string>): ImBindingResolver {
  return {
    async resolveUserId(platform, platformUserId) {
      return bindings.get(`${platform}:${platformUserId}`) ?? null
    },
    async claim({ code, platform, platformUserId }) {
      const userId = codes.get(code)
      if (!userId) return { ok: false, reason: 'invalid' }
      bindings.set(`${platform}:${platformUserId}`, userId)
      return { ok: true, userId }
    },
  }
}

/** A one-method hub stub — the `free` branch only ever calls `dispatch`. */
const stubHub = {
  async dispatch(): Promise<TaskResult> {
    return { kind: 'ok', output: { text: '收到' }, by: 'agent' } as TaskResult
  },
} as unknown as Hub

/** Build a `HostImConfig` whose `onReachable` feeds the given registry. */
function configFor(
  registry: ButlerReachableRegistry,
  resolver: ImBindingResolver,
): HostImConfig {
  return {
    hub: stubHub,
    resolver,
    freeTextCapability: 'chat',
    onUnbind: async () => ({ removed: false }),
    log: silentLogger,
    onReachable: (info) =>
      registry.record({
        userId: info.userId,
        platform: info.platform,
        platformUserId: info.from.platformUserId,
        displayName: info.from.displayName ?? null,
        ...(info.chatId !== undefined ? { chatId: info.chatId } : {}),
      }),
  }
}

function inbound(
  platformUserId: string,
  text: string,
  opts: { chatId?: string; displayName?: string } = {},
): ImMessage {
  return {
    from: {
      platform: 'telegram',
      platformUserId,
      ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
    },
    text,
    ...(opts.chatId !== undefined ? { chatId: opts.chatId } : {}),
  }
}

describe('F1 — butler outbound-push foundation', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gotong-butler-reachable-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function registry(overrides: Partial<ButlerReachableOptions> = {}): {
    reg: ButlerReachableRegistry
    bridge: FakeBridge
  } {
    const bridge = new FakeBridge('telegram')
    const reg = new ButlerReachableRegistry({
      dir,
      bridgeFor: (p) => (p === bridge.platform ? bridge : undefined),
      logger: silentLogger,
      ...overrides,
    })
    return { reg, bridge }
  }

  it('learns a route from a real inbound /bind, then pushes back to that same chat', async () => {
    const { reg, bridge } = registry()
    const resolver = fakeResolver(new Map(), new Map([['482913', 'alice']]))
    const config = configFor(reg, resolver)

    // Inbound: alice DMs `/bind 482913` from her chat. The production router binds
    // her AND records this chat as her reachable route.
    await handleImMessage(bridge, inbound('tg-alice', '/bind 482913', { chatId: 'dm:alice', displayName: 'Alice' }), config)
    await reg.flush()

    // The bind reply landed (proves the router ran end-to-end), and the registry
    // learned alice's route.
    expect(bridge.sent.map((s) => s.text).some((t) => t.includes('已绑定'))).toBe(true)
    const route = reg.routeFor('alice')
    expect(route).toMatchObject({ platform: 'telegram', platformUserId: 'tg-alice', chatId: 'dm:alice' })

    // ── the whole point of F1: push OUT of band to her last chat ───────────────
    bridge.sent.length = 0
    const result = await reg.push('alice', '提醒你:三点开会。')
    expect(result).toEqual({ delivered: true })
    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0]!.text).toBe('提醒你:三点开会。')
    expect(bridge.sent[0]!.to.platformUserId).toBe('tg-alice')
    expect(bridge.sent[0]!.chatId).toBe('dm:alice')
  })

  it('a bound member’s plain chat (the free path) also refreshes their route', async () => {
    const { reg, bridge } = registry()
    // alice is already bound; a plain "hello" resolves her and records the route.
    const resolver = fakeResolver(new Map([['telegram:tg-alice', 'alice']]), new Map())
    const config = configFor(reg, resolver)

    await handleImMessage(bridge, inbound('tg-alice', '你好', { chatId: 'dm:alice-2' }), config)
    await reg.flush()

    expect(reg.routeFor('alice')).toMatchObject({ chatId: 'dm:alice-2' })
  })

  it('persists a route so a reminder set before a restart still has somewhere to fire', async () => {
    const { reg, bridge } = registry()
    const resolver = fakeResolver(new Map(), new Map([['111111', 'alice']]))
    await handleImMessage(bridge, inbound('tg-alice', '/bind 111111', { chatId: 'dm:alice' }), configFor(reg, resolver))
    await reg.flush()

    // Restart: a brand-new registry over the SAME dir rehydrates the route.
    const reg2 = new ButlerReachableRegistry({
      dir,
      bridgeFor: (p) => (p === bridge.platform ? bridge : undefined),
      logger: silentLogger,
    })
    await reg2.load()
    expect(reg2.routeFor('alice')).toMatchObject({ platform: 'telegram', platformUserId: 'tg-alice', chatId: 'dm:alice' })

    // And the rehydrated registry can push — the restart-survival guarantee.
    const result = await reg2.push('alice', 'after restart')
    expect(result).toEqual({ delivered: true })
    expect(bridge.sent.at(-1)).toMatchObject({ text: 'after restart', chatId: 'dm:alice' })
  })

  it('returns a typed unknown_member when the member was never reached', async () => {
    const { reg } = registry()
    expect(await reg.push('nobody', 'x')).toEqual({ delivered: false, reason: 'unknown_member' })
  })

  it('returns a typed no_bridge when the platform bridge is gone', async () => {
    // A route exists, but no bridge is live for its platform (bridge crashed /
    // reconfigured) — the reminder can't be delivered right now, not lost.
    const reg = new ButlerReachableRegistry({
      dir,
      bridgeFor: () => undefined,
      logger: silentLogger,
    })
    reg.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg-alice', chatId: 'dm:alice' })
    expect(await reg.push('alice', 'x')).toEqual({ delivered: false, reason: 'no_bridge' })
  })

  it('returns a typed send_failed when the bridge throws', async () => {
    const { reg, bridge } = registry()
    reg.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg-alice', chatId: 'dm:alice' })
    bridge.failOnce()
    expect(await reg.push('alice', 'x')).toEqual({ delivered: false, reason: 'send_failed' })
  })

  it('no-leak: pushing to alice never reaches bob’s chat', async () => {
    const { reg, bridge } = registry()
    const resolver = fakeResolver(new Map(), new Map([['aaa', 'alice'], ['bbb', 'bob']]))
    const config = configFor(reg, resolver)
    await handleImMessage(bridge, inbound('tg-alice', '/bind aaa', { chatId: 'dm:alice' }), config)
    await handleImMessage(bridge, inbound('tg-bob', '/bind bbb', { chatId: 'dm:bob' }), config)
    await reg.flush()

    bridge.sent.length = 0
    await reg.push('alice', '只给 alice')

    expect(bridge.sent).toHaveLength(1)
    expect(bridge.sent[0]!.to.platformUserId).toBe('tg-alice')
    expect(bridge.sent[0]!.chatId).toBe('dm:alice')
    // bob's route is untouched and distinct.
    expect(reg.routeFor('bob')).toMatchObject({ platformUserId: 'tg-bob', chatId: 'dm:bob' })
  })

  it('GRP — a legacy route file without the direct marker loses its chatId on load', async () => {
    // Pre-GRP files carry no `chatKind` marker, so the persisted chatId could
    // be a GROUP room id (the old router recorded groups as routes). Trusting
    // it would put personal reminders in front of the whole room — the load
    // path must drop it and let the push fall back to the platformUserId DM.
    const { bridge } = registry()
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'alice.json'),
      JSON.stringify({
        platform: 'telegram',
        platformUserId: 'tg-alice',
        chatId: 'group:oc_room_9', // poisoned: a room, not her DM
        updatedAt: 123,
      }),
      'utf8',
    )

    const reg2 = new ButlerReachableRegistry({
      dir,
      bridgeFor: (p) => (p === bridge.platform ? bridge : undefined),
      logger: silentLogger,
    })
    await reg2.load()
    const route = reg2.routeFor('alice')
    expect(route).toMatchObject({ platform: 'telegram', platformUserId: 'tg-alice' })
    expect(route?.chatId).toBeUndefined()

    // The push still delivers — to her platformUserId DM, never the room.
    expect(await reg2.push('alice', '提醒')).toEqual({ delivered: true })
    expect(bridge.sent.at(-1)!.to.platformUserId).toBe('tg-alice')
    expect(bridge.sent.at(-1)!.chatId).toBeUndefined()
  })

  it('GRP — a route recorded today stamps the direct marker and survives reload intact', async () => {
    const { reg, bridge } = registry()
    reg.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg-alice', chatId: 'dm:alice' })
    await reg.flush()

    const reg2 = new ButlerReachableRegistry({
      dir,
      bridgeFor: (p) => (p === bridge.platform ? bridge : undefined),
      logger: silentLogger,
    })
    await reg2.load()
    expect(reg2.routeFor('alice')).toMatchObject({ chatId: 'dm:alice', chatKind: 'direct' })
  })

  it('a corrupt route file is skipped on load, never blocking the others', async () => {
    // Persist alice cleanly, then drop a garbage file for bob; load() keeps alice.
    const { reg, bridge } = registry()
    reg.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg-alice', chatId: 'dm:alice' })
    await reg.flush()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'bob.json'), '{ not valid json', 'utf8')

    const reg2 = new ButlerReachableRegistry({
      dir,
      bridgeFor: (p) => (p === bridge.platform ? bridge : undefined),
      logger: silentLogger,
    })
    await reg2.load()
    expect(reg2.routeFor('alice')).toMatchObject({ platformUserId: 'tg-alice' })
    expect(reg2.routeFor('bob')).toBeUndefined()
  })
})

describe('pushFile — 文件只到成员本人', () => {
  const FILE = { bytes: new Uint8Array([1, 2, 3]), filename: '报告.pptx' }

  class FileBridge extends FakeBridge {
    readonly files: Array<{ to: ImUser; filename: string; chatId?: string }> = []
    fail: Error | null = null
    async sendFile(to: ImUser, file: ImOutboundFile, options?: { chatId?: string }): Promise<void> {
      if (this.fail) throw this.fail
      this.files.push({ to, filename: file.filename, ...(options?.chatId !== undefined ? { chatId: options.chatId } : {}) })
    }
  }

  const registry = (bridge: ImBridge | undefined): ButlerReachableRegistry =>
    new ButlerReachableRegistry({
      dir: join(tmpdir(), `gotong-reach-file-${process.pid}-${Math.random().toString(36).slice(2)}`),
      bridgeFor: () => bridge,
      logger: silentLogger,
    })

  it('发到私聊路由', async () => {
    const bridge = new FileBridge()
    const reg = registry(bridge)
    reg.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg_a', chatId: 'dm:alice' })
    expect(reg.canPushFile('alice')).toEqual({ ok: true })
    expect(await reg.pushFile('alice', FILE)).toEqual({ delivered: true })
    expect(bridge.files).toEqual([
      {
        to: { platform: 'telegram', platformUserId: 'tg_a', displayName: null },
        filename: '报告.pptx',
        chatId: 'dm:alice',
      },
    ])
    await reg.flush()
  })

  it('真实入站链路:成员在群里说话,文件仍然发到私聊,群 id 进不了路由', async () => {
    const bridge = new FileBridge()
    const reg = registry(bridge)
    const bindings = new Map([['telegram:tg_a', 'alice']])
    const config = configFor(reg, fakeResolver(bindings, new Map()))
    await handleImMessage(
      bridge,
      { ...inbound('tg_a', '帮我做个 PPT', { chatId: 'group:oc_room_9' }), chatKind: 'group' },
      config,
    )
    expect(reg.routeFor('alice')?.chatId).toBeUndefined()
    await reg.pushFile('alice', FILE)
    expect(bridge.files[0]?.to.platformUserId).toBe('tg_a')
    expect(bridge.files[0]?.chatId).toBeUndefined()
    await reg.flush()
  })

  it('没有路由、没有桥、桥不支持,探测和发送都如实区分', async () => {
    const withBridge = registry(new FileBridge())
    expect(withBridge.canPushFile('ghost')).toEqual({ ok: false, reason: 'unknown_member' })
    expect(await withBridge.pushFile('ghost', FILE)).toEqual({ delivered: false, reason: 'unknown_member' })

    const noBridge = registry(undefined)
    noBridge.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg_a' })
    expect(noBridge.canPushFile('alice')).toEqual({ ok: false, reason: 'no_bridge' })
    expect(await noBridge.pushFile('alice', FILE)).toEqual({ delivered: false, reason: 'no_bridge' })
    await noBridge.flush()

    // FakeBridge 没实现 sendFile:其余平台都是这个形状。
    const textOnly = new FakeBridge()
    const unsupported = registry(textOnly)
    unsupported.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg_a' })
    expect(unsupported.canPushFile('alice')).toEqual({ ok: false, reason: 'unsupported' })
    expect(await unsupported.pushFile('alice', FILE)).toEqual({ delivered: false, reason: 'unsupported' })
    // 不支持时不能退化成发一句文字,否则成员以为收到了。
    expect(textOnly.sent).toHaveLength(0)
    await unsupported.flush()
  })

  it('发送失败带回平台错误,不抛', async () => {
    const bridge = new FileBridge()
    bridge.fail = new Error('code=99991672 缺少 im:resource 权限')
    const reg = registry(bridge)
    reg.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg_a' })
    expect(await reg.pushFile('alice', FILE)).toEqual({
      delivered: false,
      reason: 'send_failed',
      detail: 'code=99991672 缺少 im:resource 权限',
    })
    await reg.flush()
  })

  it('平台错误太长时截断:这段文字会进模型上下文', async () => {
    const bridge = new FileBridge()
    bridge.fail = new Error('错'.repeat(5000))
    const reg = registry(bridge)
    reg.record({ userId: 'alice', platform: 'telegram', platformUserId: 'tg_a' })
    const result = await reg.pushFile('alice', FILE)
    expect(result).toMatchObject({ delivered: false, reason: 'send_failed' })
    expect((result as { detail: string }).detail).toHaveLength(300)
    await reg.flush()
  })
})
