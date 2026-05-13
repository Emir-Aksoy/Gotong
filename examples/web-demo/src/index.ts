/**
 * web-demo — opens the AipeHub reference web UI in your browser and runs a
 * tiny perpetual loop:
 *
 *   1. WriterAgent drafts a one-liner (auto)
 *   2. Alice (HumanParticipant) is asked to approve it
 *   3. dispatch hangs until you click Approve or Reject in the browser
 *   4. repeat forever; Ctrl-C to exit
 *
 * Open http://127.0.0.1:3000 after launch.
 */

import { AgentParticipant, Hub, HumanParticipant, type Task } from '@aipehub/core'
import { serveWeb } from '@aipehub/web'

class WriterAgent extends AgentParticipant {
  private n = 0
  constructor() {
    super({ id: 'writer', capabilities: ['draft'] })
  }
  protected async handleTask(_task: Task): Promise<{ text: string }> {
    await sleep(300)
    this.n += 1
    return { text: `Draft #${this.n}: TypeScript scales because the compiler is your second pair of eyes.` }
  }
}

const TOPICS = [
  'large codebases',
  'open source collaboration',
  'AI agents writing code',
  'platform engineering',
  'developer ergonomics',
]

async function main(): Promise<void> {
  const hub = new Hub()
  await hub.start()

  const writer = new WriterAgent()
  const alice = new HumanParticipant({ id: 'alice', capabilities: ['approve'] })
  hub.register(writer)
  hub.register(alice)

  const web = await serveWeb(hub, { port: 3000 })
  console.log(`\nOpen ${web.url} in your browser to interact with Alice.`)
  console.log(`Ctrl-C to exit.\n`)

  let running = true
  const shutdown = async () => {
    if (!running) return
    running = false
    console.log('\nshutting down…')
    await web.close()
    await hub.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  let i = 0
  while (running) {
    const topic = TOPICS[i % TOPICS.length]!
    i += 1

    const draftRes = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['draft'] },
      payload: { topic },
      title: `write draft about "${topic}"`,
    })
    if (draftRes.kind !== 'ok') {
      console.error('draft failed', draftRes)
      break
    }
    const text = (draftRes.output as { text: string }).text

    const approveRes = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'explicit', to: alice.id },
      payload: { draft: text, topic },
      title: `approve draft about "${topic}"`,
    })
    console.log(
      `[${i}] alice -> ${approveRes.kind === 'ok' ? 'approved' : approveRes.kind}`,
    )

    await sleep(500)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
