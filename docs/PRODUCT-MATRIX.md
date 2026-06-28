# Product Dimension Matrix + Best-Fit User (with the DeepSeek price/performance variable)

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](zh/PRODUCT-MATRIX.md) · [日本語](ja/PRODUCT-MATRIX.md) · [Русский](ru/PRODUCT-MATRIX.md) · [Français](fr/PRODUCT-MATRIX.md) · [Español](es/PRODUCT-MATRIX.md) · [한국어](ko/PRODUCT-MATRIX.md). If a translation conflicts with this English version, the English version governs.

> Archive date 2026-06-21. This doc records two **product-level comparison matrices** (one strengths table, one weaknesses table, done the morning of 2026-06-21) and attaches a judgment: "from the user's angle, which kind of user with a **real need that isn't met today** we fit best" — deliberately factoring in the external variable that "DeepSeek's new API over the past two months has sharply lowered LLM price/performance."
>
> Companion reading: [`COMPETITIVE-LANDSCAPE.md`](COMPETITIVE-LANDSCAPE.md) (the 2026-05-29 panoramic survey of 30+ projects across tracks). That one is the "track map"; this one is "product-level head-to-head + target user." The cells in both matrices are **coarse judgments at the product-positioning level** (based on public material), not item-by-item testing; precise verification of any one vendor can be dug into separately.

---

## 1. Strengths matrix: product × dimension (AipeHub in the last row)

> ✅ has it · ⚠️ partial / paid-tier-only / primitive-level · ❌ none / not this positioning. The dimensions are **chosen along AipeHub's design stance** — so its advantage here is structural, with "home-field advantage" (the weaknesses matrix swaps in the dimensions enterprise buyers actually care about, and the gap immediately reverses).

| Representative product | OSS | Self-host | Owns data/creds | Governance·audit·RBAC | HITL approval | Cross-org federation | Personal↔org continuity | Framework doesn't run LLM |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Salesforce Agentforce** | ❌ | ❌ | ❌ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **Microsoft** Copilot Studio/Agent 365 | ❌ | ❌ | ⚠️ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **ServiceNow** AI Agents | ❌ | ❌ | ❌ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **Google** Gemini Enterprise | ❌ | ❌ | ❌ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ |
| **LangGraph** | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **CrewAI** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **MS Agent Framework** (SDK) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ |
| **n8n** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ |
| **Dify** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **Flowise** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **Temporal / Windmill** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ |
| **Odysseus** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Goose** (Block) | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **OpenClaw / Hermes** (class) | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **🟢 AipeHub** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Dimension glossary**: cross-org federation = agents from different sovereign hubs/orgs collaborating (credentials each stay home); personal↔org continuity = one stack that smoothly scales from personal mode up to team and then cross-org; framework doesn't run LLM = the framework only routes/accounts, never decides for the participants (the Hub is dumb).

