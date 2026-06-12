/**
 * Route B P1-M5a — SAML 2.0 SP protocol core.
 *
 * The dangerous parts — XML canonicalization and signature math — are delegated
 * to the vetted `xml-crypto` library (per the chosen approach). What lives HERE
 * is the SP protocol GLUE that xml-crypto does NOT do and that is just as
 * security-critical to get right:
 *
 *   1. AuthnRequest generation (HTTP-Redirect binding: deflate + base64).
 *   2. SAMLResponse / Assertion parsing + condition validation.
 *   3. The signature-wrapping (XSW) defenses around xml-crypto:
 *        - the verification key is PINNED to the configured IdP cert, never
 *          taken from the document's own KeyInfo (cert-substitution defense);
 *        - claims are extracted ONLY from `getSignedReferences()` — the exact
 *          bytes the signature covered — never from the raw document, so a
 *          forged assertion smuggled in as a sibling is never read;
 *        - the signed assertion's @ID must be unique in the document (the
 *          classic duplicated-ID XSW confusion is rejected);
 *        - DOCTYPE is forbidden outright (XXE / entity-expansion guard).
 *
 * Everything is a pure function with `now` injected, so the full validation
 * path is exhaustively testable with a self-signed key and hand-signed
 * fixtures (no network, no IdP). RS256/RSA-SHA256 + exclusive-c14n is the
 * mainstream IdP default; xml-crypto enforces the signature method.
 */

import { randomBytes } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { DOMParser } from '@xmldom/xmldom'
import * as xpath from 'xpath'
import { SignedXml } from 'xml-crypto'

import {
  SamlError,
  type AuthnRequestInput,
  type AuthnRequestResult,
  type SamlAssertionResult,
  type SpMetadataInput,
  type ValidateSamlResponseInput,
} from './types.js'

const NS_SAMLP = 'urn:oasis:names:tc:SAML:2.0:protocol'
const NS_SAML = 'urn:oasis:names:tc:SAML:2.0:assertion'
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#'
const NS_MD = 'urn:oasis:names:tc:SAML:2.0:metadata'

const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success'
const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress'
const NAMEID_UNSPECIFIED = 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'

/** Common email Attribute @Name values across IdPs (matched case-insensitively for the short ones). */
const EMAIL_ATTR_NAMES = new Set([
  'urn:oid:1.2.840.113549.1.9.1', // RFC 2985 emailAddress (LDAP / Shibboleth)
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', // ADFS / Azure AD
  'email',
  'mail',
  'emailaddress',
  'e-mail',
])

// XML node handling crosses three libraries (xmldom DOM, xpath, xml-crypto)
// whose `Node` types don't align and aren't available without the DOM lib, so
// node values are kept loosely typed at this boundary (same posture oidc.ts
// uses when casting at the node:crypto boundary). The logic, not the types, is
// what the test suite pins.
type XmlNode = any // eslint-disable-line @typescript-eslint/no-explicit-any

function requireStr(v: unknown, name: string): asserts v is string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new SamlError('invalid_input', `${name} must be a non-empty string`)
  }
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Parse XML with DTDs forbidden (XXE guard) and require a document element. */
function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE/iu.test(xml)) {
    throw new SamlError('doctype_forbidden', 'SAML XML must not contain a DOCTYPE (XXE / entity-expansion guard)')
  }
  const parser = new DOMParser({
    // xmldom flags many benign things as "error"; the real defenses are the
    // signature check + XSW guards below, not parser strictness. We only swallow
    // the noise here and rely on documentElement presence as the parse gate.
    errorHandler: { warning() {}, error() {}, fatalError() {} },
  })
  let doc: XmlNode
  try {
    doc = parser.parseFromString(xml, 'text/xml')
  } catch {
    throw new SamlError('malformed_response', 'XML could not be parsed')
  }
  if (!doc || !doc.documentElement) {
    throw new SamlError('malformed_response', 'XML has no document element')
  }
  return doc
}

function selectNodes(expr: string, ctx: XmlNode): XmlNode[] {
  const r = xpath.select(expr, ctx as never) as unknown
  if (Array.isArray(r)) return r as XmlNode[]
  return r ? [r as XmlNode] : []
}

function selectNode(expr: string, ctx: XmlNode): XmlNode | null {
  const r = selectNodes(expr, ctx)
  return r.length > 0 ? r[0]! : null
}

/** First child element with the given local name + namespace. */
function childByLocal(parent: XmlNode, localName: string, ns: string): XmlNode | null {
  return selectNode(`*[local-name()='${localName}' and namespace-uri()='${ns}']`, parent)
}

