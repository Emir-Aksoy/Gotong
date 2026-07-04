/**
 * Steward-aware IM router — `ImMessage` in, `StewardPort.plan` / `.apply` out.
 *
 * This is a FORK of `examples/im-bridge-host/src/router.ts`, not a reuse, and the
 * reason is instructive: the shared `parseImCommand` (`@gotong/im-adapter`) only
 * knows `/help` `/bind` `/unbind` `/agents` `/workflow` — `/steward` and `/apply`
 * are UNKNOWN verbs to it, so they fall through to `{ kind: 'free' }`. The plan
 * (D-D) calls for exactly this: a steward bridge forks the router with its own
 * command vocabulary. We still REUSE `parseImCommand` for the shared verbs
 * (`/help` / `/bind` / `/unbind`) so the binding UX is identical to every other
 * bridge; we just pre-parse the two steward verbs first.
 *
 * The other fork: this router routes to a `StewardPort` (plan / apply — mirroring
 * the host's `MeHubStewardSurface`), NOT to `hub.dispatch`. So it needs no
 * `@gotong/core` Hub at all — the steward is reached the same way from the admin
 * console, the `/me` SPA, and here (one steward, three transports).
 *
 * North-star fit: the steward only ever PROPOSES; the human applies. Dangerous /
 * cross-hub actions don't run on `/apply` — they park to the approval inbox and
 * the user confirms in `/me`. This router carries that honestly to IM: `/apply`
 * on a parked action replies "sent to your inbox, I'll tell you once you confirm",
 * and an async notify-back (D-M2) closes the loop when they resolve it.
 */

import type {
  ImBridge,
  ImBindingResolver,
  ImMessage,
  ImUser,
} from '@gotong/im-adapter'
import { parseImCommand } from '@gotong/im-adapter'

import type {
  StewardClassifiedAction,
  StewardInboxResolveEvent,
  StewardPort,
} from './steward-port.js'

export type ImRouterUnbindHook = (
  platform: string,
  platformUserId: string,
) => Promise<{ removed: boolean }>

export interface StewardImRouterConfig {
  bridge: ImBridge
  port: StewardPort
  resolver: ImBindingResolver
  /** Optional `/unbind` hook (drop the IM binding). */
  onUnbind?: ImRouterUnbindHook
  /** Optional help-copy override. */
  helpText?: string
  /** Optional logger; defaults to `console.error` for non-info. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
}

export const defaultStewardHelpText = [
  'Gotong 管家 (hub steward) — 在这里用大白话管你的助手和工作流：',
  '',
  '  /help              — 显示这份帮助',
  '  /bind <code>       — 绑定你的 Gotong 账号（在个人界面 → 绑定 IM 取 6 位码）',
  '  /unbind            — 解绑',
  '  /steward <大白话>  — 让管家把你的话变成一组「待你确认」的动作',
  '  /apply <编号>      — 执行管家刚提议的第 N 个动作',
  '  <直接说话>          — 等同 /steward（绑定后直接说就行）',
  '',
  '管家只「提议」，你来「确认 + 执行」。危险动作（删助手）和跨 hub 工作流',
  '改动都要你在 /me 收件箱里再确认一次——确认后我会在这里告诉你结果。',
].join('\n')

/** zh badge for a host-assigned tier. */
function tierBadge(tier: string): string {
  switch (tier) {
    case 'safe':
      return '安全'
    case 'dangerous':
      return '需二次确认 · 危险'
    case 'cross_hub':
      return '需二次确认 · 跨 hub'
    case 'forbidden':
      return '不可执行'
    default:
      return tier
  }
}

export class StewardImRouter {
  private readonly bridge: ImBridge
  private readonly port: StewardPort
  private readonly resolver: ImBindingResolver
  private readonly onUnbind?: ImRouterUnbindHook
  private readonly helpText: string
  private readonly log: NonNullable<StewardImRouterConfig['log']>

  /** Per-user last proposal, so `/apply <n>` knows which action to run. */
  private readonly lastProposal = new Map<string, StewardClassifiedAction[]>()
  /**
   * Per-user last-seen IM identity, so the async notify-back (D-M2) can reach
   * the right person. A real bridge persists this; the example keeps it in
   * memory (one binding maps to one IM identity here).
   */
  private readonly reachable = new Map<string, { user: ImUser; chatId?: string }>()

