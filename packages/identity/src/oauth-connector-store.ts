/**
 * OAuthConnectorStore — C-M2-M2, the outbound OAuth 2.0 connector registry
 * (接入现实生活 track).
 *
 * The hub is the CLIENT: a row lets it obtain (and keep refreshed) an access
 * token to call an external API ON THE USER'S BEHALF, which the M4 SecretSource
 * injects as the bearer of a remote MCP connector. This is the OUTBOUND mirror
 * of OidcProviderStore (inbound SSO), sharing its exact secret discipline and
 * adding a persisted TOKEN SET:
 *   - The confidential `client_secret` lives as a VAULT ENTRY (kind
 *     'oauth_client_secret', ownerKind 'org' — the hub owns its connector
 *     registration). A PUBLIC (PKCE-only) client has no secret and thus no
 *     vault entry, so a hub WITHOUT a master key can still register one.
 *   - The obtained token set (access + refresh + type + scope) lives as a
 *     SECOND vault entry (kind 'oauth_token') — the tokens are the live
 *     credential, so envelope encryption + master-key rotation cover them for
 *     free. `access_token_expires_at` is NON-secret metadata kept in the row so
 *     the M4 SecretSource can judge staleness WITHOUT decrypting on every spawn.
 *   - The `oauth_connectors` row holds only the non-secret config + the two
 *     vault_id pointers + the expiry. The public projection ({@link
 *     OAuthConnector}) NEVER carries the secret or the tokens.
 *
 * opt-in edge (用户法则): a store with no registered connector is byte-for-byte
 * identical to today — nothing here runs until an admin explicitly registers a
 * provider (C-M2-M5 catalog / UI) and a user completes the connect flow
 * (C-M2-M3). This milestone is pure storage; no route reads it yet.
 */

import { type SqliteDb, type SqliteStmt } from './db.js'
import { IdentityError } from './errors.js'
import type {
  OAuthConnector,
  RegisterOAuthConnectorInput,
  StoredOAuthTokenSet,
  UpdateOAuthConnectorInput,
  VaultEntry,
} from './types.js'

/** The narrow slice of the vault facade this store needs (injected). */
export interface OAuthConnectorVaultOps {
  createVaultEntry(input: {
    kind: 'oauth_client_secret' | 'oauth_token'
    ownerKind: 'org'
    ownerId?: null
    secret: string
    label?: string
  }): VaultEntry
  readVaultSecret(id: string): string
  revokeVaultEntry(id: string): boolean
}

interface OAuthConnectorRow {
  id: string
  display_name: string | null
  authorization_endpoint: string
  token_endpoint: string
  client_id: string
  redirect_uri: string
  scope: string
  extra_auth_params: string | null
  mcp_server_name: string | null
  secret_vault_id: string | null
  token_vault_id: string | null
  access_token_expires_at: number | null
  enabled: number
  created_at: number
  updated_at: number
}

/**
 * Parse the stored `extra_auth_params` JSON. Defensive: a corrupt/non-object
 * blob degrades to null rather than throwing — a connector with unreadable
 * extras is still usable (it just won't add them), and we never want a bad row
 * to crash a list().
 */
