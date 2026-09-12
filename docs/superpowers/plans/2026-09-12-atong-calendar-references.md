# Atong Calendar References Implementation Plan

Direction: M. Implements the calendar-expression step of the approved temporal-memory design; no history backfill, deployment, event-identity inference or M3 budget/retrieval work.

**Goal:** Anchor supported Chinese calendar phrases to the original server-local date and preserve the interpretation across compaction and recall.

**Architecture:** A bounded pure calendar module uses native Gregorian Date arithmetic and Intl only to obtain the original server-local date. Capture persists versioned phrase offsets and half-open calendar ranges. Evidence packing carries these alongside the original quote and clock; reading validates existing metadata but never synthesizes it for old entries. These are conditional interpretations of date phrases relative to the original turn, not proof that an event happened, and not inferred relationships between clauses.

**Contract:** At most four references per quote; extra references explicitly marked omitted. Support 今天/昨天/前天/明天/后天 and 本周/这周/上周/上上周/下周/下下周, plus explicit YYYY-MM-DD and YYYY年M月D日. Weeks start Monday; end dates are exclusive. Unsupported precision/composite expressions remain unparsed, missing clocks keep relative references unknown, invalid dates never roll into another month. No general natural-language parser and no new dependency or model call.

## Task: Calendar Grounding and Evidence Preservation

- [x] Write `packages/personal-memory/tests/calendar.test.ts`: verify Sep 11 上上周 is [Aug 24, Aug 31), local midnight, year/leap/DST boundaries, unknown clock, invalid date, supported phrase limits and corruption rejection. Run red before implementation.
- [x] Add `src/calendar.ts`: `captureCalendar(text, temporal)`, `calendarOf(raw,text,temporal)`, `formatCalendar(calendar,text)`. Metadata v1 contains bounded spans/ranges and overflow; fixed rule semantics and exact metadata validation.
- [x] Add integration tests in `tests/calendar-evidence.test.ts` covering new capture, old spans untouched, static metadata spoofing, two compaction generations, atomic selection, frozen/recall byte-stability under a later clock/changed process timezone, fixed body caps and saved-evidence mismatch retention.
- [x] Wire capture/evidence/atomic prompt to the module without changing the existing storage or context caps. Keep calendar metadata within the existing whole-entry packing byte cap; if it cannot fit retain original sources.
- [x] Run full memory/butler/host suites, affected builds, whole-workspace typecheck and architecture/memory gates. Independent review, fix findings with regressions, update status docs and local direction-M ledger, then commit explicitly listed files locally.

Example oracle:
```ts
const clock = observeTurnTime(Date.parse('2026-09-11T12:00:00Z'), 'Asia/Shanghai')
expect(captureCalendar('我上上周吃过烤肉', clock)?.references[0]?.range)
  .toEqual({ start: '2026-08-24', end: '2026-08-31', precision: 'week' })
expect(calendarOf(undefined, '我上上周吃过烤肉', clock)).toBeUndefined()
```

Remaining: explicit event extraction/correction links and ambiguous phrase semantics; M3 time-query retrieval and shared token budget. No real-model accuracy claims from deterministic mechanism tests.

## Verification

- memory 704 / butler 418 / host 3511 passed; 5 existing host skips. Whole-workspace typecheck, affected builds, guards and memory write/recall gates passed.
- Added 41 date/evidence cases and one host capture-to-new-session prompt case. Labels share existing caps; duplicate clock labels removed after a red test.
- Review caught lexical/composite false positives (去年今天, 后天性疾病); conservative skip guards and positive controls passed re-review.
- A host full run stalled and was terminated without counting it as a pass. Full rerun via `pnpm -C packages/host exec vitest run --reporter=verbose --maxWorkers=4` passed in 23.28s. Cause not established; no unrelated production changes.
- No production credentials, historical data or live model accessed; no push/deploy.
