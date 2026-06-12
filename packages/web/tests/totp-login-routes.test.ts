/**
 * Route B P1-M3d — the HTTP login-challenge contract.
 *
 * The store-level gate is pinned in identity (totp-login.test.ts). Here we pin
 * what the WEB layer does with it: when authenticatePassword throws
 * `totp_required`, /api/admin/identity/login must reply with a typed challenge
 * (401 `{challenge:'totp'}`, NO Set-Cookie) instead of a flat error, forward a
 * `totpCode` from the body on the retry, and — crucially — NOT burn rate-limit
 * budget for the challenge itself (a correct password awaiting its second
 * factor is not a brute-force attempt; only a wrong code is).
 *
 * Boots a real Space + Hub + IdentityStore (WITH a master key, since TOTP
 * secrets live in the vault) + serveWeb, enrolls a member's factor
 * out-of-band, then drives fetch against the login route.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { Hub, Space } from '@aipehub/core'
import {
  openIdentityStore,
  type IdentityStore,
  MASTER_KEY_LEN_BYTES,
} from '@aipehub/identity'
import { base32Decode, totpCodeAt } from '@aipehub/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'

const MASTER_KEY = randomBytes(MASTER_KEY_LEN_BYTES)
const MEMBER_EMAIL = 'member@team.test'
const MEMBER_PASSWORD = 'member-strong-password'

interface Boot {
  tmp: string
  hub: Hub
  identity: IdentityStore
  server: WebServerHandle
  baseUrl: string
  /** The member's TOTP secret (base32) for computing live codes. */
  secret: string
}

/**
 * A code valid for the wall clock + offset (the store verifies against
 * Date.now(), ±1 step). Login assertions pass +30s — the NEXT step — because
 * the setup's confirm consumed the current step and the replay guard refuses
 * to accept any step twice (audit F1).
 */
function liveCode(secret: string, offsetSeconds = 0): string {
  return totpCodeAt(base32Decode(secret), Math.floor(Date.now() / 1000) + offsetSeconds)
}

async function boot(rateLimit?: { max: number; windowSec: number }): Promise<Boot> {
  const tmp = await mkdtemp(join(tmpdir(), 'aipehub-totp-login-'))
  const init = await Space.init(tmp, { name: 'totp-login-test' })
  const hub = new Hub({ space: init.space })
  await hub.start()

  const identity = openIdentityStore({
    dbPath: join(tmp, 'identity.sqlite'),
    masterKey: MASTER_KEY,
  })
  identity.bootstrap({ ownerEmail: 'admin@local', ownerDisplayName: 'Owner' })

  const member = identity.createUser({
    email: MEMBER_EMAIL,
    displayName: 'Member',
    password: MEMBER_PASSWORD,
    role: 'member',
  })
  const enrollment = identity.enrollTotp({
    userId: member.id,
    account: MEMBER_EMAIL,
    issuer: 'AipeHub',
  })
  // Confirm with a code for the wall clock → factor becomes ACTIVE.
  const ok = identity.confirmTotp({
    userId: member.id,
    code: totpCodeAt(base32Decode(enrollment.secretBase32), Math.floor(Date.now() / 1000)),
  })
  if (!ok) throw new Error('test setup: TOTP confirm failed')

  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(rateLimit ? { adminLoginRateLimit: rateLimit } : {}),
  })
  return { tmp, hub, identity, server, baseUrl: server.url, secret: enrollment.secretBase32 }
}

async function teardown(b: Boot): Promise<void> {
  await b.server.close()
  b.identity.close()
  await b.hub.stop?.()
  await rm(b.tmp, { recursive: true, force: true })
}

