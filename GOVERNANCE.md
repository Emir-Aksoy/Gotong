# Gotong Governance

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](docs/zh/GOVERNANCE.md) · [日本語](docs/ja/GOVERNANCE.md) · [Русский](docs/ru/GOVERNANCE.md) · [Français](docs/fr/GOVERNANCE.md) · [Español](docs/es/GOVERNANCE.md) · [한국어](docs/ko/GOVERNANCE.md). If a translation conflicts with this English version, the English version governs.

This document describes **how decisions get made** in Gotong: who maintains
the project, how a change lands, how a community template enters the official
gallery, and what happens when people disagree. It is deliberately small —
the project is young, and a heavy governance structure on a small project is
just ceremony. We will grow this document as the community grows, not before.

This document sits under the project's constitution, [`CHARTER.md`](CHARTER.md):
the charter says *what* Gotong is and what it refuses to become; this says *how*
we decide. Where the two meet — e.g. "the framework does not run the LLM" — the
charter is the source and this is the enforcement.

If you only read one thing: **the design line is not up for negotiation, but
almost everything else is.** See [The one non-negotiable](#the-one-non-negotiable).

---

## Roles

We keep three roles. There is no secret fourth tier.

| Role | What it means | How you get it |
|---|---|---|
| **Contributor** | Anyone who opens an issue, sends a PR, files a template, or helps in Discussions. | Just show up. No application. |
| **Maintainer** | Can review and merge PRs, triage issues, and publish releases. Responsible for a subsystem or the project as a whole. | A track record of good, design-aligned contributions, then nominated in the open — see [Becoming a maintainer](#becoming-a-maintainer). |
| **Steward** | Final tie-breaker on contested decisions and the keeper of the design line. Today this is the founding maintainer. | Held by the founder until the project is large enough to elect stewards (see [Component committee](#path-to-a-component-committee)). |

Current maintainers are listed in [`MAINTAINERS.md`](MAINTAINERS.md) — today
that is just the founding maintainer, who is also the steward, the reviewer, and
the release manager. This document exists precisely so that arrangement is
**temporary and written down**, not a habit, and the next section is the path
the second maintainer takes.

### Becoming a maintainer

The ladder is deliberately light — this is a young project, and the goal is to
grow a bench of people who hold the design line, not to gate-keep. A rough
guideline, not a checklist to game:

- **A track record, not a tally.** On the order of ~5 non-trivial merged PRs —
  or the equivalent — over a couple of months. The number is a floor for "we've
  seen enough of your work to trust your judgement," never a target to farm with
  drive-by PRs. **"The equivalent" explicitly includes reach work, not only
  code:** a flagship template you keep maintained, a substantial adapter, or
  sustained review / triage help — *and equally* keeping the docs alive in a
  language the core team doesn't speak, running the community so newcomers get
  unstuck, or sustained educational material that brings people to the project.
  Carrying Gotong to people is real work; this ladder counts it as a path to a
  say, not a lesser track (see [pillar ⑤ of the recognition
  system](docs/RECOGNITION-SYSTEM.md#pillar-5),
  and [`CONTRIBUTORS.md`](CONTRIBUTORS.md) where contributions of every kind are
  recorded).
- **A feel for the design line.** Your PRs and reviews show you reach for a
  *participant*, not the Hub, when logic needs a home (see
  [The one non-negotiable](#the-one-non-negotiable)).
- **Nominated in the open.** An existing maintainer nominates you on a public
  issue — self-nomination is fine, just say why. Approval is lazy consensus
  among maintainers and the steward confirms; your name lands in
  [`MAINTAINERS.md`](MAINTAINERS.md) in that same PR.

What you take on: reviewing others' PRs in your area, upholding the design line,
and answering issues for what you maintain. It is a responsibility you can also
set down — step back any time and we move you to emeritus in `MAINTAINERS.md`
rather than pretend you're still on call.

Today there is exactly one maintainer — the founding steward — so this ladder is
**written but dormant**: there is no one to nominate yet. It is here so the
*second* maintainer joins by a known path, not an ad-hoc tap on the shoulder.

---

## How a change lands

Most changes are boring, and boring is good:

1. **Open an issue first** for anything non-trivial — a new dependency, a
   protocol-shape change, a new package, a behavioral change to scheduling or
   federation. Drive-by typo PRs and small doc fixes can skip this.
2. **Send a small PR.** One change, one PR. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
3. **A maintainer reviews it.** Reviews check three things, in order:
   correctness, the [design line](#the-one-non-negotiable), and simplicity.
4. **Merge.** Lazy consensus: if no maintainer objects within a reasonable
   window and CI / local checks pass, it merges. Objections are resolved by
   discussion; a genuine deadlock goes to the steward.

We do not require a CLA. By contributing, you offer your work under the
project's [MIT license](LICENSE).

### Decisions that need more than a PR

A few categories get extra care, and a maintainer will slow them down on
purpose:

- **Wire-protocol changes** — anything that alters the shapes in
  [`docs/PROTOCOL.md`](docs/PROTOCOL.md). These get a version bump and an
  explicit migration note.
- **Irreversible schema changes** (drop a column / table). Even though the
  project does not promise forward-compatibility pre-1.0, we discuss the blast
  radius before dropping persisted data.
- **New runtime dependencies**, especially native ones. Open an issue.
- **Removing a public API surface.** Describe the impact first, even if you
  believe nobody uses it.

---

## How a template enters the official gallery

Gotong ships **templates** (`gotong.template/v1` — a self-contained YAML that
carries an agent team + workflows + knowledge-base *references*, but never
secrets, knowledge content, or personnel). The bar to be *shipped with the
framework* — to appear in the one-click gallery in the admin UI and on the
public site — is higher than the bar to be *accepted as a community template*.

There are two tiers, and they are different promises:

### Community templates — "we checked the license and it parses"

Live under [`templates/community/`](templates/community/). To be merged, a
community template must:

1. **Parse.** It passes the real `parseTemplate` (and every embedded workflow
   passes the real `parseWorkflow`). This is enforced by an automated
   validation test, not a human eyeball — see
   [`templates/community/templates/README.md`](templates/community/templates/README.md).
2. **Carry honest provenance.** If it is derived from another template or an
   upstream prompt library, it declares that in the `provenance` block
   (`derivedFrom`, `author`, `notes`). Provenance is how citation credit flows
   back upstream — don't strip it.
3. **Carry no secrets.** Every credential is a `${ENV}` placeholder. A template
   with a literal key in it is rejected, full stop.
4. **Have a clear, commercial-friendly license** for any adapted upstream
   material (CC0 / MIT / Apache-2.0 / BSD). Non-commercial or unlicensed
   sources are not accepted. See
   [`templates/community/LICENSE-NOTICES.md`](templates/community/LICENSE-NOTICES.md).

That's it. A community template that meets the bar is merged. We are not
curating taste at this tier — we are curating *safety and honesty*.

### Flagship templates — "we vouch for this"

A small curated set (see [`docs/zh/FLAGSHIP-TEMPLATES.md`](docs/zh/FLAGSHIP-TEMPLATES.md))
that the project actively recommends to a non-technical user. On top of the
community bar, a flagship template must:

1. **Ship a deterministic demo** that runs with no API key and self-asserts its
   own behavior (the `examples/*` convention). A reviewer can prove it works in
   one command.
2. **State its governance posture plainly** — what it can touch, what it
   cannot, and where a human is in the loop. A template that can lock a door,
   spend money, or send a child's data across a federation link must show the
   human-confirmation gate, not bury it.
3. **Be maintained.** A flagship template has a maintainer who answers issues
   about it. If it bit-rots and nobody will fix it, it drops back to community
   tier.

Promotion from community → flagship is a maintainer decision, made in the open
on an issue. Demotion is the same.

---

## When people disagree

Disagreement is normal and welcome — it is how a design gets pressure-tested.
The process:

1. **Talk it out on the issue / PR.** State the trade-off, not just the
   conclusion. "I prefer X" is weak; "X because Y, at the cost of Z" is useful.
2. **A maintainer makes the call** if discussion stalls. Maintainers should
   explain *why*, on the record.
3. **The steward is the tie-breaker** for genuinely contested calls, and the
   final authority on whether a change crosses the design line. This is a
   backstop, not a routine step — a steward who has to break ties often is a
   steward who has failed to grow the maintainer bench.

Conduct disputes are handled separately — see
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

---

## The one non-negotiable

Gotong has exactly one architectural commitment that a PR cannot vote away,
because changing it means the project is no longer Gotong:

> **The framework does not run the LLM.** The Hub routes messages, dispatches
> tasks, writes the transcript, and emits events. Every decision stays with the
> participants — agents, humans, external services. State is files on disk;
> credentials stay local; federation is peer-to-peer with explicit per-link
> boundaries.

Patches that put LLM calls, agent loops, or business rules *into the Hub* will
be redirected — not because the idea is bad, but because it belongs in a
participant, not the substrate. Everything else — schedulers, providers,
adapters, transports, UI, templates — is open to change.

---

## License permanence

Gotong is MIT, and it stays MIT:

> **We will not relicense.** Code published in this repository under the MIT
> license remains MIT forever. Future versions of the framework will not move
> to a more restrictive license — no BSL, no SSPL, no source-available pivot,
> and no CLA designed to enable one later.

Why write this down? Because the pattern is well-worn by now: a popular
infrastructure project takes funding, "clarifies" its license, and the
community routes around it with a fork (Redis → Valkey is the canonical
case). Rules that stay put matter more than rules that are generous —
people build on foundations, not on weather.

MIT itself already guarantees the escape hatch (anyone may fork the last MIT
commit), so this section adds exactly one thing: our stated intent that no
such fork should ever be necessary. If stewardship of the project changes
hands, this commitment binds the new stewards the same way
[The one non-negotiable](#the-one-non-negotiable) does.

---

## Path to a component committee

The long-term shape of this project is a **marketplace of governed,
reusable components** — templates, adapters, knowledge-base connectors — that
people trust enough to point at their home, their family, or their money.
Curating that marketplace is more than one person can do, and more than one
person *should* do.

When the contributor base is large enough that gallery curation is a real
recurring job, we will stand up a **component committee**: a small, elected
group of maintainers responsible for what gets promoted to flagship, how
citation credit is surfaced, and how disputes between template authors are
resolved. This document will be amended at that time to describe how committee
members are nominated, elected, and rotated.

We are writing this paragraph now, while the project is small, so that the
committee is a **planned milestone with a written mandate** rather than an
ad-hoc power grab later. The trigger is sustained contribution volume, not a
date.

---

## Regional chapters

The end state is a free graph of sovereign hubs, not one central platform — and the
human side of that graph is **regional chapters**: local, language-, or
community-rooted groups that run their own hubs, curate templates for their people,
and help newcomers in their own tongue. The charter ([`CHARTER.md`](CHARTER.md) §11)
welcomes them; this section says how one works in practice.

A chapter is **sovereign, not a franchise.** It owns its room and answers to no
central landlord. Nobody's permission is required to *start* one — that would
contradict the whole "no single party whose permission you need to keep running"
premise the project rests on. You can stand up a hub, gather a local community, and
curate templates for them today, and call it an Gotong chapter.

What a chapter is **not**:

- **Not an official voice of the project.** A chapter speaks for its own community,
  not for Gotong. It does not set the design line, ratify the charter, or decide
  what is promoted to flagship — those stay with the maintainers and the steward on
  the canonical repository ([`MAINTAINERS.md`](MAINTAINERS.md)).
- **Not a fork that holds the line.** A chapter may run a modified build for its own
  people, but the authoritative charter, protocol, and flagship set live in the
  canonical repository. A chapter that wants its changes to be *the* Gotong sends
  them upstream as pull requests, like anyone else.

### Recognition is optional and light

Running a chapter needs no blessing. Being **listed** as a recognized chapter — linked
from the project so newcomers can find you — is a small, opt-in step, and it works much
like template promotion:

1. **Announce it in Discussions** — who you are, the region / language / community you
   serve, and where your hub lives.
2. **A maintainer endorses it on a public issue.** The bar is honesty, not size: you
   represent the project truthfully, you follow the
   [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md), and you do not claim official status you
   do not have.
3. **Recognition can be withdrawn** the same way it was given — on a public issue, with
   reasons — if a chapter misrepresents the project or breaks the conduct line. The
   project cannot (and will not try to) shut down a chapter's hub — that is its
   sovereign room — but it can stop listing it and ask it to stop implying an
   endorsement it no longer has.

When the **component committee** stands up (see above), curating the chapter list and
resolving disputes between chapters becomes a natural part of its mandate; until then
it is a light maintainer call.

---

## Using the Gotong name

The code is [MIT](LICENSE) — you may embed it, modify it, and ship it in commercial or
closed-source products, with the license and copyright line preserved. The **license
covers the code; it does not hand over the project's name and identity.** There is no
registered trademark here, and we will not pretend otherwise — what follows is a
**community norm**, asked for in good faith, not a legal threat:

- **Descriptive use is welcome.** "Built on Gotong," "an Gotong hub," "the Gotong
  Malaysia chapter" — say these freely. They are true, and we are glad you are saying
  them.
- **Do not imply an endorsement you do not have.** Do not name a product, fork, or
  service in a way that presents it *as* Gotong-the-project or as officially blessed
  by it — no "Gotong Official," no look-alike that poses as the canonical download.
- **Do not rebrand the canonical project.** A modified distribution is yours to ship,
  but the authoritative "Gotong" — the charter, the design line, the flagship set — is
  the one in the canonical repository. If your fork diverges in spirit, give it your own
  name; the MIT license guarantees you can, and an honest name serves your users better
  than a borrowed one.

This is the lightest version of name protection that works: enough that "Gotong" keeps
meaning the governed, file-first, human-in-the-loop thing the charter describes, and no
more.

---

## Amending this document

Governance changes the same way code does: open an issue, send a PR, get
maintainer review. Changes to [The one non-negotiable](#the-one-non-negotiable)
or [License permanence](#license-permanence) require steward sign-off and a
clear statement of why the line should move. We expect those two sections to
never change. The rest is meant to grow.
