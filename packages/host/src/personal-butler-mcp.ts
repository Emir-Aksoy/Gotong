/**
 * personal-butler-mcp.ts — split a butler's attached MCP toolset (notes /
 * calendar / …) into a READ half that runs inline and a WRITE half that parks
 * for a `/me` approval (S1-M2).
 *
 * The resident butler already composes whatever MCP servers the managed-agent row
 * declared (`mcpServers:` / `useMcpServers:`). Before S1-M2 the WHOLE toolset was
 * benign — the butler could silently create a calendar event or overwrite a note.
 * That breaks the north star's "sensitive actions → a human clears them": writing
 * to your notes / calendar is exactly the kind of side effect that should ask
 * first.
 *
 * So we partition the connected toolset by tool:
 *   - READ tools (search notes, list events, get a page) → a benign proxy that
 *     runs inline. No approval — reading your own data has no consequence.
 *   - WRITE tools (create / update / delete / send) → a `GovernedActionToolset`
 *     whose default verdict is `approve`, so the butler PARKS (`SuspendTaskError`
 *     → `/me` inbox) before the write happens; a human clears it, then the very
 *     same call runs on resume. This is the SAME gate the steward action set uses
 *     — the butler now just carries two governed gates (multi-gate leaf change),
 *     each self-contained.
 *
 * ── Why partition here and not inside the LLM loop ──────────────────────────
 * The butler's gate keys off the tool NAME (`governs(name)`), and execution
 * routes through the composed toolset. So read + write must be DISJOINT toolsets
 * (a name in exactly one), which `ComposedToolset` also enforces. This module is
 * the one place that decides which side each MCP tool lands on, from a resolved,
 * namespaced tool list (`await mcpToolset.listTools()` — the servers are already
 * connected at spawn).
 *
 * ── The classification, and its conservative default ────────────────────────
 * `defaultMcpToolClass` reads the MCP `annotations.readOnlyHint` /
 * `destructiveHint` first (the server's own declaration). Many servers set
 * neither, so it falls back to a read-verb name heuristic; anything it still
 * can't place is treated as a WRITE — fail-safe: an unclassified tool asks a
 * human rather than acting silently. A host that knows its server precisely can
 * inject `classifyTool` to override.
 */

