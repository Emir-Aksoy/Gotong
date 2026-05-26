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
  UsagePeriod,
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
  /**
   * Phase 6 #3 — org scoping. When omitted (or null), the pool resolves
   * vault rows with `ownerKind='org' AND ownerId IS NULL` — the host's
   * primary / implicit org. Set to a non-empty string when this host
   * is multi-tenant and you want this pool to see only rows tagged
   * with that orgId.
   *
   * The default is intentionally unset so single-org hosts (the common
   * case today) get the historical behavior with zero config change.
   * Multi-org deployments build one pool per org and route by
   * `task.origin.orgId` at dispatch time.
   */
  orgId?: string | null
}

/**
 * B2.2 — minimal "who pays for this call" descriptor. Deliberately
 * decoupled from `Task` / `TaskOrigin` so OrgApiPool stays free of
 * @aipehub/core and @aipehub/llm imports. Host wiring code adapts the
 * concrete shape (e.g. `task.origin`) to this contract at the seam.
 */
export interface QuotaSubject {
  /** v4 user id to debit. Absent → the gate is a no-op (allow). */
  userId?: string
}

/**
 * The `preCallHook` shape that `OrgApiPool.makeLlmQuotaGate` returns.
 * Throws when usage exceeds the cap; resolves silently otherwise.
 */
export type QuotaGate = (subject: QuotaSubject | undefined) => void

export interface MakeLlmQuotaGateOpts {
  /** Counter id, e.g. `'llm_requests'`. Required. */
  metric: string
  /** Rolling window. Required. */
  period: UsagePeriod
  /** Units to debit per call. Defaults to 1. */
  amount?: number
}

/**
 * Error thrown by a `QuotaGate` when a call would exceed the cap.
 * Carries the counter snapshot so the caller can build a meaningful
 * surface error (HTTP 429 body, task fail metadata, etc.) without
 * re-reading the store.
 */
export class QuotaExceededError extends Error {
  readonly code = 'quota_exceeded' as const
  constructor(
    public readonly userId: string,
    public readonly metric: string,
    public readonly period: UsagePeriod,
    public readonly used: number,
    public readonly quota: number,
    public readonly exceededBy: number,
  ) {
    super(
      `quota_exceeded: user=${userId} metric=${metric} period=${period} used=${used} quota=${quota} (over by ${exceededBy})`,
    )
    this.name = 'QuotaExceededError'
  }
}

export class OrgApiPool {
  private readonly identity: IdentityStore
  /**
   * Phase 6 #3 — null = primary host org (vault rows with
   * ownerId IS NULL); non-null string = a specific peer/sub-org.
   * Captured once at construction and used in every vault filter.
   */
  private readonly orgId: string | null
  /**
   * provider → resolved key. Misses are cached as `null` so a "we know
   * there's no key" answer is also free on the hot path; `invalidate()`
   * clears both hits and misses. Cache is per-pool-instance, so two
   * pools with different orgIds maintain isolated caches.
   */
  private cache = new Map<string, ResolvedLlmKey | null>()
  /**
   * Audit #145 — unsubscribe handle for the vault-mutation listener
   * we installed at construction. Cleared in `dispose()`. Tests +
   * long-running hosts that recreate the pool need this to avoid
   * leaking listener refs on the IdentityStore.
   */
  private vaultMutationUnsubscribe: (() => void) | undefined

  constructor(opts: OrgApiPoolOpts) {
    if (!opts || !opts.identity) {
      throw new TypeError('OrgApiPool requires { identity }')
    }
    this.identity = opts.identity
    // Normalise undefined → null so the rest of the class has one shape
    // and tests / callers can pass either {orgId: null} or {} for the
    // primary org. Reject empty string to catch accidental "".
    if (opts.orgId !== undefined && opts.orgId !== null) {
      if (typeof opts.orgId !== 'string' || opts.orgId.length === 0) {
        throw new TypeError(
          'OrgApiPool: orgId must be a non-empty string when provided (or null/omitted for primary)',
        )
      }
    }
    this.orgId = opts.orgId ?? null
    // Audit #145 — auto-flush cache when vault mutates. Before this,
    // an admin rotating a key via createVaultEntry + revokeVaultEntry
    // left the OLD plaintext in this.cache until something else
    // happened to call invalidate() (a 401 fires it; nothing else
    // did). Subscribing here closes that loop unconditionally.
    //
    // The store provides onVaultMutation as of Audit #145; old
    // identity stores without it just keep the previous behavior
    // (cache stale until 401 / manual invalidate). Defensive typeof
    // check lets us drop in against older fixtures without crashing.
    if (typeof (this.identity as { onVaultMutation?: unknown }).onVaultMutation === 'function') {
      this.vaultMutationUnsubscribe = this.identity.onVaultMutation(() => {
        this.cache.clear()
      })
    }
  }

