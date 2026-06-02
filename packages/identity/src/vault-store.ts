/**
 * VaultStore — encrypted application-layer secret storage.
 *
 * Extracted from IdentityStore as the first domain of the R13 god-object
 * split (store.ts was 3.8k lines). IdentityStore now composes a VaultStore
 * and forwards its public vault methods verbatim, so callers see no API
 * change — `store.createVaultEntry(...)` etc. still work. VaultStore is an
 * internal collaborator (not exported from the package index); the single
 * public surface of @aipehub/identity stays IdentityStore.
 *
 * Design notes:
 *   - Distinct from `credentials` (one-way hashed login material).
 *     Vault rows are AES-256-GCM encrypted and CAN be decrypted —
 *     the host re-presents these secrets to upstream services.
 *   - `createVaultEntry` / `readVaultSecret` / `revokeVaultEntry` all
 *     require `masterKey` was supplied at openIdentityStore time;
 *     otherwise they throw `vault_not_configured`. Listing is allowed
 *     without a key because list results omit secret material.
 *   - `revokeVaultEntry` is a soft delete (sets `revoked_at`) — rows
 *     stay queryable for audit. The active hot path filters by
 *     `revoked_at IS NULL`.
 *   - Audit writes belong to the CALLING layer (web / OrgApiPool), not
 *     the store. The store doesn't know who's calling, what surface
 *     authenticated them, or whether the operation is admin-initiated
 *     vs internal — the caller has that context.
 */

import { transactionImmediate, type SqliteDb, type SqliteStmt } from './db.js'
import { newId } from './tokens.js'
import { IdentityError } from './errors.js'
import {
  decryptSecret,
  encryptSecret,
  generateDataKey,
  unwrapDataKey,
  wrapDataKey,
} from './crypto.js'
import {
  OWNER_KINDS,
  VAULT_KINDS,
  type CreateVaultEntryInput,
  type ListVaultEntriesQuery,
  type OwnerKind,
  type VaultEntry,
  type VaultKind,
} from './types.js'

/**
 * Audit #145 — reason tag handed to onVaultMutation subscribers. Fired
 * AFTER a successful create / revoke commits.
 */
export type VaultMutationReason = 'create' | 'revoke'

/**
 * Route B P0-M4b — the vault_meta row that holds the wrapped data key.
 * Versioned in the key so a future DEK format change can coexist.
 */
const VAULT_DEK_META_KEY = 'vault.dek.v1'

interface VaultRow {
  id: string
  kind: string
  owner_kind: string
  owner_id: string | null
  label: string | null
  secret_enc: string
  metadata: string | null
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

export class VaultStore {
  private readonly db: SqliteDb
  /**
   * A1 — present iff the caller passed `masterKey` to openIdentityStore.
   * Vault APIs throw `vault_not_configured` when this is undefined.
   * Kept as a field (not a closure capture) so methods can check it
   * uniformly via a single `requireMasterKey()` helper.
   */
  private readonly masterKey?: Buffer
  /**
   * Route B P0-M4b — the unwrapped data key (DEK), memoised after the
   * first vault operation. Every secret row is encrypted with THIS, not
   * the master key directly; the master key only wraps the DEK. Lazy so a
   * host that never touches the vault never generates one, and so opening
   * the store with a wrong/absent key still succeeds (the failure lands
   * on the first vault call, matching the pre-envelope contract).
   */
  private _dek?: Buffer
  // Vault prepared statements — lazy because they're only allocated for
  // hosts that actually use vault APIs. better-sqlite3's per-db statement
  // cache makes the first prepare ~zero-cost; we just don't want to
  // allocate them on every IdentityStore even when vault is unused.
  private _stmtVaultInsert?: SqliteStmt
  private _stmtVaultById?: SqliteStmt
  private _stmtVaultTouch?: SqliteStmt
  private _stmtVaultRevoke?: SqliteStmt
  private _stmtVaultMetaGet?: SqliteStmt
  private _stmtVaultMetaPut?: SqliteStmt
  private _stmtVaultReEncrypt?: SqliteStmt

