/**
 * setting-im-e2e (setting-ops M5) — the IM surface of the unified deterministic
 * `setting` ops console, proven WITHOUT a real bot token.
 *
 * The same hermetic `FakeBridge` the GO-LIVE T1 gate uses drives the production
 * `handleImMessage` router, now with `config.setting` wired: an operator DMs
 * `/setting` to enter a conversational command mode, then types ops subcommands
 * until `exit`. A real `Hub` + real `IdentityStore` back the bindings; the ops
 * engine is a canned `ImSettingOps` that emulates ops-core's tier chokepoint
 * exactly as the web M4 test does — read / safe-mutate return lines, while
 * config-write and destructive-offline THROW an OpsTierError-shaped error whose
 * `.message` already says where the refused tier must run instead.
 *
 * The load-bearing assertions (the plan's M5 acceptance gate):
 *   - an UNBOUND `/setting` is nudged to `/bind` first (the binding IS the gate);
 *   - a bound NON-operator is refused 「命令模式仅限管理员」 (D3);
 *   - an OPERATOR enters command mode and sees the runnable catalog;
 *   - in mode, `status` (read) returns the snapshot;
 *   - in mode, `restore` (destructive-offline) and `config-set` (config-write)
 *     are REFUSED, each carrying the right "run it on the CLI / as owner" hint —
 *     the IM face can never write config or run a destructive op, by construction;
 *   - `exit` leaves the console, after which free-text dispatches normally again;
 *   - with the console WIRED, every existing branch (`/help`, free-text) is still
 *     byte-for-byte unchanged when the sender is neither triggering nor in mode.
 *
 * When the operator later supplies a real `GOTONG_TELEGRAM_BOT_TOKEN` and wires the
 * real ops-core runner, the only things that change are FakeBridge → TelegramBridge
 * and the canned ops → `runOpsCommand({surface:'im',…})`; this exact console path
 * is what runs. The real-stack physical boundary (a true restore on the CLI) is the
 * M6 e2e — here we pin the IM seam only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AgentParticipant, Hub, type Logger, type Task } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'

import {
  handleImMessage,
  makeIdentityImBindingResolver,
  type HostImConfig,
  type ImSettingOps,
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
  readonly outbound: Array<{ to: ImUser; text: string; chatId?: string }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
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
  /** Deliver an inbound message to the subscribed listener. */
  async inject(msg: ImMessage): Promise<void> {
    if (this.listener) await this.listener(msg)
  }
}

// A pure-text "chat" agent so the post-exit free-text path actually dispatches
// (proving the existing branches still run once the console releases the message).
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

// ---------------------------------------------------------------------------
// A canned ops runner that emulates ops-core's tier chokepoint for surface='im':
// read + safe-mutate return lines; config-write + destructive-offline THROW an
// OpsTierError-shaped error (`.code` + a `.message` that names where to run it).
// Identical idiom to the web M4 route test's stub surface.
// ---------------------------------------------------------------------------

function tierError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code: string }
  e.code = code
  return e
}

function makeFakeOps(): ImSettingOps {
  return {
    list() {
      return [
        { id: 'status', tier: 'read', title: 'hub 状态快照', runnableHere: true },
        { id: 'fix-dirs', tier: 'safe-mutate', title: '建缺失目录', runnableHere: true },
        {
          id: 'config-set',
          tier: 'config-write',
          title: '写托管 env 旋钮',
          runnableHere: false,
          whereToRun: 'owner 在网页/CLI 改',
        },
        {
          id: 'restore',
          tier: 'destructive-offline',
          title: '从备份恢复',
          runnableHere: false,
          whereToRun: '去服务器 CLI 跑',
        },
      ]
    },
    async run(id, args) {
      if (id === 'status') return { lines: ['hub: up', 'agents: 1'] }
      if (id === 'fix-dirs') return { lines: [`created 0 dir(s) (args: ${args.join(' ')})`] }
      // The chokepoint: the IM caller (surface='im', allowConfigWrite=false) can
      // never reach these — ops-core throws, and the message says where instead.
      if (id === 'restore') {
        throw tierError('destructive_offline_cli_only', 'restore is CLI-only — run it from the server CLI')
      }
      if (id === 'config-set') {
        throw tierError('config_write_not_permitted', 'config-set needs the hub owner on the web UI or server CLI')
      }
      throw tierError('unknown_command', `unknown command: ${id}`)
    },
  }
}

// ---------------------------------------------------------------------------

const ALICE: ImUser = { platform: 'telegram', platformUserId: '2001', displayName: 'Alice' }
const BOB: ImUser = { platform: 'telegram', platformUserId: '2002', displayName: 'Bob' }
const CAROL: ImUser = { platform: 'telegram', platformUserId: '2003', displayName: 'Carol' }

function msgFrom(user: ImUser, text: string): ImMessage {
  return { from: user, text, chatId: `private:${user.platformUserId}`, ts: 1_700_000_000_000 }
}

