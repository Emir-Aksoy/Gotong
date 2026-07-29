/**
 * HostMeDeviceService — SHELL-M1. Backs `/api/me/devices*` and the PUBLIC
 * `/api/devices/claim` so a member can pair a native app shell to this hub:
 *
 *   1. signed into the web UI, the member mints a pairing code,
 *   2. the app scans the QR (or the member retypes the code) and POSTs it,
 *   3. the hub trades it for an `aipk_` key bound to that device,
 *   4. from then on the app authenticates with `Authorization: Bearer`.
 *
 * Step 4 is why this milestone is small: `resolveV4Auth` has always accepted
 * `aipk_` keys and `/api/me/*` has always been reachable with one. What was
 * missing was a way for a MEMBER to get such a key without an owner minting
 * it by hand — and a way for that key to expire.
 *
 * The constrained door (mirrors HostMeImService):
 *   - issue/list are scoped to the SESSION userId;
 *   - revoke is gated on the credential belonging to the caller AND being an
 *     api_key → 404 otherwise, so a member can neither kill someone else's
 *     credential nor probe whether a given credential id exists;
 *   - `claim` is deliberately NOT scoped to a caller — it has none. The code
 *     is the authorisation and the store decides whose it was. The rate limit
 *     that makes that safe lives in the web layer, at the public edge.
 *
 * The listing shows every `api_key` credential, not just paired devices: a
 * key an owner issued for CI can also act as this member, so hiding it from
 * the one place a member can revoke things would be the wrong kind of tidy.
 * Such rows carry `expiresAt: null`, which is how the UI tells them apart.
 */

import { createLogger } from '@gotong/core'
import type {
  ClaimedDevice,
  Credential,
  DevicePairingCode,
} from '@gotong/identity'
import type { WebServerOptions } from '@gotong/web'

const log = createLogger('me-devices')

// Derive the surface contract from the web opts — single source of truth
// (same pattern as HostMeImService).
type MeDeviceSurface = NonNullable<WebServerOptions['devices']>
type MeDeviceRow = Awaited<ReturnType<MeDeviceSurface['list']>>[number]

/** The narrow slice of IdentityStore this service needs (real store satisfies). */
export interface MeDeviceStore {
  issueDevicePairingCode(input: { userId: string; ttlMs?: number }): DevicePairingCode
  claimDevicePairingCode(input: {
    code: string
    deviceLabel?: string | null
  }): ClaimedDevice
  listCredentials(userId: string): Credential[]
  revokeCredential(credentialId: string): void
}

export interface HostMeDeviceServiceOpts {
  identity: MeDeviceStore
}

export class HostMeDeviceService implements MeDeviceSurface {
  private readonly identity: MeDeviceStore

  constructor(opts: HostMeDeviceServiceOpts) {
    this.identity = opts.identity
  }

  async issueCode(userId: string): Promise<{
    code: string
    display: string
    expiresAt: number
  }> {
    // TTL / rotation / alphabet are the store's call. We only scope to the caller.
    const issued = this.identity.issueDevicePairingCode({ userId })
    log.info('member issued device pairing code', { userId, expiresAt: issued.expiresAt })
    return { code: issued.code, display: issued.display, expiresAt: issued.expiresAt }
  }

  async list(userId: string): Promise<MeDeviceRow[]> {
    return this.identity
      .listCredentials(userId)
      .filter((c) => c.kind === 'api_key')
      .map(projectDevice)
  }

  async revoke(userId: string, credentialId: string): Promise<{ removed: boolean }> {
    // Only the caller's OWN api_key credentials. A password credential is not
    // revocable here (that would be a confusing way to lock yourself out), and
    // someone else's id must be indistinguishable from one that doesn't exist.
    const mine = this.identity
      .listCredentials(userId)
      .find((c) => c.id === credentialId && c.kind === 'api_key')
    if (!mine) {
      throw httpError(404, 'device not found')
    }
    this.identity.revokeCredential(credentialId)
    log.info('member revoked device', { userId, credentialId })
    return { removed: true }
  }

  async claim(input: { code: string; deviceLabel?: string | null }): Promise<{
    key: string
    userId: string
    expiresAt: number
  }> {
    // No caller scoping by design — see the header. The store consumes the
    // code and mints the credential in one transaction; its refusals (duck
    // `code: 'device_pairing_code_*'`) are what the route flattens to one
    // indistinguishable answer.
    const claimed = this.identity.claimDevicePairingCode(input)
    log.info('device paired', {
      userId: claimed.userId,
      credentialId: claimed.credentialId,
      expiresAt: claimed.expiresAt,
    })
    return { key: claimed.key, userId: claimed.userId, expiresAt: claimed.expiresAt }
  }
}

// -- helpers --------------------------------------------------------------

function projectDevice(c: Credential): MeDeviceRow {
  // Narrow on purpose: `identifier` is the token hash and `secretHash` is the
  // same value again. Neither belongs in a projection, and a row shape that
  // simply has no field for them can't leak them by accident later.
  return {
    credentialId: c.id,
    label: c.label ?? 'Paired device',
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    lastUsedAt: c.lastUsedAt,
  }
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}