  // Audit #145 — vault-mutation subscribers. OrgApiPool / future cache
  // layers subscribe here; the store fires after every successful
  // createVaultEntry / revokeVaultEntry / update so consumers can flush
  // their memoised secrets without polling. Stored as a Set so an
  // unsubscribe call can remove without an index search.
  private readonly vaultMutationListeners = new Set<(reason: VaultMutationReason) => void>()

  constructor(db: SqliteDb, masterKey?: Buffer) {
    this.db = db
    // Stored only when explicitly provided so vault APIs can detect
    // "host didn't configure encryption" vs "wrong key supplied".
    if (masterKey !== undefined) this.masterKey = masterKey
  }

  /**
   * Insert a new vault entry. Returns the row metadata WITHOUT the
   * encrypted blob (list / get use the same shape). The plaintext
   * `secret` is encrypted with the configured master key before
   * touching disk.
   *
   * Validation:
   *   - `kind` and `ownerKind` must be enum members; otherwise
   *     `invalid_input`.
   *   - `ownerKind === 'org'` requires `ownerId` to be null/undefined
   *     (the host is the implicit org owner; explicit ids are rejected
   *     to prevent silent misclassification).
   *   - `ownerKind === 'user' | 'peer'` requires a non-empty `ownerId`.
   *   - `secret` must be a non-empty string. Provider-format validation
   *     is the caller's job (we don't know what `sk-ant-` should look
   *     like for every kind).
   *   - `metadata`, when present, is JSON-stringified and clamped to
   *     8KB (same as audit_log).
   */
  createVaultEntry(input: CreateVaultEntryInput): VaultEntry {
    // requireDek() also enforces the vault_not_configured gate (it calls
    // requireMasterKey internally), so the "no master key" behaviour is
    // unchanged. Secrets are encrypted with the DEK, not the master key.
    const dek = this.requireDek()
    if (!input || typeof input !== 'object') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'createVaultEntry input required',
      })
    }
    if (!isVaultKind(input.kind)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `vault kind must be one of ${VAULT_KINDS.join(', ')}; got ${JSON.stringify(input.kind)}`,
      })
    }
    if (!isOwnerKind(input.ownerKind)) {
      throw new IdentityError({
        code: 'invalid_input',
        message: `vault ownerKind must be one of ${OWNER_KINDS.join(', ')}; got ${JSON.stringify(input.ownerKind)}`,
      })
    }
    // Owner-id shape gate, per the documented contract.
    //
    // Phase 6 #3 (multi-org): ownerKind='org' now accepts either:
    //   - ownerId === null — primary / implicit-host org (legacy).
    //     Single-tenant deployments stay here; nothing changed.
    //   - ownerId === '<orgId>' — specific peer / sub-org. Lets one
    //     host serve multiple orgs by scoping vault rows per orgId.
    //     OrgApiPool instances are constructed with the matching
    //     orgId and only see rows for that scope.
    // ownerKind='user'/'peer' still require non-empty ownerId.
    const ownerId = input.ownerId ?? null
    if (input.ownerKind === 'org') {
      if (ownerId !== null && (typeof ownerId !== 'string' || ownerId.length === 0)) {
        throw new IdentityError({
          code: 'invalid_input',
          message:
            'vault ownerKind=org requires either null ownerId (primary org) or a non-empty orgId string',
        })
      }
    } else {
      if (typeof ownerId !== 'string' || ownerId.length === 0) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `vault ownerKind=${input.ownerKind} requires non-empty ownerId`,
        })
      }
    }
    if (typeof input.secret !== 'string' || input.secret.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'vault secret must be a non-empty string',
      })
    }
    const label = input.label === undefined ? null : input.label
    if (label !== null && typeof label !== 'string') {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'vault label must be a string or null',
      })
    }
    let metadataJson: string | null = null
    let metadataObj: Record<string, unknown> | null = null
    if (input.metadata !== undefined && input.metadata !== null) {
      if (typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
        throw new IdentityError({
          code: 'invalid_input',
          message: 'vault metadata must be a plain object or null',
        })
      }
      try {
        metadataJson = JSON.stringify(input.metadata)
      } catch (err) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `vault metadata not JSON-serialisable: ${(err as Error).message}`,
          cause: err,
        })
      }
      if (metadataJson.length > 8192) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `vault metadata too large (max 8KB serialised); got ${metadataJson.length}`,
        })
      }
      metadataObj = input.metadata
    }

    const id = newId()
    const now = Date.now()
    const secretEnc = encryptSecret(dek, input.secret)
    this.stmtVaultInsert.run(
      id,
      input.kind,
      input.ownerKind,
      ownerId,
      label,
      secretEnc,
      metadataJson,
      now,
    )
    // Audit #145 — let cache layers (OrgApiPool) invalidate.
    this.emitVaultMutation('create')
    return {
      id,
      kind: input.kind,
      ownerKind: input.ownerKind,
      ownerId,
      label,
      metadata: metadataObj,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    }
  }

  /** Lookup by id. Returns null on missing id. Includes revoked rows. */
  getVaultEntry(id: string): VaultEntry | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const row = this.stmtVaultById.get(id) as VaultRow | undefined
    return row ? rowToVaultEntry(row) : null
  }

  /**
   * Read + decrypt the plaintext secret. Side-effect: touches
   * `last_used_at`. Throws:
   *   - `vault_not_configured` if no master key was supplied at open
   *   - `vault_entry_not_found` if no row matches
   *   - `vault_entry_not_found` if the row is soft-revoked (we refuse to
   *     hand out revoked secrets — callers needing forensics should use
   *     `getVaultEntry` + admin-level intent)
   *   - `vault_decrypt_failed` if the master key doesn't match the
   *     row's ciphertext
   */
  readVaultSecret(id: string): string {
    const dek = this.requireDek()
    if (typeof id !== 'string' || id.length === 0) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: 'vault entry id required',
      })
    }
    const row = this.stmtVaultById.get(id) as VaultRow | undefined
    if (!row) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: `vault entry not found: ${id}`,
      })
    }
    if (row.revoked_at !== null) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: `vault entry revoked: ${id}`,
      })
    }
    const plaintext = decryptSecret(dek, row.secret_enc)
    this.stmtVaultTouch.run(Date.now(), id)
    return plaintext
  }

  /**
   * Soft-delete a vault entry (sets `revoked_at`). Idempotent: a
   * second call on an already-revoked id is a no-op.
   *
   * Returns `true` when this call performed the revoke (the row was
   * active going in), `false` when it was already revoked (idempotent
   * no-op). Audit #157 — callers that emit a side-effect audit row
   * use the return value to dedup so N concurrent calls produce 1
   * audit row, not N.
   */
  revokeVaultEntry(id: string): boolean {
    if (typeof id !== 'string' || id.length === 0) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: 'vault entry id required',
      })
    }
    const existing = this.stmtVaultById.get(id) as VaultRow | undefined
    if (!existing) {
      throw new IdentityError({
        code: 'vault_entry_not_found',
        message: `vault entry not found: ${id}`,
      })
    }
    if (existing.revoked_at !== null) return false // already revoked
    this.stmtVaultRevoke.run(Date.now(), id)
    // Audit #145 — flush cached resolves of this entry.
    this.emitVaultMutation('revoke')
    return true
  }

  /**
   * Filterable listing. Does NOT decrypt — secret material never leaves
   * the store via list paths. The result rows let the caller decide
   * which id to feed into `readVaultSecret`.
   */
  listVaultEntries(query: ListVaultEntriesQuery = {}): VaultEntry[] {
    const limit = Math.max(1, Math.min(500, query.limit ?? 100))
    const offset = Math.max(0, query.offset ?? 0)
    const activeOnly = query.activeOnly !== false
    const where: string[] = []
    const params: (string | number | null)[] = []
    if (query.kind !== undefined) {
      if (!isVaultKind(query.kind)) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `listVaultEntries: invalid kind filter: ${JSON.stringify(query.kind)}`,
        })
      }
      where.push('kind = ?')
      params.push(query.kind)
    }
    if (query.ownerKind !== undefined) {
      if (!isOwnerKind(query.ownerKind)) {
        throw new IdentityError({
          code: 'invalid_input',
          message: `listVaultEntries: invalid ownerKind filter: ${JSON.stringify(query.ownerKind)}`,
        })
      }
      where.push('owner_kind = ?')
      params.push(query.ownerKind)
    }
    // ownerId filter — `null` is a legitimate match value (it queries
    // org-owned rows), so we check for explicit presence in the input.
    if ('ownerId' in query) {
      if (query.ownerId === null) {
        where.push('owner_id IS NULL')
      } else if (typeof query.ownerId === 'string' && query.ownerId.length > 0) {
        where.push('owner_id = ?')
        params.push(query.ownerId)
      } else if (query.ownerId !== undefined) {
        throw new IdentityError({
          code: 'invalid_input',
          message: 'listVaultEntries: ownerId must be a non-empty string or null',
        })
      }
    }
    if (activeOnly) {
      where.push('revoked_at IS NULL')
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    // rowid tie-breaker — see listAuditLog for the rationale.
    const sql = `SELECT * FROM vault ${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
    params.push(limit, offset)
    const rows = this.db.prepare(sql).all(...params) as VaultRow[]
    return rows.map(rowToVaultEntry)
  }

  /**
   * Audit #145 — subscribe to vault mutations. Returns an unsubscribe
   * function. Fired AFTER a successful create / revoke commits, so
   * subscribers may read fresh state.
   *
   * Use case: OrgApiPool subscribes here to flush its memoised
   * resolveLlmKey cache the instant an admin rotates a key in vault.
   * Before this hook the cache stayed stale until the next 401 (or
   * never, if the rotated key never produced a 401).
   *
   * Listeners run synchronously; throwing from a listener is caught
   * and silenced (their bugs shouldn't break the vault write that
   * just happened). For ordered side effects, sequence them inside
   * one listener instead of subscribing twice.
   */
  onVaultMutation(fn: (reason: VaultMutationReason) => void): () => void {
    if (typeof fn !== 'function') {
      throw new TypeError('onVaultMutation requires a function')
    }
    this.vaultMutationListeners.add(fn)
    return () => {
      this.vaultMutationListeners.delete(fn)
    }
  }

  private emitVaultMutation(reason: VaultMutationReason): void {
    for (const fn of this.vaultMutationListeners) {
      try {
        fn(reason)
      } catch {
        // Audit #145 — listener bugs are non-fatal. The vault write
        // already committed; one consumer's cache being stale is far
        // less bad than throwing back to the caller and leaving them
        // thinking the vault write failed when it didn't.
      }
    }
  }

  // ---- Vault internal helpers ----

  private requireMasterKey(): Buffer {
    if (!this.masterKey) {
      throw new IdentityError({
        code: 'vault_not_configured',
        message:
          'vault requires `masterKey` at openIdentityStore time; vault APIs are disabled until configured',
      })
    }
    return this.masterKey
  }

  /**
   * Route B P0-M4b — resolve the data key (DEK) used to encrypt secrets,
   * memoising it for the process lifetime.
   *
   *   - Fast path: a wrapped DEK already exists in vault_meta → unwrap it
   *     with the master key (KEK). A wrong KEK throws `vault_decrypt_failed`
   *     here, which is why reopening with the wrong key still fails on the
   *     first vault call (just at unwrap instead of per-row decrypt).
   *   - First run after the envelope upgrade: generate a DEK, re-encrypt
   *     any pre-envelope (legacy KEK-direct) rows under it, and persist the
   *     wrapped DEK — all inside one IMMEDIATE transaction, so a crash (or a
   *     second process racing the seed) can never leave half-migrated rows
   *     with no marker. `wrapDataKey` runs before the transaction so a
   *     wrong-length KEK fails before any row is touched.
   */
  private requireDek(): Buffer {
    if (this._dek) return this._dek
    const kek = this.requireMasterKey()
    const existing = this.stmtVaultMetaGet.get(VAULT_DEK_META_KEY) as
      | { value: string }
      | undefined
    if (existing) {
      this._dek = unwrapDataKey(kek, existing.value)
      return this._dek
    }
    const dek = generateDataKey()
    const wrapped = wrapDataKey(kek, dek)
    const seed = (): Buffer => {
      // Re-check under the write lock — another process may have seeded the
      // DEK between our read above and acquiring the lock. If so, adopt its
      // DEK (the rows it migrated are under that key), not our throwaway one.
      const raced = this.stmtVaultMetaGet.get(VAULT_DEK_META_KEY) as
        | { value: string }
        | undefined
      if (raced) return unwrapDataKey(kek, raced.value)
      // Rows present here predate the envelope, so they're KEK-encrypted.
      // Re-encrypt each under the DEK. A fresh vault has none → empty loop.
      const rows = this.db
        .prepare('SELECT id, secret_enc FROM vault')
        .all() as { id: string; secret_enc: string }[]
      for (const r of rows) {
        const plaintext = decryptSecret(kek, r.secret_enc)
        this.stmtVaultReEncrypt.run(encryptSecret(dek, plaintext), r.id)
      }
      this.stmtVaultMetaPut.run(VAULT_DEK_META_KEY, wrapped, Date.now())
      return dek
    }
    // The seed (migrate + persist) must be atomic. If the caller already
    // opened a transaction — addPeer wraps its vault write + peer write in
    // one — nesting BEGIN IMMEDIATE would throw "transaction within a
    // transaction", so reuse the caller's (already-atomic) transaction.
    // Otherwise open our own IMMEDIATE one.
    this._dek = this.db.inTransaction ? seed() : transactionImmediate(this.db, seed)
    return this._dek
  }

  private get stmtVaultInsert(): SqliteStmt {
    return (this._stmtVaultInsert ??= this.db.prepare(
      `INSERT INTO vault(
         id, kind, owner_kind, owner_id, label, secret_enc, metadata,
         created_at, last_used_at, revoked_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ))
  }
  private get stmtVaultById(): SqliteStmt {
    return (this._stmtVaultById ??= this.db.prepare(
      'SELECT * FROM vault WHERE id = ?',
    ))
  }
  private get stmtVaultTouch(): SqliteStmt {
    return (this._stmtVaultTouch ??= this.db.prepare(
      'UPDATE vault SET last_used_at = ? WHERE id = ?',
    ))
  }
  private get stmtVaultRevoke(): SqliteStmt {
    return (this._stmtVaultRevoke ??= this.db.prepare(
      'UPDATE vault SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ))
  }
  // Route B P0-M4b — vault_meta access for the wrapped data key.
  private get stmtVaultMetaGet(): SqliteStmt {
    return (this._stmtVaultMetaGet ??= this.db.prepare(
      'SELECT value FROM vault_meta WHERE key = ?',
    ))
  }
  private get stmtVaultMetaPut(): SqliteStmt {
    return (this._stmtVaultMetaPut ??= this.db.prepare(
      `INSERT INTO vault_meta(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ))
  }
  private get stmtVaultReEncrypt(): SqliteStmt {
    return (this._stmtVaultReEncrypt ??= this.db.prepare(
      'UPDATE vault SET secret_enc = ? WHERE id = ?',
    ))
  }
}

// ---- Module-private vault helpers (pure functions, kept out of class) ----

function isVaultKind(s: unknown): s is VaultKind {
  return typeof s === 'string' && (VAULT_KINDS as readonly string[]).includes(s)
}
function isOwnerKind(s: unknown): s is OwnerKind {
  return typeof s === 'string' && (OWNER_KINDS as readonly string[]).includes(s)
}

function rowToVaultEntry(r: VaultRow): VaultEntry {
  let metadata: Record<string, unknown> | null = null
  if (r.metadata) {
    try {
      const parsed: unknown = JSON.parse(r.metadata)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      }
    } catch {
      metadata = { _corrupt: r.metadata }
    }
  }
  // Graceful fallback on db corruption (manual edit): clamp unknown
  // strings to the closest valid enum so the row stays visible in the
  // admin UI rather than crashing the list endpoint.
  const kind = isVaultKind(r.kind) ? r.kind : ('third_party_api' as VaultKind)
  const ownerKind = isOwnerKind(r.owner_kind)
    ? r.owner_kind
    : ('org' as OwnerKind)
  return {
    id: r.id,
    kind,
    ownerKind,
    ownerId: r.owner_id,
    label: r.label,
    metadata,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }
}
