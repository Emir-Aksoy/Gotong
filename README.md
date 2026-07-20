# Gotong

<!-- doc-version: 1.0 -->
> **Doc version 1.0** · English (authoritative source) · Updated 2026-06-27 · Translations: [中文](docs/zh/README.md) · [日本語](docs/ja/README.md) · [Русский](docs/ru/README.md) · [Français](docs/fr/README.md) · [Español](docs/es/README.md) · [한국어](docs/ko/README.md). If a translation conflicts with this English version, the English version governs.

[English](README.md) · [中文文档](docs/zh/README.md)

**Gotong** — from *gotong-royong*, the Malay–Indonesian tradition of a whole village shouldering work together (Chinese: 共同) — a self-hosted substrate where people and AI agents collaborate as equal participants, and organizations federate without handing over their keys, data, or billing.

Gotong is not an agent — and not another agent framework. It's the **layer underneath them**: a registry, a message bus, a task router, a governed federation link, and an append-only transcript. LangGraph / CrewAI agents, CLI coding agents (Claude Code, Codex), and humans all plug in as the same `Participant`. The Hub keeps the signals flowing and the boundaries enforced — it never runs the LLM, so every decision stays with the participants.

### AI you can actually trust with the consequential stuff

Most AI tools give you two options: hand everything to a cloud you don't control, or wire it all together yourself. Gotong is the third option — **AI you can point at your home, your family, or your money, because the boundaries are real and yours:**

