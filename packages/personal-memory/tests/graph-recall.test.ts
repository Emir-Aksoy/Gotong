/**
 * graph-recall.test.ts — the M-GRAPH ruler graduation (entity-bridge multi-hop).
 *
 * M-EMB1 filled the CLEAN-synonym gap (饮料 ↔ 珍珠奶茶) with a real embedder. But a
 * whole class of question stays out of reach of ANY single-fact ranker — keyword OR
 * embedder: the answer lives in a SECOND fact that shares no term with the query and
 * is only reachable THROUGH a first fact. Ask 「妈妈住哪」:
 *
 *   A 「我妈妈是玛丽」        ← the query hits this (妈妈)
 *   B 「玛丽在槟城买了房子」  ← the ANSWER (住址=槟城), zero query overlap
 *
 * A and B share the ENTITY 玛丽, not the query. So recall on 「妈妈住哪」 returns A and
 * stops — B is one associative hop away, invisible to a ranker that scores each fact
 * against the query in isolation. This is exactly what the dormant link graph solves,
 * and this test is the end-to-end proof that M-GRAPH wires it live:
 *
 *   1. the real WRITE reviewer (`linkReviewer` → `buildLinkGraph`) discovers A↔B from
 *      scratch (no pre-seeded links — unlike toolset.test's E-M3 unit),
 *   2. the real READ path (`MemoryToolset` recall + one-hop expansion) then surfaces B,
 *   3. while the M-EMB1 production default (fused keyword + local embedder, NO links)
 *      cannot reach B at all — naming exactly the gap graph mode fills.
 */
import { describe, expect, it } from 'vitest'

import {
  buildInvertedIndex,
  fusedRetriever,
  linkReviewer,
  linksOf,
  localBigramEmbedder,
  MemoryToolset,
  type MemoryLinkWriter,
  type MemoryRetriever,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const NOW = 1_700_000_000_000

/** The entity-bridge corpus: A→B via the shared entity 玛丽; distractors share nothing. */
function bridgeMemory() {
  return makeFakeMemory([
    entry('A', 'semantic', '我妈妈是玛丽', NOW - 5000),
    entry('B', 'semantic', '玛丽在槟城买了房子', NOW - 4000),
    entry('d1', 'semantic', '今天下午三点要开会', NOW - 3000),
    entry('d2', 'semantic', '记得周末去超市买牛奶', NOW - 2000),
    entry('d3', 'semantic', '手机壳该换一个新的了', NOW - 1000),
  ])
}

/** A patchMeta-backed link writer, mirroring the host's `butlerMemoryWriters().linkWriter`. */
const linkWriterOver = (mem: ReturnType<typeof bridgeMemory>): MemoryLinkWriter => (updates) =>
  Promise.all(updates.map((u) => mem.patchMeta!(u.id, { links: u.links }))).then(() => undefined)

/** A by-id lookup over the store, mirroring the host's `recallIndex.lookupByIds`. */
const lookupOver = (mem: ReturnType<typeof bridgeMemory>) => (ids: readonly string[]) =>
  ids.map((id) => mem.entries.find((e) => e.id === id)).filter((e): e is NonNullable<typeof e> => !!e)

/** Fused recall over the CURRENT store state — the M-EMB1 production default (local embedder). */
function fusedOver(mem: ReturnType<typeof bridgeMemory>): MemoryRetriever {
  return fusedRetriever(buildInvertedIndex([...mem.entries]), {
    activeOnly: true,
    now: () => NOW,
    embed: localBigramEmbedder(),
  })
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0]!.text

describe('M-GRAPH — associative links bridge an entity that ranking alone cannot', () => {
  it('WRITE: linkReviewer discovers A↔B from scratch (shared 玛丽), not the distractors', async () => {
    const mem = bridgeMemory()
    const review = linkReviewer({ write: linkWriterOver(mem) })
    const out = await review({ memory: mem, episodic: [], now: NOW })

    // The pass grew links (A and B), so it reports them — not an idle HEARTBEAT_OK.
    expect(out.summary).toMatch(/linked: 2/)
    const links = (id: string) => linksOf(mem.entries.find((e) => e.id === id)!)
    expect(links('A')).toContain('B') // bidirectional: A points at its bridge B
    expect(links('B')).toContain('A')
    // The distractors share no term with anything, so they stay unlinked.
    expect(links('d1')).toEqual([])
    expect(links('d2')).toEqual([])
  })

  it('READ gap: fused recall (keyword + local embedder) returns A but NOT the bridge answer B', async () => {
    const mem = bridgeMemory()
    // No links, no expansion — the exact M-EMB1 production default.
    const ts = new MemoryToolset({ memory: mem, retriever: fusedOver(mem) })
    const out = textOf(await ts.callTool('recall', { query: '妈妈住哪' }))
    expect(out).toContain('[A]') // the query-matching fact is found
    expect(out).not.toContain('[B]') // …but the answer, one hop away, is not
    expect(out).not.toContain('槟城')
  })

  it('READ solved: after linking, the SAME query surfaces B via one-hop expansion (↪)', async () => {
    const mem = bridgeMemory()
    // Write side first (as the 6h sweep would), then read with the graph-mode wiring.
    await linkReviewer({ write: linkWriterOver(mem) })({ memory: mem, episodic: [], now: NOW })
    const ts = new MemoryToolset({
      memory: mem,
      retriever: fusedOver(mem), // seeds now carry meta.links written above
      linkLookup: lookupOver(mem),
      expandK: 5,
    })
    const out = textOf(await ts.callTool('recall', { query: '妈妈住哪' }))
    expect(out).toContain('[A]') // still the seed
    expect(out).toContain('↪ [B]') // the bridge answer, surfaced by association
    expect(out).toContain('槟城') // …carrying the actual address
    expect(out).not.toContain('[d1]') // distractors never linked, never surfaced
  })

  it('OFF is byte-identical: with links present but no linkLookup, recall never expands', async () => {
    const mem = bridgeMemory()
    await linkReviewer({ write: linkWriterOver(mem) })({ memory: mem, episodic: [], now: NOW })
    // Graph mode off ⇒ the butler omits linkLookup ⇒ the written links are inert on recall.
    const ts = new MemoryToolset({ memory: mem, retriever: fusedOver(mem) })
    const out = textOf(await ts.callTool('recall', { query: '妈妈住哪' }))
    expect(out).not.toContain('↪')
    expect(out).not.toContain('[B]')
  })
})