**How to read this table**:
- The **rightmost three columns** (cross-org federation / personal↔org / framework doesn't run LLM) **are ✅ only for AipeHub**, with everyone else ❌/⚠️ — this is AipeHub's true blank space.
- Commercial platforms (top 4 rows): top marks on governance/HITL, but **OSS·self-host·owns-data are all ❌** (SaaS, vendor holds the trust model; some offer VPC but it's still tenancy at bottom).
- OSS frameworks / self-hosted platforms (middle 7 rows): top marks on OSS·self-host, but **governance only ⚠️, cross-org all ❌** (within one org).
- Personal agents (OpenClaw/Hermes/Goose/Odysseus): top marks on self-host, but **governance·cross-org·continuity path all ❌** (single person, single machine).
- **AipeHub is the only all-green row** — but precisely because the dimensions were chosen along its stance, so the weaknesses table below must be read alongside it.

---

## 2. Weaknesses matrix: honest reverse comparison (swap in the dimensions enterprise buyers care about, and AipeHub is the weaker one)

The table above wins on "home-field advantage." Swap in the dimensions an enterprise buyer actually asks about, and the gap reverses immediately:

| Dimension | Who's strong (specific product) | AipeHub |
|---|---|---|
| Customer validation / scale | Salesforce Agentforce (8000+ customers), ServiceNow | ❌ early-stage / self-use |
| Ecosystem integration (CRM/ITSM/Office/SAP) | Salesforce, ServiceNow, Microsoft | ❌ wire it yourself via MCP |
| Compliance certifications (SOC2/ISO/HIPAA) | all commercial platforms | ❌ no certifications |
| Out-of-box / no-code maturity | n8n, Dify, Agentforce | ⚠️ needs config / example-first |
| Bundled strong model + SLA + commercial support | all commercial platforms | ❌ (and by design doesn't run the model; depends on the MiMo/DeepSeek/Claude you wire in) |
| Visual orchestration maturity | n8n, Flowise, Dify | ⚠️ mostly declarative YAML (read-only DAG view added) |

**Network-effect weakness (listed on its own, because it's life-or-death for federation-class products)**: federation's value grows superlinearly with the number of peers, while at cold start the peer count = 0. This is the death trap of every "cross-org" product — §4 below explains why the target users we pick **bring their own peers and can sidestep this trap**.

---

## 3. One-line conclusion

**AipeHub is not "a better Agentforce" or "a stronger n8n"; it sits in a crossroads cell no one else occupies**: self-hosted sovereignty + cross-org federation + org-level governance/HITL + a personal-to-org continuity path + framework doesn't run the LLM. The price is that it's an early-stage product on "maturity / ecosystem / compliance / customer validation" — which is exactly where the commercial platforms are strongest.

> Data sources: vdf.ai vendor panorama / Futurum platform wars / Zylos protocol layer / Knowlee OSS self-host / Strata HITL, plus measurements of the codebase (32 packages / 85.7k LOC / test ratio >1:1 / 41 demos). See [`COMPETITIVE-LANDSCAPE.md`](COMPETITIVE-LANDSCAPE.md).

---

## 4. Which kind of user we fit best — "has a need, but isn't met today"

Stack the two matrices and **the served cells are already crowded; there's only one unserved cell**:

> **Small outfits that need governance / guardianship / approval + data sovereignty + cross-boundary collaboration, but ① can't afford and can't use enterprise-grade platforms, and ② are also shut out by the "single-org, no governance" ceiling of OSS frameworks.**

This cell is near-vacuum today — not because no one wants to build it, but because it's blocked by **two walls at once**:

- **Wall A (price/maturity)**: enterprise platforms (Agentforce/ServiceNow/Microsoft/Google) have governance and HITL, but are high-ACV, high-touch SaaS GTM and **simply don't sell down** to a household, a bubble-tea shop, a three-person law firm.
- **Wall B (architecture)**: OSS frameworks (LangGraph/Dify/n8n) and personal agents (OpenClaw/Goose) are cheap and self-hostable enough, but **architecturally have no cross-org federation, no org-level governance, no outbound approval gate** — and no amount of cheapness grows those capabilities.

AipeHub stands right in the crack between the two walls: it has the enterprise platforms' "governance + HITL + data sovereignty," and also the OSS frameworks' "self-host + cheap + credentials stay on your machine," **plus it exclusively owns those three columns (cross-org federation / personal↔org continuity / framework doesn't run LLM)**.

### 4.1 The two sharpest beachheads, where we've already built the examples through

| Beachhead | Who | Why it's unmet today | The examples we've built through |
|---|---|---|---|
| **A. Family / education** | parents opening AI for kids, multi-member family sovereign AI, parental guardianship+approval | enterprise platforms don't sell to families; personal agents are single-person/single-machine with no guardianship/cross-member sovereignty/approval gate | `family-learning-hub` (two sovereign hubs + outbound approval gate + data-class locking child data), the `/teach` tutor, transcript fork to the parent |
| **B. SMB cross-org** | supply chain (shop↔supplier), franchise chains (HQ↔store), mentorship/clubs/cross-company projects | enterprise platforms are too heavy/expensive for the very small, and their cross-org story is still vendor-bound; OSS frameworks are single-org | `tea-supply-link`, `tea-chain-hq`, `warband-club`, `cafe-ops` |

Pushing one ring outward, the same cell also holds **federations of regulated small teams**: law-firm consortia, clinics, cross-company RFPs, research collaboration — all "cross-org collaboration + data must stay in my own hands + need audit/approval," equally unserved head-on today.

### 4.2 DeepSeek pushed over the "price wall" — exactly the variable the user pointed at

The user's judgment fully holds: **a product that had no price/performance case before may have one later.** The mechanism, spelled out:

1. **This cell was historically locked by a dual constraint**: ① the LLM is too expensive + ② no product fills "sovereignty + governance + cross-org + consumer price." Families can't afford it, bubble-tea shops have thin margins, and "running the LLM on every interaction, plus keeping several agents alive for routing/consultation/heartbeat" **didn't pencil out** at old model prices — so this kind of self-hosted, governance-style AI stayed stuck at demo, with no one actually going live.
2. **DeepSeek's new API over the past two months removes constraint ①** (LLM cost). **AipeHub fills exactly constraint ②** (the missing product). Put the two together and this cell, for the first time, has both "affordable" and "something to use."
3. **The key asymmetry — competitors can use cheap DeepSeek too, but cheap LLMs don't help them reach this cell**:
   - Enterprise platforms: a cheap LLM doesn't change their high-touch enterprise GTM; they **won't** drop down to sell to families/small shops just to save tokens.
   - OSS frameworks: a cheap LLM **can't add** cross-org federation/governance/HITL — a price cut doesn't backfill what the architecture lacks.
   - Personal agents: a cheap LLM **can't add** guardianship/cross-org/approval — they're single-person/single-machine by design.
   - → DeepSeek is a rising tide that lifts everyone, but it **disproportionately unlocks AipeHub's cell**: because that cell was blocked by "cost ∧ missing product" at once, DeepSeek removes the cost, and **only AipeHub supplies the missing product**.
4. **And cheap LLMs benefit AipeHub more than others** — an overlooked point: AipeHub's "framework doesn't run the LLM, but the participants do" design naturally makes **many small LLM calls** (a routing agent deciding who to dispatch to, multi-agent consultation, heartbeat proactive wake-ups, the three-pillar growth agents, tutor+topic-screen+content-moderation…). This "many cheap LLM participants" shape was a **cost burden** at old model prices — exactly what kept non-enterprise users out; once DeepSeek cuts the unit price, AipeHub's most natural design becomes the **price/performance sweet spot** — and it's sweet precisely on the users price had squeezed out before.

### 4.3 Why this choice also conveniently solves the "federation cold-start" death trap

§2 said: the biggest death trap for federation-class products is **peer count = 0**. The two beachheads we pick **bring their own peers**:

- "parent + child" is **2 sovereign hubs** from the opening move;
- "shop + supplier," "HQ + franchise," "master + apprentice" are **≥2 parties** from the opening move.

In other words, this kind of user's **usage scenario is itself a paired/grouped federation** — the second peer isn't something you have to go BD-hunt for, it's brought by the use case. This is fundamentally different from "an enterprise buys one single deployment": an enterprise single deployment can't cold-start a federation network, whereas a pair of families or a supply chain **naturally bring the second node in**. So picking this cell is both "the most-unmet need" and a way to flip federation's network-effect cold-start problem from "death trap" to "brought by the use case."

### 4.4 Honest boundaries (this is not "winning on autopilot")

- **Wall A's price is pushed over, but Wall A's "maturity" isn't**: families/small shops want **truly out-of-box** (one-line start, a desktop shell, idiot-proof onboarding); AipeHub is still example-first + needs configuration. Price/performance unlocked the demand, **usability is the next gate**.
- **Trust/compliance is still a hard gate for families and regulated small teams**: guarding a child's data, a law-firm consortium — without audit/compliance backing they still won't dare use it.
- **Distribution is still a business problem, not a code problem**: this cell's users are scattered and hard to acquire; it needs a no-code entry + a template gallery + real reference customers, not a few more features.

---

## 5. One line for decision-making

> **The sharpest target is the small outfit that "needs governance/guardianship/cross-org, but enterprise platforms can't reach and OSS frameworks can't grow into" — family/education first, SMB cross-org collaboration second.** They were historically blocked by both "the LLM is too expensive" and "there is no such product"; DeepSeek's price cut over the past two months removed the former, AipeHub is exactly the answer to the latter, and this kind of user's use case **brings its own federation peer**, conveniently solving cold start. Competitors can use cheap DeepSeek too, but a price cut can't backfill the cross-org governance their architecture lacks — **this cell's price/performance window is structurally open for AipeHub.** The remaining hard fights are in usability, trust backing, and distribution — not in technology.