- **A human is in the loop where it matters.** Reversible actions (turn off the lights) just happen; irreversible ones (lock the door, spend money, send a child's data across a link) wait for a person to confirm in an inbox. The workflow can't skip the gate.
- **Your keys and data stay on your disk.** Credentials live encrypted in your own `.gotong/` directory. Federating with another hub shares a capability, not your vault.
- **Nothing decides in the dark.** Every dispatch and result is an append-only transcript you can read. The framework never runs the model, so there's no hidden judgment call.

Fronting all of this for each member is **Atong (阿同)** — the resident personal butler: it remembers you across sessions, runs errands through your connected tools, and parks anything consequential (spending money, messaging outsiders) in your inbox until you approve. The name rides on Go**tong** — 同 as in 共同, your "together" companion. ([Design doc](docs/zh/PERSONAL-BUTLER-DESIGN.md), zh.)

→ See the [**flagship templates**](docs/zh/FLAGSHIP-TEMPLATES.md) for hubs a non-technical person can import and run today (smart home, café ops, a family learning hub, a personal coding hub), each with the governance gate shown plainly and a one-command demo. Want to share your own? [`templates/community/templates/`](templates/community/templates/).

## Core ideas

- **The Hub is dumb on purpose.** It does not run LLMs or own agent loops. It routes messages, dispatches tasks, persists the transcript, and emits events. Decisions stay with participants.
- **Humans are first-class.** A human is a `Participant` like an agent is. The Hub's async / long-running primitives apply to both.
- **One interface, two deployment shapes.** Agents implement the same `Participant` contract whether they run in-process or across the network. Local and remote agents share the same registry and the same scheduler.
- **Pluggable scheduling.** Three task-routing strategies out of the box: explicit assignment, capability matching, and broadcast claiming.
- **Bring your own LLM.** A small `LlmAgent` base class + a neutral `LlmProvider` interface let you back an agent with Claude, GPT, or any other model without touching the Hub.

## Status

**Self-hosted, file-first, and governed for multi-org use.** A workspace is a directory on disk (`.gotong/`) — drop the directory and the space is gone; copy it and you've handed the room to a teammate; restarts are transparent. On top of that: a per-org credential vault, cross-org federation with per-link trust contracts (capability allowlist · data-class gate · quota · revocation), human-in-the-loop approval inboxes, and a usage / cost ledger. The Hub still never runs an LLM — every decision stays with the participants.

The npm packages are scoped `@gotong/*`; the Python SDK is `gotong` on PyPI. License: [MIT](LICENSE) — permanently: we [commit to never relicensing](GOVERNANCE.md#license-permanence).

## Pick your door

> **Lost?** Start at [`docs/OVERVIEW.md`](docs/OVERVIEW.md) — a single page that ties usage, license, agent on-boarding, template downloads, multi-user teams, and multi-team federation into one narrative. The table below is the by-role drill-down.

| You are… | Read this | TL;DR |
|---|---|---|
| 🧭 **First time here** | [`docs/OVERVIEW.md`](docs/OVERVIEW.md) | 5-minute map of every concept + a "small-team workflow" walkthrough. |
| 🧑 **A worker / admin joining a room** | [`docs/HUMAN.md`](docs/HUMAN.md) | Open the URL the operator gave you; pick a nickname; you're in. |
| 🤖 **Writing an agent to plug in** | [`docs/AGENT.md`](docs/AGENT.md) | `@gotong/sdk-node` or Python `gotong`. Subclass `AgentParticipant`. |
| 🧩 **Bringing in an LLM agent without writing code** | [`docs/TEMPLATES.md`](docs/TEMPLATES.md) + [`templates/`](templates/) | YAML manifest → paste / upload in admin UI → host spawns it for you. Two sets: project-original (`templates/agents/`) and CC0/MIT community-adapted (`templates/community/`). |
| ⭐ **Just want a hub that does something useful** | [`docs/zh/FLAGSHIP-TEMPLATES.md`](docs/zh/FLAGSHIP-TEMPLATES.md) (zh) | Curated, trust-framed gallery — import one and it works. Smart home, café ops, family learning, personal coding. Each shows what it can/can't touch + a no-key demo. |
| 👨‍👩‍👧 **Setting up a family / home hub** | [`docs/zh/FAMILY-HUB.md`](docs/zh/FAMILY-HUB.md) (zh) | One AI butler for the whole family: per-member accounts & roles, credentials in an encrypted vault members can't read, outbound actions parked for a parent's approval. One-click gallery template + a 15-minute out-of-box checklist; threat model in [`docs/zh/THREAT-MODEL.md`](docs/zh/THREAT-MODEL.md). |
| 🔧 **Running the server** | [`docs/DEPLOY.md`](docs/DEPLOY.md) | `pnpm host` for local, Caddy + systemd for public. |
| 🚀 **Going live (3 topologies)** | [`docs/zh/GO-LIVE.md`](docs/zh/GO-LIVE.md) + [`deploy/`](deploy/) | Home host + IM, cloud host + IM, or cloud + direct IP. Copy `deploy/.env.home` / `.env.cloud`, follow the runbook. IM bridge is outbound long-poll → a NAT'd home box needs no tunnel. (Runbook is zh; English pending.) |
| 🪢 **Federating two hubs (team → org)** | [`docs/FEDERATION.md`](docs/FEDERATION.md) | `TeamBridgeAgent` makes a whole sub-Hub appear upstream as one agent — keeps internal members / keys / sub-tasks private. |
| 🔌 **Driving a Hub from Claude Desktop / Cursor / Cline** | [`docs/MCP.md`](docs/MCP.md) | `@gotong/mcp-server` is an MCP bridge — 5 tools (list / dispatch / evaluate / leaderboard / tasks). Add 5 lines to your MCP client config. |
| 🧰 **Giving your agents the MCP tool ecosystem** | [`docs/MCP.md`](docs/MCP.md#6-outbound--using-third-party-mcp-tools-from-your-agent) | `@gotong/mcp-client` lets your Gotong agents attach Filesystem / GitHub / Slack / Postgres / any MCP server. `LlmAgent` runs a multi-turn tool-use loop out of the box (v0.3+) — just pass `tools: toolset` and Claude / GPT decide when to call which tool. |
| ⚖️ **Worried about license / commercial use** | [`docs/LICENSE-FAQ.md`](docs/LICENSE-FAQ.md) | MIT throughout. Embeddable in closed-source / SaaS. Community templates are CC0 + MIT. |
| 🧠 **Designing on top of it** | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) + [`docs/PROTOCOL.md`](docs/PROTOCOL.md) | Hub is dumb on purpose; wire protocol is v1.0. |
| 📊 **Sizing a deployment** | [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) + [`docs/zh/CLOUD-RESOURCE-FOOTPRINT.md`](docs/zh/CLOUD-RESOURCE-FOOTPRINT.md) | Pre-launch baseline numbers + how to rerun the load test against your own hardware. The zh doc adds a **real production measurement** (Feishu + MiMo, single hub on a 2 vCPU / 2 GiB box) with per-load capacity estimates and upgrade triggers — steady state is ~110–160 MiB RAM and ~0 CPU because inference runs on the LLM provider, not the host. |
| 🛟 **Operating in production** | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | Backup/restore playbook, disaster-recovery drill, `secret.key` handling, troubleshooting. |
| 📡 **Monitoring + alerts** | [`docs/MONITORING.md`](docs/MONITORING.md) | Prometheus scrape config, 7 alert rules with runbooks, Grafana dashboard JSON. |

### Adding an agent — two paths

|  | Host-managed (no code) | External SDK (your code) |
|---|---|---|
| **You do** | Paste / upload a YAML manifest in admin UI | Write `AgentParticipant.handleTask`, call `connect(url, agents)` |
| **Where it runs** | Inside the Hub process (LocalAgentPool) | Anywhere on the network |
| **What it can do** | LLM tasks via Anthropic / OpenAI / Mock providers | Anything — LLMs, scrapers, private data, ML models, scripts |
| **API key lives** | Encrypted in `.gotong/secrets.enc.json` (per-agent or workspace default) | Wherever your code reads it |
| **On restart** | Auto-respawned by `LocalAgentPool` | Your code reconnects (SDK has built-in auto-retry) |
| **Best for** | End users • standard roles • one-click templates | Developers • private logic • cross-language workers |
| **Read** | [`docs/TEMPLATES.md`](docs/TEMPLATES.md) | [`docs/AGENT.md`](docs/AGENT.md) |

Both paths plug into the same Hub. Mix freely — a room can have host-managed `writer-zh` next to your private SDK-connected `rag-agent`.

What this project is — and what it refuses to become: [`CHARTER.md`](CHARTER.md). Contributing? See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: [`SECURITY.md`](SECURITY.md). Version history: [`CHANGELOG.md`](CHANGELOG.md).

**Learn by watching** → [`LEARN.md`](LEARN.md) curates the best community-made videos, talks, and tutorials, each credited to its author. **Everyone who builds *and spreads* Gotong** → [`CONTRIBUTORS.md`](CONTRIBUTORS.md) — because reach is real work, and [we recognize it](docs/RECOGNITION-SYSTEM.md#pillar-5).

## Quick start

> **New here?** [`QUICKSTART.md`](QUICKSTART.md) is the do-this → see-that ladder:
> clone → a real multi-participant result on screen in ~1 min (no key, no Docker) →
> your own browser hub → a thinking LLM agent. The install matrix below is the
> reference; the ladder is the fast path.

### Non-technical user? Double-click, zero Node/Docker

The path that needs **no terminal, no Node, no Docker** on the machine that runs
it. A maintainer builds a self-contained portable bundle once:

```bash
node scripts/build-portable.mjs        # → dist-portable/Gotong-macos-arm64/
```

Then hand the whole `Gotong-macos-arm64/` folder to anyone. They **double-click
`Gotong.command`** → the browser opens the 5-minute setup wizard. The bundle
ships its own pinned Node runtime + the compiled host + a real on-disk
`node_modules` (including the native SQLite binding), so it runs the **full**
identity-backed host on a machine with nothing installed. Data lives in
`~/.gotong` (outside the folder), so replacing the bundle never loses data.

Built on demand, not a committed/published download yet (that's the post-1.0
plan) — for now "download & run" means *build the folder once, share the folder*.
macOS arm64 this round. Full write-up: [`docs/zh/PORTABLE-BUNDLE.md`](docs/zh/PORTABLE-BUNDLE.md).

### Get running in 30 seconds — pick one

```bash
# A. npx (fastest — Node ≥ 20, nothing to clone)
npx gotong start
# → boots the full hub; first run pulls the closure once (~160MB), later runs are instant

# B. Docker (no Node setup, works on macOS / Windows / Linux)
docker compose up
# → http://127.0.0.1:3000  (setup wizard — no token needed on loopback)
# → state persists under ./data

# C. From source (cloned repo, full demo set available)
pnpm install
pnpm build
pnpm host
```

All three boot the same binary. Open the printed setup-wizard URL → you're in.
(The token-bearing `/admin` URL is the backup path and lives in
`<space>/runtime/admin-link.txt`, mode `0600` — it is never printed, so log
shippers never see it.)

**First-run nicety (new).** After boot the host prints a prominent next-step
banner pointing at the loopback setup wizard, and on a local (loopback) first
run it opens your browser there for you:

```text
┌─ 下一步 / Next step ──────────────────────────

  打开浏览器完成 5 分钟设置 (设置向导,无需 token):
  Open your browser to finish the 5-minute setup:

      →  http://127.0.0.1:3000

  设置向导在本机回环 (loopback) 上运行。
  The setup wizard runs on loopback only.
└───────────────────────────────────────────────
  (已自动打开浏览器 / browser opened — GOTONG_OPEN_BROWSER=0 关闭)
```

`GOTONG_OPEN_BROWSER` controls the auto-open: unset = `auto` (first local run
only), `1`/`always` = every start, `0`/`never` = off. It is also forced off
whenever the host is network-exposed — a headless server never pops a browser,
and the wizard isn't reachable there anyway (that path uses the admin-token
file). The banner itself always prints.

> 💡 **Distribution.** Published on npm as the unscoped meta package
> [`gotong`](https://www.npmjs.com/package/gotong) (pulls `@gotong/cli` +
> `@gotong/host` into the install closure) plus the 35 `@gotong/*` workspace
> packages; the Python SDK ships on PyPI as `gotong`. Docker (B) and source (C)
> remain fully supported; the publish discipline (gates, OTP, rollback =
> deprecate never unpublish) lives in
> [docs/zh/PUBLISH-RUNBOOK.md](docs/zh/PUBLISH-RUNBOOK.md).

CLI flags (from a built repo):

```bash
pnpm exec gotong-host --help       # full env-var reference
pnpm exec gotong-host --version    # current host version
```

After it boots, follow [`docs/OVERVIEW.md`](docs/OVERVIEW.md) for the "what now" walkthrough.

**Won't start?** Run a pre-flight check before booting — it inspects the exact
`GOTONG_*` env the host reads (Node version, ports actually free to bind, data dir
writable, master key) and prints, per check, ✓ / ⚠ / ✖ with a one-line fix:

```bash
pnpm exec gotong doctor          # report only
pnpm exec gotong doctor --fix    # also auto-creates a missing data dir (the one safe, reversible repair)
```

And if a boot *does* fail, the host turns the common, recoverable failures
(port already in use, no permission to bind a port, missing/invalid master key,
data dir not writable, disk full) into a one-line human message naming which
`GOTONG_*` var to change — not a stack trace. See the troubleshooting section in
[`docs/zh/GO-LIVE.md`](docs/zh/GO-LIVE.md) §十一.

**Verify the key probe works (no real key needed).** The most common first-run
trap is a pasted LLM key that silently doesn't work. The setup wizard catches
this with a one-click "去补 key" rescue path; this command walks that same probe
end to end so you know the rescue path is wired before you onboard:

```bash
pnpm check:onboarding          # hermetic — proves a bad/empty key → "go add a key", a network error → "check the URL"
ANTHROPIC_API_KEY=… pnpm check:onboarding   # also round-trips a REAL key over the wire (opt-in; skipped without one)
```

It's hermetic by default (no network, no spend) and never logs your key.
Exit 0 = every check that ran passed. The opt-in real-key check mirrors the
live gate's env contract (`OPENAI_API_KEY` + `OPENAI_BASE_URL=https://api.deepseek.com`
+ `GOTONG_LIVE_OPENAI_MODEL=deepseek-chat` for the DeepSeek path).

### Deploy to a cloud server (VPS)

Got a fresh Ubuntu/Debian box? One command fetches the code (the repo is
public) and provisions a systemd service:

```bash
curl -fsSL https://raw.githubusercontent.com/Emir-Aksoy/Gotong/main/deploy/cloud-quickstart.sh \
  | sudo bash -s -- --clone
# already have a checkout on the box:  sudo bash deploy/cloud-quickstart.sh
#   preview first, mutates nothing:    bash deploy/cloud-quickstart.sh --dry-run
```

It installs Node + pnpm, builds, creates the `gotong` service user and data
dir, drops in `/etc/gotong.env` (from [`deploy/.env.cloud`](deploy/.env.cloud)),
and installs a systemd unit that mirrors [`docs/zh/DEPLOY.md`](docs/zh/DEPLOY.md)
§C.4. It **stops one step short of starting** — the env file ships with the
domain / master key / host-allowlist blank, and exposing an unconfigured box is
unsafe. It prints the safe last mile: fill the env, run
[`scripts/cloud-harden.sh`](scripts/cloud-harden.sh) (perimeter check), put Caddy
+ a firewall in front, then `systemctl enable --now gotong`.

> There is **no browser "one-click deploy" button** while the repo is private
> (those need a public repo or a provider account pre-linked to your git). This
> copy-pasteable bootstrap is the real, testable equivalent. Full runbook —
> topology, IP-exposure risks, IM member onboarding: [`docs/zh/GO-LIVE.md`](docs/zh/GO-LIVE.md).

### 个人模式 (新, v4 Phase 7) — 一个人用 AI 干活, 0 配置

如果你就一个人, 想把 Gotong 当成"我的 AI 桌面"用 (不是给团队开 hub),
直接 `docker compose up` 就行 — host 第一次启动检测到只有你一个用户,
**自动进入个人模式**:

```bash
docker compose up
# → http://127.0.0.1:3000 (回环设置向导, 无需 token; 带 token 的备用链接在
#   ./data/runtime/admin-link.txt, mode 0600 — 永不打印进日志)
# → 首屏顶部不显示 "owner" 角色 chip (个人用户不需要看见组织角色)
# → 副标题写"我的 AI 桌面"(不是"管理员控制台")
# → 设置 tab 出现 [升级到团队模式] 按钮 — 哪天想拉人就点一下
```

个人模式与团队模式的差别就两点:
- 主页副标题文案不同 / role chip 隐藏
- 设置里多个升级按钮

**所有 admin tab 都还在**(用户管理 / peer / 配额 / audit 全可见),
但你不会被这些概念占满屏幕。需要时再用。

`GOTONG_MODE=team` 可以强制 pin 团队模式(即使只有一个用户);
`GOTONG_MODE=personal` 反过来——多用户时也强制 pin 个人模式(罕见,
通常给 dev / 测试场景)。

升级到团队后, 自动出现"邀请用户"流程, 跟着导出 admin URL 给团队成员;
路径见下一节 5-min personal growth workflow 或 [`docs/zh/OVERVIEW.md`](docs/zh/OVERVIEW.md)。

### 5-minute personal growth workflow (新)

The first ready-to-run shipped experience. 7 教练 (访谈 + 身体 / 心理 / 目标 / 资源 / 关系 + 综合规划师) 跑一遍 → 一份 markdown 12 周墙上计划落到磁盘。Default LLM 是 **DeepSeek**(国内可达、便宜)。

```text
1. 装好 host (Docker 或源码,见上)
2. 打开打印的设置向导 URL → 走完向导 → 进 admin
3. 申请 DeepSeek API key: https://platform.deepseek.com (新用户送 10 元额度,够跑几十次)
4. Admin → 工作流 tab → 点 [导入团队 (bundle)] → 点 [🎁 用内置模板:个人成长]
   → 粘贴 DeepSeek key → [导入]
   (7 个 agent 一键创建,workflow 自动注册)
5. 工作流卡片上点 [开始] → 弹 4 段表单 (现状 / 愿望 / 卡点 / 这次最想想清楚什么)
6. 派发 → 等 ~3.5 分钟 (7 次 DeepSeek API call)
7. 工作流 tab 滚到底 → "成长报告" 面板 → 点 [下载]
   或: <space>/services/artifact/file/agent/growth-synthesist/reports/<caseId>/<date>.md
```

报告里有:画像 + 身体/心理/目标/资源/关系 五份维度分析 + 一句话发展路径 + **12 周墙上计划** (主线 + 副线,每周做什么) + **5 个权衡判断** + "做不到怎么办" 降级方案 + "v2 跑工作流时建议你回答的 5 个种子问题"(下次回来用)。

> 🙏 **关于隐私 / 数据**:你的 4 段自述会发给 DeepSeek (中国大陆服务器) 做推理。Workflow 跑完后,所有产出落在你自己电脑的 `.gotong-*/services/` 目录,不会上传任何云。每位教练都设计成有边界的陪伴者 — 身体教练触及红旗(持续胸痛 / 不明出血等)会让你找医生;心理教练触及风险信号会给出 24h 危机热线(全国 400-161-9995 / 马来西亚 Befrienders 03-7956 8144)。**这不是医生 / 心理咨询师 / 财务顾问 / 关系治疗师的替代品。**

想换 Anthropic Claude 或 OpenAI?编辑 `templates/teams/personal-growth-team.yaml`,把每个 agent 的 `provider` / `baseURL` / `model` 改掉就行 — system 提示词跟 vendor 无关。

### Logging

Structured logging is **on by default** — JSON line per event when stdout is piped (for `jq` / Loki / ELK / Datadog), pretty-printed when stdout is a terminal. Three env vars control it:

```bash
GOTONG_LOG_LEVEL=info       # silent | trace | debug | info (default) | warn | error | fatal
GOTONG_LOG_FORMAT=json      # json | pretty (default: auto by TTY)
GOTONG_LOG_DISABLED=1       # hard-off escape hatch
```

Filter by component with `jq` once you've got JSON output:

```bash
pnpm host 2>&1 | jq 'select(.comp == "local-agents")'
```

### Demos (cloned repo)

Once you've `pnpm install && pnpm build`-ed, every collaboration pattern in the framework has a runnable demo:

```bash
# in-process demos (no network)
pnpm demo                # two mock agents + one mock human
pnpm demo:broadcast      # three reviewers race, losers cancelled

# persistence demos
pnpm demo:persist:fresh && pnpm demo:persist:resume
pnpm demo:persist:sqlite:fresh && pnpm demo:persist:sqlite:resume

# remote agents
pnpm demo:remote         # host + worker in separate processes
pnpm demo:remote:python  # Node host + Python worker (cross-language)
pnpm demo:cli-human      # terminal-as-human approval loop

# LLM-backed agents
pnpm demo:llm            # LlmAgent + mock provider (no API key needed)
pnpm demo:llm:real       # real Claude/GPT (needs ANTHROPIC_API_KEY/OPENAI_API_KEY)

# v2.0 full stack — web UI + agent admission + tasks panel
pnpm demo:open-space
pnpm demo:federated-team # one Hub joins another Hub as a single agent
```

### 上手案例 — 5 个开箱即用的 hub (Hands-on hubs)

Beyond the pattern demos above, five `examples/` cases are **complete, copy-able hubs** —
each ships a deterministic no-key demo *and* a one-file loadable template (agents + workflows
+ KB wiring). Three personal ("我的 AI 桌面"), two organization (team-mode):

```bash
# personal hubs (router LLM orchestrates sub-agents / CLIs)
pnpm demo:personal-coding-hub      # routes Claude Code + Codex on a shared repo
pnpm demo:personal-research-hub    # compiles raw sources into a linked Obsidian wiki
pnpm demo:battle-monk-training     # a growth coach writing state into a persistent Codex

# organization hubs (declarative workflows + surface.me self-service + human: HITL approval)
pnpm demo:cafe-ops                 # 奶茶/咖啡店: onboarding / shifts / overtime, manager approves
pnpm demo:bar-ops                  # 酒吧: 年龄核查事件复核 (合规 when 门控, 经理审批) + 深夜薪倍率
pnpm demo:warband-club             # a fan club collaborating over one shared archive
```

Pick one, see the deterministic demo, then go live with real DeepSeek + Obsidian —
the full catalog and go-live runbook is **[`docs/zh/HANDS-ON-HUBS.md`](docs/zh/HANDS-ON-HUBS.md)**.

## Embedded — everything in one process

```ts
import { Hub, Space } from '@gotong/core'

// v2.0: bind to a directory; admins, workers, transcript all live here
const { space, adminToken } = await Space.openOrInit('.gotong', {
  name: 'my-space',
  adminDisplayName: 'Operator',
})
console.log(`Admin URL once: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()
hub.register(new MyAgent())
hub.register(new MyHumanAdapter())

const result = await hub.dispatch({
  from: 'admin',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'why TypeScript' },
})

