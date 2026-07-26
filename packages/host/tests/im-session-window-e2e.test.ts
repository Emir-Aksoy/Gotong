/**
 * Session window × IM bridge — the "查一下 → 查什么?" continuity fix, proven
 * on the REAL inbound path (startImBridges → free case → hub.dispatch).
 *
 * Load-bearing claims:
 *   1. sessions absent → the free-text payload is byte-identical to before
 *      (`{prompt}` only, NO `history` key) — existing deployments unchanged.
 *   2. First message of a conversation: still no `history` key (empty history
 *      is omitted, not sent as `[]`), and the member's words are recorded
 *      BEFORE dispatch (said is said, even if the model then dies).
 *   3. Second message: `payload.history` carries the prior user+assistant
 *      turns and NEVER the current sentence (buildRequest appends that).
 *   4. The push-back seam (pushToMember → deliverToMember) records an
 *      assistant turn — an escalation result / broadcast the butler pushed
 *      out-of-band shows up in the next turn's history (the dual-brain
 *      black-hole fix: "expert answered X" is something the butler SAID).
 *
 * Uses the REAL ButlerSessionWindow over a temp dir — the same class the
 * wiring constructs — wrapped in a recorder so call ORDER is assertable.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Logger, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'
import { ButlerSessionWindow, type SessionMessage } from '@gotong/personal-butler'

import { startImBridges, type ImSessionSurface } from '../src/im-bridge.js'

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

// Echo agent that captures every payload so the test can assert the exact
// dispatch shape (history injected / omitted) without Hub internals.
const seenPayloads: unknown[] = []
class EchoAgent extends AgentParticipant {
  constructor() {
    super({ id: 'chat', capabilities: ['chat'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    seenPayloads.push(task.payload)
    const p = task.payload as { prompt?: unknown }
    return { text: `echo: ${String(p.prompt ?? '')}` }
  }
}

/** Delegates to a REAL window; records call order for the discipline asserts. */
class RecordingSessions implements ImSessionSurface {
  readonly events: string[] = []
  constructor(private readonly real: ButlerSessionWindow) {}
  async history(userId: string): Promise<SessionMessage[]> {
    this.events.push('history')
    return this.real.history(userId)
  }
  async append(userId: string, role: 'user' | 'assistant', text: string): Promise<void> {
    this.events.push(`append:${role}:${text}`)
    await this.real.append(userId, role, text)
  }
}

