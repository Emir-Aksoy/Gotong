/**
 * Route B P1-M5d — host SAML login orchestration.
 *
 * A REAL in-memory IdentityStore (providers, links, and minted sessions are
 * genuine) plus a STUB SamlProtocol (so no real XML-DSig — validateSamlResponse
 * returns a canned assertion and records what it was asked to verify). Pins the
 * orchestration: begin() builds a redirect and stashes single-use RelayState,
 * passing the host ACS + per-provider SP entityID into the AuthnRequest;
 * complete() validates RelayState (unknown / used / expired → saml_state_invalid),
 * pins InResponseTo to the issued request @ID, then resolves a local user
 * (pre-existing link, JIT-link-by-asserted-email, or refusal) and mints a usable
 * session. The signature math itself is the saml package's job, not retested
 * here; a validation failure is simulated by having the stub throw.
 *
 * No masterKey on the store on purpose: SAML providers carry no vault secret.
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { openIdentityStore, IdentityStore } from '@aipehub/identity'
import {
  SamlError,
  type AuthnRequestInput,
  type AuthnRequestResult,
  type SamlAssertionResult,
  type ValidateSamlResponseInput,
} from '@aipehub/saml'
import { SamlLoginService, type SamlProtocol } from '../src/saml-login-service.js'

const IDP_ENTITY = 'https://idp.test/entity'
const SSO_URL = 'https://idp.test/sso'
const IDP_CERT = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----'
const SP_ENTITY = 'https://hub.test/saml/metadata'
const ACS_URL = 'https://hub.test/api/auth/saml/acs'

/** A canned assertion with sensible defaults; override per test. */
function assertion(over: Partial<SamlAssertionResult> & { nameId: string }): SamlAssertionResult {
  return {
    issuer: IDP_ENTITY,
    attributes: {},
    email: null,
    assertionId: 'assn-1',
    ...over,
  }
}

/**
 * Stub protocol: generateAuthnRequest hands back a deterministic @ID and echoes
 * RelayState into the redirect; validateSamlResponse returns the injected
 * assertion (or throws `failWith`) and records each input for assertions.
 */
function stubProtocol(
  result: SamlAssertionResult,
  failWith?: SamlError,
): SamlProtocol & {
  generateInputs: AuthnRequestInput[]
  validateInputs: ValidateSamlResponseInput[]
  genCount: number
} {
  const stub = {
    generateInputs: [] as AuthnRequestInput[],
    validateInputs: [] as ValidateSamlResponseInput[],
    genCount: 0,
    generateAuthnRequest(input: AuthnRequestInput): AuthnRequestResult {
      stub.generateInputs.push(input)
      const id = `req-${++stub.genCount}`
      const url = `${input.idpSsoUrl}?SAMLRequest=DEFLATED&RelayState=${encodeURIComponent(input.relayState ?? '')}`
      return { id, redirectUrl: url, xml: `<AuthnRequest ID="${id}"/>` }
    },
    decodeSamlPostResponse(field: string): string {
      return `<decoded>${field}</decoded>`
    },
    validateSamlResponse(input: ValidateSamlResponseInput): SamlAssertionResult {
      stub.validateInputs.push(input)
      if (failWith) throw failWith
      return result
    },
  }
  return stub
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(SamlError)
    expect((err as SamlError).code).toBe(code)
    return
  }
  throw new Error(`expected SamlError ${code}, but nothing was thrown`)
}

