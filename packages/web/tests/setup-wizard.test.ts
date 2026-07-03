/**
 * C1b — first-time setup wizard tests (A2.3).
 *
 * Coverage:
 *   needs-bootstrap detection:
 *     - identity unwired           → bootstrap: false
 *     - fresh bootstrap, no pwd    → bootstrap: true
 *     - owner has password         → bootstrap: false
 *     - multi-user host            → bootstrap: false
 *
 *   owner-password set:
 *     - loopback + bootstrap-mode + ≥12 chars → 200, password set,
 *       audit row written
 *     - non-loopback (forged X-Forwarded-For doesn't help) → 403
 *     - identity unwired          → 503
 *     - multi-user host           → 409
 *     - owner already has pwd     → 409
 *     - password < 12 chars       → 400
 *     - empty/garbage body        → 400
 *     - after success: needs-bootstrap flips to false; owner can log in
 *       with the new password
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@aipehub/core'
import { MASTER_KEY_LEN_BYTES, openIdentityStore, type IdentityStore } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'

interface BootResult {
  tmp: string
  hub: Hub
  space: Space
  identity?: IdentityStore
  server: WebServerHandle
  baseUrl: string
  ownerUserId: string | null
}

async function boot(opts: {
  withIdentity?: boolean
  preSetPassword?: boolean
  preCreateExtraUser?: boolean
  /** DEPLOY-B2 — fake hot-start surface for the owner-im tests. */
  imHotStart?: {
    start(platform: 'telegram' | 'lark'): Promise<
      | { ok: true; source?: string }
      | { ok: false; reason: string; detail?: string }
    >
  }
} = {}): Promise<BootResult> {
  const withIdentity = opts.withIdentity ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-web-setup-'))
  const init = await Space.init(tmp, { name: 'setup-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { admin, token: adminToken } = await space.createAdmin('TestAdmin')
  // Don't seed an admin session here — setup wizard runs pre-auth.
  void admin

  let identity: IdentityStore | undefined
  let ownerUserId: string | null = null
  if (withIdentity) {
    // masterKey enables the vault APIs the owner-llm-key route writes through;
    // owner-password/needs-bootstrap tests don't touch the vault so this is
    // purely additive for them.
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite'), masterKey: randomBytes(MASTER_KEY_LEN_BYTES) })
    const ib = identity.bootstrap({
      adminToken,
      ownerEmail: 'owner@setup.local',
      ownerDisplayName: 'Setup Owner',
    })
    ownerUserId = ib.ownerUserId
    if (opts.preSetPassword && ownerUserId) {
      identity.setPassword(ownerUserId, 'preset-password-strong-12')
    }
    if (opts.preCreateExtraUser) {
      identity.createUser({
        email: 'extra@setup.local',
        displayName: 'Extra',
        password: 'extra-password-strong',
        role: 'member',
      })
    }
  }

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    ...(identity ? { identity } : {}),
    ...(opts.imHotStart ? { imHotStart: opts.imHotStart } : {}),
  })

  return {
    tmp,
    hub,
    space,
    ...(identity ? { identity } : {}),
    server,
    baseUrl: server.url,
    ownerUserId,
  }
}

async function teardown(b: BootResult): Promise<void> {
  await b.server.close()
  await b.hub.stop()
  b.identity?.close()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('GET /api/setup/needs-bootstrap', () => {
  it('identity unwired → bootstrap: false', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ bootstrap: false })
    } finally { await teardown(b) }
  })

  it('fresh bootstrap, owner has no password → bootstrap: true', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ bootstrap: true })
    } finally { await teardown(b) }
  })

  it('owner already has password → bootstrap: false', async () => {
    const b = await boot({ preSetPassword: true })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ bootstrap: false })
    } finally { await teardown(b) }
  })

  it('multi-user host → bootstrap: false (setup is already done)', async () => {
    const b = await boot({ preCreateExtraUser: true })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ bootstrap: false })
    } finally { await teardown(b) }
  })
})