import {
  GovernedActionToolset,
  type GovernedToolSpec,
  type GovernedVerdict,
} from '@aipehub/personal-butler'
import type {
  LlmAgentToolset,
  LlmContentBlock,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'

/** The double-underscore namespacing `McpToolset` uses (`<server>__<tool>`). */
const NAME_SEP = '__'

/**
 * A resolved, namespaced MCP tool as returned by `McpToolset.listTools()`. Only
 * the fields this module reads are declared; the real object carries more (it
 * spreads the full MCP `Tool`), which is why `annotations` flows through even
 * though `LlmToolDefinition` doesn't declare it.
 */
export interface ButlerMcpTool {
  /** Namespaced name, `<server>__<tool>` — what the LLM calls. */
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: {
    /** MCP: the tool does not modify its environment (a read). */
    readOnlyHint?: boolean
    /** MCP: the tool may perform destructive updates (a write). */
    destructiveHint?: boolean
    [k: string]: unknown
  }
}

/** Runs a tool by its namespaced name — bind `mcpToolset.callTool`. */
export type ButlerMcpCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<LlmToolCallResult>

export interface ButlerMcpToolsetsOptions {
  /** The connected toolset's resolved tools (`await mcpToolset.listTools()`). */
  tools: readonly ButlerMcpTool[]
  /** Executes a cleared call — `(n, a) => mcpToolset.callTool(n, a)`. */
  callTool: ButlerMcpCall
  /**
   * Override the read/write split for a tool. Default → {@link defaultMcpToolClass}.
   * A host that knows its server precisely (e.g. "this `move_event` is safe to
   * run inline") can force a tool's side.
   */
  classifyTool?: (tool: ButlerMcpTool) => 'read' | 'write'
  /**
   * Verdict for a WRITE tool. Default → `approve` (park for a human). A host can
   * downgrade a specific low-risk write to `allow` (inline) if it wants.
   */
  writeVerdict?: (tool: ButlerMcpTool) => GovernedVerdict
}

export interface ButlerMcpToolsets {
  /** The read half — compose into the butler's `benign` set (runs inline). */
  readBenign: LlmAgentToolset
  /**
   * The write half — add to the butler's `governed` array (parks for approval).
   * `undefined` when the server exposes no write tools (a read-only KB) — then the
   * butler carries no MCP gate at all.
   */
  writeGoverned: GovernedActionToolset | undefined
}

const READ_VERB_RE =
  /^(list|get|read|search|find|query|fetch|show|view|lookup|describe|count|recent|browse)([_-]|$)/

/**
 * Classify one MCP tool as a read or a write. Trusts the server's own
 * `annotations` first; falls back to a read-verb name heuristic; treats anything
 * still ambiguous as a WRITE (conservative — an unclassified tool asks a human).
 */
export function defaultMcpToolClass(tool: ButlerMcpTool): 'read' | 'write' {
  const a = tool.annotations
  // 1. The server's own declaration wins.
  if (a?.readOnlyHint === true) return 'read'
  if (a?.readOnlyHint === false || a?.destructiveHint === true) return 'write'
  // 2. No hint — look at the local (un-namespaced) tool name.
  const sep = tool.name.indexOf(NAME_SEP)
  const local = sep >= 0 ? tool.name.slice(sep + NAME_SEP.length) : tool.name
  if (READ_VERB_RE.test(local.toLowerCase())) return 'read'
  // 3. Fail-safe: can't prove it's a read → govern it.
  return 'write'
}

/**
 * Partition a connected MCP toolset into a benign READ proxy and a governed WRITE
 * toolset for the resident butler. Names are namespaced + disjoint across the two
 * halves, so they compose without collision.
 */
export function buildButlerMcpToolsets(opts: ButlerMcpToolsetsOptions): ButlerMcpToolsets {
  const classify = opts.classifyTool ?? defaultMcpToolClass
  const writeVerdict = opts.writeVerdict ?? (() => APPROVE_WRITE)

  const readDefs: LlmToolDefinition[] = []
  const writeSpecs: GovernedToolSpec[] = []
  for (const tool of opts.tools) {
    if (classify(tool) === 'read') {
      readDefs.push(toolDefinition(tool))
    } else {
      writeSpecs.push({
        ...toolSpec(tool),
        defaultVerdict: writeVerdict(tool),
      })
    }
  }

  const readBenign = new ReadOnlyMcpProxy(readDefs, opts.callTool)
  const writeGoverned =
    writeSpecs.length > 0
      ? new GovernedActionToolset({
          tools: writeSpecs,
          // Human title for the /me inbox item — "在你的笔记/日历上执行:<tool>".
          describe: (name, args) => `在你的笔记/日历上执行:${humanizeToolName(name)}${argHint(args)}`,
          // Runs the cleared write through the SAME MCP toolset. A throw
          // (`McpClientError` on a tool-level error) becomes a tidy isError
          // result — the model is told and adapts, never crashes the task.
          execute: async (name, args) => {
            try {
              const out = await opts.callTool(name, args)
              return {
                text: flattenContent(out.content),
                ...(out.isError ? { isError: true } : {}),
              }
            } catch (err) {
              return { text: err instanceof Error ? err.message : String(err), isError: true }
            }
          },
        })
      : undefined

  return { readBenign, writeGoverned }
}

/** Default write verdict — ask a human. */
const APPROVE_WRITE: GovernedVerdict = {
  decision: 'approve',
  reason: '会写你的笔记/日历,先问你一下',
}

/** A benign proxy over the connected MCP toolset that only advertises READ tools. */
class ReadOnlyMcpProxy implements LlmAgentToolset {
  constructor(
    private readonly defs: LlmToolDefinition[],
    private readonly call: ButlerMcpCall,
  ) {}

  listTools(): LlmToolDefinition[] {
    return this.defs
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    // Only read names are advertised, so the LLM can only reach reads here; the
    // MCP toolset validates the name regardless.
    return this.call(name, args)
  }
}

function toolDefinition(tool: ButlerMcpTool): LlmToolDefinition {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema ?? { type: 'object' },
  }
}

function toolSpec(tool: ButlerMcpTool): GovernedToolSpec {
  return {
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema ?? { type: 'object' },
  }
}

/** `notes__create_note` → `notes · create_note` for a member-readable title. */
function humanizeToolName(namespaced: string): string {
  const sep = namespaced.indexOf(NAME_SEP)
  if (sep < 0) return namespaced
  return `${namespaced.slice(0, sep)} · ${namespaced.slice(sep + NAME_SEP.length)}`
}

/** A short, safe argument hint for the inbox title — never the full payload. */
function argHint(args: Record<string, unknown>): string {
  let s: string
  try {
    s = JSON.stringify(args)
  } catch {
    return ''
  }
  if (s === '{}' || s === undefined) return ''
  if (s.length > 80) s = s.slice(0, 79) + '…'
  return `(${s})`
}

/** Flatten an MCP result's content blocks to text for the LLM tool result. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as LlmContentBlock[]) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}