// for tests / in-process demos with no persistence:
const tmp = Hub.inMemory()
```

## Distributed — agents connect from another process / machine

Host process (the Hub):

```ts
import { Hub } from '@gotong/core'
import { serveWebSocket } from '@gotong/transport-ws'

const hub = new Hub()
await hub.start()
await serveWebSocket(hub, { port: 4000 })
```

Worker process (any agent, anywhere):

```ts
import { AgentParticipant, connect } from '@gotong/sdk-node'

class MyAgent extends AgentParticipant {
  constructor() { super({ id: 'a1', capabilities: ['draft'] }) }
  protected async handleTask(task) { return { text: '…' } }
}

await connect({ url: 'ws://hub.example.com:4000', agents: [new MyAgent()] })
```

The Hub's `dispatch(...)` calls reach the remote agent identically to a local one. See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the wire format and [examples/remote-agent](examples/remote-agent) for a runnable two-process demo.

## LLM-backed agents

The Hub does not call LLMs. `LlmAgent` does — it's a thin base class that wires a Task into an `LlmProvider` and turns the response into a `TaskResult`. Swapping vendors is a one-line change.

```ts
import { Hub } from '@gotong/core'
import { LlmAgent } from '@gotong/llm'
import { AnthropicProvider } from '@gotong/llm-anthropic'
import { OpenAIProvider } from '@gotong/llm-openai'

