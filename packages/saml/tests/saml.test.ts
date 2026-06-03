/**
 * Route B P1-M5a — SAML protocol core tests.
 *
 * Fixtures are signed at RUNTIME with a freshly generated RSA key (via the same
 * xml-crypto signing API a real IdP uses) — no opaque blobs checked in. The
 * attack fixtures (XSW sibling injection, ID duplication, tamper, wrong key,
 * unsigned, DOCTYPE) are the load-bearing part: they prove the signature and
 * signature-wrapping defenses actually reject forgeries, not just that the happy
 * path parses.
 *
 * The IdP "cert" here is a bare RSA public-key PEM. xml-crypto accepts any
 * crypto.KeyLike for `publicCert`, and a production X.509 cert PEM flows through
 * the identical code path (node extracts the SPKI) — so this is a faithful test
 * of OUR logic; the cert→key extraction is node's concern.
 */

import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SignedXml } from 'xml-crypto'

import {
  SamlError,
  buildSpMetadata,
  decodeSamlPostResponse,
  generateAuthnRequest,
  validateSamlResponse,
} from '../src/index.js'

// ---- key material (one IdP key, one attacker key) ----
function rsaPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { privateKey: privateKey as string, cert: publicKey as string }
}
const IDP = rsaPair()
const ATTACKER = rsaPair()

const SP_ENTITY_ID = 'https://hub.example.com/saml/metadata'
const ACS_URL = 'https://hub.example.com/api/auth/saml/acs'
const IDP_ISSUER = 'https://idp.example.com/entity'
const NOW = Date.parse('2026-06-02T12:00:00Z')
const REQ_ID = '_req0123456789abcdef'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

interface ResponseOpts {
  assertionId?: string
  responseId?: string
  issuer?: string
  nameId?: string
  nameIdFormat?: string
  audience?: string
  recipient?: string
  inResponseTo?: string | null
  notBefore?: number
  notOnOrAfter?: number
  scNotOnOrAfter?: number
  status?: string
  emailAttr?: { name: string; value: string } | null
}

/** Build an UNSIGNED samlp:Response with an embedded assertion. */
function buildResponse(o: ResponseOpts = {}): string {
  const assertionId = o.assertionId ?? '_assert000111222'
  const responseId = o.responseId ?? '_resp000111222'
  const issuer = o.issuer ?? IDP_ISSUER
  const nameId = o.nameId ?? 'alice@example.com'
  const nameIdFormat = o.nameIdFormat ?? 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
  const audience = o.audience ?? SP_ENTITY_ID
  const recipient = o.recipient ?? ACS_URL
  const irt = o.inResponseTo === null ? '' : ` InResponseTo="${o.inResponseTo ?? REQ_ID}"`
  const nb = iso(o.notBefore ?? NOW - 5 * 60_000)
  const noa = iso(o.notOnOrAfter ?? NOW + 5 * 60_000)
  const scNoa = iso(o.scNotOnOrAfter ?? NOW + 5 * 60_000)
  const status = o.status ?? 'urn:oasis:names:tc:SAML:2.0:status:Success'
  const emailAttr =
    o.emailAttr === null
      ? ''
      : `<saml:AttributeStatement><saml:Attribute Name="${(o.emailAttr ?? { name: 'email', value: nameId }).name}">` +
        `<saml:AttributeValue>${(o.emailAttr ?? { name: 'email', value: nameId }).value}</saml:AttributeValue>` +
        `</saml:Attribute></saml:AttributeStatement>`

  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
    ` ID="${responseId}" Version="2.0" IssueInstant="${iso(NOW)}" Destination="${ACS_URL}"${irt}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(NOW)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${nameIdFormat}">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${scNoa}" Recipient="${recipient}"${irt}/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}">` +
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(NOW)}" SessionIndex="_sess123">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    emailAttr +
    `</saml:Assertion>` +
    `</samlp:Response>`
  )
}

/** Sign one element (by local-name) of the response, enveloped + exc-c14n + RSA-SHA256. */
function signElement(xml: string, localName: string, privateKey: string): string {
  const sig = new SignedXml({ privateKey })
  sig.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256'
  sig.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#'
  sig.addReference({
    xpath: `//*[local-name(.)='${localName}']`,
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  })
  sig.computeSignature(xml, {
    location: { reference: `//*[local-name(.)='${localName}']`, action: 'append' },
  })
  return sig.getSignedXml()
}

