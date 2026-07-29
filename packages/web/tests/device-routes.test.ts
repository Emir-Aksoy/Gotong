/**
 * SHELL-M1 — HTTP tests for app device pairing.
 *
 *   POST   /api/me/devices/pairing-code   member self-service
 *   GET    /api/me/devices                the member's paired devices
 *   DELETE /api/me/devices/:credentialId  revoke one
 *   POST   /api/devices/claim             PUBLIC
 *
 * Pins, in order of how much they'd hurt if they broke:
 *   - the claim route really is reachable with NO cookie and NO bearer (that
 *     is the entire point) and yet is NOT reachable past its per-IP budget
 *   - a failed claim answers the same way whether the code was wrong or
 *     merely expired — a public endpoint must not map the live code space
 *   - the member half is SESSION-pinned: a userId in the query is ignored
 *   - no surface → GET is an honest {available:false}, POSTs 503
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hub, Space } from '@gotong/core'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { serveWeb, type WebServerHandle } from '../src/server.js'
import type { DeviceRow, MeDeviceSurface } from '../src/device-routes.js'

class DuckPairingError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/**
 * Stub with just enough of the real store's behaviour to exercise the route
 * layer: one live code, and the two distinct refusals the wire must flatten.
 */
class StubDevices implements MeDeviceSurface {
  readonly issuedFor: string[] = []
  readonly listedFor: string[] = []
  readonly revokeCalls: Array<{ userId: string; credentialId: string }> = []
  readonly claimCalls: Array<{ code: string; deviceLabel?: string | null }> = []
  rows: DeviceRow[] = [
    {
      credentialId: 'cred-1',
      label: "Alice's iPhone",
      createdAt: 1_700_000_000_000,
      expiresAt: 1_800_000_000_000,
      lastUsedAt: null,
    },
  ]

  async issueCode(userId: string) {
    this.issuedFor.push(userId)
    return {
      code: 'ABCDEFGHJKMNPQRS',
      display: 'ABCD-EFGH-JKMN-PQRS',
      expiresAt: 1_700_000_600_000,
    }
  }
  async list(userId: string) {
    this.listedFor.push(userId)
    return this.rows
  }
  async revoke(userId: string, credentialId: string) {
    this.revokeCalls.push({ userId, credentialId })
    // The real host surface answers 404 for "not a device of yours" — a
    // status-coded error, exactly like the member-agent surface.
    if (credentialId === 'cred-of-somebody-else') {
      throw Object.assign(new Error('device not found'), { status: 404 })
    }
    return { removed: credentialId === 'cred-1' }
  }
  async claim(input: { code: string; deviceLabel?: string | null }) {
    this.claimCalls.push(input)
    // Normalisation is the store's job, not the route's — mirror just enough
    // of it here so the "route forwards what was typed" assertion is real.
    const code = input.code.replace(/[-\s]/g, '').toUpperCase()
    if (code === 'ABCDEFGHJKMNPQRS') {
      return { key: 'aipk_stub-device-key', userId: 'user-alice', expiresAt: 1_800_000_000_000 }
    }
    if (code === 'EXPIREDEXPIRED00') {
      throw new DuckPairingError('device_pairing_code_expired')
    }
    if (code === 'NOTACODE') throw new DuckPairingError('invalid_input')
    throw new DuckPairingError('device_pairing_code_invalid')
  }
}

interface Boot {
  tmp: string
  server: WebServerHandle
  identity: IdentityStore
  memberCookie: string
  memberUserId: string
  stub: StubDevices | undefined
}

