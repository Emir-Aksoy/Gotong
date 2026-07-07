/**
 * personal-butler-ask-peer.ts — NET-M2. The resident butler's GOVERNED
 * "替我问一下对端 hub" — the first conversational doorway OUT of the hub.
 *
 * "问问爸爸的 hub 今晚有没有空" — the butler relays the question across a mesh
 * edge, the member confirms first, the answer comes back in the same chat.
 * Every hard part already exists: `installPeerLink`'s wrapper (outbound
 * allowlist / data-class gate / origin stamp / owner approval decoration) IS
 * the road; this file only adds the conversational on-ramp and the member's
 * own confirmation. No new privilege: the butler cannot make a task cross that
 * the same member couldn't send via a workflow step today.
 *
 * ── Why GOVERNED where ask_my_agent is benign ────────────────────────────────
 * Asking your own agent is self-service. Leaving the hub is consequential —
 * it spends the far side's resources and crosses a data boundary — matching
 * the steward taxonomy where cross_hub demands a SECOND confirmation. So every
 * ask_peer call parks for the member's own /me approval before anything moves.
 *
 * ── Two gates, each guarding its own principal ───────────────────────────────
 * Member gate (this file, "I really do want to send this line out") fires
 * FIRST; the owner gate (per-peer `requireApprovalOutbound` → wrapper
 * decoration, "this org edge permits outbound") remains downstream and cannot
 * be bypassed — the dispatch lands on the decorated wrapper like everyone
 * else's. When the owner gate parks after the member approved, the member gets
 * an honest "还差 owner 一道" instead of a fake success.
 *
 * ── Only a CURATED edge is askable (G-M1: advertise = authorize) ─────────────
 * Cross-hub task flow is capability-addressed, period. The wrapper forwards a
 * task with its strategy VERBATIM and the far hub re-dispatches by that same
 * strategy — an `explicit` aimed at OUR wrapper id names nobody over there
 * (the two-hub e2e proved it: crosses the wire, dies `no_participant`). And
 * `row.outboundCaps` doubles as the wrapper's ADVERTISED capabilities
 * (peer-registry, G-M1), so:
 *   outboundCaps null  → wrapper advertises NOTHING — capability dispatch
 *                        cannot even route to the edge. Honest refusal with
 *                        curation guidance; "send-all" on a legacy edge is an
 *                        allowlist truth, not a routability truth.
 *   lockdown []        → honest refusal before any park.
 *   whitelist [...]    → capability dispatch. Pre-flight is read-only honesty:
 *                        the cap must be unambiguous (not served locally,
 *                        advertised by exactly this one edge), else refuse
 *                        with guidance; the REAL gate stays in the wrapper.
 * Same mesh semantics as a cross-hub workflow step — the butler gets no
 * private addressing mode.
 * The route is resolved TWICE: at classify (refuse nonsense before wasting an
 * approval) and again at execute (approval may land minutes later; posture may
 * have changed — a changed edge yields an honest "情况变了", never a blind send
 * on stale assumptions and never a silent re-block of the approved intent).
 *
 * ── No pre-stamped origin ────────────────────────────────────────────────────
 * The dispatch deliberately carries NO `origin`: the wrapper's originResolver
 * stamps `{orgId: <selfHubId>, userId}` — the receiver must see the TRUE hub
 * identity, not a 'local' sentinel passed through the multi-hop branch.
 */

import type { TaskResult } from '@gotong/core'
import { GovernedActionToolset, type GovernedVerdict } from '@gotong/personal-butler'

import type { ButlerPeerRow, ButlerPeerSurface } from './personal-butler-peers.js'

/** The two Hub slices this tool drives — dispatch + the live local-caps view. */
export interface ButlerAskPeerHub {
  dispatch(input: {
    from: string
    strategy: { kind: 'capability'; capabilities: string[] }
    payload: unknown
    title: string
  }): Promise<TaskResult>
  participants(): Array<{ id: string; capabilities: readonly string[] }>
}

export interface ButlerAskPeerDeps {
  /** The member this butler serves — dispatch is attributed to them. */
  userId: string
  /** NET-M1's sanitized roster — one target list for eye and action, no drift. */
  peers: ButlerPeerSurface
  hub: ButlerAskPeerHub
  logger?: { error: (msg: string, meta?: Record<string, unknown>) => void }
}

/** A resolved way out — or an honest reason there isn't one. */
export type AskPeerRoute =
  | { ok: true; peer: ButlerPeerRow; capability: string }
  | { ok: false; reason: string }

/**
 * Resolve HOW to reach `peerId` given the edge's outbound posture. Pure — the
 * live inputs (roster + local capability set) are handed in, so classify and
 * execute share one brain and tests need no hub.
 */
