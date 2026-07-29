/**
 * device-routes.ts — SHELL-M1. Pairing a native app shell to this hub.
 *
 *   POST   /api/me/devices/pairing-code   member self-service; mints a code
 *   GET    /api/me/devices                the member's paired devices
 *   DELETE /api/me/devices/:credentialId  revoke one
 *   POST   /api/devices/claim             PUBLIC — trades a code for a key
 *
 * The claim route is the whole reason this file exists separately. It is
 * unauthenticated by necessity: the app has no credential yet, that's what
 * it is asking for. Which means three things hold it up, and all three are
 * load-bearing:
 *
 *   1. The code is 80 bits (identity `tokens.ts`), not the 6 digits an IM
 *      binding code uses. 10^6 is fine behind a chat platform; it is not
 *      fine on the open internet.
 *   2. A per-IP rate limit, injected by the server so it shares the same
 *      RateLimiter machinery as admin login.
 *   3. "Wrong code" and "no such code" are the same answer, so the endpoint
 *      can't be used to map which codes are live.
 *
 * Everything after pairing rides the Bearer path `resolveV4Auth` already
 * accepts (`aipk_`), so no second authentication mechanism is introduced —
 * the app is just a client holding an API key that happens to expire.
 *
 * Auth for the /api/me/* half: handleMeRoute's session gate resolved the
 * caller, so `userId` is server-pinned and a userId in the query string is
 * ignored (same posture as panel-routes / push-routes).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { readJsonBody, sendJson } from './http-helpers.js'
import { qrSvgDataUri } from './qr.js'

/**
 * Host-side device surface (duck-typed; web stays host-free).
 *
 * Note `claim` takes no userId — the code IS the authorisation, and which
 * member it belongs to is the store's answer, never the caller's claim.
 */
export interface MeDeviceSurface {
  issueCode(userId: string): Promise<{ code: string; display: string; expiresAt: number }>
  list(userId: string): Promise<DeviceRow[]>
  revoke(userId: string, credentialId: string): Promise<{ removed: boolean }>
  claim(input: { code: string; deviceLabel?: string | null }): Promise<{
    key: string
    userId: string
    expiresAt: number
  }>
}

export interface DeviceRow {
  credentialId: string
  label: string
  createdAt: number
  /** null for credentials that never expire (API keys the owner issued). */
  expiresAt: number | null
  lastUsedAt: number | null
}

export interface MeDeviceRouteDeps {
  devices: MeDeviceSurface | undefined
  /**
   * Whether X-Forwarded-Proto may be believed — the server's existing switch,
   * shared with the agent card's base URL. Off means a request that arrived
   * over plain HTTP is described as plain HTTP no matter what it claims.
   */
  trustProxy: boolean
}

export interface DeviceClaimRouteDeps {
  devices: MeDeviceSurface | undefined
  /**
   * Returns false when this caller is over budget. Injected so the claim
   * endpoint shares the server's RateLimiter rather than growing its own.
   */
  allowClaim(): boolean
}

/**
 * Map a host surface error to an HTTP status (default 500), same helper
 * shape me-routes uses for member agent CRUD. It matters here because
 * `revoke` answers 404 for "not yours" — collapsing that to 500 would turn
 * a deliberate refusal into an apparent bug.
 */
function surfaceErrStatus(err: unknown): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status
    if (typeof s === 'number' && s >= 400 && s < 600) return s
  }
  return 500
}

/**
 * The origin the member reached us on, mirroring how the A2A agent card
 * derives its own base URL (server.ts). It is request-derived on purpose:
 * whichever address the member's browser is actually talking to is the one
 * their phone should be told to talk to.
 *
 * SHELL-M2 will replace this with the single choke point that decides "which
 * hub" for every client — this is the first caller that needs an answer, and
 * it should be folded into that seam rather than grow a second one.
 */
function pairingOrigin(req: IncomingMessage, trustProxy: boolean): string {
  const xfProto = req.headers['x-forwarded-proto']
  const fwd = (Array.isArray(xfProto) ? xfProto[0] : xfProto)?.split(',')[0]?.trim()
  const proto = (trustProxy && fwd) || 'http'
  return `${proto}://${req.headers.host ?? 'localhost'}`
}

/**
 * What the QR encodes: where to connect, and the one-shot code. Two fields,
 * because scanning has to answer both questions at once — that was the point
 * of choosing a QR over a 6-digit code the member also has to pair with a
 * hand-typed address (SHELL-M0 岔口 C).
 *
 * The custom scheme is claimed by the shell (SHELL-M5); nothing else on the
 * device answers it, so a scan that lands anywhere else simply does nothing.
 */
export function pairingPayload(origin: string, code: string): string {
  return `gotong://pair?u=${encodeURIComponent(origin)}&c=${encodeURIComponent(code)}`
}

