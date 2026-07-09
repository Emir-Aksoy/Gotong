/**
 * DEPLOY-B1 — vault-backed IM credentials + the hot-start seam.
 *
 * What this pins:
 *
 *   1. `resolveImCreds` resolution order — env WINS, vault is the fallback,
 *      never a mix (lark's two fields come from one source or not at all).
 *   2. Boot path — a wizard-written vault row brings a bridge up with NO env
 *      var set (the "restart also works" half of the story).
 *   3. Hot-start — with `hotStart`, `startImBridges` returns a live handle
 *      even with nothing configured; `startPlatform` resolves creds at call
 *      time, wires the bridge through the SAME router, and refuses a
 *      platform that is already running (只热启不热改).
 *
 * Bridges are hermetic fakes injected through the `makeBridge` test seam —
 * a real TelegramBridge long-polls the live API the moment it starts.
 */

import { randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, type Logger } from '@gotong/core'
import {
  MASTER_KEY_LEN_BYTES,
  openIdentityStore,
  type IdentityStore,
} from '@gotong/identity'
import type { ImAttachment, ImBridge, ImMessage, ImUser } from '@gotong/im-adapter'

import {
  resolveImCreds,
  startImBridges,
  type ImVaultPlatform,
  type ResolvedImCreds,
} from '../src/im-bridge.js'

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
}

class FakeBridge implements ImBridge {
  readonly outbound: Array<{ to: ImUser; text: string; chatId?: string }> = []
  private listener: ((msg: ImMessage) => void | Promise<void>) | null = null
  started = false
  constructor(
    readonly platform: string,
    readonly creds: ResolvedImCreds,
    private readonly failStart = false,
  ) {}

  async start(): Promise<void> {
    if (this.failStart) throw new Error('fake start failure')
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
  async inject(msg: ImMessage): Promise<void> {
    if (this.listener) await this.listener(msg)
  }
}

// Every env var the telegram/lark/wechat gates read — cleared per test so a
// dev shell exporting a real token can't flip outcomes.
const KEYS = [
  'GOTONG_TELEGRAM_BOT_TOKEN',
  'GOTONG_LARK_APP_ID',
  'GOTONG_LARK_APP_SECRET',
  'GOTONG_WECHAT_BOT_TOKEN',
  'GOTONG_WECHAT_BASE_URL',
]
const saved: Record<string, string | undefined> = {}

let identity: IdentityStore

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  identity = openIdentityStore({
    dbPath: ':memory:',
    masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
  })
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  identity.close()
})

function putVaultRow(input: {
  platform: ImVaultPlatform
  secret: string
  appId?: string
  baseUrl?: string
}): string {
  const entry = identity.createVaultEntry({
    kind: 'im_bridge',
    ownerKind: 'org',
    ownerId: null,
    secret: input.secret,
    label: null,
    metadata: {
      platform: input.platform,
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      registeredBy: 'test',
    },
  })
  return entry.id
}

