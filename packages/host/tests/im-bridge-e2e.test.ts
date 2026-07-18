/**
 * im-bridge-e2e — the GO-LIVE T1 acceptance gate.
 *
 * Proves the production IM fold end to end WITHOUT a real bot token: a
 * hermetic `FakeBridge` (in-memory `ImBridge`) drives the same
 * `handleImMessage` router the live Telegram bridge calls, against a real
 * `Hub` + real `IdentityStore`. The walk is the full member lifecycle:
 *
 *   /help (before bind) → free-text (nudged) → /bind <code> →
 *   free-text (echoed, dispatched with origin.userId) → /unbind →
 *   free-text (nudged again).
 *
 * The load-bearing assertions:
 *   - a bound free-text message dispatches a real Hub task whose
 *     `origin.userId` is the BOUND member (never the raw IM handle), so
 *     the quota gate / audit log attribute it correctly;
 *   - before/after binding, unbound users get the "/bind first" nudge —
 *     the binding IS the auth boundary;
 *   - `startImBridges` returns undefined with no token, so an existing
 *     deployment is byte-for-byte unaffected (the env gate works).
 *
 * When the operator later supplies a real `GOTONG_TELEGRAM_BOT_TOKEN`,
 * the only thing that changes is FakeBridge → TelegramBridge; this exact
 * router path is what runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Logger, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@gotong/im-adapter'

import {
  handleImMessage,
  foldHearingTranscriber,
  makeIdentityImBindingResolver,
  startImBridges,
  type HostImConfig,
} from '../src/im-bridge.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

// ---------------------------------------------------------------------------
// Hermetic in-memory bridge — the same `ImBridge` contract the six real
// `@gotong/im-*` bridges implement, minus the network.
// ---------------------------------------------------------------------------

class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly outbound: Array<{
    to: ImUser
    text: string
    chatId?: string
    /** VOICE-M3 — the RAW options object, so tests can assert the
     * `attachments` key is structurally absent (byte-identical contract). */
    options?: { attachments?: ImAttachment[]; chatId?: string }
  }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  started = false

  async start(): Promise<void> {
    this.started = true
  }
  async stop(): Promise<void> {
    this.started = false
  }
  async sendMessage(
    to: ImUser,
    text: string,
    options?: { attachments?: ImAttachment[]; chatId?: string },
  ): Promise<void> {
    this.outbound.push({ to, text, chatId: options?.chatId, options })
  }
  onMessage(listener: (msg: ImMessage) => void | Promise<void>): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }
  /** Test helper: deliver an inbound message to the subscribed listener. */
  async inject(msg: ImMessage): Promise<void> {
    if (this.listener) await this.listener(msg)
  }
}

// A pure-text "chat" agent. Captures every task it sees so the test can
// assert on `from` / `origin` without depending on Hub-internal shape.
const seenTasks: Task[] = []
class ChatEchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'chat', capabilities: ['chat'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    seenTasks.push(task)
    const payload = task.payload
    const text =
      typeof payload === 'object' && payload !== null && 'text' in payload
        ? String((payload as { text: unknown }).text)
        : '(no text)'
    return { text: `echo: ${text}` }
  }
}

const ALICE: ImUser = { platform: 'telegram', platformUserId: '1001', displayName: 'Alice' }

function imMsg(text: string): ImMessage {
  return { from: ALICE, text, chatId: 'private:1001', ts: 1_700_000_000_000 }
}

