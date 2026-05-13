# Contributing to AipeHub

Thanks for considering a contribution. AipeHub is an early-stage project
and we are happy to take patches, bug reports, design feedback, and
documentation improvements.

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
