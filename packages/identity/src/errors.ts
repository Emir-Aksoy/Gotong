/**
 * Error taxonomy for @aipehub/identity.
 *
 * Every failure throws an `IdentityError` whose `code` discriminates
 * the failure mode for callers that want to map to HTTP status / UI
 * messages without parsing strings. Codes are stable; messages are not.
 */

export type IdentityErrorCode =
  | 'duplicate_email'
  | 'duplicate_credential'
  | 'invalid_role'
  | 'invalid_email'
  | 'invalid_input'
  | 'user_not_found'
  | 'credential_not_found'
  | 'authentication_failed'
  // Route B P1-M3c — password verified but the user has an ACTIVE TOTP factor
  // and no (or no further) code was supplied. The caller should re-prompt for
  // the 6-digit code and retry. Distinct from authentication_failed so the web
  // layer can map it to a "challenge" response rather than a flat 401.
  | 'totp_required'
  // Route B P1-M4a — OIDC account linking.
  //   `oidc_not_linked`     authenticateOidc found no local user for this
  //                         (issuer, sub). The callback layer decides whether
  //                         to auto-provision or refuse (its provisioning
  //                         policy), so the store stays mechanism-only.
  //   `oidc_already_linked` linkOidc was asked to bind an (issuer, sub) that
  //                         already maps to a DIFFERENT local user — a real
  //                         conflict (two accounts can't claim one IdP
  //                         identity). Re-linking to the SAME user is an
  //                         idempotent no-op, not this error.
  | 'oidc_not_linked'
  | 'oidc_already_linked'
  // Route B P1-M5b — SAML account linking (twins of the OIDC codes).
  //   `saml_not_linked`     authenticateSaml found no local user for this
  //                         (idpEntityId, NameID). The ACS route decides
  //                         JIT-link-by-verified-email vs refuse.
  //   `saml_already_linked` linkSaml was asked to bind a (idpEntityId, NameID)
  //                         already mapped to a DIFFERENT local user.
  | 'saml_not_linked'
  | 'saml_already_linked'
  // Route B P1-M4d — OIDC provider (IdP) configuration store.
  //   `oidc_provider_exists`     addOidcProvider hit the UNIQUE(issuer) — one
  //                              IdP registration per issuer URL.
  //   `oidc_provider_not_found`  get/update/readSecret targeted an id with no row.
  | 'oidc_provider_exists'
  | 'oidc_provider_not_found'
  // Route B P1-M5c — SAML provider (IdP) configuration store (twins of OIDC).
  //   `saml_provider_exists`     addSamlProvider hit UNIQUE(idp_entity_id) — one
  //                              registration per IdP entityID.
  //   `saml_provider_not_found`  get/update/remove targeted an id with no row.
  | 'saml_provider_exists'
  | 'saml_provider_not_found'
  // Route B P1-M11a — outbound A2A agent registry.
  //   `a2a_agent_exists`     addA2aAgent reused an existing participant id (PK).
  //   `a2a_agent_not_found`  get/update/remove targeted an id with no row.
  | 'a2a_agent_exists'
  | 'a2a_agent_not_found'
  | 'session_expired'
  | 'session_not_found'
  | 'weak_password'
  /**
   * V4-AUDIT-03: setRole was called on the last remaining owner with a
   * non-owner target. Refused to prevent permanent lockout. Operator
   * must promote another user to owner first, then retry the demotion.
   */
  | 'last_owner'
  // Invitation flow (Phase 3 — user invitations).
  | 'invitation_not_found'
  | 'invitation_expired'
  | 'invitation_already_used'
  | 'invitation_revoked'
  /**
   * createInvitation refused because a pending (non-expired, non-revoked,
   * non-accepted) invite for this email already exists. The owner can
   * revoke the older invite first, then create a fresh one.
   */
  | 'invitation_pending_exists'
  /**
   * Phase 6 #9: createInvitation refused because the org-wide active-
   * pending invites count has reached `AIPE_MAX_PENDING_INVITES` (default
   * 1000). The hard cap guards against table-blowup from an owner /
   * script bug. Operator must revoke some pending invites (or wait for
   * expiry) before creating new ones.
   */
  | 'invitations_limit_exceeded'
  // Vault (Phase 5 A1 — encrypted application-layer secret storage).
  /**
   * Vault row not found (or already hard-deleted — soft-delete rows
   * stay queryable until you pass `activeOnly:false`, so this code
   * means "no row by that id at all").
   */
  | 'vault_entry_not_found'
  /**
   * Attempted to call a vault method but the IdentityStore was opened
   * without a `masterKey`. Vault APIs require the key to encrypt /
   * decrypt; without it they refuse rather than no-op or silently fail.
   */
  | 'vault_not_configured'
  /**
   * Decryption failed: format mismatch, unknown version prefix, AES-GCM
   * auth tag rejection, or wrong master key. Surface code is opaque on
   * purpose — distinguishing "tampered" from "wrong key" leaks
   * information to an attacker who can repeatedly poke the API.
   */
  | 'vault_decrypt_failed'
  // D1 (Phase 5) — Peer Registry.
  /** UNIQUE constraint violated on peers.peer_id during addPeer. */
  | 'peer_id_taken'
  /** No peers row by that internal id. */
  | 'peer_not_found'
  // E1 (Phase 5) — org soft quotas.
  /** No org_quotas row for the requested (metric, period) tuple. */
  | 'org_quota_not_found'
  // Phase 12 M1 — IM bindings.
  /**
   * `claimImBindingCode` was called with a code that no row matches.
   * Common causes: the code was already redeemed (single-shot), the
   * user mistyped, or it was expired/swept long enough ago that the
   * row is gone. UX: ask the user to reissue from the admin UI.
   */
  | 'im_binding_code_invalid'
  /**
   * `claimImBindingCode` matched a row but `expires_at < now`. The
   * row IS deleted on this path so the user can immediately request
   * a fresh code. Distinct from `_invalid` so the IM bot can render
   * a friendlier "this code expired; ask for a new one" message.
   */
  | 'im_binding_code_expired'

export interface IdentityErrorOptions {
  code: IdentityErrorCode
  message: string
  cause?: unknown
}

export class IdentityError extends Error {
  readonly code: IdentityErrorCode

  constructor(opts: IdentityErrorOptions) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'IdentityError'
    this.code = opts.code
  }
}
