/**
 * MCP tool registry for the AipeHub bridge. Every tool is a thin
 * translation: take typed input → call HubClient → render the response
 * back into the MCP `content: [{type: 'text', text: ...}]` shape.
 *
 * Tool authoring conventions:
 *   - Tool names are snake_case verbs (`list_participants`, not `participants`).
 *   - Input schema uses raw zod shapes (`{ a: z.string() }`), not a wrapping
 *     `z.object` — that's what MCP SDK v1.x expects.
 *   - All output goes back as a single JSON-stringified text block.
 *     LLM clients render this fine and we don't have to invent a UI.
 *   - Errors throw — the SDK turns them into `isError: true` results that
 *     surface to the LLM with the message visible.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { HubClient } from './hub-client.js'

/**
 * Hard caps applied to the `dispatch_task` tool input (H4).
 *
 * Pre-3.4 `payload: z.unknown()` and `title: z.string()` had no upper
 * bound. An LLM in a long agent loop could mint MB-sized payloads which
 * the Hub would happily accept, write to `transcript.jsonl` on disk,
 * AND broadcast to every connected participant. One stuck loop could
 * fill the workspace dir + saturate every agent's inbox; on a small
 * VPS that's the whole machine.
 *
 * 256 KiB matches the WebSocket `maxPayload` default (PR #23 C1 fix),
 * so any payload accepted here also fits cleanly down the wire. 2000
 * chars on `title` is comfortable for transcript UIs and shorter than
 * any sane window-title field. Both limits are intentional caller-
 * facing constants so a future audit grep finds them.
 *
 * See AUDIT-v3.3.md finding H4.
 */
export const MAX_DISPATCH_PAYLOAD_BYTES = 256 * 1024
export const MAX_DISPATCH_TITLE_LENGTH = 2000

/**
 * Best-effort JSON byte length. Returns Infinity when the value cannot
 * be serialised (circular, BigInt, function, etc.) — callers treat
 * "can't measure" as "must reject" rather than guessing.
 */
