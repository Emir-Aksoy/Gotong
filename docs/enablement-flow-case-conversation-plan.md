# Plan: bringing `industry-enablement-flow` onto case-conversation

The companion to `industry-consultation-flow.yaml` (which already
threads case-memory through every agent) is the
`industry-enablement-flow.yaml` workflow. As the yaml's own header
admits, **enablement-flow currently does not see case-memory** — its
six agents are plain `kind: llm` participants with no host glue.

This file is the design for closing that gap. It's a plan, not a
landed change — implementation lands in a follow-up PR scoped against
this doc.

---

## Why this isn't a one-line yaml edit

You can't just paste `uses: [memory, ...]` into the yaml and call it
done, because:

1. **Case scope is dynamic.** `industry-consultation-flow` reads
   `caseId` from the trigger payload and threads it through every
   step. The current enablement-flow yaml doesn't have a `caseId`
   contract — it only carries flat `industry / role / pain_points`
   fields. Without a per-run identifier you can't address a
   `workflow-run` owner, so memory writes have nowhere to land.
2. **LlmAgent doesn't auto-inject context.** Even with a memory
   handle attached at spawn, the agent has no codepath that
   prepends "## 当前 case 的已有上下文" into the system prompt. The
   consultation-flow examples do it by subclassing `LlmAgent` and
   overriding `buildRequest`; pure-yaml agents don't have that hook.
3. **Workflow runner needs the caseId.** `WorkflowRunner` substitutes
   `$trigger.payload.X` into step payloads. To put `caseId` everywhere
   it has to be declared on the trigger schema.

Each of the three is a small change individually; the plan below
sequences them so each step is independently testable.

---

## Step 1 — extend the trigger schema with `caseId`

Add a top-level `caseId` to the yaml's `trigger.payload`. New
contract:

```yaml
trigger:
  capability: enable-industry-with-ai
  payload:
    caseId: string             # NEW — per-run scope id, opaque
    industry: string
    role: string
    pain_points: string
    # … existing fields unchanged
```

Old callers that omit `caseId` get an auto-generated one
(`enablement-${nowMs}`) inside the workflow runner. That keeps every
existing example / test passing while making the field present for
downstream substitution.

Pass the id through to every step:

```yaml
- id: diagnose
  dispatch:
    payload:
      caseId: $trigger.payload.caseId       # NEW
      industry: $trigger.payload.industry
      role: $trigger.payload.role
      pain_points: $trigger.payload.pain_points
```

(repeated for `scan` / `tools` / `plan` / `concerns`).

---

## Step 2 — give each agent a `uses:` block

Each of the six agents in `traditional-industry-ai-enablement.yaml`
gains:

```yaml
uses:
  - type: memory
    impl: file
    owner: { kind: workflow-run, id: '*' }
```

Wildcard owner because the actual `caseId` is only known at task time.
This is the same pattern `industry-consultation-flow` already uses.

On the host, `LocalAgentPool` already supports `id: '*'` patterns for
v1.1 — it attaches a fresh handle the first time the agent calls
`memoryFor({ kind: 'workflow-run', id: <real id> })`. No host-side
code change.

---

## Step 3 — make LlmAgent honour `task.payload.caseId` automatically

This is the only real **code** change. Today every agent that wants
to read case context has to subclass `LlmAgent` (the
`industry-consultation-deepseek` example does this manually). For a
yaml-only workflow we need an opt-in flag.

Proposal: add an option to `LlmAgentOptions`:

```ts
export interface LlmAgentOptions extends AgentOptions {
  // … existing fields
  /**
   * When true (and the agent has a memory handle attached at
   * `workflow-run` scope), the base `buildRequest` prepends a
   * "## case 已有上下文" block to the system prompt for any task
   * whose payload carries a `caseId` field.
   *
   * Off by default to preserve backwards compatibility with v2.2
   * tests that count tokens.
   */
  autoInjectCaseContext?: boolean
}
```

