/**
 * In-memory mock ACP agent — plays the agent side of the wire over a crosswise
 * PassThrough pair, with NO child process. Behaviour is driven by markers in the
 * prompt text so tests stay deterministic (mirrors the Node-script mock the M6
 * host e2e spawns for real, but here it's just a function).
 *
 *   - default          → stream one `agent_message_chunk` "echo:<text>|turn=N",
 *                         then respond `stopReason: 'end_turn'`.
 *   - contains NEED_PERM→ also send a `session/request_permission` reverse request
 *                         (a destructive "rm -rf build") and DEFER the prompt
 *                         response until the hub answers: allow → 'end_turn',
 *                         reject/cancel → 'refusal'.
 *   - contains HANG    → stream a chunk but never finish; only `session/cancel`
 *                         ends it (with 'cancelled'). Used to exercise cancel.
 *
 * `turn=N` (N = per-session prompt count) is how a test proves two prompts hit
 * the SAME session — the counter only advances because the session is held open.
 */

import { PassThrough } from 'node:stream'

import type { AcpTransport } from '../src/acp-connection.js'
import { promptText } from '../src/acp-protocol.js'

export interface MockAcpStats {
  initCount: number
  promptCount: number
  lastPrompt: string | undefined
}

export function createMockAcpAgent(): { transport: AcpTransport; stats: MockAcpStats } {
  const hubToAgent = new PassThrough() // session writes here (its output); agent reads
  const agentToHub = new PassThrough() // agent writes here; session reads (its input)
  const transport: AcpTransport = { input: agentToHub, output: hubToAgent }
  const stats: MockAcpStats = { initCount: 0, promptCount: 0, lastPrompt: undefined }

  const send = (msg: unknown): void => {
    agentToHub.write(JSON.stringify(msg) + '\n')
  }
  const update = (text: string): void =>
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'mock-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    })

  let pendingPromptId: string | number | null = null
  let permCounter = 0

  let buf = ''
  hubToAgent.on('data', (c: Buffer) => {
    buf += c.toString('utf8')
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) handle(JSON.parse(line) as Record<string, unknown>)
    }
  })

  function handle(msg: Record<string, unknown>): void {
    const id = msg.id as string | number | undefined
    const method = msg.method as string | undefined

    if (method === 'initialize') {
      stats.initCount++
      send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } })
      return
    }
    if (method === 'authenticate') {
      send({ jsonrpc: '2.0', id, result: {} })
      return
    }
    if (method === 'session/new') {
      send({ jsonrpc: '2.0', id, result: { sessionId: 'mock-1' } })
      return
    }
    if (method === 'session/prompt') {
      stats.promptCount++
      const params = msg.params as { prompt?: Parameters<typeof promptText>[0] }
      const text = promptText(params.prompt ?? [])
      stats.lastPrompt = text
      update(`echo:${text}|turn=${stats.promptCount}`)
      if (text.includes('NEED_PERM')) {
        pendingPromptId = id ?? null
        send({
          jsonrpc: '2.0',
          id: `rp-${++permCounter}`,
          method: 'session/request_permission',
          params: {
            sessionId: 'mock-1',
            toolCall: { title: 'rm -rf build', kind: 'execute' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          },
        })
        return
      }
      if (text.includes('HANG')) {
        pendingPromptId = id ?? null
        return
      }
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
      return
    }
    if (method === 'session/cancel') {
      if (pendingPromptId !== null) {
        send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: 'cancelled' } })
        pendingPromptId = null
      }
      return
    }
    // No method + has id = the hub's RESPONSE to our permission reverse request.
    if (method === undefined && id !== undefined && pendingPromptId !== null) {
      const result = msg.result as { outcome?: { outcome?: string; optionId?: string } } | undefined
      const outcome = result?.outcome
      const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow'
      update(`perm:${allowed ? 'allowed' : 'denied'}`)
      send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: allowed ? 'end_turn' : 'refusal' } })
      pendingPromptId = null
    }
  }

  return { transport, stats }
}
