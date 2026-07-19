# bar-ops — 酒吧运营 (bar / pub) organization hub

> The bar-flavored sibling of [`cafe-ops`](../cafe-ops) — same org mechanisms
> (declarative workflows + `surface.me` self-service + `human:` approval), tuned
> to what a **bar** actually manages. Design write-up:
> [`docs/zh/STOREFRONT-OPS.md`](../../docs/zh/STOREFRONT-OPS.md).

The second storefront pack in the **STORE** track. cafe-ops (奶茶 / 咖啡店) proves
the pattern; bar-ops shows the *same kernel* carries a business with a legally
different center of gravity.

A bar's headline difference from a café: **age-check / liquor-license compliance
is the legal high-voltage line** — one under-age sale and it's the liquor
license (the whole business) on the line. So the signature flow here isn't
overtime pay, it's an **age-check incident review**: a bartender refuses service
to a suspected-underage patron → the duty manager reviews → it's logged as a
refusal record. The very same `human:` gate that guards *money* in cafe-ops here
guards a *compliance decision*.

Storefront type = 酒吧 / pub. The five things a real bar manages, folded in:
**岗位知识 · 排班 · 深夜薪 (含临时工) · 酒水库存 · 酒牌 / 年龄合规**.

---

## The six workflows

| Workflow | Trigger | Member self-service | Approval | Covers |
|---|---|---|---|---|
| `bar-staff-onboarding` | `bar.onboard-staff` | ✅ `/me` (scope `trainee_id`) | — | 新员工学到本岗位 (调酒 / 侍酒 / 安保 / 收银) 操作与规范 |
| `bar-shift-availability` | `bar.submit-availability` | ✅ `/me` (scope `staff_id`) | ✅ `human:` 领班确认 | 排班 (深夜 / 周末档) |
| `bar-late-night-wage` | `bar.settle-late-wage` | ✅ `/me` (owner/admin) | ✅ `human:` 老板审批 | 临时工深夜薪 (LLM 建议, 人定钱) |
| `bar-age-incident` | `bar.report-age-incident` | ✅ `/me` (scope `reporter_id`) | ✅ `human:` 值班经理复核 | **年龄核查事件 → 复核后写正式拒售条目 (招牌流)** |
| `bar-liquor-inventory` | `bar.count-liquor` | ✅ `/me` | — (无人值守) | 酒水盘点与预警 |
| `bar-compliance-check` | `bar.compliance-check` | ✅ `/me` | — (无人值守 + 每周定时) | 酒牌 / 年龄 / 营业时间合规自查 |

Three agents serve every capability these workflows dispatch:

- **岗位培训师** (`bar-onboarding-trainer`, cap `bar.train-position`) — reads the
  bar operations manual and walks a new hire through their position's SOP + norms,
  surfacing the age-check red line for every station.
- **运营助手** (`bar-ops-assistant`, caps `bar.shift-draft` / `bar.late-night-wage`)
  — drafts shift proposals (flagging late-night / weekend coverage) and suggests
  late-night wage amounts per the store's shift-multiplier policy (人定钱).
- **合规助手** (`bar-compliance-aide`, caps `bar.liquor-inventory` /
  `bar.license-check` / `bar.age-incident-review`) — outputs liquor-count
  checklists (flagging below-safety items if an inventory source is wired) and
  compliance self-check lists, and drafts the age-incident review sheet + the
  post-approval log entry. It only produces checklists / review sheets — it never
  rules on a customer's real age or on compliance; people do.

The `human:` steps dispatch to `gotong.human/v1` — the host's inbox broker, a
built-in, **not** a template agent. The two unattended flows (inventory /
compliance) carry no `human:` step, so they enter the golden-run acceptance.

---

## The headline: age-check incident review (HITL)

This is the flow that makes bar-ops a bar, not a café reskin. A bartender or
door-security staffer refuses to sell to a suspected-underage patron and files
it; the assistant drafts a review sheet; the run **suspends** at a duty-manager
gate; the manager confirms; the `record` step (`when`-gated on approval) writes
the compliance-log entry.