describe('SamlLoginService (P1-M5d)', () => {
  let store: IdentityStore
  let providerId: string
  let clock: number

  beforeEach(() => {
    store = openIdentityStore({ dbPath: ':memory:' })
    store.bootstrap()
    clock = 1_700_000_000_000
    providerId = store.addSamlProvider({
      idpEntityId: IDP_ENTITY,
      ssoUrl: SSO_URL,
      idpCert: IDP_CERT,
      spEntityId: SP_ENTITY,
    }).id
  })

  function service(result: SamlAssertionResult, failWith?: SamlError) {
    const protocol = stubProtocol(result, failWith)
    const svc = new SamlLoginService(store, {
      acsUrl: ACS_URL,
      now: () => clock,
      stateTtlMs: 600_000,
      protocol,
    })
    return { svc, protocol }
  }

  it('begin() builds an IdP redirect, stashes single-use RelayState, and passes ACS + SP entityID', () => {
    const { svc, protocol } = service(assertion({ nameId: 'n' }))
    const { redirectUrl, relayState } = svc.begin(providerId)
    const url = new URL(redirectUrl)
    expect(url.origin + url.pathname).toBe(SSO_URL)
    expect(url.searchParams.get('SAMLRequest')).toBeTruthy()
    expect(url.searchParams.get('RelayState')).toBe(relayState)
    expect(svc.pendingCount()).toBe(1)
    // The AuthnRequest carried the host ACS + the provider's SP entityID.
    expect(protocol.generateInputs[0]!.acsUrl).toBe(ACS_URL)
    expect(protocol.generateInputs[0]!.spEntityId).toBe(SP_ENTITY)
    expect(protocol.generateInputs[0]!.idpSsoUrl).toBe(SSO_URL)
  })

  it('begin() refuses a disabled or unknown provider', () => {
    const disabledId = store.addSamlProvider({
      idpEntityId: 'https://off.test/entity',
      ssoUrl: 'https://off.test/sso',
      idpCert: IDP_CERT,
      spEntityId: SP_ENTITY,
      enabled: false,
    }).id
    const { svc } = service(assertion({ nameId: 'n' }))
    expectCode(() => svc.begin(disabledId), 'saml_provider_disabled')
    expectCode(() => svc.begin('no-such-provider'), 'saml_provider_not_found')
  })

  it('completes for a PRE-LINKED user, pins InResponseTo, and mints a usable session', () => {
    const userId = store.createUser({ email: 'linked@test', displayName: 'L', role: 'member' }).id
    store.linkSaml({ userId, idpEntityId: IDP_ENTITY, nameId: 'name-1' })

    const { svc, protocol } = service(assertion({ nameId: 'name-1' }))
    const { relayState } = svc.begin(providerId)
    const { session, userId: resolved } = svc.complete({ relayState, samlResponse: 'BASE64RESP' })

    expect(resolved).toBe(userId)
    const back = store.getSessionByToken(session.token)
    expect(back?.user.id).toBe(userId)
    expect(session.token).toMatch(/^ses_/)
    expect(svc.pendingCount()).toBe(0) // RelayState consumed
    // The validate call pinned the cert / issuer / SP / ACS and the issued @ID.
    const vin = protocol.validateInputs[0]!
    expect(vin.idpCertPem).toBe(IDP_CERT)
    expect(vin.expectedIssuer).toBe(IDP_ENTITY)
    expect(vin.spEntityId).toBe(SP_ENTITY)
    expect(vin.acsUrl).toBe(ACS_URL)
    expect(vin.expectedInResponseTo).toBe('req-1') // the @ID begin() issued
  })

  it('JIT-links an unlinked identity to an existing user by the asserted email', () => {
    const userId = store.createUser({ email: 'jit@test', displayName: 'J', role: 'member' }).id
    expect(store.findUserBySaml({ idpEntityId: IDP_ENTITY, nameId: 'jit-name' })).toBeNull()

    const { svc } = service(assertion({ nameId: 'jit-name', email: 'jit@test' }))
    const { relayState } = svc.begin(providerId)
    const { userId: resolved } = svc.complete({ relayState, samlResponse: 'R' })

    expect(resolved).toBe(userId)
    // The link now exists, so a second login reuses it.
    expect(store.findUserBySaml({ idpEntityId: IDP_ENTITY, nameId: 'jit-name' })).toBe(userId)
  })

  it('refuses an unknown identity (asserted email matches no user, or no email)', () => {
    store.createUser({ email: 'someone@test', displayName: 'S', role: 'member' })
    // (a) asserted email matches no local user
    {
      const { svc } = service(assertion({ nameId: 'ext-1', email: 'stranger@test' }))
      const { relayState } = svc.begin(providerId)
      expectCode(() => svc.complete({ relayState, samlResponse: 'R' }), 'saml_no_account')
    }
    // (b) no email asserted at all → nothing to match on
    {
      const { svc } = service(assertion({ nameId: 'ext-2', email: null }))
      const { relayState } = svc.begin(providerId)
      expectCode(() => svc.complete({ relayState, samlResponse: 'R' }), 'saml_no_account')
    }
  })

  it('rejects an unknown or already-used RelayState (single-use)', () => {
    const userId = store.createUser({ email: 'l2@test', displayName: 'L', role: 'member' }).id
    store.linkSaml({ userId, idpEntityId: IDP_ENTITY, nameId: 'name-2' })

    const { svc } = service(assertion({ nameId: 'name-2' }))
    expectCode(() => svc.complete({ relayState: 'never-issued', samlResponse: 'R' }), 'saml_state_invalid')

    const { relayState } = svc.begin(providerId)
    svc.complete({ relayState, samlResponse: 'R' }) // consumes it
    expectCode(() => svc.complete({ relayState, samlResponse: 'R' }), 'saml_state_invalid')
  })

  it('rejects an expired RelayState', () => {
    const userId = store.createUser({ email: 'l3@test', displayName: 'L', role: 'member' }).id
    store.linkSaml({ userId, idpEntityId: IDP_ENTITY, nameId: 'name-3' })

    const { svc } = service(assertion({ nameId: 'name-3' }))
    const { relayState } = svc.begin(providerId)
    clock += 600_001 // advance past the 10-minute TTL
    expectCode(() => svc.complete({ relayState, samlResponse: 'R' }), 'saml_state_invalid')
  })

  it('surfaces a validation failure and still consumes the RelayState (no replay)', () => {
    const userId = store.createUser({ email: 'v@test', displayName: 'V', role: 'member' }).id
    store.linkSaml({ userId, idpEntityId: IDP_ENTITY, nameId: 'name-4' })

    const { svc } = service(assertion({ nameId: 'name-4' }), new SamlError('signature_invalid', 'bad sig'))
    const { relayState } = svc.begin(providerId)
    expectCode(() => svc.complete({ relayState, samlResponse: 'TAMPERED' }), 'signature_invalid')
    // The captured response can't be retried against the same RelayState.
    expect(svc.pendingCount()).toBe(0)
    expectCode(() => svc.complete({ relayState, samlResponse: 'TAMPERED' }), 'saml_state_invalid')
  })
})
