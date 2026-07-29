/**
 * device-pairing-e2e — SHELL-M1 acceptance.
 *
 * `packages/identity/tests/device-pairing.test.ts` pins the store, and
 * `packages/web/tests/device-routes.test.ts` pins the HTTP shapes against a
 * stub. Neither can reach the seam that actually matters for this milestone:
 *
 *   a key that came out of a QR scan, used as `Authorization: Bearer`,
 *   really reaches `/api/me/*` as that member — and stops when it expires.
 *
 * That is the whole claim SHELL-M1 makes. Everything else in the track (the
 * base-URL layer, the SDUI contract, the Capacitor shell) assumes it. So this
 * drives the real thing: real IdentityStore, real HostMeDeviceService, real
 * serveWeb, no stubs — the exact wiring `main.ts` builds.
 *
 * Also pinned here because only a real store can show it:
 *   - the code is single-shot across the real HTTP surface (two apps racing
 *     one QR: exactly one gets a key);
 *   - a device Bob paired cannot be revoked by Alice, and the refusal is a
 *     404 — indistinguishable from an id that never existed;
 *   - revoking really cuts the app off mid-life.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Hub, Space } from '@gotong/core'
import { serveWeb, type WebServerHandle } from '@gotong/web'
import { openIdentityStore, type IdentityStore } from '@gotong/identity'

import { HostMeDeviceService } from '../src/me-device-service.js'

describe('SHELL-M1 — device pairing end to end', () => {
  let tmp: string
  let hub: Hub
  let identity: IdentityStore
  let server: WebServerHandle
  let aliceCookie: string
  let aliceId: string
  let bobCookie: string
  let bobId: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'gotong-device-e2e-'))
    const init = await Space.init(tmp, { name: 'device-e2e' })
    hub = new Hub({ space: init.space })
    await hub.start()

    const { token: adminToken } = await init.space.createAdmin('Owner')
    identity = openIdentityStore({ dbPath: join(tmp, 'identity.sqlite') })
    identity.bootstrap({
      adminToken,
      ownerEmail: 'owner@local',
      ownerDisplayName: 'Owner',
    })
    aliceId = identity.createUser({
      email: 'alice@team.test',
      displayName: 'Alice',
      password: 'alice-strong-password',
      role: 'member',
    }).id
    bobId = identity.createUser({
      email: 'bob@team.test',
      displayName: 'Bob',
      password: 'bob-strong-password',
      role: 'member',
    }).id

    // The exact wiring main.ts builds — no stub in the path.
    server = await serveWeb(hub, {
      host: '127.0.0.1',
      port: 0,
      identity,
      devices: new HostMeDeviceService({ identity }),
    })

    aliceCookie = await login('alice@team.test', 'alice-strong-password')
    bobCookie = await login('bob@team.test', 'bob-strong-password')
  })

  afterEach(async () => {
    await server.close()
    identity.close()
    await hub.stop()
    await rm(tmp, { recursive: true, force: true })
  })

  async function login(email: string, password: string): Promise<string> {
    const res = await fetch(`${server.url}/api/admin/identity/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.status !== 200) throw new Error(`login ${email} failed ${res.status}`)
    return res.headers.get('set-cookie')!.split(';')[0]!
  }

  /** Mint a pairing code the way the SPA does. */
  async function mintCode(cookie: string): Promise<{ code: string; display: string }> {
    const res = await fetch(`${server.url}/api/me/devices/pairing-code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
    })
    expect(res.status).toBe(201)
    return res.json() as Promise<{ code: string; display: string }>
  }

  /** Redeem it the way the app does — no cookie, no prior credential. */
  async function claim(
    code: string,
    deviceLabel?: string,
  ): Promise<{ status: number; json: any }> {
    const res = await fetch(`${server.url}/api/devices/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, ...(deviceLabel ? { deviceLabel } : {}) }),
    })
    return { status: res.status, json: await res.json().catch(() => ({})) }
  }

  it('a scanned code becomes a Bearer key that reaches /api/me as that member', async () => {
    const { code, display } = await mintCode(aliceCookie)

    // The app scans the QR — but a member retyping the grouped form must land
    // in the same place, so redeem the DISPLAY form here on purpose.
    const claimed = await claim(display, "Alice's iPhone")
    expect(claimed.status).toBe(200)
    expect(claimed.json.key).toMatch(/^aipk_/)
    expect(claimed.json.userId).toBe(aliceId)
    expect(display.replace(/-/g, '')).toBe(code)

    // THE assertion of this milestone: Bearer, no cookie, a real /me route
    // — and it resolves to ALICE, which we prove by what comes back. The
    // /me routes are all userId-pinned from the resolved session, so a list
    // containing exactly the device that just paired is the circle closing.
    const asApp = await fetch(`${server.url}/api/me/devices`, {
      headers: { authorization: `Bearer ${claimed.json.key}` },
    })
    expect(asApp.status).toBe(200)
    const seen = await asApp.json()
    expect(seen.available).toBe(true)
    expect(seen.devices).toHaveLength(1)
    expect(seen.devices[0].label).toBe("Alice's iPhone")
    expect(seen.devices[0].expiresAt).toBeGreaterThan(Date.now())

    // Same rows Alice sees from her browser — one member, two doors.
    const viaCookie = await fetch(`${server.url}/api/me/devices`, {
      headers: { cookie: aliceCookie },
    })
    expect((await viaCookie.json()).devices).toEqual(seen.devices)

    // And Bob, holding his own session, sees none of it.
    const bobsView = await fetch(`${server.url}/api/me/devices`, {
      headers: { cookie: bobCookie },
    })
    expect((await bobsView.json()).devices).toHaveLength(0)
  })

  it('the key stops working the moment the member revokes the device', async () => {
    const { code } = await mintCode(aliceCookie)
    const claimed = await claim(code, 'Old phone')
    const key = claimed.json.key as string

    const before = await fetch(`${server.url}/api/me/devices`, {
      headers: { authorization: `Bearer ${key}` },
    })
    expect(before.status).toBe(200)

    const list = await (
      await fetch(`${server.url}/api/me/devices`, { headers: { cookie: aliceCookie } })
    ).json()
    const credentialId = list.devices[0].credentialId as string
    const del = await fetch(`${server.url}/api/me/devices/${credentialId}`, {
      method: 'DELETE',
      headers: { cookie: aliceCookie },
    })
    expect(del.status).toBe(200)
    expect((await del.json()).removed).toBe(true)

    const after = await fetch(`${server.url}/api/me/devices`, {
      headers: { authorization: `Bearer ${key}` },
    })
    expect(after.status).toBe(401)
  })

  it('an expired key is refused even though the credential row survives', async () => {
    const { code } = await mintCode(aliceCookie)
    const claimed = await claim(code, 'Expiring phone')
    const key = claimed.json.key as string
    const credentialId = (
      await (
        await fetch(`${server.url}/api/me/devices`, { headers: { cookie: aliceCookie } })
      ).json()
    ).devices[0].credentialId as string

    // Reach past the API to age the credential — there is no route that lets
    // a caller do this, which is the point.
    ;(identity as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
      .prepare('UPDATE credentials SET expires_at = ? WHERE id = ?')
      .run(Date.now() - 1, credentialId)

    const after = await fetch(`${server.url}/api/me/whoami`, {
      headers: { authorization: `Bearer ${key}` },
    })
    expect(after.status).toBe(401)

    // Still listed, so the member can see WHY the app stopped working and
    // re-pair rather than wonder where the device went.
    const list = await (
      await fetch(`${server.url}/api/me/devices`, { headers: { cookie: aliceCookie } })
    ).json()
    expect(list.devices).toHaveLength(1)
    expect(list.devices[0].expiresAt).toBeLessThan(Date.now())
  })

  it('one QR, two apps: exactly one gets a key', async () => {
    const { code } = await mintCode(aliceCookie)
    const [first, second] = await Promise.all([claim(code, 'Phone A'), claim(code, 'Phone B')])
    const oks = [first, second].filter((r) => r.status === 200)
    const fails = [first, second].filter((r) => r.status === 400)
    expect(oks).toHaveLength(1)
    expect(fails).toHaveLength(1)
    expect(fails[0]!.json.code).toBe('pairing_failed')

    const list = await (
      await fetch(`${server.url}/api/me/devices`, { headers: { cookie: aliceCookie } })
    ).json()
    expect(list.devices).toHaveLength(1)
  })

  it("Alice cannot revoke Bob's device, and the refusal looks like 'no such id'", async () => {
    const bobCode = await mintCode(bobCookie)
    await claim(bobCode.code, "Bob's phone")
    const bobDevices = await (
      await fetch(`${server.url}/api/me/devices`, { headers: { cookie: bobCookie } })
    ).json()
    const bobCredentialId = bobDevices.devices[0].credentialId as string

    // Alice's list doesn't contain it...
    const aliceDevices = await (
      await fetch(`${server.url}/api/me/devices`, { headers: { cookie: aliceCookie } })
    ).json()
    expect(aliceDevices.devices).toHaveLength(0)

    // ...and naming it directly is a 404, the same answer a made-up id gets.
    const real = await fetch(`${server.url}/api/me/devices/${bobCredentialId}`, {
      method: 'DELETE',
      headers: { cookie: aliceCookie },
    })
    const invented = await fetch(`${server.url}/api/me/devices/no-such-credential`, {
      method: 'DELETE',
      headers: { cookie: aliceCookie },
    })
    expect(real.status).toBe(404)
    expect(invented.status).toBe(404)

    // Bob's device still works — the failed revoke was a true no-op.
    const stillThere = await (
      await fetch(`${server.url}/api/me/devices`, { headers: { cookie: bobCookie } })
    ).json()
    expect(stillThere.devices).toHaveLength(1)
    expect(bobId).not.toBe(aliceId)
  })

  it('minting a fresh code kills the one still on screen', async () => {
    const stale = await mintCode(aliceCookie)
    const fresh = await mintCode(aliceCookie)
    expect(fresh.code).not.toBe(stale.code)
    expect((await claim(stale.code)).status).toBe(400)
    expect((await claim(fresh.code)).status).toBe(200)
  })
})
