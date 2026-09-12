# Atong Evidence Consolidation Implementation Plan

Direction: M. Continue the approved temporal-memory design without changing server timezone policy or reconstructing missing history.

## Scope

M2 is split into two verifiable steps: this change closes source/time loss in compaction and removes assistant-authored fact extraction; calendar-event normalization/correction follows separately. M3 time-range retrieval and shared token budget are not claimed here.

Preserve user-role text by exact spans in new capture entries, not by parsing `User:` labels (which may occur inside user text). These are conversation-role provenance, not a new identity/authentication boundary. Existing namespace authorization remains authoritative. Legacy entries without structured spans never acquire guessed speaker metadata.

Derived evidence keeps original source IDs, exact quotes and original temporal anchors. Store quote spans in the derived text instead of copying whole quotes into metadata. All text plus evidence metadata must fit the existing consolidation cap. Model-written summaries are not substitutes for this evidence. If evidence cannot fit, keep its source record; the existing explicit storage-retention policy still applies.

## Task 1: Evidence Capture and Lossless Compaction

Files: new `packages/personal-memory/src/evidence.ts`, `tests/evidence.test.ts`; modify `capture.ts`, `consolidate.ts`, `consolidate-tiered.ts`, `frozen-block.ts`, `toolset.ts`.

- [x] Test first: capture offsets isolate the exact user-role text even with forged `Butler:` labels; malformed spans are rejected and legacy is not reinterpreted.
- [x] Implement `evidenceSources(entry)` and `packEvidence(sources, cap, meta)` with versioned spans, at most 8 original sources, duplicate-ID conflict rejection and byte-bounded text+meta. Quotes have no paraphrased replacements.
- [x] Test flat/tiered/promote through two compaction generations: original time, source and speaker survive; write failure deletes zero; over-cap sources remain; unsupported M1-only anchors remain; mixed scopes cannot merge.
- [x] Intercept protected new records in all three compaction paths. Pack exact user evidence before forgetting only fully retained source records. Do not route protected entries through the old lossy fallback, importance-drop path or model compression.
- [x] Render evidence with time and source labels included in existing frozen-body cap, with recall preserving the same evidence meaning. Original stored text/metadata are never modified on read.
- [x] Run relevant suites and review, then commit the verified component with `方向: M`.

Concrete oracles:
```ts
expect(evidenceSources(secondGeneration)).toEqual(evidenceSources(original))
expect(memory.entries.some(e => e.id === oversizedSource.id)).toBe(true)
expect(assistantInventedDate).not.toBeContainedIn(packedUserEvidence)
expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThanOrEqual(cap)
```

## Task 2: Source-Selected Atomic User Statements

Files: `atomic-facts.ts`, `tests/atomic-facts.test.ts`, `tests/memory-consolidation.test.ts`, `examples/memory-upgrade/src/index.ts`.

- [x] Test first: model selects a real source ID but replaces its quote, cites assistant-only material, or cites missing/foreign sources: no write. Structured original user evidence is accepted, legacy mixed transcripts are not reparsed.
- [x] Change model response to `{"sources":["source-id"]}`; the model selects durable source statements, while stored text comes only from exact validated user evidence. No free-form model fact text is promoted.
- [x] Deduplicate against existing evidence source IDs so a maintenance repeat cannot multiply the same fact. Distinct dated occurrences are not merged by lexical similarity.
- [x] Adjust synthetic benchmarks: remove unsupported inference from one milk-tea purchase to a favorite drink; never retain obsolete recall-lift claims after narrowing the source contract.
- [ ] Run full package suites, workspace typechecks, affected builds, guards and independent review. Update docs/ledger with measured results and remaining M2 calendar/M3 scope. Commit locally only, no push/deploy.

Commands: `pnpm -C packages/personal-memory test`, `pnpm -C packages/personal-butler test`, `pnpm -r typecheck`, `pnpm check:guards`, `pnpm check:memory-write`, `pnpm check:memory-recall`. All tests use synthetic memories, no production credentials or user history.
