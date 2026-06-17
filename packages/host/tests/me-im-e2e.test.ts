/**
 * me-im-e2e — GO-LIVE GL-1c acceptance.
 *
 * Closes the SECOND IM gap: the production bridge (im-bridge.ts) only ever
 * CONSUMES a `/bind <code>`; nothing exposed code issuance over HTTP, so a real
 * member could never produce a code. `HostMeImService` is the member-facing
 * door — mint a code, list/disconnect your own bindings. This proves it against
 * a real `IdentityStore`, with the load-bearing security properties:
 *
 *   - a minted code is actually claimable (it's a real binding code, and the
 *     binding lands on the issuing member — the whole point of the loop);
 *   - listings are per-member: Bob never sees Alice's binding;
 *   - revoke is ownership-gated — Bob revoking Alice's binding is a 404 (not a
 *     403, and not a silent success), so a member can't disconnect or even
 *     probe the existence of someone else's IM link;
 *   - re-issuing rotates: the prior code stops working the moment a new one is
 *     minted (single live code per member).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openIdentityStore, IdentityError, type IdentityStore } from '@aipehub/identity'

import { HostMeImService } from '../src/me-im-service.js'

describe('GO-LIVE GL-1c — member IM-binding surface', () => {
  let identity: IdentityStore
  let bridgeUp: boolean
  let svc: HostMeImService
  let aliceId: string
  let bobId: string

  beforeEach(() => {
    identity = openIdentityStore({ dbPath: ':memory:' })
    aliceId = identity.createUser({ email: 'alice@example.com', displayName: 'Alice' }).id
    bobId = identity.createUser({ email: 'bob@example.com', displayName: 'Bob' }).id
    bridgeUp = false
    // `enabled()` is a live read of the host's bridge handle — flip `bridgeUp`
    // to simulate the operator turning the Telegram bridge on/off.
    svc = new HostMeImService({ identity, isEnabled: () => bridgeUp })
  })

  afterEach(() => {
    identity.close()
  })

  it('enabled() tracks the live bridge state', () => {
    expect(svc.enabled()).toBe(false)
    bridgeUp = true
    expect(svc.enabled()).toBe(true)
  })

  it('mints a claimable code that binds to the issuing member', async () => {
    const { code, expiresAt } = await svc.issueCode(aliceId)
    expect(code).toMatch(/^\d{6}$/)
    expect(typeof expiresAt).toBe('number')
    expect(expiresAt).toBeGreaterThan(0)

    // The bridge's `/bind <code>` path claims it — the binding must land on Alice.
    const result = identity.claimImBindingCode({
      code,
      platform: 'telegram',
      platformUserId: '1001',
    })
    expect(result.userId).toBe(aliceId)

    const bindings = await svc.listBindings(aliceId)
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatchObject({ platform: 'telegram', platformUserId: '1001' })
  })

  it('scopes listings per member (Bob never sees Alice)', async () => {
    const { code } = await svc.issueCode(aliceId)
    identity.claimImBindingCode({ code, platform: 'telegram', platformUserId: '1001' })

    expect(await svc.listBindings(aliceId)).toHaveLength(1)
    expect(await svc.listBindings(bobId)).toHaveLength(0)
  })

  it('gates revoke on ownership — 404 for a binding the caller does not own', async () => {
    const { code } = await svc.issueCode(aliceId)
    identity.claimImBindingCode({ code, platform: 'telegram', platformUserId: '1001' })

    // Bob cannot disconnect (or probe) Alice's binding.
    await expect(svc.removeBinding(bobId, 'telegram', '1001')).rejects.toMatchObject({
      status: 404,
    })
    // Alice's binding is untouched by the failed attempt.
    expect(await svc.listBindings(aliceId)).toHaveLength(1)

    // The owner can revoke their own.
    expect(await svc.removeBinding(aliceId, 'telegram', '1001')).toBe(true)
    expect(await svc.listBindings(aliceId)).toHaveLength(0)
  })

  it('rotates: re-issuing invalidates the prior code (one live code per member)', async () => {
    const first = await svc.issueCode(aliceId)
    const second = await svc.issueCode(aliceId)
    expect(second.code).not.toBe(first.code)

    // The first code is dead the moment the second was minted.
    expect(() =>
      identity.claimImBindingCode({
        code: first.code,
        platform: 'telegram',
        platformUserId: '1001',
      }),
    ).toThrow(IdentityError)

    // The current code still binds.
    const result = identity.claimImBindingCode({
      code: second.code,
      platform: 'telegram',
      platformUserId: '1001',
    })
    expect(result.userId).toBe(aliceId)
  })
})
