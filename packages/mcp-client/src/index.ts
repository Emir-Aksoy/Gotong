/**
 * `@aipehub/mcp-client` — attach a fleet of MCP servers to an AipeHub
 * agent so its LLM tool-use loop can drive GitHub / Filesystem /
 * Slack / Postgres / arbitrary stdio-MCP servers natively.
 *
 * See README.md for the full story; the public surface is small:
 *
 *   import { McpToolset, McpClientError } from '@aipehub/mcp-client'
 */
export { McpToolset } from './toolset.js'
export type {
  McpToolsetOptions,
  McpToolsetEvents,
} from './toolset.js'
export { McpClientError } from './errors.js'
export type { McpClientErrorKind } from './errors.js'
export type {
  McpServerConfig,
  NamespacedTool,
  ServerStatus,
  ServerStatusReport,
  Tool,
  CallToolResult,
} from './types.js'