describe('resolveImCreds — env first, vault fallback, never a mix', () => {
  it('returns undefined with nothing configured', () => {
    expect(resolveImCreds('telegram', identity)).toBeUndefined()
    expect(resolveImCreds('lark', identity)).toBeUndefined()
  })

  it('env wins over a vault row (telegram)', () => {
    putVaultRow({ platform: 'telegram', secret: 'vault-token' })
    process.env.GOTONG_TELEGRAM_BOT_TOKEN = 'env-token'
    expect(resolveImCreds('telegram', identity)).toEqual({
      source: 'env',
      fields: { token: 'env-token' },
    })
  })

  it('falls back to the vault row when env is unset (telegram)', () => {
    putVaultRow({ platform: 'telegram', secret: 'vault-token' })
    expect(resolveImCreds('telegram', identity)).toEqual({
      source: 'vault',
      fields: { token: 'vault-token' },
    })
  })

  it('newest active vault row wins; revoked rows are invisible', () => {
    const first = putVaultRow({ platform: 'telegram', secret: 'old-token' })
    putVaultRow({ platform: 'telegram', secret: 'new-token' })
    expect(resolveImCreds('telegram', identity)?.fields.token).toBe('new-token')
    // Revoking the old row changes nothing; revoking BOTH turns IM off.
    identity.revokeVaultEntry(first)
    expect(resolveImCreds('telegram', identity)?.fields.token).toBe('new-token')
  })

  it('lark vault row carries appId in metadata + appSecret as the secret', () => {
    putVaultRow({ platform: 'lark', secret: 'app-secret', appId: 'cli_123' })
    expect(resolveImCreds('lark', identity)).toEqual({
      source: 'vault',
      fields: { appId: 'cli_123', appSecret: 'app-secret' },
    })
  })

  it('refuses a half-written lark row (secret without appId)', () => {
    putVaultRow({ platform: 'lark', secret: 'app-secret' })
    expect(resolveImCreds('lark', identity)).toBeUndefined()
  })

  it('a lone env half never pairs with vault (lark falls through whole)', () => {
    // Env has only the app id — not enough. The vault row must win WHOLE
    // (both fields), never "env appId + vault secret".
    process.env.GOTONG_LARK_APP_ID = 'cli_env'
    putVaultRow({ platform: 'lark', secret: 'vault-secret', appId: 'cli_vault' })
    expect(resolveImCreds('lark', identity)).toEqual({
      source: 'vault',
      fields: { appId: 'cli_vault', appSecret: 'vault-secret' },
    })
  })

  it('platform tags do not cross-match', () => {
    putVaultRow({ platform: 'lark', secret: 's', appId: 'cli_1' })
    expect(resolveImCreds('telegram', identity)).toBeUndefined()
    expect(resolveImCreds('wechat', identity)).toBeUndefined()
  })

  // ── WX-M2b — the iLink bot token minted by `gotong wechat-login` ──

  it('wechat: returns undefined with nothing configured', () => {
    expect(resolveImCreds('wechat', identity)).toBeUndefined()
  })

  it('wechat: env wins over a vault row; env base URL rides along', () => {
    putVaultRow({ platform: 'wechat', secret: 'vault-bot-token' })
    process.env.GOTONG_WECHAT_BOT_TOKEN = 'env-bot-token'
    expect(resolveImCreds('wechat', identity)).toEqual({
      source: 'env',
      fields: { token: 'env-bot-token' },
    })
    process.env.GOTONG_WECHAT_BASE_URL = 'https://sh.ilinkai.weixin.qq.com'
    expect(resolveImCreds('wechat', identity)).toEqual({
      source: 'env',
      fields: { token: 'env-bot-token', baseUrl: 'https://sh.ilinkai.weixin.qq.com' },
    })
  })

  it('wechat: a lone base URL env is NOT credentials (no mixed halves)', () => {
    process.env.GOTONG_WECHAT_BASE_URL = 'https://sh.ilinkai.weixin.qq.com'
    putVaultRow({ platform: 'wechat', secret: 'vault-bot-token' })
    // The vault row wins whole — its own (absent) baseUrl, never env's.
    expect(resolveImCreds('wechat', identity)).toEqual({
      source: 'vault',
      fields: { token: 'vault-bot-token' },
    })
  })

  it('wechat: vault row carries the QR-login base URL as non-secret metadata', () => {
    putVaultRow({
      platform: 'wechat',
      secret: 'vault-bot-token',
      baseUrl: 'https://sz.ilinkai.weixin.qq.com',
    })
    expect(resolveImCreds('wechat', identity)).toEqual({
      source: 'vault',
      fields: { token: 'vault-bot-token', baseUrl: 'https://sz.ilinkai.weixin.qq.com' },
    })
  })
})

describe('startImBridges — vault row activates a bridge at boot', () => {
  it('starts telegram from a vault row with no env var set', async () => {
    putVaultRow({ platform: 'telegram', secret: 'vault-token' })
    const hub = Hub.inMemory()
    await hub.start()
    const made: FakeBridge[] = []
    try {
      const handle = await startImBridges({
        hub,
        identity,
        log: silentLogger,
        makeBridge: (platform, creds) => {
          const b = new FakeBridge(platform, creds)
          made.push(b)
          return b
        },
      })
      expect(handle).toBeDefined()
      expect(handle!.bridges.map((b) => b.platform)).toEqual(['telegram'])
      expect(made[0]!.creds).toEqual({ source: 'vault', fields: { token: 'vault-token' } })
      expect(made[0]!.started).toBe(true)
      // DEPLOY-B3 — the read-only projection the admin settings page shows.
      expect(handle!.status()).toEqual([{ platform: 'telegram', source: 'vault' }])
      await handle!.stop()
      expect(made[0]!.started).toBe(false)
    } finally {
      await hub.stop()
    }
  })

  it('still returns undefined with nothing configured and no hotStart', async () => {
    const hub = Hub.inMemory()
    await hub.start()
    try {
      const handle = await startImBridges({ hub, identity, log: silentLogger })
      expect(handle).toBeUndefined()
    } finally {
      await hub.stop()
    }
  })

  it('starts wechat from a vault row (token + base URL) with no env var set', async () => {
    putVaultRow({
      platform: 'wechat',
      secret: 'vault-bot-token',
      baseUrl: 'https://sh.ilinkai.weixin.qq.com',
    })
    const hub = Hub.inMemory()
    await hub.start()
    const made: FakeBridge[] = []
    try {
      const handle = await startImBridges({
        hub,
        identity,
        log: silentLogger,
        makeBridge: (platform, creds) => {
          const b = new FakeBridge(platform, creds)
          made.push(b)
          return b
        },
      })
      expect(handle).toBeDefined()
      expect(handle!.bridges.map((b) => b.platform)).toEqual(['wechat'])
      expect(made[0]!.creds).toEqual({
        source: 'vault',
        fields: { token: 'vault-bot-token', baseUrl: 'https://sh.ilinkai.weixin.qq.com' },
      })
      expect(handle!.status()).toEqual([{ platform: 'wechat', source: 'vault' }])
      await handle!.stop()
    } finally {
      await hub.stop()
    }
  })
})

