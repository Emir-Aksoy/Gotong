// Services over WebSocket — sidecar demo (protocol v1.1).
//
// Demonstrates that an external agent can:
//   1. connect to a Hub purely over wire-protocol v1.1 (no host import,
//      no `pnpm install` on the host side beyond first-party plugins)
//   2. declare which Hub Services it needs in HELLO
//   3. drive `memory.remember` / `memory.recall` over SERVICE_CALL
//      with the same TS surface as an in-process LlmAgent
//   4. share a case-scoped memory across two agents (writer + reviewer)
//      so the reviewer sees what the writer remembered
//
// To keep the demo zero-dependency it uses MockLlmProvider — no API
// key, no network beyond localhost WS.
//
// Architecture:
//
//        ┌────────────────────── this process ─────────────────────┐
//        │                                                          │
//        │  Hub  +  HubServices  +  ws server (:0 random port)     │
//        │      ▲                  │                                │
//        │      │ SERVICE_CALL/RESULT (WebSocket)                   │
//        │      ▼                                                   │
//        │  sdk-node connect():                                     │
//        │    ┌──────────────┐    ┌──────────────┐                  │
//        │    │ WriterAgent  │    │ ReviewerAgent│                  │
//        │    │ + services   │    │ + services   │                  │
//        │    └──────────────┘    └──────────────┘                  │
//        │                                                          │
//        └──────────────────────────────────────────────────────────┘
//
// In production these two sub-trees would be separate OS processes
// (the SDK-side could even be Python via `pip install aipehub`). Wire
// behaviour is identical. We co-locate here for demo brevity.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { Hub, Space, type Task } from '@aipehub/core'
import { bootstrapServices } from '@aipehub/host/services'
import { MockLlmProvider } from '@aipehub/llm'
import { AgentParticipant, connect, type Session, type ServiceClient } from '@aipehub/sdk-node'
import { serveWebSocket, type WebSocketTransportHandle } from '@aipehub/transport-ws'

// ---------------------------------------------------------------------------
// Two sidecar agents — each declares its own service ACL in HELLO.
// ---------------------------------------------------------------------------

class WriterAgent extends AgentParticipant {
  /** Filled in by main() after connect() resolves; we keep the reference
   *  on the instance so handleTask reads it identically to an in-process
   *  LlmAgent (`this.services.memory.remember(...)`). */
  services?: ServiceClient

  constructor(private readonly provider: MockLlmProvider) {
    super({ id: 'writer-sidecar', capabilities: ['draft'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const payload = task.payload as { caseId: string; prompt: string }
    log(`[writer] task=${task.id.slice(0, 8)} case=${payload.caseId}`)

    // RPC — pulls the case-scoped memory handle (lazy attach server-side).
    const caseMemory = this.services!.memoryFor('file', {
      kind: 'workflow-run',
      id: payload.caseId,
    })

    // Recall whatever the case has heard so far (probably empty on first call).
    const prior = await caseMemory.recall({ k: 20 })
    log(`[writer]   case memory has ${prior.length} prior entries`)

    // Pretend to write a draft via the mock provider.
    const reply = await this.provider.complete({
      messages: [{ role: 'user', content: payload.prompt }],
    })
    const draft = reply.text

    // Remember the draft so the reviewer sees it.
    await caseMemory.remember({
      kind: 'episodic',
      text: draft,
      meta: { source: 'writer' },
    })
    log(`[writer]   wrote draft (${draft.length} chars) into case memory`)
    return { draft }
  }
}

class ReviewerAgent extends AgentParticipant {
  services?: ServiceClient

  constructor(private readonly provider: MockLlmProvider) {
    super({ id: 'reviewer-sidecar', capabilities: ['review'] })
  }

  protected async handleTask(task: Task): Promise<unknown> {
    const payload = task.payload as { caseId: string }
    log(`[reviewer] task=${task.id.slice(0, 8)} case=${payload.caseId}`)

    const caseMemory = this.services!.memoryFor('file', {
      kind: 'workflow-run',
      id: payload.caseId,
    })
    const seen = await caseMemory.recall({ k: 20 })
    log(`[reviewer]   case memory has ${seen.length} entries from writer`)

    const reply = await this.provider.complete({
      messages: [
        {
          role: 'user',
          content: `Review ${seen.length} prior entries: ${seen.map((e) => e.text).join(' | ')}`,
        },
      ],
    })

    // Reviewer also writes back a note so a future call would see both.
    await caseMemory.remember({
      kind: 'episodic',
      text: reply.text,
      meta: { source: 'reviewer' },
    })
    log(`[reviewer]   recorded review note into case memory`)
    return { note: reply.text, sawCount: seen.length }
  }
}

// ---------------------------------------------------------------------------
// Glue
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  const ts = new Date().toISOString().slice(11, 23)
  // eslint-disable-next-line no-console
  console.log(`[${ts}]`, ...args)
}

function banner(text: string): void {
  log('')
  log('─'.repeat(70))
  log('━━', text)
  log('─'.repeat(70))
}

async function main(): Promise<void> {
  const ROOT = join(process.cwd(), '..', '..', '.aipehub-sidecar-demo')
  if (existsSync(ROOT)) await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })

