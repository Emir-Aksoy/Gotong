/**
 * Discriminated error class for everything that can go wrong wiring an
 * MCP server into an AipeHub agent.
 *
 * The `kind` field is stable so callers can branch on it without
 * string-matching `.message`:
 *
 *   - `not_connected` — operating on a toolset that has not been
 *     `connect()`-ed yet, or has already been `disconnect()`-ed.
 *   - `server_crashed` — a previously-running server child process
 *     died (stderr / non-zero exit / transport closed). The other
 *     servers in the same toolset keep working.
 *   - `unknown_tool` — `callTool(name, ...)` was called with a name
 *     that doesn't appear in the most recent `listTools()` result.
 *     Caller probably forgot to await `connect()` or used a stale
 *     tool name across a server restart.
 *   - `bad_tool_name` — tool name doesn't match the `<server>__<tool>`
 *     convention. Always a programmer error.
 *   - `duplicate_server` — two servers in the same toolset share the
 *     same `name` field. Always a programmer error.
 *   - `tool_call_failed` — the server returned a successful response
 *     but the tool reported `isError: true` (e.g. "file not found"
 *     from filesystem MCP). The `.detail` field carries the server's
 *     own error message, which is the actionable thing.
 *   - `transport_error` — wraps any error thrown by the underlying
 *     `@modelcontextprotocol/sdk` transport (handshake failure,
 *     spawn ENOENT, etc).
 */
export type McpClientErrorKind =
  | 'not_connected'
  | 'server_crashed'
  | 'unknown_tool'
  | 'bad_tool_name'
  | 'duplicate_server'
  | 'tool_call_failed'
  | 'transport_error'

export class McpClientError extends Error {
  readonly kind: McpClientErrorKind
  readonly serverName?: string
  readonly detail?: string

  constructor(
    kind: McpClientErrorKind,
    message: string,
    opts: { serverName?: string; detail?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'McpClientError'
    this.kind = kind
    if (opts.serverName !== undefined) this.serverName = opts.serverName
    if (opts.detail !== undefined) this.detail = opts.detail
  }
}
