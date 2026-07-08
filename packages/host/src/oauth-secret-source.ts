/**
 * C-M2-M4a — outbound OAuth token → live MCP credential (接入现实生活 track).
 *
 * The injection point where a *connected* OAuth connector's LIVE access token
 * flows into a remote MCP server's `Authorization` header. It is the outbound
 * mirror of `mcp-config.ts`'s `${ENV}` expansion: instead of reading
 * `process.env`, an oauth-backed `SecretSource` resolves ONE reserved ref name
 * — `${OAUTH_ACCESS_TOKEN}` — to the token of the connector wired to *that* MCP
 * server (by `mcpServerName`). Every other ref falls through to the base source
 * (`process.env`), so a hub with zero connected connectors resolves
 * byte-for-byte as it does today. Opt-in is structural: no connector, no effect.
 *
 * Why per-server, not one global source: a connector binds to exactly one MCP
 * server via `mcpServerName` (the column M2 added for this). So the ref is a
 * FIXED sentinel and *which* token it means is decided by the server being
 * resolved — a spec author writes the same `Bearer ${OAUTH_ACCESS_TOKEN}`
 * regardless of connector id, and two oauth-backed servers never collide.
 *
 * Why sync: `SecretSource` is synchronous by contract (see mcp-config.ts). This
 * source only READS an already-stored token (a sync vault decrypt). Keeping the
 * access token fresh (refresh grant — async) is a separate background concern
 * (C-M2-M4b). If the stored token is already expired it is injected anyway: the
 * MCP server rejects it with a 401 that surfaces on `server-stderr`, the same
 * loud-failure path a wrong `${ENV}` credential takes today.
 *
 * Boundary (接入 ≠ 授权行动): a live token here only lets an agent's MCP toolset
 * *call* the provider. High-risk actions (send, spend) still pass the butler's
 * governed approval gate — this seam grants reach, not autonomy.
 */
import { envSecretSource, type SecretSource } from './mcp-config.js'
import type { OAuthConnector, StoredOAuthTokenSet } from '@gotong/identity'

/**
 * The one reserved `${}` ref an oauth-backed server config may use for its
 * bearer token. Deliberately NOT `GOTONG_*`: it is a credential placeholder
 * resolved here, never a `process.env` control knob (and the env-registry gate
 * scans source for `GOTONG_*` literals — a knob-shaped name would trip it).
 */
export const OAUTH_ACCESS_TOKEN_REF = 'OAUTH_ACCESS_TOKEN'

/** A `SecretSource` specialised for the MCP server currently being resolved. */
export type ServerSecretSource = (mcpServerName: string) => SecretSource

/** The read-only identity facade the oauth source needs (all sync). */
export interface OAuthSecretIdentity {
  listOAuthConnectors(): OAuthConnector[]
  getOAuthTokenSet(id: string): StoredOAuthTokenSet | null
}

/**
 * The live access token for the connector wired to `mcpServerName`, or
 * `undefined` when none applies (caller then falls through to the base source).
 * `enabled` AND `connected` are both required — a disabled or not-yet-connected
 * connector must behave as if absent.
 *
 * Fail-soft on a corrupt token blob: a single unreadable connector must not
 * tank an agent's whole spawn (this runs inside the spawn-time credential
 * resolution, which is not wrapped). Returning `undefined` falls through to the
 * base source → the MCP server gets no bearer → a 401 on first use surfaces on
 * `server-stderr`, so the fault stays observable without being fatal.
 */
function tokenForServer(
  identity: OAuthSecretIdentity,
  mcpServerName: string,
): string | undefined {
  for (const c of identity.listOAuthConnectors()) {
    if (c.enabled && c.connected && c.mcpServerName === mcpServerName) {
      try {
        return identity.getOAuthTokenSet(c.id)?.accessToken
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

/**
 * Build the per-server oauth-backed `SecretSource` factory. `base` is the
 * fallthrough (defaults to `process.env`); every ref other than
 * `${OAUTH_ACCESS_TOKEN}` — and that ref for a server with no connected
 * connector — resolves through it, so unset = today's behavior.
 */
export function makeOAuthSecretSource(
  identity: OAuthSecretIdentity,
  base: SecretSource = envSecretSource,
): ServerSecretSource {
  return (mcpServerName) => (name) => {
    if (name === OAUTH_ACCESS_TOKEN_REF) {
      const token = tokenForServer(identity, mcpServerName)
      if (token !== undefined) return token
    }
    return base(name)
  }
}