const hub = new Hub()
await hub.start()

// Claude writes drafts
hub.register(new LlmAgent({
  id: 'writer',
  capabilities: ['draft'],
  provider: new AnthropicProvider(),        // reads ANTHROPIC_API_KEY
  system: 'You write one terse sentence.',
}))

// GPT reviews them
hub.register(new LlmAgent({
  id: 'reviewer',
  capabilities: ['review'],
  provider: new OpenAIProvider(),            // reads OPENAI_API_KEY
  system: 'You return one revision suggestion.',
}))

const draft = await hub.dispatch({
  from: 'system',
  strategy: { kind: 'capability', capabilities: ['draft'] },
  payload: { topic: 'distributed agents' },
})
```

Override `buildRequest(task)` to customize prompt assembly (retrieved context, few-shot examples) or `parseResponse(response, task)` to post-process (JSON extraction, validation re-prompt). Override `handleTask(task)` for full control — multi-step reasoning, retries, structured outputs. See [`packages/llm`](packages/llm/src/agent.ts) and the two demos in [`examples/llm-mock`](examples/llm-mock) and [`examples/llm-real`](examples/llm-real).

## Open Space — admins, workers, and agents in one room (v2.0)

Anchor the hub to a `.gotong/` directory; admin identity, worker accounts, and gated agent admissions all live there. Web UI splits into two views (`/` worker, `/admin` admin). Hub restarts are transparent — cookies still work, admins are still admins, transcripts grow rather than restart.

```ts
import { Hub, Space } from '@gotong/core'
import { serveWebSocket } from '@gotong/transport-ws'
import { serveWeb } from '@gotong/web'

