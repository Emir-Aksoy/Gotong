/**
 * web-demo — opens the AipeHub reference web UI and runs a tiny perpetual
 * loop. Now that the UI is split into admin + worker views, this demo
 * focuses on the worker side:
 *
 *   1. WriterAgent drafts a one-liner (auto)
 *   2. Hub dispatches it via `capability: ['approve']`
 *   3. Once a person joins the space at http://localhost:3000 with
 *      capability `approve`, the task lands in their inbox
 *   4. The person clicks Approve / Reject in the browser
 *   5. repeat forever; Ctrl-C to exit
 *
 * To also enable the admin console, set AIPE_ADMIN_TOKEN before running.
 */

import { AgentParticipant, Hub, type Task } from '@aipehub/core'
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

  hub.register(new WriterAgent())

  const web = await serveWeb(hub, { port: 3000 })
  console.log(`\nOpen ${web.url} to join as a worker.`)
  console.log(`  pick any nickname (e.g. "alice") and capability "approve" to receive drafts.`)
  if (web.adminEnabled) {
    console.log(`Admin login URL was printed above.`)
  } else {
    console.log(`Admin disabled; set AIPE_ADMIN_TOKEN to enable the /admin console.`)
  }
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
    // wait until at least one human with "approve" capability has joined
    await waitForCapability(hub, 'approve', () => running)
    if (!running) break

    const topic = TOPICS[i % TOPICS.length]!
    i += 1

    // 1. draft
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

    // 2. ask for human approval — by now we know someone has cap "approve"
    const approveRes = await hub.dispatch({
      from: 'system',
      strategy: { kind: 'capability', capabilities: ['approve'] },
      payload: { draft: text, topic },
      title: `approve draft about "${topic}"`,
    })
    console.log(
      `[${i}] human verdict: ${approveRes.kind === 'ok' ? 'approved' : approveRes.kind}`,
    )

    await sleep(500)
  }
}

/** Resolve once at least one human in the hub advertises the given capability. */
async function waitForCapability(
  hub: Hub,
  cap: string,
  stillRunning: () => boolean,
): Promise<void> {
  while (stillRunning()) {
    const hit = hub.participants().some(
      (p) => p.kind === 'human' && p.capabilities.includes(cap),
    )
    if (hit) return
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
