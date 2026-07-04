/**
 * Pluggable peer authentication for the hub-mesh wire (R1 — A2A
 * alignment seam).
 *
 * Before R1, mutual peer auth was a single pre-shared `peerToken` string
 * baked into the MESH_HELLO / MESH_HELLO_ACK frames and compared with
 * `timingSafeEqual`. That hard-coded "auth == one comparable string"
 * into every layer — the wire frame, the link options, both factories,
 * the host resolver. A2A requires peers to *declare* an auth scheme
 * (Bearer / OAuth2 / OIDC / mTLS); you cannot bolt OAuth2 onto a bare
 * string field without reshaping all of them at once.
 *
 * This module introduces the seam: the frame now carries an `auth`
 * ENVELOPE (`{scheme, credential}`, a discriminated union), and a
 * `PeerAuthScheme` object owns BOTH halves of the exchange — what this
 * side PRESENTS in its HELLO/ACK and how it VERIFIES the peer's.
 * `verifyPeerAuth` in hub-link.ts stays the single verification choke
 * point and just delegates here, dispatching by scheme kind.
 *
 * R1 ships exactly one scheme — `bearer` — which reproduces the prior
 * FED-M1 (shared secret) and Phase 6 #4 (per-peer resolver) behavior
 * bit-for-bit, including the exact rejection messages. New schemes
 * (oauth2, mtls) become new envelope variants + new factories WITHOUT
 * reshaping the frame or touching the choke point.
 */

import { timingSafeEqual } from 'node:crypto'

import type { ParticipantId } from '@gotong/core'

/**
 * The credential envelope carried in MESH_HELLO / MESH_HELLO_ACK.
 * Discriminated by `scheme` so a future OAuth2 / mTLS variant slots in
 * without changing the frame shape. An absent envelope means "this side
 * presents no credential" (unauthenticated peer — inproc tests, trusted
 * LAN).
 */
export type PeerAuthEnvelope =
  | { scheme: 'bearer'; credential: string }
// Future schemes plug in here without reshaping the frame or the choke
// point — kept as an explicit extension point, intentionally not yet
// implemented (see COMPETITIVE-LANDSCAPE.md §6 / A2A alignment):
//   | { scheme: 'oauth2'; credential: string /* bearer access token */ }
//   | { scheme: 'mtls';   credential?: never /* verified at the TLS layer */ }

/** Verdict from verifying one inbound envelope. */
export interface PeerAuthVerdict {
  /**
   * `null` = accepted. An `Error` = reject the handshake; its message is
   * surfaced to the IN side's logs (the OUT side only ever sees an
   * opaque socket close, by design — we never leak which check failed).
   */
  error: Error | null
  /**
   * On success, the envelope to echo back in our HELLO_ACK so the OUT
   * side can close the mutual-auth loop. `undefined` = echo nothing.
   * Under per-peer bearer this is the resolved per-pair secret; under
   * shared bearer it is our own configured token.
   */
  replyWith?: PeerAuthEnvelope
}

/**
 * One pluggable authentication scheme for a hub-link. A link is given at
 * most one. It both PRESENTS its own credential on outgoing HELLO/ACK
 * and VERIFIES the peer's on incoming HELLO/ACK.
 *
 * No scheme == unauthenticated: present nothing, accept anything.
 */
export interface PeerAuthScheme {
  /** Discriminator; matches the `scheme` of envelopes this emits/accepts. */
  readonly kind: PeerAuthEnvelope['scheme']
  /**
   * The envelope to present in our outgoing HELLO (the OUT side). The IN
   * side answers with `verifyInbound().replyWith` instead of this.
   * `undefined` = present nothing.
   */
  present(): PeerAuthEnvelope | undefined
  /**
   * Verify the peer's inbound envelope. `claimedPeerId` is the `peerId`
   * from the peer's HELLO, needed by per-peer lookups.
   */
  verifyInbound(
    received: PeerAuthEnvelope | undefined,
    claimedPeerId: ParticipantId | undefined,
  ): PeerAuthVerdict
}

