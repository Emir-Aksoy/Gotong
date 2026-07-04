/**
 * REPL hub bootstrap — spin up an in-memory `Hub` with a small set of
 * default agents so `gotong repl` is useful out of the box.
 *
 * Design choices:
 *
 *   1. **In-memory only.** No `space:` config — REPL state is
 *      ephemeral by design (transcript dies with the process). Users
 *      who want persistence should run the full `gotong host` and
 *      connect via M13 remote REPL (TODO Phase 13).
 *
 *   2. **Default echo agent.** Capability `chat`, matches what the
 *      M8 IM router uses as default capability. Lets a user type
 *      something and see the dispatch round-trip without configuring
 *      anything.
 *
 *   3. **No LLM provider wired in by default.** Pulling an LLM
 *      provider into the CLI bundle would add anthropic-sdk / openai
 *      transitively (~5 MB on install). REPL stays text-only by
 *      default; users wanting a real model fork this bootstrap (it's
 *      the documented extension point — see `injectAgent` opt).
 *
 *   4. **`injectAgent` hook.** Programmatic callers (tests, demo
 *      hosts) can register additional agents before the loop starts.
 *      Each callback returns a `Participant` and gets `hub` so it
 *      can subscribe to events too.
 */

import {
  AgentParticipant,
  Hub,
  type Participant,
  type Task,
} from '@gotong/core'

export interface ReplHubHandle {
  hub: Hub
  /**
   * The capability strategy that free-text dispatches use. Defaults
   * to `['chat']` — matching the IM bridge router contract so the
   * mental model carries over.
   */
  defaultCapability: readonly string[]
  /**
   * Stop the hub and release resources. Idempotent.
   */
  shutdown(): Promise<void>
}

export interface CreateReplHubOpts {
  /**
   * Override the default echo agent. Pass `null` to disable the
   * default and rely entirely on `injectAgents`.
   */
  defaultAgent?: Participant | null
  /**
   * Register additional participants. Run after `defaultAgent` (so
   * the echo agent shows up first in `:agents` output by default).
   */
  injectAgents?: (hub: Hub) => Iterable<Participant> | Promise<Iterable<Participant>>
  /**
   * Override the free-text dispatch capability. Default `['chat']`.
   */
  defaultCapability?: readonly string[]
}

/**
 * Boots a hub, registers default + injected participants, returns a
 * handle the loop / tests can drive.
 */
export async function createReplHub(opts: CreateReplHubOpts = {}): Promise<ReplHubHandle> {
  const hub = Hub.inMemory()
  await hub.start()

  if (opts.defaultAgent !== null) {
    const agent = opts.defaultAgent ?? new ReplEchoAgent()
    hub.register(agent)
  }

  if (opts.injectAgents) {
    for (const a of await opts.injectAgents(hub)) {
      hub.register(a)
    }
  }

  let stopped = false
  return {
    hub,
    defaultCapability: opts.defaultCapability ?? ['chat'],
    async shutdown() {
      if (stopped) return
      stopped = true
      await hub.stop()
    },
  }
}

/**
 * Minimal `chat` agent for the REPL. Echoes the user's text with a
 * tiny "echo:" prefix so they can see the dispatch round-tripped.
 *
 * Public so other examples / tests can re-use it (e.g. M8 IM bridge
 * host's similar fallback agent). Kept here rather than in core
 * because it's REPL-default policy, not framework primitive.
 */
export class ReplEchoAgent extends AgentParticipant {
  constructor(id = 'chat') {
    super({ id, capabilities: ['chat'] })
  }
  protected async handleTask(task: Task): Promise<unknown> {
    const text =
      typeof task.payload === 'object' &&
      task.payload !== null &&
      'text' in task.payload &&
      typeof (task.payload as { text: unknown }).text === 'string'
        ? (task.payload as { text: string }).text
        : '(no text)'
    return {
      text: `echo: ${text}`,
    }
  }
}
