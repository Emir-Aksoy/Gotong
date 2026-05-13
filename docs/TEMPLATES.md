# Agent / Team Templates

> ⚠️ **Where templates live**
>
> The **initial reference set** is in [`templates/`](../templates/) of
> the main repo. Once the project stabilises, the **public template
> library** will be split into its own repository — **`AipeHub/aipehub-templates`**.
> Community PRs will go there; the main repo will keep only a small
> "frozen for CI" subset so the parser tests have something to run.
>
> Until that split happens, PR into the main repo's `templates/` is
> still accepted — we'll migrate everything wholesale when we move.

AipeHub ships a small reference set of **standard agent and team
templates** in [`templates/`](../templates/). Anyone can pull one
through the admin UI, and anyone can PR new ones.

There are two parallel sets:

- [`templates/agents/`](../templates/agents/) + [`templates/teams/`](../templates/teams/) — **project-original**, written for AipeHub from scratch. Same MIT license as the project.
- [`templates/community/`](../templates/community/) — **adapted from third-party prompt libraries** ([`awesome-chatgpt-prompts`](https://github.com/f/awesome-chatgpt-prompts) (CC0) and [`awesome-chatgpt-prompts-zh`](https://github.com/PlexPt/awesome-chatgpt-prompts-zh) (MIT)). Each file's header records upstream source + license; [`templates/community/LICENSE-NOTICES.md`](../templates/community/LICENSE-NOTICES.md) aggregates the third-party licenses verbatim. Both license families allow commercial use. We rejected upstream sources marked "non-commercial", "research only", or unlicensed.

This doc covers:

1. The **file format** templates use (so you can write your own)
2. How the **import flow** works end-to-end
3. How to **contribute** a new template

If you just want to use existing templates, [`templates/README.md`](../templates/README.md) is the short version.

---

## 1. File format

Templates are YAML or JSON. Both are accepted at import; YAML is
recommended for human-edited templates because it has comments and is
easier to skim.

### Schema strings

Every manifest starts with a `schema` line identifying the version and
shape:

```yaml
schema: aipehub.agent/v1    # single agent
# or
schema: aipehub.team/v1     # multiple agents bundled
```

Unknown schemas are rejected with a clear error message. We'll bump to
`/v2` when we make a breaking change.

### Single-agent (`aipehub.agent/v1`)

```yaml
schema: aipehub.agent/v1
agent:
  id: writer-zh                  # required, unique in the space
  displayName: 中文写作助手       # optional, shown next to the id in the UI
  capabilities: [draft]          # required, non-empty array of strings
  kind: llm                      # only 'llm' today (defaults to llm if omitted)
  provider: anthropic            # 'anthropic' | 'openai' | 'mock'
  model: claude-opus-4-7         # optional, passed through to the provider
  weightDefault: 2.0             # optional, default Task.weight when dispatching to this agent
  system: |                      # required, the system prompt
    You are a brief Chinese writer.
    - 200-400 words.
    - no preamble.
```

### Team (`aipehub.team/v1`)

```yaml
schema: aipehub.team/v1
team:
  name: 中文编辑团队              # optional
  description: 写作 + 审稿        # optional
  agents:
    - id: writer-zh
      capabilities: [draft]
      kind: llm
      provider: anthropic
      model: claude-opus-4-7
      system: |
        You write briefly.
    - id: reviewer-zh
      capabilities: [review]
      kind: llm
      provider: anthropic
      model: claude-opus-4-7
      system: |
        You review and return one suggestion.
```

Each entry under `team.agents` is the same shape as `agent` in the
single-agent schema. Duplicate ids inside one team are rejected.

### Field-level rules

| Field | Rule |
|---|---|
| `id` | Required. Pattern `[a-zA-Z0-9_.:-]+`, max 80 chars. URL- and JSON-safe — they end up in URL paths and cookie payloads. |
| `displayName` | Optional. Free text, max 80 chars. |
| `capabilities` | Required, non-empty array of non-empty strings. These are what `dispatch({ strategy: { kind: 'capability', capabilities: [...] } })` matches against. |
| `kind` | Defaults to `llm`. Today `llm` is the only allowed value. |
| `provider` | Required. Must be one of `anthropic`, `openai`, `mock`. |
| `model` | Optional. Pass-through to the provider — you're responsible for matching the provider's accepted model strings. |
| `system` | Required, non-empty. The agent's system prompt. |
| `weightDefault` | Optional. Number in [0.1, 10.0]. Sanitised by the Hub anyway. |

API keys **never** appear in a template. Keys come from three sources
(see [HUMAN.md](./HUMAN.md) "API Key 管理"):

1. Per-agent override set in the admin UI (encrypted at rest in
   `<space>/secrets.enc.json`)
2. Workspace default for the provider (same file)
3. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` env var on the host

If a template uses `provider: anthropic` but **none** of the above
supplies a key, the import is rejected with a clear message. The fix
is "open the API Key 管理 panel and set a workspace key, then re-import."

---

## 2. Import flow

End-to-end (admin UI):

```
templates/teams/editorial-zh.yaml          (file on GitHub)
              │ copy raw URL → paste
              ▼
Admin UI ─── 导入 ─── parseManifest()
              │
              ├── schema check                (reject if unknown)
              ├── per-agent validation       (id pattern, caps non-empty, ...)
              ├── provider availability      (reject if env key missing)
              │
              ▼
agents.json   ◀──── upsertAgent per entry
              │
              ▼
AgentSupervisor.start(record)
              │
              ▼
hub.register(new LlmAgent({ ... })) ─────► transcript: participant_joined
              │
              ▼
SSE → admin UI → 智能体列表 re-renders with online: true
```

Three things can fail along the way; each maps to a 4xx the UI shows verbatim:

- **Malformed schema / YAML** — `400` with the parser's diagnostic
- **Provider unavailable** — `400 agent '<id>' uses provider '<x>' which is not available on this host`
- **Duplicate id** — `409` (UI suggests editing instead)

If the API call succeeds but the **supervisor's spawn fails** (e.g. the
provider library throws during construction), you get a `200 OK` with a
`spawnErrors: [{id, error}]` array. The record stayed on disk so you can
edit + retry without re-uploading.

---

## 3. Contributing a new template

The full process is in
[`templates/CONTRIBUTING.md`](../templates/CONTRIBUTING.md). TL;DR:

1. Pick a filename. Single agent → `templates/agents/<id>.yaml`. Team →
   `templates/teams/<id>.yaml`.
2. Write the manifest. Use the schema described above.
3. **Test it locally** against a real provider — push at least one task
   through `pnpm host` and verify the output looks reasonable.
4. PR the file. Update `templates/README.md`'s directory listing if
   your file is in a new sub-category.

### What the reviewer checks

- File parses cleanly (the manifest-parser test suite runs all templates
  in CI)
- `system` prompt is in the same language as the target user (中文
  agents have 中文 prompts; English agents have English prompts)
- `id` doesn't clash with an existing template
- Provider + model pairing actually works (we can't always verify this
  in CI, so reviewers spot-check)
- Capability strings follow the project's loose convention (verb-like:
  `draft`, `review`, `translate`, …)

### What we won't accept (today)

- Templates that bake an API key into the file
- Templates with prompt-injection-style content meant to subvert other
  agents
- Templates that depend on private / unreleased provider models

---

## 4. Versioning rules

Templates ship under MIT (same as the project). Once a template is
merged:

- **Editing a `system` prompt** for the same `id` is fine — anyone who
  imported the old version keeps their copy on disk; the new prompt
  affects future imports only.
- **Renaming** a template means a deprecation period: add `#
  DEPRECATED: see <new-id>` to the top, keep the file 30 days, then
  delete. Old imports are unaffected — the persisted record is on the
  user's disk.
- **Breaking the manifest schema** means bumping `aipehub.agent/v2` —
  the parser will keep accepting `/v1` for at least one minor release.

---

## 5. Operator tips

- The supervisor logs `[supervisor] spawned <id> (provider=<x>)` on
  every spawn — easy to grep on boot to verify your `agents.json` is
  intact.
- `agents.json` is plain JSON; nothing stops you from `git`-tracking
  your space's `agents.json` separately from the AipeHub repo, so your
  team's curated agent set survives across machine moves.
- For tests / CI you can pre-seed `agents.json` before starting the
  host — the supervisor will replay it like any other boot.
