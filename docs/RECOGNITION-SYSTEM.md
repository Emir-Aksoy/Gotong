# Recognition System

> This system hands out **recognition only** — no money, no token, no bounty. Its
> "currency" is honest provenance, visible attribution, and a documented path to a
> real say in where the project goes.
>
> 中文版 / Chinese: [`zh/RECOGNITION-SYSTEM.md`](zh/RECOGNITION-SYSTEM.md) ·
> Last updated: 2026-06-27

---

## 1. Why recognition only

AipeHub's long-term shape is a **governed market of reusable components** —
templates, adapters, knowledge-base connectors — built so people trust it enough to
point it at their home, their family, or their money (see
[`GOVERNANCE.md`](../GOVERNANCE.md) § "Path to a component committee"). For a market
to live, contributors need a reason to hand their good work over — and to keep
maintaining it.

We weighed four candidates and **do only the first two**:

| Candidate | What it is | Decision |
|---|---|---|
| **A — citation leaderboard in FLAGSHIP** | Render the "who gets forked most" ranking into a checked-in doc, visible in the repo without deploying a static site. | ✅ do |
| **B — a quantified maintainer ladder** | Give `GOVERNANCE.md`'s promotion path a **light, measurable** yardstick + a `MAINTAINERS.md`. | ✅ do |
| **C — an economic / reward layer** | Bounties, tokens, revenue share. | ❌ drop |
| **D — do nothing** | Keep the status quo. | ❌ drop |

**Dropping C is deliberate, not lazy.** The North Star says the framework does not
run the LLM, state is files on disk, credentials stay local, federation is
peer-to-peer — and an incentive layer that introduces money would immediately muddy
that trust model: who custodies the ledger? how is a revenue split settled across
hubs? who has the authority to set a price? Every one of those drags the project back
toward a center, away from "the Hub is dumb and the decisions live with the
participants." **A pure-recognition system is natively file-first and natively
decentralized:** attribution is one `provenance` line in a template file, the
leaderboard is a deterministic computation, promotion is lazy consensus on a public
issue — not one of them needs a central money-pot.

So this system's "currency" is three things, and none of them costs anything:

1. **Honest provenance** — `provenance.derivedFrom` flows credit back upstream.
2. **Visible attribution** — the leaderboard and the flagship index put your name in
   the most visible place.
3. **A documented path to a say** — sustained good work earns maintainer standing and
   a real voice, not a payout.

---

## 2. The four pillars

This system is made of four things that **already exist and are already wired up**.
They are not new machinery — this document names existing parts as one system.

### Pillar ① — the citation leaderboard (credit flows back)

> "Who gets remixed the most" is "who is most useful."

Every template manifest carries a `provenance.derivedFrom`. When you fork a template,
you write the upstream slug into your own `derivedFrom`. The leaderboard ranks by
**in-degree** — how many templates declare themselves derived from you.

- **Mechanism**: the pure functions `loadCorpus` + `buildModel` in
  `packages/web/scripts/build-site.mjs` compute in-degree from the validated corpus.
- **Two render targets, one computation**:
  - The static site ([`zh/COMMUNITY-SITE.md`](zh/COMMUNITY-SITE.md)) renders it;
  - The **checked-in doc** (the "citation leaderboard" section of
    [`zh/FLAGSHIP-TEMPLATES.md`](zh/FLAGSHIP-TEMPLATES.md)) renders it too — this is
    **pillar A**, written into a `<!-- LEADERBOARD:START -->` marker block by
    `pnpm build:leaderboard` (`build-leaderboard-doc.mjs`). You can see the ranking
    in the repo without ever deploying a static site.
- **Drift guard**: `packages/web/tests/build-leaderboard-doc.test.ts` re-renders from
  the real corpus and asserts the checked-in block is byte-identical — add a
  `derivedFrom` edge but forget to re-run `pnpm build:leaderboard`, and CI names the
  failure rather than letting the table quietly rot.
- **It ranks templates, not people.** This is the honest boundary that matters: the
  leaderboard measures how much a *component* gets reused; it does not run a
  personality cult or mint gameable headcount points.

### Pillar ② — the maintainer ladder (a path to a say)

> The endpoint of good contribution is **trust + responsibility**, not a prize.

`GOVERNANCE.md`'s "Becoming a maintainer" gives a **deliberately light, measurable**
yardstick (this is **pillar B**):

- **A track record, not a tally**: on the order of ~5 non-trivial merged PRs — or the
  equivalent (a flagship template you keep maintained, a substantial adapter,
  sustained review/triage) — over a couple of months. The number is a **floor** for
  "we've seen enough of your judgement," never a **target** to farm with drive-by PRs.
