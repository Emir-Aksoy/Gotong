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
 * When the operator later supplies a real `AIPE_TELEGRAM_BOT_TOKEN`,
 * the only thing that changes is FakeBridge → TelegramBridge; this exact
 * router path is what runs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Logger, type Task } from '@aipehub/core'
import { openIdentityStore, type IdentityStore } from '@aipehub/identity'
import type {
  ImAttachment,
  ImBridge,
  ImMessage,
  ImUser,
} from '@aipehub/im-adapter'

import {
  handleImMessage,
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
// `@aipehub/im-*` bridges implement, minus the network.
// ---------------------------------------------------------------------------

class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly outbound: Array<{ to: ImUser; text: string; chatId?: string }> = []
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
    this.outbound.push({ to, text, chatId: options?.chatId })
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
    expect(last(bridge).text).toContain('AipeHub IM bridge')
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
  const KEY = 'AIPE_TELEGRAM_BOT_TOKEN'
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[KEY]
    delete process.env[KEY]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  })

  it('startImBridges returns undefined with no token', async () => {
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
})

function last(bridge: FakeBridge): { to: ImUser; text: string; chatId?: string } {
  const out = bridge.outbound.at(-1)
  if (!out) throw new Error('no outbound message was sent')
  return out
}