/** Every descendant element (incl. the context element when ctx is a document) with the given local name + namespace. */
function descByLocal(ctx: XmlNode, localName: string, ns: string): XmlNode[] {
  return selectNodes(`.//*[local-name()='${localName}' and namespace-uri()='${ns}']`, ctx)
}

function attr(node: XmlNode, name: string): string | null {
  if (!node || typeof node.getAttribute !== 'function') return null
  const v = node.getAttribute(name)
  return v === null || v === '' ? null : v
}

function text(node: XmlNode): string {
  if (!node) return ''
  return String(node.textContent ?? '').trim()
}

/** SAML xsd:ID is an NCName; reject anything else before it ever reaches an XPath string. */
function isXmlId(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9._-]*$/u.test(s)
}

/** ISO-8601 instant → unix ms, or null when unparseable. */
function parseInstant(s: string): number | null {
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

function looksLikeEmail(s: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(s)
}

function deriveEmail(
  nameId: string,
  nameIdFormat: string | undefined,
  attributes: Record<string, string[]>,
): string | null {
  if (nameIdFormat === NAMEID_EMAIL && looksLikeEmail(nameId)) {
    return nameId.toLowerCase()
  }
  for (const [k, vals] of Object.entries(attributes)) {
    if (EMAIL_ATTR_NAMES.has(k) || EMAIL_ATTR_NAMES.has(k.toLowerCase())) {
      const v = vals.find(looksLikeEmail)
      if (v) return v.toLowerCase()
    }
  }
  // Last resort: a bare NameID that is itself an email (common with unspecified format).
  if (looksLikeEmail(nameId)) return nameId.toLowerCase()
  return null
}

/**
 * Build an SP-initiated AuthnRequest and the HTTP-Redirect URL to send the
 * browser to. The @ID is returned so the caller can stash it (keyed by
 * relayState) and later require the SAMLResponse's InResponseTo to match it —
 * that binding is what stops a stray/replayed assertion from logging someone in.
 */
export function generateAuthnRequest(input: AuthnRequestInput): AuthnRequestResult {
  requireStr(input?.idpSsoUrl, 'idpSsoUrl')
  requireStr(input?.spEntityId, 'spEntityId')
  requireStr(input?.acsUrl, 'acsUrl')
  const now = typeof input.now === 'number' ? input.now : Date.now()
  const id = `_${randomBytes(16).toString('hex')}`
  const issueInstant = new Date(now).toISOString()
  const nameIdFormat = input.nameIdFormat || NAMEID_UNSPECIFIED
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${NS_SAMLP}" xmlns:saml="${NS_SAML}"` +
    ` ID="${id}" Version="2.0" IssueInstant="${issueInstant}"` +
    ` Destination="${xmlEscape(input.idpSsoUrl)}"` +
    ` AssertionConsumerServiceURL="${xmlEscape(input.acsUrl)}" ProtocolBinding="${BINDING_POST}">` +
    `<saml:Issuer>${xmlEscape(input.spEntityId)}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="${xmlEscape(nameIdFormat)}" AllowCreate="true"/>` +
    `</samlp:AuthnRequest>`

  // HTTP-Redirect binding: raw DEFLATE (no zlib header) → base64 → URL query param.
  const encoded = deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64')
  const url = new URL(input.idpSsoUrl)
  url.searchParams.set('SAMLRequest', encoded)
  if (input.relayState) url.searchParams.set('RelayState', input.relayState)
  return { id, redirectUrl: url.toString(), xml }
}

/**
 * Decode the base64 SAMLResponse delivered on the HTTP-POST binding (the ACS
 * form field). POST binding is base64 only — NO inflate (that is the redirect
 * binding). Returns the raw XML for validateSamlResponse.
 */
export function decodeSamlPostResponse(samlResponseB64: string): string {
  requireStr(samlResponseB64, 'SAMLResponse')
  // Node's base64 decoder is lenient for string input and never throws —
  // garbage just decodes to garbage bytes. The look-like-SAML check below
  // (and the full signature validation after it) is the real gate.
  const xml = Buffer.from(samlResponseB64, 'base64').toString('utf8')
  if (!xml.includes('Response')) {
    throw new SamlError('malformed_response', 'decoded SAMLResponse does not look like SAML XML')
  }
  return xml
}

/**
 * Validate a SAMLResponse end to end and return the authenticated assertion
 * facts. Throws SamlError on ANY failure — there is no partial trust. The order
 * is signature FIRST (so claims are only ever read from validated bytes), then
 * Issuer / Audience / time-window / Recipient / InResponseTo.
 */
export function validateSamlResponse(input: ValidateSamlResponseInput): SamlAssertionResult {
  requireStr(input?.xml, 'xml')
  requireStr(input?.idpCertPem, 'idpCertPem')
  requireStr(input?.expectedIssuer, 'expectedIssuer')
  requireStr(input?.spEntityId, 'spEntityId')
  requireStr(input?.acsUrl, 'acsUrl')
  if (typeof input.now !== 'number') {
    throw new SamlError('invalid_input', 'now must be a number (unix ms)')
  }
  const skew = typeof input.clockSkewMs === 'number' ? input.clockSkewMs : 5 * 60 * 1000

  const doc = parseXml(input.xml)

  const response = selectNode(`/*[local-name()='Response' and namespace-uri()='${NS_SAMLP}']`, doc)
  if (!response) {
    throw new SamlError('malformed_response', 'no samlp:Response root element')
  }

  // Top-level status must be Success before anything else is trusted.
  const statusCode = selectNode(`.//*[local-name()='StatusCode' and namespace-uri()='${NS_SAMLP}']`, response)
  const statusValue = statusCode ? attr(statusCode, 'Value') : null
  if (statusValue !== STATUS_SUCCESS) {
    throw new SamlError('status_not_success', `SAML status is not Success: ${statusValue ?? 'missing'}`)
  }

  // Response-level InResponseTo (when we initiated the flow).
  if (input.expectedInResponseTo) {
    const rIrt = attr(response, 'InResponseTo')
    if (rIrt && rIrt !== input.expectedInResponseTo) {
      throw new SamlError('bad_in_response_to', 'Response InResponseTo does not match the AuthnRequest id')
    }
  }

  // ---- Signature validation (key PINNED to the configured cert) ----
  const signedContents: string[] = []
  for (const sigNode of descByLocal(doc, 'Signature', NS_DS)) {
    const sig = new SignedXml({
      publicCert: input.idpCertPem,
      // Never derive the verification key from the document's own KeyInfo — an
      // attacker who self-signs with a cert they embed there would otherwise
      // "validate". noop → key selection falls through to publicCert (pinned).
      getCertFromKeyInfo: () => null,
    })
    try {
      sig.loadSignature(sigNode)
      if (sig.checkSignature(input.xml)) {
        for (const ref of sig.getSignedReferences()) signedContents.push(ref)
      }
    } catch {
      // Not a valid signature for our pinned cert — simply not counted. We
      // require at least one valid signature covering the assertion below.
    }
  }
  if (signedContents.length === 0) {
    throw new SamlError(
      'no_valid_signature',
      'no valid XML signature found (assertion is unsigned or signature does not verify against the IdP cert)',
    )
  }

  // Read the assertion ONLY from validated signed bytes (XSW defense): even if
  // the document also carries a forged assertion as a sibling, it is never read.
  let assertionNode: XmlNode | null = null
  for (const content of signedContents) {
    let signedDoc: XmlNode
    try {
      signedDoc = parseXml(content)
    } catch {
      continue
    }
    const found = descByLocal(signedDoc, 'Assertion', NS_SAML)
    if (found.length > 0) {
      assertionNode = found[0]!
      break
    }
  }
  if (!assertionNode) {
    throw new SamlError('assertion_not_signed', 'the validated signature does not cover a SAML Assertion')
  }

  const assertionId = attr(assertionNode, 'ID') ?? ''
  // Defense-in-depth: a duplicated assertion ID is a classic XSW confusion;
  // require the signed assertion's ID to be unique in the original document.
  if (assertionId) {
    if (!isXmlId(assertionId)) {
      throw new SamlError('malformed_response', 'assertion ID is not a valid XML id')
    }
    const dupes = selectNodes(`.//*[@ID='${assertionId}']`, doc)
    if (dupes.length > 1) {
      throw new SamlError('ambiguous_assertion_id', 'assertion ID is not unique in the document (possible signature-wrapping)')
    }
  }

  // ---- Issuer ----
  const issuerNode = childByLocal(assertionNode, 'Issuer', NS_SAML)
  const issuer = issuerNode ? text(issuerNode) : ''
  if (issuer !== input.expectedIssuer) {
    throw new SamlError('bad_issuer', 'assertion Issuer does not match the configured IdP entityID')
  }

  // ---- Subject / NameID ----
  const subject = childByLocal(assertionNode, 'Subject', NS_SAML)
  const nameIdNode = subject ? childByLocal(subject, 'NameID', NS_SAML) : null
  const nameId = nameIdNode ? text(nameIdNode) : ''
  if (!nameId) {
    throw new SamlError('no_name_id', 'assertion has no Subject NameID')
  }
  const nameIdFormat = nameIdNode ? attr(nameIdNode, 'Format') ?? undefined : undefined

  // ---- SubjectConfirmationData: Recipient / NotOnOrAfter / InResponseTo ----
  const scData = subject
    ? selectNode(`.//*[local-name()='SubjectConfirmationData' and namespace-uri()='${NS_SAML}']`, subject)
    : null
  if (scData) {
    const recipient = attr(scData, 'Recipient')
    if (recipient && recipient !== input.acsUrl) {
      throw new SamlError('bad_recipient', 'SubjectConfirmationData Recipient does not match the ACS URL')
    }
    const scNotOnOrAfter = attr(scData, 'NotOnOrAfter')
    if (scNotOnOrAfter) {
      const t = parseInstant(scNotOnOrAfter)
      if (t !== null && input.now - skew >= t) {
        throw new SamlError('assertion_expired', 'SubjectConfirmationData NotOnOrAfter has passed')
      }
    }
    const scIrt = attr(scData, 'InResponseTo')
    if (input.expectedInResponseTo && scIrt && scIrt !== input.expectedInResponseTo) {
      throw new SamlError('bad_in_response_to', 'SubjectConfirmationData InResponseTo does not match the AuthnRequest id')
    }
  }

  // ---- Conditions: time window + AudienceRestriction ----
  const conditions = childByLocal(assertionNode, 'Conditions', NS_SAML)
  if (conditions) {
    const nb = attr(conditions, 'NotBefore')
    if (nb) {
      const t = parseInstant(nb)
      if (t !== null && input.now + skew < t) {
        throw new SamlError('assertion_not_yet_valid', 'Conditions NotBefore is in the future')
      }
    }
    const noa = attr(conditions, 'NotOnOrAfter')
    if (noa) {
      const t = parseInstant(noa)
      if (t !== null && input.now - skew >= t) {
        throw new SamlError('assertion_expired', 'Conditions NotOnOrAfter has passed')
      }
    }
    const audiences = descByLocal(conditions, 'Audience', NS_SAML).map((n) => text(n))
    if (audiences.length > 0 && !audiences.includes(input.spEntityId)) {
      throw new SamlError('bad_audience', 'assertion AudienceRestriction does not include our SP entityID')
    }
  }

  // ---- AttributeStatement ----
  const attributes: Record<string, string[]> = {}
  for (const attrNode of descByLocal(assertionNode, 'Attribute', NS_SAML)) {
    const name = attr(attrNode, 'Name') ?? attr(attrNode, 'FriendlyName')
    if (!name) continue
    const values = descByLocal(attrNode, 'AttributeValue', NS_SAML)
      .map((n) => text(n))
      .filter((v) => v.length > 0)
    if (values.length > 0) attributes[name] = values
  }

  const authnStatement = childByLocal(assertionNode, 'AuthnStatement', NS_SAML)
  const sessionIndex = authnStatement ? attr(authnStatement, 'SessionIndex') ?? undefined : undefined

  const email = deriveEmail(nameId, nameIdFormat, attributes)

  return { nameId, nameIdFormat, sessionIndex, issuer, attributes, email, assertionId }
}

/**
 * SP metadata XML for an admin to hand to the IdP. Declares
 * WantAssertionsSigned=true (we enforce it) and AuthnRequestsSigned=false (we
 * do not sign requests in this MVP — many IdPs accept unsigned AuthnRequests).
 */
export function buildSpMetadata(input: SpMetadataInput): string {
  requireStr(input?.spEntityId, 'spEntityId')
  requireStr(input?.acsUrl, 'acsUrl')
  return (
    `<?xml version="1.0"?>` +
    `<md:EntityDescriptor xmlns:md="${NS_MD}" entityID="${xmlEscape(input.spEntityId)}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"` +
    ` protocolSupportEnumeration="${NS_SAMLP}">` +
    `<md:NameIDFormat>${NAMEID_EMAIL}</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="${BINDING_POST}"` +
    ` Location="${xmlEscape(input.acsUrl)}" index="0" isDefault="true"/>` +
    `</md:SPSSODescriptor>` +
    `</md:EntityDescriptor>`
  )
}