describe('setting-ops M5 — IM `/setting` command console (hermetic)', () => {
  let hub: Hub
  let identity: IdentityStore
  let bridge: FakeBridge
  let config: HostImConfig
  let mode: Map<string, boolean>
  let operators: Set<string>
  let aliceId: string
  let bobId: string

  beforeEach(async () => {
    seenTasks.length = 0
    hub = Hub.inMemory()
    await hub.start()
    hub.register(new ChatEchoAgent())

    identity = openIdentityStore({ dbPath: ':memory:' })
    aliceId = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' }).id
    bobId = identity.createUser({ email: 'bob@example.com', displayName: 'Bob' }).id

    // Alice is an operator; Bob is a bound-but-ordinary member. Carol stays unbound.
    operators = new Set([aliceId])
    mode = new Map<string, boolean>()

    bridge = new FakeBridge()
    config = {
      hub,
      resolver: makeIdentityImBindingResolver(identity),
      freeTextCapability: 'chat',
      onUnbind: async (platform, platformUserId) => {
        const n = identity.removeImBinding(platform, platformUserId)
        return { removed: n > 0 }
      },
      log: silentLogger,
      setting: {
        isOperator: (userId) => operators.has(userId),
        mode,
        ops: makeFakeOps(),
      },
    }
    bridge.onMessage((m) => handleImMessage(bridge, m, config))

    // Bind Alice and Bob through the real router path (the same `/bind` branch the
    // live bridge runs — proving it still works with the console wired).
    await bridge.inject(msgFrom(ALICE, `/bind ${identity.issueImBindingCode({ userId: aliceId }).code}`))
    await bridge.inject(msgFrom(BOB, `/bind ${identity.issueImBindingCode({ userId: bobId }).code}`))
    bridge.outbound.length = 0
  })

  afterEach(async () => {
    await hub.stop()
    identity.close()
  })

  it('nudges an UNBOUND /setting to bind first (binding is the gate)', async () => {
    await bridge.inject(msgFrom(CAROL, '/setting'))
    expect(last(bridge).text).toMatch(/bind/i)
    // Carol has no userId, so she can never be put into command mode.
    expect([...mode.values()]).not.toContain(true)
  })

  it('refuses a bound NON-operator with the 管理员-only message (D3)', async () => {
    await bridge.inject(msgFrom(BOB, '/setting'))
    expect(last(bridge).text).toContain('命令模式仅限管理员')
    expect(mode.get(bobId)).not.toBe(true)
  })

  it('an OPERATOR walks the console: enter → status → refusals → help → exit → free-text', async () => {
    // 1. /setting → enter command mode + see the runnable (read + safe-mutate) catalog.
    await bridge.inject(msgFrom(ALICE, '/setting'))
    expect(mode.get(aliceId)).toBe(true)
    expect(last(bridge).text).toContain('进入命令模式')
    expect(last(bridge).text).toContain('status')

    // 2. in mode, `status` (read) returns the snapshot.
    await bridge.inject(msgFrom(ALICE, 'status'))
    expect(last(bridge).text).toContain('hub: up')

    // 3. in mode, `restore` (destructive-offline) is REFUSED with a "run on the CLI" hint.
    await bridge.inject(msgFrom(ALICE, 'restore'))
    expect(last(bridge).text).toContain('✗')
    expect(last(bridge).text).toMatch(/CLI/i)

    // 4. in mode, `config-set` (config-write) is REFUSED with an owner/web/CLI hint.
    await bridge.inject(msgFrom(ALICE, 'config-set GOTONG_MODE team'))
    expect(last(bridge).text).toContain('✗')
    expect(last(bridge).text).toMatch(/owner/i)

    // 5. `help` lists the FULL catalog — the refused tiers shown with a × mark.
    await bridge.inject(msgFrom(ALICE, 'help'))
    expect(last(bridge).text).toContain('×')
    expect(last(bridge).text).toContain('restore')
    expect(last(bridge).text).toContain('config-set')

    // 6. `exit` leaves the console.
    await bridge.inject(msgFrom(ALICE, 'exit'))
    expect(mode.get(aliceId)).not.toBe(true)
    expect(last(bridge).text).toContain('已退出命令模式')

    // 7. after exit, free-text dispatches as the bound member again (existing
    //    branch untouched — the console only claims trigger / in-mode lines).
    expect(seenTasks).toHaveLength(0)
    await bridge.inject(msgFrom(ALICE, 'hello there'))
    expect(last(bridge).text).toBe('echo: hello there')
    expect(seenTasks).toHaveLength(1)
    expect(seenTasks[0].origin?.userId).toBe(aliceId)
  })

  it('leaves existing branches byte-for-byte: /help works with the console wired', async () => {
    // Alice is NOT in command mode → /help is not a `/setting` trigger → the
    // console returns false and the normal router answers with the help text.
    await bridge.inject(msgFrom(ALICE, '/help'))
    expect(last(bridge).text).toContain('Gotong IM bridge')
    expect(mode.get(aliceId)).not.toBe(true)
  })

  it('accepts a leading-slash verb inside the console (/status ≡ status)', async () => {
    await bridge.inject(msgFrom(ALICE, '/setting'))
    bridge.outbound.length = 0
    // muscle-memory slash on the verb still resolves to the same ops id.
    await bridge.inject(msgFrom(ALICE, '/status'))
    expect(last(bridge).text).toContain('hub: up')
  })
})

function last(bridge: FakeBridge): { to: ImUser; text: string; chatId?: string } {
  const out = bridge.outbound.at(-1)
  if (!out) throw new Error('no outbound message was sent')
  return out
}