```
调酒师 /me 上报拒售事件 (时间 / 岗位 / 顾客情况 / 出示了什么证件 / 怎么处置)
   │  dispatch bar.report-age-incident
   ▼
[review]  合规助手 → 事件复核单 (按上报文本标出提及的动作: 证件 / 拒售 / 报安保 —— 待经理核实)
   ▼
[approve]  human: → gotong.human/v1
   │  broker writes an inbox item for the duty manager, then SUSPENDS the run
   ▼
   ⏸  parked — not failed.  值班经理 /me 收件箱 sees one pending approval.
   │
   │  值班经理 confirms
   ▼
   ▶  two-step resume (child broker, then parent workflow)
   ▼
[record]  when: $approve.output.approved == true  → 写一条正式「拒售记录」条目 (拒绝则跳过)
   ▼
run completes:  { review: {...}, approval: { approved: true }, record: { logEntry: "[拒售记录] ..." } }
```

`src/index.ts` runs exactly this end to end (deterministic, no API key) and
self-asserts every check. The `record` step is `when`-gated on the manager's
approval — **不确认就不写正式拒售条目** (rejected → judged a non-incident → no
formal refusal entry; the run itself is still recorded as an audit trail, with
the record step marked `skipped`). The two-step resume (child broker strictly
before parent workflow) is hand-rolled in ~30 lines mirroring
`HostInboxService.resolve`, so the HITL mechanism is visible in example code,
not buried in the host.

> **年龄核查事件是「记录 + 复核」, 不是「执法」.** The record is a *refusal-of-service
> entry* — it captures that the bar ran an age check and refused, reviewed by a
> manager. That entry lands in **this workflow's own run record** (form inputs /
> step outputs / approval, snapshotted to `.gotong/`, file-first) — the template
> ships **no** write connector to any external compliance system. On rejection the
> entry isn't written, though the run is still kept as an audit trail (the record
> step marked `skipped`). It is **not** ① a report to the authorities (记录 ≠ 举报;
> whether to report is a human decision made outside the ledger), ② a check of the
> customer's *real* age (there's no ID database — the refusal is a human on-the-spot
> call, the template only logs it), or ③ a judgment of whether the staffer acted
> correctly (the template doesn't adjudicate; the staffer already refused).

### The wage red line — same as cafe-ops

`bar-late-night-wage` mirrors cafe-ops's casual-wage flow. The assistant produces
a **suggested** amount per the store's shift-multiplier policy (an LLM figure in
the loadable template — day ×1 / late-night ×1.5 / weekend ×2 / holiday ×3, per
*your* manual), flags possible anomalies, and a `record` (结算单) step is
`when`-gated on the owner's approval — **不批就不出结算单, 不发钱, 不写工资库, 不做
劳动法裁定**. Final amount is always per your real payroll system.

`src/index.ts`'s `[B2]` probe proves the multiplier is **situational**: the same
4 hours yield ¥150 / ¥200 / ¥300 across late-night / weekend / holiday — the
worker fits the shift, not a flat rate. Deterministic arithmetic
(`Math.round(h*rate*multiplier*100)/100`) runs only in the demo stand-in; in the
loadable template the figure is an LLM **suggestion** per policy. Either way the
manager decides the money. See [`docs/zh/STOREFRONT-OPS.md`](../../docs/zh/STOREFRONT-OPS.md) §三.

> The runnable no-key demo (`src/index.ts`) exercises a **teaching subset**
> (onboarding + age-incident + wage multiplier). The loadable template ships all
> six flows; the anti-corruption gate drives every one through the real
> `parseWorkflow`.

---

## Run it

```bash
# the runnable demo — onboarding (no approval) + age-incident (HITL suspend→approve→resume)
pnpm demo:bar-ops

# preview the loadable template (config-preview; does not spawn mcp-obsidian)
pnpm demo:bar-ops:template
```

