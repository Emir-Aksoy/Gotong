/**
 * Phase 19 P5-M4 — Gotong -> Windmill (durable workflow) bridge demo.
 *
 * The Hub dispatches a task to a `WindmillParticipant`; the participant hands
 * the work to a durable external engine, which persists the job and runs it
 * to completion while the participant polls. This is the outbound twin of the
 * Activepieces (inbound) bridge.
 *
 * Self-contained + self-asserting: a tiny fake Windmill server runs over
 * loopback and models the real async API (`run/f/...` returns a job id;
 * `get_result_maybe/<id>` returns `{completed:false}` until the durable job
 * finishes). `start` exits 0 on success — no Windmill account, no network.
 */

import { AgentParticipant, Hub } from '@gotong/core'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { strict as assert } from 'node:assert'

import { WindmillParticipant } from './windmill-participant.js'

const TOKEN = 'wm-demo-token'

/**
 * A fake Windmill instance: enough of the async job API to prove the bridge.
 * Each job needs 2 polls before it reports completed, so the demo exercises
 * the participant's poll loop (the whole point of "durable").
 */
function fakeWindmill(): Server {
  const polls = new Map<string, number>()
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const auth = req.headers['authorization']
    if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'unauthorized' })
    const url = (req.url ?? '').split('?')[0] ?? ''

    // Submit: POST /api/w/demo/jobs/run/f/<path>  ->  bare job-id string.
    const submit = url.match(/^\/api\/w\/demo\/jobs\/run\/f\/(.+)$/)
    if (req.method === 'POST' && submit) {
      const flow = submit[1]
      const jobId = `job-${flow!.replace(/\//g, '_')}`
      polls.set(jobId, 0)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(jobId)) // Windmill returns the uuid as a string body
      return
    }

    // Poll: GET /api/w/demo/jobs_u/completed/get_result_maybe/<id>
    const poll = url.match(/^\/api\/w\/demo\/jobs_u\/completed\/get_result_maybe\/(.+)$/)
    if (req.method === 'GET' && poll) {
      const jobId = poll[1]!
      const n = (polls.get(jobId) ?? 0) + 1
      polls.set(jobId, n)
      if (n < 2) return json(res, 200, { completed: false }) // still running
      if (jobId.includes('always_fails')) {
        return json(res, 200, { completed: true, success: false, result: { error: 'manual review required' } })
      }
      return json(res, 200, { completed: true, success: true, result: { score: 87, segment: 'enterprise' } })
    }

    json(res, 404, { error: 'not_found' })
  })
}

/** A purely local agent, to show the Windmill agent sits beside normal ones. */
class NoteAgent extends AgentParticipant {
  constructor() {
    super({ id: 'note', capabilities: ['note'] })
  }
  protected async handleTask(): Promise<unknown> {
    return { ok: true }
  }
}

async function main(): Promise<void> {
  console.log('\n=== Gotong demo: windmill-bridge (Phase 19 P5-M4) ===\n')

  const wm = fakeWindmill()
  await new Promise<void>((resolve) => wm.listen(0, '127.0.0.1', () => resolve()))
  const port = (wm.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}`
  console.log(`  windmill   fake durable engine on ${baseUrl}`)

  const hub = Hub.inMemory()
  await hub.start()
  hub.register(new NoteAgent())
  hub.register(
    new WindmillParticipant({
      id: 'lead-enricher-wm',
      capabilities: ['enrich:lead'],
      baseUrl,
      workspace: 'demo',
      token: TOKEN,
      flowPath: 'u/demo/process_lead',
      toInputs: (task) => ({ lead: task.payload }),
      fromResult: (r) => ({ enrichment: r }),
      pollIntervalMs: 20,
    }),
  )
  hub.register(
    new WindmillParticipant({
      id: 'flaky-wm',
      capabilities: ['enrich:flaky'],
      baseUrl,
      workspace: 'demo',
      token: TOKEN,
      flowPath: 'u/demo/always_fails',
      pollIntervalMs: 20,
    }),
  )
  console.log('  hub        started, agents: note, lead-enricher-wm, flaky-wm\n')

  // -- 1. durable job runs to completion, result flows back ------------------
  console.log('  [1] dispatch enrich:lead -> Windmill submit + poll until done')
  const ok = await hub.dispatch({
    from: 'demo',
    strategy: { kind: 'capability', capabilities: ['enrich:lead'] },
    payload: { name: 'Mei', company: 'Kopitiam Co' },
  })
  console.log('      ->', ok.kind, JSON.stringify((ok as { output?: unknown }).output))
  assert.equal(ok.kind, 'ok')
  assert.deepEqual((ok as { output: { enrichment: { score: number } } }).output.enrichment, {
    score: 87,
    segment: 'enterprise',
  })

  // -- 2. a durable job that fails its own logic becomes a failed task -------
  console.log('  [2] dispatch enrich:flaky -> Windmill job completes with success:false')
  const bad = await hub.dispatch({
    from: 'demo',
    strategy: { kind: 'capability', capabilities: ['enrich:flaky'] },
    payload: {},
  })
  console.log('      ->', bad.kind, (bad as { error?: string }).error)
  assert.equal(bad.kind, 'failed')
  assert.match((bad as { error: string }).error, /windmill_job_failed/)

  console.log('\n  transcript:', hub.transcript.size(), 'entries')
  console.log('  ✓ all assertions passed\n')

  await new Promise<void>((resolve) => wm.close(() => resolve()))
  await hub.stop()
  process.exit(0)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

main().catch((err) => {
  console.error('[windmill-bridge] FAILED:', err)
  process.exit(1)
})
