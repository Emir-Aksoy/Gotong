/**
 * Host process: runs the Hub + WebSocket transport on :4000, waits for the
 * remote worker to connect, dispatches a few tasks, prints the transcript,
 * and exits cleanly.
 */

import { Hub, type TranscriptEntry } from '@aipehub/core'
import { serveWebSocket } from '@aipehub/transport-ws'

async function main(): Promise<void> {
  const hub = new Hub()
  await hub.start()

  hub.onEvent((e) => {
    console.log(`  [host][seq=${String(e.seq).padStart(2, '0')}] ${describe(e)}`)
  })

  const ws = await serveWebSocket(hub, { port: 4000 })
  console.log(`[host] WebSocket transport listening at ${ws.url}\n`)

  console.log('[host] waiting up to 5s for a remote agent to register...')
  await waitForAgent(hub, 5_000)
  console.log('[host] remote agents present, dispatching tasks\n')

  const draft = await hub.dispatch({
    from: 'host',
    strategy: { kind: 'capability', capabilities: ['draft'] },
    payload: { topic: 'distributed agents' },
    title: 'write a draft',
  })
  if (draft.kind !== 'ok') throw new Error(`draft: ${JSON.stringify(draft)}`)
  const draftText = (draft.output as { text: string }).text
  console.log(`\n[host] draft text: "${draftText}"\n`)

  const review = await hub.dispatch({
    from: 'host',
    strategy: { kind: 'capability', capabilities: ['review'] },
    payload: { draft: draftText },
    title: 'review the draft',
  })
  if (review.kind !== 'ok') throw new Error(`review: ${JSON.stringify(review)}`)
  console.log(`\n[host] reviewer note: "${(review.output as { note: string }).note}"\n`)

  console.log(`[host] done. transcript: ${hub.transcript.size()} entries.\n`)
  console.log('[host] shutting down WebSocket transport...')
  await ws.close()
  await hub.stop()
  console.log('[host] bye.')
  process.exit(0)
}

async function waitForAgent(hub: Hub, timeoutMs: number): Promise<void> {
  if (hub.registry.byKind('agent').length > 0) return
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`no remote agent registered within ${timeoutMs}ms`))
    }, timeoutMs)
    const stop = hub.registry.onJoin((p) => {
      if (p.kind === 'agent') {
        clearTimeout(timer)
        stop()
        // give the worker a beat to register all of its agents
        setTimeout(resolve, 200)
      }
    })
  })
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
  }
}

main().catch((err) => {
  console.error('[host] fatal:', err)
  process.exit(1)
})
