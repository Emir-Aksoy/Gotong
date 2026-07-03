/**
 * butler-vector-recall — semantic recall for the personal butler, two ways.
 *
 * Deterministic, hermetic, self-asserting (throws on mismatch). No network, no
 * model download, no vector server: a tiny local "embedder" stands in for a real
 * model so the semantics are exact and the demo runs in milliseconds.
 *
 *   Scene 1  embeddingRetriever — local embed + in-frame cosine
 *   Scene 2  chromaRetriever     — the seam to a chroma-mcp vector store
 *   Scene 3  parity              — no-query recall still importance-then-recency
 *
 * THE point both retrievers make: a query that shares ZERO characters with the
 * stored text still matches when they are semantically close. 「饮料」 (beverage)
 * finds 「奶茶」/「咖啡」 — where C-M2's lexical overlap scores exactly 0.
 *
 * Run:  pnpm demo:butler-vector-recall
 *
 * The framework never computes a vector. The embedding model (Scene 1) and the
 * vector store (Scene 2) are INJECTED — see chroma-retriever.ts for the
 * production chroma-mcp wiring. Same north-star stance as RAG: no vectors on disk
 * inside the framework; the MemoryHandle stays the source of truth.
 */

import {
  cosineSimilarity,
  embeddingRetriever,
  lexicalRetriever,
  type Embedder,
  type MemoryRetriever,
} from '@aipehub/personal-memory'
import type {
  MemoryEntry,
  MemoryHandle,
  MemoryKind,
  MemoryQuery,
  NewMemoryEntry,
} from '@aipehub/services-sdk'

import { chromaRetriever, type ChromaQuery } from './chroma-retriever.js'

// --- a minimal in-memory MemoryHandle (demo-local; prod uses the file service) -

function inMemoryHandle(seed: MemoryEntry[]): MemoryHandle {
  let entries = [...seed]
  let n = seed.length
  return {
    async recall(query: MemoryQuery): Promise<MemoryEntry[]> {
      const k = query.k ?? 20
      let rows = entries
      if (query.kinds && query.kinds.length > 0) {
        rows = rows.filter((e) => query.kinds!.includes(e.kind))
      }
      if (query.since !== undefined) rows = rows.filter((e) => e.ts >= query.since!)
      // The file backend does case-insensitive substring on `text`; mirror that
      // so the demo's lexical-vs-semantic contrast is honest.
      if (query.text) {
        const q = query.text.toLowerCase()
        rows = rows.filter((e) => e.text.toLowerCase().includes(q))
      }
      return [...rows].sort((a, b) => b.ts - a.ts).slice(0, k)
    },
    async remember(entry: NewMemoryEntry): Promise<MemoryEntry> {
      const e: MemoryEntry = {
        id: entry.id ?? `m${++n}`,
        kind: entry.kind,
        text: entry.text,
        ...(entry.meta ? { meta: entry.meta } : {}),
        ts: Date.now(),
      }
      entries.push(e)
      return e
    },
    async list(opts) {
      let rows = entries
      if (opts?.kind) rows = rows.filter((e) => e.kind === opts.kind)
      return [...rows].sort((a, b) => b.ts - a.ts).slice(0, opts?.limit ?? 100)
    },
    async forget(id) {
      entries = entries.filter((e) => e.id !== id)
    },
    async clear(kind) {
      entries = kind ? entries.filter((e) => e.kind !== kind) : []
    },
  }
}

function entry(id: string, text: string, ts: number, meta?: Record<string, unknown>): MemoryEntry {
  return { id, kind: 'semantic', text, ts, ...(meta ? { meta } : {}) }
}

// --- a tiny deterministic "local embedder" (stands in for a real model) --------
//
// Three concept axes; a 1 on an axis if the text mentions any of its keywords.
// Enough to make 「奶茶」/「咖啡」/「饮料」 collinear (all `drink`) while 「篮球」 is
// orthogonal. A real local model (sentence-transformers via a child process, an
// ONNX runtime, an embedding API) plugs into the SAME `Embedder` seam.

const AXES: Record<string, readonly string[]> = {
  drink: ['奶茶', '咖啡', '饮料', '茶', '奶', '拿铁'],
  sport: ['篮球', '足球', '跑步', '运动'],
  work: ['项目', '代码', '部署', '会议'],
}
const AXIS_KEYS = Object.keys(AXES)
const localEmbed: Embedder = async (texts) =>
  texts.map((t) => AXIS_KEYS.map((axis) => (AXES[axis]!.some((kw) => t.includes(kw)) ? 1 : 0)))

