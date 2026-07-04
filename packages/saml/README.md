# @gotong/saml

SAML 2.0 **Service Provider (SP)** protocol core for Gotong enterprise SSO
(Route B P1-M5). Pure functions; no network, no state, no IdP.

The dangerous parts — XML canonicalization (C14N) and the signature math — are
delegated to the vetted [`xml-crypto`](https://github.com/node-saml/xml-crypto)
library. What lives here is the **SP protocol glue** xml-crypto does not do, and
the **signature-wrapping (XSW) defenses** layered around it.

## Surface

| Function | Purpose |
|---|---|
| `generateAuthnRequest(input)` | Build an SP-initiated `AuthnRequest` + the HTTP-Redirect URL (deflate + base64). Returns the request `id` to correlate `InResponseTo`. |
| `decodeSamlPostResponse(b64)` | Base64-decode the `SAMLResponse` form field from the HTTP-POST binding (no inflate). |
| `validateSamlResponse(input)` | Validate signature + Issuer + Audience + time window + Recipient + `InResponseTo`; return the authenticated assertion facts (`nameId`, `email`, attributes, …). Throws `SamlError` on any failure. |
| `buildSpMetadata(input)` | SP metadata XML for the IdP (`WantAssertionsSigned=true`). |

## Security posture

- **Key pinned to the configured IdP cert** — the verification key is never
  taken from the document's own `KeyInfo` (cert-substitution defense).
- **Claims read only from `getSignedReferences()`** — the exact bytes the
  signature covered, never the raw document, so a forged assertion smuggled in
  as a sibling is never read (XSW defense).
- **Unique signed-assertion `@ID`** — a duplicated-ID XSW confusion is rejected.
- **DOCTYPE forbidden** — XXE / entity-expansion guard.
- **No partial trust** — signature is checked before any claim is read.

## Scope (MVP)

SP-initiated SSO, HTTP-Redirect AuthnRequest + HTTP-POST `SAMLResponse`,
RS256 / RSA-SHA256 + exclusive-c14n (the mainstream IdP default). Out of scope:
SP-signed AuthnRequests, artifact binding, Single Logout (SLO), IdP-initiated
SSO, and encrypted assertions.
