/**
 * web-demo — opens the Gotong reference web UI on `.gotong-web-demo/`
 * (auto-init) and runs a tiny perpetual loop:
 *
 *   1. WriterAgent drafts a one-liner (auto, in-process)
 *   2. Hub dispatches it via `capability: ['approve']`
 *   3. Once a worker joins at http://localhost:3000 with capability
 *      `approve`, the task lands in their inbox
 *   4. They click Approve / Reject in the browser
 *   5. repeat forever; Ctrl-C to exit
 *
 * The admin token is minted on first launch and printed once.
 *
 * No env vars required. Set GOTONG_SPACE=/tmp/foo to use a different space dir.
 */

import { AgentParticipant, Hub, Space, type Task } from '@gotong/core'
import { serveWeb } from '@gotong/web'

const SPACE_DIR = process.env.GOTONG_SPACE ?? '.gotong-web-demo'

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
  const { space, adminToken } = await Space.openOrInit(SPACE_DIR, {
    name: 'web-demo',
    description: 'simple worker-driven loop (v2.0 file-first)',
    adminDisplayName: 'Operator',
    // gating: 'open' so the writer agent in-process registers without approval
    config: { webPort: 3000, gating: 'open' },
  })

  const hub = new Hub({ space })
  await hub.start()
  hub.register(new WriterAgent())

  const web = await serveWeb(hub, { port: (await space.config()).webPort })

  console.log(`\n[web-demo] space: ${SPACE_DIR}/`)
  if (adminToken) {
    console.log(`[web-demo] admin: ${web.url}/admin?token=${adminToken} (one-time URL — store this token)`)
  } else {
    console.log(`[web-demo] admin already configured — re-use your saved token`)
  }
  console.log(`[web-demo] workers: ${web.url}/  — pick capability "approve" to receive drafts`)
  console.log(`[web-demo] Ctrl-C to exit.\n`)

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
    await waitForCapability(hub, 'approve', () => running)
    if (!running) break

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
