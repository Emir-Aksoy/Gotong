/**
 * HostMeCredentialsService — v5 A-M3. Backs `/api/me/credentials` so a member
 * can manage THEIR OWN LLM API keys ("bring your own key"). Keys live in the
 * identity vault with `ownerKind='user'` / `ownerId=<caller>` and are consumed
 * by that member's own agents (A-M2) through the per-user fallback the
 * OrgApiPool grew in A-M3a (org key primary, member key the fallback).
 *
 * Why a member needs this: in a team hub the owner may not configure an org key
 * for every provider a member wants to experiment with; in a personal hub the
 * single user simply owns their own keys. Either way the secret is the member's
 * to hold — never the org's, never another member's.
 *
 * The constrained door (mirrors HostMeAgentService):
 *   - the vault row is HOST-written with ownerId = the SESSION userId — a member
 *     can't store a key under someone else's account;
 *   - delete is gated on "this row is YOUR llm_provider key" → 404 (not 403) if
 *     not, so a member can't enumerate org keys / other members' key ids;
 *   - only providers a member can bring a RAW key for are accepted (anthropic /
 *     openai). `mock` needs no key; `openai-compatible` needs a baseURL, which
 *     is operator infra, not a member secret.
 *
 * The secret is NEVER returned — list/create project metadata only. Cache
 * coherence is automatic: createVaultEntry / revokeVaultEntry fire the
 * IdentityStore vault-mutation hook the OrgApiPool already subscribes to, so a
 * member rotating their key flushes the resolved-key cache with no extra wiring.
 */

import { createLogger } from '@aipehub/core'
import type { VaultEntry, WriteAuditLogInput } from '@aipehub/identity'
import { AUDIT_ACTIONS } from '@aipehub/identity'
import type { WebServerOptions } from '@aipehub/web'

const log = createLogger('me-credentials')

// Derive the surface contract from the web opts — single source of truth, no
// re-export needed (same pattern as HostMeAgentService).
type MeCredentialsSurface = NonNullable<WebServerOptions['meCredentials']>
type MeCredentialView = Awaited<ReturnType<MeCredentialsSurface['list']>>[number]
type MeCredentialInput = Parameters<MeCredentialsSurface['create']>[1]

/** The narrow slice of IdentityStore this service needs (real store satisfies). */
export interface MeCredentialVaultStore {
  createVaultEntry(input: {
    kind: 'llm_provider'
    ownerKind: 'user'
    ownerId: string
    secret: string
    label?: string | null
    metadata?: Record<string, unknown> | null
  }): VaultEntry
  listVaultEntries(query: {
    kind?: 'llm_provider'
    ownerKind?: 'user'
    ownerId?: string | null
    activeOnly?: boolean
  }): VaultEntry[]
  getVaultEntry(id: string): VaultEntry | null
  revokeVaultEntry(id: string): boolean
  writeAuditLog?(input: WriteAuditLogInput): unknown
}

/**
 * Providers a member may store a RAW api key for. Deliberately narrow: these
 * are the two first-party providers whose key is a single bearer string. New
 * BYO providers join here as the per-user fallback path supports them.
 */
const MEMBER_CREDENTIAL_PROVIDERS = new Set(['anthropic', 'openai'])

export interface HostMeCredentialsServiceOpts {
  identity: MeCredentialVaultStore
}

export class HostMeCredentialsService implements MeCredentialsSurface {
  private readonly identity: MeCredentialVaultStore

  constructor(opts: HostMeCredentialsServiceOpts) {
    this.identity = opts.identity
  }

  async providers(): Promise<string[]> {
    return [...MEMBER_CREDENTIAL_PROVIDERS]
  }

  async list(userId: string): Promise<MeCredentialView[]> {
    return this.identity
      .listVaultEntries({
        kind: 'llm_provider',
        ownerKind: 'user',
        ownerId: userId,
        activeOnly: true,
      })
      .map(projectCredential)
  }

  async create(userId: string, input: MeCredentialInput): Promise<MeCredentialView> {
    const provider = this.assertProvider(input.provider)
    const entry = this.identity.createVaultEntry({
      kind: 'llm_provider',
      ownerKind: 'user',
      ownerId: userId,
      secret: input.apiKey,
      label: input.label ?? null,
      metadata: { provider },
    })
    this.audit(userId, AUDIT_ACTIONS.VAULT_CREATE, entry.id, provider)
    log.info('member stored credential', { userId, provider, entryId: entry.id })
    return projectCredential(entry)
  }

  async remove(userId: string, credentialId: string): Promise<boolean> {
    const entry = this.identity.getVaultEntry(credentialId)
    // 404 (not 403) unless this is the caller's OWN llm_provider key — never
    // reveal that some other id (an org key, another member's key) exists.
    if (
      !entry ||
      entry.kind !== 'llm_provider' ||
      entry.ownerKind !== 'user' ||
      entry.ownerId !== userId
    ) {
      throw httpError(404, 'credential not found')
    }
    const removed = this.identity.revokeVaultEntry(credentialId)
    if (removed) this.audit(userId, AUDIT_ACTIONS.VAULT_REVOKE, credentialId, readProvider(entry))
    log.info('member revoked credential', { userId, credentialId, removed })
    return removed
  }

  // -- internals ----------------------------------------------------------

  private assertProvider(provider: string): string {
    if (!MEMBER_CREDENTIAL_PROVIDERS.has(provider)) {
      throw httpError(400, `provider must be one of ${[...MEMBER_CREDENTIAL_PROVIDERS].join(', ')}`)
    }
    return provider
  }

  /** Best-effort audit — a fault here never blocks the credential mutation. */
  private audit(userId: string, action: string, vaultEntryId: string, provider: string): void {
    if (typeof this.identity.writeAuditLog !== 'function') return
    try {
      this.identity.writeAuditLog({
        action,
        // Member acted through their /me session (same as HostInboxService).
        actorSource: 'v4-session',
        actorUserId: userId,
        targetUserId: userId,
        metadata: { ownerScope: 'user', provider, vaultEntryId },
      })
    } catch (err) {
      log.warn('credential audit write failed', { userId, action, err })
    }
  }
}

// -- helpers --------------------------------------------------------------

function projectCredential(e: VaultEntry): MeCredentialView {
  return {
    id: e.id,
    provider: readProvider(e),
    label: e.label,
    createdAt: e.createdAt,
    lastUsedAt: e.lastUsedAt,
  }
}

function readProvider(e: VaultEntry): string {
  const m = e.metadata
  if (m && typeof m === 'object') {
    const p = (m as Record<string, unknown>).provider
    if (typeof p === 'string') return p
  }
  return ''
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}
