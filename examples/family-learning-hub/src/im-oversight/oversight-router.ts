/**
 * Family oversight IM router — `ImMessage` in, `FamilyOversightPort` approve / reject out.
 *
 * A FORK of `examples/im-steward-bridge/src/steward-router.ts` (same north-star shape: one
 * approval surface reached identically from /me and from IM; the human confirms, the
 * framework only ever proposes). The vocabulary differs because the PARENT's job here is to
 * APPROVE, not to author: `/pending` lists the lessons awaiting their blessing, `/approve <n>`
 * / `/reject <n>` act on them. We REUSE `parseImCommand` for `/help` `/bind` `/unbind` (so the
 * binding UX is identical to every other bridge) and pre-parse the three oversight verbs
 * (which `parseImCommand` doesn't know — they'd fall through to `{ kind: 'free' }`).
 *
 * The single result path: `/approve` / `/reject` reply ONLY on a validation error (no
 * pending / bad index / already handled). The SUCCESS message is pushed by
 * `onResolve` → `notifyResolve` → `sendMessage`. That one path serves BOTH an IM-initiated
 * resolve AND a /me-initiated one, so the parent always gets exactly one consistent
 * "✓ approved / ✗ rejected" — never zero, never two. (Mirrors steward-router's async
 * notify-back, generalised to cover IM resolves too.)
 */

import type { ImBridge, ImBindingResolver, ImMessage, ImUser } from '@aipehub/im-adapter'
import { parseImCommand } from '@aipehub/im-adapter'

import type {
  FamilyOversightPort,
  OversightParkEvent,
  OversightResolveEvent,
} from './oversight-port.js'

export type ImRouterUnbindHook = (
  platform: string,
  platformUserId: string,
) => Promise<{ removed: boolean }>

export interface OversightImRouterConfig {
  bridge: ImBridge
  port: FamilyOversightPort
  resolver: ImBindingResolver
  /** Optional `/unbind` hook (drop the IM binding). */
  onUnbind?: ImRouterUnbindHook
  /** Optional help-copy override. */
  helpText?: string
  /** Optional logger; defaults to `console.error` for non-info. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void
}

export const defaultOversightHelpText = [
  'AipeHub 家长监督 — 你的孩子要学白名单外（或被规则标记）的课题时，会先来这里等你批准：',
  '',
  '  /help            — 显示这份帮助',
  '  /bind <code>     — 绑定你的 AipeHub 账号（在个人界面 → 绑定 IM 取 6 位码）',
  '  /unbind          — 解绑',
  '  /pending         — 列出等你批准的课程',
  '  /approve <编号>  — 批准第 N 节课（孩子才能上）',
  '  /reject <编号>   — 拒绝第 N 节课',
  '',
  '只有你批准，课程才会跨到导师那边开讲。你也可以在 /me 收件箱里批——结果都会回到这里告诉你。',
].join('\n')

export class OversightImRouter {
  private readonly bridge: ImBridge
  private readonly port: FamilyOversightPort
  private readonly resolver: ImBindingResolver
  private readonly onUnbind?: ImRouterUnbindHook
  private readonly helpText: string
  private readonly log: NonNullable<OversightImRouterConfig['log']>

  /** Per-user snapshot of the last `/pending` listing, so `/approve <n>` maps to a STABLE itemId. */
  private readonly lastListed = new Map<string, string[]>()
  /**
   * Per-user last-seen IM identity, so the async result push (onResolve) can reach the right
   * parent. A real bridge persists this; the example keeps it in memory (one binding ↔ one
   * IM identity here).
   */
  private readonly reachable = new Map<string, { user: ImUser; chatId?: string }>()

  constructor(config: OversightImRouterConfig) {
    this.bridge = config.bridge
    this.port = config.port
    this.resolver = config.resolver
    this.onUnbind = config.onUnbind
    this.helpText = config.helpText ?? defaultOversightHelpText
    this.log =
      config.log ??
      ((lvl, m, e) => {
        if (lvl !== 'info') console.error(`[oversight-router/${lvl}] ${m}`, e ?? '')
      })
  }

  /** Subscribe to inbound IM + the port's park / resolve events. Call once. */
  start(): void {
    this.bridge.onMessage((msg) => this.handle(msg))
    // D-M2: when a lesson parks, tell the parent; when one is resolved (IM or /me), push the result.
    this.port.onParked = (ev) => this.notifyPark(ev)
    this.port.onResolve = (ev) => this.notifyResolve(ev)
  }

  async handle(msg: ImMessage): Promise<void> {
    try {
      await this.route(msg)
    } catch (err) {
      // A single bad message must not take down the bridge loop.
      this.log('error', 'oversight-router.handle failed', err)
      try {
        await this.reply(msg, '抱歉 / sorry — 处理这条消息时出错了，已记录。')
      } catch (sendErr) {
        this.log('error', 'oversight-router failed to send error reply', sendErr)
      }
    }
  }

  private async route(msg: ImMessage): Promise<void> {
    const platform = this.bridge.platform
    const raw = (msg.text ?? '').trim()
    const lower = raw.toLowerCase()

    // --- Pre-parse the three oversight verbs parseImCommand doesn't know. ----
    const isPending = lower === '/pending'
    const isApprove = lower === '/approve' || lower.startsWith('/approve ')
    const isReject = lower === '/reject' || lower.startsWith('/reject ')

    // --- Shared verbs (help / bind) via parseImCommand. ---------------------
    if (!isPending && !isApprove && !isReject) {
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
        '你还没绑定 AipeHub 账号。去个人界面 → 绑定 IM 取一个 6 位码，然后发我 `/bind <code>`。',
      )
      return
    }
    // Remember how to reach this parent for the async result push (onResolve).
    this.reachable.set(userId, {
      user: msg.from,
      ...(msg.chatId ? { chatId: msg.chatId } : {}),
    })

