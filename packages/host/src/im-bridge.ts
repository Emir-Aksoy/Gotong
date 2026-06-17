/**
 * Production IM bridge wiring — folds the example's IM router glue into
 * the host so a real Telegram bot can drive the hub.
 *
 * OFF by default: with `AIPE_TELEGRAM_BOT_TOKEN` unset, `startImBridges()`
 * returns `undefined` and nothing changes — exactly how the A2A / ACP
 * outbound managers stay inert without their env. That zero-behaviour-
 * change-when-unset property is the whole point of an env gate: an
 * existing deployment that doesn't want IM is byte-for-byte unaffected.
 *
 * Why inline the router here instead of importing from
 * `examples/im-bridge-host`:
 *
 *   1. The host can't depend on an example package (examples are leaves,
 *      not workspace deps of host).
 *   2. The host tailors the free-text capability, agent listing, and
 *      logger; the example stays the standalone teaching reference.
 *
 * The shape is the same one proved out in the example — `ImMessage` in →
 * `Hub.dispatch` out — and it's deliberately small so a host operator can
 * read the whole integration in one file.
 *
 * Binding model (unchanged): a member issues a 6-digit code in the admin
 * UI / `/me`, then DMs the bot `/bind <code>`. The binding maps
 * `platform + platformUserId → AipeHub userId`. Every dispatch carries
 * `origin.userId`, so the quota gate / audit log attribute work to the
 * real member — never to the raw IM handle (which goes only into
 * `Task.from` for transcript display).
 */

import type { DispatchStrategy, Hub, TaskResult } from '@aipehub/core'
import { IdentityError, type IdentityStore } from '@aipehub/identity'
import {
  parseImCommand,
  type ClaimResult,
  type ImBindingResolver,
  type ImBridge,
  type ImMessage,
  type ImUser,
} from '@aipehub/im-adapter'
import { TelegramBridge } from '@aipehub/im-telegram'
import { QqBridge } from '@aipehub/im-qq'
import { LarkBridge } from '@aipehub/im-lark'
import { SlackBridge, type WebSocketCtor as SlackWebSocketCtor } from '@aipehub/im-slack'
import { WebSocket as NodeWebSocket } from 'ws'

/**
 * Minimal structural logger — the host's `@aipehub/core` `Logger`
 * satisfies it. Declaring it locally keeps this module from importing a
 * concrete logger and keeps the unit test's fake one line long.
 */
export interface ImLogger {
  info(msg: string, ctx?: Record<string, unknown>): void
  warn(msg: string, ctx?: Record<string, unknown>): void
  error(msg: string, ctx?: Record<string, unknown>): void
}

// ---------------------------------------------------------------------------
// Identity binding resolver — lifts the sync, throw-based `IdentityStore`
// into the Promise / discriminated-result `ImBindingResolver` contract.
// (Same translation as examples/im-bridge-host/src/identity-resolver.ts;
// the throw → result conversion is required because IM users typing wrong
// codes is the COMMON path, not an exception.)
// ---------------------------------------------------------------------------