const { space, adminToken } = await Space.openOrInit('.gotong', {
  name: 'my-space',
  adminDisplayName: 'Operator',
  config: { gating: 'admin-approval' },
})
console.log(`Admin URL once: http://localhost:3000/admin?token=${adminToken}`)

const hub = new Hub({ space })
await hub.start()

await serveWebSocket(hub, { port: 4000, gating: (await space.config()).gating })
await serveWeb(hub, { port: 3000 })
// admin = /admin?token=<TOKEN>   |   worker = /
```

- **Admin** signs in once with the token, then drives the room: approve / reject pending agent admissions, dispatch tasks via any of the three strategies, see all tasks in a filterable panel with a **Retry** button on failed rows, write evaluations attached to specific tasks.
- **Worker** picks a nickname + capabilities at `/`, becomes a `HumanParticipant`. A `workers.json` row + an HttpOnly cookie remember them across reloads and restarts.
- **Agent** connects to the WebSocket port; with `gating: 'admin-approval'` they hang in pending until an admin acts.

Full runnable demo in [`examples/open-space`](examples/open-space). `pnpm demo:open-space` spins host + agent in one terminal, then point a browser at the two URLs it prints.

## Hub Services — agent memory, artifacts, datastores (v2.2)

An agent can declare what state it wants the host to keep on its
behalf. Three first-party "services" ship today; the plumbing is
plugin-from-day-1 so adding a fourth is a separate npm package.

```yaml
# templates/agents/industry-coach-with-memory.yaml
schema: gotong.agent/v1
agent:
  id: industry-coach
  capabilities: [intake]
  provider: anthropic
  model: claude-opus-4-7
  system: |
    Use memory.recall before answering; artifact.write the report
    afterwards; cases.sql for structured industry comparisons.
  uses:
    - { type: memory,    impl: file,   config: { kinds: [episodic, semantic] } }
    - { type: artifact,  impl: file,   config: { name: industry-reports } }
    - { type: datastore, impl: sqlite, config: { name: cases, schema: "..." } }
