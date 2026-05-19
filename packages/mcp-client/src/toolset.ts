/**
 * `McpToolset` — attach a fleet of MCP servers to an AipeHub agent.
 *
 * Conceptual model:
 *
 *   const toolset = new McpToolset({
 *     servers: [
 *       { name: 'fs',     command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', './workspace'] },
 *       { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
 *                         env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<pat>' } },
 *     ],
 *   })
 *
 *   await toolset.connect()                       // spawn + handshake (in parallel)
 *   const tools = await toolset.listTools()       // [{ name: 'fs__read_file', ... }, ...]
 *   const out = await toolset.callTool('fs__read_file', { path: 'README.md' })
 *   await toolset.disconnect()                    // shut all children down
 *
 * Tool names are namespaced `<server>__<tool>` so two servers can both
 * declare e.g. `read` without colliding. The double-underscore
 * separator is the convention used by the official SDK examples and
 * survives common LLM tool-name regexes (Anthropic / OpenAI both
 * accept it).
 *
 * Servers are independent: if one crashes, the others stay live. Tool
 * calls against a dead server raise `server_crashed` rather than
 * silently hanging.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { McpClientError } from './errors.js'
import type {
  McpServerConfig,
  NamespacedTool,
  ServerStatus,
  ServerStatusReport,
  Tool,
  CallToolResult,
} from './types.js'

/**
 * Separator between server prefix and the MCP server's own tool name.
 * Two underscores so the result is a valid identifier under the tool-
 * name regex used by Anthropic + OpenAI tool-use APIs
 * (`^[a-zA-Z0-9_-]+$`).
 */
const NAME_SEP = '__'

/** Validates a server name at connect-time so a typo is caught loudly. */
const SERVER_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/

export interface McpToolsetOptions {
  /** One or more MCP server configurations. At least one is required. */
  servers: readonly McpServerConfig[]

  /**
   * Tool-listing timeout per server, in ms. Defaults to 10_000.
   * Tightened for tests; production agents should leave it alone.
   */
  listToolsTimeoutMs?: number

  /**
   * `callTool` timeout per call, in ms. Defaults to 60_000. Tools
   * that legitimately take longer than a minute (e.g. running a
   * build, a long DB query) should bump this.
   */
  callToolTimeoutMs?: number

  /**
   * Client identity advertised to the MCP server during handshake.
   * Default is `{ name: '@aipehub/mcp-client', version: '0.1.0' }`.
   * Override for telemetry / per-tenant attribution.
   */
  clientInfo?: { name: string; version: string }
}

interface ServerState {
  config: McpServerConfig
  status: ServerStatus
  client?: Client
  transport?: StdioClientTransport
  lastError?: string
  /** Cached tool list from the most recent listTools roundtrip. */
  tools: NamespacedTool[]
}

const DEFAULT_CLIENT_INFO = {
  name: '@aipehub/mcp-client',
  version: '0.1.0',
}

export class McpToolset {
  private readonly servers: Map<string, ServerState>
  private readonly listToolsTimeoutMs: number
  private readonly callToolTimeoutMs: number
  private readonly clientInfo: { name: string; version: string }
  private connectCalled = false

  constructor(opts: McpToolsetOptions) {
    if (!opts.servers || opts.servers.length === 0) {
      throw new McpClientError(
        'duplicate_server', // not quite the right kind; reuse rather than introduce 'no_servers'
        'McpToolset requires at least one server',
      )
    }
    this.servers = new Map()
    for (const cfg of opts.servers) {
      if (this.servers.has(cfg.name)) {
        throw new McpClientError(
          'duplicate_server',
          `server name '${cfg.name}' is declared twice in the same toolset`,
          { serverName: cfg.name },
        )
      }
      if (!SERVER_NAME_RE.test(cfg.name)) {
        throw new McpClientError(
          'bad_tool_name',
          `server name '${cfg.name}' must match ${SERVER_NAME_RE} (used as a tool-name prefix)`,
          { serverName: cfg.name },
        )
      }
      this.servers.set(cfg.name, {
        config: cfg,
        status: 'idle',
        tools: [],
      })
    }
    this.listToolsTimeoutMs = opts.listToolsTimeoutMs ?? 10_000
    this.callToolTimeoutMs = opts.callToolTimeoutMs ?? 60_000
    this.clientInfo = opts.clientInfo ?? DEFAULT_CLIENT_INFO
  }

