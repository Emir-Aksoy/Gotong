/**
 * Route B P1-M4e-1 — host OIDC login orchestration.
 *
 * A REAL in-memory IdentityStore (so providers, links, and minted sessions are
 * genuine) plus a STUB OidcClient (so no network / no real IdP — completeLogin
 * returns canned claims). Pins the orchestration: begin() builds a proper
 * authorization URL and stashes single-use state; complete() validates state
 * (unknown / used / expired all → oidc_state_invalid), then resolves a local
 * user — pre-existing link, JIT-link-by-verified-email, or refusal — and mints
 * a usable session. The id_token crypto itself is M4b/M4c's job, not retested.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

import {
  openIdentityStore,
  IdentityStore,
  MASTER_KEY_LEN_BYTES,
  OidcError,
  type IdTokenClaims,
} from '@gotong/identity'
import { OidcLoginService, type OidcLoginClient } from '../src/oidc-login-service.js'

const FIXED_KEY = randomBytes(MASTER_KEY_LEN_BYTES)
const ISSUER = 'https://idp.test'

/** Stub client: discovery is canned; completeLogin returns the claims we inject. */
function stubClient(claims: Partial<IdTokenClaims> & { sub: string }): OidcLoginClient & {
  completeCalls: number
} {
  const stub = {
    completeCalls: 0,
    async discover() {
      return { authorization_endpoint: `${ISSUER}/authorize` }
    },
    async completeLogin(): Promise<IdTokenClaims> {
      stub.completeCalls++
      return { iss: ISSUER, aud: 'client-1', exp: 0, ...claims } as IdTokenClaims
    },
  }
  return stub
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn()
  } catch (err) {
    expect(err).toBeInstanceOf(OidcError)
    expect((err as OidcError).code).toBe(code)
    return
  }
  throw new Error(`expected OidcError ${code}, but nothing was thrown`)
}

describe('OidcLoginService (P1-M4e-1)', () => {
  let store: IdentityStore
  let providerId: string
  let clock: number

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:', masterKey: FIXED_KEY })
    store.bootstrap()
    clock = 1_700_000_000_000
    providerId = store.addOidcProvider({
      issuer: ISSUER,
      clientId: 'client-1',
      redirectUri: 'https://hub.test/api/auth/oidc/callback',
      scope: 'openid email profile',
      clientSecret: 'idp-secret',
    }).id
  })

  function service(claims: Partial<IdTokenClaims> & { sub: string }) {
    const client = stubClient(claims)
    const svc = new OidcLoginService(store, client, { now: () => clock, stateTtlMs: 600_000 })
    return { svc, client }
  }

  it('begin() builds a code+PKCE authorization URL and stashes single-use state', async () => {
    const { svc } = service({ sub: 'sub-1' })
    const { authorizationUrl, state } = await svc.begin(providerId)
    const url = new URL(authorizationUrl)
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-1')
    expect(url.searchParams.get('redirect_uri')).toBe('https://hub.test/api/auth/oidc/callback')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe(state)
    expect(url.searchParams.get('nonce')).toBeTruthy()
    expect(svc.pendingCount()).toBe(1)
  })

  it('begin() refuses a disabled or unknown provider', async () => {
    const disabledId = store.addOidcProvider({
      issuer: 'https://off.test',
      clientId: 'c',
      redirectUri: 'https://h/cb',
      enabled: false,
    }).id
    const { svc } = service({ sub: 'sub-1' })
    await expectCode(() => svc.begin(disabledId), 'oidc_provider_disabled')
    await expectCode(() => svc.begin('no-such-provider'), 'oidc_provider_not_found')
  })

  it('completes a login for a PRE-LINKED user and mints a usable session', async () => {
    const userId = store.createUser({ email: 'linked@test', displayName: 'L', role: 'member' }).id
    store.linkOidc({ userId, issuer: ISSUER, sub: 'sub-1' })

    const { svc } = service({ sub: 'sub-1' })
    const { state } = await svc.begin(providerId)
    const { session, userId: resolved } = await svc.complete({ state, code: 'auth-code' })

    expect(resolved).toBe(userId)
    const back = store.getSessionByToken(session.token)
    expect(back?.user.id).toBe(userId)
    expect(session.token).toMatch(/^ses_/)
    // State was consumed.
    expect(svc.pendingCount()).toBe(0)
  })

  it('JIT-links an unlinked identity to an existing user by verified email', async () => {
    const userId = store.createUser({ email: 'jit@test', displayName: 'J', role: 'member' }).id
    expect(store.findUserByOidc({ issuer: ISSUER, sub: 'jit-sub' })).toBeNull()

    const { svc } = service({ sub: 'jit-sub', email: 'jit@test', email_verified: true })
    const { state } = await svc.begin(providerId)
    const { userId: resolved } = await svc.complete({ state, code: 'c' })

    expect(resolved).toBe(userId)
    // The link now exists, so a second login reuses it.
    expect(store.findUserByOidc({ issuer: ISSUER, sub: 'jit-sub' })).toBe(userId)
  })

  it('refuses an unknown identity (no link, no verified-email match)', async () => {
    store.createUser({ email: 'someone@test', displayName: 'S', role: 'member' })
    // (a) verified email that matches no local user
    {
      const { svc } = service({ sub: 'ext-1', email: 'stranger@test', email_verified: true })
      const { state } = await svc.begin(providerId)
      await expectCode(() => svc.complete({ state, code: 'c' }), 'oidc_no_account')
    }
    // (b) matching email but NOT verified → must not auto-link
    {
      const { svc } = service({ sub: 'ext-2', email: 'someone@test', email_verified: false })
      const { state } = await svc.begin(providerId)
      await expectCode(() => svc.complete({ state, code: 'c' }), 'oidc_no_account')
    }
  })

  it('rejects an unknown or already-used state (single-use)', async () => {
    const userId = store.createUser({ email: 'l2@test', displayName: 'L', role: 'member' }).id
    store.linkOidc({ userId, issuer: ISSUER, sub: 'sub-2' })

    const { svc } = service({ sub: 'sub-2' })
    await expectCode(() => svc.complete({ state: 'never-issued', code: 'c' }), 'oidc_state_invalid')

    const { state } = await svc.begin(providerId)
    await svc.complete({ state, code: 'c' }) // consumes it
    await expectCode(() => svc.complete({ state, code: 'c' }), 'oidc_state_invalid')
  })

  it('rejects an expired state', async () => {
    const userId = store.createUser({ email: 'l3@test', displayName: 'L', role: 'member' }).id
    store.linkOidc({ userId, issuer: ISSUER, sub: 'sub-3' })

    const { svc } = service({ sub: 'sub-3' })
    const { state } = await svc.begin(providerId)
    clock += 600_001 // advance past the 10-minute TTL
    await expectCode(() => svc.complete({ state, code: 'c' }), 'oidc_state_invalid')
  })
})
