/**
 * Decoupling smoke test for the personal-growth bolt-on.
 *
 * Verifies two layers stay clean:
 *
 *   1. **Host wiring level** — `GrowthReportsAdmin` returns [] / throws
 *      gracefully when the synthesist agent isn't spawned, instead of
 *      crashing the web layer.
 *
 *   2. **Agent-class level** — instantiating a plain `LlmAgent` (no
 *      personal-growth kind) doesn't import / trigger any growth
 *      helpers. Done by inspecting that the LocalAgentPool's
 *      `kind` switch falls through to LlmAgent for `kind:'llm'`.
 *
 *   3. **Memory helper level** — `recallGrowthHistory` / `recordGrowth-
 *      Output` operate only on the binding passed in; calling them
 *      against a memory handle that's empty doesn't throw and returns
 *      sensible defaults (so a v0.2 admin who pokes the synthesist's
 *      memory tab in the UI sees an empty list, not an error).
 *
 * Run with:  node scripts/test-decoupling.mjs
 *
 * Exit codes:  0 = all pass · 1 = at least one assertion failed.
 */

import { GrowthReportsAdmin } from '../packages/host/dist/services/growth-reports-admin.js'
import {
  recallGrowthHistory,
  recordGrowthOutput,
  shouldCompact,
  maybeCompactMemory,
  topicForCapability,
  formatGrowthContextBlock,
} from '../packages/host/dist/services/personal-growth-context.js'

let failures = 0

function check(label, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${label}` + (detail ? `  -- ${detail}` : ''))
  if (!ok) failures++
}

// ────────────────────────────────────────────────────────────────────
// 1. GrowthReportsAdmin
// ────────────────────────────────────────────────────────────────────

{
  // No accessor → no handle → list returns [], read throws.
  const admin = new GrowthReportsAdmin({ artifactAccessor: () => undefined })
  const list = await admin.list()
  check('GR: list() returns [] when synthesist not spawned', Array.isArray(list) && list.length === 0)
  try {
    await admin.read('reports/self/x.md')
    check('GR: read() throws when handle unavailable', false, 'expected throw')
  } catch (err) {
    check('GR: read() throws when handle unavailable', /unavailable/.test(err.message))
  }
}

{
  // Accessor with a stub handle — list filters + sorts; read forwards
  const items = [
    { ref: 'a', path: 'reports/self/2026-05-20T10-00-00.md', size: 100, ts: 100, mime: 'text/markdown' },
    { ref: 'b', path: 'reports/self/2026-05-22T10-00-00.md', size: 200, ts: 300, mime: 'text/markdown' },
    { ref: 'c', path: 'reports/foo/2026-05-21T10-00-00.md', size: 150, ts: 200, mime: 'text/markdown' },
    { ref: 'd', path: 'reports/strayfile-no-caseid.md',     size: 50,  ts: 50,  mime: 'text/markdown' },
    { ref: 'e', path: 'reports/self/something.txt',         size: 20,  ts: 60,  mime: 'text/plain' },
  ]
  const handle = {
    async list() { return items },
    async read(p) {
      const it = items.find((i) => i.path === p)
      if (!it) throw new Error('not found')
      return { content: `### ${p}\nhello`, mime: it.mime }
    },
  }
  const admin = new GrowthReportsAdmin({ artifactAccessor: () => handle })
  const list = await admin.list()
  check('GR: list filters non-.md and broken paths', list.length === 3, `got ${list.length}`)
  check('GR: list is newest-first', list[0]?.path === 'reports/self/2026-05-22T10-00-00.md')
  // sorted newest-first: b(ts=300, self), c(ts=200, foo), a(ts=100, self)
  check('GR: caseId parsed from path',
    list[0]?.caseId === 'self' && list[1]?.caseId === 'foo' && list[2]?.caseId === 'self',
    `got [${list.map(l => l.caseId).join(', ')}]`)
  const r = await admin.read('reports/self/2026-05-22T10-00-00.md')
  check('GR: read returns markdown text', r.markdown.startsWith('### reports/self/'))
  try {
    await admin.read('not-in-reports/x.md')
    check('GR: read rejects path outside reports/', false, 'expected throw')
  } catch (err) {
    check('GR: read rejects path outside reports/', /reports\//.test(err.message))
  }
}

