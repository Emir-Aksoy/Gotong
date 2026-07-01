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

import { ButlerReachableRegistry, type ButlerPushResult } from './butler-reachable.js'

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

// ── setting console (setting-ops M5) ─────────────────────────────────────────
// The IM face of the unified deterministic `setting` ops console — the THIRD
// surface over the one host `ops-core` (CLI + admin web + IM). An operator DMs
// the bot `/setting` to enter a command mode; each subsequent line is an ops
// subcommand until `exit`. Owner/operator only (D3), and ONLY read + safe-mutate
// execute here: ops-core's chokepoint refuses config-write AND
// destructive-offline for the `surface:'im'` caller, so the IM console can never
// write config or run a destructive op — it LISTS them and points the operator
// at the admin web UI / server CLI, exactly like the other two faces.

/** One catalog row for the IM console banner — a structural mirror of ops-core's
 *  `OpsCommandInfo`, so the host injects `listOpsCommands({surface:'im',…})`
 *  verbatim (the extra `summary` field is simply ignored here). */
export interface ImSettingCommandInfo {
  id: string
  tier: string
  title: string
  runnableHere: boolean
  whereToRun?: string
}

/** The deterministic ops runner the IM console drives. Production binds it to
 *  ops-core (`listOpsCommands` / `runOpsCommand`, surface='im'); `run` throws an
 *  ops error whose `.message` already says where a refused tier must run. */
export interface ImSettingOps {
  list(): ImSettingCommandInfo[]
  run(id: string, args: readonly string[]): Promise<{ lines: string[] }>
}

/**
 * IM command-console wiring. Present only when the host wired the console
 * (identity + ops-core available). ABSENT (the default) → `handleImMessage`'s
 * `/setting` pre-branch is skipped and every existing branch runs byte-for-byte
 * unchanged — the same zero-behaviour-change-when-unset property as the env gate.
 */
export interface HostImSettingConfig {
  /** Owner/operator gate (D3): only an admin may enter the console. Keyed by the
   *  bound AipeHub userId (resolved from the binding), never the raw IM handle. */
  isOperator: (userId: string) => boolean | Promise<boolean>
  /**
   * Per-user "in command mode" flag, OWNED by the orchestration layer
   * (`startImBridges`) so the stateless `handleImMessage` can read / flip it.
   * Command mode is conversational and intended for a DM with the bot.
   */
  mode: Map<string, boolean>
  /** The deterministic ops runner (read + safe-mutate only on IM). */
  ops: ImSettingOps
}

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
  /**
   * setting-ops M5 — owner/operator-only deterministic ops command mode, entered
   * by DMing `/setting`. Absent → the `/setting` branch is inert and the bridge
   * behaves exactly as before.
   */
  setting?: HostImSettingConfig
  /**
   * F1 — outbound-push foundation. Called on every inbound message from a BOUND
   * member so the reachable registry always knows the freshest chat to push a
   * reminder / approval back to. Absent → reachability isn't tracked (the default
   * for a host that hasn't wired the butler push foundation); every branch below
   * runs byte-for-byte unchanged either way.
   */
  onReachable?: (info: {
    userId: string
    platform: string
    from: ImUser
    chatId?: string
  }) => void
}

/**
 * The "never resume on a timer" sentinel — a suspend that only a human resolves
 * (`/me` inbox: a butler governed action, a workflow human step, an approval
 * gate). Mirrors `@aipehub/inbox`'s `NEVER_RESUME_AT` / the butler's
 * `BUTLER_NEVER_RESUME_AT`; duplicated as a local const so this module needs no
 * dep just to phrase a friendlier reply. Any `resumeAt >= this` means "waiting on
 * you", never "I'll get back to it at time T".
 */
const NEVER_RESUME_AT = 9_999_999_999_000

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

  // setting-ops M5 — additive `/setting` pre-branch. Claims the message iff it
  // is `/setting` OR the sender is already in command mode; otherwise returns
  // false and every existing branch below runs byte-for-byte unchanged. Inert
  // unless the host wired `config.setting`.
  if (config.setting) {
    const claimed = await handleSettingConsole(bridge, msg, config, config.setting)
    if (claimed) return
  }

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
      // F1 — this chat is now a known route for the member (reach them here later).
      recordReachable(config, result.userId, platform, msg)
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

  // F1 — the member is bound and just talked to us here; remember this chat as
  // their reachable route so a later reminder / approval can be pushed back.
  recordReachable(config, userId, platform, msg)

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
// setting console (setting-ops M5) — the IM command mode.
// ---------------------------------------------------------------------------

/** Matches the `/setting` trigger (bare, or with trailing args / whitespace). */
const SETTING_TRIGGER_RE = /^\/setting(?:\s|$)/i

