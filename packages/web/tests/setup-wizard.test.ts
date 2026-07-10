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
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { Hub, Space } from '@gotong/core'
import { MASTER_KEY_LEN_BYTES, openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import { handleSetupRoute, type SetupRoutesCtx } from '../src/setup-routes.js'

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
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-web-setup-'))
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

// Ease-of-use ①-M1 followup, reshaped by UI-A1 — the web ROOT now always
// serves the unified SPA (login shell for anonymous). What distinguishes the
// first-run wizard from the plain login form is the server-injected
// x-gotong-bootstrap meta hint: '1' while the bootstrap window is open
// (identity wired, single owner, no password), '' otherwise. These assert
// the hint tracks the window and the legacy worker join page still exists
// at /room. Wizard WRITES stay loopback-gated in setup-routes regardless.
describe('GET / (root) during first-run bootstrap', () => {
  // app.html (the unified SPA, which renders the wizard) carries the static
  // id="setup-wizard"; worker.html (the v3 join page) carries the
  // switch-to-admin button and never the wizard id.
  const isAppShell = (html: string) => html.includes('id="setup-wizard"')
  const isWorkerShell = (html: string) => html.includes('switch-to-admin-btn')
  const bootstrapHint = (html: string) => {
    const m = html.match(/name="x-gotong-bootstrap" content="([^"]*)"/)
    return m ? m[1]! : '__missing__'
  }

  it('bootstrap pending → serves the SPA with the wizard hint ON', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isAppShell(html)).toBe(true)
      expect(isWorkerShell(html)).toBe(false)
      expect(bootstrapHint(html)).toBe('1')
    } finally { await teardown(b) }
  })

  it('owner already has a password → still the SPA, hint OFF (login form, not wizard)', async () => {
    const b = await boot({ preSetPassword: true })
    try {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isAppShell(html)).toBe(true)
      expect(bootstrapHint(html)).toBe('')
    } finally { await teardown(b) }
  })

  it('identity unwired → SPA with hint OFF (no bootstrap window at all)', async () => {
    const b = await boot({ withIdentity: false })
    try {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isAppShell(html)).toBe(true)
      expect(bootstrapHint(html)).toBe('')
    } finally { await teardown(b) }
  })

  it('multi-user host → SPA with hint OFF (setup already done)', async () => {
    const b = await boot({ preCreateExtraUser: true })
    try {
      const r = await fetch(`${b.baseUrl}/`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isAppShell(html)).toBe(true)
      expect(bootstrapHint(html)).toBe('')
    } finally { await teardown(b) }
  })

  it('/room keeps serving the legacy worker join page', async () => {
    const b = await boot()
    try {
      const r = await fetch(`${b.baseUrl}/room`)
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(isWorkerShell(html)).toBe(true)
      expect(isAppShell(html)).toBe(false)
    } finally { await teardown(b) }
  })

  // DEPLOY-C followup — the SPA shell carries a server-injected bootstrap
  // hint meta so a signed-in operator's boot can enter the wizard without a
  // blocking flag fetch on every normal boot. '1' while the window is open,
  // empty once the owner has a password.
  it('bootstrap meta hint: "1" while pending; empty once the owner has a password', async () => {
    const b = await boot()
    try {
      let html = await (await fetch(`${b.baseUrl}/`)).text()
      expect(html).toContain('name="x-gotong-bootstrap" content="1"')

      // Finish setup, sign in, refetch the SPA with the session cookie —
      // the hint must be gone so a signed-in boot on a completed host never
      // detours through the wizard path.
      await fetch(`${b.baseUrl}/api/setup/owner-password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'fresh-strong-password-12' }),
      })
      const login = await fetch(`${b.baseUrl}/api/admin/identity/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'owner@setup.local', password: 'fresh-strong-password-12' }),
      })
      expect(login.status).toBe(200)
      const sessCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      expect(sessCookie).not.toBe('')
      html = await (await fetch(`${b.baseUrl}/`, { headers: { cookie: sessCookie } })).text()
      expect(isAppShell(html)).toBe(true)
      expect(html).toContain('name="x-gotong-bootstrap" content=""')
    } finally { await teardown(b) }
  })
})