```

At spawn time the host resolves each `uses:` entry to a typed handle
the agent reads from `ctx.memory`, `ctx.artifact`, `ctx.datastore.<name>`.
Owner-based isolation is the default — two agents asking for `memory:file`
get two different stores. Data layout lives under `<space>/services/`:

```
<space>/services/
├─ plugins.json                    # which plugins to load (auto-seeded)
├─ memory/file/agent/<agentId>/    # one dir per (plugin, owner)
├─ artifact/file/agent/<agentId>/
└─ datastore/sqlite/agent/<agentId>/<name>.sqlite
```

Soft delete is a click in the admin "服务 / Services" tab; data moves
to per-plugin `.trash/`, lives 30 days, then a background sweeper
hard-deletes it. Restore is one POST until then. Full design is in
[`docs/services-rfc.md`](docs/services-rfc.md).

| Package | What it provides |
|---|---|
| `@gotong/services-sdk` | `ServicePlugin` contract, registry, loader. The seam plugin authors implement. |
| `@gotong/service-memory-file` | First-party `memory:file` — episodic / semantic / working as JSONL. |
| `@gotong/service-artifact-file` | First-party `artifact:file` — per-owner directories of files with MIME + size guards. |
| `@gotong/service-datastore-sqlite` | First-party `datastore:sqlite` — KV + raw SQL on one `.sqlite` per declared name. |

### Writing your own plugin

```ts
// my-plugin/src/index.ts
import type { ServicePlugin } from '@gotong/services-sdk'

