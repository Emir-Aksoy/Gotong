/**
 * Reusable IM router — `ImMessage` in, `Hub.dispatch` out.
 *
 * This is the glue that lets ANY `@aipehub/im-*` bridge talk to the
 * Hub. The shape is deliberately copy-paste-able into a production
 * host: import the bridges you actually want, wire each through
 * `createImRouter` (or call `handleImMessage` directly), and that's
 * the integration done.
 *
 * Why an example-internal module instead of a published package?
 *
 *   1. The 6 concrete bridges already pull in `@aipehub/im-adapter`;
 *      a separate `@aipehub/im-router` would mostly re-export it.
 *   2. Real hosts will want to fork this with their own command
 *      vocabulary (e.g. add `/quota`, `/whoami`). Inlining keeps the
 *      authoring path obvious.
 *   3. There's exactly one caller right now (this example). Promoting
 *      to a package can happen the first time we have a second.
 *
 * The router does NOT touch identity, LLM, or workflow registries
 * directly — those are passed in as small interfaces. That keeps
 * unit-testing trivial (fake every dependency in ten lines) and
 * doesn't drag identity-internal concerns into the IM hot path.
 */

import type {
  ImBridge,
  ImBindingResolver,
  ImMessage,
  ImUser,
} from '@aipehub/im-adapter'
import { parseImCommand } from '@aipehub/im-adapter'
import type { DispatchStrategy, Hub, TaskResult } from '@aipehub/core'

// ---------------------------------------------------------------------------
// Hooks the host provides to the router.
// ---------------------------------------------------------------------------

/**
 * Optional unbind hook. The base `ImBindingResolver` interface only
 * exposes `claim` (consume a code) — actually removing a binding
 * requires a host-side handle on the identity store. Bridges that
 * support `/unbind` wire a thin closure here; others omit and the
 * router replies with a "this bridge doesn't support unbind" line.
 */
export type ImRouterUnbindHook = (
  platform: string,
  platformUserId: string,
) => Promise<{ removed: boolean }>

/**
 * Optional workflow lookup. Returns the dispatch input for `/workflow
 * <name> <args>` or null when the name is unknown. Resolved against
 * the user's identity so a host CAN scope workflows per-org / per-role
 * (the demo lookup is global for brevity).
 */
export type ImRouterWorkflowResolver = (input: {
  name: string
  args: string
  userId: string
}) => Promise<{
  payload: unknown
  strategy: DispatchStrategy
  title?: string
} | null>

/**
 * Optional agent listing. Returns a human-readable line per agent the
 * user can talk to. Used for `/agents`. When absent, the router prints
 * a generic "no listing available" reply — that's still better than
 * silently dropping the command.
 */
export type ImRouterAgentLister = (userId: string) => Promise<string[]>

// ---------------------------------------------------------------------------
// Router config + factory.
// ---------------------------------------------------------------------------

export interface ImRouterConfig {
  hub: Hub
  resolver: ImBindingResolver
  /**
   * Where free-form text gets dispatched when the user IS bound but
   * didn't type a recognised command. Most hosts want `{ kind:
   * 'capability', capabilities: ['chat'] }` so any LlmAgent that
   * advertises 'chat' picks up; explicit single-agent routing is also
   * supported.
   *
   * `payloadFn` builds the dispatch payload from the IM message. The
   * default emits `{ text, attachments }` which matches what most
   * `LlmAgent`-backed handlers expect.
   */
  freeTextDispatch: {
    strategy: DispatchStrategy
    payloadFn?: (msg: ImMessage, userId: string) => unknown
  }
  /** Optional `/unbind` hook. See {@link ImRouterUnbindHook}. */
  onUnbind?: ImRouterUnbindHook
  /** Optional `/workflow <name>` resolver. */
  resolveWorkflow?: ImRouterWorkflowResolver
  /** Optional `/agents` lister. */
  listAgents?: ImRouterAgentLister
  /**
   * Optional copy override for the help message. Defaults to the
   * canonical English / Chinese mix you can read in `defaultHelpText`.
   * Override per-deployment for localisation.
   */
  helpText?: string
  /**
   * Optional structured logger. Defaults to `console.error` for
   * warnings and silent for info — keeping the demo readable. Real
   * hosts pass `@aipehub/host`'s logger.
   */
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
}

