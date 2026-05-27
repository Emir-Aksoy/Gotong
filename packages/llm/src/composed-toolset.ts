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
 *   - `listTools()` concatenates each child's tool list. Name
 *     collisions are NOT resolved here; conventions (`<server>__<tool>`
 *     for MCP, `dispatch_task` for DispatchToolset) keep them apart
 *     in practice. Documented as "first match wins" if anyone breaks
 *     the convention.
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
    for (const t of this.toolsets) {
      const tools = await t.listTools()
      for (const td of tools) all.push(td)
    }
    return all
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<LlmToolCallResult> {
    // Find the first child that advertises the name. Loop instead of
    // building a name→toolset Map up-front so toolsets that mutate
    // their tool list at runtime (some MCP servers add tools on
    // demand) are still routed correctly.
    for (const t of this.toolsets) {
      const tools = await t.listTools()
      if (tools.some((td) => td.name === name)) {
        return t.callTool(name, args)
      }
    }
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