async function boot(opts: { withSurface?: boolean; trustProxy?: boolean } = {}): Promise<Boot> {
  const withSurface = opts.withSurface ?? true
  const tmp = await mkdtemp(join(tmpdir(), 'gotong-me-devices-'))
  const init = await Space.init(tmp, { name: 'me-devices-test' })
  const space = init.space
  const hub = new Hub({ space })
  await hub.start()

  const { token: adminToken } = await space.createAdmin('TestAdmin')
  const identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
  identity.bootstrap({ adminToken, ownerEmail: 'admin@local', ownerDisplayName: 'TestAdmin' })
  const member = identity.createUser({
    email: 'member@team.test',
    displayName: 'Member',
    password: 'member-strong-password',
    role: 'member',
  })

  const stub = withSurface ? new StubDevices() : undefined
  const server = await serveWeb(hub, {
    host: '127.0.0.1',
    port: 0,
    identity,
    ...(opts.trustProxy ? { trustProxy: true } : {}),
    ...(stub ? { devices: stub } : {}),
  })

  const loginRes = await fetch(`${server.url}/api/admin/identity/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'member@team.test', password: 'member-strong-password' }),
  })
  if (loginRes.status !== 200) throw new Error(`member login failed ${loginRes.status}`)
  const memberCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!

  return { tmp, server, identity, memberCookie, memberUserId: member.id, stub }
}

describe('device pairing routes (SHELL-M1)', () => {
  let b: Boot

  afterEach(async () => {
    await b.server.close()
    b.identity.close()
    await rm(b.tmp, { recursive: true, force: true })
  })

  async function req(
    method: string,
    path: string,
    opts: { auth?: boolean; body?: unknown } = {},
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${b.server.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...((opts.auth ?? true) ? { cookie: b.memberCookie } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
    return { status: res.status, json: await res.json().catch(() => ({})) }
  }

  // ---- member half ----

  it('unauthenticated member routes → 401', async () => {
    b = await boot()
    expect((await req('GET', '/api/me/devices', { auth: false })).status).toBe(401)
    expect(
      (await req('POST', '/api/me/devices/pairing-code', { auth: false })).status,
    ).toBe(401)
    expect(b.stub!.issuedFor).toHaveLength(0)
    expect(b.stub!.listedFor).toHaveLength(0)
  })

  it('no surface: GET is an honest {available:false}, POST/DELETE 503', async () => {
    b = await boot({ withSurface: false })
    const g = await req('GET', '/api/me/devices')
    expect(g.status).toBe(200)
    expect(g.json).toEqual({ available: false, devices: [] })
    expect((await req('POST', '/api/me/devices/pairing-code')).status).toBe(503)
    expect((await req('DELETE', '/api/me/devices/cred-1')).status).toBe(503)
  })

  it('issues a code with both the QR form and the readable form', async () => {
    b = await boot()
    const r = await req('POST', '/api/me/devices/pairing-code')
    expect(r.status).toBe(201)
    expect(r.json.code).toBe('ABCDEFGHJKMNPQRS')
    expect(r.json.display).toBe('ABCD-EFGH-JKMN-PQRS')
    expect(r.json.expiresAt).toBe(1_700_000_600_000)
    expect(b.stub!.issuedFor).toEqual([b.memberUserId])
  })

  it('encodes the hub address and the code into one scannable payload', async () => {
    b = await boot()
    const r = await req('POST', '/api/me/devices/pairing-code')
    const origin = b.server.url.replace(/\/$/, '')
    // Address + code in one scan: that pairing is one step, not "type this
    // hostname AND then this code", is the reason a QR was chosen at all.
    expect(r.json.pairingUrl).toBe(
      `gotong://pair?u=${encodeURIComponent(origin)}&c=ABCDEFGHJKMNPQRS`,
    )
    expect(r.json.qrDataUri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    // Self-contained vector: no href/src means the code that carries a live
    // credential never reaches for anything off this host to render.
    const svg = decodeURIComponent(r.json.qrDataUri.split(',')[1])
    expect(svg).toContain('<svg')
    expect(svg).not.toMatch(/href|src=|<image/)
  })

  it('believes X-Forwarded-Proto only when the server was told to', async () => {
    // Behind a proxy the member reaches us over https and their phone must be
    // told https; on a bare loopback host the same header is just a claim.
    const claimsHttps = { 'x-forwarded-proto': 'https' }
    b = await boot()
    const untrusted = await fetch(`${b.server.url}/api/me/devices/pairing-code`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, ...claimsHttps },
    })
    expect((await untrusted.json()).pairingUrl).toContain('u=http%3A%2F%2F')
    await b.server.close()
    b.identity.close()
    await rm(b.tmp, { recursive: true, force: true })

    b = await boot({ trustProxy: true })
    const trusted = await fetch(`${b.server.url}/api/me/devices/pairing-code`, {
      method: 'POST',
      headers: { cookie: b.memberCookie, ...claimsHttps },
    })
    expect((await trusted.json()).pairingUrl).toContain('u=https%3A%2F%2F')
  })

  it('pins userId to the session — a userId in the query is ignored', async () => {
    b = await boot()
    await req('POST', '/api/me/devices/pairing-code?userId=somebody-else')
    await req('GET', '/api/me/devices?userId=somebody-else')
    expect(b.stub!.issuedFor).toEqual([b.memberUserId])
    expect(b.stub!.listedFor).toEqual([b.memberUserId])
  })

  it('lists devices and revokes one, scoped to the caller', async () => {
    b = await boot()
    const g = await req('GET', '/api/me/devices')
    expect(g.status).toBe(200)
    expect(g.json.available).toBe(true)
    expect(g.json.devices[0].label).toBe("Alice's iPhone")

    const d = await req('DELETE', '/api/me/devices/cred-1')
    expect(d.status).toBe(200)
    expect(d.json).toEqual({ ok: true, removed: true })
    // The surface — not the URL — decides ownership, so the userId it was
    // handed must be the session's.
    expect(b.stub!.revokeCalls).toEqual([
      { userId: b.memberUserId, credentialId: 'cred-1' },
    ])

    const miss = await req('DELETE', '/api/me/devices/cred-nope')
    expect(miss.status).toBe(200)
    expect(miss.json.removed).toBe(false)
  })

  it("carries the surface's 404 through instead of flattening it to 500", async () => {
    // Someone else's credential id must look like an id that never existed.
    // Collapsing that refusal to 500 would read as a bug and, worse, would
    // distinguish it from the 404 an invented id gets.
    b = await boot()
    const r = await req('DELETE', '/api/me/devices/cred-of-somebody-else')
    expect(r.status).toBe(404)
  })

  // ---- public claim ----

  it('claims a code with NO session and NO bearer', async () => {
    b = await boot()
    const r = await req('POST', '/api/devices/claim', {
      auth: false,
      body: { code: 'ABCD-EFGH-JKMN-PQRS', deviceLabel: "Alice's iPhone" },
    })
    expect(r.status).toBe(200)
    expect(r.json.key).toBe('aipk_stub-device-key')
    expect(r.json.userId).toBe('user-alice')
    // The route forwards what was typed; normalisation is the store's job.
    expect(b.stub!.claimCalls).toEqual([
      { code: 'ABCD-EFGH-JKMN-PQRS', deviceLabel: "Alice's iPhone" },
    ])
  })

  it('answers a wrong code and an expired code identically', async () => {
    b = await boot()
    const wrong = await req('POST', '/api/devices/claim', {
      auth: false,
      body: { code: 'ZZZZZZZZZZZZZZZZ' },
    })
    const expired = await req('POST', '/api/devices/claim', {
      auth: false,
      body: { code: 'EXPIREDEXPIRED00' },
    })
    const malformed = await req('POST', '/api/devices/claim', {
      auth: false,
      body: { code: 'NOTACODE' },
    })
    expect(wrong.status).toBe(400)
    // Byte-identical bodies: the endpoint must not leak which codes exist.
    expect(expired).toEqual(wrong)
    expect(malformed).toEqual(wrong)
    expect(wrong.json.code).toBe('pairing_failed')
  })

  it('tolerates a missing or garbled body without crashing', async () => {
    b = await boot()
    const bare = await fetch(`${b.server.url}/api/devices/claim`, { method: 'POST' })
    expect(bare.status).toBe(400)
    const garbled = await fetch(`${b.server.url}/api/devices/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(garbled.status).toBe(400)
  })

  it('rate-limits the claim endpoint per IP', async () => {
    b = await boot()
    const fire = () =>
      req('POST', '/api/devices/claim', { auth: false, body: { code: 'ZZZZZZZZZZZZZZZZ' } })
    // The budget is 10/min. Ten wrong guesses are refused on their merits...
    for (let i = 0; i < 10; i++) expect((await fire()).status).toBe(400)
    // ...and the eleventh doesn't even reach the store.
    const over = await fire()
    expect(over.status).toBe(429)
    expect(over.json.code).toBe('rate_limited')
    expect(b.stub!.claimCalls).toHaveLength(10)
  })

  it('rejects a non-POST claim with 405', async () => {
    b = await boot()
    const res = await fetch(`${b.server.url}/api/devices/claim`, { method: 'GET' })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('503s the claim route when no surface is wired', async () => {
    b = await boot({ withSurface: false })
    const r = await req('POST', '/api/devices/claim', {
      auth: false,
      body: { code: 'ABCDEFGHJKMNPQRS' },
    })
    expect(r.status).toBe(503)
  })
})