  /**
   * The org scope this pool serves. Exposed so tests + multi-org
   * dispatch code can branch on "which pool am I about to call".
   */
  get scopedOrgId(): string | null {
    return this.orgId
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
      ownerId: this.orgId,
      activeOnly: true,
    })
  }

  /**
   * Drop the resolved-key cache. Audit #145 — also called automatically
   * by the IdentityStore vault-mutation subscriber installed at
   * construction, so manual calls are now only needed for non-vault
   * cache invalidation (e.g. when an external system changes the
   * provider tag mapping without touching the vault itself).
   */
  invalidate(): void {
    this.cache.clear()
  }

  /**
   * Audit #145 — detach the vault-mutation subscriber. Call when this
   * pool will no longer be used (host shutdown, test teardown, or
   * replacing a pool instance for a new orgId). Safe to call multiple
   * times; subsequent calls are no-ops.
   */
  dispose(): void {
    if (this.vaultMutationUnsubscribe) {
      this.vaultMutationUnsubscribe()
      this.vaultMutationUnsubscribe = undefined
    }
    this.cache.clear()
  }

  /**
   * B2.2 — build a `preCallHook`-compatible quota gate. Returns a
   * function that:
   *
   *   - receives a {@link QuotaSubject} (or undefined);
   *   - resolves silently when `subject?.userId` is absent (local
   *     dispatches that didn't opt into attribution are free);
   *   - otherwise calls `identity.checkAndIncrement` with the
   *     configured metric / period / amount;
   *   - throws {@link QuotaExceededError} when the call would breach
   *     the cap (caller's task fails with that error).
   *
   * Wiring example (host LocalAgentPool):
   *
   *     const gate = orgApiPool.makeLlmQuotaGate({
   *       metric: 'llm_requests', period: 'daily',
   *     })
   *     new LlmAgent({
   *       ...,
   *       preCallHook: (task) => gate(task.origin),
   *     })
   *
   * The hook is sync (no await) — `checkAndIncrement` is a single
   * transaction on a local sqlite, so blocking is fine.
   */
  makeLlmQuotaGate(opts: MakeLlmQuotaGateOpts): QuotaGate {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('makeLlmQuotaGate requires { metric, period }')
    }
    if (typeof opts.metric !== 'string' || opts.metric.length === 0) {
      throw new TypeError(
        'makeLlmQuotaGate: metric must be a non-empty string',
      )
    }
    const { metric, period } = opts
    const amount = opts.amount ?? 1
    if (
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      !Number.isInteger(amount) ||
      amount < 0
    ) {
      throw new TypeError(
        `makeLlmQuotaGate: amount must be a non-negative integer; got ${amount}`,
      )
    }
    const identity = this.identity
    const orgIdForAudit = this.orgId
    return function quotaGate(subject: QuotaSubject | undefined): void {
      const userId = subject?.userId
      if (!userId) return // unattributed call → unconstrained (by design)
      const result = identity.checkAndIncrement({
        userId,
        metric,
        period,
        amount,
      })
      if (!result.allowed) {
        const quota = result.counter.quota ?? 0
        // Audit #151 — the API_QUOTA_DENIED vocabulary is defined in
        // AUDIT_ACTIONS but until now nothing wrote it. Operators
        // could see per-user counters at the cap but not the "this
        // many calls were rejected in the last hour" series they need
        // to size a quota raise. Write best-effort: if the audit row
        // fails (DB busy, etc.) we still throw QuotaExceededError so
        // the caller knows the request was denied — never let an
        // audit-side fault swallow the gate decision.
        try {
          identity.writeAuditLog({
            action: 'api_quota_denied',
            actorSource: 'system',
            actorUserId: userId,
            targetUserId: userId,
            targetCredentialId: null,
            ip: null,
            userAgent: null,
            metadata: {
              metric,
              period,
              amount,
              used: result.counter.used,
              quota,
              exceededBy: result.exceededBy ?? 0,
              orgId: orgIdForAudit,
            },
            success: false,
          })
        } catch {
          // Best effort — see comment above. The gate decision is
          // already committed (checkAndIncrement is atomic).
        }
        throw new QuotaExceededError(
          userId,
          metric,
          period,
          result.counter.used,
          quota,
          result.exceededBy ?? 0,
        )
      }
    }
  }
}

/** Extract `metadata.provider` defensively (metadata is `unknown`-typed). */
function readProviderTag(e: VaultEntry): string | null {
  const m = e.metadata
  if (!m || typeof m !== 'object') return null
  const p = (m as Record<string, unknown>).provider
  return typeof p === 'string' && p.length > 0 ? p : null
}