/**
 * FED-M1 — constant-time string compare. `timingSafeEqual` throws on
 * length mismatch, so we early-return on differing / zero lengths (a
 * length difference is not a useful timing oracle and is safe to leak).
 * Returns `false` on any malformed input — callers want a boolean.
 */
function constantTimeStringEquals(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  if (a.length === 0) return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export interface BearerAuthOptions {
  /**
   * Shared-secret mode: present this token in our HELLO/ACK and require
   * the peer to present the same value — the classic FED-M1 pre-shared
   * secret. When combined with `resolver` on the IN side, the resolver
   * wins for verification while this stays what we present.
   */
  token?: string
  /**
   * Per-peer mode (Phase 6 #4): look up the expected token by the peer's
   * claimed id. `null` rejects (unknown / disabled peer). When set it
   * TAKES PRECEDENCE over `token` for verification — the IN side resolves
   * each peer's own secret instead of one shared value.
   */
  resolver?: (claimedPeerId: ParticipantId) => string | null
}

/**
 * The bearer scheme: a pre-shared / per-peer secret string presented on
 * the wire and compared constant-time. Reproduces the exact pre-R1
 * behavior (shared `peerToken` and `peerTokenResolver`), now expressed
 * as a declared scheme so OAuth2 / mTLS can join as sibling schemes.
 */
export function bearerAuth(opts: BearerAuthOptions): PeerAuthScheme {
  // Empty string is rejected at construction to catch the common config
  // typo where an env var was defined but empty (which would otherwise
  // silently present / expect a zero-length secret).
  if (opts.token !== undefined && opts.token.length === 0) {
    throw new Error(
      'bearerAuth: token must be a non-empty string when provided; ' +
        'omit it to present no credential',
    )
  }
  const { token, resolver } = opts
  return {
    kind: 'bearer',
    present(): PeerAuthEnvelope | undefined {
      return token !== undefined ? { scheme: 'bearer', credential: token } : undefined
    },
    verifyInbound(received, claimedPeerId): PeerAuthVerdict {
      // A non-bearer envelope on a bearer link is a scheme mismatch.
      // (Forward-compat guard; today 'bearer' is the only scheme.)
      if (received !== undefined && received.scheme !== 'bearer') {
        return {
          error: new Error(
            `peer presented '${received.scheme}' auth but this link speaks 'bearer'`,
          ),
        }
      }
      const presented = received?.credential

      // Per-peer resolver mode wins when configured.
      if (resolver) {
        if (!claimedPeerId || claimedPeerId.length === 0) {
          return { error: new Error('peer must present a peerId; per-peer auth requires it') }
        }
        let expected: string | null
        try {
          expected = resolver(claimedPeerId)
        } catch {
          // A resolver throw is a server-side bug. Fail closed; the
          // upstream stack surfaces in the operator's logs.
          return { error: new Error('peer token resolver threw; refusing connection') }
        }
        if (expected === null) {
          return {
            error: new Error(
              `unknown peer '${claimedPeerId}'; not in this host's peer registry`,
            ),
          }
        }
        if (expected.length === 0) {
          // Defensive: resolver returned '' instead of null.
          return { error: new Error('peer token resolver returned empty string; refusing') }
        }
        if (presented === undefined) {
          return { error: new Error('peer did not present a peerToken; mutual auth required') }
        }
        if (!constantTimeStringEquals(expected, presented)) {
          return { error: new Error('peer presented an invalid peerToken; mutual auth failed') }
        }
        // Echo the resolved per-pair secret so the OUT side can verify
        // it against its own local copy (closes the mutual loop).
        return { error: null, replyWith: { scheme: 'bearer', credential: expected } }
      }

      // Shared-secret mode — or "accept anything" when no token is set
      // (legacy / inproc test path).
      if (token === undefined) {
        return { error: null }
      }
      if (presented === undefined) {
        return { error: new Error('peer did not present a peerToken; mutual auth required') }
      }
      if (!constantTimeStringEquals(token, presented)) {
        // Never log the actual tokens — just the failure shape.
        return { error: new Error('peer presented an invalid peerToken; mutual auth failed') }
      }
      return { error: null, replyWith: { scheme: 'bearer', credential: token } }
    },
  }
}
