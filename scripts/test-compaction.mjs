/**
 * Smoke test for M2 auto-compaction.
 *
 * Builds a fake MemoryHandle preloaded with 40 episodic entries
 * (above the 32-entry trigger) + a prior compacted-summary, then
 * calls maybeCompactMemory with a stub summarizer. Verifies:
 *
 *   1. The trigger fires.
 *   2. The summarizer is called once with the system + user prompt.
 *   3. The new summary is written as kind='semantic', topic='compacted-summary'.
 *   4. The kept-recent N stay, the rest get forgotten.
 *   5. The prior compacted-summary is also forgotten (folded in).
 */

import { maybeCompactMemory, COMPACT_KEEP_RECENT } from '../packages/host/dist/services/personal-growth-context.js'

const FORGOTTEN = Symbol('forgotten')

const makeMemory = (initial) => {
  let nextId = 1
  const store = initial.map((e) => ({
    ...e,
    id: e.id ?? 'seed-' + (nextId++),
    ts: e.ts ?? nextId * 1000,
  }))
  return {
    async recall(query) {
      const kinds = new Set(query?.kinds ?? ['episodic', 'semantic', 'working'])
      return store
        .filter((e) => e !== FORGOTTEN && kinds.has(e.kind))
        .sort((a, b) => b.ts - a.ts)
    },
    async remember(e) {
      const persisted = { ...e, id: 'new-' + nextId++, ts: Date.now() + nextId }
      store.push(persisted)
      return persisted
    },
    async list() { return store.filter((e) => e !== FORGOTTEN) },
    async forget(id) {
      const i = store.findIndex((e) => e !== FORGOTTEN && e.id === id)
      if (i >= 0) store[i] = FORGOTTEN
    },
    async clear() { store.length = 0 },
    _store: store,
  }
}

let failures = 0
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  -- ' + detail : ''))
  if (!ok) failures++
}

const caseId = 'self'
const initial = []
// 40 episodic entries for caseId='self'
for (let i = 0; i < 40; i++) {
  initial.push({
    kind: 'episodic',
    text: 'old body entry #' + i,
    meta: { caseId, topic: i % 2 === 0 ? 'body' : 'mind', at: new Date(2026, 0, i + 1).toISOString() },
    id: 'old-' + i,
    ts: 1_000_000 + i * 10,
  })
}
// Prior compacted summary that should get folded in & forgotten
initial.push({
  kind: 'semantic',
  text: 'PRIOR compacted summary text (earlier context)',
  meta: { caseId, topic: 'compacted-summary', at: '2025-12-31T00:00:00Z' },
  id: 'prior-summary',
  ts: 900_000,
})

const memory = makeMemory(initial)
const binding = { caseId, memory }

let summarizeCalls = 0
let lastSystem = ''
let lastUser = ''
const result = await maybeCompactMemory(binding, async ({ system, user }) => {
  summarizeCalls++
  lastSystem = system
  lastUser = user
  return '## 已经过去的对话浓缩 (截至 2026-05-22)\n\n用户在身体和心理两条线上有持续的拖延循环……(stub)'
})

check('compaction triggered', result !== null, result === null ? 'maybeCompactMemory returned null' : 'ok')
check('summarizer called exactly once', summarizeCalls === 1, `got ${summarizeCalls}`)
check('system prompt mentions 记忆压缩师', /记忆压缩/.test(lastSystem))
check('user prompt includes prior summary', /更早的背景/.test(lastUser) && /PRIOR compacted/.test(lastUser))
check('user prompt includes new entries', /新增 \d+ 条对话历史/.test(lastUser))
check('user prompt notes kept-recent', /最近 \d+ 条对话以原文继续/.test(lastUser))

check(`compactedCount = 40 - ${COMPACT_KEEP_RECENT}`,
  result?.compactedCount === 40 - COMPACT_KEEP_RECENT,
  `got ${result?.compactedCount}`)
check('absorbedSummaries = 1', result?.absorbedSummaries === 1, `got ${result?.absorbedSummaries}`)
check('summary entry has topic compacted-summary',
  result?.summaryEntry?.topic === 'compacted-summary',
  `got ${result?.summaryEntry?.topic}`)

const alive = memory._store.filter((e) => e !== FORGOTTEN)
const aliveEpisodic = alive.filter((e) => e.kind === 'episodic')
const aliveSemantic = alive.filter((e) => e.kind === 'semantic')
check(`${COMPACT_KEEP_RECENT} most recent episodic kept`,
  aliveEpisodic.length === COMPACT_KEEP_RECENT,
  `got ${aliveEpisodic.length}`)
check('exactly 1 semantic entry (new summary, old gone)',
  aliveSemantic.length === 1,
  `got ${aliveSemantic.length}`)
check('the new summary is the surviving semantic',
  aliveSemantic[0]?.text?.startsWith('## 已经过去的对话浓缩'),
  `got ${aliveSemantic[0]?.text?.slice(0,40)}`)

console.log('')
if (failures === 0) {
  console.log('ALL PASS — M2 compaction path works as designed')
  process.exit(0)
} else {
  console.log(`FAILED — ${failures} assertion(s)`)
  process.exit(1)
}
