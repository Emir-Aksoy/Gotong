# AipeHub — Project Charter

> This is the project's constitution: the slowest-changing document in the
> repository, the one every other doc, design decision, and line of code is
> answerable to. The README is a doorway and [`docs/OVERVIEW.md`](docs/OVERVIEW.md)
> is a map; this is the anchor. When code and this charter disagree, either the
> code is wrong or the charter needs an amendment — and §10 says how to make one.
>
> English is the canonical version. Translations may follow; where they drift,
> English governs.

---

## 1. What AipeHub is

**AipeHub is the self-hosted substrate for the AI-era links between people,
agents, and organizations.** AI + Person + Hub.

It is not an agent, and it is not another agent framework. It is the layer
*underneath* them — a registry, a message bus, a task router, a governed
federation link, and an append-only transcript. A LangGraph graph, a CrewAI
crew, a CLI coding agent (Claude Code, Codex), an external A2A agent, and a
human all plug into the same room through one abstraction: the `Participant`.
The Hub keeps the signals flowing and the boundaries enforced. It never runs
the model itself, so every decision stays with the participants.

The mental model is small enough to hold in one hand:

- **A Hub that is dumb on purpose.** It routes messages, dispatches tasks,
  persists the transcript, emits events, and enforces the governance gates.
  It does not own agent loops or make judgment calls.
- **One kind of participant.** A person is a `Participant` exactly as an agent
  is. There is no "request-human-input tool"; people and agents share the same
  task, transcript, and long-running primitives.
- **State that is just files.** A workspace is a directory on disk
  (`.aipehub/`). Delete it and the room is gone; copy it and you have handed
  someone the whole room; restart and nothing is lost.

That combination — not any one clever protocol — is the thing AipeHub *is*.

---

## 2. The North Star — three non-negotiables

Three sentences define the project. They are not features; they are the
identity. Changing any one of them does not produce a better AipeHub — it
produces something that is no longer AipeHub.

1. **The framework does not run the LLM.** The Hub routes, dispatches, records,
   and gates. Inference and decision-making live in the participants. This is
   why the system can be dumb, auditable, and trustworthy at the same time.
2. **A person and an agent are the same `Participant`.** Human-in-the-loop is
   not bolted on; a human is a first-class participant who can be dispatched a
   task, suspend it, and resume it — the same machinery an agent uses.
3. **State is files on disk.** Sovereignty is not a setting. Your room, your
   credentials, your transcript, and your history are a directory you own and
   can copy. Restarts are transparent because there is nothing else to restore.

These three are the hardest things in the project to change (§10). Everything
else is negotiable in service of them.

---

## 3. Why it exists — the three layers

AipeHub builds the working substrate for three layers of links, in order of
how soon a user reaches them:

**Layer 1 — a person and their own AI.** "My AI desktop." One person's hub,
private workflows, credentials that never leave the machine. The goal is five
minutes to something running, no code, the AI doing real work for you.

**Layer 2 — people and agents across boundaries.** Cross-organization
collaboration: multiple users, roles, invitations, peer-to-peer federation. A
workflow can reach across an organizational line, but credentials, data, and
billing each stay home. What crosses the boundary is constrained by an explicit
per-link trust contract, and the consequential crossings wait for a human.

**Layer 3 — the framework itself.** Clear, stable, and adaptable. The Hub stays
dumb on purpose; `Participant` stays the one abstraction; protocols, credentials,
and quotas all have explicit, visible edges. The framework's own job is to keep
up with how fast AI moves without betraying layers 1 and 2.

It exists for the person who wants AI to *do something that matters* — run the
home, help the family, handle the money, coordinate the team — and who is not
willing to hand a cloud they don't control the keys to do it.

---

## 4. The trust wedge — why you can hand it the consequential stuff

Most AI tools offer two options: give everything to a cloud you don't control,
or wire it all together yourself. AipeHub is the third option — AI you can point
at your home, your family, or your money, because the boundaries are real and
they are yours. Three properties make that true, and they are the project's moat:

- **Governed.** Reversible actions just happen; irreversible ones — lock the
  door, spend money, send a child's data across a link — wait for a person to
  confirm in an inbox, and the workflow cannot skip the gate. Dangerous and
  cross-boundary actions are fail-closed by construction.
- **Local.** Credentials live encrypted in your own `.aipehub/` directory.
  Federating with another hub shares a *capability*, never your vault. Each hub
  keeps its own credential store and its own usage/cost ledger.
- **In the open.** Every dispatch and every result is an append-only transcript
  you can read. Because the framework never runs the model, there is no hidden
  judgment call to take on faith.

This is the wedge: not "more capable than the others," but *trustworthy with
the things you would never hand to a black box.*

---

## 5. Vision — where it goes

The end state is a **free graph, not a tree.** Not one central platform that
tenants rent space inside, but many sovereign hubs that interlink peer-to-peer —
each owned by the person or organization that runs it, none of them owning the
others' trust. A control plane may *observe* (with opt-in, privacy-preserving,
counts-only summaries), but it never *takes over*.

On top of that graph grows a **governed market of reusable components** —
templates, adapters, knowledge-base connectors — built so that you can hand a
whole working architecture to someone in a single file, and they can trust it
because the governance posture travels with it and the knowledge content does
not. Provenance is honest: a template carries structure and references, never
another organization's data or people.

