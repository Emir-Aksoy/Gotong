/**
 * Phase 10 M4 — `ComposedToolset`.
 *
 * Glue helper for the common case where an LlmAgent needs both an MCP
 * toolset (third-party tool servers) AND a `DispatchToolset` (the
 * Phase 10 agent-to-agent path) attached to its single `tools:` slot.
 *
 * `LlmAgent` accepts one `LlmAgentToolset`. This composer wraps N
 * toolsets behind a single facade:
 *
 *   - `listTools()` concatenates each child's tool list. If the SAME
 *     tool name is advertised by more than one child, that's a wiring
 *     collision (e.g. two DispatchToolsets, or a DispatchToolset and an
 *     MCP server exposing the same name) — `callTool` would silently
 *     first-match-route to the wrong child. R8: rather than mis-route
 *     at runtime, `listTools()` throws a typed
 *     `ComposedToolNameCollisionError` so the bug surfaces loudly at the
 *     start of the agent's tool loop (the scheduler degrades it to a
 *     `failed` task, visible in the transcript). Conventions
 *     (`<server>__<tool>` for MCP, `dispatch_task` for DispatchToolset)
 *     keep names apart in well-formed configs, so this never fires for
 *     them. A single child advertising a name twice is its own concern
 *     and is NOT treated as a composer collision.
 *   - `callTool(name, args)` routes the call to the first child whose
 *     `listTools()` advertises that name. An unknown name returns
 *     `isError: true` content rather than throwing — the LLM keeps
 *     the turn alive.
 *   - `runForTask(task, fn)` nests each child's per-task scope so
 *     every child's `runForTask` wraps `fn`. Children without a
 *     `runForTask` are skipped silently.
 *
 * Add new toolsets via the constructor or `with(...toolsets)` —
 * conscious choice to keep the composer immutable rather than expose
 * a mutator. Two agents sharing one composer instance would otherwise
 * surprise each other.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from './types.js'

/** One tool name advertised by two or more children of a ComposedToolset. */
export interface ComposedToolCollision {
  readonly name: string
  /** Indices (into the constructor's toolset array) that all advertise `name`. */
  readonly childIndices: number[]
}

/**
 * Thrown by {@link ComposedToolset.listTools} when more than one child
 * advertises the same tool name. A collision means `callTool` would
 * first-match-route to the wrong child — a wiring bug we surface loudly
 * (R8) instead of mis-routing silently at runtime.
 */
export class ComposedToolNameCollisionError extends Error {
  readonly collisions: ComposedToolCollision[]
  constructor(collisions: ComposedToolCollision[]) {
    const detail = collisions
      .map((c) => `${c.name} (children ${c.childIndices.join(', ')})`)
      .join('; ')
    super(
      `ComposedToolset: tool name(s) advertised by more than one child — ` +
        `${detail}. Collisions silently mis-route callTool; rename or split the toolsets.`,
    )
    this.name = 'ComposedToolNameCollisionError'
    this.collisions = collisions
  }
}

export class ComposedToolset implements LlmAgentToolset {
  static of(...toolsets: LlmAgentToolset[]): ComposedToolset {
    return new ComposedToolset(toolsets)
  }

  private readonly toolsets: ReadonlyArray<LlmAgentToolset>

  constructor(toolsets: ReadonlyArray<LlmAgentToolset>) {
    this.toolsets = toolsets
  }

  async listTools(): Promise<LlmToolDefinition[]> {
    const all: LlmToolDefinition[] = []
    // name -> first child index that advertised it. A later sighting from a
    // DIFFERENT index is a cross-child collision; from the SAME index (a child
    // listing a name twice) it's the child's own concern, not ours.
    const firstOwner = new Map<string, number>()
    const collisions = new Map<string, Set<number>>()
    for (let i = 0; i < this.toolsets.length; i++) {
      const tools = await this.toolsets[i]!.listTools()
      for (const td of tools) {
        const prev = firstOwner.get(td.name)
        if (prev === undefined) {
          firstOwner.set(td.name, i)
        } else if (prev !== i) {
          let set = collisions.get(td.name)
          if (!set) {
            set = new Set<number>([prev])
            collisions.set(td.name, set)
          }
          set.add(i)
        }
        all.push(td)
      }
    }
    if (collisions.size > 0) {
      throw new ComposedToolNameCollisionError(
        [...collisions.entries()].map(([name, set]) => ({
          name,
          childIndices: [...set].sort((a, b) => a - b),
        })),
      )
    }
    return all
  }