  /**
   * Spawn every server in parallel + run the MCP handshake. Idempotent:
   * calling `connect()` twice is a no-op the second time.
   *
   * If one server fails (ENOENT on the command, handshake timeout,
   * etc), its `ServerState.status` becomes `dead` but the toolset as
   * a whole still returns. The reasoning: an agent that wires up
   * `fs + github + slack` and Slack happens to be down should still
   * be able to use `fs + github`. Strict-mode callers can check
   * `.status()` after connect and throw themselves.
   */
  async connect(): Promise<void> {
    if (this.connectCalled) return
    this.connectCalled = true
    const tasks: Array<Promise<void>> = []
    for (const state of this.servers.values()) {
      tasks.push(this.startOne(state))
    }
    await Promise.all(tasks)
  }

  /**
   * Shut all live server child processes down. Idempotent.
   *
   * Implementation note: each `transport.close()` is awaited
   * independently — one server failing to clean up should not block
   * the others. Errors during close are swallowed but reflected in
   * `.status()` as `lastError`.
   */
  async disconnect(): Promise<void> {
    if (!this.connectCalled) return
    const tasks: Array<Promise<void>> = []
    for (const state of this.servers.values()) {
      tasks.push(this.stopOne(state))
    }
    await Promise.all(tasks)
    this.connectCalled = false
  }