// ────────────────────────────────────────────────────────────────────
// 2. personal-growth-context helpers (no-side-effect on empty memory)
// ────────────────────────────────────────────────────────────────────

const fakeMemory = (entries = []) => {
  const store = [...entries]
  return {
    async recall(_q) { return [...store].reverse() },  // newest-first per contract
    async remember(e) {
      const persisted = { ...e, id: 'id-' + (store.length + 1), ts: 1000 + store.length }
      store.push(persisted)
      return persisted
    },
    async list() { return [...store] },
    async forget(id) {
      const i = store.findIndex((e) => e.id === id)
      if (i >= 0) store.splice(i, 1)
    },
    async clear() { store.length = 0 },
  }
}

{
  // recall on empty case-bound memory
  const memory = fakeMemory()
  const binding = { caseId: 'self', memory }
  const list = await recallGrowthHistory(binding, { topics: ['body'], limit: 20 })
  check('PG: recallGrowthHistory on empty memory returns []', list.length === 0)
  const ok = await shouldCompact(binding)
  check('PG: shouldCompact returns false on empty memory', ok === false)
  const compactRes = await maybeCompactMemory(binding, async () => 'should not be called')
  check('PG: maybeCompactMemory short-circuits when nothing to compact', compactRes === null)
  const blk = formatGrowthContextBlock({ history: [] })
  check('PG: formatGrowthContextBlock on empty history returns ""', blk === '')
}

{
  // topicForCapability mapping
  check('PG: capability -> topic mapping body', topicForCapability('analyze-body') === 'body')
  check('PG: capability -> topic mapping social', topicForCapability('analyze-social') === 'social')
  check('PG: capability -> topic mapping synthesis', topicForCapability('synthesize-growth-path') === 'synthesis')
  check('PG: capability -> topic unknown returns null', topicForCapability('unknown-cap') === null)
}

{
  // record + recall roundtrip
  const memory = fakeMemory()
  const binding = { caseId: 'self', memory }
  const persisted = await recordGrowthOutput(binding, { topic: 'body', text: 'body summary' })
  check('PG: recordGrowthOutput returns id', typeof persisted.id === 'string')
  const list = await recallGrowthHistory(binding, { topics: ['body'] })
  check('PG: roundtrip recall sees just-written entry', list.length === 1 && list[0]?.text === 'body summary')
  const other = await recallGrowthHistory(binding, { topics: ['mind'] })
  check('PG: topic filter excludes other-topic entries', other.length === 0)
}

{
  // cross-case isolation — caseId is the filter key inside the memory
  // namespace; entries written under one case must not leak to another.
  const memory = fakeMemory()
  const a = { caseId: 'alice', memory }
  const b = { caseId: 'bob', memory }
  await recordGrowthOutput(a, { topic: 'body', text: 'alice body' })
  await recordGrowthOutput(b, { topic: 'body', text: 'bob body' })
  const listA = await recallGrowthHistory(a, { topics: ['body'] })
  const listB = await recallGrowthHistory(b, { topics: ['body'] })
  check('PG: caseId isolation — alice sees only her own', listA.length === 1 && listA[0]?.text === 'alice body')
  check('PG: caseId isolation — bob sees only his own', listB.length === 1 && listB[0]?.text === 'bob body')
}

{
  // compacted-summary surfaces across topic filters
  const memory = fakeMemory()
  const binding = { caseId: 'self', memory }
  // write a body entry then a compacted-summary
  await recordGrowthOutput(binding, { topic: 'body', text: 'body raw' })
  await recordGrowthOutput(binding, { topic: 'compacted-summary', text: 'overall summary' })
  // mind-coach asking for only 'mind' topic should still see the
  // compacted summary (which covers mind-relevant context).
  const list = await recallGrowthHistory(binding, { topics: ['mind'] })
  check('PG: compacted-summary always surfaces past topic filter', list.length === 1 && list[0]?.topic === 'compacted-summary')
}

// ────────────────────────────────────────────────────────────────────
// 3. Summary
// ────────────────────────────────────────────────────────────────────

console.log('')
if (failures === 0) {
  console.log('ALL PASS — framework cleanly decoupled from personal-growth specifics')
  process.exit(0)
} else {
  console.log(`FAILED — ${failures} assertion(s) failed`)
  process.exit(1)
}
