/**
 * Open Space host (v1.1):
 *
 *   - Hub
 *   - WebSocket transport on :4100 with `gating: 'admin-approval'`
 *     (every connecting agent waits in pending state until an admin
 *     approves it through the web UI)
 *   - Web UI on :3100 with admin enabled via AIPE_ADMIN_TOKEN
 *
 * Sits and waits — does NOT dispatch tasks itself. Tasks are dispatched
 * from the admin console at /admin (or from CLI calls to the admin API
 * with Bearer auth).
 */

import { Hub, type TranscriptEntry } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'
import { serveWeb } from '@aipehub/web'

const WS_PORT = Number(process.env.AIPE_WS_PORT ?? 4100)
const WEB_PORT = Number(process.env.AIPE_WEB_PORT ?? 3100)
const ADMIN_TOKEN = process.env.AIPE_ADMIN_TOKEN ?? 'letmein'

async function main(): Promise<void> {
  const hub = new Hub()
  await hub.start()

  hub.onEvent((e) => {
    console.log(`[host][seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  const ws = await serveWebSocket(hub, { port: WS_PORT, gating: 'admin-approval' })
  const web = await serveWeb(hub, { port: WEB_PORT, adminToken: ADMIN_TOKEN })

  console.log(`\n=== AipeHub Open Space ready ===`)
  console.log(`Admin   : ${web.url}/admin?token=${ADMIN_TOKEN}`)
  console.log(`Workers : ${web.url}/`)
  console.log(`Agents  : connect a remote agent to ${ws.url} — it will land in pending until an admin approves it.`)
  console.log(`\nPress Ctrl-C to stop.\n`)

  const shutdown = async () => {
    console.log('\n[host] shutting down…')
    try { await ws.close() } catch { /* ignore */ }
    try { await web.close() } catch { /* ignore */ }
    try { await hub.stop() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Sleep forever; signals do the cleanup.
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
      return `PENDING  application ${e.data.id} agents=[${e.data.agents.map((a) => a.id).join(',')}]`
    case 'agent_approved':
      return `APPROVE  ${e.data.agentIds.join(',')}${e.data.by ? ` by ${e.data.by}` : ''}`
    case 'agent_rejected':
      return `REJECT   ${e.data.agentIds.join(',')} — ${e.data.reason}`
    case 'evaluation':
      return `EVAL     ${e.data.taskId.slice(0, 8)}… by ${e.data.by}${e.data.rating != null ? ` ${e.data.rating}/5` : ''}${e.data.comment ? ` "${e.data.comment}"` : ''}`
  }
}

main().catch((err) => {
  console.error('[host] fatal:', err)
  process.exit(1)
})
