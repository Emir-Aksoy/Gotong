/**
 * Production IM bridge wiring — folds the example's IM router glue into
 * the host so a real Telegram bot can drive the hub.
 *
 * OFF by default: with no platform configured (env vars unset AND no
 * `im_bridge` vault rows), `startImBridges()` returns `undefined` and
 * nothing changes — exactly how the A2A / ACP outbound managers stay
 * inert without their config. That zero-behaviour-change-when-unset
 * property is the whole point of the gate: an existing deployment that
 * doesn't want IM is byte-for-byte unaffected. (The `hotStart` option
 * relaxes only the RETURN contract — a handle exists so a bridge can be
 * started later — never the "nothing runs uninvited" part.)
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
 * `platform + platformUserId → Gotong userId`. Every dispatch carries
 * `origin.userId`, so the quota gate / audit log attribute work to the
 * real member — never to the raw IM handle (which goes only into
 * `Task.from` for transcript display).
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import type { DispatchStrategy, Hub, TaskResult } from '@gotong/core'
import { classifyLlmError } from '@gotong/llm'
import { IdentityError, type IdentityStore } from '@gotong/identity'
import {
  parseImCommand,
  type ClaimResult,
  type ImAttachment,
  type ImBindingResolver,
  type ImBridge,
  type ImMessage,
  type ImUser,
} from '@gotong/im-adapter'
import { TelegramBridge } from '@gotong/im-telegram'
import { QqBridge } from '@gotong/im-qq'
import { LarkBridge } from '@gotong/im-lark'
import { SlackBridge, type WebSocketCtor as SlackWebSocketCtor } from '@gotong/im-slack'
import { WechatBridge } from '@gotong/im-wechat'
import { WebSocket as NodeWebSocket } from 'ws'

import type { ButlerHearing } from './butler-hearing.js'
import { ButlerOutbox } from './butler-outbox.js'
import { ButlerReachableRegistry, type ButlerPushResult } from './butler-reachable.js'
import type { ButlerVoice } from './butler-voice.js'
import { translateLlmFailureKind, type FailureLang, type LlmFailureTranslation } from './failure-translator.js'
import {
  LlmOutageTracker,
  checkOutageRecovery,
  llmOutageAnnouncement,
  llmRecoveryAnnouncement,
} from './llm-outage.js'
import { readButlerRunBroadcastConfig } from './personal-butler-run-broadcast.js'

/**
 * Minimal structural logger — the host's `@gotong/core` `Logger`
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

/**
 * IMA-M2 — optional `/inbox` / `/approve` / `/deny` surface. Production binds
 * it to `ImApprovalService`; absent → the three verbs reply "not enabled"
 * (the `resolveWorkflow` posture). The risk gate — WHICH items are answerable
 * from IM — lives behind this surface (the write-time `imApprovable`
 * whitelist, re-checked server-side); the bridge only renders text and never
 * makes the risk call.
 */
export interface ImApprovalSurface {
  listForIm(userId: string): Promise<
    Array<{ shortId: string; title: string; kind: string; imApprovable: boolean }>
  >
  resolveByShortId(args: {
    userId: string
    shortId: string
    approved: boolean
    via: string
  }): Promise<{ title: string }>
}

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
   *  bound Gotong userId (resolved from the binding), never the raw IM handle. */
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
  /** IMA-M2 — optional approval surface; absent → the three verbs reply "not enabled". */
  approvals?: ImApprovalSurface
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
  /**
   * CARE-M2 — 断供不失联。present 时:自由文本 dispatch 的 provider 失败
   * 翻成 canned 大白话回复(零 LLM),断供/恢复的边沿各播报一次(dedup
   * 由 tracker 的状态文件承担,重启不重播)。absent → 所有分支字节不变。
   */
  llmOutage?: HostImLlmOutageConfig
  /** VOICE-M3 — 见 StartImBridgesOptions.voice。absent → 发送逐字节不变。 */
  voice?: Pick<ButlerVoice, 'synthesize'>
}

/** CARE-M2 — 断供滤镜的注入面(host 装配;测试给 tmp 文件 + spy)。 */
export interface HostImLlmOutageConfig {
  tracker: LlmOutageTracker
  lang: FailureLang
  /** 边沿播报出口(接 BE-M5 已同意成员的 push);缺省 → 边沿只发生不发声。 */
  announce?: (text: string) => Promise<void>
}

/**
 * The "never resume on a timer" sentinel — a suspend that only a human resolves
 * (`/me` inbox: a butler governed action, a workflow human step, an approval
 * gate). Mirrors `@gotong/inbox`'s `NEVER_RESUME_AT` / the butler's
 * `BUTLER_NEVER_RESUME_AT`; duplicated as a local const so this module needs no
 * dep just to phrase a friendlier reply. Any `resumeAt >= this` means "waiting on
 * you", never "I'll get back to it at time T".
 */
const NEVER_RESUME_AT = 9_999_999_999_000

