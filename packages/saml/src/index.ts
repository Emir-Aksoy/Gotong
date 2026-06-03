/**
 * @aipehub/saml — SAML 2.0 SP protocol core.
 *
 * Pure functions for SP-initiated SSO: AuthnRequest generation (HTTP-Redirect
 * binding), SAMLResponse validation (XML-DSig via xml-crypto, with explicit
 * signature-wrapping defenses), and SP metadata. The host drives the
 * redirect/ACS round-trip; identity owns account linking + sessions.
 */

export {
  generateAuthnRequest,
  decodeSamlPostResponse,
  validateSamlResponse,
  buildSpMetadata,
} from './saml.js'

export {
  SamlError,
  type AuthnRequestInput,
  type AuthnRequestResult,
  type ValidateSamlResponseInput,
  type SamlAssertionResult,
  type SpMetadataInput,
} from './types.js'