describe('GO-LIVE T1 — IM bridge fold (hermetic)', () => {
  let hub: Hub
  let identity: IdentityStore
  let bridge: FakeBridge
  let config: HostImConfig
  let aliceId: string
  let code: string

  beforeEach(async () => {
    seenTasks.length = 0
    hub = Hub.inMemory()
    await hub.start()
    hub.register(new ChatEchoAgent())

    identity = openIdentityStore({ dbPath: ':memory:' })
    const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
    aliceId = alice.id
    code = identity.issueImBindingCode({ userId: alice.id }).code

    bridge = new FakeBridge()
    await bridge.start()

    config = {
      hub,
      resolver: makeIdentityImBindingResolver(identity),
      freeTextCapability: 'chat',
      onUnbind: async (platform, platformUserId) => {
        const n = identity.removeImBinding(platform, platformUserId)
        return { removed: n > 0 }
      },
      log: silentLogger,
    }
    // Wire the bridge → router exactly like startImBridges does.
    bridge.onMessage((m) => handleImMessage(bridge, m, config))
  })

  afterEach(async () => {
    await bridge.stop()
    await hub.stop()
    identity.close()
  })

  it('walks the full member lifecycle and attributes dispatch to the bound user', async () => {
    // 1. /help works before binding — anyone can read it.
    await bridge.inject(imMsg('/help'))
    expect(last(bridge).text).toContain('Gotong IM bridge')
    expect(seenTasks).toHaveLength(0)

    // 2. free-text before binding → nudge, no dispatch.
    await bridge.inject(imMsg('hi there'))
    expect(last(bridge).text).toMatch(/bind/i)
    expect(seenTasks).toHaveLength(0)

    // 3. /bind <code> → bound.
    await bridge.inject(imMsg(`/bind ${code}`))
    expect(last(bridge).text).toContain('Bound')
    expect(last(bridge).text).toContain(aliceId)

    // 4. free-text after binding → echoed AND dispatched as the member.
    await bridge.inject(imMsg('what can you do?'))
    expect(last(bridge).text).toBe('echo: what can you do?')
    expect(seenTasks).toHaveLength(1)
    // The load-bearing claim: the bound member, not the raw IM handle.
    expect(seenTasks[0].origin?.userId).toBe(aliceId)
    expect(seenTasks[0].from).toBe('im:telegram:1001')

    // 5. /unbind → removed.
    await bridge.inject(imMsg('/unbind'))
    expect(last(bridge).text).toContain('Unbound')

    // 6. free-text after unbind → nudged again, no further dispatch.
    await bridge.inject(imMsg('still there?'))
    expect(last(bridge).text).toMatch(/bind/i)
    expect(seenTasks).toHaveLength(1)

    // The hub actually saw the dispatch (transcript is the audit trail).
    expect(hub.transcript.size()).toBeGreaterThan(0)
  })

  it('rejects a bogus bind code without binding', async () => {
    await bridge.inject(imMsg('/bind 000000'))
    expect(last(bridge).text).toContain('Bind failed')
    // Still unbound → free-text is nudged, not dispatched.
    await bridge.inject(imMsg('hello'))
    expect(last(bridge).text).toMatch(/bind/i)
    expect(seenTasks).toHaveLength(0)
  })
})

