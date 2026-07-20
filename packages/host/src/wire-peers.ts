import type { Hub, Logger, Participant, RemoteHubViaLink, Space } from '@gotong/core'
import type { IdentityStore, PeerRegistration } from '@gotong/identity'
import type { FileInboxStore } from '@gotong/inbox'
import type { WebServerOptions } from '@gotong/web'

import { envBool, envInt } from './main-cli.js'
import { PeerRegistry } from './peer-registry.js'
import { McpProxyHost, fetchPeerSharedMcp } from './mcp-proxy.js'
import { ApprovalGatedParticipant } from './outbound-approval.js'
import {
  PeerManifestHost,
  createPeerManifestFederation,
  type PeerManifestFederation,
} from './peer-manifest.js'
import {
  PeerSummaryHost,
  PEER_SUMMARY_METHODS,
  buildLocalSummary,
  createPeerSummaryFederation,
  type BuildSummaryDeps,
  type PeerSummaryFederation,
} from './peer-summary.js'
import { PeerTranscriptHost, PEER_TRANSCRIPT_METHODS } from './peer-transcript.js'
import { buildButlerPeerSurface, type ButlerPeerSurface } from './personal-butler-peers.js'

type PeerRegistryOptions = ConstructorParameters<typeof PeerRegistry>[0]

/**
 * 联邦这一侧的全部接线:peer registry + 跨 hub MCP 代理 + 三个 RPC provider
 * (manifest / summary / transcript) + 出站审批闸 + 两个 admin 发现面 + 可选的
 * 告警扫描定时器。
 *
 * 它原先是 main() 里一个 250 行的 `if` 块。抽出来最大的收获不是行数,是**依赖
 * 面第一次写了出来**:在 main() 里它随手就能摸到闭包里的任何东西,谁也说不清
 * 联邦到底要什么;现在下面这个 params 就是答案,想多要一样东西得先在这儿加一
 * 行,是看得见的动作。
 *
 * 调用方只在 `identity` 存在且没设 `GOTONG_PEERS_DISABLED=1` 时进来 —— 联邦要
 * v4 身份,这个判断留在 main() 里,因为「装不装」是装配层的决定。
 */
export interface WirePeersParams {
  hub: Hub
  identity: IdentityStore
  space: Space
  logger: Logger
  /** 入站 mesh 骑 serveWebSocket 的首帧 demux,不是另起一个 wss 监听器。 */
  acceptInbound: PeerRegistryOptions['acceptInbound']
  /** 有它 + 有 owner 才装得起出站审批闸;缺任一响亮记一笔,绝不静默 fail-open。 */
  inboxStore: FileInboxStore | undefined
  /** 出站审批的审批人 = 本组织 owner(boot 时解析一次)。 */
  approverUserId: string | null
  workflows: BuildSummaryDeps['workflows']
}

export interface WiredPeers {
  peerRegistry: PeerRegistry
  mcpProxy: McpProxyHost
  mcpFederation: WebServerOptions['mcpFederation']
  peerFederation: PeerManifestFederation
  peerSummaryFederation: PeerSummaryFederation
  /** NET-M1 阿同的脱敏 mesh 花名册。 */
  peerRoster: ButlerPeerSurface
  /** 只有开了告警扫描才有;shutdown 要 clearInterval。 */
  alertSweepTimer: ReturnType<typeof setInterval> | undefined
}

/** 钳进 [lo,hi];非数字回落 def。 */
function clampInt(raw: string | undefined, def: number, lo: number, hi: number): number {
  const n = Number(raw ?? '')
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : def
}

