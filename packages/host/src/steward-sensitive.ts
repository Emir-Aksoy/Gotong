/**
 * StewardSensitiveExecutors — SW-M9-B3. The OPERATOR-ONLY executors for the four
 * sensitive steward writes: register / revoke an org LLM credential, set a peer
 * (cross-org) link's trust-contract policy, and set a security-relevant usage
 * quota. They are the second half of the DOUBLE GATE:
 *
 *   Gate 1 (classification, B-M2): `classify.ts` tiers a sensitive action
 *     `forbidden` for a MEMBER steward, and `dangerous` (→ approval inbox) for an
 *     OPERATOR steward.
 *   Gate 2 (dependency injection, B-M3): THIS executor is constructed and passed
 *     ONLY to the operator steward (main.ts). The member steward never receives
 *     it, so `performStewardAction` has nothing to delegate to and FAILS CLOSED —
 *     even if a future mis-tier let a sensitive action slip past gate 1, it still
 *     cannot run. Defence in depth: the privilege IS the injected dependency.
 *
 * The key-safety invariant (the single most important Phase B decision):
 *
 *   A sensitive action NEVER carries a plaintext secret. `set_credential_ref`
 *   names an ENV VAR (`envVarName`) the operator set on the host out of band; THIS
 *   executor — the only plaintext holder in the entire steward chain — resolves
 *   `process.env[envVarName]` at apply time and hands it straight to the vault.
 *   The proposal JSON / apply body / inbox item / transcript / history only ever
 *   carry the env-var NAME. This mirrors the `tokenEnv` / `headerEnv` precedent
 *   (a2a-agent-store, peer-summary-alert-channel-store): "the secret stays in the
 *   normal env channel and never lands in the DB or an admin HTTP body".
 *
 * peer-policy and quota are non-secret by construction (the peer policy columns
 * are plain JSON; a quota is a number), so they map straight onto the identity
 * write APIs. The IdentityStore re-validates `metric` / `period` (quota) and the
 * peer-id existence — an out-of-range value fails there, visibly, not here.
 */

import { createLogger } from '@aipehub/core'
import type {
  SetOrgQuotaInput,
  SetQuotaInput,
  UpdatePeerInput,
  UsagePeriod,
  VaultEntry,
} from '@aipehub/identity'
import type {
  StewardCredentialRef,
  StewardPeerPolicy,
  StewardSecurityQuota,
} from '@aipehub/hub-steward'

const log = createLogger('steward-sensitive')

/**
 * The executor contract `performStewardAction` delegates the four sensitive kinds
 * to. Injected ONLY for the operator steward; absent (the member steward) ⇒ those
 * kinds fail closed (and the member classifier never proposes them anyway). Every
 * method returns a NO-PLAINTEXT result — just the vault id / a boolean.
 */
export interface StewardSensitiveExecutors {
  /**
   * Register an org-scope LLM credential, resolving the secret from the named
   * host env var (NOT from the action). Returns the minted vault id only.
   */
  setCredentialRef(userId: string, ref: StewardCredentialRef): Promise<{ credentialId: string }>
  /** Revoke an org-scope LLM credential by id. `removed:false` if it isn't one. */
  revokeCredential(userId: string, credentialId: string): Promise<{ removed: boolean }>
  /** Set a peer (cross-org) link's trust-contract policy fields. */
  setPeerPolicy(userId: string, policy: StewardPeerPolicy): Promise<void>
  /** Set a security-relevant usage quota. */
  setSecurityQuota(userId: string, quota: StewardSecurityQuota): Promise<void>
}

/**
 * The narrow IdentityStore slice the host executor needs — the real `IdentityStore`
 * satisfies it (same `Parameters<…>`-free duck-typing the member services use). A
 * test can pass a real store or a light fake.
 */
export interface StewardSensitiveIdentity {
  createVaultEntry(input: {
    kind: 'llm_provider'
    ownerKind: 'org'
    ownerId: null
    secret: string
    label?: string | null
    metadata?: Record<string, unknown> | null
  }): VaultEntry
  listVaultEntries(query: {
    kind?: 'llm_provider'
    ownerKind?: 'org'
    ownerId?: string | null
    activeOnly?: boolean
  }): VaultEntry[]
  revokeVaultEntry(id: string): boolean
  updatePeer(id: string, input: UpdatePeerInput): unknown
  /** Per-user quota — `userId` FKs into the users table (the user must exist). */
  setQuota(input: SetQuotaInput): unknown
  /** Hub-wide quota — no user FK; what a `scope:'hub'` quota maps onto. */
  setOrgQuota(input: SetOrgQuotaInput): unknown
}

/**
 * The reserved `scope` value that routes a quota to the HUB-WIDE counter
 * (`setOrgQuota`) instead of a per-user one (`setQuota`, which FKs into the users
 * table). The `set_security_quota` action's `scope` doc lists `hub` explicitly.
 */
const HUB_QUOTA_SCOPE = 'hub'

export interface HostStewardSensitiveExecutorsOpts {
  identity: StewardSensitiveIdentity
}