describe('GO-LIVE T1 — env gate (zero behaviour change when unset)', () => {
  // Every IM platform env the gate reads. The "all unset → undefined"
  // contract only holds when the test process has NONE of them set, so the
  // block saves + clears all four platforms (not just Telegram) and
  // restores them after — the QQ-in test below also sets some of these.
  const KEYS = [
    'GOTONG_TELEGRAM_BOT_TOKEN',
    'GOTONG_QQ_BOT_APPID',
    'GOTONG_QQ_BOT_SECRET',
    'GOTONG_QQ_WEBHOOK_PORT',
    'GOTONG_QQ_WEBHOOK_HOST',
    'GOTONG_QQ_WEBHOOK_PATH',
    'GOTONG_LARK_APP_ID',
    'GOTONG_LARK_APP_SECRET',
    'GOTONG_SLACK_APP_TOKEN',
    'GOTONG_SLACK_BOT_TOKEN',
  ]
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('returns undefined when no platform is configured', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    const identity = openIdentityStore({ dbPath: ':memory:' })
    try {
      const handle = await startImBridges({ hub, identity, log: silentLogger })
      expect(handle).toBeUndefined()
    } finally {
      identity.close()
      await hub.stop()
    }
  })

  it('env-gates QQ in independently of Telegram (official inbound webhook)', async () => {
    // QQ's official Bot API is webhook-only; GOTONG_QQ_WEBHOOK_PORT=0
    // disables the bridge's built-in listener so the test stays hermetic
    // (no socket bound, no network) while still proving the env gate wires
    // the QQ bridge into the shared `bridges` array with Telegram unset.
    process.env.GOTONG_QQ_BOT_APPID = '102000000'
    process.env.GOTONG_QQ_BOT_SECRET = 'test-secret-deadbeef'
    process.env.GOTONG_QQ_WEBHOOK_PORT = '0'

    const hub = Hub.inMemory()
    await hub.start()
    const identity = openIdentityStore({ dbPath: ':memory:' })
    try {
      const handle = await startImBridges({ hub, identity, log: silentLogger })
      expect(handle).toBeDefined()
      expect(handle!.bridges.map((b) => b.platform)).toEqual(['qq'])
      await handle!.stop()
    } finally {
      identity.close()
      await hub.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// IMA-M2 — the approval verbs (/inbox /approve /deny). The surface is a
// recording fake: the router's job is verb → surface call → bilingual text,
// nothing more (all authority lives behind the surface).
// ---------------------------------------------------------------------------

describe('IMA-M2 — IM approval verbs', () => {
  let hub: Hub
  let identity: IdentityStore
  let bridge: FakeBridge
  let config: HostImConfig

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    identity = openIdentityStore({ dbPath: ':memory:' })
    const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
    const code = identity.issueImBindingCode({ userId: alice.id }).code
    bridge = new FakeBridge()
    await bridge.start()
    config = {
      hub,
      resolver: makeIdentityImBindingResolver(identity),
      freeTextCapability: 'chat',
      onUnbind: async () => ({ removed: false }),
      log: silentLogger,
    }
    bridge.onMessage((m) => handleImMessage(bridge, m, config))
    await bridge.inject(imMsg(`/bind ${code}`))
  })

  afterEach(async () => {
    await bridge.stop()
    await hub.stop()
    identity.close()
  })

  it('replies "not enabled" for all three verbs when no surface is wired', async () => {
    for (const cmd of ['/inbox', '/approve abcd1234', '/deny abcd1234']) {
      await bridge.inject(imMsg(cmd))
      expect(last(bridge).text).toContain('未启用 IM 审批')
    }
  })

  it('lists pending rows with short ids and marks web-only ones', async () => {
    config.approvals = {
      listForIm: async () => [
        { shortId: 'aaaa1111', title: '删除 mailer', kind: 'approval', imApprovable: true },
        { shortId: 'bbbb2222', title: '发一封邮件', kind: 'approval', imApprovable: false },
      ],
      resolveByShortId: async () => ({ title: 'x' }),
    }
    await bridge.inject(imMsg('/inbox'))
    const text = last(bridge).text
    expect(text).toContain('[aaaa1111] 删除 mailer')
    expect(text).toContain('[bbbb2222] 发一封邮件 (需在网页处理 / web only)')
    expect(text).toContain('/approve <id>')
  })

  it('renders an explicit empty state', async () => {
    config.approvals = {
      listForIm: async () => [],
      resolveByShortId: async () => ({ title: 'x' }),
    }
    await bridge.inject(imMsg('/inbox'))
    expect(last(bridge).text).toContain('没有等你处理的事项')
  })

  it('routes /approve and /deny to the surface with the bound user + via tag', async () => {
    const calls: Array<{ userId: string; shortId: string; approved: boolean; via: string }> = []
    config.approvals = {
      listForIm: async () => [],
      resolveByShortId: async (args) => {
        calls.push(args)
        return { title: '删除 mailer' }
      },
    }
    await bridge.inject(imMsg('/approve aaaa1111'))
    expect(last(bridge).text).toBe('✓ 已批准 / Approved — 删除 mailer')
    await bridge.inject(imMsg('/deny aaaa1111'))
    expect(last(bridge).text).toBe('✓ 已拒绝 / Denied — 删除 mailer')
    expect(calls).toEqual([
      { userId: calls[0]!.userId, shortId: 'aaaa1111', approved: true, via: 'im:telegram' },
      { userId: calls[0]!.userId, shortId: 'aaaa1111', approved: false, via: 'im:telegram' },
    ])
    expect(calls[0]!.userId).not.toBe('') // the bound Gotong userId, not the IM handle
    expect(calls[0]!.userId).not.toBe(ALICE.platformUserId)
  })

  it('maps every gate code to an actionable bilingual line', async () => {
    const cases: Array<[string, string]> = [
      ['short_id_too_short', '至少要 4 位'],
      ['not_found', '没有找到匹配'],
      ['ambiguous', '完整编号'],
      ['web_only', '需要在网页上处理'],
      ['not_approval_kind', '填写具体内容'],
      ['already_resolved', '已经被处理过'],
      ['forbidden', '不归你处理'],
    ]
    for (const [code, expected] of cases) {
      config.approvals = {
        listForIm: async () => [],
        resolveByShortId: async () => {
          throw Object.assign(new Error(code), { code })
        },
      }
      await bridge.inject(imMsg('/approve aaaa1111'))
      expect(last(bridge).text, code).toContain(expected)
    }
  })

  it('falls back to the raw message for an unknown failure', async () => {
    config.approvals = {
      listForIm: async () => [],
      resolveByShortId: async () => {
        throw new Error('disk on fire')
      },
    }
    await bridge.inject(imMsg('/deny aaaa1111'))
    expect(last(bridge).text).toContain('处理失败')
    expect(last(bridge).text).toContain('disk on fire')
  })

  it('the /help text advertises the three verbs', async () => {
    await bridge.inject(imMsg('/help'))
    const text = last(bridge).text
    expect(text).toContain('/inbox')
    expect(text).toContain('/approve <id>')
    expect(text).toContain('/deny <id>')
  })

  it('a parked free-text reply points at /inbox when the surface is wired', async () => {
    // A hub with no participant for 'chat' is irrelevant here — we only need
    // the suspended summary path, so dispatch against a parking participant.
    const { SuspendTaskError } = await import('@gotong/core')
    class ParkingAgent extends AgentParticipant {
      constructor() {
        super({ id: 'parker', capabilities: ['chat'] })
      }
      protected async handleTask(): Promise<unknown> {
        throw new SuspendTaskError({ resumeAt: 9_999_999_999_000, state: {} })
      }
    }
    hub.register(new ParkingAgent())
    config.approvals = {
      listForIm: async () => [],
      resolveByShortId: async () => ({ title: 'x' }),
    }
    await bridge.inject(imMsg('请帮我删掉 mailer'))
    expect(last(bridge).text).toContain('/inbox')
    expect(last(bridge).text).toContain('/approve')
  })
})

// ---------------------------------------------------------------------------
// VOICE-M3 — TTS voice replies. Scope is deliberately narrow: ONLY the
// conversational OK reply speaks. Command output and failure/suspend
// telemetry carry copyable short codes (/approve <id>) that a voice bubble
// would destroy, so they stay text — and with no voice configured the
// sendMessage options must be structurally identical to before (no
// `attachments` key at all).
// ---------------------------------------------------------------------------

describe('VOICE-M3 — voice on the conversational OK reply only', () => {
  let hub: Hub
  let identity: IdentityStore
  let bridge: FakeBridge
  let config: HostImConfig
  let synthCalls: string[]
  let warns: Array<{ msg: string; data?: unknown }>

  const CLIP = Buffer.from('fake-opus-bytes')

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    hub.register(new ChatEchoAgent())
    seenTasks.length = 0
    identity = openIdentityStore({ dbPath: ':memory:' })
    const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
    const code = identity.issueImBindingCode({ userId: alice.id }).code
    bridge = new FakeBridge()
    await bridge.start()
    synthCalls = []
    warns = []
    config = {
      hub,
      resolver: makeIdentityImBindingResolver(identity),
      freeTextCapability: 'chat',
      onUnbind: async () => ({ removed: false }),
      log: {
        ...silentLogger,
        warn(msg: string, data?: unknown) {
          warns.push({ msg, data })
        },
      },
      voice: {
        synthesize: async (text: string) => {
          synthCalls.push(text)
          return { kind: 'clip' as const, bytes: CLIP }
        },
      },
    }
    bridge.onMessage((m) => handleImMessage(bridge, m, config))
    await bridge.inject(imMsg(`/bind ${code}`))
  })

  afterEach(async () => {
    await bridge.stop()
    await hub.stop()
    identity.close()
  })

  it('attaches an opus clip to the OK reply — text unchanged, synth fed the exact reply text', async () => {
    await bridge.inject(imMsg('hi'))
    const out = last(bridge)
    expect(out.text).toBe('echo: hi')
    expect(synthCalls).toEqual(['echo: hi'])
    expect(out.options?.attachments).toEqual([
      { kind: 'audio', bytes: CLIP, mime: 'audio/opus', filename: 'voice.opus' },
    ])
  })

  it('with no voice configured the options carry NO attachments key (byte-identical)', async () => {
    delete config.voice
    await bridge.inject(imMsg('hi'))
    const out = last(bridge)
    expect(out.text).toBe('echo: hi')
    expect('attachments' in (out.options ?? {})).toBe(false)
  })

  it('synthesis "failed" → warn once, text goes out alone; "skipped" stays quiet', async () => {
    config.voice = { synthesize: async () => ({ kind: 'failed', reason: 'TTS HTTP 500' }) }
    await bridge.inject(imMsg('hi'))
    expect(last(bridge).text).toBe('echo: hi')
    expect('attachments' in (last(bridge).options ?? {})).toBe(false)
    expect(warns.some((w) => w.msg.includes('synthesis failed'))).toBe(true)

    warns.length = 0
    config.voice = { synthesize: async () => ({ kind: 'skipped', reason: 'code block' }) }
    await bridge.inject(imMsg('hi again'))
    expect(last(bridge).text).toBe('echo: hi again')
    expect(warns).toHaveLength(0)
  })

  it('a synth that THROWS never eats the reply', async () => {
    config.voice = {
      synthesize: async () => {
        throw new Error('ffmpeg exploded')
      },
    }
    await bridge.inject(imMsg('hi'))
    expect(last(bridge).text).toBe('echo: hi')
    expect('attachments' in (last(bridge).options ?? {})).toBe(false)
    expect(warns.some((w) => w.msg.includes('synthesis threw'))).toBe(true)
  })

  it('failure and suspend telemetry stay text-only — synth is never called', async () => {
    // failed: an agent that throws → the ⚠️ failure line must stay copyable.
    class BoomAgent extends AgentParticipant {
      constructor() {
        super({ id: 'boom', capabilities: ['boomchat'] })
      }
      protected async handleTask(): Promise<unknown> {
        throw new Error('provider on fire')
      }
    }
    hub.register(new BoomAgent())
    config.freeTextCapability = 'boomchat'
    await bridge.inject(imMsg('hi'))
    expect(last(bridge).text).toContain('Task failed')
    expect(synthCalls).toHaveLength(0)
    expect('attachments' in (last(bridge).options ?? {})).toBe(false)

    // suspended: the park notice points at /me — also text-only.
    const { SuspendTaskError } = await import('@gotong/core')
    class ParkAgent extends AgentParticipant {
      constructor() {
        super({ id: 'parker2', capabilities: ['parkchat'] })
      }
      protected async handleTask(): Promise<unknown> {
        throw new SuspendTaskError({ resumeAt: 9_999_999_999_000, state: {} })
      }
    }
    hub.register(new ParkAgent())
    config.freeTextCapability = 'parkchat'
    await bridge.inject(imMsg('hi'))
    expect(synthCalls).toHaveLength(0)
    expect('attachments' in (last(bridge).options ?? {})).toBe(false)
  })

  it('command output stays text-only even with voice configured', async () => {
    await bridge.inject(imMsg('/help'))
    expect(last(bridge).text).toContain('Gotong IM bridge')
    expect(synthCalls).toHaveLength(0)
    expect('attachments' in (last(bridge).options ?? {})).toBe(false)
  })
})