function login(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('login route — TOTP challenge (P1-M3d)', () => {
  let b: Boot
  beforeEach(async () => {
    // Rate limiting disabled for the functional assertions; a dedicated test
    // below boots its own server with a real budget to pin the no-burn rule.
    b = await boot({ max: 0, windowSec: 60 })
  })
  afterEach(() => teardown(b))

  it('correct password, no code → 401 typed challenge, no session cookie', async () => {
    const r = await login(b.baseUrl, { email: MEMBER_EMAIL, password: MEMBER_PASSWORD })
    expect(r.status).toBe(401)
    expect(r.headers.get('set-cookie')).toBeNull()
    const j = (await r.json()) as { ok?: boolean; challenge?: string; code?: string }
    expect(j.ok).toBe(false)
    expect(j.challenge).toBe('totp')
    expect(j.code).toBe('totp_required')
  })

  it('correct password + correct code → 200 + session cookie', async () => {
    const r = await login(b.baseUrl, {
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
      totpCode: liveCode(b.secret, 30),
    })
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie') ?? '').toContain('aipehub_identity=')
    const j = (await r.json()) as { ok?: boolean }
    expect(j.ok).toBe(true)
  })

  it('correct password + wrong code → 401 generic authentication_failed (no oracle)', async () => {
    const r = await login(b.baseUrl, {
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
      totpCode: '000000',
    })
    expect(r.status).toBe(401)
    expect(r.headers.get('set-cookie')).toBeNull()
    const j = (await r.json()) as { code?: string; challenge?: string }
    expect(j.code).toBe('authentication_failed')
    // Must NOT leak that the password was right via a challenge field.
    expect(j.challenge).toBeUndefined()
  })

  it('wrong password (MFA active) → authentication_failed, never the totp challenge', async () => {
    // Even with a valid code present, a bad password fails first — no MFA oracle.
    const r = await login(b.baseUrl, {
      email: MEMBER_EMAIL,
      password: 'wrong',
      totpCode: liveCode(b.secret),
    })
    expect(r.status).toBe(401)
    const j = (await r.json()) as { code?: string; challenge?: string }
    expect(j.code).toBe('authentication_failed')
    expect(j.challenge).toBeUndefined()
  })

  it('blank totpCode is treated as absent → challenge, not a wrong-code failure', async () => {
    const r = await login(b.baseUrl, {
      email: MEMBER_EMAIL,
      password: MEMBER_PASSWORD,
      totpCode: '',
    })
    expect(r.status).toBe(401)
    const j = (await r.json()) as { challenge?: string }
    expect(j.challenge).toBe('totp')
  })
})

describe('login route — TOTP challenge does not burn rate-limit budget (P1-M3d)', () => {
  it('many challenges leave budget intact; a wrong code consumes it', async () => {
    // max:1 — a single failure exhausts the per-IP budget for the window.
    const b = await boot({ max: 1, windowSec: 60 })
    try {
      // Five correct-password-no-code challenges. If the challenge burned
      // budget, the 2nd would already 429.
      for (let i = 0; i < 5; i++) {
        const r = await login(b.baseUrl, { email: MEMBER_EMAIL, password: MEMBER_PASSWORD })
        expect(r.status).toBe(401)
        expect(((await r.json()) as { challenge?: string }).challenge).toBe('totp')
      }
      // Budget is still intact → a correct-code login succeeds.
      const good = await login(b.baseUrl, {
        email: MEMBER_EMAIL,
        password: MEMBER_PASSWORD,
        totpCode: liveCode(b.secret, 30),
      })
      expect(good.status).toBe(200)

      // Now prove a WRONG code DOES burn budget: one wrong code, then the
      // next attempt is rate-limited (429) regardless of correctness.
      const b2 = await boot({ max: 1, windowSec: 60 })
      try {
        const wrong = await login(b2.baseUrl, {
          email: MEMBER_EMAIL,
          password: MEMBER_PASSWORD,
          totpCode: '000000',
        })
        expect(wrong.status).toBe(401)
        const blocked = await login(b2.baseUrl, {
          email: MEMBER_EMAIL,
          password: MEMBER_PASSWORD,
          totpCode: liveCode(b2.secret),
        })
        expect(blocked.status).toBe(429)
      } finally {
        await teardown(b2)
      }
    } finally {
      await teardown(b)
    }
  })
})