  constructor(config: StewardImRouterConfig) {
    this.bridge = config.bridge
    this.port = config.port
    this.resolver = config.resolver
    this.onUnbind = config.onUnbind
    this.helpText = config.helpText ?? defaultStewardHelpText
    this.log =
      config.log ??
      ((lvl, m, e) => {
        if (lvl !== 'info') console.error(`[steward-router/${lvl}] ${m}`, e ?? '')
      })
  }

  /** Subscribe to inbound IM + the port's resolve events. Call once. */
  start(): void {
    this.bridge.onMessage((msg) => this.handle(msg))
    // D-M2: when a parked action is resolved in /me, notify the IM user.
    this.port.onInboxResolve?.((ev) => this.notifyResolve(ev))
  }

  async handle(msg: ImMessage): Promise<void> {
    try {
      await this.route(msg)
    } catch (err) {
      // A single bad message must not take down the bridge loop.
      this.log('error', 'steward-router.handle failed', err)
      try {
        await this.reply(msg, '抱歉 / sorry — 处理这条消息时出错了，已记录。')
      } catch (sendErr) {
        this.log('error', 'steward-router failed to send error reply', sendErr)
      }
    }
  }

  private async route(msg: ImMessage): Promise<void> {
    const platform = this.bridge.platform
    const raw = (msg.text ?? '').trim()
    const lower = raw.toLowerCase()

    // --- Pre-parse the two steward verbs parseImCommand doesn't know. -------
    const isStewardCmd = lower === '/steward' || lower.startsWith('/steward ')
    const isApplyCmd = lower === '/apply' || lower.startsWith('/apply ')

    // --- Shared verbs (help / bind / unbind) via parseImCommand. ------------
    if (!isStewardCmd && !isApplyCmd) {
      const cmd = parseImCommand(raw)
      if (cmd.kind === 'help') {
        await this.reply(msg, this.helpText)
        return
      }
      if (cmd.kind === 'bind') {
        await this.handleBind(platform, msg, cmd.code)
        return
      }
      // `/unbind` + free text still need a binding; resolve below.
    }

    // --- Everything else requires a binding. Resolve once. ------------------
    const userId = await this.resolver.resolveUserId(platform, msg.from.platformUserId)
    if (userId === null) {
      await this.reply(
        msg,
        '你还没绑定 Gotong 账号。去个人界面 → 绑定 IM 取一个 6 位码，然后发我 `/bind <code>`。',
      )
      return
    }
    // Remember how to reach this user for the async notify-back (D-M2).
    this.reachable.set(userId, {
      user: msg.from,
      ...(msg.chatId ? { chatId: msg.chatId } : {}),
    })

    if (isApplyCmd) {
      await this.handleApply(userId, msg, raw)
      return
    }

    if (isStewardCmd) {
      const text = raw.slice('/steward'.length).trim()
      await this.handlePlan(userId, msg, text)
      return
    }

    // Re-parse for the bound-only shared verbs.
    const cmd = parseImCommand(raw)
    if (cmd.kind === 'unbind') {
      if (!this.onUnbind) {
        await this.reply(msg, '这个桥没有配置解绑钩子，请让管理员帮你移除绑定。')
        return
      }
      const out = await this.onUnbind(platform, msg.from.platformUserId)
      this.reachable.delete(userId)
      this.lastProposal.delete(userId)
      await this.reply(msg, out.removed ? '✓ 已解绑。再发 /bind <code> 可重新绑定。' : '没有可解绑的绑定。')
      return
    }

    // Free text (or any `/agents` `/workflow` the steward bridge doesn't use)
    // goes to the steward as a plain-language instruction.
    await this.handlePlan(userId, msg, cmd.kind === 'free' ? cmd.text : raw)
  }

  private async handleBind(platform: string, msg: ImMessage, code: string): Promise<void> {
    const result = await this.resolver.claim({
      code,
      platform,
      platformUserId: msg.from.platformUserId,
      displayName: msg.from.displayName ?? null,
    })
    if (result.ok) {
      this.log('info', `bind ok platform=${platform} user=${result.userId}`)
      this.reachable.set(result.userId, {
        user: msg.from,
        ...(msg.chatId ? { chatId: msg.chatId } : {}),
      })
      await this.reply(msg, `✓ 已绑定，你现在是 ${result.userId}。直接用大白话跟我说，或发 /help。`)
      return
    }
    const detail =
      result.reason === 'expired'
        ? '这个码过期了——请在个人界面重新取一个。'
        : '没认出这个码，核对一下，或在个人界面重新取一个。'
    await this.reply(msg, `✗ 绑定失败 — ${detail}`)
  }