The currency of that ecosystem is **recognition, not rent** (§7). The thing that
makes contributors keep contributing is honest attribution and a path to
authority — not a payout. The free graph stays decentralized precisely because
no central party is needed to settle a ledger.

---

## 6. How to use it

AipeHub meets people at the surface that fits them, and the same Hub sits behind
all of them:

- **Personal mode** — five minutes, no code. Import a flagship template or build
  an agent from a form; the host spawns it for you. Credentials stay on your disk.
- **Team mode** — one room, many roles (admin / worker / agent), invitations,
  resource-level RBAC, member self-service at `/me`.
- **Federation** — each organization runs its own hub; a `HubLink` connects two
  of them under a per-link trust contract (capability allowlist · data-class
  gate · quota · revocation · knowledge-base allowlist). Workflows can cross the
  link; sovereignty stays intact on both sides.

The surfaces are plural on purpose: a browser admin UI, the `/me` member desktop,
IM bridges (Telegram, Lark, Slack, Discord, Matrix, QQ), an interactive CLI/REPL,
MCP for tools and external clients, and an installable PWA. AipeHub speaks the
ecosystem's open protocols where they exist — **MCP** (tools and data, both
directions), **A2A** (agent-to-agent, both directions), **ACP** (driving a held
coding-agent session) — and owns exactly one of its own: **HubLink**, the
governed federation link between two hubs.

And templates carry whole hubs: one file packs N agents, N workflows, addressable
knowledge-base slots, and a one-prompt key setup — structure and wiring, never
the knowledge itself and never your people or secrets.

→ Start at [`docs/OVERVIEW.md`](docs/OVERVIEW.md) · run a ready-made hub via
[`docs/zh/HANDS-ON-HUBS.md`](docs/zh/HANDS-ON-HUBS.md) · plug in an agent via
[`docs/AGENT.md`](docs/AGENT.md).

---

## 7. How we decide — governance and recognition

Decisions are made in the open, by people who have earned a feel for the design
line. The authority ladder, the one design rule a maintainer must internalize
("the framework does not run the LLM"), and the path from contributor to
maintainer to steward live in [`GOVERNANCE.md`](GOVERNANCE.md); the current
roster is [`MAINTAINERS.md`](MAINTAINERS.md).

Contribution is rewarded with **recognition only** — honest provenance, visible
attribution, and a documented path to a real say in the project. There is no
money, no token, and no bounty layer, because an economic layer would muddy the
file-first, decentralized trust model the whole project rests on. The four
pillars of that system — the citation leaderboard, the maintainer ladder,
frictionless sharing, and shared exemplars — are consolidated in
[`docs/zh/RECOGNITION-SYSTEM.md`](docs/zh/RECOGNITION-SYSTEM.md).

How to contribute, and the bar a community template must clear (license clear,
parses, zero plaintext secrets, provenance declared), are in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Conduct is in
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security reports go through
[`SECURITY.md`](SECURITY.md).

---

## 8. Non-goals — what it refuses to become

A charter anchors as much by what it rules out as by what it promises. AipeHub is
deliberately **not**:

- **A model host.** It will not grow an LLM inference loop into the Hub. Bring
  your own model behind the neutral `LlmProvider` interface.
- **A central SaaS that owns your trust.** It will not become a platform that
  holds your keys, your data, or your billing as the price of using it. The
  control plane observes; it does not take custody.
- **A hierarchical org tree.** Federation is a free graph of sovereign peers,
  not tenants nested inside a landlord. No hub is structurally above another.
- **A money / token / bounty economy.** The incentive layer is recognition (§7);
  introducing currency would centralize the very trust the project decentralizes.
- **An autonomous loop that acts in the dark.** It will not let an agent take
  irreversible or cross-boundary action without a human gate. "Proactive" never
  means "unsupervised on the things that matter."

When a proposed feature requires breaking one of these, that is a charter-level
conversation (§10), not a pull request.

---

## 9. How it is open

The framework is **MIT licensed** throughout — embeddable in closed-source and
SaaS products, modifiable, re-distributable, with the license file and copyright
line preserved ([`LICENSE`](LICENSE), [`docs/LICENSE-FAQ.md`](docs/LICENSE-FAQ.md)).
Community templates carry their own CC0/MIT provenance, all commercial-use
compatible.

Openness here is not only a license; it is the architecture. Your workspace is a
directory you can read, copy, back up, and walk away with. There is no lock-in to
escape because there was never custody to begin with.

---

## 10. Amending this charter

This is a living document, but it is not edited casually. The further down a
change reaches, the higher the bar:

- **The North Star (§2)** is amendable only by explicit, deliberate consensus of
  the maintainers and the steward, in the open, with the reasoning recorded. It
  should almost never change. If it does, the project has become a different
  project, and that should be said out loud.
- **Everything else** evolves the way the rest of the repo does: a pull request
  that argues the *why*, reviewed against the North Star, merged by lazy
  consensus per [`GOVERNANCE.md`](GOVERNANCE.md).

If you are unsure whether something you want to build fits, this charter is the
document to argue with. That is what it is for.