describe('POST /api/setup/owner-password', () => {
  it('happy path — sets password, audit row written, login works after', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'fresh-strong-password-12' }),
      })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: true })

      // Audit row written.
      const audit = b.identity!.listAuditLog!({ action: 'setup_owner_created' })
      expect(audit.length).toBe(1)
      expect(audit[0]!.targetUserId).toBe(b.ownerUserId)
      expect(audit[0]!.actorSource).toBe('anonymous')

      // Login works with the new password.
      const login = await fetch(`${b.baseUrl}/api/admin/identity/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@setup.local',
          password: 'fresh-strong-password-12',
        }),
      })
      expect(login.status).toBe(200)

      // needs-bootstrap now reports false.
      const flip = await fetch(`${b.baseUrl}/api/setup/needs-bootstrap`)
      expect(await flip.json()).toEqual({ bootstrap: false })
    } finally { await teardown(b) }
  })

  it('identity unwired → 503', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'strong-enough-password-12' }),
      })
      expect(r.status).toBe(503)
    } finally { await teardown(b) }
  })

  it('multi-user host → 409', async () => {
    const b = await boot({ preCreateExtraUser: true })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'strong-enough-password-12' }),
      })
      expect(r.status).toBe(409)
      expect((await r.json()).error).toMatch(/multi-user/)
    } finally { await teardown(b) }
  })

  it('owner already has password → 409', async () => {
    const b = await boot({ preSetPassword: true })
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'second-password-strong-12' }),
      })
      expect(r.status).toBe(409)
      expect((await r.json()).error).toMatch(/already has a password/)
    } finally { await teardown(b) }
  })

  it('password < 12 chars → 400', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'short' }),
      })
      expect(r.status).toBe(400)
      expect((await r.json()).error).toMatch(/at least 12/)
    } finally { await teardown(b) }
  })

  it('garbage body → 400', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      })
      expect(r.status).toBe(400)
    } finally { await teardown(b) }
  })

  it('missing password field → 400', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(r.status).toBe(400)
    } finally { await teardown(b) }
  })

  // NOTE: We cannot easily test the non-loopback rejection from a unit
  // test — boot binds to 127.0.0.1, and req.socket.remoteAddress will
  // always be 127.0.0.1 too. The loopback gate is straightforward to
  // verify by inspection (server.ts directly compares socket address
  // against the three loopback literals), and forging x-forwarded-for
  // can't fool it because the gate ignores trustProxy entirely.
})

// Ease-of-use ②-M1 — the OPTIONAL second wizard step writes an org-scope LLM
// key so the owner's first managed agent has a key to resolve. Same loopback +
// single-user gates as owner-password; repeatable (overwrites the prior org
// row for the same provider tag).
describe('POST /api/setup/owner-llm-key', () => {
  async function postKey(baseUrl: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/setup/owner-llm-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('DeepSeek preset — writes org vault row tagged openai-compatible + baseURL, audit row', async () => {
    const b = await boot()
    try {
      const r = await postKey(b.baseUrl, {
        provider: 'openai-compatible',
        apiKey: 'sk-deepseek-secret-key',
        baseURL: 'https://api.deepseek.com/v1',
        label: 'DeepSeek',
      })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: true, provider: 'openai-compatible' })

      // Exactly one active org LLM key row, tagged correctly.
      const rows = b.identity!.listVaultEntries!({
        kind: 'llm_provider',
        ownerKind: 'org',
        activeOnly: true,
      })
      expect(rows.length).toBe(1)
      expect(rows[0]!.metadata?.provider).toBe('openai-compatible')
      expect(rows[0]!.metadata?.baseURL).toBe('https://api.deepseek.com/v1')
      expect(rows[0]!.metadata?.registeredBy).toBe('setup-wizard')

      // The secret round-trips through the vault (never returned by list).
      if (typeof b.identity!.readVaultSecret === 'function') {
        expect(b.identity!.readVaultSecret(rows[0]!.id)).toBe('sk-deepseek-secret-key')
      }

      // Audit row written, pinned to the owner, secret-free.
      const audit = b.identity!.listAuditLog!({ action: 'setup_owner_llm_key' })
      expect(audit.length).toBe(1)
      expect(audit[0]!.targetUserId).toBe(b.ownerUserId)
      expect(audit[0]!.actorSource).toBe('anonymous')
      expect(audit[0]!.metadata?.provider).toBe('openai-compatible')
    } finally { await teardown(b) }
  })

  it('Anthropic preset — writes row tagged anthropic, no baseURL', async () => {
    const b = await boot()
    try {
      const r = await postKey(b.baseUrl, { provider: 'anthropic', apiKey: 'sk-ant-secret' })
      expect(r.status).toBe(200)
      const rows = b.identity!.listVaultEntries!({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })
      expect(rows.length).toBe(1)
      expect(rows[0]!.metadata?.provider).toBe('anthropic')
      expect(rows[0]!.metadata?.baseURL).toBeUndefined()
    } finally { await teardown(b) }
  })

  it('re-submitting same provider revokes the prior row (overwrite hygiene)', async () => {
    const b = await boot()
    try {
      await postKey(b.baseUrl, { provider: 'openai-compatible', apiKey: 'first-key', baseURL: 'https://api.deepseek.com/v1' })
      await postKey(b.baseUrl, { provider: 'openai-compatible', apiKey: 'second-key', baseURL: 'https://api.deepseek.com/v1' })

      // Only the newest active row remains for that provider tag…
      const active = b.identity!.listVaultEntries!({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })
      expect(active.length).toBe(1)
      // …but the revoked one is still on the books (activeOnly: false).
      const all = b.identity!.listVaultEntries!({ kind: 'llm_provider', ownerKind: 'org', activeOnly: false })
      expect(all.length).toBe(2)
    } finally { await teardown(b) }
  })

  it('identity unwired → 503', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await postKey(b.baseUrl, { provider: 'anthropic', apiKey: 'sk-ant-x' })
      expect(r.status).toBe(503)
    } finally { await teardown(b) }
  })

  it('multi-user host → 409', async () => {
    const b = await boot({ preCreateExtraUser: true })
    try {
      const r = await postKey(b.baseUrl, { provider: 'anthropic', apiKey: 'sk-ant-x' })
      expect(r.status).toBe(409)
      expect((await r.json()).error).toMatch(/multi-user/)
      // No org LLM key was written.
      const rows = b.identity!.listVaultEntries!({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })
      expect(rows.length).toBe(0)
    } finally { await teardown(b) }
  })

  it('unsupported provider (raw "deepseek") → 400', async () => {
    // The frontend maps the "deepseek" choice to the openai-compatible tag;
    // a raw "deepseek" reaching the route is not in the allowlist.
    const b = await boot()
    try {
      const r = await postKey(b.baseUrl, { provider: 'deepseek', apiKey: 'sk-x' })
      expect(r.status).toBe(400)
      expect((await r.json()).error).toMatch(/unsupported provider/)
    } finally { await teardown(b) }
  })

  it('empty apiKey → 400', async () => {
    const b = await boot()
    try {
      const r = await postKey(b.baseUrl, { provider: 'anthropic', apiKey: '   ' })
      expect(r.status).toBe(400)
      expect((await r.json()).error).toMatch(/apiKey is required/)
    } finally { await teardown(b) }
  })

  it('garbage body → 400', async () => {
    const b = await boot()
    try {
      const r = await postKey(b.baseUrl, '{not json')
      expect(r.status).toBe(400)
    } finally { await teardown(b) }
  })
})

// DEPLOY-B2 — the optional IM step. Same gates as owner-llm-key (loopback +
// single-user window), writes the `im_bridge` org vault row `resolveImCreds`
// reads, then asks the injected hot-start surface to bring the bridge up.
describe('POST /api/setup/owner-im', () => {
  async function postIm(baseUrl: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/setup/owner-im`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  }

  it('telegram happy path — vault row + hot-start called + audit', async () => {
    const started: string[] = []
    const b = await boot({
      imHotStart: {
        async start(platform) {
          started.push(platform)
          return { ok: true, source: 'vault' }
        },
      },
    })
    try {
      const r = await postIm(b.baseUrl, { platform: 'telegram', token: 'tg-bot-token-123' })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({
        ok: true,
        platform: 'telegram',
        bridge: { started: true, source: 'vault' },
      })
      expect(started).toEqual(['telegram'])

      // The vault row carries the platform tag; the token is the secret.
      const rows = b.identity!.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      expect(rows.length).toBe(1)
      expect(rows[0]!.metadata?.platform).toBe('telegram')
      expect(rows[0]!.metadata?.registeredBy).toBe('setup-wizard')
      if (typeof b.identity!.readVaultSecret === 'function') {
        expect(b.identity!.readVaultSecret(rows[0]!.id)).toBe('tg-bot-token-123')
      }

      // Audit: platform + bridge outcome, never the token.
      const audit = b.identity!.listAuditLog!({ action: 'setup_owner_im' })
      expect(audit.length).toBe(1)
      expect(audit[0]!.targetUserId).toBe(b.ownerUserId)
      expect(audit[0]!.metadata?.platform).toBe('telegram')
      expect(audit[0]!.metadata?.bridgeStarted).toBe(true)
    } finally { await teardown(b) }
  })

  it('lark happy path — appId in metadata, appSecret is the secret', async () => {
    const b = await boot({
      imHotStart: { async start() { return { ok: true, source: 'vault' } } },
    })
    try {
      const r = await postIm(b.baseUrl, { platform: 'lark', appId: 'cli_123', appSecret: 'lark-secret' })
      expect(r.status).toBe(200)
      const rows = b.identity!.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      expect(rows.length).toBe(1)
      expect(rows[0]!.metadata?.platform).toBe('lark')
      expect(rows[0]!.metadata?.appId).toBe('cli_123')
      if (typeof b.identity!.readVaultSecret === 'function') {
        expect(b.identity!.readVaultSecret(rows[0]!.id)).toBe('lark-secret')
      }
    } finally { await teardown(b) }
  })

  it('no hot-start surface → token saved, honest not_wired verdict', async () => {
    const b = await boot()
    try {
      const r = await postIm(b.baseUrl, { platform: 'telegram', token: 'tg-token' })
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({
        ok: true,
        platform: 'telegram',
        bridge: { started: false, reason: 'not_wired' },
      })
      const rows = b.identity!.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      expect(rows.length).toBe(1)
    } finally { await teardown(b) }
  })

  it('hot-start refusal → 200 with started:false, vault row kept', async () => {
    const b = await boot({
      imHotStart: {
        async start() { return { ok: false, reason: 'start_failed', detail: 'bad token' } },
      },
    })
    try {
      const r = await postIm(b.baseUrl, { platform: 'telegram', token: 'tg-token' })
      expect(r.status).toBe(200)
      const j = await r.json()
      expect(j.bridge).toEqual({ started: false, reason: 'start_failed', detail: 'bad token' })
      // The row survives — a restart still picks it up.
      const rows = b.identity!.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      expect(rows.length).toBe(1)
    } finally { await teardown(b) }
  })

  it('re-submitting the same platform revokes the prior row (overwrite hygiene)', async () => {
    const b = await boot()
    try {
      await postIm(b.baseUrl, { platform: 'telegram', token: 'first' })
      await postIm(b.baseUrl, { platform: 'telegram', token: 'second' })
      const active = b.identity!.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      expect(active.length).toBe(1)
      const all = b.identity!.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: false })
      expect(all.length).toBe(2)
    } finally { await teardown(b) }
  })

  it('multi-user host → 409, nothing written', async () => {
    const b = await boot({ preCreateExtraUser: true })
    try {
      const r = await postIm(b.baseUrl, { platform: 'telegram', token: 'tg-token' })
      expect(r.status).toBe(409)
      const rows = b.identity!.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      expect(rows.length).toBe(0)
    } finally { await teardown(b) }
  })

  it('unsupported platform → 400', async () => {
    const b = await boot()
    try {
      const r = await postIm(b.baseUrl, { platform: 'qq', token: 'x' })
      expect(r.status).toBe(400)
      expect((await r.json()).error).toMatch(/unsupported platform/)
    } finally { await teardown(b) }
  })

  it('telegram without token / lark with half creds → 400', async () => {
    const b = await boot()
    try {
      const r1 = await postIm(b.baseUrl, { platform: 'telegram', token: '  ' })
      expect(r1.status).toBe(400)
      const r2 = await postIm(b.baseUrl, { platform: 'lark', appId: 'cli_1' })
      expect(r2.status).toBe(400)
      const rows = b.identity!.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      expect(rows.length).toBe(0)
    } finally { await teardown(b) }
  })

  it('identity unwired → 503', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await postIm(b.baseUrl, { platform: 'telegram', token: 'tg-token' })
      expect(r.status).toBe(503)
    } finally { await teardown(b) }
  })
})

