# cafe-ops — 门店运营 (奶茶 / 咖啡店) organization hub

> One of the 5 [hands-on hubs](../../docs/zh/HANDS-ON-HUBS.md) (3 personal + 2 org) — comparison catalog + the real DeepSeek/Obsidian go-live runbook.

The first **organization (team-mode) hub** case, and the first whose template
carries **declarative workflows**.

The three personal hubs (coding / research / battle-monk) orchestrate with a
runtime `DispatchToolset` (Phase 10), so their templates leave `workflows: []`
empty. An organization's value is its **formal processes** — so cafe-ops finally
fills `template.workflows[]` and exercises the two org capabilities those
processes lean on:

- **`surface.me`** (Phase 14) — a member runs a workflow *for themselves* from `/me`.
- **`human:`** (Phase 16) — a step that **parks** until a manager approves it.

Storefront type = 奶茶 / 咖啡店 (café / bubble-tea): broad, fast to grasp, real
effect. A new hire can learn their position's operations and norms; shifts and
overtime run through a proper "member submits → manager approves" flow.

---

## The three workflows

| Workflow | Trigger | Member self-service | Manager approval | Covers |
|---|---|---|---|---|
| `cafe-staff-onboarding` | `cafe.onboard-staff` | ✅ `/me` (scope `trainee_id`) | — | 新员工上手就能学到对应职位的操作、规范 |
| `cafe-shift-availability` | `cafe.submit-availability` | ✅ `/me` (scope `staff_id`) | ✅ `human:` 店长确认 | 管理排班 |
| `cafe-overtime-claim` | `cafe.claim-overtime` | ✅ `/me` (scope `staff_id`) | ✅ `human:` 店长审批 | 管理加班费 |

Two agents serve every capability these workflows dispatch:

- **岗位培训师** (`onboarding-trainer`, cap `cafe.train-position`) — reads the
  store operations manual and walks a new hire through their position's SOP + norms.
- **运营助手** (`ops-assistant`, caps `cafe.overtime-policy` + `cafe.schedule-draft`)
  — suggests an overtime amount per policy, and drafts a shift proposal from
  submitted availability.

The `human:` steps dispatch to `gotong.human/v1` — the host's inbox broker, a
built-in, **not** a template agent.

---

## The headline: overtime approval (HITL)

The money flow is the point. The assistant **suggests** an amount per the store's
overtime policy; the manager **decides**. Money math is deterministic — never an
LLM's job — and the multiplier is **situational** (结合使用者的情况): the same
overtime hours pay differently on a workday vs a rest-day vs a public holiday.

```
店员 /me 报加班 (3h, 日别=休息日/周末)
   │  dispatch cafe.claim-overtime
   ▼
[assess]  运营助手 → 建议金额  (¥22/h × 2 [休息日] × 3h = ¥132, 仅供参考)
   │       倍率随日别: 工作日 1.5 / 休息日 2 / 法定节假日 3
   ▼
[manager-approval]  human: → gotong.human/v1
   │  broker writes an inbox item for the manager, then SUSPENDS the run
   ▼
   ⏸  parked — not failed.  店长 /me 收件箱 sees one pending approval.
   │
   │  店长 approves
   ▼
   ▶  two-step resume (child broker, then parent workflow)
   ▼
run completes:  { hours: 3, suggestion: {...¥132, dayLabel: 休息日, multiplier: 2}, approval: { approved: true } }
```

`src/index.ts` runs exactly this end to end (deterministic, no API key) and
self-asserts every check, including a `[B2]` probe that the **same 3 hours** yield
¥99 / ¥132 / ¥198 across the three day kinds — proof the dispatch's worker fits the
staffer's situation, not a flat rate. The two-step resume (child broker strictly
before parent workflow) is hand-rolled in ~30 lines mirroring
`HostInboxService.resolve`, so the HITL mechanism is visible in example code, not
buried in the host.

---

## Run it

```bash
# the runnable demo — onboarding (no approval) + overtime (HITL suspend→approve→resume)
pnpm demo:cafe-ops

# preview the loadable template (config-preview; does not spawn mcp-obsidian)
pnpm demo:cafe-ops:template
```

The demo uses deterministic **stand-ins** (`src/standins.ts`) for the worker
capabilities so it runs with no API key. In the loadable template those become
KB-backed `LlmAgent`s on DeepSeek + mcp-obsidian — **same hub wiring**, swap and
nothing else changes.

---

## The loadable template

`template/cafe-ops.template.yaml` is one self-contained `gotong.template/v1`
file carrying the whole working skeleton: 2 agents + 3 declarative workflows + an
addressable KB slot + a one-click DeepSeek key prompt. Load it into a real host:

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H 'content-type: application/json' \
  -d "$(jq -Rs '{template: .}' examples/cafe-ops/template/cafe-ops.template.yaml)" \
  http://127.0.0.1:8745/api/admin/templates/import
```

### What ships in the template — and what doesn't

Following the Stream B decisions, the template carries **structure and
references, never content or personnel**:

- ✅ **agents** — config only (provider / model / system / MCP wiring); secrets
  ride as `${ENV}` placeholders, never literals.
- ✅ **workflows** — the declarative process definitions (dispatch graph,
  `surface.me`, `human:` gates, `governance` metadata).
- ✅ **KB slot** (`store_ops_manual`) — MCP wiring + a `presetData` **pointer**
  to a packaged manual snapshot. Imported = *reported*, never auto-wired
  (decision #4): you connect your own Obsidian vault to the slot.
- ❌ **the manual content** — your store operations manual (岗位 SOP / 规范 /
  加班政策 / 排班规则) is your own Obsidian vault behind mcp-obsidian.
- ❌ **personnel** — no owners / grants / members. Who works at your store is
  not part of a shareable architecture.

The web anti-corruption test (`packages/web/tests/cafe-ops-template.test.ts`)
reads this exact file through the real `parseTemplate`, runs **each** embedded
workflow block through the real `parseWorkflow`, and imports it end-to-end — so
the example can never silently drift out of sync with the schema.

---

## Notes / scope

- **Deterministic stand-ins, not LLMs.** The demo proves the *hub wiring* (a
  workflow dispatches a capability, a participant answers, a `human:` step
  suspends and resumes). It is not a model demo — `src/standins.ts` does real,
  assertable logic (position SOP lookup, overtime money math) so it runs offline.
- **Money is suggested by the assistant, decided by the manager.** The overtime
  amount is computed deterministically and always gated behind a human approval —
  "LLM suggests, human decides money". Treat the suggested figure as a draft, not
  payroll truth.
- **Core + workflow + inbox only** — no host / identity / llm dependency. The
  runnable demo is intentionally small so the mechanism is legible.