/**
 * The IM setting console. Returns `true` iff it CLAIMED the message (the caller
 * then returns without running any other branch); `false` means "not mine" and
 * the normal router continues — so a non-mode user's `/help` or chat flows on
 * byte-for-byte unchanged.
 *
 * Claims a message when it is the `/setting` trigger, OR when the resolved user
 * is already in command mode.
 */
async function handleSettingConsole(
  bridge: ImBridge,
  msg: ImMessage,
  config: HostImConfig,
  setting: HostImSettingConfig,
): Promise<boolean> {
  const text = msg.text ?? ''
  const isTrigger = SETTING_TRIGGER_RE.test(text.trim())

  // Resolve the binding once. Command mode is keyed by AipeHub userId, so an
  // unbound sender can never be "in mode".
  const userId = await config.resolver.resolveUserId(bridge.platform, msg.from.platformUserId)
  const inMode = userId !== null && setting.mode.get(userId) === true

  // Not the trigger and not in mode → not ours; let the normal router run.
  if (!isTrigger && !inMode) return false

  // From here the message is ours to answer (either `/setting`, or a line typed
  // while already in command mode).

  // `/setting` from an unbound sender → bind first (mirrors the main nudge).
  if (userId === null) {
    await reply(
      bridge,
      msg,
      '你还没有绑定 AipeHub 账户，无法进入命令模式。先私信我 `/bind <code>`。\n' +
        'You must link your account before using the setting console — DM me `/bind <code>` first.',
    )
    return true
  }

  // Owner/operator gate (D3). Re-checked on EVERY line, so a demotion mid-session
  // is honoured: a non-operator is refused and any stale mode flag is dropped.
  const operator = await setting.isOperator(userId)
  if (!operator) {
    setting.mode.delete(userId)
    await reply(bridge, msg, '命令模式仅限管理员。/ The setting console is for hub operators only.')
    return true
  }

  // `/setting` → (re)enter command mode and show the runnable catalog.
  if (isTrigger) {
    setting.mode.set(userId, true)
    await reply(bridge, msg, settingEnterText(setting))
    return true
  }

  // In command mode: treat the whole line as one ops subcommand.
  const parsed = parseSettingLine(text)
  if (parsed.kind === 'empty') return true
  if (parsed.kind === 'exit') {
    setting.mode.delete(userId)
    await reply(bridge, msg, '已退出命令模式。/ Left the setting console.')
    return true
  }
  if (parsed.kind === 'help') {
    await reply(bridge, msg, settingHelpText(setting))
    return true
  }

  // parsed.kind === 'command'
  try {
    const result = await setting.ops.run(parsed.id, parsed.args)
    const body = result.lines.length > 0 ? result.lines.join('\n') : '(no output)'
    await reply(bridge, msg, body)
  } catch (err) {
    // ops-core throws typed errors whose `.message` already says where a refused
    // tier (config-write / destructive-offline) must run instead, and names an
    // unknown command. Surface it verbatim — that IS the operator guidance.
    const message = err instanceof Error ? err.message : String(err)
    await reply(bridge, msg, `✗ ${message}`)
  }
  return true
}

/** A parsed line typed inside the setting console. */
type ParsedSettingLine =
  | { kind: 'empty' }
  | { kind: 'exit' }
  | { kind: 'help' }
  | { kind: 'command'; id: string; args: string[] }

const SETTING_EXIT_WORDS = new Set(['exit', 'quit', 'q', ':exit', ':quit', ':q'])
const SETTING_HELP_WORDS = new Set(['help', '?', ':help', ':h', 'h'])

/**
 * Parse one command-mode line. Tolerates a leading `/setting ` prefix and a bare
 * leading slash on the verb (`/status` ≡ `status`), so an operator can keep
 * slashing out of muscle memory. Whitespace-split argv, the CLI shell's shape.
 */
