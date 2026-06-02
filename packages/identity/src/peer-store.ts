/**
 * PeerStore — federation peer registry (D1, v4 Phase 5).
 *
 * Extracted from IdentityStore as the third domain of the R13 god-object
 * split. CRUD for the `peers` table + token decryption helper. The shared
 * HELLO secret lives in `vault` (kind='peer_token', ownerKind='peer');
 * peers.vault_entry_id holds the soft FK. Token rotation is atomic:
 * updatePeer({peerToken}) revokes the old vault row and creates a fresh
 * one inside one transaction, so a partial failure can't leave the peer
 * row pointing at a revoked entry.
 *
 * Cross-domain dependency: PeerStore composes the VaultStore (injected by
 * IdentityStore at construction) for token storage — a clean demonstration
 * that the per-domain stores compose. Both share the same `db`, so a
 * vault write + peer write inside one `transaction(db, ...)` stay atomic.
 *
 * PeerRegistration is the projection the host's PeerRegistry reads on every
 * 5s tick; getPeerToken() is the slow-path decrypt call it makes lazily
 * when connecting a fresh outbound HubLink.
 */

import { type SqliteDb, type SqliteStmt, transaction } from './db.js'
import { newId } from './tokens.js'
import { IdentityError } from './errors.js'
import type { VaultStore } from './vault-store.js'
import {
  type AddPeerInput,
  type ListPeersQuery,
  type PeerInboundAcl,
  type PeerKind,
  type PeerRegistration,
  type PeerRevocationState,
  type UpdatePeerInput,
} from './types.js'

interface PeerRow {
  id: string
  peer_id: string
  endpoint_url: string
  label: string | null
  enabled: number
  vault_entry_id: string
  created_at: number
  updated_at: number
  // Phase 18 B-M1 — cross-org policy columns (schema v12).
  kind: string
  acl_json: string | null
  outbound_caps_json: string | null
  require_approval_outbound: number
  // Phase 19 P4-M4 — per-link trust contract columns (schema v15).
  revocation_state: string
  per_link_quota_budget: number | null
  allowed_data_classes_json: string | null
  // v5 C-M1 — callable-knowledge-base allowlist (schema v17).
  allowed_knowledge_bases_json: string | null
}

export class PeerStore {
  private readonly db: SqliteDb
  private readonly vault: VaultStore
  // Lazy for the same reason as vault (hosts without federation don't
  // allocate these prepared statements).
  private _stmtPeerInsert?: SqliteStmt
  private _stmtPeerById?: SqliteStmt
  private _stmtPeerByPeerId?: SqliteStmt
  private _stmtPeerListAll?: SqliteStmt
  private _stmtPeerListEnabled?: SqliteStmt
  private _stmtPeerUpdate?: SqliteStmt
  private _stmtPeerDelete?: SqliteStmt

  constructor(db: SqliteDb, vault: VaultStore) {
    this.db = db
    this.vault = vault
  }

