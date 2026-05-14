/**
 * Upstream Hub — the "cloud / big room" side of the federation demo.
 *
 * Real production deployment of this host would sit behind Caddy + TLS on
 * a VPS (see docs/DEPLOY.md). For the demo we just run it on localhost
 * with different ports than the open-space example so both can coexist.
 *
 *   web : 3200
 *   ws  : 4200
 *   space dir: .aipehub-upstream
 */

import { Hub, Space, type TranscriptEntry } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

const SPACE_DIR = process.env.AIPE_UPSTREAM_SPACE ?? '.aipehub-upstream'

async function main(): Promise<void> {
  const { space, adminToken } = await Space.openOrInit(SPACE_DIR, {
    name: 'Upstream room',
    description: 'Federation demo upstream — big collaborative room',
    adminDisplayName: 'Operator',
    config: {
      host: '127.0.0.1',
      webPort: 3200,
      wsPort: 4200,
      gating: 'admin-approval',
    },
  })

  const hub = new Hub({ space })
  await hub.start()

  hub.onEvent((e) => {
    console.log(`[upstream][seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  const config = await space.config()
  const ws = await serveWebSocket(hub, {
    host: config.host,
    port: config.wsPort,
    gating: config.gating,
  })
  const web = await serveWeb(hub, {
    host: config.host,
    port: config.webPort,
    cookieSecure: config.cookieSecure,
  })

  console.log(`\n=== Upstream Hub ready ===`)
  console.log(`Space dir : ${SPACE_DIR}/`)
  if (adminToken) {
    console.log(`Admin     : ${web.url}/admin?token=${adminToken}`)
    console.log(`            ↑ token shown ONCE — save it now`)
  } else {
    console.log(`Admin     : ${web.url}/admin   (cookie or token)`)
  }
  console.log(`Workers   : ${web.url}/`)
  console.log(`Bridges   : ws  ${ws.url}    (team bridges connect here)`)
  console.log(`\nThe team bridge (separate process) will queue for approval.`)
  console.log(`Approve it from the admin panel, then dispatch tasks.`)
  console.log(`Press Ctrl-C to stop.\n`)

  const shutdown = async () => {
    console.log('\n[upstream] shutting down…')
    try { await ws.close() } catch { /* ignore */ }
    try { await web.close() } catch { /* ignore */ }
    try { await hub.stop() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise<never>(() => { /* never */ })
}

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} (${e.data.participantKind}) caps=[${e.data.capabilities.join(',')}]`
    case 'participant_left':
      return `LEAVE    ${e.data.id}`
    case 'message':
      return `MSG      ${e.data.from} -> #${e.data.channel}`
    case 'task':
      return `TASK     ${e.data.from} "${e.data.title ?? '(untitled)'}" via ${e.data.strategy.kind}`
    case 'task_result':
      if (e.data.kind === 'ok') return `RESULT   ok by ${e.data.by}`
      if (e.data.kind === 'failed') return `RESULT   failed by ${e.data.by}: ${e.data.error}`
      if (e.data.kind === 'cancelled') return `RESULT   cancelled: ${e.data.reason}`
      return `RESULT   no_participant: ${e.data.reason}`
    case 'agent_pending':
      return `PENDING  app=${e.data.id} agents=[${e.data.agents.map((a) => a.id).join(',')}]`
    case 'agent_approved':
      return `APPROVE  app=${e.data.applicationId} agents=[${e.data.agentIds.join(',')}] by ${e.data.by ?? '?'}`
    case 'agent_rejected':
      return `REJECT   app=${e.data.applicationId} by ${e.data.by ?? '?'}: ${e.data.reason}`
    case 'evaluation':
      return `EVAL     ${e.data.taskId} rating=${e.data.rating ?? '?'} by ${e.data.by}`
    case 'service_trashed':
      return `TRASH    ${e.data.type}:${e.data.impl} owner=${e.data.ownerKind}/${e.data.ownerId}`
    case 'service_purged':
      return `PURGE    ${e.data.type}:${e.data.impl} trashId=${e.data.trashId}`
  }
}

main().catch((err) => {
  console.error('[upstream] fatal:', err)
  process.exit(1)
})