export const defaultHelpText = [
  'AipeHub IM bridge — recognised commands:',
  '',
  '  /help                  — show this list',
  '  /bind <code>           — link this IM identity to your AipeHub account',
  '                           (issue a code in the admin UI → Profile → Bind IM)',
  '  /unbind                — drop the binding',
  '  /agents                — list the agents you can talk to',
  '  /workflow <name> <args>— kick off a named workflow',
  '  <anything else>        — free chat with your default agent',
].join('\n')

/**
 * Build a router instance. The returned object is essentially a
 * single-message handler — concrete bridges call `handle(bridge, msg)`
 * from inside their `onMessage` subscription.
 */
export function createImRouter(config: ImRouterConfig): {
  handle(bridge: ImBridge, msg: ImMessage): Promise<void>
} {
  const log = config.log ?? ((lvl, m, e) => {
    if (lvl !== 'info') console.error(`[im-router/${lvl}] ${m}`, e ?? '')
  })

  return {
    async handle(bridge, msg) {
      try {
        await handleImMessage(bridge, msg, config, log)
      } catch (err) {
        // Top-level safety net: a single bad message MUST NOT take
        // down the bridge's message loop. Concrete bridges already
        // catch listener throws (each does so in its own loop), but
        // doubling up here keeps the example self-contained and
        // demonstrates the contract to anyone copying this code.
        log('error', 'router.handle failed', err)
        try {
          await bridge.sendMessage(
            msg.from,
            '抱歉 / sorry — internal error handling that message. The host operator has been notified.',
            { chatId: msg.chatId },
          )
        } catch (sendErr) {
          log('error', 'router.handle failed to send error reply', sendErr)
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Core handler — exported separately so tests can drive it without a
// router instance, and so other glue layers can wrap.
// ---------------------------------------------------------------------------

export async function handleImMessage(
  bridge: ImBridge,
  msg: ImMessage,
  config: ImRouterConfig,
  log: NonNullable<ImRouterConfig['log']>,
): Promise<void> {
  const platform = bridge.platform
  const cmd = parseImCommand(msg.text ?? '')

  // /help is the one command that doesn't need a binding — anyone can
  // ask. Same for /bind by definition. Everything else requires the
  // user to be bound first; we look that up once here.
  if (cmd.kind === 'help') {
    await reply(bridge, msg, config.helpText ?? defaultHelpText)
    return
  }

  if (cmd.kind === 'bind') {
    const result = await config.resolver.claim({
      code: cmd.code,
      platform,
      platformUserId: msg.from.platformUserId,
      displayName: msg.from.displayName ?? null,
    })
    if (result.ok) {
      log('info', `bind ok platform=${platform} user=${result.userId}`)
      await reply(
        bridge,
        msg,
        `✓ Bound. You're now signed in as ${result.userId}. Type /help for what you can do.`,
      )
      return
    }
    const detail =
      result.reason === 'expired'
        ? 'that code has expired — please issue a fresh one in the admin UI (Profile → Bind IM).'
        : "that code wasn't recognised. Double-check, or issue a fresh one in the admin UI (Profile → Bind IM)."
    await reply(bridge, msg, `✗ Bind failed — ${detail}`)
    return
  }

  // From here on, the user must be bound. Resolve once.
  const userId = await config.resolver.resolveUserId(
    platform,
    msg.from.platformUserId,
  )
  if (userId === null) {
    await reply(
      bridge,
      msg,
      'You haven\'t linked your AipeHub account yet. Go to the admin UI → Profile → Bind IM to get a 6-digit code, then DM me `/bind <code>`.',
    )
    return
  }

  switch (cmd.kind) {
    case 'unbind': {
      if (!config.onUnbind) {
        await reply(
          bridge,
          msg,
          "This bridge wasn't configured with an unbind hook. Ask the host operator to remove the binding for you.",
        )
        return
      }
      const out = await config.onUnbind(platform, msg.from.platformUserId)
      await reply(
        bridge,
        msg,
        out.removed ? '✓ Unbound. Send /bind <code> again to re-link.' : 'Nothing to unbind.',
      )
      return
    }

    case 'agents': {
      if (!config.listAgents) {
        await reply(
          bridge,
          msg,
          'No agent listing is configured on this host. Try a free-text message — it goes to your default agent.',
        )
        return
      }
      const list = await config.listAgents(userId)
      const body =
        list.length === 0
          ? 'No agents are currently reachable for your account.'
          : ['Agents you can talk to:', '', ...list.map((l) => `  • ${l}`)].join('\n')
      await reply(bridge, msg, body)
      return
    }

    case 'workflow': {
      if (!config.resolveWorkflow) {
        await reply(
          bridge,
          msg,
          'Workflow dispatch is not enabled on this host.',
        )
        return
      }
      const wf = await config.resolveWorkflow({
        name: cmd.name,
        args: cmd.args,
        userId,
      })
      if (wf === null) {
        await reply(bridge, msg, `Unknown workflow: \`${cmd.name}\`.`)
        return
      }
      const result = await config.hub.dispatch({
        from: makeFromId(platform, msg.from.platformUserId),
        strategy: wf.strategy,
        payload: wf.payload,
        title: wf.title ?? `im:${platform}:workflow:${cmd.name}`,
        origin: { orgId: 'local', userId },
      })
      await reply(bridge, msg, summariseResult(result))
      return
    }

    case 'free': {
      const buildPayload =
        config.freeTextDispatch.payloadFn ??
        ((m: ImMessage) => ({
          text: m.text,
          ...(m.attachments && m.attachments.length > 0
            ? { attachments: m.attachments }
            : {}),
        }))
      const result = await config.hub.dispatch({
        from: makeFromId(platform, msg.from.platformUserId),
        strategy: config.freeTextDispatch.strategy,
        payload: buildPayload(msg, userId),
        title: `im:${platform}`,
        origin: { orgId: 'local', userId },
      })
      await reply(bridge, msg, summariseResult(result))
      return
    }

    default: {
      // Exhaustiveness — switch covers all ImCommand kinds we care
      // about; an unknown one means parseImCommand changed shape.
      const _exhaustive: never = cmd
      log('warn', 'router: unhandled command kind', { cmd: _exhaustive })
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Build the `from` participant id used as `Task.from`. Embedding the
 * platform + user lets the transcript reader tell apart e.g. "the same
 * user typed this in Telegram vs Slack", without conflating with
 * AipeHub-internal user ids.
 *
 * The actual *AipeHub* user id goes into `Task.origin.userId` so the
 * quota gate / audit log / per-user routing can use it. `from` is the
 * loose human-readable wrapper for transcript display.
 */
function makeFromId(platform: string, platformUserId: string): string {
  return `im:${platform}:${platformUserId}`
}

async function reply(bridge: ImBridge, msg: ImMessage, text: string): Promise<void> {
  const to: ImUser = msg.from
  await bridge.sendMessage(to, text, { chatId: msg.chatId })
}

function summariseResult(result: TaskResult): string {
  switch (result.kind) {
    case 'ok': {
      // Common case: an LlmAgent that returned `{ text: '…' }`. Strip
      // it out for a clean IM reply. Anything else gets stringified.
      const output = result.output
      if (
        typeof output === 'object' &&
        output !== null &&
        'text' in output &&
        typeof (output as { text: unknown }).text === 'string'
      ) {
        return (output as { text: string }).text
      }
      try {
        return '```\n' + JSON.stringify(output, null, 2) + '\n```'
      } catch {
        return String(output)
      }
    }
    case 'failed':
      return `⚠️ Task failed: ${result.error}`
    case 'cancelled':
      return `⚠️ Task cancelled: ${result.reason}`
    case 'suspended':
      return `⏸ Task suspended; the agent will resume around ${new Date(result.resumeAt).toISOString()}.`
    case 'no_participant':
      return `⚠️ No agent picked it up: ${result.reason}`
  }
}