  /**
   * Add a peer registration. Stores `peerToken` encrypted in vault and
   * inserts the peers row in one transaction. Throws `peer_id_taken`
   * when another row already uses the same `peerId` (the SQLite UNIQUE
   * constraint on `peer_id`).
   *
   * Caller is the only one with the plaintext token after this call —
   * subsequent reads via getPeer / listPeers do NOT return it. To
   * recover the token on demand (PeerRegistry connecting an outbound
   * link), call `getPeerToken(peerRowId)`.
   */
  addPeer(input: AddPeerInput): PeerRegistration {
    assertNonEmptyId(input?.peerId, 'peerId')
    if (typeof input?.endpointUrl !== 'string' || input.endpointUrl.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'addPeer: endpointUrl must be a non-empty string',
      })
    }
    if (typeof input?.peerToken !== 'string' || input.peerToken.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'addPeer: peerToken must be a non-empty string',
      })
    }
    return transaction(this.db, () => {
      const vaultRow = this.vault.createVaultEntry({
        kind: 'peer_token',
        ownerKind: 'peer',
        ownerId: input.peerId,
        secret: input.peerToken,
        ...(input.label ? { label: input.label } : {}),
      })
      const id = newId()
      const now = Date.now()
      try {
        this.stmtPeerInsert.run(
          id,
          input.peerId,
          input.endpointUrl,
          input.label ?? null,
          1,
          vaultRow.id,
          now,
          now,
          // Phase 18 B-M1 policy — omitted fields fall back to the same
          // values the v12 column DEFAULTs would give an un-migrated row.
          input.kind ?? 'service',
          input.acl != null ? JSON.stringify(input.acl) : null,
          input.outboundCaps != null ? JSON.stringify(input.outboundCaps) : null,
          input.requireApprovalOutbound ? 1 : 0,
          // Phase 19 P4-M4 — per-link contract; omitted → v15 column defaults.
          input.revocationState ?? 'active',
          input.perLinkQuotaBudget ?? null,
          input.allowedDataClasses != null
            ? JSON.stringify(input.allowedDataClasses)
            : null,
          // v5 C-M1 — callable-KB allowlist; omitted → NULL = every shared KB.
          input.allowedKnowledgeBases != null
            ? JSON.stringify(input.allowedKnowledgeBases)
            : null,
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/UNIQUE.*peer_id/i.test(msg)) {
          throw new IdentityError({
            code: 'peer_id_taken',
            message: `addPeer: peerId '${input.peerId}' already registered`,
          })
        }
        throw err
      }
      const row = this.stmtPeerById.get(id) as PeerRow
      return rowToPeerRegistration(row)
    })
  }

  getPeer(id: string): PeerRegistration | null {
    const row = this.stmtPeerById.get(id) as PeerRow | undefined
    return row ? rowToPeerRegistration(row) : null
  }

  getPeerByPeerId(peerId: string): PeerRegistration | null {
    const row = this.stmtPeerByPeerId.get(peerId) as PeerRow | undefined
    return row ? rowToPeerRegistration(row) : null
  }

  listPeers(query: ListPeersQuery = {}): PeerRegistration[] {
    const rows = (query.enabledOnly
      ? this.stmtPeerListEnabled.all()
      : this.stmtPeerListAll.all()) as PeerRow[]
    return rows.map(rowToPeerRegistration)
  }

  /**
   * Update mutable fields on a peer row. If `peerToken` is provided,
   * revokes the old vault entry and creates a fresh one — the row's
   * `vaultEntryId` is updated to the new entry inside the same
   * transaction. Returns the updated row. Throws `peer_not_found` if
   * the row vanished mid-call.
   */
  updatePeer(id: string, input: UpdatePeerInput): PeerRegistration {
    const existing = this.stmtPeerById.get(id) as PeerRow | undefined
    if (!existing) {
      throw new IdentityError({
        code: 'peer_not_found',
        message: `updatePeer: no peer row with id '${id}'`,
      })
    }
    return transaction(this.db, () => {
      let vaultEntryId = existing.vault_entry_id
      if (typeof input.peerToken === 'string' && input.peerToken.length > 0) {
        // Rotate: revoke old, create fresh. The old row stays in vault
        // (soft-delete) so an audit trail of "this token was active
        // from X to Y" survives.
        this.vault.revokeVaultEntry(existing.vault_entry_id)
        const fresh = this.vault.createVaultEntry({
          kind: 'peer_token',
          ownerKind: 'peer',
          ownerId: existing.peer_id,
          secret: input.peerToken,
          ...(existing.label ? { label: existing.label } : {}),
        })
        vaultEntryId = fresh.id
      }
      const label =
        input.label !== undefined ? input.label : existing.label
      const enabled =
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled
      const endpointUrl =
        typeof input.endpointUrl === 'string' && input.endpointUrl.length > 0
          ? input.endpointUrl
          : existing.endpoint_url
      // Phase 18 B-M1 policy fields — undefined preserves the stored value;
      // for acl / outboundCaps an explicit null CLEARS it (back to
      // accept-all / send-all), which is why we test `!== undefined`
      // rather than truthiness.
      const kind = input.kind !== undefined ? input.kind : existing.kind
      const aclJson =
        input.acl !== undefined
          ? input.acl === null
            ? null
            : JSON.stringify(input.acl)
          : existing.acl_json
      const outboundCapsJson =
        input.outboundCaps !== undefined
          ? input.outboundCaps === null
            ? null
            : JSON.stringify(input.outboundCaps)
          : existing.outbound_caps_json
      const requireApprovalOutbound =
        input.requireApprovalOutbound !== undefined
          ? input.requireApprovalOutbound
            ? 1
            : 0
          : existing.require_approval_outbound
      // Phase 19 P4-M4 — per-link contract. undefined preserves; explicit null
      // on quota / data-classes clears (unlimited / all-allowed). revocationState
      // has no null — omit to preserve, pass 'active'/'revoked' to set.
      const revocationState =
        input.revocationState !== undefined
          ? input.revocationState
          : existing.revocation_state
      const perLinkQuotaBudget =
        input.perLinkQuotaBudget !== undefined
          ? input.perLinkQuotaBudget
          : existing.per_link_quota_budget
      const allowedDataClassesJson =
        input.allowedDataClasses !== undefined
          ? input.allowedDataClasses === null
            ? null
            : JSON.stringify(input.allowedDataClasses)
          : existing.allowed_data_classes_json
      // v5 C-M1 — same undefined-preserve / null-clear contract as data classes.
      const allowedKnowledgeBasesJson =
        input.allowedKnowledgeBases !== undefined
          ? input.allowedKnowledgeBases === null
            ? null
            : JSON.stringify(input.allowedKnowledgeBases)
          : existing.allowed_knowledge_bases_json
      this.stmtPeerUpdate.run(
        endpointUrl,
        label,
        enabled,
        vaultEntryId,
        kind,
        aclJson,
        outboundCapsJson,
        requireApprovalOutbound,
        revocationState,
        perLinkQuotaBudget,
        allowedDataClassesJson,
        allowedKnowledgeBasesJson,
        Date.now(),
        id,
      )
      const row = this.stmtPeerById.get(id) as PeerRow
      return rowToPeerRegistration(row)
    })
  }

  /**
   * Hard-delete the peer row AND revoke its vault entry. After this,
   * the (peerId, endpoint) pair is free for re-registration.
   * Returns true if a row was actually removed, false if id was unknown.
   */
  removePeer(id: string): boolean {
    const existing = this.stmtPeerById.get(id) as PeerRow | undefined
    if (!existing) return false
    transaction(this.db, () => {
      this.vault.revokeVaultEntry(existing.vault_entry_id)
      this.stmtPeerDelete.run(id)
    })
    return true
  }

  /**
   * Decrypt and return the peer's shared HELLO secret. Throws
   * `peer_not_found` if the row vanished. Returns the plaintext —
   * caller must not log it.
   */
  getPeerToken(id: string): string {
    const existing = this.stmtPeerById.get(id) as PeerRow | undefined
    if (!existing) {
      throw new IdentityError({
        code: 'peer_not_found',
        message: `getPeerToken: no peer row with id '${id}'`,
      })
    }
    return this.vault.readVaultSecret(existing.vault_entry_id)
  }

  // ---- Peer prepared statement getters (lazy, mirrors vault) ----

  private get stmtPeerInsert(): SqliteStmt {
    return (this._stmtPeerInsert ??= this.db.prepare(
      `INSERT INTO peers(
         id, peer_id, endpoint_url, label, enabled, vault_entry_id,
         created_at, updated_at,
         kind, acl_json, outbound_caps_json, require_approval_outbound,
         revocation_state, per_link_quota_budget, allowed_data_classes_json,
         allowed_knowledge_bases_json
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ))
  }
  private get stmtPeerById(): SqliteStmt {
    return (this._stmtPeerById ??= this.db.prepare(
      'SELECT * FROM peers WHERE id = ?',
    ))
  }
  private get stmtPeerByPeerId(): SqliteStmt {
    return (this._stmtPeerByPeerId ??= this.db.prepare(
      'SELECT * FROM peers WHERE peer_id = ?',
    ))
  }
  private get stmtPeerListAll(): SqliteStmt {
    return (this._stmtPeerListAll ??= this.db.prepare(
      'SELECT * FROM peers ORDER BY created_at',
    ))
  }
  private get stmtPeerListEnabled(): SqliteStmt {
    return (this._stmtPeerListEnabled ??= this.db.prepare(
      'SELECT * FROM peers WHERE enabled = 1 ORDER BY created_at',
    ))
  }
  private get stmtPeerUpdate(): SqliteStmt {
    return (this._stmtPeerUpdate ??= this.db.prepare(
      `UPDATE peers
         SET endpoint_url = ?, label = ?, enabled = ?, vault_entry_id = ?,
             kind = ?, acl_json = ?, outbound_caps_json = ?,
             require_approval_outbound = ?,
             revocation_state = ?, per_link_quota_budget = ?,
             allowed_data_classes_json = ?, allowed_knowledge_bases_json = ?,
             updated_at = ?
       WHERE id = ?`,
    ))
  }
  private get stmtPeerDelete(): SqliteStmt {
    return (this._stmtPeerDelete ??= this.db.prepare(
      'DELETE FROM peers WHERE id = ?',
    ))
  }
}

// ---- D1 — peer registry helpers ----

// Local copy of the shared id guard (the IdentityStore facade keeps its
// own for the quota domain). Trivial + stable, so the duplication won't
// drift; keeping it here lets PeerStore stay self-contained instead of
// importing back from the facade.
function assertNonEmptyId(id: unknown, label: string): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `${label} must be a non-empty string`,
    })
  }
}

function rowToPeerRegistration(r: PeerRow): PeerRegistration {
  return {
    id: r.id,
    peerId: r.peer_id,
    endpointUrl: r.endpoint_url,
    label: r.label,
    enabled: r.enabled !== 0,
    vaultEntryId: r.vault_entry_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Phase 18 B-M1 policy projection.
    kind: ((r.kind as PeerKind) || 'service'),
    acl: parsePolicyJson<PeerInboundAcl>(r.acl_json),
    outboundCaps: parsePolicyJson<string[]>(r.outbound_caps_json),
    requireApprovalOutbound: r.require_approval_outbound !== 0,
    // Phase 19 P4-M4 per-link contract projection.
    revocationState: r.revocation_state === 'revoked' ? 'revoked' : 'active',
    perLinkQuotaBudget:
      typeof r.per_link_quota_budget === 'number' ? r.per_link_quota_budget : null,
    allowedDataClasses: parsePolicyJson<string[]>(r.allowed_data_classes_json),
    // v5 C-M1 callable-KB allowlist projection.
    allowedKnowledgeBases: parsePolicyJson<string[]>(r.allowed_knowledge_bases_json),
  }
}

/**
 * Parse a stored policy JSON column. Corrupt JSON degrades to null — the
 * same accept-all / send-all default a NULL column carries — instead of
 * throwing, so one hand-mangled row can't break the whole peer-list load
 * (same "don't let a bad row poison the read" rule as the suspended-task
 * corrupt-json drop). We only ever write these via JSON.stringify, so
 * corruption means external DB tampering, against which this buys
 * resilience, not security (the tamperer could just store NULL anyway).
 */
function parsePolicyJson<T>(raw: string | null): T | null {
  if (raw == null) return null
  try {
    const v = JSON.parse(raw)
    return v == null ? null : (v as T)
  } catch {
    return null
  }
}
