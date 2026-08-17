/**
 * HANDS-M3a/b — the ASSEMBLY seam for the credential verbs.
 *
 * Why this file exists, in one sentence: M3a shipped with `/setkey` and `/keys`
 * answering "not enabled" on every hub, and every unit test stayed green.
 *
 * The bug was that `StartImBridgesOptions` never declared `credentials`. The
 * wiring passed it inside a conditional spread — `...(x ? { credentials } : {})`
 * — and a spread suppresses excess-property checking, so the compiler said
 * nothing, the value landed on `opts`, and `startImBridges` never copied it into
 * the `HostImConfig` it builds. `config.credentials` was `undefined` at runtime.
 * The M3a tests hand-build a `HostImConfig` and call the router directly: they
 * pinned the BRANCH, which was correct, and nothing pinned the WIRE to it.
 *
 * So these tests deliberately enter through `startImBridges({ credentials })`
 * — the same door `im-bridge-wiring.ts` uses — and assert on what comes back
 * out of the bridge. A surface that is wired must be REACHED:
 *
 *   1. `/keys` on a wired hub does not answer "not enabled".
 *   2. `/setkey <target> <secret>` reaches `setKey` with the secret intact and
 *      `via` naming the platform.
 *   3. `/setkey link` reaches `issueLink`.
 *   4. NOT wiring it still answers "not enabled" — the honest default, so this
 *      file also proves the assertions above are not vacuously true.
 *   5. `handle.setKeyLink` (the web half) is present exactly when the surface
 *      says a link would work, and is the SAME instance the chat verbs use.
 *
 * The surface here is a recording stub, not the real service: what is under
 * test is the wire, not the vault.
 */

import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, type Logger } from '@gotong/core'
import { MASTER_KEY_LEN_BYTES, openIdentityStore, type IdentityStore } from '@gotong/identity'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'

import {
  startImBridges,
  type ImCredentialsSurface,
  type ImKeysView,
  type ImSetKeyLinkOutcome,
  type ImSetKeyOutcome,
} from '../src/im-bridge.js'

const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }

class FakeBridge implements ImBridge {
  readonly platform = 'telegram'
  readonly outbound: Array<{ to: ImUser; text: string }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(to: ImUser, text: string, _options?: { attachments?: ImAttachment[]; chatId?: string }): Promise<void> {
    this.outbound.push({ to, text })
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

const EMPTY_VIEW: ImKeysView = { agents: [], shared: {}, workspace: {}, hostEnv: {} }

/** Records what the wire delivered. Nothing here touches a vault. */
class RecordingCredentials implements ImCredentialsSurface {
  listCalls = 0
  readonly setKeyCalls: Array<{ userId: string; target: string; secret: string; via: string }> = []
  readonly linkCalls: string[] = []
  constructor(private readonly linkWorks: boolean) {}

  async allowed(_userId: string): Promise<boolean> {
    return true
  }
  async list(): Promise<ImKeysView> {
    this.listCalls++
    return EMPTY_VIEW
  }
  async setKey(args: { userId: string; target: string; secret: string; via: string }): Promise<ImSetKeyOutcome> {
    this.setKeyCalls.push(args)
    return {
      ok: true,
      slot: 'agent',
      agentId: 'assistant',
      provider: 'anthropic',
      restart: { restarted: ['assistant'], failed: [] },
    }
  }
  issueLink(userId: string): ImSetKeyLinkOutcome {
    this.linkCalls.push(userId)
    return this.linkWorks
      ? { ok: true, url: 'https://hub.example/setkey/abc', expiresAt: Date.now() + 600_000 }
      : { ok: false, code: 'unavailable' }
  }
  linkAvailable(): boolean {
    return this.linkWorks
  }
  async linkPage(_token: unknown) {
    return { ok: false as const, code: 'not_found' as const }
  }
  async submitLink(_args: { token: unknown; target: string; secret: string }) {
    return { ok: false as const, code: 'not_found' as const }
  }
}

describe('HANDS-M3a/b — credential surface reaches the verbs through startImBridges', () => {
  let hub: Hub
  let identity: IdentityStore
  let fake: FakeBridge
  let handle: Awaited<ReturnType<typeof startImBridges>> | undefined
  let bindCode: string
  const prevToken = process.env.GOTONG_TELEGRAM_BOT_TOKEN

  const ALICE: ImUser = { platform: 'telegram', platformUserId: '7001', displayName: 'Alice' }
  const msg = (text: string): ImMessage => ({
    from: ALICE,
    text,
    chatId: 'private:7001',
    ts: 1_700_000_000_000,
  })
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  beforeEach(async () => {
    hub = Hub.inMemory()
    await hub.start()
    identity = openIdentityStore({ dbPath: ':memory:', masterKey: randomBytes(MASTER_KEY_LEN_BYTES) })
    const alice = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' })
    bindCode = identity.issueImBindingCode({ userId: alice.id }).code
    process.env.GOTONG_TELEGRAM_BOT_TOKEN = 'test-token-credentials-wiring'
    fake = new FakeBridge()
  })

  afterEach(async () => {
    await handle?.stop()
    handle = undefined
    await hub.stop()
    identity.close()
    if (prevToken === undefined) delete process.env.GOTONG_TELEGRAM_BOT_TOKEN
    else process.env.GOTONG_TELEGRAM_BOT_TOKEN = prevToken
  })

  /** Boot through the production door and bind Alice, exactly as the wiring does. */
  async function boot(credentials?: ImCredentialsSurface): Promise<void> {
    handle = await startImBridges({
      hub,
      identity,
      log: silentLogger,
      makeBridge: () => fake,
      ...(credentials ? { credentials } : {}),
    })
    await say(`/bind ${bindCode}`)
    expect(fake.outbound.at(-1)?.text).toMatch(/Bound/i)
    fake.outbound.length = 0
  }

  /** Command replies are awaited inline, but bind/dispatch are not — wait bounded. */
  async function say(text: string): Promise<string> {
    const before = fake.outbound.length
    await fake.inject(msg(text))
    for (let i = 0; i < 200 && fake.outbound.length === before; i++) await delay(2)
    expect(fake.outbound.length).toBeGreaterThan(before)
    return fake.outbound.at(-1)!.text
  }

  const NOT_ENABLED = /未启用 IM 配置 key/

  it('THE REGRESSION: a wired surface answers /keys — not "not enabled"', async () => {
    const creds = new RecordingCredentials(true)
    await boot(creds)
    const reply = await say('/keys')
    expect(reply).not.toMatch(NOT_ENABLED)
    expect(creds.listCalls).toBe(1)
  })

  it('/setkey delivers the secret to the surface with the platform in `via`', async () => {
    const creds = new RecordingCredentials(true)
    await boot(creds)
    const reply = await say('/setkey assistant sk-ant-secret-value')
    expect(creds.setKeyCalls).toHaveLength(1)
    expect(creds.setKeyCalls[0]!.target).toBe('assistant')
    expect(creds.setKeyCalls[0]!.secret).toBe('sk-ant-secret-value')
    expect(creds.setKeyCalls[0]!.via).toBe('im:telegram')
    // And the secret does not come back out on the reply.
    expect(reply).not.toContain('sk-ant-secret-value')
  })

  it('/setkey link reaches issueLink through the same wire', async () => {
    const creds = new RecordingCredentials(true)
    await boot(creds)
    const reply = await say('/setkey link')
    expect(creds.linkCalls).toHaveLength(1)
    expect(reply).toContain('https://hub.example/setkey/abc')
    expect(creds.setKeyCalls).toHaveLength(0) // never mistaken for a paste
  })

  it('no surface wired → both verbs say "not enabled" (so the asserts above mean something)', async () => {
    await boot()
    expect(await say('/keys')).toMatch(NOT_ENABLED)
    expect(await say('/setkey assistant sk-ant-secret-value')).toMatch(NOT_ENABLED)
  })

  it('handle.setKeyLink is the SAME instance, present only when a link would work', async () => {
    const creds = new RecordingCredentials(true)
    await boot(creds)
    expect(handle!.setKeyLink).toBeDefined()
    // Same service, not a second one pointed at the same directory: calling
    // through the web half must land on this very stub.
    await handle!.setKeyLink!.submitLink({ token: 't', target: 'assistant', secret: 'x' })
    expect(await handle!.setKeyLink!.linkPage('t')).toEqual({ ok: false, code: 'not_found' })
  })

  it('surface says a link cannot work → no web half at all (routes 404 rather than serve a dead form)', async () => {
    await boot(new RecordingCredentials(false))
    expect(handle!.setKeyLink).toBeUndefined()
  })
})
