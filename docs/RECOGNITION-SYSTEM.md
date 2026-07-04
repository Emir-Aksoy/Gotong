# Recognition System

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](zh/RECOGNITION-SYSTEM.md) · [日本語](ja/RECOGNITION-SYSTEM.md) · [Русский](ru/RECOGNITION-SYSTEM.md) · [Français](fr/RECOGNITION-SYSTEM.md) · [Español](es/RECOGNITION-SYSTEM.md) · [한국어](ko/RECOGNITION-SYSTEM.md). If a translation conflicts with this English version, the English version governs.

> This system hands out **recognition only** — no money, no token, no bounty. Its
> "currency" is honest provenance, visible attribution, and a documented path to a
> real say in where the project goes.
>
> 中文版 / Chinese: [`zh/RECOGNITION-SYSTEM.md`](zh/RECOGNITION-SYSTEM.md) ·
> Last updated: 2026-06-27

---

## 1. Why recognition only

Gotong's long-term shape is a **governed market of reusable components** —
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

Those three are also the test for anything we *add* to the system: it must cost nothing
and pull toward files-and-people, not toward a center. **Pillar ⑤ below — recognizing
spread — is the one deliberate extension.** It widens *visible attribution* to cover the
work of carrying the project to people, which the original four pillars, all keyed off
in-repo artifacts, structurally can't see. It introduces no money and no tracking
backend; it is two markdown files.

---

## 2. The pillars

This system is made of five pillars. The first four (①–④) **already exist and are
already wired up** — this document names existing parts as one system rather than
inventing a subsystem. The fifth (⑤) is the **one deliberate addition**: two light,
file-first artifacts that recognize the work of *carrying the project to people* — the
work the first four structurally cannot see.

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

<a id="pillar-5"></a>

### Pillar ⑤ — recognizing spread (reach is real work)

> A good product only gets better by reaching people. The four pillars above all reward
> work that leaves a trace *inside the repo*; carrying the project *to people* leaves no
> `derivedFrom` edge — so without a fifth pillar it stays invisible.

The first four pillars share a blind spot: they key off in-repo artifacts. The
leaderboard counts `provenance` edges; the maintainer ladder counts merged PRs; both are
blind to the person who writes the tutorial that finally makes federation click, gives
the talk that brings fifty people to the project, runs the room where newcomers get
unstuck, or translates the docs into a language the core team doesn't speak. **That labor
is the difference between a good framework nobody finds and a good framework people
actually use** — and most open source under-credits it. In the AI era the gap is sharper:
building is cheaper than ever, so the scarce, decisive work is *discovery and trust* — and
that is exactly the work the first four pillars can't see. Recognizing it is a deliberate
differentiator, not an afterthought.

So pillar ⑤ adds two light, file-first artifacts — and nothing heavier:

