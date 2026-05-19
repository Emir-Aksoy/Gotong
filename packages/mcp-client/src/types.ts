/**
 * Public types for `@aipehub/mcp-client`. Re-exports a curated slice
 * of `@modelcontextprotocol/sdk` types so library users don't need to
 * pull the SDK in directly to satisfy TypeScript.
 */

import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * One MCP server in a toolset. The handshake + spawn happens lazily
 * when `connect()` is called on the parent toolset.
 *
 * `name` is the short identifier used to namespace tool names — see
 * `McpToolset.listTools()`. It must be unique within the toolset and
 * match `/^[a-zA-Z][a-zA-Z0-9_-]*$/` (a-z, A-Z, 0-9, `_`, `-`; can't
 * start with a digit). Validated at `connect()` time, not at
 * construction, so a typo doesn't reject the whole config eagerly.
 */
export interface McpServerConfig {
  /**
   * Short identifier, used as the prefix on namespaced tool names
   * (`<name>__<tool>`). Must be unique within the toolset.
   */
  name: string

  /**
   * Executable to spawn. Typically `npx` for installed-on-demand
   * servers, or an absolute path for site-installed ones. Don't ship
   * a workspace-relative path — the agent's CWD is not the workspace
   * root in production (the host runs from `/opt/aipehub`).
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
   * Working directory for the child process. Defaults to the AipeHub
   * agent process's CWD. Set this when the server needs a specific
   * project root (e.g. some `git`-based MCPs look at `process.cwd()`
   * to find the repo).
   */
  cwd?: string
}

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