function payloadJsonLength(v: unknown): number {
  if (v === undefined) return 0
  try {
    return JSON.stringify(v).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Raw Zod shape for the `dispatch_task` MCP tool input. Exported so
 * regression tests can hit the H4 caps (`payload` size, `title`
 * length) directly without booting an MCP server. Used inline by
 * `registerTools` below — the SDK accepts a raw shape (not a wrapping
 * `z.object`), which is also how the audit-fix can be unit-tested
 * by wrapping it in `z.object(...)` on the test side.
 */
export const DISPATCH_TASK_INPUT_SHAPE = {
  strategy: z
    .enum(['direct', 'capability', 'broadcast'])
    .describe('Routing strategy.'),
  recipient: z
    .string()
    .optional()
    .describe('Required when strategy=direct: the participant id to route to.'),
  capabilities: z
    .array(z.string())
    .optional()
    .describe(
      'Required when strategy=capability or broadcast (with filter): capability tags the recipient must have.',
    ),
  payload: z
    .unknown()
    .optional()
    .refine(
      (v) => payloadJsonLength(v) <= MAX_DISPATCH_PAYLOAD_BYTES,
      {
        message:
          `payload exceeds ${MAX_DISPATCH_PAYLOAD_BYTES} bytes when ` +
          `JSON-serialised (or contains values that cannot be ` +
          `serialised — circular references, BigInt, functions). ` +
          `See AUDIT-v3.3.md finding H4.`,
      },
    )
    .describe(
      `Task payload, free-form. Stringified into the participant's message body. JSON objects survive serialization. ` +
        `Capped at ${MAX_DISPATCH_PAYLOAD_BYTES} bytes when JSON-encoded (H4 — keeps a runaway LLM loop from filling the transcript / agent inboxes).`,
    ),
  title: z
    .string()
    .max(MAX_DISPATCH_TITLE_LENGTH, {
      message: `title exceeds ${MAX_DISPATCH_TITLE_LENGTH} characters (H4)`,
    })
    .optional()
    .describe(
      `Short human-readable title for the transcript. Capped at ${MAX_DISPATCH_TITLE_LENGTH} characters (H4).`,
    ),
  weight: z
    .number()
    .min(0.1)
    .max(10)
    .optional()
    .describe('Contribution weight in [0.1, 10.0], 1 decimal. Default 1.0.'),
  priority: z
    .number()
    .optional()
    .describe('Scheduler priority hint. Higher = more urgent. Ignored by the default scheduler.'),
  countContribution: z
    .boolean()
    .optional()
    .describe('Set false to exclude this single task from the leaderboard.'),
  timeoutMs: z
    .number()
    .min(1000)
    .max(600_000)
    .optional()
    .describe('How long to wait for the result before failing. Default 60_000 (60s).'),
} as const

export function registerTools(server: McpServer, client: HubClient): void {
  // 1. List the participants currently online in the room.
  server.registerTool(
    'list_participants',
    {
      title: 'List participants',
      description:
        'Return every participant currently registered with the Hub — agents and humans — with their capability tags and current load. Use this before dispatching to learn what the room can do.',
      inputSchema: {
        kind: z
          .enum(['agent', 'human', 'any'])
          .optional()
          .describe("Filter by participant kind. Defaults to 'any'."),
      },
    },
    async ({ kind }) => {
      const state = await client.state()
      const rows = state.participants.filter((p) =>
        !kind || kind === 'any' ? true : p.kind === kind,
      )
      return textJson({
        count: rows.length,
        participants: rows.map((p) => ({
          id: p.id,
          kind: p.kind,
          capabilities: p.capabilities,
          load: p.load,
        })),
      })
    },
  )

  // 2. Dispatch a task and wait for the result.
  server.registerTool(
    'dispatch_task',
    {
      title: 'Dispatch a task',
      description:
        'Send a task into the Hub using one of three routing strategies and wait for the result (synchronous). ' +
        'Use `direct` when you know the recipient id, `capability` for "whoever has these tags is least busy", ' +
        'or `broadcast` for "first-responder wins, others cancel". The task is recorded on the transcript and ' +
        'counts toward the contribution leaderboard unless `countContribution: false` is passed.',
      // Defined at module scope (DISPATCH_TASK_INPUT_SHAPE) so the H4
      // payload-size / title-length caps can be unit-tested directly
      // without booting an MCP server.
      inputSchema: DISPATCH_TASK_INPUT_SHAPE,
    },
    async (input) => {
      const strategy = buildStrategy(input.strategy, input.recipient, input.capabilities)
      const r = await client.dispatchAndWait(
        {
          strategy,
          payload: input.payload ?? {},
          title: input.title,
          weight: input.weight,
          priority: input.priority,
          countContribution: input.countContribution,
        },
        input.timeoutMs,
      )
      if (!r.ok) {
        throw new Error(`Dispatch failed: ${r.error ?? 'unknown error'}`)
      }
      return textJson(r.result)
    },
  )

  // 3. List recent tasks with their status.
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List recent tasks recorded on the Hub with status (pending / done / failed / cancelled) and the participant assigned. Filter by status if provided. Tasks come from /api/state, in transcript order.',
      inputSchema: {
        status: z
          .enum(['pending', 'done', 'failed', 'cancelled', 'any'])
          .optional()
          .describe("Filter by status. Defaults to 'any'."),
        limit: z
          .number()
          .min(1)
          .max(200)
          .optional()
          .describe('Maximum rows to return. Default 50.'),
      },
    },
    async ({ status, limit }) => {
      const state = await client.state()
      const tasks = Array.isArray(state.tasks) ? state.tasks : []
      const filtered = tasks.filter((t) => {
        if (!status || status === 'any') return true
        return typeof t === 'object' && t !== null && (t as { status?: string }).status === status
      })
      const lim = limit ?? 50
      return textJson({
        count: filtered.length,
        returned: Math.min(filtered.length, lim),
        tasks: filtered.slice(0, lim),
      })
    },
  )

  // 4. Pull the contribution leaderboard.
  server.registerTool(
    'get_leaderboard',
    {
      title: 'Contribution leaderboard',
      description:
        'Return the contribution leaderboard for a time window. Each row is a participant with their total contribution (sum of weight × rating), task count, average rating, capability breakdown, and last activity timestamp. Useful for "who has done the most this week".',
      inputSchema: {
        window: z
          .enum(['today', '7d', '30d', 'all'])
          .optional()
          .describe('Preset time window. Defaults to all-time.'),
        limit: z.number().min(1).max(50).optional().describe('Truncate rows. Default 20.'),
      },
    },
    async ({ window, limit }) => {
      const opts = windowToRange(window ?? 'all')
      const lb = await client.leaderboard(opts)
      const lim = limit ?? 20
      return textJson({
        window: { from: lb.from, to: lb.to },
        totalTaskCount: lb.totalTaskCount,
        unratedTaskCount: lb.unratedTaskCount,
        rows: lb.rows.slice(0, lim),
      })
    },
  )

  // 5. Evaluate a completed task — feeds the leaderboard.
  server.registerTool(
    'evaluate_task',
    {
      title: 'Evaluate a task',
      description:
        'Attach an evaluation (rating 0–5, 1 decimal place; optional free-text comment) to a completed task. ' +
        'Rating × the task`s weight becomes the contributor`s score for that task on the leaderboard. ' +
        'Find taskId via list_tasks first.',
      inputSchema: {
        taskId: z.string().describe('The id of the task to evaluate.'),
        rating: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .describe('0–5 stars, 1 decimal. Omit to leave the previous rating unchanged.'),
        comment: z.string().optional().describe('Free-text comment.'),
      },
    },
    async ({ taskId, rating, comment }) => {
      await client.evaluate({ taskId, rating, comment })
      return textJson({ ok: true, taskId })
    },
  )
}

// --- helpers ----------------------------------------------------------
// `buildStrategy` and `windowToRange` are exported for tests. They're
// pure functions with no MCP / Hub deps so they're easy to pin down
// independently of the SDK plumbing.

export function buildStrategy(
  kind: 'direct' | 'capability' | 'broadcast',
  recipient: string | undefined,
  capabilities: string[] | undefined,
): import('./hub-client.js').DispatchBody['strategy'] {
  // MCP tool keeps the user-facing `direct` / `recipient` vocabulary
  // (reads more naturally for an LLM); we translate to core's
  // `explicit` / `to` shape on the way out so the scheduler sees a
  // kind it actually handles. See hub-client.ts DispatchBody for the
  // pre-3.1 hang this used to cause.
  if (kind === 'direct') {
    if (!recipient) throw new Error("strategy='direct' requires `recipient`")
    return { kind: 'explicit', to: recipient }
  }
  if (kind === 'capability') {
    if (!capabilities || capabilities.length === 0) {
      throw new Error("strategy='capability' requires non-empty `capabilities`")
    }
    return { kind: 'capability', capabilities }
  }
  // broadcast: capabilities are optional
  return capabilities && capabilities.length > 0
    ? { kind: 'broadcast', capabilities }
    : { kind: 'broadcast' }
}

export function windowToRange(w: 'today' | '7d' | '30d' | 'all'): { from?: number; to?: number } {
  const now = Date.now()
  if (w === 'all') return {}
  if (w === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return { from: d.getTime(), to: now }
  }
  const days = w === '7d' ? 7 : 30
  return { from: now - days * 24 * 60 * 60 * 1000, to: now }
}

function textJson(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  }
}