// DEPLOY-C followup — trust anchor 2: an authenticated operator session
// admits the setup writes from a NON-loopback socket. That's the Docker
// compose path: requests reach the container through the port-forward with
// the bridge gateway as source IP, so anchor 1 (loopback) can never hold —
// the operator signs in via the runtime/admin-link.txt URL instead and the
// wizard runs on that session.
//
// These drive handleSetupRoute directly with a forged remoteAddress — the
// one thing a real HTTP round-trip through 127.0.0.1 cannot simulate (see
// the NOTE in the owner-password describe above). server.ts's isOperator
// wiring itself is one line (findAdminFromRequest(..).kind === 'admin');
// the matrix here covers every anchor combination the gate can see.
describe('operator-session anchor (non-loopback setup writes)', () => {
  /** What a Docker bridge port-forward looks like to the container. */
  const DOCKER_GW = '172.17.0.1'

  interface DirectCtx {
    tmp: string
    identity: IdentityStore
    ownerUserId: string
  }

  /** Identity-only fixture — no Hub, no web server; we call the handler. */
  async function directIdentity(): Promise<DirectCtx> {
    const tmp = await mkdtemp(join(tmpdir(), 'gotong-setup-direct-'))
    const init = await Space.init(tmp, { name: 'setup-direct' })
    const { token: adminToken } = await init.space.createAdmin('DirectAdmin')
    const identity = openIdentityStore({
      dbPath: join(tmp, 'identity.sqlite'),
      masterKey: randomBytes(MASTER_KEY_LEN_BYTES),
    })
    const ib = identity.bootstrap({
      adminToken,
      ownerEmail: 'owner@direct.local',
      ownerDisplayName: 'Direct Owner',
    })
    return { tmp, identity, ownerUserId: ib.ownerUserId }
  }

  async function teardownDirect(d: DirectCtx): Promise<void> {
    d.identity.close()
    await rm(d.tmp, { recursive: true, force: true })
  }

  function fakeReq(opts: { remoteAddress: string; body?: unknown }): IncomingMessage {
    const payload = opts.body === undefined ? [] : [JSON.stringify(opts.body)]
    const req = Readable.from(payload) as unknown as IncomingMessage & {
      headers: Record<string, string>
      socket: { remoteAddress: string }
    }
    req.headers = { 'content-type': 'application/json' }
    req.socket = { remoteAddress: opts.remoteAddress }
    return req
  }

  function fakeRes(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
    let status = 0
    let body = ''
    const res = {
      writeHead(s: number) { status = s; return this },
      end(chunk?: unknown) { if (chunk !== undefined) body += String(chunk) },
    } as unknown as ServerResponse
    return { res, status: () => status, json: () => JSON.parse(body) as Record<string, unknown> }
  }

  function ctxOf(d: DirectCtx, extra?: Partial<SetupRoutesCtx>): SetupRoutesCtx {
    return { identity: d.identity as unknown as SetupRoutesCtx['identity'], ...extra }
  }

  const ownerHasPassword = (d: DirectCtx): boolean =>
    d.identity.listCredentials(d.ownerUserId).some((c) => c.kind === 'password')

  it('non-loopback + no isOperator injected → 403 (loopback-only shape unchanged)', async () => {
    const d = await directIdentity()
    try {
      const { res, status } = fakeRes()
      const handled = await handleSetupRoute(
        ctxOf(d),
        fakeReq({ remoteAddress: DOCKER_GW, body: { password: 'strong-enough-password-12' } }),
        res, 'POST', '/api/setup/owner-password',
      )
      expect(handled).toBe(true)
      expect(status()).toBe(403)
      expect(ownerHasPassword(d)).toBe(false)
    } finally { await teardownDirect(d) }
  })

  it('non-loopback + isOperator=false → 403', async () => {
    const d = await directIdentity()
    try {
      const { res, status } = fakeRes()
      await handleSetupRoute(
        ctxOf(d, { isOperator: async () => false }),
        fakeReq({ remoteAddress: DOCKER_GW, body: { password: 'strong-enough-password-12' } }),
        res, 'POST', '/api/setup/owner-password',
      )
      expect(status()).toBe(403)
      expect(ownerHasPassword(d)).toBe(false)
    } finally { await teardownDirect(d) }
  })

  it('non-loopback + isOperator throws → 403 (fail closed)', async () => {
    const d = await directIdentity()
    try {
      const { res, status } = fakeRes()
      await handleSetupRoute(
        ctxOf(d, { isOperator: async () => { throw new Error('resolver exploded') } }),
        fakeReq({ remoteAddress: DOCKER_GW, body: { password: 'strong-enough-password-12' } }),
        res, 'POST', '/api/setup/owner-password',
      )
      expect(status()).toBe(403)
      expect(ownerHasPassword(d)).toBe(false)
    } finally { await teardownDirect(d) }
  })

  it('non-loopback + isOperator=true → password set, audit anchor=operator-session', async () => {
    const d = await directIdentity()
    try {
      const { res, status, json } = fakeRes()
      await handleSetupRoute(
        ctxOf(d, { isOperator: async () => true }),
        fakeReq({ remoteAddress: DOCKER_GW, body: { password: 'strong-enough-password-12' } }),
        res, 'POST', '/api/setup/owner-password',
      )
      expect(status()).toBe(200)
      expect(json()).toEqual({ ok: true })
      expect(ownerHasPassword(d)).toBe(true)
      const audit = d.identity.listAuditLog!({ action: 'setup_owner_created' })
      expect(audit.length).toBe(1)
      expect(audit[0]!.metadata?.anchor).toBe('operator-session')
    } finally { await teardownDirect(d) }
  })

  it('loopback still passes with isOperator=false — anchors are OR, not replacement', async () => {
    const d = await directIdentity()
    try {
      const { res, status } = fakeRes()
      await handleSetupRoute(
        ctxOf(d, { isOperator: async () => false }),
        fakeReq({ remoteAddress: '127.0.0.1', body: { password: 'strong-enough-password-12' } }),
        res, 'POST', '/api/setup/owner-password',
      )
      expect(status()).toBe(200)
      expect(ownerHasPassword(d)).toBe(true)
      const audit = d.identity.listAuditLog!({ action: 'setup_owner_created' })
      expect(audit[0]!.metadata?.anchor).toBe('loopback')
    } finally { await teardownDirect(d) }
  })

  it('non-loopback operator → owner-llm-key + owner-im write vault rows, anchors audited', async () => {
    const d = await directIdentity()
    try {
      const ctx = ctxOf(d, { isOperator: async () => true })

      const key = fakeRes()
      await handleSetupRoute(
        ctx,
        fakeReq({ remoteAddress: DOCKER_GW, body: { provider: 'anthropic', apiKey: 'sk-ant-docker' } }),
        key.res, 'POST', '/api/setup/owner-llm-key',
      )
      expect(key.status()).toBe(200)
      const keyRows = d.identity.listVaultEntries!({ kind: 'llm_provider', ownerKind: 'org', activeOnly: true })
      expect(keyRows.length).toBe(1)
      const keyAudit = d.identity.listAuditLog!({ action: 'setup_owner_llm_key' })
      expect(keyAudit[0]!.metadata?.anchor).toBe('operator-session')

      const im = fakeRes()
      await handleSetupRoute(
        ctx,
        fakeReq({ remoteAddress: DOCKER_GW, body: { platform: 'telegram', token: 'tg-docker-token' } }),
        im.res, 'POST', '/api/setup/owner-im',
      )
      expect(im.status()).toBe(200)
      expect((im.json() as { bridge?: { started: boolean } }).bridge?.started).toBe(false)
      const imRows = d.identity.listVaultEntries!({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      expect(imRows.length).toBe(1)
      const imAudit = d.identity.listAuditLog!({ action: 'setup_owner_im' })
      expect(imAudit[0]!.metadata?.anchor).toBe('operator-session')
    } finally { await teardownDirect(d) }
  })

  it('non-loopback operator → test-llm-key reaches the probe', async () => {
    const d = await directIdentity()
    try {
      const probed: string[] = []
      const { res, status, json } = fakeRes()
      await handleSetupRoute(
        ctxOf(d, {
          isOperator: async () => true,
          llmKeyTest: {
            async testLlmKey(input) {
              probed.push(input.provider)
              return { ok: true, model: 'probe-model', latencyMs: 5 }
            },
          },
        }),
        fakeReq({ remoteAddress: DOCKER_GW, body: { provider: 'anthropic', apiKey: 'sk-ant-x' } }),
        res, 'POST', '/api/setup/test-llm-key',
      )
      expect(status()).toBe(200)
      expect(probed).toEqual(['anthropic'])
      expect(json().ok).toBe(true)
    } finally { await teardownDirect(d) }
  })
})
