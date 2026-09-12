# Atong Temporal Memory Implementation Plan

**Goal:** Preserve server-time anchors without reconstructing historical events; implement one independently testable milestone at a time (direction M).

**Architecture:** Reuse MemoryEntry.meta and the existing session window. Distinguish a locally observed turn-start time from write time and from an event time. Never trust payload-provided timestamps or infer an event date solely from a storage timestamp. No new global knobs, storage backends or production changes.

**Tech Stack:** TypeScript ESM, Intl.DateTimeFormat, Vitest, existing file-backed memory.

## M1: Preserve New Time Anchors and Render Them Honestly

- [x] Add `packages/personal-memory/src/temporal.ts` plus `tests/temporal.test.ts`: versioned `{v:1, observedAt, timeZone, basis:'turn-start'}` metadata, strict readers, deterministic server-local timestamp labels and UTC fallback. No event-time inference. Legacy records remain unmodified.
- [x] Extend `capture.ts` and `agent.ts` with a local clock snapshot before a new task starts. Pass the snapshot explicitly into capture; overwrite any conflicting extra metadata. Resume without a persisted original anchor must not invent one. Add injected-clock tests covering midnight, long replies and spoofed payload values.
- [x] Make `novelty.ts` refuse lexical folding when either candidate carries a new temporal envelope. New timed turns remain distinct, including identical statements on different dates. Preserve the old gate for legacy/no-anchor callers; do not backfill old records. Test both directions and unchanged legacy folding.
- [x] Update frozen-block and recall labels to distinguish turn observation from memory write time. Frozen-block labels count within its existing body cap; oversized timed entries are omitted whole. Recall retains its existing tool-output controls; unified token budgeting remains M3. Legacy text remains readable without invented event dates.
- [x] Update the personal-butler session window to persist server timeZone on new records, retain it through rendering and bound timestamp+body together. Old records with no zone are not rewritten to acquire one. Tests cover mixed legacy/new windows and same-role merge.
- [x] Run affected suites, package typechecks/build, guards and independent review; update milestone documentation. M1 is ready for local commit only, with no push/deploy.

### Concrete Regression Oracles

```ts
expect(renderFrozenBlock([earlier])).not.toBe(renderFrozenBlock([later]))
expect(foldedNewTimedTurn).toBe(false)
expect(captured.meta.temporal.observedAt).toBe(turnStartBeforeReply)
expect(JSON.stringify(legacyBefore)).toBe(JSON.stringify(legacyAfter))
expect(renderedTimedBody.length).toBeLessThanOrEqual(originalBodyCap)
```

Run `pnpm -C packages/personal-memory exec vitest run tests/temporal.test.ts tests/time-capture.test.ts tests/capture.test.ts tests/agent.test.ts tests/agent-capture.test.ts tests/novelty.test.ts tests/frozen-block.test.ts tests/toolset.test.ts` before and after the implementation. New assertions must first fail for the missing behavior. Run the complete personal-memory and personal-butler suites before committing.

### M1 Verification Record

- `personal-memory`: 596 passed; `personal-butler`: 418 passed, including 43 session-window tests.
- `host`: 3509 passed, 5 skipped. The first sandboxed run failed on local `listen EPERM`; a separately reproduced pairing test confirmed the restriction, and the authorized local-port rerun passed.
- Workspace typecheck, both affected package builds, four structural guards, memory-write and memory-integration gates passed. No new environment knobs.
- Tests reproduced missing timestamps, erroneous lexical folding, label-budget overflow, resume fallback double capture, invalid persisted dates, and the incomplete UTC fallback before fixes. Concurrent resume/fresh calls are isolated.
- Independent review found the UTC fallback was lost on revalidation; fixed with an Intl-independent UTC validator/renderer and a capture-to-render regression test.
- No production model calls or user-history reads; no push/deploy. Temporal consolidation and unified context-token accounting remain M2/M3, not hidden completion claims.

## M2: Preserve Evidence Through Consolidation (Following M1)

Not complete merely because M1 passes: atomic-facts/consolidate/consolidate-tiered still need validated source references, user-only fact evidence, bounded event records, and safe delete-before/after invariants. Add relative-time normalization tied to original anchors (server zone), explicit correction handling and tests for missing source/unknown dates. No reconstruction of lost memories.

## M3: Time-Aware Retrieval and Unified Context Budget (Following M2)

Add event-time versus message-time query ranges and historical queries to existing retrieval surfaces, then deduplicate shared sources across prompt sections under an unchanged total token ceiling. Use the same model and fixtures for baseline comparison; report unknown dates and failure rates, not only successful examples.

This plan separates milestones to avoid calling time labels a completed event-memory system. M2/M3 need their own executable test-first plans once the M1 contract is verified.