export function makeIdentityImBindingResolver(
  store: IdentityStore,
): ImBindingResolver {
  return {
    async resolveUserId(platform, platformUserId) {
      return store.getUserIdByImBinding(platform, platformUserId)
    },
    async claim(input): Promise<ClaimResult> {
      try {
        const result = store.claimImBindingCode({
          code: input.code,
          platform: input.platform,
          platformUserId: input.platformUserId,
          displayName: input.displayName ?? null,
        })
        return { ok: true, userId: result.userId }
      } catch (err) {
        if (err instanceof IdentityError) {
          if (err.code === 'im_binding_code_invalid') return { ok: false, reason: 'invalid' }
          if (err.code === 'im_binding_code_expired') return { ok: false, reason: 'expired' }
        }
        // Anything else is infra failure — let the bridge's catch surface it.
        throw err
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

/** Optional `/agents` lister — returns one human line per reachable agent. */
export type ImAgentLister = (userId: string) => Promise<string[]>

/** Optional `/workflow <name> <args>` resolver — null when name unknown. */
export type ImWorkflowResolver = (input: {
  name: string
  args: string
  userId: string
}) => Promise<{ payload: unknown; strategy: DispatchStrategy; title?: string } | null>

export interface HostImConfig {
  hub: Hub
  resolver: ImBindingResolver
  /** Capability free-text messages dispatch against. Host default 'chat'. */
  freeTextCapability: string
  /** Removes a binding for `/unbind`. */
  onUnbind: (platform: string, platformUserId: string) => Promise<{ removed: boolean }>
  /** Optional `/agents` lister; absent → router replies "not configured". */
  listAgents?: ImAgentLister
  /** Optional `/workflow` resolver; absent → router replies "not enabled". */
  resolveWorkflow?: ImWorkflowResolver
  log: ImLogger
}

const HELP_TEXT = [
  'AipeHub IM bridge — commands:',
  '',
  '  /help                   — show this list',
  '  /bind <code>            — link this IM identity to your AipeHub account',
  '                            (issue a code in the admin UI / 我的 → 绑定 IM)',
  '  /unbind                 — drop the binding',
  '  /agents                 — list agents you can talk to',
  '  /workflow <name> <args> — start a named workflow',
  '  <anything else>         — chat with your default agent',
].join('\n')

/**
 * Handle one inbound IM message. Exported so the hermetic test can drive
 * it directly with a fake bridge — no real token, no poll loop.
 */
export async function handleImMessage(
  bridge: ImBridge,
  msg: ImMessage,
  config: HostImConfig,
): Promise<void> {
  const platform = bridge.platform
  const cmd = parseImCommand(msg.text ?? '')

  // /help and /bind are the two commands that work before binding.
  if (cmd.kind === 'help') {
    await reply(bridge, msg, HELP_TEXT)
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
      config.log.info('im bind ok', { platform, userId: result.userId })
      await reply(bridge, msg, `✓ 已绑定 / Bound — signed in as ${result.userId}. Send /help for what you can do.`)
      return
    }
    const detail =
      result.reason === 'expired'
        ? '该绑定码已过期，请在管理界面 / 我的 重新生成。/ that code expired — issue a fresh one.'
        : '未识别该绑定码，请核对或重新生成。/ that code wasn\'t recognised — double-check or issue a fresh one.'
    await reply(bridge, msg, `✗ 绑定失败 / Bind failed — ${detail}`)
    return
  }

  // Everything below requires a binding. Resolve once.
  const userId = await config.resolver.resolveUserId(platform, msg.from.platformUserId)
  if (userId === null) {
    await reply(
      bridge,
      msg,
      '你还没有绑定 AipeHub 账户。在管理界面 / 我的 生成 6 位绑定码，然后私信我 `/bind <code>`。\n' +
        'You haven\'t linked your account yet — get a code in the admin UI / 我的, then DM me `/bind <code>`.',
    )
    return
  }

  switch (cmd.kind) {
    case 'unbind': {
      const out = await config.onUnbind(platform, msg.from.platformUserId)
      await reply(
        bridge,
        msg,
        out.removed ? '✓ 已解绑 / Unbound. Send /bind <code> to re-link.' : 'Nothing to unbind.',
      )
      return
    }

    case 'agents': {
      if (!config.listAgents) {
        await reply(bridge, msg, 'No agent listing is configured — just send a message; it goes to your default agent.')
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
        await reply(bridge, msg, 'Workflow dispatch is not enabled on this host.')
        return
      }
      const wf = await config.resolveWorkflow({ name: cmd.name, args: cmd.args, userId })
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
      const result = await config.hub.dispatch({
        from: makeFromId(platform, msg.from.platformUserId),
        strategy: { kind: 'capability', capabilities: [config.freeTextCapability] },
        payload: {
          text: msg.text,
          ...(msg.attachments && msg.attachments.length > 0 ? { attachments: msg.attachments } : {}),
        },
        title: `im:${platform}`,
        origin: { orgId: 'local', userId },
      })
      await reply(bridge, msg, summariseResult(result))
      return
    }

    default: {
      // Exhaustiveness guard — if parseImCommand grows a kind we don't
      // handle, the type error fires here at build time.
      const _exhaustive: never = cmd
      config.log.warn('im router: unhandled command kind', { cmd: _exhaustive })
    }
  }
}

// ---------------------------------------------------------------------------
// Start — env-gated entry point wired from main.ts.
// ---------------------------------------------------------------------------

export interface StartImBridgesOptions {
  hub: Hub
  identity: IdentityStore
  log: ImLogger
  /** Defaults to env `AIPE_IM_CHAT_CAPABILITY` or 'chat'. */
  freeTextCapability?: string
  listAgents?: ImAgentLister
  resolveWorkflow?: ImWorkflowResolver
}

export interface ImBridgesHandle {
  readonly bridges: ImBridge[]
  stop(): Promise<void>
}

/**
 * Construct and start every configured IM bridge. Each platform is
 * INDEPENDENTLY env-gated: its bridge is built only when its env vars are
 * present, so an operator turns on exactly the platforms they want. With
 * none set, `startImBridges()` returns `undefined` and nothing changes —
 * the zero-behaviour-change property an env gate exists for.
 *
 * The router (`handleImMessage`) is transport-agnostic — it depends only
 * on the `ImBridge` contract — so all four platforms share one `config`
 * and drop into one `bridges` array. They differ only in reachability:
 *
 *   - Telegram (long-poll), Lark (official long connection), and Slack
 *     (Socket Mode) dial OUT → a home box behind NAT works with no public
 *     endpoint.
 *   - QQ's official Bot API discontinued its WebSocket and pushes an
 *     INBOUND webhook (public domain + TLS), so the QQ bridge runs its own
 *     HTTP listener that an operator fronts with a reverse proxy on a
 *     cloud host. See docs/zh/IM-OFFICIAL-REARCH.md.
 *
 * Env per platform (a bridge needs ALL of its vars to activate):
 *   Telegram  AIPE_TELEGRAM_BOT_TOKEN
 *   QQ        AIPE_QQ_BOT_APPID + AIPE_QQ_BOT_SECRET
 *             (+ AIPE_QQ_WEBHOOK_PORT / _HOST / _PATH to tune the listener)
 *   Lark      AIPE_LARK_APP_ID + AIPE_LARK_APP_SECRET
 *   Slack     AIPE_SLACK_APP_TOKEN (xapp-) + AIPE_SLACK_BOT_TOKEN (xoxb-)
 */
export async function startImBridges(
  opts: StartImBridgesOptions,
): Promise<ImBridgesHandle | undefined> {
  // Defer construction behind each env gate. Building lazily (a factory
  // per configured platform) keeps a bridge's start-time side effects —
  // QQ's HTTP listener, Slack's apps.connections.open round trip — from
  // firing for a platform the operator never configured.
  const factories: Array<() => ImBridge> = []

  const telegramToken = process.env.AIPE_TELEGRAM_BOT_TOKEN?.trim()
  if (telegramToken) {
    factories.push(
      () =>
        new TelegramBridge({
          token: telegramToken,
          onError: (err) => opts.log.warn('telegram bridge error', { err: String(err) }),
        }),
    )
  }

  const qqAppId = process.env.AIPE_QQ_BOT_APPID?.trim()
  const qqSecret = process.env.AIPE_QQ_BOT_SECRET?.trim()
  if (qqAppId && qqSecret) {
    // The official QQ Bot API is inbound-webhook only (its WS was
    // discontinued), so the bridge binds its own listener that a reverse
    // proxy terminates TLS in front of. Port 0 disables the listener for a
    // host that drives the webhook from its own HTTP layer.
    const webhookPort = parseImPort(process.env.AIPE_QQ_WEBHOOK_PORT)
    const webhookHost = process.env.AIPE_QQ_WEBHOOK_HOST?.trim()
    const webhookPath = process.env.AIPE_QQ_WEBHOOK_PATH?.trim()
    factories.push(
      () =>
        new QqBridge({
          appId: qqAppId,
          secret: qqSecret,
          ...(webhookPort !== undefined ? { webhookPort } : {}),
          ...(webhookHost ? { webhookHost } : {}),
          ...(webhookPath ? { webhookPath } : {}),
          onError: (err) => opts.log.warn('qq bridge error', { err: String(err) }),
        }),
    )
  }

  const larkAppId = process.env.AIPE_LARK_APP_ID?.trim()
  const larkAppSecret = process.env.AIPE_LARK_APP_SECRET?.trim()
  if (larkAppId && larkAppSecret) {
    factories.push(
      () =>
        new LarkBridge({
          appId: larkAppId,
          appSecret: larkAppSecret,
          onError: (err) => opts.log.warn('lark bridge error', { err: String(err) }),
        }),
    )
  }

  const slackBotToken = process.env.AIPE_SLACK_BOT_TOKEN?.trim()
  const slackAppToken = process.env.AIPE_SLACK_APP_TOKEN?.trim()
  if (slackBotToken && slackAppToken) {
    factories.push(
      () =>
        new SlackBridge({
          token: slackBotToken,
          appToken: slackAppToken,
          // Node 20 has no global WebSocket (flag-gated until 22), so hand
          // the Socket Mode client `ws`'s impl — the same dependency
          // transport-ws already uses. The cast bridges `ws`'s typings to
          // the bridge's minimal structural `WebSocketCtor`.
          webSocketImpl: NodeWebSocket as unknown as SlackWebSocketCtor,
          onError: (err) => opts.log.warn('slack bridge error', { err: String(err) }),
        }),
    )
  }

  if (factories.length === 0) return undefined

  const resolver = makeIdentityImBindingResolver(opts.identity)
  const config: HostImConfig = {
    hub: opts.hub,
    resolver,
    freeTextCapability:
      opts.freeTextCapability ?? (process.env.AIPE_IM_CHAT_CAPABILITY?.trim() || 'chat'),
    onUnbind: async (platform, platformUserId) => {
      const n = opts.identity.removeImBinding(platform, platformUserId)
      return { removed: n > 0 }
    },
    listAgents: opts.listAgents,
    resolveWorkflow: opts.resolveWorkflow,
    log: opts.log,
  }

  const bridges: ImBridge[] = []
  for (const make of factories) {
    const bridge = make()
    // A single bad message must not take down a bridge's receive loop. The
    // concrete bridge already catches listener throws; this top-level net
    // also sends the user a friendly error instead of a silent drop.
    bridge.onMessage((m) => {
      void dispatchSafely(bridge, m, config)
    })
    try {
      await bridge.start()
    } catch (err) {
      // One platform's bad credential must not abort the others or the host
      // boot (these are independent transports, mirroring the best-effort
      // A2A / ACP outbound managers). Log loudly and skip it; the platforms
      // that DO start still run. Clean up the half-started bridge so it
      // leaves no listener / socket behind.
      opts.log.error('im bridge start failed', {
        platform: bridge.platform,
        err: String(err),
      })
      try {
        await bridge.stop()
      } catch {
        /* best-effort cleanup; the start failure is the real signal */
      }
      continue
    }
    opts.log.info('IM bridge enabled', {
      platform: bridge.platform,
      freeTextCapability: config.freeTextCapability,
    })
    bridges.push(bridge)
  }

  // Every configured bridge failed to start → IM is effectively disabled.
  // Returning undefined keeps the "no shutdown hook" contract the caller
  // relies on, same as the no-env path.
  if (bridges.length === 0) return undefined

  return {
    bridges,
    async stop() {
      for (const b of bridges) {
        try {
          await b.stop()
        } catch (err) {
          opts.log.error('im bridge stop error', { platform: b.platform, err: String(err) })
        }
      }
    },
  }
}

/**
 * Parse an IM webhook port from env. Returns `undefined` for an unset or
 * malformed value (the bridge then keeps its own default); 0 is a valid,
 * meaningful value — "no built-in listener, the host drives the webhook".
 */
function parseImPort(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined
  return n
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

async function dispatchSafely(
  bridge: ImBridge,
  msg: ImMessage,
  config: HostImConfig,
): Promise<void> {
  try {
    await handleImMessage(bridge, msg, config)
  } catch (err) {
    config.log.error('im router.handle failed', { err: String(err) })
    try {
      await bridge.sendMessage(
        msg.from,
        '抱歉 / sorry — internal error handling that message. The host operator has been notified.',
        { chatId: msg.chatId },
      )
    } catch (sendErr) {
      config.log.error('im router failed to send error reply', { err: String(sendErr) })
    }
  }
}

/**
 * `Task.from` — embeds platform + platformUserId so the transcript reader
 * can tell apart "same person on Telegram vs Slack" without conflating
 * with AipeHub-internal user ids (which go into `origin.userId`).
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
      return `⏸ Task suspended; it will resume around ${new Date(result.resumeAt).toISOString()}.`
    case 'no_participant':
      return `⚠️ No agent picked it up: ${result.reason}`
  }
}