  private async handlePlan(userId: string, msg: ImMessage, instruction: string): Promise<void> {
    if (instruction.length === 0) {
      await this.reply(msg, '想让我做什么？用大白话说，比如「帮我建一个客服助手」。')
      return
    }
    const proposal = await this.port.plan({ userId, instruction })
    this.lastProposal.set(userId, proposal.actions)
    await this.reply(msg, this.renderProposal(proposal.reply, proposal.actions))
  }

  private async handleApply(userId: string, msg: ImMessage, raw: string): Promise<void> {
    const arg = raw.slice('/apply'.length).trim()
    const actions = this.lastProposal.get(userId)
    if (!actions || actions.length === 0) {
      await this.reply(msg, '现在没有待执行的提议。先用大白话跟我说你想做什么。')
      return
    }
    const n = Number.parseInt(arg, 10)
    if (!Number.isInteger(n) || n < 1 || n > actions.length) {
      await this.reply(msg, `请用 /apply <1..${actions.length}> 选一个要执行的动作。`)
      return
    }
    const chosen = actions[n - 1]!
    const outcome = await this.port.apply({ userId, action: chosen.action })
    await this.reply(msg, this.renderOutcome(chosen, outcome))
  }

  // -- Rendering (zh; all derived from host-authoritative fields) -----------

  private renderProposal(reply: string, actions: StewardClassifiedAction[]): string {
    // An inspect-only answer reads as a plain reply, no numbered actions.
    if (actions.length === 1 && actions[0]!.action.kind === 'inspect') {
      return `管家：${reply}`
    }
    if (actions.length === 0) return `管家：${reply}`
    const lines = [`管家：${reply}`, '']
    actions.forEach((a, i) => {
      lines.push(`  ${i + 1}. [${tierBadge(a.tier)}] ${a.summary}`)
    })
    const applyable = actions.some((a) => a.tier !== 'forbidden')
    lines.push('')
    lines.push(
      applyable
        ? '回复 /apply <编号> 执行其中一个。'
        : '（这些我都不能替你执行，仅作说明。）',
    )
    return lines.join('\n')
  }

  private renderOutcome(
    chosen: StewardClassifiedAction,
    outcome: Awaited<ReturnType<StewardPort['apply']>>,
  ): string {
    switch (outcome.status) {
      case 'done':
        return `✓ 已执行：${chosen.summary}`
      case 'pending_approval':
        return [
          `⏸ 已送你的 /me 收件箱待确认（${tierBadge(outcome.tier)}）：${chosen.summary}`,
          '确认后我会在这里告诉你结果。',
        ].join('\n')
      case 'refused':
        return `✗ 已拒绝：${outcome.reason}`
      case 'invalid':
        return `✗ 动作无效：${outcome.reason}`
    }
  }

  /** D-M2 — a parked action was resolved in /me; tell the IM user. */
  private async notifyResolve(ev: StewardInboxResolveEvent): Promise<void> {
    const target = this.reachable.get(ev.userId)
    if (!target) {
      // We have no IM identity for this user (they bound on another bridge, or
      // the process restarted). A real host would look this up persistently.
      this.log('warn', `no IM target for resolved item user=${ev.userId}`)
      return
    }
    const subject = ev.subject ? ` → ${ev.subject}` : ''
    const text =
      ev.decision === 'approved'
        ? `✓ 你在收件箱确认了「${ev.action.kind}${subject}」— 已执行。`
        : `✗ 你在收件箱拒绝了「${ev.action.kind}${subject}」— 未执行。`
    await this.bridge.sendMessage(target.user, text, {
      ...(target.chatId ? { chatId: target.chatId } : {}),
    })
  }

  private async reply(msg: ImMessage, text: string): Promise<void> {
    await this.bridge.sendMessage(msg.from, text, {
      ...(msg.chatId ? { chatId: msg.chatId } : {}),
    })
  }
}
