/**
 * `MemoryToolset` — exposes a butler's memory as three LLM tools:
 *
 *   - `remember`  durably record a fact or note. `semantic` (default) is a
 *                 lasting profile fact that surfaces in next session's frozen
 *                 block; `episodic` is a "what happened" note.
 *   - `recall`    search past memory (episodic + semantic) by substring. This
 *                 is the on-demand path — the frozen block only carries the
 *                 curated semantic profile, so `recall` is how the model digs
 *                 up older raw history mid-turn.
 *   - `forget`    delete one entry by id (ids appear in the frozen block and
 *                 in `recall` output).
 *
 * Implements {@link LlmAgentToolset} so it drops straight into
 * `new LlmAgent({ tools })` — or composes with a dispatch / MCP toolset via
 * `ComposedToolset`. Tool failures come back as `isError: true` content (not
 * thrown) so the model can recover within the same turn, matching the
 * `DispatchToolset` convention.
 *
 * Scope note: in M1 all three tools run DIRECTLY — they only touch the
 * butler's own per-user memory, which is low-stakes (the user can always
 * re-tell). The approval-gating machinery (Phase 16 inbox) is reserved for
 * tools that mutate the hub / spend / send / delete external state — a later
 * milestone of the butler build.
 */

import type {
  LlmAgentToolset,
  LlmToolCallResult,
  LlmToolDefinition,
} from '@aipehub/llm'
import type { MemoryHandle, MemoryKind } from '@aipehub/services-sdk'

export interface MemoryToolsetOptions {
  /** The (already per-owner-scoped) memory handle the tools act on. */
  memory: MemoryHandle
  /** Kinds the `remember` tool may write. Default `['episodic', 'semantic']`. */
  writableKinds?: readonly MemoryKind[]
  /** Default + hard cap on entries `recall` returns. Default 12, cap 50. */
  recallDefaultK?: number
}

const REMEMBER = 'remember'
const RECALL = 'recall'
const FORGET = 'forget'

const DEFAULT_WRITABLE_KINDS: readonly MemoryKind[] = ['episodic', 'semantic']
const DEFAULT_RECALL_K = 12
const RECALL_HARD_CAP = 50

export class MemoryToolset implements LlmAgentToolset {
  private readonly memory: MemoryHandle
  private readonly writableKinds: ReadonlySet<MemoryKind>
  private readonly recallDefaultK: number

  constructor(opts: MemoryToolsetOptions) {
    this.memory = opts.memory
    this.writableKinds = new Set(
      opts.writableKinds && opts.writableKinds.length > 0
        ? opts.writableKinds
        : DEFAULT_WRITABLE_KINDS,
    )
    this.recallDefaultK = clamp(opts.recallDefaultK ?? DEFAULT_RECALL_K, 1, RECALL_HARD_CAP)
  }

  listTools(): LlmToolDefinition[] {
    const writable = [...this.writableKinds]
    return [
      {
        name: REMEMBER,
        description:
          'Durably record something worth keeping. Use `semantic` (default) ' +
          'for a lasting fact about the user or a decision — it appears in ' +
          'future sessions automatically. Use `episodic` for a note about ' +
          'what just happened. Only record things that will still matter ' +
          'later; do not log every message.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The fact or note to remember. One self-contained sentence is ideal.',
            },
            kind: {
              type: 'string',
              enum: writable,
              description: `Memory kind. One of: ${writable.join(', ')}. Defaults to '${
                writable.includes('semantic') ? 'semantic' : writable[0]
              }'.`,
            },
          },
          required: ['text'],
        },
      },
      {
        name: RECALL,
        description:
          'Search past memory for relevant entries by keyword (case-insensitive ' +
          'substring). Use this to dig up older details that are not in the ' +
          'frozen long-term-memory block at the top of this prompt.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Keyword(s) to match. Omit to get the most recent entries.',
            },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: ['episodic', 'semantic', 'working'] },
              description: 'Restrict to these memory kinds. Omit to search all.',
            },
            k: {
              type: 'number',
              description: `Max entries to return (default ${this.recallDefaultK}, hard cap ${RECALL_HARD_CAP}).`,
            },
          },
        },
      },
      {
        name: FORGET,
        description:
          'Delete one memory entry by its id (ids are shown in the long-term-memory ' +
          'block and in `recall` results). No-op if the id is already gone.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id of the entry to delete.' },
          },
          required: ['id'],
        },
      },
    ]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    switch (name) {
      case REMEMBER:
        return this.doRemember(args)
      case RECALL:
        return this.doRecall(args)
      case FORGET:
        return this.doForget(args)
      default:
        return errorResult(`unknown tool: ${name}`)
    }
  }

  // --- tool bodies ------------------------------------------------------

  private async doRemember(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!text) return errorResult('`text` is required and must be a non-empty string.')

    let kind: MemoryKind = this.writableKinds.has('semantic')
      ? 'semantic'
      : ([...this.writableKinds][0] as MemoryKind)
    if (typeof args.kind === 'string') {
      if (!isMemoryKind(args.kind) || !this.writableKinds.has(args.kind)) {
        return errorResult(
          `kind '${args.kind}' is not writable. Allowed: ${[...this.writableKinds].join(', ')}.`,
        )
      }
      kind = args.kind
    }

    try {
      const entry = await this.memory.remember({ kind, text })
      return okResult(`Remembered as ${entry.id} (${entry.kind}).`)
    } catch (err) {
      return errorResult(`remember failed: ${errMsg(err)}`)
    }
  }

  private async doRecall(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const query = typeof args.query === 'string' && args.query.length > 0 ? args.query : undefined
    const kinds = Array.isArray(args.kinds)
      ? (args.kinds.filter(isMemoryKind) as MemoryKind[])
      : undefined
    const k = clamp(
      typeof args.k === 'number' && Number.isFinite(args.k) ? Math.floor(args.k) : this.recallDefaultK,
      1,
      RECALL_HARD_CAP,
    )

    try {
      const entries = await this.memory.recall({
        ...(query !== undefined ? { text: query } : {}),
        ...(kinds && kinds.length > 0 ? { kinds } : {}),
        k,
      })
      if (entries.length === 0) return okResult('No matching memories.')
      const lines = entries.map(
        (e) => `[${e.id}] (${e.kind}, ${new Date(e.ts).toISOString()}) ${e.text}`,
      )
      return okResult(lines.join('\n'))
    } catch (err) {
      return errorResult(`recall failed: ${errMsg(err)}`)
    }
  }

  private async doForget(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    const id = typeof args.id === 'string' ? args.id : ''
    if (!id) return errorResult('`id` is required and must be a non-empty string.')
    try {
      await this.memory.forget(id)
      return okResult(`Forgot ${id} (if it existed).`)
    } catch (err) {
      return errorResult(`forget failed: ${errMsg(err)}`)
    }
  }
}

// --- shared helpers -----------------------------------------------------

function okResult(text: string): LlmToolCallResult {
  return { content: [{ type: 'text', text }] }
}

function errorResult(text: string): LlmToolCallResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function isMemoryKind(v: unknown): v is MemoryKind {
  return v === 'episodic' || v === 'semantic' || v === 'working'
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
