# Atong Evidence-First Memory Implementation Plan

Development plan, 2026-09-21. Kept in the tracked documentation tree.

> For agentic workers: execute sequentially with `executing-plans`; use regression-first development and verify each delivery.

**Direction:** M

**Goal:** Make existing memory layers reliably searchable and progressively readable without an unbounded context or a new memory subsystem.

**Architecture:** Keep file stores authoritative. Reuse the existing scoped recall index and cross-store net. Preserve original evidence separately from search text; apply validity and query filters before ranking. Explicit full scans serve maintenance, never interactive UI lists. Search returns bounded clues; source expansion revalidates current content and has a fixed output budget.

**Tech Stack:** TypeScript, pnpm, Vitest; existing personal-memory, personal-butler, service-memory-file and host packages.

## Boundaries

- No new LLM planner, memory tier, database, embedding dependency or production knob.
- No historical memory backfill, production data changes, GitHub push or server deployment.
- Do not resume unfinished temporal-memory deletion/correction infrastructure.
- Ordinary assistant-generated notes must not masquerade as user-confirmed semantic evidence.
- Retrieval scores indicate ranking, not factual confidence; missing evidence remains missing.

## Tasks

- [x] 1. Repair retrieval consistency: original evidence/time in memory sheets, current validity by default, filtering before top-k including neighbors. Regressions in personal-butler and personal-memory tests.
- [x] 2. Add explicit complete scans for the file backend and maintenance/export callers; separate storage cooling from semantic validity. Test >500 records and cold-but-still-true facts.
- [x] 3. Add scoped cross-store search and version-checked source reading with fixed byte budgets, source IDs and deduplication; wire into the native Atong agent. Protect semantic writes with trusted user evidence rather than model-declared provenance.
- [x] 4. Run focused and package regressions, type checks and architecture guards; document delivered behavior and remaining limitations. Commit each independently verified increment with direction M. Evidence: `releases/2026-09-21-evidence-first-memory.md`.

## Acceptance

- The original turn and calendar reference survive capture, consolidation and both retrieval paths; a later file write is never presented as the event date.
- An expired matching record cannot starve a valid result, and tier/form filters cannot lose a valid lower-ranked result before selection.
- All 501+ records participate in supported complete scans; UI list limits remain unchanged.
- Cooling does not write `validTo`; cold facts remain retrievable until actual budget eviction.
- Source reads refuse changed/deleted/inaccessible references and never accept arbitrary filesystem paths or another user's scope.
- Tool outputs and automatic clues are bounded, deduplicated and truthful about truncation; no extra model call is needed.
- Tests use synthetic data only; final report states exactly what was verified and whether anything remains incomplete.
