/**
 * OidcProviderStore — Route B P1-M4d, the OIDC identity-provider registry.
 *
 * The hub is a Relying Party; this stores the IdP registrations it accepts SSO
 * from. Splits "the config" from "the secret" exactly like TotpStore (M3b):
 *   - The confidential `client_secret` lives as a VAULT ENTRY (kind
 *     'oidc_client_secret', ownerKind 'org' — the hub owns its own IdP
 *     registration). Reusing the vault means the DEK envelope encrypts it at
 *     rest and a master-key rotation (P0-M4c) re-wraps it for free; we never
 *     invented a second secret store to keep in sync.
 *   - The `oidc_providers` row holds only the non-secret config + a `vault_id`
 *     pointer. A PUBLIC (PKCE-only) client has no secret and thus no vault
 *     entry (vault_id NULL) — so a hub WITHOUT a configured master key can
 *     still register a public IdP.
 *
 * The public projection (`OidcProvider`) NEVER carries the secret. The token
 * exchange reads it on demand via `readClientSecret(id)` — the one method that
 * touches plaintext, and only the host's OIDC callback calls it.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import { newId } from './tokens.js'
import type {
  AddOidcProviderInput,
  OidcProvider,
  UpdateOidcProviderInput,
  VaultEntry,
} from './types.js'

/** The narrow slice of the vault facade this store needs (injected). */
export interface OidcProviderVaultOps {
  createVaultEntry(input: {
    kind: 'oidc_client_secret'
    ownerKind: 'org'
    ownerId?: null
    secret: string
    label?: string
  }): VaultEntry
  readVaultSecret(id: string): string
  revokeVaultEntry(id: string): boolean
}

interface OidcProviderRow {
  id: string
  issuer: string
  client_id: string
  redirect_uri: string
  scope: string | null
  vault_id: string | null
  enabled: number
  label: string | null
  created_at: number
  updated_at: number
}

function rowToProvider(r: OidcProviderRow): OidcProvider {
  return {
    id: r.id,
    issuer: r.issuer,
    clientId: r.client_id,
    redirectUri: r.redirect_uri,
    scope: r.scope ?? null,
    enabled: r.enabled === 1,
    label: r.label ?? null,
    hasClientSecret: typeof r.vault_id === 'string' && r.vault_id.length > 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Trim + reject empty; issuer/client_id/redirect_uri are all mandatory. */
function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `oidc provider ${field} must be a non-empty string`,
    })
  }
  return value.trim()
}

function normScope(scope: string | null | undefined): string | null {
  if (scope == null) return null
  const t = scope.trim()
  return t.length > 0 ? t : null
}

export class OidcProviderStore {
  private readonly stmtInsert: SqliteStmt
  private readonly stmtById: SqliteStmt
  private readonly stmtByIssuer: SqliteStmt
  private readonly stmtList: SqliteStmt
  private readonly stmtUpdate: SqliteStmt
  private readonly stmtDelete: SqliteStmt