    if (isPending) {
      await this.handlePending(userId, msg)
      return
    }
    if (isApprove) {
      await this.handleDecision(userId, msg, raw, '/approve', 'approved')
      return
    }
    if (isReject) {
      await this.handleDecision(userId, msg, raw, '/reject', 'rejected')
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
      this.lastListed.delete(userId)
      await this.reply(msg, out.removed ? '✓ 已解绑。再发 /bind <code> 可重新绑定。' : '没有可解绑的绑定。')
      return
    }

    // Any other free text — the parent's job here is to approve, not to chat. Nudge.
    await this.reply(msg, '我帮你盯着孩子的课程审批。发 /pending 看有哪些等你批，或 /help 看用法。')
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
      await this.reply(
        msg,
        `✓ 已绑定，你现在是 ${result.userId}。孩子要学白名单外的课题时我会在这里找你。发 /pending 看现在有没有待批的。`,
      )
      return
    }
    const detail =
      result.reason === 'expired'
        ? '这个码过期了——请在个人界面重新取一个。'
        : '没认出这个码，核对一下，或在个人界面重新取一个。'
    await this.reply(msg, `✗ 绑定失败 — ${detail}`)
  }

  private async handlePending(userId: string, msg: ImMessage): Promise<void> {
    const pending = await this.port.pending(userId)
    this.lastListed.set(
      userId,
      pending.map((p) => p.itemId),
    )
    if (pending.length === 0) {
      await this.reply(msg, '✓ 现在没有等你批的课程。')
      return
    }
    const lines = ['等你批准的课程：', '']
    pending.forEach((item, i) => {
      const m = this.port.metaFor(item.itemId)
      const who = m ? `孩子 ${m.learnerId} · ` : ''
      const why = m ? `（${m.reason}）` : ''
      const topic = m ? m.topic : (item.title ?? item.prompt)
      lines.push(`  ${i + 1}. ${who}${topic}${why}`)
    })
    lines.push('')
    lines.push('回复 /approve <编号> 批准，或 /reject <编号> 拒绝。')
    await this.reply(msg, lines.join('\n'))
  }

  private async handleDecision(
    userId: string,
    msg: ImMessage,
    raw: string,
    verb: '/approve' | '/reject',
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    const arg = raw.slice(verb.length).trim()
    const listed = this.lastListed.get(userId)
    if (!listed || listed.length === 0) {
      await this.reply(msg, `先发 /pending 看一下有哪些等你批的课程，再 ${verb} <编号>。`)
      return
    }
    const n = Number.parseInt(arg, 10)
    if (!Number.isInteger(n) || n < 1 || n > listed.length) {
      await this.reply(msg, `请用 ${verb} <1..${listed.length}> 选一节课。`)
      return
    }
    const itemId = listed[n - 1]!
    const outcome = await this.port.resolve({ parentUserId: userId, itemId, decision })
    // The SUCCESS message is pushed by notifyResolve (one path for IM + /me). Reply here
    // ONLY on the error outcomes — so a successful /approve produces exactly one message.
    switch (outcome.status) {
      case 'done':
        return // notifyResolve will push "✓ approved / ✗ rejected"
      case 'already_resolved':
        await this.reply(msg, '这节课已经处理过了（可能你刚在 /me 批过，或重复点了）。发 /pending 看最新的。')
        return
      case 'not_found':
        await this.reply(msg, '没找到这节课，可能已经处理掉了。发 /pending 看最新的。')
        return
      case 'forbidden':
        await this.reply(msg, '这不是你孩子的课程，不能由你处理。')
        return
    }
  }

  /** A lesson parked — tell the bound parent it needs their blessing. */
  private async notifyPark(ev: OversightParkEvent): Promise<void> {
    const target = this.reachable.get(ev.parentUserId)
    if (!target) {
      // No IM identity for this parent yet (they haven't messaged since the process started).
      // A real host persists binding → chatId; the example keeps it in memory.
      this.log('warn', `no IM target for parked lesson parent=${ev.parentUserId}`)
      return
    }
    const text = [
      `🔔 孩子「${ev.learnerId}」想学「${ev.topic}」`,
      `   原因：${ev.reason}`,
      '   发 /pending 查看并 /approve / /reject。',
    ].join('\n')
    await this.bridge.sendMessage(target.user, text, {
      ...(target.chatId ? { chatId: target.chatId } : {}),
    })
  }

  /** A parked lesson was resolved (IM or /me) — push the ONE result message back. */
  private async notifyResolve(ev: OversightResolveEvent): Promise<void> {
    const target = this.reachable.get(ev.parentUserId)
    if (!target) {
      this.log('warn', `no IM target for resolved lesson parent=${ev.parentUserId}`)
      return
    }
    const text =
      ev.decision === 'approved'
        ? `✓ 你批准了「${ev.topic}」（孩子 ${ev.learnerId}）— 这节课可以开讲了。`
        : `✗ 你拒绝了「${ev.topic}」（孩子 ${ev.learnerId}）— 这节课不会开。`
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
