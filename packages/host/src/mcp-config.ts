/**
 * Resolve a yaml-level `McpServerSpec` into a ready-to-spawn
 * `McpServerConfig`, expanding `${VAR}` credential references against a
 * pluggable secret source.
 *
 * This is the one credential path shared by every consumer that needs to
 * turn a declared MCP server into a live one:
 *
 *   - agent spawn (`LocalAgentPool.buildToolset`), and
 *   - any future integration installer that adds an MCP server at
 *     hub/workspace scope.
 *
 * Keeping it a pure function of `(spec, secretSource)` — rather than
 * reaching into `process.env` inline — means the secret source can be
 * swapped for the v4 vault later without touching callers: pass a
 * `SecretSource` backed by `vault.get(name)` instead of `process.env`.
 */

import type { McpServerSpec } from '@aipehub/core'
import type { McpServerConfig } from '@aipehub/mcp-client'

/**
 * Resolves a `${VAR}` name to its secret value, or `undefined` if the
 * source doesn't have it. The default ({@link envSecretSource}) reads
 * `process.env`; a vault-backed source is a drop-in replacement.
 */
export type SecretSource = (name: string) => string | undefined

/** The default secret source — reads `process.env`. */
export const envSecretSource: SecretSource = (name) => process.env[name]

export interface ResolveMcpOptions {
  /**
   * Invoked when a `${VAR}` reference resolves to `undefined` (the ref
   * still expands to an empty string — the spawn proceeds and the MCP
   * server fails loudly itself if it actually needed the credential).
   * Wire this to a logger so operators see the missing-secret warning.
   */
  onMissingSecret?: (varName: string, serverName: string) => void
}

// ${NAME} — anchored to standard POSIX env-var name shape so a literal
// "$5.99" in a value isn't mistaken for a reference.
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * Expand `${VAR}` references in a `name → value` map against
 * `secrets`. Unknown refs become empty strings (and fire
 * `onMissingSecret`, if given). Used for both stdio `env` and http/sse
 * `headers`.
 */
export function expandSecretRefs(
  raw: Record<string, string>,
  secrets: SecretSource,
  serverName: string,
  onMissingSecret?: (varName: string, serverName: string) => void,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v.replace(REF, (_match, name: string) => {
      const val = secrets(name)
      if (val === undefined) {
        onMissingSecret?.(name, serverName)
        return ''
      }
      return val
    })
  }
  return out
}

/**
 * Map one `McpServerSpec` to a resolved `McpServerConfig`, expanding
 * `${VAR}` references in the credential-bearing fields: stdio `env`
 * values and http/sse `headers` values (typically an
 * `Authorization: Bearer ${...}` token).
 */
export function resolveMcpServerConfig(
  spec: McpServerSpec,
  secrets: SecretSource = envSecretSource,
  opts: ResolveMcpOptions = {},
): McpServerConfig {
  const { onMissingSecret } = opts
  if (spec.transport === 'http' || spec.transport === 'sse') {
    const headers = spec.headers
      ? expandSecretRefs(spec.headers, secrets, spec.name, onMissingSecret)
      : undefined
    return spec.transport === 'http'
      ? { name: spec.name, transport: 'http', url: spec.url, ...(headers ? { headers } : {}) }
      : { name: spec.name, transport: 'sse', url: spec.url, ...(headers ? { headers } : {}) }
  }
  // stdio (default)
  const cfg: McpServerConfig = { name: spec.name, command: spec.command }
  if (spec.args) cfg.args = [...spec.args]
  if (spec.env) cfg.env = expandSecretRefs(spec.env, secrets, spec.name, onMissingSecret)
  if (spec.cwd) cfg.cwd = spec.cwd
  return cfg
}

/**
 * Merge an agent's MCP server specs from two sources, in tool-list
 * order: the hub-registry servers it opts into (`useMcpServers`,
 * resolved through `registry`) first, then its own inline `mcpServers`.
 *
 *   - an opt-in name with no registry entry is dropped + reported via
 *     `onUnknown` (graceful — the agent still spawns);
 *   - an opt-in name that collides with an inline server is dropped in
 *     favour of the inline one (a local override of a hub default);
 *   - duplicate opt-in names are de-duped (McpToolset requires unique
 *     names).
 *
 * Pure function — the host method wraps it with the live registry +
 * a logging `onUnknown`.
 */
export function mergeAgentMcpSpecs(
  inline: readonly McpServerSpec[],
  optInNames: readonly string[],
  registry: ReadonlyMap<string, McpServerSpec>,
  onUnknown?: (name: string) => void,
): McpServerSpec[] {
  if (optInNames.length === 0) return [...inline]
  const inlineNames = new Set(inline.map((s) => s.name))
  const resolved: McpServerSpec[] = []
  const seen = new Set<string>()
  for (const name of optInNames) {
    if (seen.has(name)) continue
    seen.add(name)
    if (inlineNames.has(name)) continue // inline wins
    const spec = registry.get(name)
    if (!spec) {
      onUnknown?.(name)
      continue
    }
    resolved.push(spec)
  }
  return [...resolved, ...inline]
}