  constructor(
    private readonly db: SqliteDb,
    private readonly vault: OidcProviderVaultOps,
  ) {
    this.stmtInsert = db.prepare(
      `INSERT INTO oidc_providers
         (id, issuer, client_id, redirect_uri, scope, vault_id, enabled, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM oidc_providers WHERE id = ?')
    this.stmtByIssuer = db.prepare('SELECT * FROM oidc_providers WHERE issuer = ?')
    this.stmtList = db.prepare('SELECT * FROM oidc_providers ORDER BY created_at ASC')
    this.stmtUpdate = db.prepare(
      `UPDATE oidc_providers
         SET client_id = ?, redirect_uri = ?, scope = ?, vault_id = ?, enabled = ?, label = ?, updated_at = ?
         WHERE id = ?`,
    )
    this.stmtDelete = db.prepare('DELETE FROM oidc_providers WHERE id = ?')
  }

  private rowById(id: string): OidcProviderRow | undefined {
    return this.stmtById.get(id) as OidcProviderRow | undefined
  }

  /**
   * Register an IdP. If a confidential `clientSecret` is given it is stored in
   * the vault first; the row only ever holds the pointer. A duplicate issuer
   * throws `oidc_provider_exists` — and we revoke the just-created vault entry
   * so a rejected insert leaves no orphan secret.
   */
  add(input: AddOidcProviderInput): OidcProvider {
    const issuer = requireNonEmpty(input.issuer, 'issuer')
    const clientId = requireNonEmpty(input.clientId, 'clientId')
    const redirectUri = requireNonEmpty(input.redirectUri, 'redirectUri')
    const scope = normScope(input.scope)
    const enabled = input.enabled === false ? 0 : 1
    const label = input.label?.trim() || null

    let vaultId: string | null = null
    if (typeof input.clientSecret === 'string' && input.clientSecret.length > 0) {
      vaultId = this.vault.createVaultEntry({
        kind: 'oidc_client_secret',
        ownerKind: 'org',
        secret: input.clientSecret,
        label: `oidc:${issuer}`,
      }).id
    }

    const id = newId()
    const now = Date.now()
    try {
      this.stmtInsert.run(id, issuer, clientId, redirectUri, scope, vaultId, enabled, label, now, now)
    } catch (err) {
      // Don't strand the secret we just wrote if the row was rejected.
      if (vaultId) this.vault.revokeVaultEntry(vaultId)
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE.*issuer/i.test(msg)) {
        throw new IdentityError({
          code: 'oidc_provider_exists',
          message: `an OIDC provider for issuer ${issuer} already exists`,
        })
      }
      throw err
    }
    return rowToProvider(this.rowById(id)!)
  }

  get(id: string): OidcProvider | null {
    const r = this.rowById(id)
    return r ? rowToProvider(r) : null
  }

  getByIssuer(issuer: string): OidcProvider | null {
    if (typeof issuer !== 'string' || issuer.length === 0) return null
    const r = this.stmtByIssuer.get(issuer.trim()) as OidcProviderRow | undefined
    return r ? rowToProvider(r) : null
  }

  list(): OidcProvider[] {
    return (this.stmtList.all() as OidcProviderRow[]).map(rowToProvider)
  }

  /**
   * Read the confidential client secret for the token exchange. Returns '' for
   * a public client (no vault entry) — exactly what OidcClient treats as
   * "PKCE-only, send no client_secret". Throws `oidc_provider_not_found` if the
   * id is unknown (never silently returns '' for a typo'd id).
   */
  readClientSecret(id: string): string {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'oidc_provider_not_found', message: `no OIDC provider ${id}` })
    }
    if (!r.vault_id) return ''
    return this.vault.readVaultSecret(r.vault_id)
  }

  /**
   * Targeted update (undefined = keep). `issuer` is immutable. Rotating the
   * secret writes a NEW vault entry and revokes the old one AFTER the row is
   * repointed, so a crash leaves at most an orphan secret, never a row pointing
   * at a deleted one. `clientSecret: ''` clears the secret (→ public client).
   */
  update(id: string, patch: UpdateOidcProviderInput): OidcProvider {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'oidc_provider_not_found', message: `no OIDC provider ${id}` })
    }

    const clientId = patch.clientId !== undefined ? requireNonEmpty(patch.clientId, 'clientId') : r.client_id
    const redirectUri =
      patch.redirectUri !== undefined ? requireNonEmpty(patch.redirectUri, 'redirectUri') : r.redirect_uri
    const scope = patch.scope !== undefined ? normScope(patch.scope) : r.scope
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled
    const label = patch.label !== undefined ? (patch.label?.trim() || null) : r.label

    let vaultId = r.vault_id
    let priorVaultId: string | null = null
    if (patch.clientSecret !== undefined) {
      priorVaultId = r.vault_id
      if (typeof patch.clientSecret === 'string' && patch.clientSecret.length > 0) {
        vaultId = this.vault.createVaultEntry({
          kind: 'oidc_client_secret',
          ownerKind: 'org',
          secret: patch.clientSecret,
          label: `oidc:${r.issuer}`,
        }).id
      } else {
        vaultId = null // empty string → clear the secret (public client)
      }
    }

    this.stmtUpdate.run(clientId, redirectUri, scope, vaultId, enabled, label, Date.now(), id)
    // Revoke the superseded secret only after the row no longer points at it.
    if (priorVaultId && priorVaultId !== vaultId) this.vault.revokeVaultEntry(priorVaultId)
    return rowToProvider(this.rowById(id)!)
  }

  /** Delete the registration and revoke its client secret (if any). */
  remove(id: string): boolean {
    const r = this.rowById(id)
    if (!r) return false
    this.stmtDelete.run(id)
    if (r.vault_id) this.vault.revokeVaultEntry(r.vault_id)
    return true
  }
}
