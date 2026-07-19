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
effect. STORE-M1 grew it into a **full storefront pack** — the five things a real
shop actually manages: **岗位知识 · 排班 / 请假 · 工资 (含临时工) · 库存 · 合规**.
The design write-up (positioning, the wage red line, honest boundaries) is
[`docs/zh/STOREFRONT-OPS.md`](../../docs/zh/STOREFRONT-OPS.md).

---

## The seven workflows

| Workflow | Trigger | Member self-service | Approval | Covers |
|---|---|---|---|---|
| `cafe-staff-onboarding` | `cafe.onboard-staff` | ✅ `/me` (scope `trainee_id`) | — | 新员工学到对应岗位的操作、规范 |
| `cafe-shift-availability` | `cafe.submit-availability` | ✅ `/me` (scope `staff_id`) | ✅ `human:` 店长确认 | 排班 |
| `cafe-overtime-claim` | `cafe.claim-overtime` | ✅ `/me` (scope `staff_id`) | ✅ `human:` 店长审批 | 加班费 (LLM 建议, 人定钱) |
| `cafe-leave-request` | `cafe.request-leave` | ✅ `/me` (scope `staff_id`) | ✅ `human:` 店长审批 | 请假 |
| `cafe-casual-wage` | `cafe.settle-casual-wage` | ✅ `/me` (owner/admin) | ✅ `human:` 老板审批 | 临时工工时结算 (LLM 建议, 人定钱) |
| `cafe-inventory-count` | `cafe.count-inventory` | ✅ `/me` | — (无人值守) | 库存盘点与预警 |
| `cafe-compliance-check` | `cafe.compliance-check` | ✅ `/me` | — (无人值守 + 每周定时) | 合规自查清单 |

Three agents serve every capability these workflows dispatch:

- **岗位培训师** (`onboarding-trainer`, cap `cafe.train-position`) — reads the
  store operations manual and walks a new hire through their position's SOP + norms.
- **运营助手** (`ops-assistant`, caps `cafe.overtime-policy` / `cafe.schedule-draft` /
  `cafe.leave-review` / `cafe.casual-wage`) — the human-affairs desk: suggests
  overtime & casual-worker wage amounts per policy (人定钱), drafts shift proposals,
  and reviews leave requests (flagging roster conflicts for manual check *if* a
  roster source is wired — honest mode just notes班表影响需人工核对).
- **库存合规助手** (`inventory-compliance-aide`, caps `cafe.inventory-review` /
  `cafe.compliance-check`) — outputs stock-count checklists (flagging below-safety
  items if an inventory source is wired) and compliance self-check lists. It only
  produces checklists — it never rules on compliance; people do.

The `human:` steps dispatch to `gotong.human/v1` — the host's inbox broker, a
built-in, **not** a template agent. The two unattended flows (inventory /
compliance) carry no `human:` step, so they enter the golden-run acceptance.

---

## The headline: overtime approval (HITL)

The money flow is the point. A worker **suggests** an amount per the store's
overtime policy; the manager **decides**. The multiplier is **situational**
(结合使用者的情况): the same overtime hours pay differently on a workday vs a
rest-day vs a public holiday. In the **runnable demo below** that worker is the
deterministic `assessOvertime` stand-in (`时薪 × 倍率 × 时长` arithmetic, no key);
in the **loadable template** it's the DeepSeek `ops-assistant`, whose figure is an
LLM **suggestion** per policy — either way, **the manager decides the money**.

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

The **same red line governs casual-worker wages** (`cafe-casual-wage`): the
assistant produces a **suggested** amount per policy (an LLM figure in the loadable
template — or arithmetic from a payroll MCP / the demo stand-in if you wire one),
flags possible anomalies (工时偏高 / 时薪偏低 → 提示人工核对当地法规), and a `record`
(结算单) step is `when`-gated on the owner's approval — **不批就不出结算单, 不发钱,
不写工资库, 不做劳动法裁定**. Final amount is always per your real payroll system.
See [`docs/zh/STOREFRONT-OPS.md`](../../docs/zh/STOREFRONT-OPS.md) §三.

> The runnable no-key demo (`src/index.ts`) exercises a **teaching subset**
> (onboarding + overtime). The loadable template ships all seven flows; the
> anti-corruption gate drives every one of them through the real `parseWorkflow`.

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
file carrying the whole working skeleton: 3 agents + 7 declarative workflows + an
addressable KB slot + **2 optional read-only connector slots** (inventory /
timesheet) + 2 golden-run acceptance cases + a person-less weekly schedule +
a one-click DeepSeek key prompt. Load it into a real host:

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
- ✅ **optional connector slots** (`inventory` / `timesheet`) — abstract read-only
  MCP needs, not pre-wired to any agent. The **system of record** for stateful
  business data (库存数 / 工时) is **your** external source — Gotong doesn't hold the
  authoritative ledger. (It's file-first, though: each run's form inputs, step
  outputs and approvals are still snapshotted to `.gotong/` as an audit trail —
  the master copy just isn't there.) Unplugged = honest mode (the flows still run,
  they just don't read real numbers).
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
- **Money is suggested, decided by the manager.** In this runnable demo the
  overtime amount is the deterministic stand-in's arithmetic; in the loadable
  template it's the assistant's LLM suggestion per policy. Both are always gated
  behind a human approval — "suggests, human decides money". Treat the suggested
  figure as a draft, not payroll truth.
- **Core + workflow + inbox only** — no host / identity / llm dependency. The
  runnable demo is intentionally small so the mechanism is legible.