export function resolveAskPeerRoute(input: {
  peerId: string
  capability: string | null
  roster: ButlerPeerRow[]
  localCaps: ReadonlySet<string>
}): AskPeerRoute {
  const { peerId, capability, roster, localCaps } = input
  const peer = roster.find((r) => r.peerId === peerId)
  if (!peer) {
    const ids = roster.map((r) => r.peerId).join('、')
    return {
      ok: false,
      reason: ids
        ? `「${peerId}」不是互联的对端。互联的有:${ids}(用 list_peers 看详情)。`
        : `「${peerId}」不是互联的对端——这台 hub 还没有互联任何对端。`,
    }
  }
  const caps = peer.outboundCaps
  if (caps === null) {
    // 老式边:出站 ACL 是「什么都放行」,但 wrapper 广告为空——按能力派发根本
    // 选不中它,而 explicit 过线后对端也路由不了(两 hub e2e 证过)。诚实说清。
    return {
      ok: false,
      reason: `到「${labelOf(peer)}」的这条边还没策展可出网的能力,现在派不出请求;请管理员在对端配置里给这条边配 outboundCaps(策展即授权)。`,
    }
  }
  if (caps.length === 0) {
    return { ok: false, reason: `到「${labelOf(peer)}」的这条边出站已锁死,现在什么都发不出去。` }
  }
  // Curated edge → capability addressing. Pick the capability, then insist it
  // is unambiguous — routing must deterministically land on THIS edge.
  let cap: string
  if (capability) {
    if (!caps.includes(capability)) {
      return { ok: false, reason: `这条边不允许「${capability}」。可用:${caps.join('、')}。` }
    }
    cap = capability
  } else if (caps.length === 1) {
    cap = caps[0]!
  } else {
    return { ok: false, reason: `这条边有多个可用能力(${caps.join('、')}),再说清楚要用哪个(capability 参数)。` }
  }
  if (localCaps.has(cap)) {
    return {
      ok: false,
      reason: `「${cap}」本地也有人服务,按能力派发会先落在本地,没法确定送到对端;请管理员给这条边策展一个专属能力名。`,
    }
  }
  const advertisers = roster.filter((r) => r.outboundCaps?.includes(cap))
  if (advertisers.length > 1) {
    return {
      ok: false,
      reason: `「${cap}」有多条边都认(${advertisers.map((r) => r.peerId).join('、')}),没法确定送到「${peerId}」;请管理员策展专属能力名。`,
    }
  }
  return { ok: true, peer, capability: cap }
}

/**
 * Build the per-user governed `ask_peer` gate. Compose into
 * `PersonalButlerAgent.governed` alongside the steward / create_workflow gates
 * (disjoint tool name). Classify refuses nonsense BEFORE parking; execute runs
 * only after the member approved in /me.
 */
