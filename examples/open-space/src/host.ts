/**
 * Open Space host (v2.0 — file-first):
 *
 *   - Space at `.gotong/` (auto-init if missing). One admin minted on
 *     first run; their plaintext token is printed once and never again.
 *   - Hub bound to the space (transcript + pending apps + sessions all
 *     persisted)
 *   - WebSocket transport on space.config.wsPort with admin-approval gating
 *   - Web UI on space.config.webPort
 *
 * Sits and waits — does NOT dispatch tasks itself. Tasks come from the
 * admin console at /admin (or from CLI calls to the admin API with the
 * bearer token).
 */

import { Hub, Space, type TranscriptEntry } from '@gotong/core'
import { serveWebSocket } from '@gotong/transport-ws'
import { serveWeb } from '@gotong/web'

const SPACE_DIR = process.env.GOTONG_SPACE ?? '.gotong-open-space'

async function main(): Promise<void> {
  const initResult = await Space.openOrInit(SPACE_DIR, {
    name: 'Open Space demo',
    description: 'Three-role file-first collaborative space',
    adminDisplayName: 'Operator',
    config: { webPort: 3100, wsPort: 4100, gating: 'admin-approval' },
  })
  const { space, adminToken } = initResult

  const hub = new Hub({ space })
  await hub.start()

  hub.onEvent((e) => {
    console.log(`[host][seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  const config = await space.config()
  const ws = await serveWebSocket(hub, { host: config.host, port: config.wsPort, gating: config.gating })
  const web = await serveWeb(hub, {
    host: config.host,
    port: config.webPort,
    cookieSecure: config.cookieSecure,
  })

  console.log(`\n=== Gotong Open Space ready (v2.0) ===`)
  console.log(`Space dir : ${SPACE_DIR}/   (delete to start fresh)`)
  if (adminToken) {
    console.log(`Admin     : ${web.url}/admin?token=${adminToken}`)
    console.log(`            ↑ this token is shown ONCE. Save it now.`)
  } else {
    console.log(`Admin     : ${web.url}/admin (use the token you already have)`)
  }
  console.log(`Workers   : ${web.url}/`)
  console.log(`Agents    : connect to ${ws.url} — they will queue for approval`)
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
      if (e.data.kind === 'suspended')
        return `RESULT   suspended by ${e.data.by} until ${new Date(e.data.resumeAt).toISOString()}`
      return `RESULT   no_participant: ${e.data.reason}`
    case 'agent_pending':
      return `PENDING  application ${e.data.id} agents=[${e.data.agents.map((a) => a.id).join(',')}]`
    case 'agent_approved':
      return `APPROVE  ${e.data.agentIds.join(',')}${e.data.by ? ` by ${e.data.by}` : ''}`
    case 'agent_rejected':
      return `REJECT   ${e.data.agentIds.join(',')} — ${e.data.reason}`
    case 'evaluation':
      return `EVAL     ${e.data.taskId.slice(0, 8)}… by ${e.data.by}${e.data.rating != null ? ` ${e.data.rating}/5` : ''}${e.data.comment ? ` "${e.data.comment}"` : ''}`
    case 'service_trashed':
      return `TRASH    ${e.data.type}:${e.data.impl} owner=${e.data.ownerKind}/${e.data.ownerId}`
    case 'service_purged':
      return `PURGE    ${e.data.type}:${e.data.impl} trashId=${e.data.trashId}`
    case 'service_call':
      // v1.2 audit entry — one line per resolved SERVICE_CALL.
      return `SVCCALL  ${e.data.from} ${e.data.type}:${e.data.impl}#${e.data.method} → ${e.data.outcome} (${e.data.durationMs}ms)`
    case 'llm_stream_chunk':
      // Phase 8 — too noisy to print per chunk, just acknowledge.
      return `STREAM   ${e.data.agentId} task=${e.data.taskId.slice(0, 8)}…`
    case 'task_resumed':
      return `RESUME   task=${e.data.taskId.slice(0, 8)}… by ${e.data.by}`
  }
}

main().catch((err) => {
  console.error('[host] fatal:', err)
  process.exit(1)
})
