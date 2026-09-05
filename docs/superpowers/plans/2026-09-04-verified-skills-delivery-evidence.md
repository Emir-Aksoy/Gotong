# Verified Skills and Delivery Evidence Implementation Plan

**Goal:** Deliver two independently testable enhancements: verified, versioned Atong experience skills (M+T), then reproducible evidence accompanying Gotong deliverables (C).

**Architecture:** Gotong is the network between agents and governs MCP/RAG calls. Atong is its highly adapted native agent, and the first consumer of the new facilities. Reuse procedural memory, maintenance providers, governed tool calls, exchange envelopes, member identity and signing. The Hub remains model-free. No new environment knobs or implicit data sharing.

**Tech Stack:** TypeScript ESM, pnpm, Vitest, existing file-backed memory, JCS/ES256 exchange envelopes.

## 1. Verified Experience Skills (M+T)

- [ ] Extend existing procedures with immutable candidate versions, source references, applicability and counterexamples; preserve prior revisions for rollback.
- [ ] Add a real evaluation path using independent member-defined holdout cases and a trusted runner. Compute verdicts from actual outputs; an agent-supplied `passed` flag never publishes a skill. Record the exact version, suite and model identity.
- [ ] Wire candidate/evaluate/publish/rollback into Atong. Automatic authors and refiners cannot inherit validation when content changes. Legacy procedures remain readable and explicitly unverified.
- [ ] Test failed evaluations, stale evidence, rollback, owner isolation and production wiring. Run affected package tests and typechecks before committing.

## 2. Reproducible Delivery Evidence (C)

- [ ] Define bounded declarative acceptance checks for an exchange request: JSON output selection with deterministic assertions, plus explicitly untested human checks. No arbitrary code, file reads or network requests from a received check.
- [ ] Bind result evidence to the delivered output and request/check fingerprints, record per-check verdicts and provenance; generate after output fitting so truncated output cannot retain a full-output pass.
- [ ] Integrate request validation, result generation/signing and receiver preview/reverification with the existing exchange flow. Sender signatures attest origin/integrity only; receiver recomputes supported checks and retains independent acceptance authority.
- [ ] Test pass/fail/untested, tampering, wrong request, missing output, truncation, limits, restart persistence and member isolation. Document a runnable request/result round-trip.
- [ ] Commit separately from skills.

## 3. Verification and Release

- [ ] Run `pnpm -r build`, `pnpm -r typecheck`, `pnpm check:guards`, affected package Vitest suites and `pnpm check:publish`.
- [ ] Review the implementation for spec coverage and code risks; resolve findings before release.
- [ ] Update direction ledger and current status: these two enhancements resume development; other parked directions remain parked.
- [ ] Fetch origin, verify fast-forward ancestry, merge to local main and push only main. Include the existing pause-snapshot docs commit.
- [ ] Confirm actual SSH/deployment target without reading credentials or `.env`; inspect deployed revision and dirty state, preserve a rollback point/data snapshot, deploy/build/restart only Gotong and verify revision plus health. Record any unresolved external blocker honestly.