describe('startImBridges — hot-start seam', () => {
  let hub: Hub
  const made: FakeBridge[] = []
  let failNextStart = false

  beforeEach(async () => {
    made.length = 0
    failNextStart = false
    hub = Hub.inMemory()
    await hub.start()
  })
  afterEach(async () => {
    await hub.stop()
  })

  function boot() {
    return startImBridges({
      hub,
      identity,
      log: silentLogger,
      hotStart: true,
      makeBridge: (platform, creds) => {
        const b = new FakeBridge(platform, creds, failNextStart)
        made.push(b)
        return b
      },
    })
  }

  it('returns a live empty handle with nothing configured', async () => {
    const handle = await boot()
    expect(handle).toBeDefined()
    expect(handle!.bridges).toHaveLength(0)
    expect(handle!.startPlatform).toBeTypeOf('function')
    expect(handle!.status()).toEqual([]) // DEPLOY-B3 — honest "no live channel"
    await handle!.stop() // no-op on empty must not throw
  })

  it('startPlatform: no creds → no_credentials; vault row → up; again → already_running', async () => {
    const handle = await boot()
    expect(await handle!.startPlatform!('telegram')).toEqual({
      ok: false,
      reason: 'no_credentials',
    })

    // The wizard's sequence: write the vault row, THEN hot-start.
    putVaultRow({ platform: 'telegram', secret: 'wizard-token' })
    const res = await handle!.startPlatform!('telegram')
    expect(res).toEqual({ ok: true, platform: 'telegram', source: 'vault' })
    expect(handle!.bridges.map((b) => b.platform)).toEqual(['telegram'])
    expect(made[0]!.started).toBe(true)
    // DEPLOY-B3 — a hot-started bridge appears in the status projection too.
    expect(handle!.status()).toEqual([{ platform: 'telegram', source: 'vault' }])

    // 只热启不热改 — a second call must refuse, not rebuild.
    expect(await handle!.startPlatform!('telegram')).toEqual({
      ok: false,
      reason: 'already_running',
    })
    expect(made).toHaveLength(1)

    await handle!.stop()
    expect(made[0]!.started).toBe(false)
  })

  it('a hot-started bridge is wired into the router (inbound gets a reply)', async () => {
    const handle = await boot()
    putVaultRow({ platform: 'telegram', secret: 'wizard-token' })
    await handle!.startPlatform!('telegram')
    const bridge = made[0]!
    // Unbound user free-texts → router answers with the bind nudge; proving
    // the hot-started bridge went through the same onMessage wiring as boot.
    await bridge.inject({
      from: { platform: 'telegram', platformUserId: '1001', displayName: 'Alice' },
      text: 'hello',
      chatId: 'private:1001',
      ts: 1_700_000_000_000,
    })
    expect(bridge.outbound.at(-1)?.text).toMatch(/bind/i)
    await handle!.stop()
  })

  it('startPlatform: bridge start throwing → start_failed, nothing left running', async () => {
    const handle = await boot()
    putVaultRow({ platform: 'telegram', secret: 'wizard-token' })
    failNextStart = true
    const res = await handle!.startPlatform!('telegram')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('start_failed')
    expect(handle!.bridges).toHaveLength(0)
    await handle!.stop()
  })

  it('hot-starts lark from a wizard-written row', async () => {
    const handle = await boot()
    putVaultRow({ platform: 'lark', secret: 'app-secret', appId: 'cli_123' })
    const res = await handle!.startPlatform!('lark')
    expect(res).toEqual({ ok: true, platform: 'lark', source: 'vault' })
    expect(made[0]!.creds.fields).toEqual({ appId: 'cli_123', appSecret: 'app-secret' })
    await handle!.stop()
  })
})