const HELP_TEXT = [
  'Gotong IM bridge — commands:',
  '',
  '  /help                   — show this list',
  '  /bind <code>            — link this IM identity to your Gotong account',
  '                            (issue a code in the admin UI / 我的 → 绑定 IM)',
  '  /unbind                 — drop the binding',
  '  /agents                 — list agents you can talk to',
  '  /workflow <name> <args> — start a named workflow',
  '  /inbox                  — list items waiting for your approval',
  '  /approve <id>           — approve one (id from /inbox)',
  '  /deny <id>              — reject one',
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
      '你还没有绑定 Gotong 账户。在管理界面 / 我的 生成 6 位绑定码，然后私信我 `/bind <code>`。\n' +
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
      await reply(bridge, msg, summariseResult(result, config.approvals !== undefined))
      return
    }

    // IMA-M2 — the approval loop's three verbs. All authority (ownership,
    // race guard, the imApprovable whitelist re-check, two-step resume, the
    // S1-M3 outcome push-back) lives behind `config.approvals`; this router
    // only renders text.
    case 'inbox': {
      if (!config.approvals) {
        await reply(bridge, msg, APPROVALS_NOT_ENABLED)
        return
      }
      const rows = await config.approvals.listForIm(userId)
      if (rows.length === 0) {
        await reply(bridge, msg, '没有等你处理的事项。/ Nothing is waiting on you.')
        return
      }
      const lines = rows.map((r) =>
        r.imApprovable
          ? `  • [${r.shortId}] ${r.title}`
          : `  • [${r.shortId}] ${r.title} (需在网页处理 / web only)`,
      )
      await reply(
        bridge,
        msg,
        [
          `等你处理的事项 / Waiting on you (${rows.length}):`,
          '',
          ...lines,
          '',
          '回复 /approve <id> 或 /deny <id>。/ Reply /approve <id> or /deny <id>.',
        ].join('\n'),
      )
      return
    }

    case 'approve':
    case 'deny': {
      if (!config.approvals) {
        await reply(bridge, msg, APPROVALS_NOT_ENABLED)
        return
      }
      const approved = cmd.kind === 'approve'
      try {
        const out = await config.approvals.resolveByShortId({
          userId,
          shortId: cmd.shortId,
          approved,
          via: `im:${platform}`,
        })
        await reply(
          bridge,
          msg,
          approved ? `✓ 已批准 / Approved — ${out.title}` : `✓ 已拒绝 / Denied — ${out.title}`,
        )
      } catch (err) {
        await reply(bridge, msg, describeApprovalError(err, cmd.shortId))
      }
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
      // CARE-M2 — provider 病了给 canned 大白话而不是原始异常;答上话了在
      // 恢复边沿播一声。llmOutage 未接线 → 老路径字节不变。
      if (config.llmOutage && (await handleLlmOutageOnFreeText(bridge, msg, config, config.llmOutage, result))) {
        return
      }
      const summary = summariseResult(result, config.approvals !== undefined)
      // VOICE-M3 — only the assistant's OK reply speaks; failure / suspend
      // telemetry carries commands (/inbox 短码) that must stay copyable text.
      await reply(bridge, msg, summary, result.kind === 'ok' ? await voiceClipFor(config, summary) : undefined)
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

  // Resolve the binding once. Command mode is keyed by Gotong userId, so an
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
      '你还没有绑定 Gotong 账户，无法进入命令模式。先私信我 `/bind <code>`。\n' +
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

// ---------------------------------------------------------------------------
// DEPLOY-B1 — vault-backed IM credentials (env-first, vault-fallback).
//
// The first-boot wizard writes an org vault row (`kind='im_bridge'`,
// `metadata.platform` as the resolution tag — same convention llm_provider
// rows use `metadata.provider` for) so a fresh box gets IM without anyone
// hand-editing an env file. Env vars still WIN: an operator who set
// GOTONG_TELEGRAM_BOT_TOKEN keeps exactly today's behaviour, vault unread.
// Three platforms resolve from vault: telegram + lark (wizard-pasted) and
// wechat, whose token can't be pasted at all — `gotong wechat-login` MINTS
// it via QR scan and writes the row (WX-M2c). QQ/Slack stay env-only —
// their multi-field + webhook tuning is operator-level config, not a
// first-boot form.
// ---------------------------------------------------------------------------

/** Platforms whose credentials can live in the vault (wizard or login CLI). */
export type ImVaultPlatform = 'telegram' | 'lark' | 'wechat'

export interface ResolvedImCreds {
  source: 'env' | 'vault'
  /** telegram: `{ token }` · lark: `{ appId, appSecret }` ·
   *  wechat: `{ token, baseUrl? }` */
  fields: Record<string, string>
}

export function resolveImCreds(
  platform: ImVaultPlatform,
  identity: IdentityStore,
  log?: ImLogger,
): ResolvedImCreds | undefined {
  if (platform === 'telegram') {
    const token = process.env.GOTONG_TELEGRAM_BOT_TOKEN?.trim()
    if (token) return { source: 'env', fields: { token } }
  } else if (platform === 'wechat') {
    // Token alone suffices; the base URL (IDC affinity from the QR login) is
    // an optional companion and never mixes sources — env token pairs only
    // with env base URL, a vault row carries its own.
    const token = process.env.GOTONG_WECHAT_BOT_TOKEN?.trim()
    const baseUrl = process.env.GOTONG_WECHAT_BASE_URL?.trim()
    if (token) return { source: 'env', fields: { token, ...(baseUrl ? { baseUrl } : {}) } }
  } else {
    // Both-or-nothing from env: a lone GOTONG_LARK_APP_ID never pairs with a
    // vault secret — mixed-source halves would make "which app is this?"
    // undebuggable.
    const appId = process.env.GOTONG_LARK_APP_ID?.trim()
    const appSecret = process.env.GOTONG_LARK_APP_SECRET?.trim()
    if (appId && appSecret) return { source: 'env', fields: { appId, appSecret } }
  }
  try {
    const rows = identity
      .listVaultEntries({ kind: 'im_bridge', ownerKind: 'org', activeOnly: true })
      .filter((e) => (e.metadata as Record<string, unknown> | null)?.platform === platform)
    // listVaultEntries returns newest-first — a re-run wizard's fresh token
    // wins without requiring the old row to be revoked first.
    const chosen = rows[0]
    if (!chosen) return undefined
    const secret = identity.readVaultSecret(chosen.id)
    if (platform === 'telegram') return { source: 'vault', fields: { token: secret } }
    if (platform === 'wechat') {
      // baseUrl is non-secret companion metadata (the lark-appId convention).
      const baseUrl = (chosen.metadata as Record<string, unknown> | null)?.baseUrl
      return {
        source: 'vault',
        fields: {
          token: secret,
          ...(typeof baseUrl === 'string' && baseUrl.length > 0 ? { baseUrl } : {}),
        },
      }
    }
    const appId = (chosen.metadata as Record<string, unknown> | null)?.appId
    if (typeof appId !== 'string' || appId.length === 0) {
      // Half-written row (secret without its non-secret app id) — refuse
      // rather than start a bridge that can only fail to authenticate.
      log?.warn('im vault row missing appId; ignoring', { platform, entryId: chosen.id })
      return undefined
    }
    return { source: 'vault', fields: { appId, appSecret: secret } }
  } catch (err) {
    // A vault read failure (master key mismatch, pre-vault store) must not
    // take down env-only boot — IM just stays off for this platform, loudly.
    log?.warn('im vault credential lookup failed', { platform, err: String(err) })
    return undefined
  }
}

/**
 * Single construction point for the two vault-capable platforms — the boot
 * loop and the hot-start seam must build byte-identical bridges.
 */
function buildVaultablePlatformBridge(
  platform: ImVaultPlatform,
  creds: ResolvedImCreds,
  log: ImLogger,
  hearing?: Pick<ButlerHearing, 'transcribe'>,
): ImBridge {
  if (platform === 'telegram') {
    return new TelegramBridge({
      token: creds.fields.token!,
      onError: (err) => log.warn('telegram bridge error', { err: String(err) }),
    })
  }
  if (platform === 'wechat') {
    return new WechatBridge({
      token: creds.fields.token!,
      ...(creds.fields.baseUrl ? { baseUrl: creds.fields.baseUrl } : {}),
      onError: (err) => log.warn('wechat bridge error', { err: String(err) }),
    })
  }
  return new LarkBridge({
    appId: creds.fields.appId!,
    appSecret: creds.fields.appSecret!,
    // ASR-M3 — absent hearing = no transcriber key at all (inbound byte-identical).
    ...(hearing ? { transcriber: foldHearingTranscriber(hearing, log) } : {}),
    onError: (err) => log.warn('lark bridge error', { err: String(err) }),
  })
}

/**
 * ASR-M3 — fold the three-state {@link ButlerHearing} result into the Lark
 * bridge's `string | null` transcriber contract: `text` → transcript,
 * `skipped` (silence / oversize — in-design) → quiet null, `failed` (infra)
 * → warn + null. The bridge substitutes its honest marker for null;
 * `transcribe()` itself never throws. Exported for the anti-corrosion test —
 * production reaches it only through the Lark construction above.
 */
export function foldHearingTranscriber(
  hearing: Pick<ButlerHearing, 'transcribe'>,
  log: ImLogger,
): (bytes: Uint8Array) => Promise<string | null> {
  return async (bytes) => {
    const r = await hearing.transcribe(Buffer.from(bytes))
    if (r.kind === 'text') return r.text
    if (r.kind === 'failed') log.warn('im hearing: transcription failed', { reason: r.reason })
    return null
  }
}

export type ImHotStartResult =
  | { ok: true; platform: ImVaultPlatform; source: 'env' | 'vault' }
  | { ok: false; reason: 'already_running' | 'no_credentials' | 'start_failed'; detail?: string }

export interface StartImBridgesOptions {
  hub: Hub
  identity: IdentityStore
  log: ImLogger
  /** Defaults to env `GOTONG_IM_CHAT_CAPABILITY` or 'chat'. */
  freeTextCapability?: string
  listAgents?: ImAgentLister
  resolveWorkflow?: ImWorkflowResolver
  /** IMA-M2 — `/inbox` `/approve` `/deny`; absent → the verbs reply "not enabled". */
  approvals?: ImApprovalSurface
  /**
   * DEPLOY-B1 — opt into the hot-start seam: return a handle even when no
   * platform resolved credentials at boot, exposing `startPlatform` so the
   * first-boot wizard can bring a bridge up right after writing its token to
   * vault — no restart between "pasted the token" and "bot answers".
   * Start-only by design (只热启不热改): a RUNNING bridge is never
   * reconfigured or stopped here — rotating a token still means restart,
   * same as every other knob (the setting console's no-hot-reload stance).
   * Without this flag the boot contract is byte-identical to before.
   */
  hotStart?: boolean
  /**
   * Test seam — overrides bridge construction for the vault-capable
   * platforms so hot-start tests stay hermetic (a real TelegramBridge
   * long-polls the live API the moment it starts). Production never sets it.
   */
  makeBridge?: (platform: ImVaultPlatform, creds: ResolvedImCreds) => ImBridge
  /**
   * setting-ops M5 — owner/operator-only deterministic `/setting` command mode.
   * Absent → the `/setting` branch is inert (the default; pure env-gated IM is
   * unaffected). `main.ts` builds it from ops-core once identity is available.
   */
  setting?: HostImSettingConfig
  /**
   * VOICE-M3 — opt-in TTS voice replies (`butlerVoiceFromEnv`, all four of
   * `GOTONG_BUTLER_VOICE_URL`/`_KEY`/`_MODEL`/`_VOICE` set). When present, the free-text OK reply is ALSO
   * synthesized to an opus clip and attached — the Lark bridge plays it as a
   * voice bubble; bridges without an audio leg refuse the attachment and send
   * text (their existing posture). Command output / failure telemetry stays
   * text-only ON PURPOSE: short codes (`/approve <id>`) must remain copyable,
   * and a voice bubble REPLACES text on the platform leg. Absent →
   * byte-identical sends.
   */
  voice?: Pick<ButlerVoice, 'synthesize'>
  /**
   * ASR-M3 — opt-in voice-note hearing (`butlerHearingFromEnv`, shared
   * `GOTONG_BUTLER_VOICE_URL`/`_KEY` + `GOTONG_BUTLER_ASR_MODEL` all set).
   * Lark voice notes are downloaded and transcribed BEFORE dispatch so the
   * butler reads what was said; `skipped`/`failed` fold to null → the bridge
   * substitutes its honest marker text. Transcription ≠ authorization: the
   * transcript walks the same governed pipeline as typed text. Absent →
   * inbound handling byte-identical (voice notes arrive with empty text).
   */
  hearing?: Pick<ButlerHearing, 'transcribe'>
  /**
   * F1 — where to persist reachable routes (`<space>/butler/reachable`). When set,
   * `startImBridges` builds a {@link ButlerReachableRegistry}, rehydrates it, and
   * populates it on every bound member's inbound message; the returned handle
   * exposes `pushToMember`. Absent → reachability isn't tracked and `pushToMember`
   * is undefined (pure env-gated IM is byte-for-byte unchanged).
   */
  reachableDir?: string
  /**
   * CARE-M8 — outbox 目录(`<space>/butler/outbox`)。给了它(且 reachableDir
   * 在)→ `pushToMember` 与断供播报走持久化重投:投递失败入盘,成员下次说话
   * (record → flush)或 cadence 巡检时补投。缺省 → push 仍是 best-effort
   * (失败只记日志,与今天字节一致)。
   */
  outboxDir?: string
  /**
   * CARE-M2 — 断供不失联接线。file 惯例 `<space>/runtime/llm-outage.json`;
   * butlerMemoryRoot 用来枚举 BE-M5 播报已同意的成员(骑同一份同意,零新
   * 旋钮);边沿播报走 reachable push,没配 reachableDir 时退化为只记日志
   * ——对话内的 canned 回复不依赖这里,永远先答人。
   *
   * CARE-M5 — 可选 probeLiveness:给了它(且 reachableDir 在)就 arm 一个
   * 主动恢复探活定时器,断供期间按节律做只读活体探针,通了立刻播恢复,
   * 不必等下一条用户消息。缺省 → 恢复仍只走反应式(下一条消息成功才播)。
   */
  llmOutage?: {
    file: string
    lang: FailureLang
    butlerMemoryRoot: string
    probeLiveness?: () => Promise<boolean>
    /** 探活节律毫秒。缺省 = LLM_RECOVERY_PROBE_INTERVAL_MS;主要给测试缩短。 */
    probeIntervalMs?: number
  }
}

/**
 * DEPLOY-B3 — one live bridge's at-a-glance row for the admin settings page.
 * `source` answers "换 token 该去哪": env → edit env + restart; vault → the
 * setup wizard / a future admin write path owns it. Platforms with no vault
 * path (QQ / Slack) always report 'env'.
 */
export interface ImBridgeStatusRow {
  platform: string
  source?: 'env' | 'vault'
}

export interface ImBridgesHandle {
  readonly bridges: ImBridge[]
  /**
   * DEPLOY-B3 — read-only projection of what is LIVE right now (platform +
   * credential source). Pure snapshot of in-memory state; safe on every
   * admin-settings open.
   */
  status(): ImBridgeStatusRow[]
  /**
   * F1 — deliver a line of text to a member's last known chat (reminder / approval
   * push-back). Present only when `reachableDir` was configured; undefined
   * otherwise. Returns a typed result so a caller can tell "never bound a chat"
   * from "bridge down" from "send threw".
   */
  pushToMember?: (userId: string, text: string) => Promise<ButlerPushResult>
  /**
   * DEPLOY-B1 — start ONE not-yet-running vault-capable platform, resolving
   * credentials at call time (env first, then the vault row the caller just
   * wrote). Present only when `hotStart` was requested. Refuses a platform
   * that is already up (`already_running`) — this seam starts, never
   * reconfigures.
   */
  startPlatform?: (platform: ImVaultPlatform) => Promise<ImHotStartResult>
  stop(): Promise<void>
}

/**
 * CARE-M5 — 主动恢复探活的节律。常量而非 env 旋钮(同 CARE-M2/M3 的零新
 * 旋钮惯例):断供期间每 60s 探一次只读活体,足够及时又不刷 provider;健康
 * 时每次 tick 只是 tracker 的一次内存读('idle' 即返回),近乎零成本。
 */
const LLM_RECOVERY_PROBE_INTERVAL_MS = 60_000

/**
 * CARE-M8 — outbox 重投巡检节律。常量非旋钮。成员一说话立刻 flush(record →
 * flush,常态恢复路径);这个 cadence 只兜「桥恢复了但成员没吭声」——2 分钟够
 * 及时;空队列时每 tick 只是一次 readdir,近乎零成本。
 */
const OUTBOX_FLUSH_INTERVAL_MS = 2 * 60 * 1000

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
 *   - Telegram (long-poll), Lark (official long connection), Slack
 *     (Socket Mode), and WeChat (iLink long-poll) dial OUT → a home box
 *     behind NAT works with no public endpoint.
 *   - QQ's official Bot API discontinued its WebSocket and pushes an
 *     INBOUND webhook (public domain + TLS), so the QQ bridge runs its own
 *     HTTP listener that an operator fronts with a reverse proxy on a
 *     cloud host. See docs/zh/IM-OFFICIAL-REARCH.md.
 *
 * Env per platform (a bridge needs ALL of its vars to activate):
 *   Telegram  GOTONG_TELEGRAM_BOT_TOKEN   — or vault kind='im_bridge' (wizard)
 *   QQ        GOTONG_QQ_BOT_APPID + GOTONG_QQ_BOT_SECRET
 *             (+ GOTONG_QQ_WEBHOOK_PORT / _HOST / _PATH to tune the listener)
 *   Lark      GOTONG_LARK_APP_ID + GOTONG_LARK_APP_SECRET — or vault (wizard)
 *   Slack     GOTONG_SLACK_APP_TOKEN (xapp-) + GOTONG_SLACK_BOT_TOKEN (xoxb-)
 *   WeChat    GOTONG_WECHAT_BOT_TOKEN (+ optional GOTONG_WECHAT_BASE_URL)
 *             — or vault (minted by `gotong wechat-login`, WX-M2c)
 */
export async function startImBridges(
  opts: StartImBridgesOptions,
): Promise<ImBridgesHandle | undefined> {
  // Defer construction behind each gate. Building lazily (a factory per
  // configured platform) keeps a bridge's start-time side effects —
  // QQ's HTTP listener, Slack's apps.connections.open round trip — from
  // firing for a platform the operator never configured.
  const factories: Array<{ make: () => ImBridge; source?: 'env' | 'vault' }> = []
  const makeVaultable = (platform: ImVaultPlatform, creds: ResolvedImCreds): ImBridge =>
    opts.makeBridge
      ? opts.makeBridge(platform, creds)
      : buildVaultablePlatformBridge(platform, creds, opts.log, opts.hearing)

  const telegram = resolveImCreds('telegram', opts.identity, opts.log)
  if (telegram) {
    factories.push({ source: telegram.source, make: () => makeVaultable('telegram', telegram) })
  }

  const qqAppId = process.env.GOTONG_QQ_BOT_APPID?.trim()
  const qqSecret = process.env.GOTONG_QQ_BOT_SECRET?.trim()
  if (qqAppId && qqSecret) {
    // The official QQ Bot API is inbound-webhook only (its WS was
    // discontinued), so the bridge binds its own listener that a reverse
    // proxy terminates TLS in front of. Port 0 disables the listener for a
    // host that drives the webhook from its own HTTP layer.
    const webhookPort = parseImPort(process.env.GOTONG_QQ_WEBHOOK_PORT)
    const webhookHost = process.env.GOTONG_QQ_WEBHOOK_HOST?.trim()
    const webhookPath = process.env.GOTONG_QQ_WEBHOOK_PATH?.trim()
    factories.push({
      // QQ has no vault path — env is its only credential source, stated
      // explicitly so the status() projection reads uniformly.
      source: 'env',
      make: () =>
        new QqBridge({
          appId: qqAppId,
          secret: qqSecret,
          ...(webhookPort !== undefined ? { webhookPort } : {}),
          ...(webhookHost ? { webhookHost } : {}),
          ...(webhookPath ? { webhookPath } : {}),
          onError: (err) => opts.log.warn('qq bridge error', { err: String(err) }),
        }),
    })
  }

  const lark = resolveImCreds('lark', opts.identity, opts.log)
  if (lark) {
    factories.push({ source: lark.source, make: () => makeVaultable('lark', lark) })
  }

  const wechat = resolveImCreds('wechat', opts.identity, opts.log)
  if (wechat) {
    factories.push({ source: wechat.source, make: () => makeVaultable('wechat', wechat) })
  }

  const slackBotToken = process.env.GOTONG_SLACK_BOT_TOKEN?.trim()
  const slackAppToken = process.env.GOTONG_SLACK_APP_TOKEN?.trim()
  if (slackBotToken && slackAppToken) {
    factories.push({
      // Slack likewise: env-only credentials, no vault path.
      source: 'env',
      make: () =>
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
    })
  }

  // Without the hot-start seam the boot contract is unchanged: nothing
  // configured (env NOR vault) → undefined, no handle, no shutdown hook.
  if (factories.length === 0 && !opts.hotStart) return undefined

  // Declared before the registry so its `bridgeFor` closure reads the live array
  // (populated in the loop below); `push` only fires out-of-band, well after.
  const bridges: ImBridge[] = []
  // DEPLOY-B3 — credential source per LIVE platform, feeding the status()
  // projection. Keyed by platform (one bridge per platform by construction).
  const credSources = new Map<string, 'env' | 'vault'>()

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

  // CARE-M8 — 持久化投递重投。仅当 reachable 在 AND 宿主给了 outboxDir 时包一层:
  // 投递失败入盘,成员下次说话(record → flush)或 cadence 巡检时补投。缺省 →
  // push 仍 best-effort(失败只记日志,与今天字节一致)。
  let outbox: ButlerOutbox | undefined
  if (reachable && opts.outboxDir) {
    const reg = reachable
    outbox = new ButlerOutbox({
      dir: opts.outboxDir,
      push: (userId, text) => reg.push(userId, text),
      logger: opts.log,
    })
  }

  // 面向成员的统一投递原语:有 outbox 走持久重投,否则退回 raw best-effort push。
  // 一切成员向投递(pushToMember、断供 announce)都走它,重试语义一处、齐整。
  // reachable 不在 → undefined(纯 env IM 没有出站推送面,字节不变)。
  const deliverToMember: ((userId: string, text: string) => Promise<ButlerPushResult>) | undefined =
    reachable
      ? outbox
        ? (userId, text) => outbox!.deliver(userId, text)
        : (userId, text) => reachable!.push(userId, text)
      : undefined

  // CARE-M2 — 断供/恢复的边沿播报出口:发给 BE-M5 运行播报已开的成员
  // (同一份同意,零新旋钮)。best-effort:一个成员送不到不挡下一个;
  // 没有 reachable 注册表就只记日志。
  const outageOpts = opts.llmOutage
  const llmOutage: HostImLlmOutageConfig | undefined = outageOpts
    ? {
        tracker: new LlmOutageTracker(outageOpts.file),
        lang: outageOpts.lang,
        announce: async (text: string) => {
          if (!deliverToMember) {
            opts.log.warn('llm outage: announce skipped, no reachable registry')
            return
          }
          let userIds: string[]
          try {
            const entries = await readdir(join(outageOpts.butlerMemoryRoot, 'user'), { withFileTypes: true })
            userIds = entries.filter((e) => e.isDirectory()).map((e) => e.name)
          } catch {
            return // 还没有管家成员 → 没有可播对象
          }
          for (const userId of userIds) {
            try {
              const cfg = await readButlerRunBroadcastConfig(outageOpts.butlerMemoryRoot, userId)
              if (!cfg?.enabled) continue
              // CARE-M8 — 走 outbox:一个短暂失联的成员不会漏掉这声「坏了/好了」。
              await deliverToMember(userId, text)
            } catch (err) {
              opts.log.warn('llm outage: announce delivery failed', { userId, err: String(err) })
            }
          }
        },
      }
    : undefined

  const resolver = makeIdentityImBindingResolver(opts.identity)
  const config: HostImConfig = {
    hub: opts.hub,
    resolver,
    freeTextCapability:
      opts.freeTextCapability ?? (process.env.GOTONG_IM_CHAT_CAPABILITY?.trim() || 'chat'),
    onUnbind: async (platform, platformUserId) => {
      const n = opts.identity.removeImBinding(platform, platformUserId)
      return { removed: n > 0 }
    },
    listAgents: opts.listAgents,
    resolveWorkflow: opts.resolveWorkflow,
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
    log: opts.log,
    ...(opts.setting ? { setting: opts.setting } : {}),
    ...(opts.voice ? { voice: opts.voice } : {}),
    ...(llmOutage ? { llmOutage } : {}),
    ...(reachable
      ? {
          onReachable: (info) => {
            reachable!.record({
              userId: info.userId,
              platform: info.platform,
              platformUserId: info.from.platformUserId,
              displayName: info.from.displayName ?? null,
              ...(info.chatId !== undefined ? { chatId: info.chatId } : {}),
            })
            // CARE-M8 — 成员刚说话 = 此刻可达:立刻 flush 他的 outbox,把失联
            // 期间攒下的「坏了/好了」/提醒/审批补投。fire-and-forget,不挡入站。
            if (outbox) void outbox.flush(info.userId)
          },
        }
      : {}),
  }
  // Shared by the boot loop and the hot-start seam so a hot-started bridge is
  // wired byte-identically to a boot-started one (same router, same config,
  // same failure tolerance).
  const wireAndStart = async (bridge: ImBridge, source?: 'env' | 'vault'): Promise<boolean> => {
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
      return false
    }
    opts.log.info('IM bridge enabled', {
      platform: bridge.platform,
      freeTextCapability: config.freeTextCapability,
      ...(source ? { credSource: source } : {}),
    })
    bridges.push(bridge)
    if (source) credSources.set(bridge.platform, source)
    return true
  }

  for (const f of factories) {
    await wireAndStart(f.make(), f.source)
  }

  // Every configured bridge failed to start → IM is effectively disabled.
  // Returning undefined keeps the "no shutdown hook" contract the caller
  // relies on, same as the no-env path — unless the hot-start seam is on,
  // in which case the (empty) handle IS the point: a bridge may arrive later.
  if (bridges.length === 0 && !opts.hotStart) return undefined

  // DEPLOY-B1 — bring ONE not-yet-running platform up after boot. Credential
  // resolution happens at CALL time (the setup route writes the vault row,
  // then calls this), through the same resolveImCreds the boot path uses.
  const startPlatform = async (platform: ImVaultPlatform): Promise<ImHotStartResult> => {
    if (bridges.some((b) => b.platform === platform)) {
      return { ok: false, reason: 'already_running' }
    }
    const creds = resolveImCreds(platform, opts.identity, opts.log)
    if (!creds) return { ok: false, reason: 'no_credentials' }
    const started = await wireAndStart(makeVaultable(platform, creds), creds.source)
    return started
      ? { ok: true, platform, source: creds.source }
      : { ok: false, reason: 'start_failed', detail: 'bridge start threw; see host log' }
  }

  // CARE-M5 — 主动恢复探活定时器。宿主给了 probeLiveness(且 reachable 在,
  // 否则本就无处播)才 arm:断供期间按节律探只读活体,通了 checkOutageRecovery
  // 经同一个 tracker 边沿判定后立刻播恢复,不必等下一条用户消息。unref → 绝不
  // 拖住进程退出;stop() 里 clearInterval。tracker 与反应式路径同一实例,谁先
  // 清谁播,不重复。
  let recoveryTimer: ReturnType<typeof setInterval> | undefined
  if (llmOutage && outageOpts?.probeLiveness && reachable) {
    const probeLiveness = outageOpts.probeLiveness
    const outageForSweep = llmOutage
    const intervalMs = outageOpts.probeIntervalMs ?? LLM_RECOVERY_PROBE_INTERVAL_MS
    recoveryTimer = setInterval(() => {
      void checkOutageRecovery({
        tracker: outageForSweep.tracker,
        probeLiveness,
        announce: outageForSweep.announce ?? (async () => {}),
        lang: outageForSweep.lang,
        log: opts.log,
      }).catch((err) => opts.log.warn('llm recovery sweep error', { err: String(err) }))
    }, intervalMs)
    recoveryTimer.unref?.()
  }

  // CARE-M8 — outbox 重投巡检定时器。仅当有 outbox 时 arm(unref;stop 里
  // clearInterval)。常态恢复靠 record → flush 即时补投;这个 cadence 只兜「桥
  // 恢复了但成员没说话」。空队列时每 tick 只是一次 readdir,近乎零成本。
  let outboxTimer: ReturnType<typeof setInterval> | undefined
  if (outbox) {
    const ob = outbox
    outboxTimer = setInterval(() => {
      void ob.flushAll().catch((err) => opts.log.warn('outbox flush sweep error', { err: String(err) }))
    }, OUTBOX_FLUSH_INTERVAL_MS)
    outboxTimer.unref?.()
  }

  return {
    bridges,
    status: () =>
      bridges.map((b) => {
        const source = credSources.get(b.platform)
        return { platform: b.platform, ...(source ? { source } : {}) }
      }),
    ...(deliverToMember ? { pushToMember: deliverToMember } : {}),
    ...(opts.hotStart ? { startPlatform } : {}),
    async stop() {
      if (recoveryTimer) clearInterval(recoveryTimer)
      if (outboxTimer) clearInterval(outboxTimer)
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
 * with Gotong-internal user ids (which go into `origin.userId`).
 */
function makeFromId(platform: string, platformUserId: string): string {
  return `im:${platform}:${platformUserId}`
}

async function reply(
  bridge: ImBridge,
  msg: ImMessage,
  text: string,
  attachments?: ImAttachment[],
): Promise<void> {
  const to: ImUser = msg.from
  await bridge.sendMessage(to, text, {
    chatId: msg.chatId,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  })
}

/**
 * VOICE-M3 — best-effort voice clip for a conversational reply. `undefined`
 * (no voice configured / content skipped / synthesis failed) means the text
 * goes out alone — voice never eats, delays into failure, or replaces a reply
 * the member is owed. Infra failures warn; by-design skips stay quiet.
 */
async function voiceClipFor(config: HostImConfig, text: string): Promise<ImAttachment[] | undefined> {
  if (!config.voice) return undefined
  try {
    const r = await config.voice.synthesize(text)
    if (r.kind === 'clip') {
      return [{ kind: 'audio', bytes: r.bytes, mime: 'audio/opus', filename: 'voice.opus' }]
    }
    if (r.kind === 'failed') {
      config.log.warn('im voice: synthesis failed, sending text only', { reason: r.reason })
    }
    return undefined
  } catch (err) {
    config.log.warn('im voice: synthesis threw, sending text only', { err: String(err) })
    return undefined
  }
}

/**
 * CARE-M2 — 自由文本 dispatch 结果过一道断供滤镜。
 *
 * 返回 true = 已用 canned 回复答复(调用方不再走 summariseResult);
 * false = 不归我管(成功 / 挂起 / 取消 / 认不出的失败),老路径照旧。
 *
 * unknown 故意放行:自由文本的失败不全是 provider 病(工作流步骤炸了、
 * agent 业务错),认不出的一律走既有 `⚠️ Task failed: 原文`——原文本来
 * 就在,那已经是诚实兜底,再包一层「我不认识」反而丢了老用户熟悉的形状。
 *
 * 播报是 best-effort:announce 抛错只记日志,绝不影响对话内的 canned
 * 回复(用户在场的那条线永远优先)。
 */
async function handleLlmOutageOnFreeText(
  bridge: ImBridge,
  msg: ImMessage,
  config: HostImConfig,
  outage: HostImLlmOutageConfig,
  result: TaskResult,
): Promise<boolean> {
  if (result.kind === 'ok') {
    if ((await outage.tracker.onProviderSuccess()) === 'announce_recovery') {
      try {
        await outage.announce?.(llmRecoveryAnnouncement(outage.lang))
      } catch (err) {
        config.log.warn('llm outage: recovery announce failed', { err: String(err) })
      }
    }
    return false
  }
  if (result.kind !== 'failed') return false
  const kind = classifyLlmError(result.error)
  if (kind === 'unknown') return false
  const t = translateLlmFailureKind(kind, outage.lang)
  await reply(bridge, msg, cannedLlmFailureReply(t, outage.lang))
  if ((await outage.tracker.onProviderFailure(kind)) === 'announce') {
    try {
      await outage.announce?.(llmOutageAnnouncement(kind, outage.lang))
    } catch (err) {
      config.log.warn('llm outage: announce failed', { err: String(err) })
    }
  }
  return true
}

/** canned 回复:翻译文案 + 命令面仍可用。零 LLM——断供期间每条自由文本都答得上话。 */
function cannedLlmFailureReply(t: LlmFailureTranslation, lang: FailureLang): string {
  return lang === 'zh'
    ? `⚠️ ${t.headline}\n${t.fix}\n\n这条消息没能让大模型处理;命令照常可用:/help /agents /workflow <名字>。修好后把话再发一遍就行。`
    : `⚠️ ${t.headline}\n${t.fix}\n\nThis message couldn't reach the model; commands still work: /help /agents /workflow <name>. Once it's fixed, just send your message again.`
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

function summariseResult(result: TaskResult, imApprovals = false): string {
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
      // on you", not a nonsensical year-2286 timestamp. A finite resumeAt is a
      // genuine timed suspend (e.g. a long-running poll) — keep the ETA. With
      // the IMA approval surface wired, point at `/inbox` RIGHT HERE instead of
      // sending the member to the web (hub-internal items resolve in-chat).
      return result.resumeAt >= NEVER_RESUME_AT
        ? imApprovals
          ? '这件事需要你先确认一下。发 /inbox 看详情,再用 /approve <id> 或 /deny <id> 答复(部分敏感事项仍需到网页「我的 → 收件箱」处理);处理好我再回来告诉你结果。'
          : '这件事需要你先确认一下,我已经放进你的「我的 → 收件箱」了。你在那儿点确认或拒绝,处理好我再回来告诉你结果。'
        : `⏸ 已安排,预计 ${new Date(result.resumeAt).toISOString()} 前后继续。`
    case 'no_participant':
      return `⚠️ No agent picked it up: ${result.reason}`
  }
}

// ── IMA-M2 approval-verb rendering ──────────────────────────────────────────

const APPROVALS_NOT_ENABLED =
  '此 host 未启用 IM 审批,请到网页「我的 → 收件箱」处理。/ IM approval is not enabled on this host — use the web (/me).'

/**
 * Map an approval-resolve failure to a bilingual reply. Covers BOTH error
 * vocabularies crossing the surface: `ImApprovalError` (short-id gates) and
 * `InboxError` passing through from `HostInboxService.resolve`
 * (`already_resolved`, `forbidden`, …). Duck-typed on `.code` so this module
 * needs no dep on either class.
 */
function describeApprovalError(err: unknown, shortId: string): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : ''
  switch (code) {
    case 'short_id_too_short':
      return '编号太短,至少要 4 位(用 /inbox 查看编号)。/ That id is too short — at least 4 chars (see /inbox).'
    case 'not_found':
      return `没有找到匹配「${shortId}」的待办事项(可能已被处理)。发 /inbox 查看最新列表。/ No pending item matches — see /inbox.`
    case 'ambiguous':
      return `「${shortId}」匹配了多个事项,请用 /inbox 显示的完整编号。/ That prefix is ambiguous — use the full id from /inbox.`
    case 'web_only':
      return '这件事涉及对外或跨 hub 动作,需要在网页上处理:我的 → 收件箱。/ This one must be handled on the web (/me → inbox).'
    case 'not_approval_kind':
      return '这件事需要填写具体内容,不是批准/拒绝就能答的,请到网页上处理。/ This one needs a typed answer — use the web.'
    case 'already_resolved':
      return '这件事已经被处理过了。发 /inbox 查看最新待办。/ Already resolved — see /inbox.'
    case 'forbidden':
      return '这件事不归你处理(可能刚被转派)。/ Not yours to resolve (it may have been delegated).'
    default:
      return `处理失败 / Failed — ${err instanceof Error ? err.message : String(err)}`
  }
}