The demo uses deterministic **stand-ins** (`src/standins.ts`) for the worker
capabilities so it runs with no API key. In the loadable template those become
KB-backed `LlmAgent`s on DeepSeek + mcp-obsidian — **same hub wiring**, swap and
nothing else changes.

---

## The loadable template

`template/bar-ops.template.yaml` is one self-contained `gotong.template/v1`
file carrying the whole working skeleton: 3 agents + 6 declarative workflows + an
addressable KB slot (`bar_ops_manual`) + **2 optional read-only connector slots**
(inventory / timesheet) + 2 golden-run acceptance cases + a person-less weekly
schedule + a one-click DeepSeek key prompt. Load it into a real host:

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H 'content-type: application/json' \
  -d "$(jq -Rs '{template: .}' examples/bar-ops/template/bar-ops.template.yaml)" \
  http://127.0.0.1:8745/api/admin/templates/import
```

### What ships in the template — and what doesn't

Following the Stream B decisions, the template carries **structure and
references, never content or personnel**:

- ✅ **agents** — config only (provider / model / system / MCP wiring); secrets
  ride as `${ENV}` placeholders, never literals.
- ✅ **workflows** — the declarative process definitions (dispatch graph,
  `surface.me`, `human:` gates, `governance` metadata).
- ✅ **KB slot** (`bar_ops_manual`) — MCP wiring + a `presetData` **pointer**
  to a packaged manual snapshot. Imported = *reported*, never auto-wired
  (decision #4): you connect your own Obsidian vault to the slot.
- ✅ **optional connector slots** (`inventory` / `timesheet`) — abstract read-only
  MCP needs, not pre-wired to any agent. The **system of record** for stateful
  business data (酒水库存数 / 工时) is **your** external source — Gotong doesn't hold
  the authoritative ledger. (It's file-first, though: each run's form inputs, step
  outputs and approvals are still snapshotted to `.gotong/` as an audit trail —
  the master copy just isn't there.) Unplugged = honest mode (the flows still run,
  they just don't read real numbers).
- ❌ **the manual content** — your bar operations manual (岗位 SOP / 年龄核查与酒牌
  规范 / 深夜薪政策 / 排班规则) is your own Obsidian vault behind mcp-obsidian.
- ❌ **personnel** — no owners / grants / members. Who works at your bar is
  not part of a shareable architecture.

The web anti-corruption test (`packages/web/tests/bar-ops-template.test.ts`)
reads this exact file through the real `parseTemplate`, runs **each** embedded
workflow block through the real `parseWorkflow`, and imports it end-to-end — so
the example can never silently drift out of sync with the schema.

---

## Notes / scope

- **Deterministic stand-ins, not LLMs.** The demo proves the *hub wiring* (a
  workflow dispatches a capability, a participant answers, a `human:` step
  suspends and resumes). It is not a model demo — `src/standins.ts` does real,
  assertable logic (position SOP lookup, shift-multiplier wage math, an
  age-incident compliance checklist) so it runs offline.
- **Compliance decisions and money are both human-gated.** The age-incident
  record and the wage settlement each sit behind a `human:` approval, and the
  `record` step is `when`-gated on it. Reject → no *formal* refusal entry, no
  settlement — but the run itself is still recorded (its `record` step marked
  `skipped`), so a rejected review leaves an audit trail either way.
- **`human:` is routing, not a role-gate.** `manager_id` / `approver_id` /
  `reviewer_id` are free-text userIds the initiator fills in; the broker only
  checks the assignee is non-empty — it does not verify the person is actually a
  shift-lead / owner / duty-manager (or isn't the initiator themselves). Locking
  "must be a manager, can't self-approve" needs authoritative role checks a pure
  template can't do — it rides on filling the right userId + deployment discipline.
- **Core + workflow + inbox only** — no host / identity / llm dependency. The
  runnable demo is intentionally small so the mechanism is legible.
