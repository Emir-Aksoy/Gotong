/**
 * HostMeImService — GO-LIVE GL-1c. Backs `/api/me/im/*` so a member can link
 * THEIR OWN IM account (Telegram, …) to Gotong:
 *
 *   1. mint a one-time binding code here (POST /api/me/im/binding-code),
 *   2. DM the bot `/bind <code>` — the production IM bridge (im-bridge.ts)
 *      CONSUMES it via `claimImBindingCode`,
 *   3. from then on the member's IM messages dispatch as that member.
 *
 * Why this is a real gap and not polish: the GL-1 bridge only consumes `/bind`.
 * The identity store has always had `issueImBindingCode`, but NOTHING exposed it
 * over HTTP — the example minted codes in-process. Without an issuance route a
 * real member could never produce a code, so the bridge accepted binds nobody
 * could create. This closes that loop, member-first.
 *
 * The constrained door (mirrors HostMeCredentialsService):
 *   - issue/list are scoped to the SESSION userId — a member can't mint a code
 *     for, or enumerate the bindings of, another account;
 *   - revoke is gated on `getUserIdByImBinding(...) === caller` → 404 (not 403)
 *     otherwise, so a member can't disconnect (or probe the existence of)
 *     someone else's IM binding;
 *   - there is no secret to project — a binding is just (platform,
 *     platformUserId) → this member; the short-lived code is single-use and
 *     rotates on re-issue (the store deletes the prior row first).
 */

import { createLogger } from '@gotong/core'
import type { ImBinding, ImBindingCode } from '@gotong/identity'
import type { WebServerOptions } from '@gotong/web'

const log = createLogger('me-im')

// Derive the surface contract from the web opts — single source of truth, no
// re-export needed (same pattern as HostMeCredentialsService).
type MeImSurface = NonNullable<WebServerOptions['meIm']>
type MeImBindingView = Awaited<ReturnType<MeImSurface['listBindings']>>[number]
type MeImCodeView = Awaited<ReturnType<MeImSurface['issueCode']>>

/** The narrow slice of IdentityStore this service needs (real store satisfies). */
export interface MeImBindingStore {
  issueImBindingCode(input: { userId: string; ttlMs?: number }): ImBindingCode
  listImBindings(userId: string, query?: { platform?: string }): ImBinding[]
  getUserIdByImBinding(platform: string, platformUserId: string): string | null
  removeImBinding(platform: string, platformUserId: string): number
}

export interface HostMeImServiceOpts {
  identity: MeImBindingStore
  /**
   * Live read of whether an IM bridge is actually running. Pure UI hint — the
   * `/me` panel hides the "connect" button when no bridge is configured, so a
   * member isn't handed a code nothing can consume. A closure (not a boolean)
   * so it reflects the host's `imBridges` handle at request time, not boot time.
   */
  isEnabled: () => boolean
}

export class HostMeImService implements MeImSurface {
  private readonly identity: MeImBindingStore
  private readonly isEnabled: () => boolean

  constructor(opts: HostMeImServiceOpts) {
    this.identity = opts.identity
    this.isEnabled = opts.isEnabled
  }

  enabled(): boolean {
    return this.isEnabled()
  }

  async listBindings(userId: string): Promise<MeImBindingView[]> {
    return this.identity.listImBindings(userId).map(projectBinding)
  }

  async issueCode(userId: string): Promise<MeImCodeView> {
    // TTL/rotation/format are the store's call (default 10 min, single-use,
    // prior code deleted first). We only scope it to the caller.
    const issued = this.identity.issueImBindingCode({ userId })
    log.info('member issued IM binding code', { userId, expiresAt: issued.expiresAt })
    return { code: issued.code, expiresAt: issued.expiresAt }
  }

  async removeBinding(
    userId: string,
    platform: string,
    platformUserId: string,
  ): Promise<boolean> {
    // 404 (not 403) unless this binding is the caller's OWN — never reveal that
    // some (platform, platformUserId) pair is bound to a different member.
    const owner = this.identity.getUserIdByImBinding(platform, platformUserId)
    if (owner !== userId) {
      throw httpError(404, 'binding not found')
    }
    const removed = this.identity.removeImBinding(platform, platformUserId) > 0
    log.info('member removed IM binding', { userId, platform, removed })
    return removed
  }
}

// -- helpers --------------------------------------------------------------

function projectBinding(b: ImBinding): MeImBindingView {
  return {
    platform: b.platform,
    platformUserId: b.platformUserId,
    displayName: b.displayName,
    createdAt: b.createdAt,
  }
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}
