/**
 * WX-M2a — WechatBridge loop/ledger/cooldown behaviour with a scripted fake
 * client. No fetch, no timers longer than milliseconds (the 60-min cooldown
 * runs on an injected clock + faked setTimeout).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImMessage, ImUser } from '@gotong/im-adapter'

import { WechatBridge } from '../src/bridge.js'
import type {
  WechatGetUpdatesResp,
  WechatMessage,
  WechatSendTextParams,
} from '../src/index.js'
import type { WechatIlinkClient } from '../src/client.js'

type Step = { page?: Partial<WechatGetUpdatesResp>; error?: Error }

/** Scripted client: each getUpdates consumes one step; when the script runs
 *  out it parks (resolving an empty page only on abort — same contract as the
 *  real client), so a test can "deliver N pages then idle" without spinning. */
function makeClient(script: Step[]) {
  const getUpdatesCalls: Array<string | undefined> = []
  const sends: WechatSendTextParams[] = []
  const counts = { notifyStarts: 0, notifyStops: 0 }
  const client: WechatIlinkClient = {
    async getUpdates(params = {}) {
      getUpdatesCalls.push(params.getUpdatesBuf)
      const next = script.shift()
      if (!next) {
        return new Promise<WechatGetUpdatesResp>((resolve) => {
          const done = () =>
            resolve({ ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf ?? '' })
          if (params.abortSignal?.aborted) return done()
          params.abortSignal?.addEventListener('abort', done, { once: true })
        })
      }
      if (next.error) throw next.error
      return { ret: 0, msgs: [], get_updates_buf: '', ...next.page }
    },
    async sendTextMessage(p) {
      sends.push(p)
    },
    async getConfig() {
      throw new Error('unused in bridge tests')
    },
    async notifyStart() {
      counts.notifyStarts++
    },
    async notifyStop() {
      counts.notifyStops++
    },
    async fetchBotQrcode() {
      throw new Error('unused in bridge tests')
    },
    async pollQrcodeStatus() {
      throw new Error('unused in bridge tests')
    },
  }
  return { client, getUpdatesCalls, sends, counts }
}

let seq = 0
const userMsg = (
  from: string,
  text: string,
  ctx?: string,
  over: Partial<WechatMessage> = {},
): WechatMessage => ({
  seq: ++seq,
  message_id: 1000 + seq,
  from_user_id: from,
  to_user_id: 'bot-1',
  create_time_ms: 1_760_000_000_000 + seq,
  message_type: 1,
  message_state: 2,
  ...(ctx ? { context_token: ctx } : {}),
  item_list: [{ type: 1, text_item: { text } }],
  ...over,
})