- **A feel for the design line**: your PRs and reviews show you reach for a
  *participant*, not the Hub, when logic needs a home (see `GOVERNANCE.md` § "The one
  non-negotiable").
- **Nominated in the open**: an existing maintainer nominates you on a public issue
  (self-nomination is fine); lazy consensus passes, the steward confirms, and your
  name lands in [`MAINTAINERS.md`](../MAINTAINERS.md) in that same PR.

`MAINTAINERS.md` today holds only the founding maintainer. The entire point of that
file is that the **second** maintainer joins by a path that is **written down**, not a
tap on the shoulder — a responsibility line should never be an unwritten habit. When
contribution volume grows large enough that curation is a standing job,
`GOVERNANCE.md` already records the plan to stand up a **component committee**.

### Pillar ③ — frictionless sharing (make handing it over cheap)

> Friction is the enemy of incentive. Installing a template is one click; submitting
> one should not be twenty steps.

- **One-click install**: the **template gallery** in the admin "Workflows" panel
  ([`zh/TEMPLATE-GALLERY.md`](zh/TEMPLATE-GALLERY.md)) lists the curated templates
  shipped with the framework, one-click install reusing the existing
  `POST /templates/import`.
- **Five-step submit**: the community-template submission flow lives at
  [`templates/community/templates/README.md`](../templates/community/templates/README.md)
  — copy a flagship → make it yours → declare provenance → run `pnpm check:templates`
  locally → open a PR.
- **The bar is safety and honesty, not taste**: the community tier asks only "license
  clear, parses, zero plaintext secrets, provenance declared" (`GOVERNANCE.md` §
  "Community templates"); meet it and it merges. At this tier we curate *safety and
  honesty*, not your taste.

Convenience is itself an incentive: the cheaper it is to hand a template over, the
more people will publish the good workflows they hoard privately — and every honest,
attributed publish feeds the upstream one more pillar-① citation.

### Pillar ④ — shared exemplars (things worth remixing)

> A leaderboard needs things to cite; first there must be exemplars worth citing.

- **Flagship tier**: [`zh/FLAGSHIP-TEMPLATES.md`](zh/FLAGSHIP-TEMPLATES.md) — a small
  curated set the project vouches for and recommends to a non-technical user. The bar
  is higher (deterministic demo + plain governance posture + a maintainer, see
  `GOVERNANCE.md` § "Flagship templates").
- **Built-in gallery**: the templates embedded with the framework, one-click
  installable from the admin UI.
- **examples/**: end-to-end demos, each a forkable starting point.

Exemplars are the **seed** of the loop: without good exemplars, frictionless sharing
has nothing to share and the leaderboard has nothing to rank. Write an exemplar well,
state its governance posture plainly, and people fork it, cite it, and grow their own
work on top of it.

---

## 3. How the four pillars reinforce each other

The four pillars are not four isolated things — they are a **self-reinforcing loop**:

```
   ④ exemplars  ──fork──▶  ③ frictionless share  ──PR + honest provenance──▶  ① leaderboard
        ▲                                                                          │
        │                                                          cited = visible attribution
        │                                                                          │
        └──────────────  sustained good work  ◀──②  maintainer ladder  ◀──────────┘
                       (new exemplars / maintaining old ones / reviewing others')
```

1. You start from a **flagship exemplar (④)**;
2. make it yours, hand it back through **frictionless sharing (③)**, and **honestly
   attribute** the upstream in `provenance`;
3. your honest provenance adds one **citation (①)** to the upstream, which climbs the
   leaderboard — credit flows back;
4. your own template starts getting forked and cited, and your name lands on the
   leaderboard and the flagship index;
5. sustained good work (new exemplars, maintaining old ones, reviewing others') walks
   you up the **maintainer ladder (②)** to trust and a voice — and as a maintainer you
   vouch for new flagship exemplars (④), and the loop turns again.

**No step needs money.** What drives the whole loop is "my thing is useful, people use
it, my name is in the open, and what I say starts to count" — pure recognition, and
exactly enough.

---

## 4. What we don't do (honest boundary)

- **No money / no token / no bounty** (candidate C, dropped).
- **The leaderboard does not rank people**: it ranks how much a template is reused, not
  gameable personal points.
- **Promotion is not automatic**: ~5 PRs is a floor, not a switch; the final call is a
  human judgement + lazy consensus on a public issue, not a counter that unlocks.
- **No new machinery invented for it**: all four pillars are things that **already
  exist and are already wired up**; this document names them as one system, it does not
  add a subsystem.

---

## 5. Related docs

| Want to know | Read |
|---|---|
| Flagship index + citation leaderboard (pillars ①④) | [`zh/FLAGSHIP-TEMPLATES.md`](zh/FLAGSHIP-TEMPLATES.md) |
| Decision process + maintainer ladder (pillar ②) | [`GOVERNANCE.md`](../GOVERNANCE.md) |
| Current maintainer roster (pillar ②) | [`MAINTAINERS.md`](../MAINTAINERS.md) |
| Template gallery one-click install (pillar ③) | [`zh/TEMPLATE-GALLERY.md`](zh/TEMPLATE-GALLERY.md) |
| Community-template submission flow (pillar ③) | [`templates/community/templates/README.md`](../templates/community/templates/README.md) |
| Zero-compute community site (the leaderboard's other render target) | [`zh/COMMUNITY-SITE.md`](zh/COMMUNITY-SITE.md) |
| The community living room (Discussions) | [`zh/COMMUNITY-DISCUSSIONS.md`](zh/COMMUNITY-DISCUSSIONS.md) |
| 中文版 (Chinese) | [`zh/RECOGNITION-SYSTEM.md`](zh/RECOGNITION-SYSTEM.md) |
