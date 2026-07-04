/**
 * `MemoryToolset` — exposes a butler's memory as three LLM tools:
 *
 *   - `remember`  durably record a fact or note. `semantic` (default) is a
 *                 lasting profile fact that surfaces in next session's frozen
 *                 block; `episodic` is a "what happened" note.
 *   - `recall`    search past memory (episodic + semantic) by relevance —
 *                 Chinese-aware keyword overlap, not bare substring. This is the
 *                 on-demand path — the frozen block only carries the
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
} from '@gotong/llm'
import type { MemoryEntry, MemoryHandle, MemoryKind } from '@gotong/services-sdk'

import { queryFingerprint, type MemoryQueryHitWriter } from './dreaming.js'
import {
  clampImportance,
  importanceOf,
  META_IMPORTANCE,
  type Importance,
} from './importance.js'
import { DEFAULT_LINK_EXPAND, expandByLinks, linksOf } from './links.js'
import {
  cleanSteps,
  formatProcedureSteps,
  formOf,
  isProcedure,
  stepsOf,
  FORM_PROCEDURE,
  META_FORM,
  META_STEPS,
} from './procedure.js'
import { lexicalRetriever, type MemoryRetriever } from './retriever.js'
import { tierOf } from './tiers.js'

/**
 * Opt-in (decision F-M3): reinforce the entries a recall returned — bump
 * `recallCount` + stamp `lastRecalledTs` so {@link effectiveSalience} keeps
 * frequently-used memories under budget pressure. Called best-effort, once per
 * returned entry.
 *
 * The reinforcer MUST update meta IN PLACE preserving `id` + `ts` (so the
 * frozen-block order — importance, then ts, then id — is untouched; recallCount
 * / lastRecalledTs are not read by that comparator, and the body prints neither,
 * so a correct reinforcer leaves the block byte-identical). The handle has no
 * meta-only update, so the host wires a file-backed patch — see
 * {@link reinforcedMeta} for the pure meta transform.
 */
export type MemoryReinforcer = (entry: MemoryEntry, now: number) => void | Promise<void>

/**
 * Opt-in (decision E, E-M3): resolve link-target ids to their entries so
 * `recall` can expand ONE hop — surfacing what the matched facts associate with.
 * The host wires a file-backed by-id read (the handle has no get-by-id); tests
 * inject a fake. Best-effort: a failure leaves the un-expanded seeds.
 */
export type MemoryLinkLookup = (
  ids: readonly string[],
) => readonly MemoryEntry[] | Promise<readonly MemoryEntry[]>

export interface MemoryToolsetOptions {
  /** The (already per-owner-scoped) memory handle the tools act on. */
  memory: MemoryHandle
  /** Kinds the `remember` tool may write. Default `['episodic', 'semantic']`. */
  writableKinds?: readonly MemoryKind[]
  /** Default + hard cap on entries `recall` returns. Default 12, cap 50. */
  recallDefaultK?: number
  /**
   * Swappable backend for the `recall` tool (vector / hybrid / chroma-mcp).
   * Default = {@link lexicalRetriever} (Chinese-aware CJK bigram / Latin token
   * overlap). Writes always go to the handle regardless — the retriever only
   * answers queries.
   */
  retriever?: MemoryRetriever
  /**
   * Opt-in (F-M3): after a recall, reinforce the returned entries. Omit → no
   * reinforcement (default, byte-identical to pre-F). Best-effort: a failure is
   * swallowed so it never breaks the recall. See {@link MemoryReinforcer}.
   */
  reinforce?: MemoryReinforcer
  /**
   * Opt-in (MR2): after a recall WITH a query, record that query's fingerprint
   * on each matched entry, bumping its query-DIVERSITY (how many distinct
   * questions a fact has answered) for the dreaming sweep. Omit → no recording
   * (default, byte-identical to pre-MR2). Like {@link reinforce}, the host wires
   * a file-backed patch and it's best-effort. See {@link MemoryQueryHitWriter}.
   */
  queryHit?: MemoryQueryHitWriter
  /**
   * Opt-in (E-M3): after a recall, expand ONE hop along the matched entries'
   * links and append the linked entries (marked `↪`). Omit → no expansion
   * (default, byte-identical to pre-E). See {@link MemoryLinkLookup}.
   */
  linkLookup?: MemoryLinkLookup
  /** Max one-hop neighbors appended per recall when expanding. Default {@link DEFAULT_LINK_EXPAND}. */
  expandK?: number
  /** Clock for reinforcement timestamps. Default `Date.now`. */
  now?: () => number
}

const REMEMBER = 'remember'
const REMEMBER_PROCEDURE = 'remember_procedure'
const REFINE_PROCEDURE = 'refine_procedure'
const RECALL = 'recall'
const FORGET = 'forget'

