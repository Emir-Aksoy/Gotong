/**
 * Worker process: connects to the host's WebSocket transport, registers two
 * remote agents, and runs until the host closes the session.
 */

import { AgentParticipant, connect, type Task } from '@gotong/sdk-node'

class WriterAgent extends AgentParticipant {
  constructor() {
    super({ id: 'writer-remote', capabilities: ['draft'] })
  }
  protected async handleTask(task: Task): Promise<{ text: string }> {
    const payload = task.payload as { topic: string }
    console.log(`[worker] writer-remote received '${task.title}' topic=${payload.topic}`)
    await sleep(300)
    return {
      text: `On ${payload.topic}: it took a WebSocket roundtrip, but here is your sentence.`,
    }
  }
}

class ReviewerAgent extends AgentParticipant {
  constructor() {
    super({ id: 'reviewer-remote', capabilities: ['review'] })
  }
  protected async handleTask(task: Task): Promise<{ note: string }> {
    console.log(`[worker] reviewer-remote received '${task.title}'`)
    await sleep(300)
    return { note: 'Add a concrete code snippet showing the SDK usage.' }
  }
}

async function main(): Promise<void> {
  console.log('[worker] connecting to ws://127.0.0.1:4000 ...')
  const session = await connect({
    url: 'ws://127.0.0.1:4000',
    agents: [new WriterAgent(), new ReviewerAgent()],
    autoReconnect: false,
    onStateChange: (s, info) => {
      console.log(`[worker] state -> ${s}${info?.reason ? ` (${info.reason})` : ''}`)
      if (s === 'closed') process.exit(0)
    },
  })
  console.log(`[worker] connected, sessionId=${session.sessionId}`)

  // Stay alive until the session reaches 'closed' (handled in onStateChange).
  await new Promise<void>(() => {
    /* park forever */
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('[worker] fatal:', err)
  process.exit(1)
})
