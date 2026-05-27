/**
 * Phase 10 M1 — `DispatchToolset`.
 *
 * Lets an `LlmAgent` spawn sub-tasks via its tool-use loop. The toolset
 * implements `LlmAgentToolset` (same shape as `McpToolset`) and exposes a
 * single `dispatch_task` tool that wraps `Hub.dispatch`. The LLM picks a
 * target (by agentId or by capability), supplies a payload, and the
 * sub-task's `TaskResult` comes back as the tool result.
 *
 * # Why it matters
 * Without this, an LlmAgent can only call MCP tools — i.e. side-effecting
 * helpers. With it, the agent can orchestrate other agents on the hub:
 * "writer, give me 3 paragraphs", "reviewer, rate this", and so on. The
 * coordinator/architect pattern moves from being a workflow-runner
 * concern up into the agent itself.
 *
 * # Authorization model
 * Allow-lists (`allowedAgents`, `allowedCapabilities`) are the only gate.
 * A target outside the list comes back as `isError: true` content instead
 * of an exception so the LLM can recover and try a different target
 * within the same turn.
 *
 * # What the LLM cannot set
 * `weight`, `countContribution`, `origin` are intentionally NOT exposed
 * on the tool input. Those are publisher / federation policy fields; the
 * agent has no business claiming them.
 */

import type {
  DispatchStrategy,
  ParticipantId,
  TaskResult,
} from '@aipehub/core'
import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from './types.js'

/**
 * Minimal subset of `Hub.dispatch` that the toolset needs. `Hub` itself
 * trivially satisfies this — the extra optional fields it accepts
 * (`weight`, `countContribution`, `origin`) are policy fields the
 * toolset deliberately does not expose to the LLM.
 *
 * Defining a narrow surface (rather than depending on the concrete
 * `Hub`) keeps the toolset testable with a one-line vi.fn() mock.
 */
export interface DispatchSurface {
  dispatch(opts: {
    from: ParticipantId
    strategy: DispatchStrategy
    payload: unknown
    title?: string
    deadlineMs?: number
    priority?: number
  }): Promise<TaskResult>
}

export interface DispatchToolsetOptions {
  /** Hub-shaped surface to forward dispatches into. */
  hub: DispatchSurface
  /** Agent's own ParticipantId — stamped as `from` on every dispatch. */
  selfId: ParticipantId
  /**
   * Explicit-dispatch allow-list. `dispatch_task({agentId: ...})` succeeds
   * only when the id is in this set. Empty / omitted = explicit dispatch
   * disabled.
   */
  allowedAgents?: readonly ParticipantId[]
  /**
   * Capability-dispatch allow-list. `dispatch_task({capability: ...})`
   * succeeds only when the name is in this set. Empty / omitted =
   * capability dispatch disabled.
   */
  allowedCapabilities?: readonly string[]
  /**
   * Override the tool name. Defaults to `'dispatch_task'`. Useful when
   * an agent has multiple dispatch toolsets attached (e.g. local +
   * cross-hub in Phase 10 M3) and they need distinct tool names.
   */
  toolName?: string
}

/**
 * `LlmAgentToolset` that exposes `Hub.dispatch` as a single tool. Drop
 * directly into `new LlmAgent({ tools: dispatchToolset })`, same as
 * `McpToolset`. Multiple toolsets can be combined later by wrapping
 * them in a fan-out toolset (not part of M1).
 */
export class DispatchToolset implements LlmAgentToolset {
  static create(opts: DispatchToolsetOptions): DispatchToolset {
    return new DispatchToolset(opts)
  }

  private readonly hub: DispatchSurface
  private readonly selfId: ParticipantId
  private readonly allowedAgents: ReadonlySet<ParticipantId>
  private readonly allowedCapabilities: ReadonlySet<string>
  private readonly toolName: string

  private constructor(opts: DispatchToolsetOptions) {
    this.hub = opts.hub
    this.selfId = opts.selfId
    this.allowedAgents = new Set(opts.allowedAgents ?? [])
    this.allowedCapabilities = new Set(opts.allowedCapabilities ?? [])
    this.toolName = opts.toolName ?? 'dispatch_task'
  }