function signedAssertionResponse(o: ResponseOpts = {}, key = IDP.privateKey): string {
  return signElement(buildResponse(o), 'Assertion', key)
}

function validate(xml: string, over: Partial<Parameters<typeof validateSamlResponse>[0]> = {}) {
  return validateSamlResponse({
    xml,
    idpCertPem: IDP.cert,
    expectedIssuer: IDP_ISSUER,
    spEntityId: SP_ENTITY_ID,
    acsUrl: ACS_URL,
    expectedInResponseTo: REQ_ID,
    now: NOW,
    ...over,
  })
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(SamlError)
    expect((e as SamlError).code).toBe(code)
    return
  }
  throw new Error(`expected SamlError(${code}) but no error was thrown`)
}

// =====================================================================
describe('generateAuthnRequest', () => {
  it('produces a deflate+base64 SAMLRequest that inflates to XML carrying the returned ID', async () => {
    const { inflateRawSync } = await import('node:zlib')
    const r = generateAuthnRequest({
      idpSsoUrl: 'https://idp.example.com/sso',
      spEntityId: SP_ENTITY_ID,
      acsUrl: ACS_URL,
      relayState: 'state-abc',
      now: NOW,
    })
    expect(r.id).toMatch(/^_[0-9a-f]{32}$/)
    const u = new URL(r.redirectUrl)
    expect(u.origin + u.pathname).toBe('https://idp.example.com/sso')
    expect(u.searchParams.get('RelayState')).toBe('state-abc')
    const inflated = inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8')
    expect(inflated).toContain(`ID="${r.id}"`)
    expect(inflated).toContain(`AssertionConsumerServiceURL="${ACS_URL}"`)
    expect(inflated).toContain(SP_ENTITY_ID)
  })

  it('rejects missing inputs', () => {
    expectCode(() => generateAuthnRequest({ idpSsoUrl: '', spEntityId: SP_ENTITY_ID, acsUrl: ACS_URL }), 'invalid_input')
  })
})

describe('decodeSamlPostResponse', () => {
  it('base64-decodes the POST field (no inflate)', () => {
    const xml = '<samlp:Response>x</samlp:Response>'
    expect(decodeSamlPostResponse(Buffer.from(xml, 'utf8').toString('base64'))).toBe(xml)
  })
  it('rejects empty / non-XML', () => {
    expectCode(() => decodeSamlPostResponse(''), 'invalid_input')
    expectCode(() => decodeSamlPostResponse(Buffer.from('not xml', 'utf8').toString('base64')), 'malformed_response')
  })
})

describe('validateSamlResponse — happy paths', () => {
  it('accepts a validly signed assertion and extracts subject + attributes', () => {
    const r = validate(signedAssertionResponse())
    expect(r.nameId).toBe('alice@example.com')
    expect(r.issuer).toBe(IDP_ISSUER)
    expect(r.email).toBe('alice@example.com')
    expect(r.sessionIndex).toBe('_sess123')
    expect(r.assertionId).toBe('_assert000111222')
    expect(r.attributes['email']).toEqual(['alice@example.com'])
  })

  it('accepts a signed RESPONSE wrapping the assertion (response-level signature)', () => {
    const r = validate(signElement(buildResponse(), 'Response', IDP.privateKey))
    expect(r.nameId).toBe('alice@example.com')
  })

  it('derives email from a non-email NameID via the email attribute', () => {
    const xml = signedAssertionResponse({
      nameId: 'CN=Alice,OU=People',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
      emailAttr: { name: 'urn:oid:1.2.840.113549.1.9.1', value: 'alice@corp.example' },
    })
    const r = validate(xml)
    expect(r.nameId).toBe('CN=Alice,OU=People')
    expect(r.email).toBe('alice@corp.example')
  })

  it('tolerates clock skew within the window', () => {
    // now is 4 min past the assertion NotOnOrAfter, but within the 5-min default skew.
    const r = validate(signedAssertionResponse(), { now: NOW + 5 * 60_000 + 4 * 60_000 - 1 })
    expect(r.nameId).toBe('alice@example.com')
  })
})

