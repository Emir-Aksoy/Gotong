/**
 * Route B P1-M3e — /api/me/totp/* member self-service.
 *
 * A signed-in member enrolls, confirms, and disables their OWN second factor.
 * Pins: enroll → pending (secret + otpauth URI returned once), confirm with a
 * current code → active, a WRONG confirm code stays pending, disabling an
 * ACTIVE factor requires a current code (a stolen session alone can't strip
 * 2FA), a PENDING enrollment can be cancelled without a code, and every route
 * 503s when the host configured no master key (the secret can't be encrypted).
 *
 * Boots a real Space + Hub + IdentityStore + serveWeb and drives fetch with the
 * member's session cookie (minted out-of-band before any factor is active).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore, MASTER_KEY_LEN_BYTES } from '@gotong/identity'
import { base32Decode, totpCodeAt } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'

const MASTER_KEY = randomBytes(MASTER_KEY_LEN_BYTES)
const EMAIL = 'member@team.test'
const PASSWORD = 'member-strong-password'

interface Boot {
  tmp: string
  hub: Hub
  identity: IdentityStore
  server: WebServerHandle
  baseUrl: string
  cookie: string
}

// Offset picks a DIFFERENT step when one was already consumed — the replay
// guard (audit F1) refuses to accept any time step twice.
function liveCode(secret: string, offsetSeconds = 0): string {
  return totpCodeAt(base32Decode(secret), Math.floor(Date.now() / 1000) + offsetSeconds)
}

async function boot(opts: { masterKey?: boolean } = {}): Promise<Boot> {
  const withKey = opts.masterKey ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-totp-me-'))
  const init = await Space.init(tmp, { name: 'totp-me-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()

  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    ...(withKey ? { masterKey: MASTER_KEY } : {}),
  })
  identity.bootstrap({ ownerEmail: 'admin@local', ownerDisplayName: 'Owner' })
  const member = identity.createUser({
    email: EMAIL,
    displayName: 'Member',
    password: PASSWORD,
    role: 'member',
  })
  // Mint the member's session BEFORE any factor exists, so login needs no code.
  const sess = identity.authenticatePassword({ email: EMAIL, password: PASSWORD })
  void member

  const server = await serveWeb(hub, { host: '127.0.0.1', port: 0, identity })
  return {
    tmp,
    hub,
    identity,
    server,
    baseUrl: server.url,
    cookie: `gotong_identity=${sess.token}`,
  }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  b.identity.close()
  await b.hub.stop?.()
  await rm(b.tmp, { recursive: true, force: true })
}

describe('/api/me/totp — member MFA self-service (P1-M3e)', () => {
  let b: Boot
  beforeEach(async () => {
    b = await boot()
  })
  afterEach(() => teardown(b))

  function me(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return fetch(`${b.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: b.cookie },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  }

  async function state(): Promise<string> {
    return ((await (await me('/api/me/totp')).json()) as { state: string }).state
  }

  it('starts with no factor', async () => {
    const r = await me('/api/me/totp')
    expect(r.status).toBe(200)
    expect(((await r.json()) as { state: string }).state).toBe('none')
  })

  it('enroll → pending, returns a secret + otpauth URI', async () => {
    const r = await me('/api/me/totp/enroll', 'POST')
    expect(r.status).toBe(200)
    const j = (await r.json()) as { ok: boolean; secretBase32: string; otpauthUri: string }
    expect(j.ok).toBe(true)
    expect(j.secretBase32).toMatch(/^[A-Z2-7]+=*$/u)
    expect(j.otpauthUri).toContain('otpauth://totp/')
    expect(j.otpauthUri).toContain('issuer=Gotong')
    expect(await state()).toBe('pending')
  })

  it('confirm: wrong code stays pending, correct code activates', async () => {
    const enroll = (await (await me('/api/me/totp/enroll', 'POST')).json()) as {
      secretBase32: string
    }
    const bad = await me('/api/me/totp/confirm', 'POST', { code: '000000' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { code: string }).code).toBe('invalid_code')
    expect(await state()).toBe('pending')

    const good = await me('/api/me/totp/confirm', 'POST', { code: liveCode(enroll.secretBase32) })
    expect(good.status).toBe(200)
    expect(((await good.json()) as { ok: boolean }).ok).toBe(true)
    expect(await state()).toBe('active')
  })

  it('confirm with no pending enrollment → 409', async () => {
    const r = await me('/api/me/totp/confirm', 'POST', { code: '000000' })
    // No enrollment at all → identity throws invalid_input, mapped to 409.
    expect(r.status).toBe(409)
  })

  it('disabling an ACTIVE factor requires a current code', async () => {
    const enroll = (await (await me('/api/me/totp/enroll', 'POST')).json()) as {
      secretBase32: string
    }
    await me('/api/me/totp/confirm', 'POST', { code: liveCode(enroll.secretBase32) })
    expect(await state()).toBe('active')

    // No code → refused, factor stays active.
    const noCode = await me('/api/me/totp/disable', 'POST')
    expect(noCode.status).toBe(400)
    expect(await state()).toBe('active')

    // Wrong code → refused.
    const wrong = await me('/api/me/totp/disable', 'POST', { code: '000000' })
    expect(wrong.status).toBe(400)
    expect(await state()).toBe('active')

    // Correct FRESH code (next step — confirm consumed the current one) → removed.
    const ok = await me('/api/me/totp/disable', 'POST', {
      code: liveCode(enroll.secretBase32, 30),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true)
    expect(await state()).toBe('none')
  })

  it('a PENDING enrollment can be cancelled without a code', async () => {
    await me('/api/me/totp/enroll', 'POST')
    expect(await state()).toBe('pending')
    const r = await me('/api/me/totp/disable', 'POST') // no code
    expect(r.status).toBe(200)
    expect(await state()).toBe('none')
  })

  it('disable with no enrollment at all → 400', async () => {
    const r = await me('/api/me/totp/disable', 'POST')
    expect(r.status).toBe(400)
    expect(((await r.json()) as { code: string }).code).toBe('no_enrollment')
  })

  it('unauthenticated → 401 (the /me gate)', async () => {
    const r = await fetch(`${b.baseUrl}/api/me/totp`, { method: 'GET' })
    expect(r.status).toBe(401)
  })
})

describe('/api/me/totp — no master key configured (P1-M3e)', () => {
  it('enroll returns 503 (the secret cannot be encrypted)', async () => {
    const b = await boot({ masterKey: false })
    try {
      const r = await fetch(`${b.baseUrl}/api/me/totp/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: b.cookie },
      })
      expect(r.status).toBe(503)
      expect(((await r.json()) as { code: string }).code).toBe('vault_not_configured')
    } finally {
      await teardown(b)
    }
  })
})
