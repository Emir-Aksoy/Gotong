/**
 * Route B P1-M5d — host SAML login orchestration.
 *
 * The SAML twin of OidcLoginService. Drives a browser SP-initiated SSO
 * round-trip without the web layer knowing any SAML detail:
 *   begin(providerId)   → mint an AuthnRequest (HTTP-Redirect binding), stash
 *                         the in-flight request keyed by a random RelayState,
 *                         return the IdP redirect URL.
 *   complete(relayState,→ look up the stashed request (RelayState is SAML's CSRF
 *           samlResponse)  token), validate the signed SAMLResponse against the
 *                         PINNED IdP cert (signature → Issuer → Audience → time →
 *                         Recipient → InResponseTo, all in @aipehub/saml),
 *                         resolve a LOCAL user, and mint the SAME `ses_` session
 *                         every other auth path produces (decision D-3).
 *
 * The in-flight `relayState → {providerId, requestId}` map is in-memory with a
 * short TTL and single-use semantics — same rationale as OIDC: a login finishes
 * in seconds on one process, a restart just means retry, and we never want
 * resumable half-logins on disk. RelayState binds the ACS POST to the exact
 * AuthnRequest we issued, and we additionally pin `InResponseTo` to that
 * request's @ID (defeats response replay / injection of an unsolicited assertion).
 *
 * Account resolution is JIT-link-by-asserted-email, never auto-provision: a
 * pre-existing (idpEntityId, NameID) link wins; else, if the SIGNED assertion
 * carries an email matching an EXISTING local user, we link them. Unlike OIDC
 * there is no separate `email_verified` flag — a SAML assertion's email is
 * IdP-vouched by the signature itself, so a signed email IS the verification. An
 * unknown identity is refused (`saml_no_account`).
 */

import type { Session, User } from '@aipehub/identity'
import { randomUrlToken } from '@aipehub/identity'
import {
  SamlError,
  generateAuthnRequest as realGenerateAuthnRequest,
  decodeSamlPostResponse as realDecode,
  validateSamlResponse as realValidate,
  type AuthnRequestInput,
  type AuthnRequestResult,
  type SamlAssertionResult,
  type ValidateSamlResponseInput,
} from '@aipehub/saml'

/** The narrow identity facade this service needs (the real IdentityStore satisfies it). */
export interface SamlLoginIdentity {
  getSamlProvider(id: string): {
    id: string
    idpEntityId: string
    ssoUrl: string
    idpCert: string
    spEntityId: string
    enabled: boolean
  } | null
  findUserBySaml(opts: { idpEntityId: string; nameId: string }): string | null
  linkSaml(input: { userId: string; idpEntityId: string; nameId: string }): string
  getUserByEmail(email: string): User | null
  authenticateSaml(opts: { idpEntityId: string; nameId: string; ttlMs?: number }): Session
}

/**
 * The pure SAML protocol slice (the real `@aipehub/saml` functions satisfy it).
 * Injected so the orchestration can be unit-tested with a fake; defaults to the
 * real, signature-verifying implementation (whose XSW defenses are proven in the
 * saml package's own tests).
 */
export interface SamlProtocol {
  generateAuthnRequest(input: AuthnRequestInput): AuthnRequestResult
  decodeSamlPostResponse(field: string): string
  validateSamlResponse(input: ValidateSamlResponseInput): SamlAssertionResult
}

const REAL_PROTOCOL: SamlProtocol = {
  generateAuthnRequest: realGenerateAuthnRequest,
  decodeSamlPostResponse: realDecode,
  validateSamlResponse: realValidate,
}

interface PendingLogin {
  providerId: string
  idpEntityId: string
  /** The AuthnRequest @ID — pinned as the expected InResponseTo on the way back. */
  requestId: string
  createdAt: number
}

export interface SamlLoginServiceOptions {
  /**
   * Our Assertion Consumer Service URL (host-level: one SP, one ACS). Becomes
   * the AuthnRequest @AssertionConsumerServiceURL and the Recipient the response
   * must match. The host computes it once from its public base URL.
   */
  acsUrl: string
  /** How long a started login may sit before the ACS POST (default 10 min). */
  stateTtlMs?: number
  /** Injected clock (ms). Defaults to Date.now. */
  now?: () => number
  /** Clock-skew tolerance passed to validateSamlResponse (ms; default its own 5 min). */
  clockSkewMs?: number
  /**
   * JIT-link an unlinked identity to an existing user when the assertion carries
   * a matching email (default true). Never creates accounts either way.
   */
  autoLinkByEmail?: boolean
  /** Override the SAML protocol functions (tests inject a fake). */
  protocol?: SamlProtocol
}

export class SamlLoginService {
  private readonly pending = new Map<string, PendingLogin>()
  private readonly acsUrl: string
  private readonly stateTtlMs: number
  private readonly nowMs: () => number
  private readonly clockSkewMs: number | undefined
  private readonly autoLink: boolean
  private readonly saml: SamlProtocol

