/**
 * B1.1 — Org-level LLM API key pool.
 *
 * Reads `kind='llm_provider'` + `ownerKind='org'` rows from the identity
 * vault and exposes a tiny `resolveLlmKey(provider)` surface so the rest
 * of the host doesn't reach into the vault directly to pull LLM secrets.
 *
 * Why a pool object instead of "just call identity.listVaultEntries
 * everywhere":
 *
 *   1. The yaml-level provider tag ('anthropic' | 'openai' | 'deepseek'
 *      | ...) lives in `metadata.provider`. `listVaultEntries` can't
 *      filter on metadata (no JSON-aware SQL where clause), so every
 *      caller would otherwise duplicate the JS-side filter.
 *   2. Agent spawn is hot — we don't want to AES-decrypt the same key
 *      once per dispatch. The pool memoises per-provider after the
 *      first successful resolve. Admin UI / CLI calls `invalidate()`
 *      after mutating a vault entry; no TTL guesswork.
 *   3. A single chokepoint where B2 (per-user quota) and F1 (audit on
 *      resolve) will be added without touching every consumer.
 *
 * Out of scope for B1.1 (deferred):
 *   - LocalAgentPool integration — B1.2.
 *   - Quota enforcement, audit logging — B2 / F1.
 *   - Per-user / per-agent key selection — today returns the org's
 *     newest matching key. Plumbing for "give me a specific entry id"
 *     stays unbuilt until B2 actually needs it.
 */

import type {
  IdentityStore,
  VaultEntry,
} from '@aipehub/identity'

/**
 * Resolved org-level LLM API key. The pool returns this — never the raw
 * `VaultEntry` — so secret material lives in one place and every
 * resolution is stamped with `entryId`, which downstream audit / quota
 * code can use to attribute usage back to a specific vault row.
 */
export interface ResolvedLlmKey {
  /** Provider tag from `metadata.provider`, e.g. `'anthropic'`. */
  readonly provider: string
  /** Decrypted secret. NEVER log this. */
  readonly apiKey: string
  /** Vault entry id — stable handle for audit / per-key quota lookup. */
  readonly entryId: string
  /** Human label from the vault row, when set. */
  readonly label: string | null
}

export interface OrgApiPoolOpts {
  identity: IdentityStore
}

export class OrgApiPool {
  private readonly identity: IdentityStore
  /**
   * provider → resolved key. Misses are cached as `null` so a "we know
   * there's no key" answer is also free on the hot path; `invalidate()`
   * clears both hits and misses.
   */
  private cache = new Map<string, ResolvedLlmKey | null>()

  constructor(opts: OrgApiPoolOpts) {
    if (!opts || !opts.identity) {
      throw new TypeError('OrgApiPool requires { identity }')
    }
    this.identity = opts.identity
  }

  /**
   * Return the active org-owned LLM key for `provider`, or `null` when
   * none is configured. Result is cached until {@link invalidate}.
   *
   * Multiple active rows for the same provider: the newest (highest
   * `createdAt`) wins. Matches typical "user rotated the key, use the
   * new one" intent without forcing admin UI to revoke the old row.
   */
  resolveLlmKey(provider: string): ResolvedLlmKey | null {
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new TypeError(
        'OrgApiPool.resolveLlmKey: provider must be a non-empty string',
      )
    }
    if (this.cache.has(provider)) return this.cache.get(provider) ?? null

    const entries = this.listOrgLlmEntries().filter(
      (e) => readProviderTag(e) === provider,
    )
    // listVaultEntries already returns newest-first.
    const chosen = entries[0]
    if (!chosen) {
      this.cache.set(provider, null)
      return null
    }
    const apiKey = this.identity.readVaultSecret(chosen.id)
    const resolved: ResolvedLlmKey = {
      provider,
      apiKey,
      entryId: chosen.id,
      label: chosen.label,
    }
    this.cache.set(provider, resolved)
    return resolved
  }

  /**
   * List unique provider tags currently configured at org scope.
   * Stable order: alphabetical, deduped. Useful for admin UI dropdowns
   * and "which providers does this org support" introspection.
   */
  listProviders(): string[] {
    const set = new Set<string>()
    for (const e of this.listOrgLlmEntries()) {
      const tag = readProviderTag(e)
      if (tag) set.add(tag)
    }
    return Array.from(set).sort()
  }

  /**
   * Raw access to org-owned llm_provider rows (active only). Exposed
   * for admin UI / debug. Does NOT decrypt secrets — caller must go
   * through {@link resolveLlmKey} to obtain plaintext.
   */
  listOrgLlmEntries(): VaultEntry[] {
    return this.identity.listVaultEntries({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      activeOnly: true,
    })
  }

  /**
   * Drop the resolved-key cache. Call after creating / revoking /
   * editing a vault entry; otherwise the previous answer (including a
   * `null` miss) stays cached for the lifetime of this pool instance.
   */
  invalidate(): void {
    this.cache.clear()
  }
}

/** Extract `metadata.provider` defensively (metadata is `unknown`-typed). */
function readProviderTag(e: VaultEntry): string | null {
  const m = e.metadata
  if (!m || typeof m !== 'object') return null
  const p = (m as Record<string, unknown>).provider
  return typeof p === 'string' && p.length > 0 ? p : null
}