export class HostStewardSensitiveExecutors implements StewardSensitiveExecutors {
  private readonly identity: StewardSensitiveIdentity

  constructor(opts: HostStewardSensitiveExecutorsOpts) {
    this.identity = opts.identity
  }

  async setCredentialRef(
    userId: string,
    ref: StewardCredentialRef,
  ): Promise<{ credentialId: string }> {
    // The ONLY place a plaintext secret enters the steward chain — read from the
    // host env, never from the action. Empty / unset ⇒ fail visibly so the
    // operator knows to set it on the host before approving.
    const secret = process.env[ref.envVarName]
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error(
        `steward set_credential_ref: env var ${ref.envVarName} is empty or unset — ` +
          'set it on the host before approving this credential',
      )
    }
    // Org scope (ownerKind='org', ownerId=null) so OrgApiPool resolves it
    // hub-wide — the operator manages site-wide credentials, not a member's BYO key.
    const entry = this.identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'org',
      ownerId: null,
      secret,
      // Non-secret context only — the env var NAME is recorded so the admin UI can
      // show "Anthropic · via $FOO_KEY" without ever touching the secret.
      metadata: { provider: ref.provider, envVarName: ref.envVarName, registeredBy: userId },
      ...(ref.label !== undefined ? { label: ref.label } : {}),
    })
    log.info('operator registered org credential', {
      userId,
      provider: ref.provider,
      envVarName: ref.envVarName,
      credentialId: entry.id,
    })
    return { credentialId: entry.id }
  }

  async revokeCredential(userId: string, credentialId: string): Promise<{ removed: boolean }> {
    // Only an ORG llm_provider row may be revoked through the operator steward —
    // never a member's BYO key, never a peer token. Guard via list first so an
    // unrelated id quietly returns `removed:false` rather than touching it.
    const orgKeys = this.identity.listVaultEntries({ kind: 'llm_provider', ownerKind: 'org' })
    if (!orgKeys.some((e) => e.id === credentialId)) {
      log.warn('operator revoke skipped — not an org credential', { userId, credentialId })
      return { removed: false }
    }
    const removed = this.identity.revokeVaultEntry(credentialId)
    log.info('operator revoked org credential', { userId, credentialId, removed })
    return { removed }
  }

  async setPeerPolicy(userId: string, policy: StewardPeerPolicy): Promise<void> {
    // Only the fields the steward vocabulary exposes; an omitted field is left
    // unchanged (UpdatePeerInput's undefined-preserve contract). `updatePeer`
    // throws IdentityError if the peer id doesn't exist — fail-visible.
    const input: UpdatePeerInput = {}
    if (policy.allowedDataClasses !== undefined) input.allowedDataClasses = [...policy.allowedDataClasses]
    if (policy.perLinkQuotaBudget !== undefined) input.perLinkQuotaBudget = policy.perLinkQuotaBudget
    if (policy.shareSummary !== undefined) input.shareSummary = policy.shareSummary
    this.identity.updatePeer(policy.peerId, input)
    log.info('operator set peer policy', {
      userId,
      peerId: policy.peerId,
      fields: Object.keys(input),
    })
  }

  async setSecurityQuota(userId: string, quota: StewardSecurityQuota): Promise<void> {
    // `period` arrives free-form from the action (the LLM might say "day"); map the
    // obvious singular forms onto the real enum, then let the store's
    // `assertUsagePeriod` be the authoritative gate for anything still off-enum.
    // `limit` is floored to an integer (quotas are integer counts) — the validator
    // already required it non-negative.
    const period = normalizeUsagePeriod(quota.period)
    const limit = Math.floor(quota.limit)
    // `scope:'hub'` is the HUB-WIDE counter (`setOrgQuota`, no user FK). Any other
    // scope is a per-user quota — `setQuota` FKs into the users table, so a
    // non-existent user fails visibly there (fail-closed), not silently.
    if (quota.scope === HUB_QUOTA_SCOPE) {
      this.identity.setOrgQuota({ metric: quota.metric, period, quota: limit })
    } else {
      this.identity.setQuota({ userId: quota.scope, metric: quota.metric, period, quota: limit })
    }
    log.info('operator set security quota', {
      userId,
      scope: quota.scope,
      metric: quota.metric,
      period: quota.period,
      limit: quota.limit,
    })
  }
}

/**
 * Map common singular period phrasings onto the real `UsagePeriod` enum. Anything
 * not in the map passes through verbatim so `assertUsagePeriod` (in `setQuota`)
 * stays the authoritative gate — this is a thin convenience, never a silent
 * acceptance of an invalid value.
 */
function normalizeUsagePeriod(period: string): UsagePeriod {
  switch (period) {
    case 'hour':
    case 'hourly':
      return 'hourly'
    case 'day':
    case 'daily':
      return 'daily'
    case 'month':
    case 'monthly':
      return 'monthly'
    case 'total':
      return 'total'
    default:
      // Pass through; `setQuota` → `assertUsagePeriod` rejects it (fail-visible).
      return period as UsagePeriod
  }
}