const DEFAULT_WRITABLE_KINDS: readonly MemoryKind[] = ['episodic', 'semantic']
const DEFAULT_RECALL_K = 12
const RECALL_HARD_CAP = 50

/**
 * Cap on entries scanned to resolve a procedure by id for {@link MemoryToolset}'s
 * `refine_procedure`. The handle has no get-by-id, so refine lists semantic
 * entries and finds the target; this bounds that scan (skills are few — a butler
 * accumulates dozens, not thousands — so this never truncates a real target).
 */
const PROCEDURE_SCAN = 200

export class MemoryToolset implements LlmAgentToolset {
  private readonly memory: MemoryHandle
  private readonly retriever: MemoryRetriever
  private readonly writableKinds: ReadonlySet<MemoryKind>
  private readonly recallDefaultK: number
  private readonly reinforce: MemoryReinforcer | undefined
  private readonly queryHit: MemoryQueryHitWriter | undefined
  private readonly linkLookup: MemoryLinkLookup | undefined
  private readonly expandK: number
  private readonly now: () => number

  constructor(opts: MemoryToolsetOptions) {
    this.memory = opts.memory
    // Recall goes through the retriever (default = Chinese-aware lexical rank);
    // writes always hit the handle directly.
    this.retriever = opts.retriever ?? lexicalRetriever(opts.memory)
    this.writableKinds = new Set(
      opts.writableKinds && opts.writableKinds.length > 0
        ? opts.writableKinds
        : DEFAULT_WRITABLE_KINDS,
    )
    this.recallDefaultK = clamp(opts.recallDefaultK ?? DEFAULT_RECALL_K, 1, RECALL_HARD_CAP)
    this.reinforce = opts.reinforce
    this.queryHit = opts.queryHit
    this.linkLookup = opts.linkLookup
    this.expandK = Math.max(0, Math.floor(opts.expandK ?? DEFAULT_LINK_EXPAND))
    this.now = opts.now ?? Date.now
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
            importance: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description:
                'How important this is, 1–5. 1=trivial, 3=ordinary (default), ' +
                '5=critical/pin (kept first and never auto-dropped under space ' +
                'pressure). Use 4–5 only for facts that should always stay in view.',
            },
          },
          required: ['text'],
        },
      },
      {
        name: REMEMBER_PROCEDURE,
        description:
          'Record HOW you accomplished a multi-step task — the ordered sequence ' +
          'of actions that worked — so you can repeat it next time. Use this for ' +
          'reusable know-how ("how I got an overtime claim approved"), not one-off ' +
          'facts (use `remember` for those). Stored as a lasting semantic memory.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Short name or goal of the procedure. One line.',
            },
            steps: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The ordered steps, each a short action sentence. At least one; ' +
                'order matters.',
            },
            importance: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description:
                'How important this know-how is, 1–5 (default 3). 5 pins it in ' +
                'view and protects it from auto-drop under space pressure.',
            },
          },
          required: ['name', 'steps'],
        },
      },
      {
        name: REFINE_PROCEDURE,
        description:
          'Revise the steps of a procedure you already recorded, in place, as you ' +
          'find a better way to do it — its name and id stay the same (so it keeps ' +
          'its place in memory). Use `steps` to REPLACE the whole sequence, or ' +
          '`appendSteps` to ADD steps to the end. Get the id from `recall` (search ' +
          'form "procedure"). For a brand-new skill use `remember_procedure` instead.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The id of the procedure to revise (from `recall`).',
            },
            steps: {
              type: 'array',
              items: { type: 'string' },
              description: 'New ordered steps that REPLACE the existing ones. Non-empty.',
            },
            appendSteps: {
              type: 'array',
              items: { type: 'string' },
              description: 'Ordered steps to ADD to the end of the existing sequence. Non-empty.',
            },
          },
          required: ['id'],
        },
      },
      {
        name: RECALL,
        description:
          'Search past memory for relevant entries by keyword relevance ' +
          '(Chinese-aware — overlapping words/characters, not an exact ' +
          'substring), most relevant first. Use this to dig up older details ' +
          'that are not in the frozen long-term-memory block at the top of this ' +
          'prompt. Omit the query to get the most recent entries.',
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
            minImportance: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description:
                'Only return entries at least this important (1–5). Omit for all. ' +
                'Use e.g. 4 to surface only the high-salience facts.',
            },
            tier: {
              type: 'string',
              description:
                'Restrict to a single long-term-memory cluster by its id ' +
                '(e.g. persona / projects / people / commitments / misc). Omit to ' +
                'search every cluster. Matches entries explicitly tagged with that cluster.',
            },
            form: {
              type: 'string',
              description:
                'Restrict to one memory form. Use "procedure" to surface only ' +
                'recorded how-to step sequences. Omit to search every form.',
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
      case REMEMBER_PROCEDURE:
        return this.doRememberProcedure(args)
      case REFINE_PROCEDURE:
        return this.doRefineProcedure(args)
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

    const importance: Importance | undefined =
      args.importance === undefined ? undefined : clampImportance(args.importance)

    try {
      const meta = importance === undefined ? undefined : { [META_IMPORTANCE]: importance }
      const entry = await this.memory.remember({ kind, text, ...(meta ? { meta } : {}) })
      return okResult(
        `Remembered as ${entry.id} (${entry.kind}${
          importance !== undefined ? `, importance ${importance}` : ''
        }).`,
      )
    } catch (err) {
      return errorResult(`remember failed: ${errMsg(err)}`)
    }
  }

  private async doRememberProcedure(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    // A procedure is always a lasting semantic fact — if the toolset can't write
    // semantic, it can't record procedures.
    if (!this.writableKinds.has('semantic')) {
      return errorResult('Procedures are stored as semantic memory, which is not writable here.')
    }
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    if (!name) return errorResult('`name` is required and must be a non-empty string.')

    const steps = cleanSteps(args.steps)
    if (steps.length === 0) {
      return errorResult('`steps` must be a non-empty array of step strings.')
    }

    const importance: Importance | undefined =
      args.importance === undefined ? undefined : clampImportance(args.importance)

    try {
      const meta: Record<string, unknown> = {
        [META_FORM]: FORM_PROCEDURE,
        [META_STEPS]: steps,
        ...(importance !== undefined ? { [META_IMPORTANCE]: importance } : {}),
      }
      const entry = await this.memory.remember({ kind: 'semantic', text: name, meta })
      return okResult(`Remembered procedure ${entry.id} (${steps.length} step(s)).`)
    } catch (err) {
      return errorResult(`remember_procedure failed: ${errMsg(err)}`)
    }
  }

  /**
   * Self-improve (MR3 ②): revise a recorded procedure's steps IN PLACE. Only the
   * `steps` change — keeping the id/name/ts means the entry stays put (a renamed
   * skill would mint a new id and move its frozen-block position, which is what
   * the Umbrella merge is for, not a casual revision). Amends `meta.steps` via the
   * handle's `patchMeta` (feature-detected); replace with `steps`, or append with
   * `appendSteps` (exactly one).
   */
  private async doRefineProcedure(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (typeof this.memory.patchMeta !== 'function') {
      return errorResult('This memory backend cannot revise entries in place.')
    }
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!id) return errorResult('`id` is required and must be a non-empty string.')

    const replace = cleanSteps(args.steps)
    const append = cleanSteps(args.appendSteps)
    const hasReplace = args.steps !== undefined && replace.length > 0
    const hasAppend = args.appendSteps !== undefined && append.length > 0
    if (hasReplace === hasAppend) {
      // Neither → nothing to do; both → ambiguous intent. Demand exactly one.
      return errorResult('Provide exactly one of `steps` (replace) or `appendSteps` (append).')
    }

    try {
      // No get-by-id on the handle — list semantic entries and find the target.
      const semantic = await this.memory.list({ kind: 'semantic', limit: PROCEDURE_SCAN })
      const target = semantic.find((e) => e.id === id)
      if (!target) return errorResult(`No procedure with id ${id}.`)
      if (!isProcedure(target)) return errorResult(`${id} is not a procedure (no steps to revise).`)

      const next = hasReplace ? replace : [...stepsOf(target), ...append]
      const ok = await this.memory.patchMeta(id, { [META_STEPS]: next })
      if (!ok) return errorResult(`No procedure with id ${id}.`)
      return okResult(`Refined procedure ${id} (${next.length} step(s)).`)
    } catch (err) {
      return errorResult(`refine_procedure failed: ${errMsg(err)}`)
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

    const minImportance: Importance | undefined =
      args.minImportance === undefined ? undefined : clampImportance(args.minImportance)
    const tier =
      typeof args.tier === 'string' && args.tier.trim().length > 0 ? args.tier.trim() : undefined
    const form =
      typeof args.form === 'string' && args.form.trim().length > 0 ? args.form.trim() : undefined

    try {
      const retrieved = await this.retriever.retrieve({
        ...(query !== undefined ? { text: query } : {}),
        ...(kinds && kinds.length > 0 ? { kinds } : {}),
        k,
      })
      // Importance ranking lives in the default retriever; a custom (vector)
      // retriever owns its own order. `minImportance` / `tier` are universal
      // post-filters — narrowing the result is safe regardless of how it ranked.
      const entries = retrieved.filter(
        (e) =>
          (minImportance === undefined || importanceOf(e) >= minImportance) &&
          (tier === undefined || tierOf(e, '') === tier) &&
          (form === undefined || formOf(e, '') === form),
      )
      if (entries.length === 0) return okResult('No matching memories.')

      // E-M3: optionally expand one hop along links (opt-in). The seeds are the
      // direct matches; neighbors are appended (marked `↪`) so the model sees
      // what those facts associate with. Neighbors are NOT re-filtered by
      // minImportance/tier — an explicit association can be exactly the relevant
      // context even if it is low-importance or in another cluster.
      const seedIds = new Set(entries.map((e) => e.id))
      const result = await this.expand(entries, seedIds)

      const lines = result.map((e) => {
        const t = tierOf(e, '')
        const tag = t ? `${e.kind}/${t}` : e.kind
        const prefix = seedIds.has(e.id) ? '' : '↪ '
        // A recalled procedure is useless without its steps — show them inline
        // (recall output is the on-demand path, not the byte-stable frozen block).
        const steps = isProcedure(e) ? stepsOf(e) : []
        const suffix = steps.length > 0 ? ` — steps: ${formatProcedureSteps(steps)}` : ''
        return `${prefix}[${e.id}] (${tag}, p${importanceOf(e)}, ${new Date(e.ts).toISOString()}) ${e.text}${suffix}`
      })
      // F-M3: reinforce what the query MATCHED (the seeds), opt-in. Best-effort
      // and AFTER the result is built — a failed reinforce must not turn a good
      // recall into an error, and it never alters the returned text. Expansion
      // neighbors are surfaced-by-association, not matched, so they're not
      // reinforced (that would flatten salience across whole neighborhoods).
      await this.reinforceEntries(entries)
      // MR2: also stamp THIS query's fingerprint on the matched seeds, so the
      // dreaming sweep can tell a fact that gets asked about in many different
      // ways (high query-diversity) from one merely re-read often. Same
      // best-effort / seeds-only / post-build discipline as reinforce.
      await this.recordQueryHits(query, entries)
      return okResult(lines.join('\n'))
    } catch (err) {
      return errorResult(`recall failed: ${errMsg(err)}`)
    }
  }

  /**
   * E-M3: best-effort one-hop link expansion (no-op when `linkLookup` not set or
   * `expandK` is 0). Gathers the seeds' link-target ids not already among the
   * seeds, resolves them via the lookup, and appends them. A lookup failure
   * leaves the un-expanded seeds.
   */
  private async expand(
    seeds: readonly MemoryEntry[],
    seedIds: ReadonlySet<string>,
  ): Promise<readonly MemoryEntry[]> {
    if (!this.linkLookup || this.expandK === 0) return seeds
    const wanted: string[] = []
    const seen = new Set<string>()
    for (const e of seeds) {
      for (const id of linksOf(e)) {
        if (!seedIds.has(id) && !seen.has(id)) {
          seen.add(id)
          wanted.push(id)
        }
      }
    }
    if (wanted.length === 0) return seeds
    try {
      const fetched = await this.linkLookup(wanted)
      return expandByLinks(seeds, fetched, { maxExpand: this.expandK })
    } catch {
      return seeds // best-effort: expansion failure must never break recall
    }
  }

  /** F-M3: best-effort reinforcement of recalled entries (no-op when not opted in). */
  private async reinforceEntries(entries: readonly MemoryEntry[]): Promise<void> {
    if (!this.reinforce || entries.length === 0) return
    const now = this.now()
    for (const e of entries) {
      try {
        await this.reinforce(e, now)
      } catch {
        // best-effort: a reinforcement failure must never break recall
      }
    }
  }

  /**
   * MR2: best-effort stamp of THIS recall's query fingerprint on the matched
   * seeds (no-op when not opted in or the query is empty). The fingerprint is
   * computed once for the whole call; the writer itself is idempotent (a
   * re-asked query, already in the bounded set, is not a new hit), so a fact's
   * query-DIVERSITY rises only when it's asked about in genuinely new ways.
   */
  private async recordQueryHits(
    query: string | undefined,
    entries: readonly MemoryEntry[],
  ): Promise<void> {
    if (!this.queryHit || query === undefined || entries.length === 0) return
    const fingerprint = queryFingerprint(query)
    if (fingerprint === '') return // no terms (e.g. punctuation-only) → nothing to record
    for (const e of entries) {
      try {
        await this.queryHit(e, fingerprint)
      } catch {
        // best-effort: a query-hit failure must never break recall
      }
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
