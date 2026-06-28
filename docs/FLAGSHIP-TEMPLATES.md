# Flagship Templates — hubs an ordinary person can import and use

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](zh/FLAGSHIP-TEMPLATES.md) · [日本語](ja/FLAGSHIP-TEMPLATES.md) · [Русский](ru/FLAGSHIP-TEMPLATES.md) · [Français](fr/FLAGSHIP-TEMPLATES.md) · [Español](es/FLAGSHIP-TEMPLATES.md) · [한국어](ko/FLAGSHIP-TEMPLATES.md). If a translation conflicts with this English version, the English version governs.

> This is an **endorsed** template list. "Flagship" doesn't mean "the most," it means "we vouch for it": each one ships a **deterministic demo** (one command, no key, asserts its own behavior), each puts its **governance posture** (what it can touch, what it can't, where a human gates) out in the open, and each **is maintained**.
>
> Want to see all templates (including the community tier)? The admin UI's "Workflows → Template Gallery." Want to submit one yourself: [`templates/community/templates/`](../templates/community/templates/). The selection criteria for this list are written in [`GOVERNANCE.md`](../GOVERNANCE.md).

---

## Why these

AipeHub's differentiator isn't "can call AI" — that's everywhere. It's that **you dare point AI at your home, your family, your money**, because the boundaries are real and they are yours:

