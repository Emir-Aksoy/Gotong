/**
 * Team Hub — Alice's local team. Single human leader, two sub-agents
 * (writer + reviewer), plus a TeamBridgeAgent that joins the upstream
 * hub as one outward-facing agent "alice-team".
 *
 * The leader gets their own admin/worker UI on http://localhost:3300
 * to supervise what their team is doing, independent of the upstream
 * room. Forwarded tasks show up titled "[upstream] ..." in the local
 * transcript.
 *
 *   local web : 3300       (Alice's private cockpit)
 *   upstream  : ws://127.0.0.1:4200   (configurable)
 *   space dir : .aipehub-team
 */

import { AgentParticipant, Hub, Space, type Task, type TranscriptEntry } from '@aipehub/core'
import { serveWeb } from '@aipehub/web'
import { connect, TeamBridgeAgent } from '@aipehub/sdk-node'

const SPACE_DIR = process.env.AIPE_TEAM_SPACE ?? '.aipehub-team'
const UPSTREAM_URL = process.env.AIPE_UPSTREAM_URL ?? 'ws://127.0.0.1:4200'
const BRIDGE_ID = process.env.AIPE_BRIDGE_ID ?? 'alice-team'

// --- two trivial sub-agents (stand in for any local team members) ---------
class WriterBot extends AgentParticipant {
  constructor() { super({ id: 'writer-bot', capabilities: ['draft'] }) }
  protected handleTask(task: Task): unknown {
    const topic = readTopic(task.payload) ?? '(no topic)'
    return { text: `[WriterBot] One terse sentence about ${topic}.` }
  }
}
class ReviewerBot extends AgentParticipant {
  constructor() { super({ id: 'reviewer-bot', capabilities: ['review'] }) }
  protected handleTask(task: Task): unknown {
    return { suggestion: '[ReviewerBot] Tighten verbs; cut adjectives.', input: task.payload }
  }
}

async function main(): Promise<void> {
  const { space, adminToken } = await Space.openOrInit(SPACE_DIR, {
    name: 'Alice team',
    description: 'Local team Hub, federates into upstream as one agent',
    adminDisplayName: 'Alice',
    config: {
      host: '127.0.0.1',
      webPort: 3300,
      // not used in this demo — the team Hub never accepts remote agents
      // (its members are all in-process). Leaving wsPort default is fine.
      gating: 'open',
    },
  })

  const localHub = new Hub({ space })
  await localHub.start()

  localHub.register(new WriterBot())
  localHub.register(new ReviewerBot())

  localHub.onEvent((e) => {
    console.log(`[team][seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  const config = await space.config()
  const web = await serveWeb(localHub, {
    host: config.host,
    port: config.webPort,
    cookieSecure: config.cookieSecure,
  })

  console.log(`\n=== Team Hub ready ===`)
  console.log(`Space dir : ${SPACE_DIR}/`)
  if (adminToken) {
    console.log(`Cockpit   : ${web.url}/admin?token=${adminToken}`)
    console.log(`            ↑ Alice's private supervision panel, token shown ONCE`)
  } else {
    console.log(`Cockpit   : ${web.url}/admin   (cookie)`)
  }

  // --- federate: bridge ourselves onto the upstream Hub -------------------
  const bridge = new TeamBridgeAgent({
    id: BRIDGE_ID,
    capabilities: ['draft', 'review'],   // what we expose upward
    localHub,
    tagLocalTasks: true,
  })

  console.log(`Federate  : connecting to upstream at ${UPSTREAM_URL} as agent '${BRIDGE_ID}'…`)
  console.log(`            (will hang in pending until an upstream admin approves)`)
  const session = await connect({
    url: UPSTREAM_URL,
    agents: [bridge],
    autoReconnect: true,
    onStateChange: (state, info) => {
      const tail = info?.reason ? ` (${info.reason})` : ''
      console.log(`[bridge] state -> ${state}${tail}`)
    },
  })
  console.log(`Federate  : connected, sessionId=${session.sessionId}\n`)

  const shutdown = async () => {
    console.log('\n[team] shutting down…')
    try { await session.close('shutdown') } catch { /* ignore */ }
    try { await web.close() } catch { /* ignore */ }
    try { await localHub.stop() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  await new Promise<never>(() => { /* never */ })
}

function readTopic(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'topic' in payload) {
    const t = (payload as { topic?: unknown }).topic
    return typeof t === 'string' ? t : undefined
  }
  return undefined
}

function describe(e: TranscriptEntry): string {
  switch (e.kind) {
    case 'participant_joined':
      return `JOIN     ${e.data.id} (${e.data.participantKind})`
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
      return `PENDING  app=${e.data.id}`
    case 'agent_approved':
      return `APPROVE  app=${e.data.applicationId}`
    case 'agent_rejected':
      return `REJECT   app=${e.data.applicationId}`
    case 'evaluation':
      return `EVAL     ${e.data.taskId} rating=${e.data.rating ?? '?'}`
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
  }
}

main().catch((err) => {
  console.error('[team] fatal:', err)
  process.exit(1)
})