describe('validateSamlResponse — signature defenses', () => {
  it('rejects an unsigned response', () => {
    expectCode(() => validate(buildResponse()), 'no_valid_signature')
  })

  it('rejects a response signed by the WRONG key (cert pinned to the IdP)', () => {
    expectCode(() => validate(signedAssertionResponse({}, ATTACKER.privateKey)), 'no_valid_signature')
  })

  it('rejects a tampered assertion (digest mismatch after signing)', () => {
    const signed = signedAssertionResponse()
    const tampered = signed.replace('alice@example.com', 'mallory@evil.example')
    expectCode(() => validate(tampered), 'no_valid_signature')
  })

  it('XSW sibling injection: a forged unsigned assertion is never read', () => {
    const signed = signedAssertionResponse()
    // Splice a forged assertion (attacker NameID) as a sibling, right after the Status.
    const forged =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evilassert" Version="2.0" IssueInstant="${iso(NOW)}">` +
      `<saml:Issuer>${IDP_ISSUER}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">mallory@evil.example</saml:NameID></saml:Subject>` +
      `</saml:Assertion>`
    const wrapped = signed.replace('</samlp:Status>', `</samlp:Status>${forged}`)
    const r = validate(wrapped)
    // Either it still reads the genuinely-signed assertion, never the forgery...
    expect(r.nameId).toBe('alice@example.com')
    expect(r.nameId).not.toBe('mallory@evil.example')
  })

  it('XSW duplicate-ID wrapping is rejected (ambiguous or unsigned)', () => {
    const signed = signedAssertionResponse()
    // Forge an assertion that REUSES the signed assertion's ID to confuse reference resolution.
    const forged =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assert000111222" Version="2.0" IssueInstant="${iso(NOW)}">` +
      `<saml:Issuer>${IDP_ISSUER}</saml:Issuer>` +
      `<saml:Subject><saml:NameID>mallory@evil.example</saml:NameID></saml:Subject>` +
      `</saml:Assertion>`
    const wrapped = signed.replace('</samlp:Status>', `</samlp:Status>${forged}`)
    // The duplicated ID must NOT yield a session as mallory — it is rejected
    // (ambiguous id) or the signature fails. Whatever the path, never mallory.
    try {
      const r = validate(wrapped)
      expect(r.nameId).toBe('alice@example.com')
    } catch (e) {
      expect(e).toBeInstanceOf(SamlError)
    }
  })

  it('rejects a DOCTYPE (XXE guard)', () => {
    const signed = signedAssertionResponse()
    const withDoctype = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "y">]>${signed.replace(/^<\?xml[^>]*\?>/, '')}`
    expectCode(() => validate(withDoctype), 'doctype_forbidden')
  })
})

describe('validateSamlResponse — condition checks', () => {
  it('rejects a non-Success status', () => {
    expectCode(
      () => validate(signedAssertionResponse({ status: 'urn:oasis:names:tc:SAML:2.0:status:Requester' })),
      'status_not_success',
    )
  })

  it('rejects a bad audience', () => {
    expectCode(() => validate(signedAssertionResponse({ audience: 'https://other.example/sp' })), 'bad_audience')
  })

  it('rejects a bad recipient', () => {
    expectCode(
      () => validate(signedAssertionResponse({ recipient: 'https://evil.example/acs' })),
      'bad_recipient',
    )
  })

  it('rejects a bad issuer', () => {
    expectCode(() => validate(signedAssertionResponse({ issuer: 'https://evil-idp.example' })), 'bad_issuer')
  })

  it('rejects a mismatched InResponseTo', () => {
    expectCode(() => validate(signedAssertionResponse({ inResponseTo: '_someoneElsesRequest' })), 'bad_in_response_to')
  })

  it('rejects an expired assertion (past NotOnOrAfter beyond skew)', () => {
    expectCode(() => validate(signedAssertionResponse(), { now: NOW + 60 * 60_000 }), 'assertion_expired')
  })

  it('rejects a not-yet-valid assertion (before NotBefore beyond skew)', () => {
    expectCode(() => validate(signedAssertionResponse(), { now: NOW - 60 * 60_000 }), 'assertion_not_yet_valid')
  })
})

describe('buildSpMetadata', () => {
  it('emits SP metadata with the ACS location + WantAssertionsSigned', () => {
    const md = buildSpMetadata({ spEntityId: SP_ENTITY_ID, acsUrl: ACS_URL })
    expect(md).toContain(`entityID="${SP_ENTITY_ID}"`)
    expect(md).toContain(`Location="${ACS_URL}"`)
    expect(md).toContain('WantAssertionsSigned="true"')
  })
})