  /**
   * name → owning child. Built lazily and **rebuilt on every miss**, so a
   * name that appears later (hot-added MCP server) still routes.
   *
   * The version before this cached nothing: it re-listed every child on
   * every single tool call, and for an `McpToolset` child `listTools()` is a
   * live `tools/list` round-trip per server. 4 tool calls across 5 servers =
   * 20 round-trips spent re-deriving an answer that hadn't changed.
   *
   * Rebuild-on-miss is what keeps that loop's stated purpose intact. The
   * three ways the tool face can move, and what happens to each:
   *
   *   - **name appears** (`installMcpServer` hot-adds): first call misses →
   *     rebuild → routes. Same as before.
   *   - **name disappears** (`uninstallMcpServer`): the stale entry routes to
   *     the old child, which answers with its own honest error ("no server
   *     named 'x'" / "server 'x' is no longer live"). `LlmAgent` turns any
   *     throw from `callTool` into an `isError` tool result (agent.ts), so the
   *     turn survives either way — and that error names the actual problem,
   *     where the old code could only say "unknown tool".
   *   - **name moves between children**: the next miss rebuilds the whole map,
   *     so stale entries don't outlive a rebuild.
   *
   * `listTools()` is deliberately NOT cached: it's the once-per-task snapshot
   * `LlmAgent` takes (agent.ts `runToolLoop`), and hot-add propagation is
   * documented to ride on exactly that (`local-agent-pool.installMcpServer`).
   */
  private route = new Map<string, LlmAgentToolset>()
  private rebuilding: Promise<void> | null = null

  private rebuildRoute(): Promise<void> {
    // Concurrent misses share one rebuild — otherwise parallel tool_use with
    // N unknown names fans out N full listTools sweeps, the very thing this
    // cache exists to kill.
    if (this.rebuilding) return this.rebuilding
    const p = (async () => {
      const next = new Map<string, LlmAgentToolset>()
      for (const t of this.toolsets) {
        for (const td of await t.listTools()) {
          // First-match-wins, mirroring the old loop's order. Collisions are
          // `listTools()`'s job to shout about (and it runs first, per task);
          // re-deciding that here would only change WHERE the same wiring bug
          // surfaces.
          if (!next.has(td.name)) next.set(td.name, t)
        }
      }
      this.route = next
    })().finally(() => {
      if (this.rebuilding === p) this.rebuilding = null
    })
    this.rebuilding = p
    return p
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<LlmToolCallResult> {
    let owner = this.route.get(name)
    if (!owner) {
      await this.rebuildRoute()
      owner = this.route.get(name)
    }
    if (owner) return owner.callTool(name, args)
    return {
      content: [
        {
          type: 'text',
          text: `unknown tool: ${name}`,
        },
      ],
      isError: true,
    }
  }

  /**
   * Nest each child's `runForTask` so the composed scope wraps
   * `fn` once per child. Children without `runForTask` are skipped.
   * Implementation note: `reduceRight` makes the FIRST toolset's
   * scope the OUTERMOST — matches the order in which children were
   * added, which is the least-surprise default for ALS-style state.
   */
  runForTask<T>(
    task: {
      readonly id: string
      readonly from: string
      readonly ancestry?: ReadonlyArray<{ taskId: string; by: string }>
    },
    fn: () => Promise<T>,
  ): Promise<T> {
    const layers = this.toolsets
      .filter((t): t is LlmAgentToolset & Required<Pick<LlmAgentToolset, 'runForTask'>> =>
        typeof t.runForTask === 'function',
      )
      .map((t) => t.runForTask.bind(t))
    if (layers.length === 0) return fn()
    const composed = layers.reduceRight<() => Promise<T>>(
      (next, layer) => () => layer(task, next),
      fn,
    )
    return composed()
  }
}
