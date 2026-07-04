# warband-club — 战团同好会 (a collaboration-first organization hub)

> One of the 5 [hands-on hubs](../../docs/zh/HANDS-ON-HUBS.md) (3 personal + 2 org) — comparison catalog + the real DeepSeek/Obsidian go-live runbook.

The second **organization (team-mode) hub** case (after `cafe-ops`). Read the two
together — they cover the two faces of an org:

- **cafe-ops** — top-down formal processes (a manager approves shifts / overtime):
  the **management** face.
- **warband-club** — collaboration around a **shared resource** (the whole warband
  reads and writes one archive): the **collaboration** face.

The form is a Warhammer 40k fan warband (同好会). The org's value is one
**shared archive**: any brother's paint scheme or battle report goes into the same
library, and every other brother can find it — the answer to your question may come
from someone else's earlier contribution. That is "collaboration + shared resources".

Like cafe-ops, this template fills `template.workflows[]` with declarative
workflows and exercises the two org capabilities:

- **`surface.me`** (Phase 14) — a member contributes / queries *for themselves* from `/me`.
- **`human:`** (Phase 16) — a muster proposal **parks** until the warband leader confirms.

> **Original fan homage.** This is an original tribute to the grimdark-wargaming
> hobby, not affiliated with or endorsed by any rights holder. It deliberately uses
> only generic hobby-club terms (战团 / 兄弟 / 司库 / 传令官 / 集结 / 对战夜 / 涂装会)
> and contains **no copyrighted text or proprietary names**. Swap the flavor for any
> club (a board-game group, a model-railway society, a book club) — the shape is the same.

---

## The three workflows

| Workflow | Trigger | Member self-service | Leader approval | The collaboration role |
|---|---|---|---|---|
| `warband-contribute` | `warband.contribute` | ✅ `/me` (scope `contributor_id`) | — | the shared resource's **write** |
| `warband-consult` | `warband.ask` | ✅ `/me` (scope `asker_id`) | — | the shared resource's **read** (= collaboration) |
| `warband-muster` | `warband.propose-muster` | ✅ `/me` (scope `proposer_id`) | ✅ `human:` 战团长确认 | the **decide** step collaboration needs |

Two agents serve every capability these workflows dispatch:

- **司库** (`archivist`, caps `warband.file-contribution` + `warband.consult-archive`)
  — files contributions into the shared archive and searches it to answer queries,
  always citing which brother's contribution the answer came from.
- **传令官** (`herald`, cap `warband.draft-muster`) — turns a muster proposal into a
  clean charter for the leader to confirm.

The `human:` step dispatches to `gotong.human/v1` — the host's inbox broker, a
built-in, **not** a template agent.

---

## The headline: collaboration through a shared resource

The shared archive is the point. One member files a paint scheme; a *different*
member queries and gets it back — that round trip through a single shared library
is the whole org model:

```
brother-cobalt /me 贡献「钴蓝战甲涂装方案」
   │  dispatch warband.contribute → [file]
   ▼
   司库 writes it into the SHARED archive (one library, whole warband)
   ⋮
   ⋮   (later, a DIFFERENT member)
   ▼
brother-novice /me 问「钴蓝战甲怎么涂装提亮?」
   │  dispatch warband.ask → [consult]
   ▼
   司库 searches the shared archive → answer cites brother-cobalt's contribution
   ▼
{ answer: "据「钴蓝战甲涂装方案」(由 brother-cobalt 贡献)…", sources: [{contributor: "brother-cobalt"}] }
```

And the muster flow shows the HITL gate collaboration needs to *decide*:

```
brother-warden /me 提议集结「月末对战夜」
   │  dispatch warband.propose-muster → [draft] 传令官拟章程
   ▼
[leader-confirm]  human: → gotong.human/v1
   │  broker writes an inbox item for the warband leader, then SUSPENDS the run
   ▼
   ⏸  parked — not failed.  战团长 /me 收件箱 sees one pending approval.
   │  战团长 confirms
   ▼
   ▶  two-step resume (child broker, then parent workflow) → run completes
```

`src/index.ts` runs both flows end to end (deterministic, no API key) and
self-asserts all seven checks — including that the consult answer came from a
**different** member's contribution (collaboration proven, not assumed). The
two-step resume is hand-rolled in ~30 lines mirroring `HostInboxService.resolve`,
so the HITL mechanism is visible in example code, not buried in the host.

---

## Run it

```bash
# the runnable demo — two members contribute to a SHARED archive, a third queries
# it (collaboration), and a muster runs the full suspend→leader-confirm→resume HITL
pnpm demo:warband-club

# preview the loadable template (config-preview; does not spawn mcp-obsidian)
pnpm demo:warband-club:template
```

The demo uses deterministic **stand-ins** (`src/standins.ts`) for the worker
capabilities so it runs with no API key — but against a **real, shared, on-disk
archive directory**, so "collaboration over a shared resource" is actually
exercised, not mocked. In the loadable template those stand-ins become KB-backed
`LlmAgent`s on DeepSeek + mcp-obsidian — **same hub wiring**, swap and nothing
else changes.

---

## The loadable template

`template/warband-club.template.yaml` is one self-contained `gotong.template/v1`
file carrying the whole working skeleton: 2 agents + 3 declarative workflows + an
addressable shared-archive KB slot + a one-click DeepSeek key prompt. Load it into
a real host:

```bash
curl -X POST -H "Authorization: Bearer <admin-token>" \
  -H 'content-type: application/json' \
  -d "$(jq -Rs '{template: .}' examples/warband-club/template/warband-club.template.yaml)" \
  http://127.0.0.1:8745/api/admin/templates/import
```

### What ships in the template — and what doesn't

Following the Stream B decisions, the template carries **structure and
references, never content or personnel**:

- ✅ **agents** — config only (provider / model / system / MCP wiring); secrets
  ride as `${ENV}` placeholders, never literals.
- ✅ **workflows** — the declarative process definitions (dispatch graph,
  `surface.me`, the `human:` muster gate, `governance` metadata).
- ✅ **KB slot** (`warband_archive`) — MCP wiring + a `presetData` **pointer** to a
  packaged archive snapshot. Imported = *reported*, never auto-wired (decision #4):
  you connect the warband's own Obsidian vault to the slot.
- ❌ **the archive content** — the actual paint schemes / battle reports / charters
  live in the warband's own shared Obsidian vault behind mcp-obsidian. One library,
  whole warband reads and writes — single-hub shared, no federation.
- ❌ **personnel** — no owners / grants / members. Who is in your warband is not part
  of a shareable architecture.

The web anti-corruption test (`packages/web/tests/warband-club-template.test.ts`)
reads this exact file through the real `parseTemplate`, runs **each** embedded
workflow block through the real `parseWorkflow`, and imports it end-to-end — so
the example can never silently drift out of sync with the schema.

---

## Notes / scope

- **Deterministic stand-ins, not LLMs.** The demo proves the *hub wiring* (a
  workflow dispatches a capability, a participant answers against a real shared
  directory, a `human:` step suspends and resumes). It is not a model demo —
  `src/standins.ts` does real, assertable logic (markdown archive writes,
  CJK-friendly bigram-overlap search) so it runs offline.
- **The shared archive is the org.** Unlike `battle-monk-training`'s per-member
  Codex (private state), this is one library the whole warband reads and writes —
  single-hub shared resources (no cross-hub federation), the org model the user locked.
- **Core + workflow + inbox only** — no host / identity / llm dependency. The
  runnable demo is intentionally small so the collaboration mechanism is legible.