  /**
   * Aggregate tool list across every live server. Tool names are
   * already namespaced (`<server>__<tool>`); pass the array straight
   * to your LLM provider's tool-use API.
   *
   * Calls `tools/list` against each live server. Dead servers
   * contribute nothing — they don't throw, they just disappear from
   * the result. Use `.status()` to surface them to the operator.
   */
  async listTools(): Promise<NamespacedTool[]> {
    this.requireConnected()
    const out: NamespacedTool[] = []
    for (const state of this.servers.values()) {
      if (state.status !== 'live' || !state.client) continue
      try {
        const res = await state.client.listTools({}, {
          timeout: this.listToolsTimeoutMs,
        })
        state.tools = res.tools.map((t: Tool) => ({
          ...t,
          name: `${state.config.name}${NAME_SEP}${t.name}`,
          serverName: state.config.name,
          serverToolName: t.name,
        }))
        out.push(...state.tools)
      } catch (err) {
        // Don't tear the whole toolset down for one server's list
        // failure. Mark dead, log via lastError, and keep going.
        state.status = 'dead'
        state.lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return out
  }

  /**
   * Invoke a tool by its namespaced name. Throws `McpClientError`
   * with a discriminated `.kind` for the four common failure modes
   * (unknown_tool, server_crashed, tool_call_failed, transport_error).
   *
   * The return shape is the MCP `CallToolResult` — usually a
   * `content` array of text / image / resource parts. The caller
   * (typically `LlmAgent`'s tool-use loop) flattens this into the
   * LLM's tool-response message.
   */
  async callTool(
    namespacedName: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> {
    this.requireConnected()
    const sep = namespacedName.indexOf(NAME_SEP)
    if (sep <= 0 || sep >= namespacedName.length - NAME_SEP.length) {
      throw new McpClientError(
        'bad_tool_name',
        `tool name '${namespacedName}' is not in '<server>__<tool>' form`,
      )
    }
    const serverName = namespacedName.slice(0, sep)
    const serverToolName = namespacedName.slice(sep + NAME_SEP.length)
    const state = this.servers.get(serverName)
    if (!state) {
      throw new McpClientError(
        'unknown_tool',
        `no server named '${serverName}' in this toolset; known: [${[...this.servers.keys()].join(', ')}]`,
        { serverName },
      )
    }
    if (state.status === 'dead') {
      throw new McpClientError(
        'server_crashed',
        `server '${serverName}' is no longer live (last error: ${state.lastError ?? 'unknown'})`,
        { serverName, detail: state.lastError },
      )
    }
    if (state.status !== 'live' || !state.client) {
      throw new McpClientError(
        'not_connected',
        `server '${serverName}' is not live; call connect() first`,
        { serverName },
      )
    }
    let res: CallToolResult
    try {
      res = (await state.client.callTool(
        { name: serverToolName, arguments: args },
        undefined,
        { timeout: this.callToolTimeoutMs },
      )) as CallToolResult
    } catch (err) {
      throw new McpClientError(
        'transport_error',
        `callTool('${namespacedName}') failed: ${err instanceof Error ? err.message : String(err)}`,
        { serverName, cause: err },
      )
    }
    if (res.isError) {
      // MCP servers report tool-level failures (e.g. "file not found")
      // by setting isError on the result rather than throwing. Surface
      // those as a typed error so callers can branch without parsing
      // text content.
      const detail = extractTextContent(res) ?? 'no detail provided'
      throw new McpClientError(
        'tool_call_failed',
        `tool '${namespacedName}' returned isError: ${detail}`,
        { serverName, detail },
      )
    }
    return res
  }

  /**
   * Per-server liveness snapshot. Use this in an agent's healthz
   * handler or a `Hub.onEvent` listener to alert when an attached
   * MCP server goes down mid-session.
   */
  status(): ServerStatusReport[] {
    return [...this.servers.values()].map((s) => {
      const report: ServerStatusReport = {
        name: s.config.name,
        status: s.status,
      }
      if (s.lastError !== undefined) {
        report.lastError = s.lastError
      }
      return report
    })
  }

  /**
   * The names of all configured servers (live or otherwise). Useful
   * for tests and for debug printouts.
   */
  serverNames(): string[] {
    return [...this.servers.keys()]
  }

  // ----- private --------------------------------------------------------

  private requireConnected(): void {
    if (!this.connectCalled) {
      throw new McpClientError(
        'not_connected',
        'McpToolset.connect() has not been called yet',
      )
    }
  }

  private async startOne(state: ServerState): Promise<void> {
    const transport = new StdioClientTransport({
      command: state.config.command,
      args: state.config.args ? [...state.config.args] : [],
      // The SDK treats `env=undefined` as "inherit a curated subset of
      // the parent env"; an explicit object means "use exactly this".
      // We pass through whatever the caller supplied — see the doc
      // comment on McpServerConfig.env.
      ...(state.config.env !== undefined ? { env: state.config.env } : {}),
      ...(state.config.cwd !== undefined ? { cwd: state.config.cwd } : {}),
      // 'pipe' so the parent can attach a stderr listener later if it
      // wants to surface server errors. Default ('inherit') is noisier
      // for tests + production.
      stderr: 'pipe',
    })
    const client = new Client(this.clientInfo, { capabilities: {} })

    // If the child dies mid-session, mark dead so callTool fails fast.
    transport.onclose = () => {
      if (state.status === 'live') {
        state.status = 'dead'
        state.lastError = state.lastError ?? 'transport closed unexpectedly'
      }
    }
    transport.onerror = (err) => {
      state.lastError = err instanceof Error ? err.message : String(err)
    }

    try {
      await client.connect(transport)
      state.client = client
      state.transport = transport
      state.status = 'live'
    } catch (err) {
      state.status = 'dead'
      state.lastError = err instanceof Error ? err.message : String(err)
      // Best-effort cleanup of a half-spawned process. Don't await —
      // we don't want startup failures to block on a hung close.
      transport.close().catch(() => {
        /* ignore */
      })
    }
  }

  private async stopOne(state: ServerState): Promise<void> {
    if (state.status !== 'live') {
      // Already idle or dead — nothing to close. Reset the status
      // so a future connect() can re-spawn.
      state.status = 'idle'
      state.client = undefined
      state.transport = undefined
      return
    }
    try {
      await state.client?.close()
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err)
    }
    state.status = 'idle'
    state.client = undefined
    state.transport = undefined
  }
}

/**
 * Pull the first text-flavoured content block out of a CallToolResult.
 * Used to surface error detail on `isError` responses.
 */
function extractTextContent(res: CallToolResult): string | undefined {
  if (!Array.isArray(res.content)) return undefined
  for (const block of res.content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') return text
    }
  }
  return undefined
}
