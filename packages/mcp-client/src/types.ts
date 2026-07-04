/**
 * Public types for `@gotong/mcp-client`. Re-exports a curated slice
 * of `@modelcontextprotocol/sdk` types so library users don't need to
 * pull the SDK in directly to satisfy TypeScript.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * Which wire the toolset uses to reach a server:
 *
 *   - `stdio` — spawn a local child process, talk over its stdin/stdout
 *     (the original MCP transport; what `npx @modelcontextprotocol/...`
 *     servers use).
 *   - `http`  — MCP **Streamable HTTP** transport: connect to a remote
 *     URL over HTTPS (POST to send, GET+SSE to receive). This is what
 *     most *hosted* MCP servers expose, so it's the one that lets an
 *     Gotong agent "borrow" the managed-MCP ecosystem.
 *   - `sse`   — the legacy HTTP+SSE transport. Deprecated upstream but
 *     still served by a long tail of remote servers, so we keep it.
 */
export type McpTransportKind = 'stdio' | 'http' | 'sse'

/**
 * A `stdio` MCP server: a local child process the toolset spawns and
 * talks to over stdin/stdout. `transport` is optional and defaults to
 * `'stdio'`, so a bare `{ name, command }` is a valid stdio config —
 * the common case stays terse.
 */
export interface McpStdioServerConfig {
  /**
   * Short identifier, used as the prefix on namespaced tool names
   * (`<name>__<tool>`). Must be unique within the toolset.
   */
  name: string

  /** Wire kind. Optional here — omitting it means `'stdio'`. */
  transport?: 'stdio'

  /**
   * Executable to spawn. Typically `npx` for installed-on-demand
   * servers, or an absolute path for site-installed ones. Don't ship
   * a workspace-relative path — the agent's CWD is not the workspace
   * root in production (the host runs from `/opt/gotong`).
   */
  command: string

  /**
   * Command-line arguments. The MCP SDK passes these to `spawn`
   * untouched — no shell interpolation, no quote handling. If you
   * need to pass `--key=value`, that's one arg, not two.
   */
  args?: readonly string[]

  /**
   * Environment to expose to the child process. Defaults to a curated
   * subset of the parent's env (HOME, PATH, etc — the SDK's
   * `getDefaultEnvironment()` set). Most servers need credentials
   * here: `GITHUB_PERSONAL_ACCESS_TOKEN`, `SLACK_BOT_TOKEN`, etc.
   *
   * Implementation note: if you set `env` at all, only the keys you
   * provide are passed through — the default-inherited set is
   * dropped. Spell out PATH explicitly if your server needs it.
   */
  env?: Record<string, string>

  /**
   * Working directory for the child process. Defaults to the Gotong
   * agent process's CWD. Set this when the server needs a specific
   * project root (e.g. some `git`-based MCPs look at `process.cwd()`
   * to find the repo).
   */
  cwd?: string
}

/**
 * A remote MCP server reached over the **Streamable HTTP** transport.
 * No child process is spawned — the toolset POSTs to `url` and reads an
 * SSE response stream. This is the transport hosted MCP providers use.
 */
export interface McpHttpServerConfig {
  /** See {@link McpStdioServerConfig.name}. */
  name: string
  /** Selects the Streamable HTTP transport. */
  transport: 'http'
  /** Absolute server URL (e.g. `https://mcp.example.com/v1`). */
  url: string
  /**
   * Extra HTTP headers sent on every request — the place for a bearer
   * token: `{ Authorization: 'Bearer <pat>' }`. No `${ENV}` expansion
   * happens in this package; resolve credentials upstream (the host's
   * `resolveMcpServerConfig` does it against the secret source).
   */
  headers?: Record<string, string>
}

/**
 * A remote MCP server reached over the **legacy HTTP+SSE** transport.
 * Same `url`/`headers` shape as {@link McpHttpServerConfig}; prefer
 * `'http'` for new servers and reach for this only when a server
 * predates Streamable HTTP.
 */
export interface McpSseServerConfig {
  /** See {@link McpStdioServerConfig.name}. */
  name: string
  /** Selects the legacy SSE transport. */
  transport: 'sse'
  /** Absolute SSE endpoint URL the stream is opened against. */
  url: string
  /** See {@link McpHttpServerConfig.headers}. */
  headers?: Record<string, string>
}

/**
 * One MCP server in a toolset. A discriminated union over `transport`:
 * a local `stdio` child process, or a remote `http` / `sse` endpoint.
 * The handshake + spawn/connect happens lazily when `connect()` is
 * called on the parent toolset.
 *
 * `name` is the short identifier used to namespace tool names — see
 * `McpToolset.listTools()`. It must be unique within the toolset and
 * match `/^[a-zA-Z][a-zA-Z0-9_-]*$/` (a-z, A-Z, 0-9, `_`, `-`; can't
 * start with a digit). Validated at `connect()` time, not at
 * construction, so a typo doesn't reject the whole config eagerly.
 */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSseServerConfig

/**
 * A tool exposed by an MCP server, with its origin server attached so
 * the caller can render attribution / debug which server provided it.
 *
 * The `name` field is the *namespaced* name (`<server>__<tool>`) — the
 * one that gets handed to the LLM. The MCP server's own tool name
 * (before prefixing) is preserved as `serverToolName`.
 */
export interface NamespacedTool extends Tool {
  /** `<server>__<tool>` — the name the LLM sees + the one callTool() expects. */
  name: string
  /** The originating server's `name` (the prefix). */
  serverName: string
  /** The tool name on the originating server, before prefixing. */
  serverToolName: string
}

/**
 * Liveness snapshot of one server in the toolset.
 *
 *   - `idle`  — `connect()` has not been called yet (or `disconnect()`).
 *   - `live`  — child process is up + handshake completed.
 *   - `dead`  — child process has exited or transport closed; `callTool`
 *               against tools from this server now throws
 *               `server_crashed`. The toolset as a whole stays usable
 *               for the live servers.
 *
 * Surfaced via `McpToolset.status()` for ops introspection.
 */
export type ServerStatus = 'idle' | 'live' | 'dead'

export interface ServerStatusReport {
  name: string
  status: ServerStatus
  /** Last error observed, if status is `dead`. */
  lastError?: string
}

export type { Tool, CallToolResult }