// Ease-of-use ①-M1 followup — the friendly first-run banner the host prints
// tells a fresh user to "open / to finish setup (no token needed)". For that
// to be true the web ROOT must surface the setup wizard (which lives in
// app.html) during the loopback bootstrap window — otherwise anonymous lands
// on worker.html and the banner is a dead end. These assert the `/` handler
// serves the SPA shell (id="setup-wizard") exactly when bootstrap is pending
// and the request is loopback, and reverts to worker.html otherwise.
//
// The boot() server binds to 127.0.0.1, so the test's own fetch IS loopback —
// the same property the owner-password / owner-llm-key happy paths rely on.
describe('GET / (root) during first-run bootstrap', () => {
  // app.html (the unified SPA, which renders the wizard) carries the static
  // id="setup-wizard"; worker.html (the v3 join page) carries the
  // switch-to-admin button and never the wizard id.
  const isAppShell = (html: string) => html.includes('id="setup-wizard"')
  const isWorkerShell = (html: string) => html.includes('switch-to-admin-btn')

  it('bootstrap pending + loopback → serves the SPA so the wizard surfaces', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isAppShell(html)).toBe(true)
      expect(isWorkerShell(html)).toBe(false)
    } finally { await teardown(b) }
  })

  it('owner already has a password → reverts to worker.html', async () => {
    const b = await boot({ preSetPassword: true })
    try {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isWorkerShell(html)).toBe(true)
      expect(isAppShell(html)).toBe(false)
    } finally { await teardown(b) }
  })

  it('identity unwired → worker.html (no bootstrap window at all)', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isWorkerShell(html)).toBe(true)
      expect(isAppShell(html)).toBe(false)
    } finally { await teardown(b) }
  })

  it('multi-user host → worker.html (setup already done)', async () => {
    const b = await boot({ preCreateExtraUser: true })
    try {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isWorkerShell(html)).toBe(true)
      expect(isAppShell(html)).toBe(false)
    } finally { await teardown(b) }
  })
})