- **A typed contributor ledger — [`CONTRIBUTORS.md`](../CONTRIBUTORS.md).** A
  hand-maintained table that records *every* kind of contribution, big or small, next to
  code, using the [All Contributors](https://allcontributors.org) emoji vocabulary —
  💻 code, 📖 docs, 🌍 translation, 📝 blog, 📹 video, 📢 talk, ✅ tutorial,
  💬 community support, 📋 event organizing. It is **a record, not a ranking**: it states
  *what you did*, in the open, with your name on it — it does not sort people by a number.
  A significant reach effort lands in the record the same as a merged feature, and no
  effort is too small to record. We use the All-Contributors *taxonomy* but **not** its bot
  or GitHub Action (the repo spends no Actions budget on bookkeeping, and a markdown table
  is the lightest honest thing); you are added by a normal PR.
- **A curated learning showcase — [`LEARN.md`](../LEARN.md).** The best community-made
  material for learning Gotong — videos, talks, tutorials, posts — each credited to its
  author and linked from the README. This is the **reach analog of pillar ④**: flagship
  templates are the best things to *remix*; LEARN entries are the best things to *learn
  from*. Curating someone's video here is a concrete, visible act of recognition — and it
  doubles as the place a newcomer goes to learn from the best material the community has
  made.

**What we recognize is the work of reaching — not a reach number.** We deliberately do
*not* build a "spread leaderboard" off views, followers, or referral counts: those are
gameable, they'd need a tracking backend the North Star doesn't want (the Hub is dumb;
state is files), and they'd pull the project back toward vanity. We can't honestly measure
"how many people your video brought," but we *can* honestly record "you made the video"
and *can* curate "this video is good enough that we send newcomers to it." That records
the contribution and sidesteps the metric trap in one move — the same way pillar ① **ranks
templates, not people**, pillar ⑤ **records and curates work, not audience size**.

And spread earns standing, not just a row: `GOVERNANCE.md`'s maintainer ladder counts
sustained reach work — localization stewardship, running the community, sustained
educational material — as an **equivalent track** to code toward a real say in the project
(pillar ②). A person who never writes a line of framework code but keeps the docs alive in
three languages and answers newcomers every week is contributing exactly the kind of
sustained judgement the ladder is meant to recognize.

---

## 3. How the pillars reinforce each other

Pillars ①–④ are not four isolated things — they are a **self-reinforcing loop** that
turns once a person is already inside the repo:

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

**Where pillar ⑤ fits.** The loop above is the *in-repo* flywheel — it turns once a
person is already here. Pillar ⑤ widens the mouth of the funnel: reach work (a talk, a
video, a translation, a thriving community room) is how a person *arrives* at the
exemplars in the first place, and how the work they then publish finds its own audience.
It doesn't change the four-pillar loop; it feeds people into it and carries the loop's
output back out. Recognizing it keeps the people who do that work visible, instead of
treating distribution as something that just happens.

---

## 4. What we don't do (honest boundary)

- **No money / no token / no bounty** (candidate C, dropped).
- **The leaderboard does not rank people**: it ranks how much a template is reused, not
  gameable personal points.
- **We recognize spread work, not a spread score**: no view / follower / referral
  leaderboard — those are gameable and would need a tracking backend the North Star
  refuses. [`CONTRIBUTORS.md`](../CONTRIBUTORS.md) records *what you did*;
  [`LEARN.md`](../LEARN.md) curates *what's worth learning from*; neither sorts people by
  audience size.
- **Promotion is not automatic**: ~5 PRs is a floor, not a switch; the final call is a
  human judgement + lazy consensus on a public issue, not a counter that unlocks.
- **Almost no new machinery**: pillars ①–④ are things that **already exist and are
  already wired up**. Pillar ⑤ adds exactly two hand-maintained markdown files
  (`CONTRIBUTORS.md`, `LEARN.md`) — no bot, no GitHub Action, no tracking service. That is
  the whole of the "new" surface, and it is deliberately the lightest thing that could
  work.

---

## 5. Related docs

| Want to know | Read |
|---|---|
| Flagship index + citation leaderboard (pillars ①④) | [`zh/FLAGSHIP-TEMPLATES.md`](zh/FLAGSHIP-TEMPLATES.md) |
| Decision process + maintainer ladder (pillar ②) | [`GOVERNANCE.md`](../GOVERNANCE.md) |
| Current maintainer roster (pillar ②) | [`MAINTAINERS.md`](../MAINTAINERS.md) |
| Typed contributor ledger — all contribution kinds (pillar ⑤) | [`CONTRIBUTORS.md`](../CONTRIBUTORS.md) |
| Curated learning / video showcase (pillar ⑤) | [`LEARN.md`](../LEARN.md) |
| Template gallery one-click install (pillar ③) | [`zh/TEMPLATE-GALLERY.md`](zh/TEMPLATE-GALLERY.md) |
| Community-template submission flow (pillar ③) | [`templates/community/templates/README.md`](../templates/community/templates/README.md) |
| Zero-compute community site (the leaderboard's other render target) | [`zh/COMMUNITY-SITE.md`](zh/COMMUNITY-SITE.md) |
| The community living room (Discussions) | [`zh/COMMUNITY-DISCUSSIONS.md`](zh/COMMUNITY-DISCUSSIONS.md) |
| 中文版 (Chinese) | [`zh/RECOGNITION-SYSTEM.md`](zh/RECOGNITION-SYSTEM.md) |
