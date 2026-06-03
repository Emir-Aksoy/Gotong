/**
 * SamlProviderStore — Route B P1-M5c, the SAML 2.0 identity-provider registry.
 *
 * The SAML twin of OidcProviderStore. The hub acts as a Service Provider; this
 * stores the IdP registrations it accepts SSO assertions from.
 *
 * The crucial difference from OIDC: there is NO confidential field to protect.
 * An OIDC relying party holds a `client_secret` (a replayable bearer credential
 * → vault). A SAML SP verifies assertions against the IdP's `idp_cert`, an
 * X.509 *public* signing certificate — publishing it leaks nothing. So this
 * store needs no vault injection, no `readSecret` method, and no orphan-secret
 * cleanup: every column is plain config that the admin projection can carry.
 *
 * (An SP that SIGNS its own AuthnRequests would hold a private key — but the
 * MVP sets AuthnRequestsSigned=false, so there is no SP private key to store.)
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import { newId } from './tokens.js'
import type {
  AddSamlProviderInput,
  SamlProvider,
  UpdateSamlProviderInput,
} from './types.js'

interface SamlProviderRow {
  id: string
  idp_entity_id: string
  sso_url: string
  idp_cert: string
  sp_entity_id: string
  enabled: number
  label: string | null
  created_at: number
  updated_at: number
}

function rowToProvider(r: SamlProviderRow): SamlProvider {
  return {
    id: r.id,
    idpEntityId: r.idp_entity_id,
    ssoUrl: r.sso_url,
    idpCert: r.idp_cert,
    spEntityId: r.sp_entity_id,
    enabled: r.enabled === 1,
    label: r.label ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Trim + reject empty; entityID / SSO URL / cert / SP entityID are all mandatory. */
function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `saml provider ${field} must be a non-empty string`,
    })
  }
  return value.trim()
}

export class SamlProviderStore {
  private readonly stmtInsert: SqliteStmt
  private readonly stmtById: SqliteStmt
  private readonly stmtByEntityId: SqliteStmt
  private readonly stmtList: SqliteStmt
  private readonly stmtUpdate: SqliteStmt
  private readonly stmtDelete: SqliteStmt

  constructor(private readonly db: SqliteDb) {
    this.stmtInsert = db.prepare(
      `INSERT INTO saml_providers
         (id, idp_entity_id, sso_url, idp_cert, sp_entity_id, enabled, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM saml_providers WHERE id = ?')
    this.stmtByEntityId = db.prepare('SELECT * FROM saml_providers WHERE idp_entity_id = ?')
    this.stmtList = db.prepare('SELECT * FROM saml_providers ORDER BY created_at ASC')
    this.stmtUpdate = db.prepare(
      `UPDATE saml_providers
         SET sso_url = ?, idp_cert = ?, sp_entity_id = ?, enabled = ?, label = ?, updated_at = ?
         WHERE id = ?`,
    )
    this.stmtDelete = db.prepare('DELETE FROM saml_providers WHERE id = ?')
  }

  private rowById(id: string): SamlProviderRow | undefined {
    return this.stmtById.get(id) as SamlProviderRow | undefined
  }

  /**
   * Register an IdP. A duplicate entityID throws `saml_provider_exists` — one
   * registration per IdP entityID (the assertion Issuer we pin verification to).
   */
  add(input: AddSamlProviderInput): SamlProvider {
    const idpEntityId = requireNonEmpty(input.idpEntityId, 'idpEntityId')
    const ssoUrl = requireNonEmpty(input.ssoUrl, 'ssoUrl')
    const idpCert = requireNonEmpty(input.idpCert, 'idpCert')
    const spEntityId = requireNonEmpty(input.spEntityId, 'spEntityId')
    const enabled = input.enabled === false ? 0 : 1
    const label = input.label?.trim() || null

    const id = newId()
    const now = Date.now()
    try {
      this.stmtInsert.run(id, idpEntityId, ssoUrl, idpCert, spEntityId, enabled, label, now, now)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE.*idp_entity_id/i.test(msg)) {
        throw new IdentityError({
          code: 'saml_provider_exists',
          message: `a SAML provider for entityID ${idpEntityId} already exists`,
        })
      }
      throw err
    }
    return rowToProvider(this.rowById(id)!)
  }

  get(id: string): SamlProvider | null {
    const r = this.rowById(id)
    return r ? rowToProvider(r) : null
  }

  getByEntityId(idpEntityId: string): SamlProvider | null {
    if (typeof idpEntityId !== 'string' || idpEntityId.length === 0) return null
    const r = this.stmtByEntityId.get(idpEntityId.trim()) as SamlProviderRow | undefined
    return r ? rowToProvider(r) : null
  }

  list(): SamlProvider[] {
    return (this.stmtList.all() as SamlProviderRow[]).map(rowToProvider)
  }

  /**
   * Targeted update (undefined = keep). `idpEntityId` is immutable — re-add to
   * point at a different IdP, so the pinned Issuer can never drift out from
   * under an existing registration's id.
   */
  update(id: string, patch: UpdateSamlProviderInput): SamlProvider {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'saml_provider_not_found', message: `no SAML provider ${id}` })
    }

    const ssoUrl = patch.ssoUrl !== undefined ? requireNonEmpty(patch.ssoUrl, 'ssoUrl') : r.sso_url
    const idpCert = patch.idpCert !== undefined ? requireNonEmpty(patch.idpCert, 'idpCert') : r.idp_cert
    const spEntityId =
      patch.spEntityId !== undefined ? requireNonEmpty(patch.spEntityId, 'spEntityId') : r.sp_entity_id
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled
    const label = patch.label !== undefined ? (patch.label?.trim() || null) : r.label

    this.stmtUpdate.run(ssoUrl, idpCert, spEntityId, enabled, label, Date.now(), id)
    return rowToProvider(this.rowById(id)!)
  }

  /** Delete the registration. No secret to revoke (idp_cert is public). */
  remove(id: string): boolean {
    const r = this.rowById(id)
    if (!r) return false
    this.stmtDelete.run(id)
    return true
  }
}