class MyPlugin implements ServicePlugin {
  readonly type = 'memory'
  readonly impl = 'redis'
  readonly version = '0.1.0'

  async init(ctx) { /* open the redis pool */ }
  async validateConfig(raw) { /* parse + reject bad shapes */ }
  async attach(owner, config) { /* return a MemoryHandle */ }
  async detach(owner) { /* close the per-owner cache */ }
  async softDelete(owner) { /* return a TrashRef; the host stores it */ }
  async restore(ref) { /* throws TrashRestoreConflictError on collision */ }
  async hardDelete(ref) { /* irreversible */ }
  async describe(owner) { /* admin UI snapshot — sizeBytes, preview */ }
  async shutdown() { /* drain + close */ }
}

export default () => new MyPlugin()
```

Drop the package name into `<space>/services/plugins.json` and restart
the host — `loadPlugins` dynamic-imports the entry, calls `init`, and
the plugin is available to every agent's yaml `uses:`. Plugin load
failures are non-fatal: a bad plugin shows up in the boot log but
doesn't crash the host.

> **Deployment note**: the host resolves plugin packages from its own
> `node_modules/`, so third-party plugins need to be installed where
> the host can see them — `pnpm add my-org/gotong-redis-memory` in
> the host workspace, or a `package.json` dependency on the deploy
> image. Putting the package name in `plugins.json` alone is not enough
> if the package itself isn't on disk.

## Packages

| Package | Purpose |
|---|---|
| `@gotong/core` | Hub, registry, scheduler, transcript, storage, Participant base classes |
| `@gotong/web` | Embeddable reference UI (HTTP + SSE + vanilla SPA) |
| `@gotong/host` | Production binary — env-driven, no demo state, ships `gotong-host` |
| `@gotong/protocol` | Wire-protocol types + codec (zero runtime) |
| `@gotong/transport-ws` | Hub-side WebSocket transport |
| `@gotong/sdk-node` | Node SDK for remote agents (also exports `TeamBridgeAgent`) |
| `@gotong/llm` | `LlmAgent` base class + `LlmProvider` interface + `MockLlmProvider` |
| `@gotong/llm-anthropic` | Anthropic Claude provider (peer dep: `@anthropic-ai/sdk`) |
| `@gotong/llm-openai` | OpenAI provider (peer dep: `openai`) |
| `@gotong/services-sdk` | Hub Services plugin contract (v2.2) — see the section above |
| `@gotong/service-memory-file` | First-party `memory:file` plugin (JSONL on disk) |
| `@gotong/service-artifact-file` | First-party `artifact:file` plugin (per-owner dirs, MIME-gated) |
| `@gotong/service-datastore-sqlite` | First-party `datastore:sqlite` plugin (KV + SQL) |
| `@gotong/mcp-server` | MCP (Model Context Protocol) bridge — let Claude Desktop / Cursor drive a Hub |
| `gotong` (PyPI, in `python-sdk/`) | Python SDK — connect Python agents to a Hub over the same wire protocol |

## License

**MIT** for the project itself — see [`LICENSE`](LICENSE).

- ✅ Commercial use, closed-source derivatives, internal SaaS embedding — all allowed.
- ⚠️ Retain the LICENSE file + copyright notice in your distribution.
- Third-party prompt templates under [`templates/community/`](templates/community/) carry their own (compatible) licenses — CC0 1.0 and MIT — aggregated verbatim in [`templates/community/LICENSE-NOTICES.md`](templates/community/LICENSE-NOTICES.md).

Common questions ("can I embed in closed-source", "do I have to attribute community templates", "is fork+rename allowed") are answered in [`docs/LICENSE-FAQ.md`](docs/LICENSE-FAQ.md).
