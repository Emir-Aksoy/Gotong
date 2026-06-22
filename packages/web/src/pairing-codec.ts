/**
 * Cross-org pairing-code codec (ease-of-use ④-M1).
 *
 * A "pairing code" bundles the three things an operator otherwise pastes by
 * hand when registering a federation peer — the peer's id, its dial endpoint,
 * and the shared bearer token — into a single copy-paste string. It is a
 * CONVENIENCE ENCODING, NOT a new security mechanism: the token is still the
 * symmetric shared secret both hubs must hold, and the code carries it in the
 * clear (base64 is not encryption). Treat a pairing code exactly as you would
 * the raw token — only hand it over a channel you trust.
 *
 * Wire shape: base64url( utf8( JSON.stringify({ v, peerId, endpoint, token }) ) ).
 * The `v` tag lets a future format change be detected and rejected rather than
 * mis-parsed into a half-valid peer registration.
 *
 * This module is the canonical spec and the unit-tested surface. The browser
 * panel (packages/web/static/peer-admin-ui.js) inlines the byte-identical
 * transform — static files can't import from src — so keep the two in sync;
 * the test here pins the contract.
 */

export interface PairCode {
  peerId: string
  endpoint: string
  token: string
}

export class PairCodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PairCodeError'
  }
}

/** Bump only on an incompatible shape change; decode rejects other values. */
const PAIR_CODE_VERSION = 1

function toBase64Url(json: string): string {
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64Url(code: string): string {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

/**
 * Pack a peer link into a pairing code. Fields are trimmed; any blank field is
 * a programming error (the UI requires all three before calling this) and
 * throws rather than emitting a code that decodes to a broken registration.
 */
export function encodePairCode(input: PairCode): string {
  const peerId = (input?.peerId ?? '').trim()
  const endpoint = (input?.endpoint ?? '').trim()
  const token = (input?.token ?? '').trim()
  if (!peerId || !endpoint || !token) {
    throw new PairCodeError('peerId, endpoint and token are all required')
  }
  return toBase64Url(JSON.stringify({ v: PAIR_CODE_VERSION, peerId, endpoint, token }))
}

/**
 * Decode + validate a pairing code. Throws `PairCodeError` on anything that
 * isn't a well-formed current-version code with all three string fields, so a
 * caller can surface one honest "not a valid pairing code" message instead of
 * silently pre-filling a form with garbage.
 */
export function decodePairCode(code: string): PairCode {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new PairCodeError('empty pairing code')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(code.trim()))
  } catch {
    throw new PairCodeError('not a valid pairing code')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new PairCodeError('not a valid pairing code')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.v !== PAIR_CODE_VERSION) {
    throw new PairCodeError(`unsupported pairing-code version: ${String(obj.v)}`)
  }
  const { peerId, endpoint, token } = obj
  if (
    typeof peerId !== 'string' ||
    typeof endpoint !== 'string' ||
    typeof token !== 'string' ||
    !peerId ||
    !endpoint ||
    !token
  ) {
    throw new PairCodeError('pairing code is missing peerId / endpoint / token')
  }
  return { peerId, endpoint, token }
}