function parseSettingLine(line: string): ParsedSettingLine {
  const stripped = line.trim().replace(/^\/?setting\b\s*/i, '')
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return { kind: 'empty' }
  const head = tokens[0]!.toLowerCase().replace(/^\//, '')
  if (SETTING_EXIT_WORDS.has(head)) return { kind: 'exit' }
  if (SETTING_HELP_WORDS.has(head)) return { kind: 'help' }
  return { kind: 'command', id: tokens[0]!.replace(/^\//, ''), args: tokens.slice(1) }
}

/** Banner shown on entering command mode — the commands that RUN here. */
function settingEnterText(setting: HostImSettingConfig): string {
  const runnable = setting.ops.list().filter((c) => c.runnableHere)
  return [
    '进入命令模式 / Setting console — deterministic ops, no LLM.',
    '可运行 / runnable here (read + safe-mutate):',
    ...runnable.map((c) => `  • ${c.id} — ${c.title}`),
    '',
    '输入命令名运行；`help` 看完整清单（含只在网页/CLI 能跑的）；`exit` 退出。',
    'Type a command to run it; `help` for the full catalog; `exit` to leave.',
  ].join('\n')
}

/** Full catalog — every tier listed, with a mark for what runs here and a hint
 *  pointing refused tiers at the web UI / server CLI. */
function settingHelpText(setting: HostImSettingConfig): string {
  const out = ['命令清单 / setting commands:', '']
  for (const c of setting.ops.list()) {
    const mark = c.runnableHere ? '•' : '×'
    const where = c.runnableHere ? '' : `  → ${c.whereToRun ?? '在网页/CLI 运行 / run on web or CLI'}`
    out.push(`  ${mark} ${c.id} [${c.tier}] — ${c.title}${where}`)
  }
  out.push('')
  out.push('× = 此面不可运行（破坏性/配置写去网页或服务器 CLI）。`exit` 退出。')
  out.push('× = not runnable here (config-write / destructive ops live on the web UI or server CLI). `exit` to leave.')
  return out.join('\n')
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
  /**
   * setting-ops M5 — owner/operator-only deterministic `/setting` command mode.
   * Absent → the `/setting` branch is inert (the default; pure env-gated IM is
   * unaffected). `main.ts` builds it from ops-core once identity is available.
   */
  setting?: HostImSettingConfig
  /**
   * F1 — where to persist reachable routes (`<space>/butler/reachable`). When set,
   * `startImBridges` builds a {@link ButlerReachableRegistry}, rehydrates it, and
   * populates it on every bound member's inbound message; the returned handle
   * exposes `pushToMember`. Absent → reachability isn't tracked and `pushToMember`
   * is undefined (pure env-gated IM is byte-for-byte unchanged).
   */
  reachableDir?: string
}

export interface ImBridgesHandle {
  readonly bridges: ImBridge[]
  /**
   * F1 — deliver a line of text to a member's last known chat (reminder / approval
   * push-back). Present only when `reachableDir` was configured; undefined
   * otherwise. Returns a typed result so a caller can tell "never bound a chat"
   * from "bridge down" from "send threw".
   */
  pushToMember?: (userId: string, text: string) => Promise<ButlerPushResult>
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

  // Declared before the registry so its `bridgeFor` closure reads the live array
  // (populated in the loop below); `push` only fires out-of-band, well after.
  const bridges: ImBridge[] = []

  // F1 — the outbound-push foundation. Built + rehydrated only when the host
  // wired `reachableDir`; without it reachability is off and `pushToMember` is
  // undefined, leaving pure env-gated IM byte-for-byte unchanged.
  let reachable: ButlerReachableRegistry | undefined
  if (opts.reachableDir) {
    reachable = new ButlerReachableRegistry({
      dir: opts.reachableDir,
      bridgeFor: (platform) => bridges.find((b) => b.platform === platform),
      logger: opts.log,
    })
    await reachable.load()
  }

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
    ...(opts.setting ? { setting: opts.setting } : {}),
    ...(reachable
      ? {
          onReachable: (info) =>
            reachable!.record({
              userId: info.userId,
              platform: info.platform,
              platformUserId: info.from.platformUserId,
              displayName: info.from.displayName ?? null,
              ...(info.chatId !== undefined ? { chatId: info.chatId } : {}),
            }),
        }
      : {}),
  }
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
    ...(reachable ? { pushToMember: (userId: string, text: string) => reachable!.push(userId, text) } : {}),
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

/** F1 — feed the reachable registry (if wired) this member's freshest chat. */
function recordReachable(
  config: HostImConfig,
  userId: string,
  platform: string,
  msg: ImMessage,
): void {
  config.onReachable?.({
    userId,
    platform,
    from: msg.from,
    ...(msg.chatId !== undefined ? { chatId: msg.chatId } : {}),
  })
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
      // A human-resolved park (butler governed action / workflow human step /
      // approval gate) uses the NEVER_RESUME_AT sentinel — phrase it as "waiting
      // on you in /me", not a nonsensical year-2286 timestamp. A finite resumeAt
      // is a genuine timed suspend (e.g. a long-running poll) — keep the ETA.
      return result.resumeAt >= NEVER_RESUME_AT
        ? '这件事需要你先确认一下,我已经放进你的「我的 → 收件箱」了。你在那儿点确认或拒绝,处理好我再回来告诉你结果。'
        : `⏸ 已安排,预计 ${new Date(result.resumeAt).toISOString()} 前后继续。`
    case 'no_participant':
      return `⚠️ No agent picked it up: ${result.reason}`
  }
}