  // 1) Host side: hub + plugins + ws server -------------------------------
  banner('Phase 1 — host side (Hub + HubServices + WebSocket)')
  const { space } = await Space.init(ROOT, { name: 'sidecar-demo' })
  const hub = new Hub({ space })
  await hub.start()

  await writeFile(
    join(space.paths.services, 'plugins.json'),
    JSON.stringify({ plugins: ['@aipehub/service-memory-file'] }, null, 2) + '\n',
    'utf8',
  )
  const boot = await bootstrapServices({ space, hub })
  log(`✓ services ready: ${boot.ready.map((p) => `${p.type}:${p.impl}`).join(', ')}`)

  const ws: WebSocketTransportHandle = await serveWebSocket(hub, {
    port: 0,
    services: boot.services,
  })
  log(`✓ ws server listening at ${ws.url}`)

  // 2) Sidecar side: two agents over connect() ----------------------------
  banner('Phase 2 — sidecar agents (via @aipehub/sdk-node connect)')
  const provider = new MockLlmProvider({
    reply: (req) => `mock-reply: ${(req.messages[0]?.content ?? '').slice(0, 40)}`,
  })

  const writer = new WriterAgent(provider)
  const reviewer = new ReviewerAgent(provider)

  // Each agent connects with its own services ACL — declarative, no
  // imperative `services.attach({...})` calls.
  const writerSession: Session = await connect({
    url: ws.url,
    agents: [writer],
    services: [
      { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
    ],
    autoReconnect: false,
  })
  writer.services = writerSession.services
  log(`✓ writer-sidecar connected (sessionId=${writerSession.sessionId})`)

  const reviewerSession: Session = await connect({
    url: ws.url,
    agents: [reviewer],
    services: [
      { type: 'memory', impl: 'file', owner: { kind: 'workflow-run', id: '*' } },
    ],
    autoReconnect: false,
  })
  reviewer.services = reviewerSession.services
  log(`✓ reviewer-sidecar connected (sessionId=${reviewerSession.sessionId})`)

  // 3) Drive a case ------------------------------------------------------
  banner('Phase 3 — dispatch tasks; agents read/write case memory over WS')
  const caseId = `case-${Date.now()}`

  const draftResult = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['draft'] },
    payload: { caseId, prompt: 'write something brief' },
    title: 'draft',
  })
  log(`✓ draft step result: ${JSON.stringify(draftResult).slice(0, 80)}…`)

  const reviewResult = await hub.dispatch({
    from: 'system',
    strategy: { kind: 'capability', capabilities: ['review'] },
    payload: { caseId },
    title: 'review',
  })
  log(`✓ review step result: ${JSON.stringify(reviewResult).slice(0, 100)}…`)

  // 4) Verify the proof — peek at the underlying memory file.
  banner('Phase 4 — verify: read the case-memory file directly')
  const caseMemPath = join(
    space.paths.services,
    'memory',
    'file',
    'workflow-run',
    caseId,
    'episodic.jsonl',
  )
  log(`reading: ${caseMemPath}`)
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(caseMemPath, 'utf8')
  const lines = raw.trim().split('\n')
  log(`✓ case memory file has ${lines.length} entries:`)
  for (const line of lines) {
    const entry = JSON.parse(line) as { meta?: { source?: string }; text: string }
    log(`  • [${entry.meta?.source ?? '?'}] ${entry.text.slice(0, 60)}…`)
  }

  // 5) Tear down ---------------------------------------------------------
  banner('Tear-down')
  await writerSession.close('demo done')
  await reviewerSession.close('demo done')
  await ws.close()
  await boot.services.shutdownAll()
  await hub.stop()
  log('✓ all closed cleanly')
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', err)
  process.exit(1)
})
