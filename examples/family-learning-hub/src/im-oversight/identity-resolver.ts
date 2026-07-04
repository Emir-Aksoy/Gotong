/**
 * Adapter: `IdentityStore` (sync, throws `IdentityError`) →
 * `ImBindingResolver` (Promise, discriminated-result).
 *
 * Copied verbatim from `examples/im-steward-bridge/src/identity-resolver.ts` (itself a copy
 * of `examples/im-bridge-host/src/identity-resolver.ts`). The store's API is sync because
 * better-sqlite3 is sync; bridges want `await` so they can swap in a remote / federated
 * resolver later without API churn. This adapter is the canonical bridge between the two.
 *
 * The throw → discriminated-result conversion is the interesting bit:
 * `claimImBindingCode` throws on the COMMON user-error path (wrong code, expired
 * code), but the `ImBindingResolver` contract (see `@gotong/im-adapter`)
 * explicitly says "discriminated result, not throw — IM users typing wrong codes
 * is the COMMON path." We catch the two known business-logic errors and translate;
 * any other throw bubbles up (it'd indicate infra failure, which the bridge maps
 * to a generic retry message).
 */

import type { ClaimResult, ImBindingResolver } from '@gotong/im-adapter'
import { IdentityError, type IdentityStore } from '@gotong/identity'

export function makeIdentityImBindingResolver(store: IdentityStore): ImBindingResolver {
  return {
    async resolveUserId(platform, platformUserId) {
      return store.getUserIdByImBinding(platform, platformUserId)
    },

    async claim(input): Promise<ClaimResult> {
      try {
        const result = store.claimImBindingCode({
          code: input.code,
          platform: input.platform,
          platformUserId: input.platformUserId,
          displayName: input.displayName ?? null,
        })
        return { ok: true, userId: result.userId }
      } catch (err) {
        if (err instanceof IdentityError) {
          if (err.code === 'im_binding_code_invalid') {
            return { ok: false, reason: 'invalid' }
          }
          if (err.code === 'im_binding_code_expired') {
            return { ok: false, reason: 'expired' }
          }
        }
        // Anything else — bad input shape, db corruption, etc — is
        // infra failure; let the bridge's catch surface it.
        throw err
      }
    },
  }
}
