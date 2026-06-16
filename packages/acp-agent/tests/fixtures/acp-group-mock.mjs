#!/usr/bin/env node
/**
 * Mock ACP agent that ALSO spawns an idle GRANDCHILD in its own process group —
 * the hermetic stand-in for `npx … claude-code-acp` (where `npx` is the direct
 * child and the real ACP bridge is a `node` grandchild). It exists to prove
 * `AcpSession.terminate()` reaps the WHOLE tree, not just the direct child
 * (audit L6-1): a direct-pid-only SIGTERM would orphan the grandchild.
 *
 * Handshake is the bare minimum so `ensureStarted()` resolves: `initialize` +
 * `session/new`. On startup it spawns a plain idle grandchild (default spawn →
 * NOT detached → inherits THIS process's group; AcpSession spawned us with
 * `detached:true`, so we are the group leader) and prints its pid to stderr as
 * `GRANDCHILD_PID=<pid>` for the test to capture via the `onStderr` seam.
 */
import { spawn } from 'node:child_process'

// Idle grandchild in OUR process group. Dies on the group SIGTERM that a correct
// `killChild` sends (`process.kill(-pgid, …)`); survives a buggy direct-pid kill.
// The 30s self-exit is a safety net so a test crash can't leak it forever.
const gc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  stdio: 'ignore',
})
process.stderr.write(`GRANDCHILD_PID=${gc.pid}\n`)

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function handle(msg) {
  const { id, method } = msg
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {} } })
    return
  }
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'mock-1' } })
    return
  }
  // Any other method is irrelevant to the terminate/reap gate — ignore it.
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