export function buildButlerAskPeerToolset(deps: ButlerAskPeerDeps): GovernedActionToolset {
  const { userId, peers, hub, logger } = deps

  /** Live view: roster + the capability set of NON-wrapper participants. */
  const liveView = async (): Promise<{ roster: ButlerPeerRow[]; localCaps: Set<string> }> => {
    const roster = await peers.listForButler()
    const peerIds = new Set(roster.map((r) => r.peerId))
    const localCaps = new Set<string>()
    for (const p of hub.participants()) {
      if (peerIds.has(p.id)) continue
      for (const c of p.capabilities) localCaps.add(c)
    }
    return { roster, localCaps }
  }

  const parseArgs = (args: Record<string, unknown>): { peerId: string; message: string; capability: string | null } => ({
    peerId: typeof args.peerId === 'string' ? args.peerId.trim() : '',
    message: typeof args.message === 'string' ? args.message : '',
    capability: typeof args.capability === 'string' && args.capability.trim() ? args.capability.trim() : null,
  })

  return new GovernedActionToolset({
    tools: [
      {
        name: 'ask_peer',
        description:
          '替这个成员向一个互联的对端 hub 发一句请求/问题,拿到回答带回来。会先送 /me 收件箱等成员本人确认(这是出网动作);对端那条边自己的信任契约照常生效。先用 list_peers 看有哪些对端和这条边允许发什么。',
        inputSchema: {
          type: 'object',
          properties: {
            peerId: { type: 'string', description: '对端 hub 的 id(见 list_peers)。' },
            message: { type: 'string', description: '要发过去的话,用大白话写清楚。' },
            capability: {
              type: 'string',
              description: '(可选)白名单边上用哪个能力发;这条边只开一个能力时可省略。',
            },
          },
          required: ['peerId', 'message'],
          additionalProperties: false,
        },
      },
    ],
    // Park 前的服务端权威分级:无效目标 / 锁死边 / 歧义能力在这里就拒,
    // 绝不浪费成员一次审批;有效 → approve(出网必须成员点头)。
    classify: async (_name, args): Promise<GovernedVerdict> => {
      const { peerId, message, capability } = parseArgs(args)
      if (!peerId) return { decision: 'refuse', reason: '没说要问哪个对端(缺 peerId)。先用 list_peers 看看。' }
      if (!message.trim()) return { decision: 'refuse', reason: '没说要发什么。再写一下要问的话?' }
      let route: AskPeerRoute
      try {
        const { roster, localCaps } = await liveView()
        route = resolveAskPeerRoute({ peerId, capability, roster, localCaps })
      } catch (err) {
        logger?.error('butler ask_peer: classify view failed', { err })
        return { decision: 'refuse', reason: '暂时读不到互联列表,稍后再试。' }
      }
      if (!route.ok) return { decision: 'refuse', reason: route.reason }
      return {
        decision: 'approve',
        reason: `要出网发给对端「${labelOf(route.peer)}」——先请你确认`,
      }
    },
    // 成员在 /me 批准之后才会走到这里。姿态重解析:审批可能落在几分钟后,
    // 边的姿态可能已变——变了就诚实说「情况变了没发」,绝不按旧快照盲发,
    // 也绝不静默重新拦下已批准的意图。
    execute: async (_name, args) => {
      const { peerId, message, capability } = parseArgs(args)
      let route: AskPeerRoute
      try {
        const { roster, localCaps } = await liveView()
        route = resolveAskPeerRoute({ peerId, capability, roster, localCaps })
      } catch (err) {
        logger?.error('butler ask_peer: execute view failed', { err })
        return { text: '读不到互联列表,这次没发出去,稍后再试。', isError: true }
      }
      if (!route.ok) {
        return { text: `批准后情况变了:${route.reason} 这次没发出去。`, isError: true }
      }
      const label = labelOf(route.peer)
      let result: TaskResult
      try {
        result = await hub.dispatch({
          from: userId,
          // 不带 origin —— wrapper 的 originResolver 会盖真实 hub 身份。
          strategy: { kind: 'capability', capabilities: [route.capability] },
          payload: message,
          title: `出网问「${label}」— ${userId}`,
        })
      } catch (err) {
        logger?.error('butler ask_peer: dispatch failed', { err, peerId })
        return { text: `发给「${label}」的时候出错了,稍后再试。`, isError: true }
      }
      switch (result.kind) {
        case 'ok': {
          const reply = replyText(result.output)
          return reply
            ? { text: `对端「${label}」回复:\n${reply}` }
            : { text: `对端「${label}」回复了,但没有可读的文字内容。` }
        }
        case 'suspended':
          // owner 闸(requireApprovalOutbound)在成员闸之后又停了一道——第二道
          // 闸的最终答案回传是 NET-M3 的评估项,这里先把顺序讲诚实。
          return {
            text: `已递出去,但到「${label}」的这条边还需要 hub 管理员再批一道;批完对端才会真正收到。`,
          }
        case 'no_participant':
          return { text: `对端「${label}」现在不在线(或这条边还没接通),稍后再试。`, isError: true }
        case 'failed':
          if (result.error.startsWith('outbound_capability_denied')) {
            return {
              text: `这条边不允许发这类请求(${result.error});请管理员在对端信任契约里放行或策展能力名。`,
              isError: true,
            }
          }
          if (result.error === 'outbound_approval_denied') {
            return { text: `hub 管理员拒绝了这次出站,没发给「${label}」。`, isError: true }
          }
          return { text: `对端「${label}」没能完成:${result.error}`, isError: true }
        case 'cancelled':
          return { text: `这次出网询问被取消了(${result.reason})。`, isError: true }
      }
    },
    // /me 收件箱标题——成员批的是「把哪句话发给谁」,不是一个抽象动作名。
    describe: (_name, args) => {
      const { peerId, message } = parseArgs(args)
      const brief = message.length > 40 ? message.slice(0, 39) + '…' : message
      return `出网询问对端「${peerId}」:${brief || '(未写内容)'}`
    },
  })
}

function labelOf(peer: ButlerPeerRow): string {
  return peer.label ? `${peer.peerId}(${peer.label})` : peer.peerId
}

/** Same two-shape reply extraction as ask_my_agent (kept local — no coupling). */
function replyText(output: unknown): string | null {
  if (typeof output === 'string') return output.trim() || null
  if (output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
    return (output as { text: string }).text.trim() || null
  }
  return null
}
