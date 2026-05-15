/**
 * `aipehub ping <ws-url>` — open a WebSocket, send HELLO, await
 * WELCOME (or REJECT), report. Exits 0 on WELCOME, non-zero on any
 * failure with a meaningful message.
 *
 * Avoids depending on `@aipehub/sdk-node` to keep the CLI's transitive
 * dep graph small. Uses `ws` directly with a hand-rolled state machine
 * that only cares about the first server frame.
 */

import { PROTOCOL_VERSION, HELLO_TIMEOUT_MS } from '@aipehub/protocol'

interface ParsedPing {
  url: string
  apiKey?: string
  timeoutMs: number
  agentId: string
}

export async function ping(args: readonly string[]): Promise<number> {
  const parsed = parseArgs(args)
  if (!parsed) return 2

  // Defer the `ws` import so the bin shim doesn't pay the cost when
  // the user runs a different subcommand. `ws` is bundled in the
  // published CLI tarball via `bundleDependencies`.
  const { WebSocket } = await import('ws')

  return await new Promise<number>((resolve) => {
    let settled = false
    const finish = (code: number, msg: string) => {
      if (settled) return
      settled = true
      if (code === 0) {
        console.log(msg)
      } else {
        console.error(msg)
      }
      try { ws.terminate() } catch { /* ignore */ }
      resolve(code)
    }
    const timer = setTimeout(() => {
      finish(1, `[ping] timed out after ${parsed.timeoutMs}ms`)
    }, parsed.timeoutMs)

    const ws = new WebSocket(parsed.url, { perMessageDeflate: false })

    ws.on('open', () => {
      const hello: Record<string, unknown> = {
        type: 'HELLO',
        protocolVersion: PROTOCOL_VERSION,
        client: { name: 'aipehub-cli', version: '0.1.0' },
        agents: [{ id: parsed.agentId, capabilities: [] }],
      }
      if (parsed.apiKey) hello.apiKey = parsed.apiKey
      ws.send(JSON.stringify(hello))
    })

    ws.on('message', (raw) => {
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        finish(1, '[ping] bad JSON from server')
        return
      }
      if (frame.type === 'WELCOME') {
        clearTimeout(timer)
        finish(
          0,
          `[ping] WELCOME — sessionId=${String(frame.sessionId ?? '?')} ` +
            `protocol=${String(frame.protocolVersion ?? '?')}`,
        )
      } else if (frame.type === 'REJECT') {
        clearTimeout(timer)
        finish(
          1,
          `[ping] REJECT code=${String(frame.code ?? '?')} message=${String(frame.message ?? '')}`,
        )
      } else if (frame.type === 'ERROR') {
        // Some hubs send ERROR before REJECT for unexpected_frame. Keep
        // listening for the actual terminal frame.
        // (Drain without resetting the timer — REJECT/WELCOME is required.)
      }
    })

    ws.on('error', (err) => {
      clearTimeout(timer)
      finish(1, `[ping] socket error: ${err instanceof Error ? err.message : String(err)}`)
    })
    ws.on('close', (code, reason) => {
      // close before WELCOME/REJECT counts as a failure (the server
      // may have killed the connection without sending REJECT).
      if (!settled) {
        clearTimeout(timer)
        finish(1, `[ping] connection closed code=${code} reason=${reason.toString() || '(none)'}`)
      }
    })
  })
}

function parseArgs(args: readonly string[]): ParsedPing | null {
  const positional: string[] = []
  let apiKey: string | undefined
  let timeoutMs = HELLO_TIMEOUT_MS
  let agentId = 'aipehub-cli-ping'
  for (const arg of args) {
    if (arg.startsWith('--api-key=')) {
      apiKey = arg.slice('--api-key='.length)
    } else if (arg.startsWith('--timeout=')) {
      const n = Number(arg.slice('--timeout='.length))
      if (!Number.isFinite(n) || n <= 0) {
        console.error('[aipehub] --timeout must be a positive number of ms')
        return null
      }
      timeoutMs = n
    } else if (arg.startsWith('--agent-id=')) {
      agentId = arg.slice('--agent-id='.length)
    } else if (arg.startsWith('--')) {
      console.error(`[aipehub] unknown option: ${arg}`)
      return null
    } else {
      positional.push(arg)
    }
  }
  const url = positional[0]
  if (!url) {
    console.error('[aipehub] missing <ws-url> argument')
    return null
  }
  if (!/^wss?:\/\//.test(url)) {
    console.error('[aipehub] url must start with ws:// or wss://')
    return null
  }
  const r: ParsedPing = { url, timeoutMs, agentId }
  if (apiKey !== undefined) r.apiKey = apiKey
  return r
}
