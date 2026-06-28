# Contributing to AipeHub

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](docs/zh/CONTRIBUTING.md) · [日本語](docs/ja/CONTRIBUTING.md) · [Русский](docs/ru/CONTRIBUTING.md) · [Français](docs/fr/CONTRIBUTING.md) · [Español](docs/es/CONTRIBUTING.md) · [한국어](docs/ko/CONTRIBUTING.md). If a translation conflicts with this English version, the English version governs.

Thanks for considering a contribution. AipeHub is an early-stage project
and we are happy to take patches, bug reports, design feedback, and
documentation improvements — **and we mean every kind of contribution, big
or small.** Building something new and *carrying the project to people* both
count: a one-line typo fix, a whole importable hub, a translation, a tutorial
video, a talk that brings people in. All of it is recognized — see
[`CONTRIBUTORS.md`](CONTRIBUTORS.md), the curated learning showcase
[`LEARN.md`](LEARN.md), and why we do it in
[`docs/RECOGNITION-SYSTEM.md`](docs/RECOGNITION-SYSTEM.md).

## Ground rules

- **Be kind.** Treat anyone in the issue tracker / PRs the way you'd
  want a senior engineer to treat you on a bad day.
- **Small PRs.** Independent changes ship faster than mega-PRs. If a
  feature splits cleanly, send the parts separately.
- **The Hub stays dumb.** AipeHub's whole design idea is that the Hub
  routes / persists and does not own agent logic. Patches that put LLM
  calls, agent loops, or business rules into the Hub will be redirected.
- **Wire protocol is versioned.** Anything that changes the
  protocol-level message shapes goes through `docs/PROTOCOL.md` and a
  protocol-version bump. Local-only changes do not.
- **No surprise dependencies.** Adding a runtime dep (especially native
  ones) is a real decision — open an issue first.

## Workflow

```bash
# fork on GitHub, then:
git clone git@github.com:<you>/AipeHub.git
cd AipeHub
pnpm install
pnpm build

# make changes…

pnpm -r typecheck      # all 19+ packages typecheck clean
pnpm -r test           # vitest across packages
pnpm test:python       # python-sdk pytest
```

Conventions:

- TypeScript strict mode, ESM with `.js` import extensions on relative
  imports (TypeScript's "node16/nodenext" resolution requires this).
- Tests live next to the code they cover (`packages/*/tests/`).
- Lint isn't enforced by a tool yet; match the style of existing files.
- Commit messages: imperative ("add foo", not "added foo"). One
  paragraph for non-trivial commits is welcome.

## Repository layout

```
packages/
  core/           Hub + registry + scheduler + transcript + Space
  protocol/       Wire-protocol types (zero runtime)
  transport-ws/   Hub-side WebSocket adapter
  sdk-node/       Node SDK for remote agents (connect + AgentParticipant)
  web/            Embeddable web server + static SPA
  host/           Production binary (env-driven, no demo state)
  llm/            LlmAgent base class + LlmProvider interface
  llm-anthropic/  Anthropic provider
  llm-openai/     OpenAI provider
python-sdk/       Python SDK (mirror of sdk-node)
examples/         Runnable demos
docs/             Long-form architecture / protocol / deploy docs
```

## Areas to chip away at

If you want a low-context starter task, look for issues labelled
`good-first-issue`. Some always-welcome themes:

- **Documentation**: typos, clearer examples, translations (the project
  has Chinese-speaking maintainers; English-only docs are still
  thinner).
- **Test coverage**: especially for the scheduler edge cases and the
  Space's on-disk migration paths.
- **Additional LLM providers**: copy the shape of `packages/llm-anthropic`.
- **A11y / i18n in the admin UI**: vanilla JS, no framework, small
  surface area.

## Contributing a template

You don't have to write TypeScript to contribute. AipeHub ships **templates** —
self-contained YAML that someone imports to get a working hub (agents +
workflows + knowledge-base references, never secrets or knowledge content).

- A single adapted prompt → [`templates/community/`](templates/community/).
- A whole importable hub (multi-agent + workflows) →
  [`templates/community/templates/`](templates/community/templates/) — that
  README walks the 5-step flow: copy a flagship example, adapt it, declare
  provenance (`derivedFrom`), validate locally with `pnpm check:templates`,
  open a PR.

The bar to be *merged as a community template* (license is clear, it parses,
no literal secrets) is lower than the bar to be *shipped as a flagship*
(deterministic demo, stated governance posture, maintained). See
[`GOVERNANCE.md`](GOVERNANCE.md).

## Spreading the word counts too

You don't have to ship code *or* a template to contribute. Carrying AipeHub to
people — a blog post, a tutorial, a talk, a video, a translation, answering
newcomers in Discussions — is real work, and in our experience most open source
under-credits it. **We don't.** A good product only gets better by reaching
people, and recognizing the people who do that reaching is **pillar ⑤** of the
recognition system (see [`docs/RECOGNITION-SYSTEM.md`](docs/RECOGNITION-SYSTEM.md)).

- **Every effort is recorded, big or small.** Open a PR adding yourself (or
  someone else) to [`CONTRIBUTORS.md`](CONTRIBUTORS.md) with the matching emoji —
  📹 video, 📢 talk, 📝 blog, 🌍 translation, 💬 community. A significant spread
  effort lands in the GitHub record the same as a merged feature; no effort is
  too small to record.
- **Made a good video or tutorial? It's one format PR.** Add an entry to
  [`LEARN.md`](LEARN.md) in the listed format and open the PR — that is the whole
  flow. If it is accurate and genuinely useful, a maintainer curates it onto the
  page newcomers learn from, and you get credited.

We recognize the *work of reaching*, not a reach number — there is no view-count
or follower leaderboard. See the honest boundary in
[`docs/RECOGNITION-SYSTEM.md`](docs/RECOGNITION-SYSTEM.md#4-what-we-dont-do-honest-boundary).

## Reporting bugs

A useful bug report has:

- What you tried (full command line, full env vars)
- What you expected
- What happened (full error output if any, `transcript.jsonl` excerpt
  if the bug is in routing / persistence)
- Versions: `node --version`, `pnpm --version`, OS

For network-shape bugs (workers disconnecting, agents not being routed
to), include the `/api/state` snapshot — it's the canonical "what does
the hub think is happening".

## Security

Security issues do **not** belong in the public issue tracker. See
[`SECURITY.md`](SECURITY.md).

## License

By contributing you agree your work is offered under the
[MIT license](LICENSE) used by the project. No CLA.