  listTools(): LlmToolDefinition[] {
    return [
      {
        name: this.toolName,
        description:
          'Dispatch a sub-task to another agent on this hub. Use `agentId` ' +
          'to address a specific participant, or `capability` to let the hub ' +
          'pick one by capability. Returns the sub-task result synchronously.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: {
              type: 'string',
              description: agentIdDescription(this.allowedAgents),
            },
            capability: {
              type: 'string',
              description: capabilityDescription(this.allowedCapabilities),
            },
            payload: {
              description:
                'JSON-serialisable payload delivered to the sub-task as `task.payload`.',
            },
            title: {
              type: 'string',
              description:
                'Short human-readable label shown in the transcript.',
            },
            deadlineMs: {
              type: 'number',
              description:
                'Wall-clock deadline in ms since epoch. Task fails with ' +
                "`deadline_expired` if not dispatched by then.",
            },
            priority: {
              type: 'number',
              description:
                'Higher = more urgent. Ignored by schedulers without a priority queue.',
            },
          },
          required: ['payload'],
        },
      },
    ]
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<LlmToolCallResult> {
    if (name !== this.toolName) {
      return errorResult(`unknown tool: ${name}`)
    }
    const agentId =
      typeof args.agentId === 'string' && args.agentId.length > 0
        ? (args.agentId as ParticipantId)
        : undefined
    const capability =
      typeof args.capability === 'string' && args.capability.length > 0
        ? args.capability
        : undefined
    if (!agentId && !capability) {
      return errorResult('must provide either `agentId` or `capability`')
    }
    if (agentId && capability) {
      return errorResult('`agentId` and `capability` are mutually exclusive')
    }
    // `'payload' in args` rather than `args.payload === undefined` so
    // `payload: null` and `payload: 0` aren't rejected.
    if (!('payload' in args)) {
      return errorResult('missing `payload` field')
    }
    let strategy: DispatchStrategy
    if (agentId) {
      if (!this.allowedAgents.has(agentId)) {
        return errorResult(`agentId '${agentId}' not in allow-list`)
      }
      strategy = { kind: 'explicit', to: agentId }
    } else {
      // `capability` is guaranteed defined by the earlier branch check.
      if (!this.allowedCapabilities.has(capability!)) {
        return errorResult(`capability '${capability}' not in allow-list`)
      }
      strategy = { kind: 'capability', capabilities: [capability!] }
    }

    try {
      const result = await this.hub.dispatch({
        from: this.selfId,
        strategy,
        payload: args.payload,
        title: typeof args.title === 'string' ? args.title : undefined,
        deadlineMs:
          typeof args.deadlineMs === 'number' ? args.deadlineMs : undefined,
        priority:
          typeof args.priority === 'number' ? args.priority : undefined,
      })
      return mapResultToToolResult(result)
    } catch (err) {
      return errorResult(
        `dispatch threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

function agentIdDescription(allowed: ReadonlySet<ParticipantId>): string {
  const base = 'Target participant id. Mutually exclusive with `capability`. '
  return allowed.size > 0
    ? `${base}Allow-list: ${Array.from(allowed).join(', ')}.`
    : `${base}No agents are allow-listed — leave empty and use \`capability\` instead.`
}

function capabilityDescription(allowed: ReadonlySet<string>): string {
  const base =
    'Capability name; the hub picks a participant offering it. ' +
    'Mutually exclusive with `agentId`. '
  return allowed.size > 0
    ? `${base}Allow-list: ${Array.from(allowed).join(', ')}.`
    : `${base}No capabilities are allow-listed — leave empty and use \`agentId\` instead.`
}

function errorResult(message: string): LlmToolCallResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  }
}

function mapResultToToolResult(result: TaskResult): LlmToolCallResult {
  if (result.kind === 'ok') {
    // String outputs ride through verbatim — the LLM almost always wants
    // them as raw text. Everything else gets JSON-stringified.
    const text =
      typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output ?? null)
    return {
      content: [{ type: 'text', text }],
    }
  }
  // Flatten the non-ok union onto a single error string so the LLM
  // doesn't have to parse a structured shape.
  let reason: string
  switch (result.kind) {
    case 'failed':
      reason = result.error
      break
    case 'cancelled':
    case 'no_participant':
      reason = result.reason
      break
  }
  return {
    content: [
      {
        type: 'text',
        text: `sub-task ${result.taskId} ${result.kind}: ${reason}`,
      },
    ],
    isError: true,
  }
}