- **A human gates the critical actions.** Reversible ones (turn off a light) just happen; irreversible ones (lock a door, spend money, send a child's data out) suspend and wait for a human to confirm in the inbox — the workflow **cannot skip** that gate.
- **The keys and data are on your own disk.** Credentials are encrypted in your `.aipehub/` directory. Federating with another hub shares a **capability**, not your vault.
- **No black-box decisions.** Every dispatch and result is a readable, read-only transcript. The framework never runs the model; there are no hidden judgments.

Each template below is these three principles **landed on one concrete thing**.

---

## At a glance

| Template | Who for | Where a human gates (governance posture) | Run it (no key needed) |
|---|---|---|---|
| **smart-home-hub** Smart home | people with smart-home devices | lights/AC happen directly; **lock the door, arm security** wait for the resident's inbox confirmation | `pnpm demo:smart-home-hub` |
| **family-learning-hub** Family learning | parents opening AI for kids | off-whitelist topics and a child's data leaving **both need parental approval**; subscription and data each stay home | `pnpm demo:family-learning-hub` |
| **cafe-ops** Storefront ops | small-shop owner / manager | overtime pay: **the assistant only suggests, the manager decides the money**; scheduling needs manager confirmation | `pnpm demo:cafe-ops` |
| **personal-coding-hub** Personal coding | people who want AI to help write code | dangerous commands (rm -rf / push --force) suspend for your approval; the division of labor is yours to set | `pnpm demo:personal-coding-hub` |
| **codex-deepseek-hub** Coding (Codex+DeepSeek) | same, different model set | same | `pnpm demo:codex-deepseek-hub` |
| **personal-research-hub** Personal research | people with a pile of material to untangle | read-only compilation, turning raw material into an interlinked wiki | `pnpm demo:personal-research-hub` |
| **battle-monk-training** Personal growth | people who want a daily training plan | only writes your own growth record; gives no medical/psychological advice | `pnpm demo:battle-monk-training` |
| **warband-club** Hobby club | interest community / warband | the shared archive is read/write by anyone; major decisions go through the leader's confirmation | `pnpm demo:warband-club` |
| **tea-supply-link** Cross-org supply | shops dealing with a supplier | ordering **needs human approval before crossing org lines**; the supplier quotes the money, a human decides | `pnpm demo:tea-supply-link` |
| **tea-chain-hq** Chain HQ | HQs managing franchise stores | a repricing directive **needs the regional manager's approval before rollout**; the store is a sovereign party, not a subordinate | `pnpm demo:tea-chain-hq` |

Each also comes with a `pnpm demo:<name>:template` — reads in that template file, parses it, and previews the architecture it declares (no subprocess, no key), so you see "what's packed in the template, what lives outside it."

---

## Home & family

### ⭐ smart-home-hub — Smart home (Xiaomi via Home Assistant)

**Who / what.** A home steward controls your Xiaomi (or any HA-integrated) devices via Home Assistant, running a "good-night routine."

**What it can touch.** Turn off the common-area lights, switch the bedroom AC to sleep mode — these are **reversible**, just done.

**Where a human gates (governance posture).** Locking the front door and arming security are **irreversible physical / security** actions — the workflow, on reaching this step, **suspends** and waits for the resident to click "confirm" in the `/me` inbox before executing. Reject → that step is skipped by the `when:` gate → **the door stays unlocked** (fail-closed, blocking the next action, no spillover). This is exactly what "reversible done directly, irreversible needs human confirmation" looks like landed in a home.

**Template / framework separation.** The device MCP wiring in the template is `${HA_MCP_SSE_URL}` / `${HA_TOKEN}` placeholders — which Home Assistant you connect and which token you use is runtime config filled in after import. The workflow only names capabilities (`home.apply-scene` / `home.secure`), never a specific device. Swap the devices, swap the home, and the workflow doesn't change a word. This template **has no KB slot** (device state is live HA, no separate knowledge base needed).

- Run it: `pnpm demo:smart-home-hub` (two scenarios: approve → door locks; reject → door stays unlocked)
- Template: [`examples/smart-home-hub/template/smart-home-hub.template.yaml`](../examples/smart-home-hub/template/smart-home-hub.template.yaml)
- Wiring real Home Assistant: see the [README](../examples/smart-home-hub/README.md)

### ⭐ family-learning-hub — Family learning (parents opening AI for kids)

**Who / what.** A parent pays for an AI subscription, the child learns on a **separate** hub; the child's hub calls the parent's subscription via authorization, and an AI tutor (a recreation of Matt Pocock's `/teach`: establish the mission first, one small step, knowledge before skill, cite a primary source) guides the child's exploration. This is the **most production-hardened** one on the list (real ws federation + IM supervision + real DeepSeek all run through).

**What it can touch.** Within whitelisted topics, the tutor teaches directly; the **primary copy** of learning records is on the child's hub.

**Where a human gates (governance posture) — four gates.**

1. **Topic whitelist + content self-assessment** → off-whitelist topics, and content the tutor self-flagged as `flagged`, **suspend for parental approval**.
2. **Data-classification gate**: the child's data is tagged `child-learning`, and can't be sent to a third party not authorized for that data class (fail-closed).
3. **Jurisdiction**: the parent holds the subscription (the economic chokehold) + a trust contract per federation link + transcript fork throughout (the parent gets a supervision copy).
4. **Credentials / data each stay home**: two sovereign hubs, the child's data sends a copy to the parent from the child's side, but subscription and vault don't cross.

**Template / framework separation.** The cross-org link (which child peer, which capabilities are outbound-allowed, the approval policy, `allowedDataClasses`) is **runtime peer config**, in neither the template nor the workflow. Two templates: parent-side `family-tutor` (with the tutor + whitelist/approval workflow), child-side `child-desk` (zero subscription + the learning-record primary copy).

- Run it: `pnpm demo:family-learning-hub` (six scenarios, including off-whitelist→parent approves / parent rejects→lesson not taught)
- Templates: [`family-tutor`](../examples/family-learning-hub/template/family-tutor.template.yaml) · [`child-desk`](../examples/family-learning-hub/template/child-desk.template.yaml)
- Real deployment (two sovereign machines): [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](zh/FAMILY-LEARNING-GO-LIVE.md) · Design: [`FAMILY-LEARNING-HUB-DESIGN.md`](zh/FAMILY-LEARNING-HUB-DESIGN.md)

---

## Personal productivity

### personal-coding-hub — Personal coding (Claude Code + Codex division of labor)

**Who / what.** A routing "model" analyzes the task + factors in your arrangement, and decides whether to dispatch the work to Claude Code or Codex; the two coding agents share one working directory and collaborate via `AGENTS.md` (the spec) + `PROGRESS.md` (the handoff baton). There's also **adversarial consultation**: when a problem arises, multiple agents read the code together, diagnose blind first then cross-examine, and vote to converge on the real root cause.

**Where a human gates (governance posture).** Dangerous commands (`rm -rf`, `git push --force`, `sudo`, `curl | sh` …) suspend **before** execution for your approval; reject → fail-closed, the command never ran. The division of labor is **yours to decide**: name it ad hoc ("give this one to codex") or change the overall division layer in plain language (OpenClaw-style, written back to `routing-policy.json`).

**Template / framework separation.** The template carries 1 mentor agent (`coding-mentor`, DeepSeek + inline mcp-obsidian) + 1 addressable KB slot (the methodology library, a `presetData` pointer). The two CLI coding agents are **wired at runtime** (CliParticipant doesn't enter the managed-agent roster); the knowledge **content** lives outside the template.

- Run it: `pnpm demo:personal-coding-hub` (10 scenarios: division of labor / explicit assignment / plain-language re-divide / safety gate)
- Consultation: `pnpm demo:personal-coding-hub:consult`
- Template: [`examples/personal-coding-hub/template/personal-coding-hub.template.yaml`](../examples/personal-coding-hub/template/personal-coding-hub.template.yaml)

### codex-deepseek-hub — Coding (Codex + DeepSeek TUI)

The **sister** of personal-coding-hub: a different model set — Codex (the quick implementer) + DeepSeek TUI (the reasoning lead). The same routing + plain-language re-divide + explicit assignment + safety gate, self-contained and not touching personal-coding-hub.

- Run it: `pnpm demo:codex-deepseek-hub`
- Template: [`examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml`](../examples/codex-deepseek-hub/template/codex-deepseek-hub.template.yaml)

### personal-research-hub — Personal research / knowledge hub

**Who / what.** A librarian **compiles** your raw source material into an interlinked Obsidian wiki (LLM-as-compiler), then lets you "ask your wiki." Three managed LLM agents (librarian / compiler / researcher) move in as a team.

**Governance posture.** Compilation is a **read-only** turning of raw into notes + backlinks; answering cites sources and archives to `wiki/answers/`.

- Run it: `pnpm demo:personal-research-hub`
- Template: [`examples/personal-research-hub/template/personal-research-hub.template.yaml`](../examples/personal-research-hub/template/personal-research-hub.template.yaml)

### battle-monk-training — Personal growth (body / mind / lore, three pillars)

**Who / what.** A preceptor dispatches today's drill to the three pillars (body / mind / lore), each advancing the next rank based on the ranks already trained in your record, with continuity as the design core — the Obsidian KB **stores your state** (not reference material). A cold grimdark-monastic style (an original fan-tribute, aimed at Warhammer-40k-style users).

**Governance posture / safety boundary.** It **only writes your own growth record**; this is personal data, **not medical / psychological advice** — don't treat it as the sole basis for anything.

- Run it: `pnpm demo:battle-monk-training`
- Template: [`examples/battle-monk-training/template/battle-monk-training.template.yaml`](../examples/battle-monk-training/template/battle-monk-training.template.yaml)

---

## Organizations & cross-org

### cafe-ops — Storefront ops (bubble-tea / coffee shop)

**Who / what.** A small shop's formal processes: new-hire onboarding (learning the position SOP, member self-serve), scheduling (manager confirmation), overtime pay (manager approval). The first template with a non-empty `workflows[]` — an organization's value is in the formal process.

**Where a human gates (governance posture).** Overtime pay: **the assistant only suggests the amount, the manager decides the money**: the assistant computes the multiplier by day type (weekday 1.5 / rest day 2 / statutory holiday 3), but the workflow, on reaching the approval step, suspends and is only enacted once the manager approves in the inbox. **The money is computed deterministically, not by an LLM; a human decides.**

- Run it: `pnpm demo:cafe-ops` (includes the overtime HITL two-step resume)
- Template: [`examples/cafe-ops/template/cafe-ops.template.yaml`](../examples/cafe-ops/template/cafe-ops.template.yaml)

### warband-club — Hobby club (shared archive)

**Who / what.** An interest community / warband's **collaboration face** (versus cafe-ops's management face): a shared archive the whole group reads and writes — the painting scheme / battle report you submit, others can look up; the answer you get may come from someone else's earlier contribution = collaboration.

**Governance posture.** The shared archive is read/write by anyone; major decisions (a muster) go through the leader's `human:` confirmation. Shared within one hub, no federation.

- Run it: `pnpm demo:warband-club`
- Template: [`examples/warband-club/template/warband-club.template.yaml`](../examples/warband-club/template/warband-club.template.yaml)

### tea-supply-link — Cross-org supply (tea shop ↔ supplier)

**Who / what.** The first **cross-org** template: a tea shop's restock workflow orchestrates one step over to **the supplier's hub**.

**Where a human gates (governance posture).** The cross-org ordering step goes through an **outbound approval gate** (transparent to the workflow, so the workflow has **no** `human:` step) — only after the manager approves does it cross the boundary, the supplier prices line-by-line by catalog + live inventory, and the receipt flows back to file locally. The supplier computes the money, a human decides on sending it out.

**Template / framework separation (teaching point).** The cross-org link (which peer is the supplier, which capabilities are outbound-allowed, the approval policy) is **runtime peer config**, in neither the template nor the workflow — the `place` step only writes the capability `supplier.confirm-order`, never naming a peer.

- Run it: `pnpm demo:tea-supply-link`
- Template (shop side): [`examples/tea-supply-link/template/tea-shop.template.yaml`](../examples/tea-supply-link/template/tea-shop.template.yaml)
- Two-machine operator runbook: [`docs/zh/FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md)

### tea-chain-hq — Chain HQ (HQ → franchise stores)

**Who / what.** The **mirror, reverse direction** of tea-supply-link: that one goes up (store→supplier), this one goes down (HQ→franchise store). In the three-layer chain `HQ → store → supplier`, the store is in the middle.

**Where a human gates (governance posture).** The cross-org step of rolling out a repricing directive goes through an outbound approval gate — only after the regional manager approves does it cross the boundary, the store deterministically applies the repricing per its own menu, and the receipt flows back. **The store is a sovereign organization, not a subordinate object.**

- Run it: `pnpm demo:tea-chain-hq`
- Template (HQ side): [`examples/tea-chain-hq/template/chain-hq.template.yaml`](../examples/tea-chain-hq/template/chain-hq.template.yaml)

---

## Run any one with a single command (deterministic, no key)

Each flagship has a **deterministic demo**: runs the whole flow with deterministic stand-ins, asserting its own behavior, no API key, no real device / real account needed. This is the verifiable half of "we vouch for it" — one command proves it really runs:

```bash
pnpm demo:smart-home-hub          # home: approve→door locks / reject→door stays unlocked
pnpm demo:family-learning-hub     # family: off-whitelist→parent approves / parent rejects→lesson not taught
pnpm demo:cafe-ops                # storefront: overtime HITL, manager decides the money
pnpm demo:personal-coding-hub     # coding: division of labor + safety gate
pnpm demo:personal-research-hub   # research: raw → interlinked wiki
pnpm demo:battle-monk-training    # growth: body/mind/lore three pillars
pnpm demo:warband-club            # club: shared archive + leader confirmation
pnpm demo:tea-supply-link         # cross-org: cross-boundary ordering needs human approval
pnpm demo:tea-chain-hq            # chain: repricing rollout needs human approval
pnpm demo:codex-deepseek-hub      # coding (Codex + DeepSeek)
```

To see how the template itself is parsed (a load preview, also no key): replace any of the above with `pnpm demo:<name>:template`.

---

## Actually using one

The deterministic demo proves the logic works; to actually use a flagship, take these routes:

- **One-click install**: click one in the admin UI's "Workflows → Template Gallery" and it's installed into your hub (see [`docs/zh/TEMPLATE-GALLERY.md`](zh/TEMPLATE-GALLERY.md)).
- **Personal / org hub comparison + real DeepSeek/Obsidian onboarding**: [`docs/zh/HANDS-ON-HUBS.md`](zh/HANDS-ON-HUBS.md).
- **Going live (three topologies)**: [`docs/zh/GO-LIVE.md`](zh/GO-LIVE.md).
- **Cross-org federation two-machine runbook**: [`docs/zh/FEDERATION-RUNBOOK.md`](FEDERATION-RUNBOOK.md).
- **Family learning two-sovereign-machine deployment**: [`docs/zh/FAMILY-LEARNING-GO-LIVE.md`](zh/FAMILY-LEARNING-GO-LIVE.md).

---

## Citation leaderboard (who's adapted most)

Honest provenance is this community's only currency. When you fork a template, write its slug in your `provenance.derivedFrom` — and credit flows back upstream. The table below ranks by "how many templates declare `derivedFrom` it" (times cited = in-degree), **deterministically generated** by [`pnpm build:leaderboard`](../packages/web/scripts/build-leaderboard-doc.mjs) from the validated template corpus, the same computation as the [static storefront](COMMUNITY-SITE.md)'s leaderboard (never in conflict):

> Note: the leaderboard generator currently writes the markers into the Chinese source ([`docs/zh/FLAGSHIP-TEMPLATES.md`](zh/FLAGSHIP-TEMPLATES.md)). The snapshot below is a manual mirror of that generated table; rewiring the generator to target this English doc is a tracked follow-up.

| # | Template | Times cited | Adapted by |
|---|---|---|---|
| 1 | **Personal coding mentor (Karpathy workflow)** (`personal-coding-hub`) | 1 | Pairing coding mentor (Codex × DeepSeek TUI) |
| 2 | **Tea shop (cross-org supply link)** (`tea-supply-link`) | 1 | Tea chain HQ (cross-org directive rollout) |

> The table is **generated**: after adding a `derivedFrom` edge, run `pnpm build:leaderboard` to re-render the source. `packages/web/tests/build-leaderboard-doc.test.ts` watches it stay in sync with the real corpus — hand-editing or forgetting to re-render gets caught by the test. The leaderboard ranks **templates**, not people — this is a **recognition** incentive, not a reward or economic one (see [`docs/zh/RECOGNITION-SYSTEM.md`](RECOGNITION-SYSTEM.md) / [`RECOGNITION-SYSTEM.md`](RECOGNITION-SYSTEM.md)).

---

## Want to contribute one

Flagships are few and endorsed. The vast majority of templates should be **community tier** — the bar is "license-clear, parses, zero plaintext secrets, has provenance," not "we vouch for your taste." The flow is in [`templates/community/templates/README.md`](../templates/community/templates/README.md): copy a flagship → adapt it to yours → declare provenance (`derivedFrom`) → `pnpm check:templates` locally → open a PR.

Honest provenance is this community's currency: `derivedFrom` flows credit back upstream, and the static citation leaderboard just counts "how many templates derive from you." Promotion from community tier to flagship is a maintainer decision on a public issue — the criteria are in [`GOVERNANCE.md`](../GOVERNANCE.md).