// --- self-assert helpers -------------------------------------------------------

let checks = 0
function assert(cond: boolean, msg: string): void {
  checks++
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
function ids(rows: MemoryEntry[]): string[] {
  return rows.map((e) => e.id)
}

async function main(): Promise<void> {
  console.log('butler-vector-recall — semantic recall, two ways (hermetic, deterministic)\n')

  const seed = [
    entry('tea', '我在经营一家卖奶茶的小店', 100, { importance: 4 }),
    entry('coffee', '早上习惯先来一杯拿铁咖啡', 200),
    entry('ball', '周末喜欢打篮球放松', 300),
    entry('proj', '正在做一个叫 AipeHub 的项目', 400, { importance: 5 }),
  ]

  // === Scene 1: embeddingRetriever (local embed + in-frame cosine) ============
  console.log('Scene 1 — embeddingRetriever (local embed + cosine)')
  const mem1 = inMemoryHandle(seed)
  const semantic: MemoryRetriever = embeddingRetriever({ memory: mem1, embed: localEmbed })

  const q = '饮料' //  "beverage" — shares NO characters with 奶茶 / 咖啡 / 拿铁
  const sem = await semantic.retrieve({ text: q, k: 5 })
  console.log(`  query 「${q}」 → [${ids(sem).join(', ')}]`)
  assert(
    ids(sem).sort().join(',') === 'coffee,tea',
    'embeddingRetriever surfaces the drink entries for 「饮料」',
  )
  assert(!ids(sem).includes('ball'), 'the orthogonal sport entry is dropped')

  // Contrast: lexical overlap (C-M2) scores 饮料-vs-奶茶 at 0 → finds nothing.
  const lex = await lexicalRetriever(mem1).retrieve({ text: q, k: 5 })
  console.log(`  lexicalRetriever 「${q}」 → [${ids(lex).join(', ')}]  (zero char overlap)`)
  assert(lex.length === 0, 'lexical overlap finds nothing for 「饮料」 — this is the gap C closes')

  // === Scene 2: chromaRetriever (the chroma-mcp seam) =========================
  console.log('\nScene 2 — chromaRetriever (chroma-mcp seam; store ranks server-side)')
  // A hermetic stand-in for chroma-mcp: embed + cosine over the seed, so the demo
  // is deterministic without a server. In prod this injected fn forwards to the
  // chroma-mcp tool call (see chroma-retriever.ts PRODUCTION_WIRING_DOC).
  const fakeChroma: ChromaQuery = async ({ text, k, kinds }) => {
    const pool = kinds && kinds.length > 0 ? seed.filter((e) => kinds.includes(e.kind)) : seed
    const [qv, ...cvs] = await localEmbed([text, ...pool.map((e) => e.text)])
    return pool
      .map((e, i) => ({ e, s: cosineSimilarity(qv!, cvs[i] ?? []) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, k)
      .map((x) => x.e)
  }
  const viaChroma = chromaRetriever({ query: fakeChroma })
  const cr = await viaChroma.retrieve({ text: q, k: 5 })
  console.log(`  query 「${q}」 via chroma → [${ids(cr).join(', ')}]`)
  assert(
    ids(cr).sort().join(',') === 'coffee,tea',
    'chromaRetriever finds the same semantic hits through the MCP seam',
  )
  const crKind = await viaChroma.retrieve({ text: q, kinds: ['episodic'], k: 5 })
  assert(crKind.length === 0, 'kinds filter passes through (no episodic seeds → empty)')
  const crEmpty = await viaChroma.retrieve({ k: 5 })
  assert(crEmpty.length === 0, 'empty query → semantic search path returns nothing (by design)')

  // === Scene 3: parity — no-query recall is importance-then-recency ==========
  console.log('\nScene 3 — parity (no query → importance-then-recency, like the others)')
  const none = await semantic.retrieve({ k: 5 })
  console.log(`  no query → [${ids(none).join(', ')}]`)
  // proj(importance 5) then tea(importance 4), then the rest newest-first.
  assert(ids(none).join(',') === 'proj,tea,ball,coffee', 'no-query order is importance, then recency')

  console.log(`\nOK — ${checks} assertions passed.`)
  console.log('The framework computed no vectors: the embedder (Scene 1) and the')
  console.log('vector store (Scene 2) were injected. See chroma-retriever.ts for the')
  console.log('production chroma-mcp wiring, and docs/zh/ledger/MEMORY-ADVANCED-FINAL.md.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