export async function wirePeers(params: WirePeersParams): Promise<WiredPeers> {
  const { hub, identity, space, logger: log, acceptInbound, inboxStore, approverUserId, workflows } = params

  const spaceMeta = await space.meta()
  const selfHubId = spaceMeta.hubId ?? 'self'
  const pollMs = envInt('GOTONG_PEER_POLL_MS', 5_000)
  const inboundToken = process.env.GOTONG_PEER_INBOUND_TOKEN
  // Audit #142 — single source of truth for "is this host behind a reverse proxy".
  const trustProxy = envBool('GOTONG_TRUST_PROXY', false)
  // Audit #149 — env wiring for the inbound rate limit. Default 60/60s mirrors
  // PeerRegistry's own default (set to 0 either side to disable; useful in closed
  // networks / tests). Operators raise these when running a peer farm where
  // 60 hellos / 60s is genuinely too tight, or drop them when under sustained
  // attack and a tighter floor is preferable to letting one IP saturate.
  const rateLimitMax = envInt('GOTONG_PEER_INBOUND_RATE_MAX', 60)
  const rateLimitWindowMs = envInt('GOTONG_PEER_INBOUND_RATE_WINDOW_MS', 60_000)
  const inboundRateLimit = { max: rateLimitMax, windowMs: rateLimitWindowMs }
  // Phase 19 P4-M4 — fixed window for the per-link inbound quota counter
  // (`perLinkQuotaBudget` tasks per window). Default 60s; in-memory, resets on
  // restart (a fail-closed safety cap, not a billing ledger).
  const linkQuotaWindowMs = envInt('GOTONG_PEER_LINK_QUOTA_WINDOW_MS', 60_000)

  // Provider side of the cross-hub MCP proxy. Reads the same hub registry the
  // admin UI writes; only servers flagged `shared` are ever served to a peer
  // (ACL lives inside respond()).
  const mcpProxy = new McpProxyHost({ space, logger: log })
  const proxyRespond = mcpProxy.respond

  // `peerWrapperIds` is a thunk so it reflects the registry's CURRENT peers
  // (each wrapper is registered under the peer's hub id) — we advertise our own
  // agents, never a neighbour's. It's read AFTER construction, hence the `let`.
  let registry: PeerRegistry | undefined
  const peerWrapperIds = () => new Set((registry?.status() ?? []).map((r) => r.peerId))

  // Phase 18 A-M1 — peer capability manifest provider, composed with the MCP
  // proxy onto the single rpcResponder: `mcp.*` → MCP proxy, anything else →
  // manifest host.
  const peerManifestHost = new PeerManifestHost({ hub, hubId: selfHubId, peerWrapperIds })
  // v5 E5 — privacy-safe footprint summary (the free-graph control plane).
  // Counts only, built on demand from the same hub + workflow + identity
  // surfaces. Shared by the RPC provider (answers a peer's `peer.summary`) AND
  // the federation surface's `local()`. The per-link gate in peer-registry
  // denies `peer.summary` unless the row opted into sharing.
  const summaryDeps: BuildSummaryDeps = { hub, hubId: selfHubId, peerWrapperIds, workflows, identity }
  const peerSummaryHost = new PeerSummaryHost(summaryDeps)
  // v5 Stream G day-5 — cross-hub transcript chain provider. Answers a peer's
  // `peer.transcript { taskId }` with the slice of THIS hub's transcript for
  // that one task — never our internal sub-dispatches, which carry different
  // ids. Gated per-link on `share_transcript` (identity v27).
  const peerTranscriptHost = new PeerTranscriptHost({ hub, hubId: selfHubId })

  // Phase 18 B-M3 — outbound cross-org approval gate. A peer row flagged
  // `requireApprovalOutbound` has its outbound sender wrapped so a task parks as
  // an approval item in the owner's /me inbox and only crosses the org boundary
  // once approved. Wired only when both the inbox store and an owner exist;
  // otherwise the registry logs + stays ungated (loud, not a silent fail-open).
  let outboundApprovalGate:
    | ((inner: RemoteHubViaLink, row: PeerRegistration) => Participant)
    | undefined
  if (inboxStore && approverUserId) {
    const store = inboxStore
    const approver = approverUserId
    outboundApprovalGate = (inner, row) =>
      new ApprovalGatedParticipant({ inner, store, approver, peerLabel: row.label ?? row.peerId })
  } else if (inboxStore) {
    log.warn('outbound approval gate not wired: no org owner resolved')
  }

  const peerRegistry = new PeerRegistry({
    hub,
    identity,
    selfHubId,
    acceptInbound,
    ...(inboundToken ? { sharedInboundPeerToken: inboundToken } : {}),
    pollIntervalMs: pollMs,
    inboundRateLimit,
    perLinkQuotaWindowMs: linkQuotaWindowMs,
    ...(trustProxy ? { trustProxy: true } : {}),
    rpcResponder: (call) => {
      if (call.method.startsWith('mcp.')) return proxyRespond(call)
      if (call.method === PEER_SUMMARY_METHODS.get) return peerSummaryHost.respond(call)
      if (call.method === PEER_TRANSCRIPT_METHODS.get) return peerTranscriptHost.respond(call)
      return peerManifestHost.respond(call)
    },
    ...(outboundApprovalGate ? { outboundApprovalGate } : {}),
    logger: log,
  })
  registry = peerRegistry
  peerRegistry.start()

  // NET-M1 — the butler's sanitized mesh roster rides the same registry (live
  // connected state) + identity rows (outbound posture).
  const peerRoster = buildButlerPeerSurface({
    status: () => peerRegistry.status(),
    rows: () => identity.listPeers(),
  })

  // Each call asks every connected peer what it shares; an offline peer or a
  // listShared that throws (e.g. an older peer without the method) degrades to
  // `online:false` / empty rather than failing the whole list — the UI shows
  // the peer with no servers.
  const mcpFederation: WebServerOptions['mcpFederation'] = {
    listPeerShared: async () => {
      const rows = peerRegistry.status()
      return await Promise.all(
        rows.map(async (row) => {
          const link = row.connected ? peerRegistry.linkForHub(row.peerId) : null
          if (!link) return { peer: row.peerId, label: row.label, online: false, servers: [] }
          try {
            const servers = await fetchPeerSharedMcp(link)
            return { peer: row.peerId, label: row.label, online: true, servers }
          } catch (err) {
            log.warn('mcp federation: listShared failed', {
              peer: row.peerId,
              err: err instanceof Error ? err.message : String(err),
            })
            return { peer: row.peerId, label: row.label, online: true, servers: [] }
          }
        }),
      )
    },
  }

  // Phase 18 A-M2 — on-demand peer capability manifest discovery for the admin
  // UI. In-process cache over the same registry; the admin refreshes.
  const peerFederation = createPeerManifestFederation(peerRegistry, { logger: log })

  // v5 Stream F multi-channel (M3) — opt-in best-effort retry/backoff + a dedup
  // window for alert delivery. Retry defaults to a single attempt (behavior
  // unchanged); the dedup window defaults to 60s (the firing lifecycle already
  // notifies once — this is the secondary net).
  const alertRetryAttempts = clampInt(process.env.GOTONG_PEER_SUMMARY_ALERT_RETRY_ATTEMPTS, 1, 1, 6)
  const alertRetryBaseMs = clampInt(process.env.GOTONG_PEER_SUMMARY_ALERT_RETRY_BASE_MS, 500, 50, 30_000)
  const alertDedupWindowMs = clampInt(process.env.GOTONG_PEER_SUMMARY_ALERT_DEDUP_MS, 60_000, 0, 3_600_000)
  // v5 E5-M3 — the control plane: this hub's own footprint (`local`) joined with
  // each connected peer's voluntarily-shared summary. IdentityStore duck-types
  // the snapshot / rule / firing / channel sinks. Webhook delivery routes
  // through global fetch + process.env (the secret in `headerEnv` is read at
  // delivery time).
  const peerSummaryFederation = createPeerSummaryFederation(peerRegistry, {
    buildLocal: () => buildLocalSummary(summaryDeps),
    snapshots: identity,
    alertRules: identity,
    firings: identity,
    channels: identity,
    deliver: { retry: { maxAttempts: alertRetryAttempts, baseDelayMs: alertRetryBaseMs } },
    deliverDedupWindowMs: alertDedupWindowMs,
    logger: log,
  })

  // v5 Stream F day-3 — proactive alert-delivery sweep. OPT-IN: only runs when
  // GOTONG_PEER_SUMMARY_ALERT_SWEEP_MS is a positive value (clamped to [10s,1h]).
  // Each tick refreshes peer summaries then edge-triggers breaches into firings +
  // POSTs webhooks (notify ONCE per breach). A reentrancy guard prevents a slow
  // tick (many channels / slow webhooks) from overlapping the next.
  let alertSweepTimer: ReturnType<typeof setInterval> | undefined
  const rawAlertInterval = Number(process.env.GOTONG_PEER_SUMMARY_ALERT_SWEEP_MS ?? '0')
  const alertIntervalMs =
    Number.isFinite(rawAlertInterval) && rawAlertInterval >= 10_000
      ? Math.min(rawAlertInterval, 3_600_000)
      : 0
  if (alertIntervalMs > 0) {
    const fed = peerSummaryFederation
    let alertInflight = false
    const sweepAlerts = async (): Promise<void> => {
      if (alertInflight) return
      alertInflight = true
      try {
        // Refresh first so peer summaries are current before we evaluate — a
        // refresh failure on one peer leaves its last reading (the row's `stale`
        // flag stays the UI's honesty signal), it never aborts the pass.
        await fed.refresh()
        const report = await fed.evaluateAndDeliver()
        if (report.opened.length > 0 || report.resolved.length > 0) {
          log.info('peer summary alert sweep', {
            opened: report.opened.length,
            resolved: report.resolved.length,
            deliveries: report.deliveries.length,
            failedDeliveries: report.deliveries.filter((d) => !d.ok).length,
          })
        }
      } catch (err) {
        log.error('peer summary alert sweep failed', {
          err: err instanceof Error ? err.message : String(err),
        })
      } finally {
        alertInflight = false
      }
    }
    alertSweepTimer = setInterval(() => {
      void sweepAlerts()
    }, alertIntervalMs)
    alertSweepTimer.unref?.()
    log.info('peer summary alert sweep started', { intervalMs: alertIntervalMs })
  }

  // Phase 6 #4 — the per-peer resolver is auto-wired by PeerRegistry when
  // identity is present (it is here). The shared token remains a fallback for
  // peers not yet enrolled in the peers table; in practice the resolver path
  // wins for any enrolled peer because verifyPeerToken consults it first.
  log.info('peer registry started', {
    selfHubId,
    pollIntervalMs: pollMs,
    inboundAuth: inboundToken ? 'per-peer+shared-fallback' : 'per-peer',
    trustProxy,
    inboundRateLimit:
      rateLimitMax > 0 && rateLimitWindowMs > 0 ? `${rateLimitMax}/${rateLimitWindowMs}ms` : 'disabled',
  })

  return { peerRegistry, mcpProxy, mcpFederation, peerFederation, peerSummaryFederation, peerRoster, alertSweepTimer }
}