describe('session window × IM bridge (free case + push-back seam)', () => {
  let dir: string
  let hub: Hub
  let identity: IdentityStore
  let handle: Awaited<ReturnType<typeof startImBridges>> | undefined
  let fake: FakeBridge
  let sessions: RecordingSessions
  let aliceId: string
  let bindCode: string
  const prevToken = process.env.GOTONG_TELEGRAM_BOT_TOKEN

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const ALICE: ImUser = { platform: 'telegram', platformUserId: '3001', displayName: 'Alice' }
  const msgFrom = (text: string): ImMessage => ({ from: ALICE, text, chatId: 'private:3001', ts: 1_700_000_000_000 })

  beforeEach(async () => {
    seenPayloads.length = 0
    dir = mkdtempSync(join(tmpdir(), 'gotong-im-session-'))
    hub = Hub.inMemory()
    await hub.start()
    hub.register(new EchoAgent())
    identity = openIdentityStore({ dbPath: ':memory:' })
    const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
    aliceId = alice.id
    bindCode = identity.issueImBindingCode({ userId: alice.id }).code
    process.env.GOTONG_TELEGRAM_BOT_TOKEN = 'test-token-session-window'
    fake = new FakeBridge()
    sessions = new RecordingSessions(
      new ButlerSessionWindow({ rootDir: join(dir, 'butler', 'sessions'), logger: { warn: () => {} } }),
    )
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

  async function startAndBind(opts: { sessions?: ImSessionSurface; reachable?: boolean } = {}): Promise<void> {
    handle = await startImBridges({
      hub,
      identity,
      log: silentLogger,
      makeBridge: () => fake,
      // Mirrors the production wiring — only the GRP group path reads this.
      memberName: (id) => identity.getUserById(id)?.displayName ?? null,
      ...(opts.reachable ? { reachableDir: join(dir, 'butler', 'reachable') } : {}),
      ...(opts.sessions ? { sessions: opts.sessions } : {}),
    })
    await fake.inject(msgFrom(`/bind ${bindCode}`))
    for (let i = 0; i < 50 && !fake.outbound.some((o) => o.text.includes('Bound')); i++) await delay(2)
    expect(fake.outbound.some((o) => o.text.includes('Bound'))).toBe(true)
    fake.outbound.length = 0
  }

  /** Inbound dispatch is fire-and-forget (`void dispatchSafely`) — send a
   *  free-text line and wait (bounded) until its reply lands. */
  async function say(text: string): Promise<void> {
    const before = fake.outbound.length
    await fake.inject(msgFrom(text))
    for (let i = 0; i < 200 && fake.outbound.length === before; i++) await delay(2)
    expect(fake.outbound.length).toBeGreaterThan(before)
  }

  it('sessions absent → payload is {prompt} only, no history key (byte-identical)', async () => {
    await startAndBind()
    await say('你好')
    expect(seenPayloads).toHaveLength(1)
    expect(seenPayloads[0]).toEqual({ prompt: '你好' })
    expect(Object.keys(seenPayloads[0] as object)).not.toContain('history')
  })

  it('first message: empty history omitted; the user turn lands BEFORE dispatch', async () => {
    await startAndBind({ sessions })
    await say('帮我查个东西')

    expect(seenPayloads).toHaveLength(1)
    expect(seenPayloads[0]).toEqual({ prompt: '帮我查个东西' }) // no history key
    // Discipline: read history → record the member's words → (dispatch) → record the reply.
    expect(sessions.events).toEqual([
      'history',
      'append:user:帮我查个东西',
      'append:assistant:echo: 帮我查个东西',
    ])
  })

  it('second message rides the prior turns as payload.history, excluding itself', async () => {
    await startAndBind({ sessions })
    await say('明天天气如何?')
    await say('查一下')

    expect(seenPayloads).toHaveLength(2)
    const second = seenPayloads[1] as { prompt: string; history?: SessionMessage[] }
    expect(second.prompt).toBe('查一下')
    // The model now SEES its own question — the "查一下 → 查什么?" fix.
    expect(second.history).toEqual([
      { role: 'user', content: '明天天气如何?' },
      { role: 'assistant', content: 'echo: 明天天气如何?' },
    ])
    // And the current sentence is NOT inside history (buildRequest appends it).
    expect(second.history!.some((m) => m.content === '查一下')).toBe(false)
  })

  it('push-back (pushToMember) records an assistant turn → next history includes it', async () => {
    await startAndBind({ sessions, reachable: true })
    await say('转派给专家吧')

    // Out-of-band push — the escalate result / run broadcast path.
    const r = await handle!.pushToMember!(aliceId, '「专家」办完了:报告在此')
    expect(r.delivered).toBe(true)
    expect(sessions.events).toContain('append:assistant:「专家」办完了:报告在此')

    // The member's next message sees the pushed line as something the butler SAID.
    await say('收到,继续')
    const next = seenPayloads[seenPayloads.length - 1] as { history?: SessionMessage[] }
    const assistantSaid = (next.history ?? []).filter((m) => m.role === 'assistant').map((m) => m.content)
    expect(assistantSaid.join('\n')).toContain('「专家」办完了:报告在此')
  })

  // ── GRP — group chats ────────────────────────────────────────────────────

  const BOB: ImUser = { platform: 'telegram', platformUserId: '3002', displayName: 'Bob' }
  const GROUP_CHAT = 'grp:100'
  const groupMsg = (from: ImUser, text: string): ImMessage => ({
    from,
    text,
    chatId: GROUP_CHAT,
    chatKind: 'group',
    ts: 1_700_000_000_000,
  })

  async function bindBob(): Promise<string> {
    const bob = identity.createUser({ email: 'bob@example.com', displayName: 'Bob' })
    const code = identity.issueImBindingCode({ userId: bob.id }).code
    const before = fake.outbound.length
    await fake.inject({ from: BOB, text: `/bind ${code}`, chatId: 'private:3002', ts: 1_700_000_000_000 })
    for (let i = 0; i < 50 && fake.outbound.length === before; i++) await delay(2)
    fake.outbound.length = 0 // 同 startAndBind:绑定回执不算进后续断言
    return bob.id
  }

  async function sayIn(msg: ImMessage): Promise<void> {
    const before = fake.outbound.length
    await fake.inject(msg)
    for (let i = 0; i < 200 && fake.outbound.length === before; i++) await delay(2)
    expect(fake.outbound.length).toBeGreaterThan(before)
  }

  it('GRP: a group shares ONE room-scoped window — speakers see each other, turns carry names', async () => {
    await startAndBind({ sessions })
    await bindBob()

    await sayIn(groupMsg(ALICE, '今晚聚餐哪家好?'))
    await sayIn(groupMsg(BOB, '要不火锅?'))

    // Bob's dispatch: his own sentence is name-prefixed (episodic capture
    // stays correctly attributed), and history carries ALICE's group turn —
    // the room is one conversation, not per-speaker amnesia.
    const bobPayload = seenPayloads[seenPayloads.length - 1] as {
      prompt: string
      history?: SessionMessage[]
    }
    expect(bobPayload.prompt).toBe('Bob: 要不火锅?')
    expect(bobPayload.history).toEqual([
      { role: 'user', content: 'Alice: 今晚聚餐哪家好?' },
      { role: 'assistant', content: 'echo: Alice: 今晚聚餐哪家好?' },
    ])
    // Replies went to the group chat, not a DM.
    expect(fake.outbound.every((o) => o.chatId === GROUP_CHAT)).toBe(true)
  })

  it('GRP: the group window and the personal DM window are separate conversations', async () => {
    await startAndBind({ sessions })
    await sayIn(groupMsg(ALICE, '群里聊的事'))

    // Alice then DMs — her personal window never saw the group exchange:
    // first DM of a fresh conversation ⇒ no history key at all, unprefixed.
    await say('私聊问一句')
    const dm = seenPayloads[seenPayloads.length - 1] as { prompt: string; history?: unknown }
    expect(dm.prompt).toBe('私聊问一句')
    expect(dm.history).toBeUndefined()
  })

  it('GRP: a group is NOT a personal push address — pushes fall back to DM', async () => {
    await startAndBind({ sessions, reachable: true })

    // Alice's freshest interaction is a GROUP message. The reachable route
    // must not point at the room: a personal push (approval reminder /
    // escalation result) would land in front of the whole group.
    await sayIn(groupMsg(ALICE, '在群里说了句话'))
    fake.outbound.length = 0
    const pushed = await handle!.pushToMember!(aliceId, '你的审批提醒')
    expect(pushed.delivered).toBe(true)
    expect(fake.outbound[fake.outbound.length - 1]!.chatId).toBeUndefined()

    // After a DM, the route carries the DM chat again.
    await say('回到私聊')
    fake.outbound.length = 0
    const pushed2 = await handle!.pushToMember!(aliceId, '第二条提醒')
    expect(pushed2.delivered).toBe(true)
    expect(fake.outbound[fake.outbound.length - 1]!.chatId).toBe('private:3001')
  })
})