Behaviour when `autoInjectCaseContext === true`:

1. Inside `buildRequest`, read `task.payload.caseId`.
2. Resolve the case-memory handle: `this.services.memoryFor?.('file',
   { kind: 'workflow-run', id: caseId })`. (Requires extending
   `ServiceCtx` with a factory; see below.)
3. Call `formatCaseContextBlock(caseMem, { maxConvEntries, maxStepEntries })`
   — already exists in `packages/host/src/services/case-context.ts`.
4. Prepend the result to `req.system`.
5. After `complete()` resolves, record the agent's output back into
   case-memory (mirror of what the consultation-flow examples do
   manually today).

### Sub-step 3a: extend ServiceCtx with a factory

```ts
export interface ServiceCtx {
  readonly memory?: MemoryHandle
  readonly artifact?: ArtifactHandle
  readonly datastore?: Readonly<Record<string, DatastoreHandle>>
  readonly extra?: Readonly<Record<string, unknown>>
  /**
   * Resolve a per-call memory handle for a dynamic owner. Only
   * populated when the agent's yaml declared a wildcard owner.
   * Returns undefined when no matching declaration exists.
   */
  readonly memoryFor?: (impl: string, owner: { kind: string; id: string }) => MemoryHandle | undefined
}
```

For in-process agents, `LocalAgentPool` wires this to a closure that
walks the `uses:` declarations, finds the matching wildcard, and
calls `HubServices.attach` lazily. Sidecar agents already have
`session.services.memoryFor(...)` from the v1.1 ServiceClient — the
public surface is identical.

### Sub-step 3b: write the output back

Inside `LlmAgent.handleTask`, after `complete()`:

```ts
if (this.opts.autoInjectCaseContext && task.payload?.caseId && this.services.memoryFor) {
  const caseMem = this.services.memoryFor('file', { kind: 'workflow-run', id: task.payload.caseId })
  await caseMem?.remember({
    kind: 'episodic',
    text: `step ${task.title ?? this.id}: ${response.text.slice(0, 400)}…`,
    meta: { agent: this.id, taskId: task.id },
  })
}
```

This is short enough to live in `LlmAgent` itself — no subclass
required for the enablement-flow's six agents.

---

## Step 4 — refresh system prompts

Each agent's `system` field in `traditional-industry-ai-enablement.yaml`
gains a one-paragraph note matching what consultation-flow already
uses:

```
读取规则：如果任务输入里有 `## 当前 case 的已有上下文`，请把那段
当作背景事实（不要重复），先承认其中已经定下的东西，再在新这一轮
里推进。
```

That's it. The auto-inject machinery handles the actual prepending;
the prompt just teaches the model what to do when it sees the block.

---

## Test plan

1. **Unit**: `packages/llm/tests/auto-inject-case.test.ts` — fake
   provider + spy on `req.system` to assert the case-context block
   appears when `autoInjectCaseContext:true` AND `caseId` is in the
   payload; absent otherwise.
2. **Integration**: `packages/host/tests/enablement-flow-case.test.ts`
   — fire the workflow twice with the same caseId, observe that
   step 2's prompt sees step 1's `step_output` entry.
3. **Smoke**: extend `industry-enablement-flow.yaml`'s metadata test
   to confirm every agent now carries the `uses:` block.

---

## Compatibility

Default for `autoInjectCaseContext` is `false`. Every existing
`LlmAgent`-based test passes unchanged. The yaml schema is
additive — older yamls without `uses:` still load; runner-level
`caseId` substitution falls back to the auto-generated id.

The only file that needs more than yaml edits is
`packages/llm/src/agent.ts` (Step 3 + 3b). Estimated change size:
~80 lines in `agent.ts`, ~120 lines spread across two yaml templates,
~150 lines of tests. Total scope: ~350 lines, one PR.

---

## Status

Plan only as of 2026-05. Implementation tracked under the v1.2
optimization roadmap; pick this up after the v1.1 audit / Python /
allowlist closure work is merged.