// ASR-M3 — the hearing→transcriber fold that buildVaultablePlatformBridge
// hands the Lark bridge. Three-state mapping is the whole contract: text →
// transcript string, skipped (in-design: silence/oversize) → QUIET null,
// failed (infra) → warn + null. The absent-hearing side (no transcriber key
// at all ⇒ inbound byte-identical) is covered by im-lark's bridge tests;
// the unset-env side (no ButlerHearing at all) by butler-hearing tests.
describe('ASR-M3 — foldHearingTranscriber', () => {
  function warnCollector(): { warns: Array<{ msg: string; data?: unknown }>; log: Logger } {
    const warns: Array<{ msg: string; data?: unknown }> = []
    return {
      warns,
      log: { ...silentLogger, warn: (msg: string, data?: unknown) => void warns.push({ msg, data }) },
    }
  }

  it('text result becomes the transcript string (bytes pass through intact)', async () => {
    const { warns, log } = warnCollector()
    const seen: Buffer[] = []
    const fold = foldHearingTranscriber(
      { transcribe: async (bytes) => (seen.push(bytes), { kind: 'text', text: '明天提醒我交电费' }) },
      log,
    )
    await expect(fold(new Uint8Array([79, 103, 103, 83]))).resolves.toBe('明天提醒我交电费')
    expect(Array.from(seen[0]!)).toEqual([79, 103, 103, 83])
    expect(warns).toHaveLength(0)
  })

  it('skipped (silence / oversize — in-design) folds to null with ZERO warns', async () => {
    const { warns, log } = warnCollector()
    const fold = foldHearingTranscriber(
      { transcribe: async () => ({ kind: 'skipped', reason: '转写结果为空(可能是静音)' }) },
      log,
    )
    await expect(fold(new Uint8Array([1]))).resolves.toBeNull()
    expect(warns).toHaveLength(0)
  })

  it('failed (infra) folds to null AND warns with the reason', async () => {
    const { warns, log } = warnCollector()
    const fold = foldHearingTranscriber(
      { transcribe: async () => ({ kind: 'failed', reason: '未装 ffmpeg — 语音转写需要它转码 wav' }) },
      log,
    )
    await expect(fold(new Uint8Array([1]))).resolves.toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('transcription failed')
    expect(warns[0]!.data).toMatchObject({ reason: '未装 ffmpeg — 语音转写需要它转码 wav' })
  })
})

function last(bridge: FakeBridge): {
  to: ImUser
  text: string
  chatId?: string
  options?: { attachments?: ImAttachment[]; chatId?: string }
} {
  const out = bridge.outbound.at(-1)
  if (!out) throw new Error('no outbound message was sent')
  return out
}
