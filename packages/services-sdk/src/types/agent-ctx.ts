/**
 * `ServiceCtx` — what an LLM agent sees when it asks "which services
 * do I have."
 *
 * Per RFC §7 "Agent ctx — what gets injected":
 *
 *   - Only services declared in `uses:` appear on ctx. An agent with
 *     no `uses:` block gets `{}` (all fields undefined).
 *   - A handle is shared across the agent's lifetime — attach once on
 *     spawn, detach on leave. Plugins are expected to be safe under
 *     concurrent task handling.
 *   - `memory` and `artifact` are singular because the yaml schema
 *     allows at most one config of each type per agent.
 *   - `datastore` is plural because an agent can declare multiple
 *     databases by different `config.name`s — keyed by that name.
 *
 * Why not signed onto `Participant.onTask(task, ctx)`: keeping the
 * Hub interface clean. The Hub doesn't know what a service is — only
 * the host (LocalAgentPool / managed-agent boot) does, and it injects
 * the ctx into the LlmAgent constructor. SDK-connected external
 * agents are free to skip services entirely.
 *
 * The type sits in `services-sdk` so the `@aipehub/llm` package can
 * import it without taking a runtime dep on the host. Agents that
 * declare `uses:` get a typed-aware ctx; agents that don't simply
 * never read it.
 */

import type { ArtifactHandle } from './artifact.js'
import type { DatastoreHandle } from './datastore.js'
import type { MemoryHandle } from './memory.js'

/**
 * Minimal task-result shape an agent sees when its nested
 * `ctx.dispatch?.dispatch(...)` call resolves. Mirrors `@aipehub/core`'s
 * `TaskResult` discriminated union but declared inline so this package
 * doesn't take a runtime dep on `core` (services-sdk → core would be a
 * reverse arrow). At the seam (LocalAgentPool wiring) we just cast.
 *
 * Callers care about three things:
 *   - `kind === 'ok'` → use `output`
 *   - `kind === 'failed'` → use `error` for log
 *   - anything else (cancelled / no_participant) → treat as "human
 *     never answered" and degrade gracefully
 */
export type AgentDispatchResult =
  | { kind: 'ok'; output: unknown; by: string; ts: number }
  | { kind: 'failed'; error: string; by: string; ts: number }
  | { kind: 'cancelled'; reason: string; ts: number }
  | { kind: 'no_participant'; reason: string; ts: number }

/**
 * Args accepted by `AgentDispatchSurface.dispatch`. Narrower than
 * `core.DispatchOpts` on purpose — nested dispatches from inside an
 * agent are for human-in-the-loop questions and similar tightly-
 * scoped flows; broader strategies (capability fan-out, weights,
 * contribution accounting) are deliberately not exposed here so that
 * agents can't accidentally trigger broad workflow side effects.
 *
 * The `kind: 'explicit'` strategy points at a single ParticipantId
 * (usually the admin who triggered the parent workflow run, available
 * on `task.from`). Use it to ask "the user who started this" a
 * follow-up question.
 */
export interface AgentDispatchOpts {
  strategy: { kind: 'explicit'; to: string }
  payload: unknown
  title?: string
  /** Optional priority hint; default behaves like 0. */
  priority?: number
}

/**
 * Reverse-direction dispatch primitive injected into an agent's
 * `ServiceCtx` by the host. Lets an agent that is currently handling
 * a task dispatch a NEW task and `await` its result before responding
 * — the building block for human-in-the-loop ("I need more info, ask
 * the user") flows.
 *
 * Design notes:
 *   - Optional on `ServiceCtx`. Agents MUST defensively handle the
 *     case where the host didn't wire it in (SDK-connected agents
 *     have no host-local hub, for instance).
 *   - The host's wiring is responsible for stamping the agent's own
 *     `id` as `from` on the nested task so accounting + audit stay
 *     coherent ("agent X asked admin Y a question").
 *   - This is intentionally NOT a full re-export of `core.dispatch`:
 *     no `wait`, `timeoutMs`, `weight`, `countContribution`, etc.
 *     Agents that need finer control should use a dedicated service.
 *
 * Re-entrancy: the Hub's dispatch is already async + queue-based, so
 * calling it from inside `onTask` is safe — the parent task will sit
 * `await`ing the nested promise without blocking the event loop.
 */
export interface AgentDispatchSurface {
  dispatch(opts: AgentDispatchOpts): Promise<AgentDispatchResult>
}

export interface ServiceCtx {
  /**
   * Per-owner memory handle. Present iff the agent yaml had a
   * `uses: [{ type: 'memory', ... }]` entry.
   */
  readonly memory?: MemoryHandle
  /**
   * Per-owner artifact handle. Present iff the agent yaml had a
   * `uses: [{ type: 'artifact', ... }]` entry.
   */
  readonly artifact?: ArtifactHandle
  /**
   * Map of datastore handles keyed by the `config.name` from yaml.
   * `undefined` (not `{}`) when no datastores were declared, so a
   * truthy check `if (ctx.datastore)` correctly distinguishes "no
   * datastores at all" from "datastores declared but empty."
   */
  readonly datastore?: Readonly<Record<string, DatastoreHandle>>
  /**
   * Third-party `type:` strings the Hub knows nothing about land
   * here. Keys are the service type name; values are whatever the
   * plugin returned from `attach`. Callers cast to a known shape at
   * the use site.
   */
  readonly extra?: Readonly<Record<string, unknown>>
  /**
   * Optional reverse-dispatch surface (v2.5). When present, the agent
   * can `await ctx.dispatch.dispatch({...})` to ask a question of
   * (e.g.) the admin who started the parent workflow and resume with
   * the answer. Absent on hosts that haven't opted in (SDK agents,
   * older host versions). Callers must null-check before using.
   */
  readonly dispatch?: AgentDispatchSurface
}

/** Convenience: an empty ctx — same object reuse, no garbage. */
export const EMPTY_SERVICE_CTX: ServiceCtx = Object.freeze({})
