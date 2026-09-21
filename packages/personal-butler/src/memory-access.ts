import type { LlmAgentToolset, LlmToolCallResult, LlmToolDefinition } from '@gotong/llm'
import { MemoryReadBudget, MEMORY_READ_PAGE_BYTES, utf8Prefix } from '@gotong/personal-memory'
import { crossStoreRecall, memoryNodeRevision, type MemoryNet, type MemoryNode } from './memory-net.js'

export interface MemoryAccessOptions {
  /** A fresh read must never fall back to an older cached net on error. */
  net: (fresh?: boolean) => Promise<MemoryNet | null>
  budget?: MemoryReadBudget
  now?: () => number
}

const result = (text: string, isError = false): LlmToolCallResult => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) })

/** No path access: IDs only resolve inside the supplied owner-scoped net. */
export class MemoryAccessToolset implements LlmAgentToolset {
  private readonly budget: MemoryReadBudget
  constructor(private readonly opts: MemoryAccessOptions) { this.budget = opts.budget ?? new MemoryReadBudget() }

  runForTask<T>(task: { id: string; from: string }, fn: () => Promise<T>): Promise<T> {
    return this.budget.runForTask(task, fn)
  }

  listTools(): LlmToolDefinition[] {
    return [
      { name: 'search_memory', description: 'Search short clues across personal memory, knowledge files, tasks and long-run dossiers. For dates choose memory; for progress choose task/dossier; for reference material choose knowledge. Clues are not verified facts. Use read_memory with the returned id/revision for evidence. Use recall form=procedure for skills.',
        inputSchema: { type: 'object', properties: {
          query: { type: 'string' }, stores: { type: 'array', items: { type: 'string', enum: ['memory', 'knowledge', 'task', 'dossier', 'session'] } },
          history: { type: 'boolean', description: 'Include superseded facts for historical questions only.' },
        }, required: ['query'] } },
      { name: 'read_memory', description: 'Read a bounded source excerpt using an id and revision from search_memory or the automatic memory sheet. Changed/deleted sources must be searched again. nextOffset continues an incomplete excerpt; do not treat a truncated excerpt as the whole source. Dates labelled recorded are not event dates.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' }, revision: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['id', 'revision'] } },
    ]
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (this.budget.remaining() < 160) return result('Memory read budget exhausted; no more evidence loaded.', true)
    try {
      if (name === 'search_memory') return await this.search(args)
      if (name === 'read_memory') return await this.read(args)
      return result('Unknown memory access tool.', true)
    } catch {
      return result('Memory source unavailable; do not infer missing facts.', true)
    }
  }

  private async search(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 2000) return result('A non-empty query of at most 2000 characters is required.', true)
    const net = await this.opts.net()
    if (!net) return result('Memory sources unavailable.', true)
    const stores = Array.isArray(args.stores) ? args.stores : undefined
    const scoped = { ...net, nodes: net.nodes.filter(n => !stores?.length || stores.includes(n.store)) }
    const ids = await crossStoreRecall(scoped, args.query, { k: 6, ...(args.history === true ? {} : { now: (this.opts.now ?? Date.now)() }) })
    const hits: Record<string, unknown>[] = []
    const cap = Math.min(MEMORY_READ_PAGE_BYTES, this.budget.remaining())
    for (const id of ids) {
      const node = scoped.nodes.find(n => n.id === id)!
      const hit = { id, revision: memoryNodeRevision(node), store: node.store,
        recordedAt: node.ts ?? null, validFrom: node.validFrom ?? null, validTo: node.validTo ?? null,
        excerpt: utf8Prefix(node.evidenceText ?? node.text, 240), excerptOnly: true }
      if (Buffer.byteLength(JSON.stringify({ hits: [...hits, hit], more: true })) > cap) break
      hits.push(hit)
    }
    const text = JSON.stringify({ hits, more: hits.length < ids.length })
    return this.budget.consume(text) ? result(text) : result('Memory read budget exhausted.', true)
  }

  private async read(args: Record<string, unknown>): Promise<LlmToolCallResult> {
    if (typeof args.id !== 'string' || typeof args.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(args.revision)) return result('A source id and revision from search_memory are required.', true)
    const offset = args.offset ?? 0
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return result('Invalid source offset.', true)
    // Re-read before both the version check and duplicate check: a deleted source
    // must never be mistaken for evidence already validated in this execution.
    const net = await this.opts.net(true)
    const node = net?.nodes.find(n => n.id === args.id)
    if (!node || memoryNodeRevision(node) !== args.revision) return result('Source changed, deleted or inaccessible; search again.', true)
    const key = `${node.id}:${args.revision}:${offset}`
    if (this.budget.seen(key)) return result('This source excerpt was already returned.', true)
    const body = node.evidenceText ?? node.text
    if (offset > body.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(body[offset] ?? ''))) return result('Invalid source offset.', true)
    const cap = Math.min(MEMORY_READ_PAGE_BYTES, this.budget.remaining())
    const envelope = (excerpt: string) => JSON.stringify({ id: node.id, revision: args.revision,
      recordedAt: node.ts ?? null, validFrom: node.validFrom ?? null, validTo: node.validTo ?? null,
      offset, nextOffset: offset + excerpt.length < body.length ? offset + excerpt.length : null,
      excerpt, evidenceKind: node.store === 'memory' ? 'memory-source' : 'working-record-not-user-confirmation' })
    let excerpt = utf8Prefix(body.slice(offset), Math.max(0, cap - 450))
    while (excerpt && Buffer.byteLength(envelope(excerpt)) > cap) excerpt = utf8Prefix(excerpt, Buffer.byteLength(excerpt) - 32)
    const text = envelope(excerpt)
    if (!excerpt && offset < body.length) return result('Memory read budget exhausted.', true)
    return this.budget.consume(text, key) ? result(text) : result('Memory read budget exhausted.', true)
  }
}