/** Duck-typed identity refusals we know how to map. Anything else → 500. */
function claimErrStatus(err: unknown): number {
  const code = (err as { code?: unknown })?.code
  if (
    code === 'device_pairing_code_invalid' ||
    code === 'device_pairing_code_expired' ||
    code === 'invalid_input'
  ) {
    return 400
  }
  return 500
}

// ---------------------------------------------------------------------------
// Member half — /api/me/devices*
// ---------------------------------------------------------------------------

/** Returns true when the request was handled (mirrors handleMePanelRoute). */
export async function handleMeDeviceRoute(
  deps: MeDeviceRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  userId: string,
): Promise<boolean> {
  if (path === '/api/me/devices' && method === 'GET') {
    // Degrade to an honest empty list rather than 503 — the SPA card can
    // then render "not available on this host" from `available:false`
    // without a failed request in the console. Same contract as
    // /api/me/push.
    if (!deps.devices) {
      sendJson(res, { available: false, devices: [] })
      return true
    }
    sendJson(res, { available: true, devices: await deps.devices.list(userId) })
    return true
  }

  if (path === '/api/me/devices/pairing-code' && method === 'POST') {
    if (!deps.devices) {
      sendJson(res, { error: 'device pairing unavailable (identity not wired)' }, 503)
      return true
    }
    try {
      const issued = await deps.devices.issueCode(userId)
      // `code` is what goes in the QR; `display` is what the member reads
      // aloud or retypes. Both describe the same secret.
      const pairingUrl = pairingPayload(pairingOrigin(req, deps.trustProxy), issued.code)
      // A QR that won't fit is not a failed pairing — the grouped code still
      // works by hand. So the image is best-effort and its absence is a
      // documented state the card renders around, never a 500.
      let qrDataUri: string | null = null
      try {
        qrDataUri = qrSvgDataUri(pairingUrl)
      } catch {
        qrDataUri = null
      }
      sendJson(res, { ok: true, ...issued, pairingUrl, qrDataUri }, 201)
    } catch (err) {
      sendJson(
        res,
        { error: err instanceof Error ? err.message : String(err) },
        surfaceErrStatus(err),
      )
    }
    return true
  }

  if (path.startsWith('/api/me/devices/') && method === 'DELETE') {
    if (!deps.devices) {
      sendJson(res, { error: 'device pairing unavailable (identity not wired)' }, 503)
      return true
    }
    const credentialId = decodeURIComponent(path.slice('/api/me/devices/'.length))
    if (!credentialId) {
      sendJson(res, { error: 'credential id required' }, 400)
      return true
    }
    try {
      // The surface scopes the revoke to this member — a credentialId
      // belonging to someone else must not be revocable by guessing it.
      const { removed } = await deps.devices.revoke(userId, credentialId)
      sendJson(res, { ok: true, removed })
    } catch (err) {
      // 404 here means "not a device of yours" — the surface refuses to
      // distinguish that from an id that never existed, and this mapping
      // is what carries that refusal to the wire intact.
      sendJson(
        res,
        { error: err instanceof Error ? err.message : String(err) },
        surfaceErrStatus(err),
      )
    }
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Public half — /api/devices/claim
// ---------------------------------------------------------------------------

/**
 * Mounted BEFORE the CSRF gate and outside any auth check, like the OIDC
 * and OAuth callbacks: a native app posting from `capacitor://` sends no
 * Origin the browser-shaped check could satisfy, and it has no session.
 * The pairing code is the only credential involved, by design.
 */
export async function handleDeviceClaimRoute(
  deps: DeviceClaimRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<boolean> {
  if (path !== '/api/devices/claim') return false
  if (method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return true
  }
  if (!deps.devices) {
    sendJson(res, { error: 'device pairing unavailable' }, 503)
    return true
  }
  // Rate limit BEFORE reading the body: a flood shouldn't get us to parse
  // its payloads, and the answer here is the same either way.
  if (!deps.allowClaim()) {
    sendJson(res, { error: 'too many attempts', code: 'rate_limited' }, 429)
    return true
  }

  const body = (await readJsonBody(req).catch(() => null)) as
    | { code?: unknown; deviceLabel?: unknown }
    | null
  const code = typeof body?.code === 'string' ? body.code : ''
  const deviceLabel = typeof body?.deviceLabel === 'string' ? body.deviceLabel : null

  try {
    const claimed = await deps.devices.claim({ code, deviceLabel })
    // The key is returned exactly once, here. Nothing stores it but the
    // device — the hub only ever has its hash.
    sendJson(res, {
      ok: true,
      key: claimed.key,
      userId: claimed.userId,
      expiresAt: claimed.expiresAt,
    })
  } catch (err) {
    const status = claimErrStatus(err)
    // Deliberately flat: the member sees "that code didn't work" and an
    // attacker learns nothing about WHY. The distinct identity codes still
    // exist for logs and tests; they just don't travel over this wire.
    sendJson(
      res,
      status === 400
        ? { error: 'pairing code not accepted', code: 'pairing_failed' }
        : { error: 'pairing failed' },
      status,
    )
  }
  return true
}
