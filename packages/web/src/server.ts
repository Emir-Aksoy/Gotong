import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HumanParticipant, type Hub, type ParticipantId, type TaskId } from '@aipehub/core'

/**
 * Reference web UI for AipeHub.
 *
 * Embeds a tiny Node http server that:
 *   - serves a vanilla-JS single page from packages/web/static
 *   - streams HubEvents to clients over Server-Sent Events at /api/stream
 *   - lets a browser approve / reject pending human tasks via POST /api/tasks/:id/(complete|reject)
 *
 * No express, no bundler, no framework — just an addressable surface for the
 * humans in the room.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/server.js is one level below the package root, so the static dir is ../static
const STATIC_DIR = join(__dirname, '..', 'static')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

export interface WebServerOptions {
  port?: number
  host?: string
}

export interface WebServerHandle {
  readonly host: string
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

interface SseClient {
  res: ServerResponse
}

export function serveWeb(hub: Hub, opts: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const port = opts.port ?? 3000
  const sseClients = new Set<SseClient>()

  const unsubscribe = hub.onEvent((event) => {
    const payload = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
    for (const c of sseClients) {
      try {
        c.res.write(payload)
      } catch {
        /* client disappeared; cleanup happens on 'close' */
      }
    }
  })

  const server = createServer((req, res) => {
    handle(hub, req, res, sseClients).catch((err) => {
      console.error('[aipehub-web] handler threw:', err)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(`server error: ${err instanceof Error ? err.message : String(err)}`)
      } else {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
    })
  })

  return new Promise<WebServerHandle>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      const url = `http://${host}:${actualPort}`
      console.log(`[aipehub-web] listening at ${url}`)
      resolve({
        host,
        port: actualPort,
        url,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            unsubscribe()
            for (const c of sseClients) {
              try {
                c.res.end()
              } catch {
                /* ignore */
              }
            }
            sseClients.clear()
            server.close((err) => (err ? rejectClose(err) : resolveClose()))
          }),
      })
    })
  })
}

async function handle(
  hub: Hub,
  req: IncomingMessage,
  res: ServerResponse,
  sseClients: Set<SseClient>,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  // --- SSE stream ---------------------------------------------------------
  if (method === 'GET' && path === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    const client: SseClient = { res }
    sseClients.add(client)
    req.on('close', () => sseClients.delete(client))
    return
  }

  // --- state snapshot -----------------------------------------------------
  if (method === 'GET' && path === '/api/state') {
    sendJson(res, snapshotState(hub))
    return
  }

  // --- task action --------------------------------------------------------
  const taskAction = path.match(/^\/api\/tasks\/([^/]+)\/(complete|reject)$/)
  if (method === 'POST' && taskAction) {
    const taskId = decodeURIComponent(taskAction[1]!)
    const action = taskAction[2] as 'complete' | 'reject'
    const body = (await readJsonBody(req).catch(() => ({}))) as {
      output?: unknown
      error?: string
    }

    const human = findHumanWithPending(hub, taskId)
    if (!human) {
      sendJson(res, { error: `no human has task ${taskId} pending` }, 404)
      return
    }

    const ok =
      action === 'complete'
        ? human.complete(taskId, body?.output ?? null)
        : human.reject(taskId, body?.error ?? 'rejected via web UI')

    if (!ok) {
      sendJson(res, { error: 'task is no longer pending' }, 409)
      return
    }
    sendJson(res, { ok: true })
    return
  }

  // --- static files -------------------------------------------------------
  if (method === 'GET') {
    const requested = path === '/' ? 'index.html' : path.replace(/^\//, '')
    const safe = normalize(requested)
    if (safe.startsWith('..') || safe.includes(`..${sep}`)) {
      res.writeHead(400)
      res.end()
      return
    }
    const full = join(STATIC_DIR, safe)
    if (!full.startsWith(STATIC_DIR + sep) && full !== STATIC_DIR) {
      res.writeHead(400)
      res.end()
      return
    }
    try {
      const data = await readFile(full)
      const ext = extname(safe)
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      res.end(data)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      throw err
    }
  }

  res.writeHead(405)
  res.end()
}

// --- snapshot / lookup -----------------------------------------------------

function snapshotState(hub: Hub) {
  const participants = hub.registry.all().map((p) => ({
    id: p.id,
    kind: p.kind,
    capabilities: p.capabilities,
    load: hub.registry.loadOf(p.id),
  }))
  const pending: Array<{
    taskId: TaskId
    assignedTo: ParticipantId
    title?: string
    payload: unknown
    createdAt: number
  }> = []
  for (const p of hub.registry.byKind('human')) {
    if (p instanceof HumanParticipant) {
      for (const t of p.pending()) {
        pending.push({
          taskId: t.id,
          assignedTo: p.id,
          title: t.title,
          payload: t.payload,
          createdAt: t.createdAt,
        })
      }
    }
  }
  return {
    participants,
    transcript: hub.transcript.all(),
    pending,
  }
}

function findHumanWithPending(hub: Hub, taskId: TaskId): HumanParticipant | undefined {
  for (const p of hub.registry.byKind('human')) {
    if (p instanceof HumanParticipant) {
      if (p.pending().some((t) => t.id === taskId)) return p
    }
  }
  return undefined
}

// --- http helpers ----------------------------------------------------------

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = ''
    req.on('data', (chunk) => {
      buf += chunk
      if (buf.length > 1_000_000) {
        req.destroy()
        reject(new Error('body too large'))
      }
    })
    req.on('end', () => {
      if (!buf) return resolve(undefined)
      try {
        resolve(JSON.parse(buf))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}
