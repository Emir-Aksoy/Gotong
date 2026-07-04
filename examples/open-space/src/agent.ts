/**
 * Open Space writer agent — connects to the host on ws://127.0.0.1:4100
 * and waits in pending state until an admin approves it in the web UI.
 *
 * Once approved, it answers `draft` tasks with a one-line sentence.
 */

import { AgentParticipant, connect, type Task } from '@gotong/sdk-node'

const WS_URL = process.env.GOTONG_WS_URL ?? 'ws://127.0.0.1:4100'

class WriterAgent extends AgentParticipant {
  private n = 0
  constructor() {
    super({ id: 'writer-remote', capabilities: ['draft'] })
  }
  protected async handleTask(task: Task): Promise<{ text: string }> {
    const payload = task.payload as { topic?: string }
    this.n += 1
    console.log(`[agent] draft #${this.n} topic=${payload.topic ?? '(none)'}`)
    await sleep(250)
    return {
      text: `Draft #${this.n} on ${payload.topic ?? 'something'}: small steps compose into big systems.`,
    }
  }
}

async function main(): Promise<void> {
  console.log(`[agent] connecting to ${WS_URL} ...`)
  console.log(`[agent] (will hang in pending state until an admin approves)`)

  const session = await connect({
    url: WS_URL,
    agents: [new WriterAgent()],
    autoReconnect: false,
    onStateChange: (s, info) => {
      console.log(`[agent] state -> ${s}${info?.reason ? ` (${info.reason})` : ''}`)
      if (s === 'closed') process.exit(0)
    },
  })
  console.log(`[agent] approved! sessionId=${session.sessionId}`)

  // Park forever; onStateChange handles exit when the session closes.
  await new Promise<void>(() => { /* never */ })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error('[agent] fatal:', err)
  process.exit(1)
})
