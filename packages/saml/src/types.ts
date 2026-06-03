/**
 * Route B P1-M5a — SAML 2.0 SP wire types.
 *
 * Deliberately small: the SP only needs SP-initiated SSO with the
 * HTTP-Redirect binding for the AuthnRequest (SP→IdP) and the HTTP-POST
 * binding for the SAMLResponse (IdP→SP). Artifact binding, SLO, and
 * SP-signed requests are explicit non-goals for this MVP.
 */

/** Typed failure with a stable `code` (mapped to HTTP / audit upstream). */
export class SamlError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SamlError'
    this.code = code
  }
}

export interface AuthnRequestInput {
  /** IdP SSO endpoint (HTTP-Redirect binding) — becomes @Destination + the redirect host. */
  idpSsoUrl: string
  /** Our SP entityID — becomes the <saml:Issuer>. */
  spEntityId: string
  /** Our Assertion Consumer Service URL — becomes @AssertionConsumerServiceURL. */
  acsUrl: string
  /** Opaque value echoed back by the IdP on the ACS POST; we use it to find the stashed request. */
  relayState?: string
  /** Requested NameID format; defaults to the unspecified format (let the IdP decide). */
  nameIdFormat?: string
  /** unix ms; injected so the IssueInstant is deterministic in tests. Defaults to now. */
  now?: number
}

export interface AuthnRequestResult {
  /** The AuthnRequest @ID — stash this server-side keyed by relayState to verify InResponseTo. */
  id: string
  /** Full IdP redirect URL with ?SAMLRequest=<deflate+base64+urlencode>&RelayState=. */
  redirectUrl: string
  /** Raw AuthnRequest XML (kept for debugging / a future POST binding). */
  xml: string
}

export interface ValidateSamlResponseInput {
  /** The decoded (base64 → utf8) SAMLResponse XML. Use decodeSamlPostResponse first. */
  xml: string
  /** The configured IdP signing certificate (X.509 PEM) — the signature is PINNED to this, never to a cert in the document's KeyInfo. */
  idpCertPem: string
  /** Configured IdP entityID — the assertion Issuer must equal this. */
  expectedIssuer: string
  /** Our SP entityID — must appear in the assertion's AudienceRestriction. */
  spEntityId: string
  /** Our ACS URL — the SubjectConfirmationData Recipient must equal this (when present). */
  acsUrl: string
  /** The AuthnRequest ID we sent; both the Response @InResponseTo and the SubjectConfirmationData @InResponseTo must equal it. Omit only for IdP-initiated SSO (not used here). */
  expectedInResponseTo?: string
  /** unix ms; injected so time validation is pure. */
  now: number
  /** Clock-skew tolerance in ms (default 5 min). */
  clockSkewMs?: number
}

export interface SamlAssertionResult {
  /** The Subject NameID text. */
  nameId: string
  /** The Subject NameID @Format (urn). */
  nameIdFormat?: string
  /** AuthnStatement @SessionIndex, if present (used for SLO later). */
  sessionIndex?: string
  /** The assertion Issuer (== expectedIssuer, re-surfaced for the link key). */
  issuer: string
  /** AttributeStatement attributes: name → values (FriendlyName falls back to Name). */
  attributes: Record<string, string[]>
  /** Best-effort email: NameID when Format is emailAddress, else a common email attribute. null if none found. */
  email: string | null
  /** The validated assertion @ID. */
  assertionId: string
}

export interface SpMetadataInput {
  spEntityId: string
  acsUrl: string
}