  constructor(
    private readonly identity: SamlLoginIdentity,
    opts: SamlLoginServiceOptions,
  ) {
    this.acsUrl = opts.acsUrl
    this.stateTtlMs = opts.stateTtlMs ?? 600_000
    this.nowMs = opts.now ?? (() => Date.now())
    this.clockSkewMs = opts.clockSkewMs
    this.autoLink = opts.autoLinkByEmail !== false
    this.saml = opts.protocol ?? REAL_PROTOCOL
  }

  /** Number of in-flight logins (for observability/tests). */
  pendingCount(): number {
    return this.pending.size
  }

  /**
   * Start a login: build the AuthnRequest, stash it under a fresh RelayState,
   * and return the IdP redirect URL. The caller 302s the browser there.
   */
  begin(providerId: string): { redirectUrl: string; relayState: string } {
    const provider = this.identity.getSamlProvider(providerId)
    if (!provider) {
      throw new SamlError('saml_provider_not_found', `no SAML provider ${providerId}`)
    }
    if (!provider.enabled) {
      throw new SamlError('saml_provider_disabled', `SAML provider ${providerId} is disabled`)
    }
    const relayState = randomUrlToken()
    const req = this.saml.generateAuthnRequest({
      idpSsoUrl: provider.ssoUrl,
      spEntityId: provider.spEntityId,
      acsUrl: this.acsUrl,
      relayState,
      now: this.nowMs(),
    })
    this.prune()
    this.pending.set(relayState, {
      providerId,
      idpEntityId: provider.idpEntityId,
      requestId: req.id,
      createdAt: this.nowMs(),
    })
    return { redirectUrl: req.redirectUrl, relayState }
  }

  /**
   * Complete a login from the ACS POST. Looks up `relayState` (unknown/expired →
   * `saml_state_invalid`; single-use), validates the signed response against the
   * pinned IdP cert, resolves a local user, and mints a session. Any SAML
   * failure throws a SamlError.
   */
  complete(input: { relayState: string; samlResponse: string; now?: number }): {
    session: Session
    userId: string
    assertion: SamlAssertionResult
  } {
    const pend = this.pending.get(input.relayState)
    // Single-use: consume the RelayState regardless of outcome so a replay of
    // the same (RelayState, SAMLResponse) can't re-run validation.
    if (pend) this.pending.delete(input.relayState)
    if (!pend) {
      throw new SamlError('saml_state_invalid', 'unknown or already-used RelayState')
    }
    if (this.nowMs() - pend.createdAt > this.stateTtlMs) {
      throw new SamlError('saml_state_invalid', 'login RelayState expired')
    }
    const provider = this.identity.getSamlProvider(pend.providerId)
    if (!provider) {
      throw new SamlError('saml_provider_not_found', `provider ${pend.providerId} vanished mid-login`)
    }

    const xml = this.saml.decodeSamlPostResponse(input.samlResponse)
    const assertion = this.saml.validateSamlResponse({
      xml,
      idpCertPem: provider.idpCert,
      expectedIssuer: provider.idpEntityId,
      spEntityId: provider.spEntityId,
      acsUrl: this.acsUrl,
      expectedInResponseTo: pend.requestId,
      now: input.now ?? this.nowMs(),
      ...(this.clockSkewMs !== undefined ? { clockSkewMs: this.clockSkewMs } : {}),
    })

    const userId = this.resolveLocalUser(provider.idpEntityId, assertion)
    const session = this.identity.authenticateSaml({
      idpEntityId: provider.idpEntityId,
      nameId: assertion.nameId,
    })
    return { session, userId, assertion }
  }

  /**
   * Map a verified (idpEntityId, NameID) to a LOCAL user id. Pre-existing link
   * wins; otherwise JIT-link by the assertion's (signed → IdP-vouched) email to
   * an existing user; otherwise refuse. Never creates a user.
   */
  private resolveLocalUser(idpEntityId: string, assertion: SamlAssertionResult): string {
    const linked = this.identity.findUserBySaml({ idpEntityId, nameId: assertion.nameId })
    if (linked) return linked

    if (this.autoLink && typeof assertion.email === 'string' && assertion.email.length > 0) {
      const user = this.identity.getUserByEmail(assertion.email)
      if (user) {
        // No existing link for this (idpEntityId, NameID) — just checked — so
        // this can only succeed (or throw saml_already_linked on a genuine race).
        this.identity.linkSaml({ userId: user.id, idpEntityId, nameId: assertion.nameId })
        return user.id
      }
    }
    throw new SamlError(
      'saml_no_account',
      'no local account is linked to this identity; ask an admin to create or link one',
    )
  }

  /** Drop expired pending logins so the map can't grow unbounded. */
  private prune(): void {
    const cutoff = this.nowMs() - this.stateTtlMs
    for (const [relayState, p] of this.pending) {
      if (p.createdAt < cutoff) this.pending.delete(relayState)
    }
  }
}
