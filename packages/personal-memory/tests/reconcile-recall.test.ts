/**
 * reconcile-recall.test.ts — the M-RECON ruler graduation (stale-fact pollution).
 *
 * A long-lived butler accretes facts by blind `remember`, so when the user's life
 * CHANGES a fact the old and the new one sit side by side, both ACTIVE:
 *
 *   old 「我住在吉隆坡」  ← was true, never retracted
 *   new 「我住在槟城」    ← the CURRENT truth
 *
 * Ask 「我住哪」 and recall returns BOTH — the butler can't tell which city is
 * current, and may answer with the stale one. No retriever fixes this: keyword and
 * embedder each score a fact against the query in ISOLATION, and the stale fact
 * matches the residence query just as well as the current one. The cure is write-time
 * reconciliation — detect the contradiction and CLOSE the superseded fact's validity
 * interval, so the read side (which already filters `activeOnly`) stops surfacing it.
 * This test is the end-to-end proof that M-RECON wires that live:
 *
 *   1. the real `reconcile` pass (bitemporal mode) retires the old fact from a model
 *      decision by CLOSING it — never forgetting it (reversible history, not a
 *      destructive delete),
 *   2. the real production read path (fused keyword + local embedder, activeOnly) then
 *      surfaces only the current truth,
 *   3. while WITHOUT the pass both facts stay active and pollute recall — naming
 *      exactly the gap reconciliation fills.
 *
 * The summarizer here stands in for the model's contradiction judgment (a deterministic
 * fake, the same honest pattern `atomic-facts` / `reconcile` unit tests use): it proves
 * the WIRING + read-side gap given a correct decision, not the model's judgment quality.
 */
import { describe, expect, it } from 'vitest'

import {
  buildInvertedIndex,
  closedMeta,
  fusedRetriever,
  isActive,
  localBigramEmbedder,
  MemoryToolset,
  reconcile,
  validToOf,
  type MemoryRetriever,
  type MemoryValidityWriter,
  type ReconcileOp,
} from '../src/index.js'
import { entry, makeFakeMemory } from './fake-memory.js'

const NOW = 1_700_000_000_000

/** Two contradictory residence facts (both blind-`remember`'d, both active) + distractors. */
function movedMemory() {
  return makeFakeMemory([
    entry('old', 'semantic', '我住在吉隆坡', NOW - 5000),
    entry('new', 'semantic', '我住在槟城', NOW - 4000),
    entry('d1', 'semantic', '今天下午三点要开会', NOW - 3000),
    entry('d2', 'semantic', '记得周末去超市买牛奶', NOW - 2000),
  ])
}

/** A patchMeta-backed validity writer, mirroring the host's `butlerMemoryWriters().closeEntry`. */
const closeEntryOver =
  (mem: ReturnType<typeof movedMemory>): MemoryValidityWriter =>
  (e, validTo) =>
    mem.patchMeta!(e.id, closedMeta(undefined, validTo)).then(() => undefined)

/** A summarizer standing in for the model's contradiction judgment: retire the stale id. */
const retire = (id: string) => async () =>
  JSON.stringify({ ops: [{ op: 'delete', id }] as ReconcileOp[] })

/** Fused recall over the CURRENT store state — the M-EMB1 production default, activeOnly. */
function fusedOver(mem: ReturnType<typeof movedMemory>): MemoryRetriever {
  return fusedRetriever(buildInvertedIndex([...mem.entries]), {
    activeOnly: true,
    now: () => NOW,
    embed: localBigramEmbedder(),
  })
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0]!.text

async function reconcileMoved(mem: ReturnType<typeof movedMemory>) {
  return reconcile({
    memory: mem,
    summarize: retire('old'),
    bitemporal: true, // the wired posture: close intervals, never true-delete
    closeEntry: closeEntryOver(mem),
    now: () => NOW,
  })
}

describe('M-RECON — write-time reconciliation retires a stale fact that recall alone keeps surfacing', () => {
  it('READ gap: with both facts active, recall 「我住哪」 returns the stale 吉隆坡 alongside the current 槟城', async () => {
    const mem = movedMemory()
    const ts = new MemoryToolset({ memory: mem, retriever: fusedOver(mem) })
    const out = textOf(await ts.callTool('recall', { query: '我住哪' }))
    expect(out).toContain('槟城') // the current truth
    expect(out).toContain('吉隆坡') // …but the stale one pollutes it — the gap
  })

  it('WRITE: reconcile (bitemporal) CLOSES the stale fact instead of forgetting it (reversible)', async () => {
    const mem = movedMemory()
    const r = await reconcileMoved(mem)

    expect(r?.deleted).toBe(1)
    const old = mem.entries.find((e) => e.id === 'old')
    expect(old).toBeDefined() // NOT forgotten — the history survives on disk (reversible)
    expect(validToOf(old!)).toBe(NOW) // its validity interval was closed
    expect(isActive(old!, NOW)).toBe(false) // …so it drops out of the active slice
    expect(mem.entries.find((e) => e.id === 'new')).toBeDefined() // the current fact is untouched
  })

  it('READ solved: after reconciliation, the SAME query surfaces only the current 槟城', async () => {
    const mem = movedMemory()
    await reconcileMoved(mem)
    // Rebuild the read path over the post-reconcile state (as the next session would).
    const ts = new MemoryToolset({ memory: mem, retriever: fusedOver(mem) })
    const out = textOf(await ts.callTool('recall', { query: '我住哪' }))
    expect(out).toContain('槟城') // current truth still surfaces
    expect(out).not.toContain('吉隆坡') // …and the stale city no longer pollutes recall
  })
})
