#!/usr/bin/env node
/**
 * Mock ACP agent server — speaks NDJSON JSON-RPC over stdio, a hermetic stand-in
 * for `npx @zed-industries/claude-code-acp` / `codex-acp` in the host acceptance
 * gate. No deps, no network, no API key. The host e2e SPAWNS this for real
 * (process.execPath <this>), so it exercises the real stdio / framing path —
 * unlike the unit tests' in-memory PassThrough mock.
 *
 * Behaviour is driven by markers in the prompt text so the gate is deterministic:
 *   - default          → stream one message chunk "echo:<text>|turn=N" + end_turn
 *   - contains NEED_PERM→ also send a `session/request_permission` reverse request
 *                         (a destructive "rm -rf build") and DEFER the prompt
 *                         response until the hub answers: allow → end_turn (+ a
 *                         "perm:allowed" chunk), reject/cancel → refusal
 *   - contains HANG    → stream a chunk but never finish; only `session/cancel`
 *                         ends it (with 'cancelled')
 *
 * `turn=N` (the per-process prompt counter) proves a second task hit the SAME
 * held session — the counter only advances because the process stayed alive.
 */

let promptCount = 0
let pendingPromptId = null
let permCounter = 0

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function update(text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'mock-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  })
}

function promptText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function handle(msg) {
  const { id, method, params } = msg

  if (method === 'initialize') {
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
    promptCount++
    const text = promptText(params && params.prompt)
    update(`echo:${text}|turn=${promptCount}`)
    if (text.includes('NEED_PERM')) {
      pendingPromptId = id
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
      pendingPromptId = id
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
    const outcome = msg.result && msg.result.outcome
    const allowed = outcome && outcome.outcome === 'selected' && outcome.optionId === 'allow'
    update(`perm:${allowed ? 'allowed' : 'denied'}`)
    send({ jsonrpc: '2.0', id: pendingPromptId, result: { stopReason: allowed ? 'end_turn' : 'refusal' } })
    pendingPromptId = null
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) {
      try {
        handle(JSON.parse(line))
      } catch {
        /* skip a non-JSON line */
      }
    }
  }
})
process.stdin.on('end', () => process.exit(0))