function parseExtraAuthParams(json: string | null): Record<string, string> | null {
  if (json == null) return null
  try {
    const parsed = JSON.parse(json) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

function rowToConnector(r: OAuthConnectorRow): OAuthConnector {
  return {
    id: r.id,
    displayName: r.display_name ?? null,
    authorizationEndpoint: r.authorization_endpoint,
    tokenEndpoint: r.token_endpoint,
    clientId: r.client_id,
    redirectUri: r.redirect_uri,
    scope: r.scope,
    extraAuthParams: parseExtraAuthParams(r.extra_auth_params),
    mcpServerName: r.mcp_server_name ?? null,
    hasClientSecret: typeof r.secret_vault_id === 'string' && r.secret_vault_id.length > 0,
    connected: typeof r.token_vault_id === 'string' && r.token_vault_id.length > 0,
    accessTokenExpiresAt: r.access_token_expires_at ?? null,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Trim + reject empty; id / endpoints / client_id / redirect_uri / scope are mandatory. */
function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IdentityError({
      code: 'invalid_input',
      message: `oauth connector ${field} must be a non-empty string`,
    })
  }
  return value.trim()
}

/** null/undefined/empty → null; else trimmed. */
function normOptional(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

/** Serialize extras to JSON, keeping only string values; null when nothing to store. */
function serializeExtraAuthParams(
  extra: Record<string, string> | null | undefined,
): string | null {
  if (extra == null) return null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string' && k.length > 0) out[k] = v
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null
}

export class OAuthConnectorStore {
  private readonly stmtInsert: SqliteStmt
  private readonly stmtById: SqliteStmt
  private readonly stmtList: SqliteStmt
  private readonly stmtUpdateConfig: SqliteStmt
  private readonly stmtUpdateToken: SqliteStmt
  private readonly stmtDelete: SqliteStmt

  constructor(
    private readonly db: SqliteDb,
    private readonly vault: OAuthConnectorVaultOps,
  ) {
    this.stmtInsert = db.prepare(
      `INSERT INTO oauth_connectors
         (id, display_name, authorization_endpoint, token_endpoint, client_id, redirect_uri,
          scope, extra_auth_params, mcp_server_name, secret_vault_id, token_vault_id,
          access_token_expires_at, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    this.stmtById = db.prepare('SELECT * FROM oauth_connectors WHERE id = ?')
    this.stmtList = db.prepare('SELECT * FROM oauth_connectors ORDER BY created_at ASC')
    this.stmtUpdateConfig = db.prepare(
      `UPDATE oauth_connectors
         SET display_name = ?, authorization_endpoint = ?, token_endpoint = ?, client_id = ?,
             redirect_uri = ?, scope = ?, extra_auth_params = ?, mcp_server_name = ?,
             secret_vault_id = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
    )
    // Token rewrite is a NARROW update (only the token pointer + expiry) so it
    // never races with a concurrent config edit's column set.
    this.stmtUpdateToken = db.prepare(
      `UPDATE oauth_connectors
         SET token_vault_id = ?, access_token_expires_at = ?, updated_at = ?
         WHERE id = ?`,
    )
    this.stmtDelete = db.prepare('DELETE FROM oauth_connectors WHERE id = ?')
  }

  private rowById(id: string): OAuthConnectorRow | undefined {
    return this.stmtById.get(id) as OAuthConnectorRow | undefined
  }

  /**
   * Register a connector. If a confidential `clientSecret` is given it is stored
   * in the vault first; the row only ever holds the pointer. A duplicate id
   * throws `oauth_connector_exists` — and we revoke the just-created vault entry
   * so a rejected insert leaves no orphan secret.
   */
  register(input: RegisterOAuthConnectorInput): OAuthConnector {
    const id = requireNonEmpty(input.id, 'id')
    const authorizationEndpoint = requireNonEmpty(input.authorizationEndpoint, 'authorizationEndpoint')
    const tokenEndpoint = requireNonEmpty(input.tokenEndpoint, 'tokenEndpoint')
    const clientId = requireNonEmpty(input.clientId, 'clientId')
    const redirectUri = requireNonEmpty(input.redirectUri, 'redirectUri')
    const scope = requireNonEmpty(input.scope, 'scope')
    const displayName = normOptional(input.displayName)
    const mcpServerName = normOptional(input.mcpServerName)
    const extraAuthParams = serializeExtraAuthParams(input.extraAuthParams)
    const enabled = input.enabled === false ? 0 : 1

    let vaultId: string | null = null
    if (typeof input.clientSecret === 'string' && input.clientSecret.length > 0) {
      vaultId = this.vault.createVaultEntry({
        kind: 'oauth_client_secret',
        ownerKind: 'org',
        secret: input.clientSecret,
        label: `oauth:${id}`,
      }).id
    }

    const now = Date.now()
    try {
      this.stmtInsert.run(
        id, displayName, authorizationEndpoint, tokenEndpoint, clientId, redirectUri,
        scope, extraAuthParams, mcpServerName, vaultId, null, null, enabled, now, now,
      )
    } catch (err) {
      // Don't strand the secret we just wrote if the row was rejected.
      if (vaultId) this.vault.revokeVaultEntry(vaultId)
      const msg = err instanceof Error ? err.message : String(err)
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
        throw new IdentityError({
          code: 'oauth_connector_exists',
          message: `an OAuth connector with id ${id} already exists`,
        })
      }
      throw err
    }
    return rowToConnector(this.rowById(id)!)
  }

  get(id: string): OAuthConnector | null {
    if (typeof id !== 'string' || id.length === 0) return null
    const r = this.rowById(id)
    return r ? rowToConnector(r) : null
  }

  list(): OAuthConnector[] {
    return (this.stmtList.all() as OAuthConnectorRow[]).map(rowToConnector)
  }

  /**
   * Read the confidential client secret for the token exchange / refresh.
   * Returns '' for a public client (no vault entry) — exactly what
   * `buildTokenExchangeBody` treats as "PKCE-only, send no client_secret".
   * Throws `oauth_connector_not_found` for an unknown id (never silently returns
   * '' for a typo).
   */
  readClientSecret(id: string): string {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'oauth_connector_not_found', message: `no OAuth connector ${id}` })
    }
    if (!r.secret_vault_id) return ''
    return this.vault.readVaultSecret(r.secret_vault_id)
  }

  /**
   * Targeted config update (undefined = keep). `id` is immutable. Rotating the
   * secret writes a NEW vault entry and revokes the old one AFTER the row is
   * repointed, so a crash leaves at most an orphan secret, never a row pointing
   * at a deleted one. `clientSecret: ''` clears the secret (→ public client).
   * The token set is untouched here — use {@link setTokenSet} / {@link
   * clearTokenSet} for that.
   */
  update(id: string, patch: UpdateOAuthConnectorInput): OAuthConnector {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'oauth_connector_not_found', message: `no OAuth connector ${id}` })
    }

    const displayName =
      patch.displayName !== undefined ? normOptional(patch.displayName) : r.display_name
    const authorizationEndpoint =
      patch.authorizationEndpoint !== undefined
        ? requireNonEmpty(patch.authorizationEndpoint, 'authorizationEndpoint')
        : r.authorization_endpoint
    const tokenEndpoint =
      patch.tokenEndpoint !== undefined
        ? requireNonEmpty(patch.tokenEndpoint, 'tokenEndpoint')
        : r.token_endpoint
    const clientId = patch.clientId !== undefined ? requireNonEmpty(patch.clientId, 'clientId') : r.client_id
    const redirectUri =
      patch.redirectUri !== undefined ? requireNonEmpty(patch.redirectUri, 'redirectUri') : r.redirect_uri
    const scope = patch.scope !== undefined ? requireNonEmpty(patch.scope, 'scope') : r.scope
    const extraAuthParams =
      patch.extraAuthParams !== undefined
        ? serializeExtraAuthParams(patch.extraAuthParams)
        : r.extra_auth_params
    const mcpServerName =
      patch.mcpServerName !== undefined ? normOptional(patch.mcpServerName) : r.mcp_server_name
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : r.enabled

    let vaultId = r.secret_vault_id
    let priorVaultId: string | null = null
    if (patch.clientSecret !== undefined) {
      priorVaultId = r.secret_vault_id
      if (typeof patch.clientSecret === 'string' && patch.clientSecret.length > 0) {
        vaultId = this.vault.createVaultEntry({
          kind: 'oauth_client_secret',
          ownerKind: 'org',
          secret: patch.clientSecret,
          label: `oauth:${r.id}`,
        }).id
      } else {
        vaultId = null // empty string → clear the secret (public client)
      }
    }

    this.stmtUpdateConfig.run(
      displayName, authorizationEndpoint, tokenEndpoint, clientId, redirectUri, scope,
      extraAuthParams, mcpServerName, vaultId, enabled, Date.now(), id,
    )
    // Revoke the superseded secret only after the row no longer points at it.
    if (priorVaultId && priorVaultId !== vaultId) this.vault.revokeVaultEntry(priorVaultId)
    return rowToConnector(this.rowById(id)!)
  }

  /**
   * Persist a token set after the connect flow (C-M2-M3) or a refresh
   * (C-M2-M4). The tokens go into a NEW vault entry (kind 'oauth_token'); the
   * non-secret absolute expiry goes into the row. The prior token entry is
   * revoked AFTER the row is repointed — same crash-safe ordering as a secret
   * rotation, so a mid-write crash leaves at most an orphan token blob, never a
   * row pointing at a deleted one. The caller computes `accessTokenExpiresAt`
   * from the response's `expires_in`; on a refresh that omits a new
   * `refreshToken`, the caller must carry the prior one forward (this store
   * persists exactly what it's given).
   */
  setTokenSet(id: string, tokenSet: StoredOAuthTokenSet): OAuthConnector {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'oauth_connector_not_found', message: `no OAuth connector ${id}` })
    }
    const accessToken = tokenSet?.accessToken
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new IdentityError({
        code: 'invalid_input',
        message: 'setTokenSet requires a non-empty accessToken',
      })
    }
    // Only the SECRET tokens go in the vault blob; the expiry is non-secret
    // metadata kept in the row so M4 can check staleness without decrypting.
    const blob = JSON.stringify({
      accessToken,
      refreshToken: typeof tokenSet.refreshToken === 'string' ? tokenSet.refreshToken : null,
      tokenType: typeof tokenSet.tokenType === 'string' ? tokenSet.tokenType : null,
      scope: typeof tokenSet.scope === 'string' ? tokenSet.scope : null,
    })
    const newVaultId = this.vault.createVaultEntry({
      kind: 'oauth_token',
      ownerKind: 'org',
      secret: blob,
      label: `oauth-token:${r.id}`,
    }).id
    const expiresAt =
      typeof tokenSet.accessTokenExpiresAt === 'number' && Number.isFinite(tokenSet.accessTokenExpiresAt)
        ? tokenSet.accessTokenExpiresAt
        : null
    const priorVaultId = r.token_vault_id
    this.stmtUpdateToken.run(newVaultId, expiresAt, Date.now(), id)
    if (priorVaultId && priorVaultId !== newVaultId) this.vault.revokeVaultEntry(priorVaultId)
    return rowToConnector(this.rowById(id)!)
  }

  /**
   * Read the stored token set (the plaintext behind `token_vault_id` + the
   * row's expiry). Returns null when the connector isn't connected yet (no token
   * entry). Throws `oauth_connector_not_found` for an unknown id. A corrupt
   * blob throws `malformed_token_blob` rather than returning a half-set — a
   * caller must not act on a partial credential.
   */
  getTokenSet(id: string): StoredOAuthTokenSet | null {
    const r = this.rowById(id)
    if (!r) {
      throw new IdentityError({ code: 'oauth_connector_not_found', message: `no OAuth connector ${id}` })
    }
    if (!r.token_vault_id) return null
    const raw = this.vault.readVaultSecret(r.token_vault_id)
    let parsed: { accessToken?: unknown; refreshToken?: unknown; tokenType?: unknown; scope?: unknown }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch {
      throw new IdentityError({
        code: 'malformed_token_blob',
        message: `OAuth connector ${id} has an unreadable token blob`,
      })
    }
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) {
      throw new IdentityError({
        code: 'malformed_token_blob',
        message: `OAuth connector ${id} token blob has no access token`,
      })
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
      tokenType: typeof parsed.tokenType === 'string' ? parsed.tokenType : null,
      scope: typeof parsed.scope === 'string' ? parsed.scope : null,
      accessTokenExpiresAt: r.access_token_expires_at ?? null,
    }
  }

  /**
   * Disconnect: revoke the token vault entry, null the pointer + expiry. The
   * config (and its client_secret) stay, so the user can reconnect without
   * re-registering. Returns false when there was nothing to clear (unknown id
   * or already disconnected) — idempotent.
   */
  clearTokenSet(id: string): boolean {
    const r = this.rowById(id)
    if (!r || !r.token_vault_id) return false
    this.stmtUpdateToken.run(null, null, Date.now(), id)
    this.vault.revokeVaultEntry(r.token_vault_id)
    return true
  }

  /** Delete the registration and revoke its client secret + token set (if any). */
  remove(id: string): boolean {
    const r = this.rowById(id)
    if (!r) return false
    this.stmtDelete.run(id)
    if (r.secret_vault_id) this.vault.revokeVaultEntry(r.secret_vault_id)
    if (r.token_vault_id) this.vault.revokeVaultEntry(r.token_vault_id)
    return true
  }
}
