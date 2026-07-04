# @gotong/evals

Lightweight **structural** eval harness for Gotong workflows and agent
prompts. Pure functions, zero LLM calls, deterministic, microseconds per
check — runs in CI to catch prompt regressions before they ship.

## What this is

A collection of pure-function checkers that take an LLM output (or a
prompt file) and answer questions like:

- Does this output conform to the **three-segment contract** (TL;DR →
  body → confidence)? — see `checkers/three-segment`
- Does this output have all the **required markdown sections**, and
  none of the **forbidden phrases**? — see `checkers/structure`

Pair with `vitest` + golden inputs (or with snapshotted real LLM outputs
captured during E2E runs) to gate prompt changes.

## What this is NOT

- **Not an LLM judge.** We don't ask another model to grade outputs.
  That's a separate (more expensive) layer.
- **Not a runtime guardrail.** Checkers run in tests / CI, not in the
  hot path of a live workflow. (If you want runtime guardrails, the
  PG agent already enforces NEED_INPUT and three-segment markers in the
  prompt itself — failures degrade gracefully there.)
- **Not a quality benchmark.** Structural compliance ≠ semantic quality.
  Quality is the job of HITL approve steps and production telemetry.

## Why structural-only

Anthropic's [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
recommends starting with deterministic guardrails before reaching for
AI-graded evals. Structural checks are:

- **Zero-cost** (no API spend per CI run)
- **Fully deterministic** (no flakiness from LLM randomness)
- **Fast** (microseconds per check)
- **Sufficient to catch the most common regressions** — missing
  sections, wrong markers, dropped TL;DR, banned phrases creeping back

When/if Gotong needs semantic eval (e.g. "is this advice actually
useful?"), it goes in a separate package. This one stays focused.

## Usage

```ts
import { checkThreeSegmentContract } from '@gotong/evals/checkers/three-segment'
import { checkStructure } from '@gotong/evals/checkers/structure'

// Example: validate a body-coach output
const bodyCoachOutput = await readFile('fixture-body-coach-output.md', 'utf8')

const three = checkThreeSegmentContract(bodyCoachOutput, {
  openingHeading: '我的核心判断',
  closingHeading: '置信度与边界',
  maxOpeningBytes: 100,
  maxClosingBytes: 200,
})
if (!three.ok) {
  console.error('three-segment violations:', three.violations)
}

const struct = checkStructure(bodyCoachOutput, {
  requiredSections: [
    '我看到的身体基线',
    '三个最该关注的点',
    '我需要专业医生的边界',
  ],
  forbiddenPhrases: ['以下是', '您'],
  maxBytes: 8000,
})
```

## Layout

```
packages/evals/
├── src/
│   ├── index.ts                       # Re-exports
│   ├── checkers/
│   │   ├── three-segment.ts           # P0-1 contract
│   │   └── structure.ts               # Section presence + banned phrases
└── tests/
    ├── three-segment.test.ts          # Unit tests for the checker
    └── personal-growth-prompts-lint.test.ts  # Static lint of the 7 PG prompts
```

## Adding new checkers

Each checker is a pure function `check<Thing>(text, options) → { ok, violations }`.
Add the file under `src/checkers/`, re-export from `src/index.ts`, and add
unit tests under `tests/`. The package has no dependencies on `@gotong/core`
or any other workspace package — it's deliberately standalone so eval CI
can run in parallel with the main build.