const peer = (id: string): ImUser => ({ platform: 'wechat', platformUserId: id, displayName: null })

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WechatBridge', () => {
  it('delivers finished user messages and advances the string cursor', async () => {
    const { client, getUpdatesCalls } = makeClient([
      { page: { msgs: [userMsg('wxid-alice', '早')], get_updates_buf: 'C1' } },
      { page: { msgs: [userMsg('wxid-alice', '午')], get_updates_buf: 'C2' } },
    ])
    const got: ImMessage[] = []
    const bridge = new WechatBridge({ token: 't', client, retryBackoffMs: 1 })
    bridge.onMessage((m) => {
      got.push(m)
    })
    await bridge.start()
    await until(() => got.length === 2)
    await bridge.stop()

    expect(got.map((m) => m.text)).toEqual(['早', '午'])
    expect(getUpdatesCalls[0]).toBe('') // cold start
    expect(getUpdatesCalls[1]).toBe('C1')
    expect(getUpdatesCalls[2]).toBe('C2')
  })

  it('filters bot echoes / streaming frames, but a GENERATING frame still refreshes the ledger', async () => {
    const { client, sends } = makeClient([
      {
        page: {
          msgs: [
            userMsg('bot-1', '我自己的回声', 'CTX-BOT', { message_type: 2 }),
            userMsg('wxid-alice', '……', 'CTX-GEN', { message_state: 1 }),
            userMsg('wxid-bob', '在吗', 'CTX-B'),
          ],
        },
      },
    ])
    const got: ImMessage[] = []
    const bridge = new WechatBridge({ token: 't', client, retryBackoffMs: 1 })
    bridge.onMessage((m) => {
      got.push(m)
    })
    await bridge.start()
    await until(() => got.length === 1)

    // Only bob's finished message routed…
    expect(got[0]!.from.platformUserId).toBe('wxid-bob')
    // …but alice's dropped GENERATING frame still armed her reply window.
    await bridge.sendMessage(peer('wxid-alice'), '回 alice')
    expect(sends[0]).toMatchObject({ toUserId: 'wxid-alice', contextToken: 'CTX-GEN' })
    // The bot echo must NOT arm a window for the bot's own id.
    await expect(bridge.sendMessage(peer('bot-1'), 'x')).rejects.toThrow(/context_token/)
    await bridge.stop()
  })

  it('sendMessage is passive-reply honest: unknown peer throws, latest token wins and is echoed verbatim', async () => {
    const { client, sends } = makeClient([
      { page: { msgs: [userMsg('wxid-alice', '一', 'T1'), userMsg('wxid-alice', '二', 'T2')] } },
    ])
    const got: ImMessage[] = []
    const bridge = new WechatBridge({ token: 't', client, retryBackoffMs: 1 })
    bridge.onMessage((m) => {
      got.push(m)
    })

    // Before any inbound: honest refusal (the outbox retries later).
    await expect(bridge.sendMessage(peer('wxid-alice'), '主动推')).rejects.toThrow(
      /no context_token/,
    )

    await bridge.start()
    await until(() => got.length === 2)
    await bridge.sendMessage(peer('wxid-alice'), '收到')
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ toUserId: 'wxid-alice', text: '收到', contextToken: 'T2' })
    await bridge.stop()
  })

  it('reports unsupported outbound attachments but still sends the text', async () => {
    const { client, sends } = makeClient([
      { page: { msgs: [userMsg('wxid-alice', 'hi', 'T1')] } },
    ])
    const errors: unknown[] = []
    const bridge = new WechatBridge({
      token: 't',
      client,
      retryBackoffMs: 1,
      onError: (e) => errors.push(e),
    })
    const got: ImMessage[] = []
    bridge.onMessage((m) => {
      got.push(m)
    })
    await bridge.start()
    await until(() => got.length === 1)

    await bridge.sendMessage(peer('wxid-alice'), '文字照发', {
      attachments: [{ kind: 'file', url: 'file:///tmp/x.pdf', mime: null, filename: 'x.pdf' }],
    })
    expect(sends[0]!.text).toBe('文字照发')
    expect(errors.some((e) => String(e).includes('attachments not yet supported'))).toBe(true)
    await bridge.stop()
  })

  it('errcode -14 pauses ALL calls for 60 min (reported once) and self-heals after the window', async () => {
    vi.useFakeTimers()
    let clock = 1_000_000
    const { client, getUpdatesCalls } = makeClient([
      { page: { ret: -1, errcode: -14, errmsg: 'session timeout' } },
      { page: { msgs: [userMsg('wxid-alice', '恢复了', 'T-BACK')], get_updates_buf: 'AFTER' } },
    ])
    const errors: unknown[] = []
    const bridge = new WechatBridge({
      token: 't',
      client,
      retryBackoffMs: 1,
      now: () => clock,
      onError: (e) => errors.push(e),
    })
    const got: ImMessage[] = []
    bridge.onMessage((m) => {
      got.push(m)
    })
    await bridge.start()
    await vi.advanceTimersByTimeAsync(5) // first poll eats the -14 page

    expect(getUpdatesCalls).toHaveLength(1)
    expect(errors.filter((e) => String(e).includes('pausing all iLink calls'))).toHaveLength(1)

    // 29 minutes in: still paused — cooldown sleeps fire but no API call.
    clock += 29 * 60_000
    await vi.advanceTimersByTimeAsync(31_000)
    expect(getUpdatesCalls).toHaveLength(1)
    await expect(bridge.sendMessage(peer('wxid-alice'), 'x')).rejects.toThrow(/cooling down/)
    // …and no second report for the same incident.
    expect(errors.filter((e) => String(e).includes('pausing all iLink calls'))).toHaveLength(1)

    // Past the hour: polling resumes and the queued page flows.
    clock += 32 * 60_000
    await vi.advanceTimersByTimeAsync(31_000)
    expect(getUpdatesCalls.length).toBeGreaterThanOrEqual(2)
    expect(got.map((m) => m.text)).toEqual(['恢复了'])
    await bridge.stop()
  })

  it('stop() aborts the in-flight long-poll promptly; start/stop are idempotent', async () => {
    const { client, getUpdatesCalls, counts } = makeClient([]) // parks immediately
    const bridge = new WechatBridge({ token: 't', client, retryBackoffMs: 1 })
    await bridge.start()
    await bridge.start() // no second loop, no second notify
    await until(() => getUpdatesCalls.length === 1)

    const t0 = Date.now()
    await bridge.stop()
    expect(Date.now() - t0).toBeLessThan(500) // did not wait out a 35s hold
    await bridge.stop()

    await new Promise((r) => setTimeout(r, 20))
    expect(getUpdatesCalls).toHaveLength(1) // loop really exited
    expect(counts.notifyStarts).toBe(1)
    expect(counts.notifyStops).toBe(1)
  })

  it('a throwing listener is isolated: others still run, the loop survives', async () => {
    const { client } = makeClient([
      { page: { msgs: [userMsg('wxid-alice', '一')] } },
      { page: { msgs: [userMsg('wxid-alice', '二')] } },
    ])
    const errors: unknown[] = []
    const got: string[] = []
    const bridge = new WechatBridge({
      token: 't',
      client,
      retryBackoffMs: 1,
      onError: (e) => errors.push(e),
    })
    bridge.onMessage(() => {
      throw new Error('listener boom')
    })
    bridge.onMessage((m) => {
      got.push(m.text)
    })
    await bridge.start()
    await until(() => got.length === 2)
    await bridge.stop()

    expect(got).toEqual(['一', '二'])
    expect(errors.filter((e) => String(e).includes('listener boom'))).toHaveLength(2)
  })

  it('transient poll failures back off and keep the loop alive', async () => {
    const { client } = makeClient([
      { error: new Error('ECONNRESET') },
      { page: { msgs: [userMsg('wxid-alice', '还在')] } },
    ])
    const errors: unknown[] = []
    const got: ImMessage[] = []
    const bridge = new WechatBridge({
      token: 't',
      client,
      retryBackoffMs: 1,
      onError: (e) => errors.push(e),
    })
    bridge.onMessage((m) => {
      got.push(m)
    })
    await bridge.start()
    await until(() => got.length === 1)
    await bridge.stop()
    expect(errors.some((e) => String(e).includes('ECONNRESET'))).toBe(true)
  })

  it('non-zero ret pages are reported and do NOT advance the cursor', async () => {
    const { client, getUpdatesCalls } = makeClient([
      { page: { ret: 5, errmsg: 'server sad', get_updates_buf: 'POISON' } },
      { page: { msgs: [userMsg('wxid-alice', '好了')], get_updates_buf: 'OK' } },
    ])
    const errors: unknown[] = []
    const got: ImMessage[] = []
    const bridge = new WechatBridge({
      token: 't',
      client,
      retryBackoffMs: 1,
      onError: (e) => errors.push(e),
    })
    bridge.onMessage((m) => {
      got.push(m)
    })
    await bridge.start()
    await until(() => got.length === 1)
    await bridge.stop()

    expect(getUpdatesCalls[1]).toBe('') // retried with the OLD cursor, not POISON
    expect(errors.some((e) => String(e).includes('ret=5'))).toBe(true)
  })

  it('evicts the oldest ledger entry beyond capacity', async () => {
    const { client, sends } = makeClient([
      {
        page: {
          msgs: [userMsg('p1', 'a', 'T1'), userMsg('p2', 'b', 'T2'), userMsg('p3', 'c', 'T3')],
        },
      },
    ])
    const got: ImMessage[] = []
    const bridge = new WechatBridge({ token: 't', client, retryBackoffMs: 1, maxLedgerEntries: 2 })
    bridge.onMessage((m) => {
      got.push(m)
    })
    await bridge.start()
    await until(() => got.length === 3)
    await bridge.stop()

    await expect(bridge.sendMessage(peer('p1'), 'x')).rejects.toThrow(/no context_token/)
    await bridge.sendMessage(peer('p2'), 'y')
    await bridge.sendMessage(peer('p3'), 'z')
    expect(sends.map((s) => s.toUserId)).toEqual(['p2', 'p3'])
  })
})
