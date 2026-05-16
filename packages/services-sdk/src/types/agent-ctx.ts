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
}

/** Convenience: an empty ctx — same object reuse, no garbage. */
export const EMPTY_SERVICE_CTX: ServiceCtx = Object.freeze({})
