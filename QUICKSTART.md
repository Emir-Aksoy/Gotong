# AipeHub — QUICKSTART · 5 分钟上手漏斗

> **The promise / 承诺**: from a fresh clone to a real multi-participant result on
> your screen in about a minute — **no API key, no Docker**. Two more short steps
> take you to your own hub in the browser and to an agent that actually thinks.
>
> This is the do-this → see-that ladder. For concepts first, read
> [`docs/OVERVIEW.md`](docs/OVERVIEW.md); for the full install matrix, the
> **Quick start** section of [`README.md`](README.md).

**Prerequisites / 前置**: Node ≥ 20 and [pnpm](https://pnpm.io) for steps 1 & 3.
Step 2 also works with just **Docker** (no Node). Nothing else.

---

## 1 · See it work — no key, no Docker (~1 min) · 先看它真的跑起来

```bash
pnpm install && pnpm build      # first build takes a few minutes; later runs are instant
pnpm demo                        # the zero-key "hello-collab" hub
```

You'll see a writer agent, a reviewer agent, and a **human** named `alice`
collaborate on one task and land a result:

```text
  [seq=01] JOIN     writer (agent) caps=[draft,revise]
  [seq=02] JOIN     reviewer (agent) caps=[review]
  [seq=03] JOIN     alice (human) caps=[approve]
  ...
  [seq=04] TASK     system "write draft" via capability caps=[draft]
  [seq=05] RESULT   ok by writer
  [seq=07] RESULT   ok by reviewer          # reviewer critiqued the draft
  [seq=09] RESULT   ok by writer            # writer revised it
  👤 alice sees task "final approval" ...then approving.

=== final ===
Why TypeScript matters for large codebases: it catches whole categories of bugs
at compile time ... — revised note: mention IDE autocompletion as a day-to-day win.
```

**What you just saw** — two agents and one person collaborated over the **same**
message/task rails. In AipeHub a human and an agent are the *same* `Participant`:
`alice` didn't call a special "ask-a-human" tool — she received a task exactly
like the agents did. That's the whole point, and it ran **offline, deterministic,
zero key**. This is your "it works" moment.

More keyless demos to poke at:

```bash
pnpm demo:llm         # a mock LLM writer/reviewer (LLM-shaped, still no key)
pnpm demo:cafe-ops    # a small org workflow: new-hire onboarding + approval
```

Full gallery of runnable hubs → [`docs/zh/HANDS-ON-HUBS.md`](docs/zh/HANDS-ON-HUBS.md).

---

## 2 · Your own hub in the browser (~2 min) · 自己的 hub

```bash
docker compose up        # recommended — no Node setup; state persists under ./data
#   — or, from the built repo —
pnpm host
```

The host prints a next-step banner and (on a local first run) opens your browser
to the **setup wizard** — loopback only, **no token needed**:

```text
┌─ 下一步 / Next step ──────────────────────────
  打开浏览器完成 5 分钟设置 (设置向导,无需 token):
  Open your browser to finish the 5-minute setup:
      →  http://127.0.0.1:3000
└───────────────────────────────────────────────
```

In the wizard: name yourself, then **pick a provider — choose `Mock` to stay
keyless**, or paste a real key (next step). The master key is created for you
under `./data/runtime/secret.key`; you land logged-in at `/admin`.

**Won't start?** Run the pre-flight — it inspects the exact `AIPE_*` env the host
reads (Node version, ports free to bind, data dir writable, master key) and prints
✓ / ⚠ / ✖ per check with a one-line fix:

```bash
pnpm exec aipehub doctor          # report only
pnpm exec aipehub doctor --fix    # also creates a missing data dir (safe, reversible)
```

---

## 3 · Make an agent actually think (~2 min) · 接上真模型

In the wizard (or `/admin` → **Agents**) paste an LLM key — Anthropic, OpenAI,
DeepSeek, Ollama, or any OpenAI-compatible endpoint. The most common first-run
trap is a key that silently doesn't work; the wizard's **one-click probe** tells
you immediately (a bad key shows a "去补 key →" rescue button, a dead URL shows
"check the network") so you never stare at a frozen agent.

Prove that rescue path yourself — **no real key needed**:

```bash
pnpm check:onboarding    # hermetic: bad/empty key → "go add a key", network error → "check the URL"
```

Then give an agent real work: import a template (`/admin` → **Templates**, one
click), or run a workflow against a live model:

```bash
ANTHROPIC_API_KEY=sk-...  pnpm demo:llm:real
```

---

## 4 · Put it in your pocket — chat with your hub over IM (optional) · 装进口袋

Bind a Lark / Telegram / Slack / Discord bot and talk to your hub — and to your
always-on **personal butler** (it remembers you across chats, and can build and
fix your agents and workflows in plain language, each change gated by your
one-click approval) — from your phone. Home-first, zero public exposure:
[`docs/zh/GO-LIVE.md`](docs/zh/GO-LIVE.md) §一 (T1).

---

## Where next · 接着读哪

A ladder, not a pile — tutorial → reference → deep-dive:

| You want… | Read |
|---|---|
| The concepts in 5 minutes | [`docs/OVERVIEW.md`](docs/OVERVIEW.md) · [`docs/zh/OVERVIEW.md`](docs/zh/OVERVIEW.md) |
| Five example hubs to copy from | [`docs/zh/HANDS-ON-HUBS.md`](docs/zh/HANDS-ON-HUBS.md) |
| To deploy for real (3 topologies) | [`docs/zh/GO-LIVE.md`](docs/zh/GO-LIVE.md) |
| Why it's built this way (the charter) | [`CHARTER.md`](CHARTER.md) · [`docs/zh/CHARTER.md`](docs/zh/CHARTER.md) |
| To write your own agent in ~20 lines | [`docs/zh/OVERVIEW.md`](docs/zh/OVERVIEW.md) → Participant |

---

> **Honest timing.** The "~1 min / ~2 min" marks assume a warm `pnpm install`; the
> very first `pnpm build` compiles the whole workspace and takes a few minutes. The
> step-1 demo and the step-3 key-probe (`pnpm check:onboarding`) are runnable checks
> committed in the repo, so you can re-verify this ladder yourself at any time.
