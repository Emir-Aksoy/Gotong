# 快捷接入主流 agent（QUICK-CONNECT）

> 把主流编码 agent 一键接到正在运行的 AipeHub Hub。
> 这是 [`AGENT-ADAPTER-CONTRACT.md`](AGENT-ADAPTER-CONTRACT.md) 「双向」里的
> **入站**那一半（agent → AipeHub）；「出站」（hub 反过来驱动它们）是另一条
> 线，见该契约。
>
> Last updated: 2026-06-01

---

## 一句话原理

2026 年所有主流编码 agent 都是 **MCP 客户端**（或 MCP host）。所以「接入
AipeHub」对整个品类是**同一个动作**：把 agent 的 MCP 配置指向
`@aipehub/mcp-server` —— 它本身是 Hub admin HTTP API 的一个瘦客户端
（见 `packages/mcp-server`，暴露 `list_participants` / `dispatch_task` /
`list_tasks` / `get_leaderboard` / `evaluate_task` 五个工具）。

各家不同的只是**外壳格式**：`claude mcp add` 一行命令、一段 TOML 表、一个
JSON `mcpServers` map、一段 YAML。底下的载荷永远一样：

```
command: node
args:    [<packages/mcp-server/bin/aipehub-mcp.js 的绝对路径>]
env:     AIPE_HUB_URL, AIPE_ADMIN_TOKEN
```

> **为什么用 `node` + 绝对路径，而不是 `npx -y @aipehub/mcp-server`？**
> `@aipehub/mcp-server` 还没发到 npm。发布前一律用绝对路径 spawn。
> 与 [`MCP.md`](MCP.md) 的说明一致。

---

## 快捷命令

```bash
# 列出支持的 agent + 当前解析到的 hub / bin
aipehub connect

# 打印某个 agent 的完整可复制配置
aipehub connect codex
aipehub connect claude-code --token="$AIPE_ADMIN_TOKEN"
aipehub connect cursor --name=my-hub --hub=http://127.0.0.1:3000
```

- `--hub=<url>`：Hub admin HTTP 基址（默认 `$AIPE_HUB_URL` 或 `http://127.0.0.1:3000`）
- `--token=<token>`：要内联进配置的 admin token（默认占位符；**绝不**把 env 里的
  密钥自动写进终端输出——要内联请显式传 `--token`）
- `--name=<name>`：MCP server 在 agent 配置里的名字（默认 `aipehub`）
- `--bin=<path>`：`aipehub-mcp.js` 路径（monorepo 检出里自动探测，否则手动给）

配置块走 **stdout**（方便 `| pbcopy` / 重定向）；告警（占位符 token、bin 没找到）
走 **stderr**，不污染可复制内容。

---

## 一个完整例子（Claude Code）

```bash
claude mcp add aipehub \
  -e AIPE_HUB_URL=http://127.0.0.1:3000 \
  -e AIPE_ADMIN_TOKEN=<你的 admin token> \
  -- node /abs/path/AipeHub/packages/mcp-server/bin/aipehub-mcp.js
```

连上后在 Claude Code 里就能直接 `dispatch_task` 把活派进 Hub、`list_tasks`
看进度、`get_leaderboard` 看贡献榜——你的 agent 成了 Hub 房间里的一个调度者。

---

## 八个 agent 的接入点

| id | agent | 配置位置 | 机制 | 文档 |
|---|---|---|---|---|
| `claude-code` | Claude Code（Anthropic） | `~/.claude.json` | `claude mcp add` / `mcpServers` | [docs](https://docs.anthropic.com/en/docs/claude-code/mcp) |
| `codex` | Codex（OpenAI） | `~/.codex/config.toml` | `[mcp_servers.*]` | [repo](https://github.com/openai/codex) |
| `opencode` | OpenCode（sst/opencode） | `opencode.json` | `"mcp"`（`type: local`） | [docs](https://opencode.ai/docs/mcp-servers/) |
| `antigravity` | Antigravity（Google） | `~/.gemini/config/mcp_config.json` | `mcpServers`（IDE+CLI 共享） | [docs](https://antigravity.google/docs/mcp) |
| `cursor` | Cursor | `~/.cursor/mcp.json` | `mcpServers` | [docs](https://docs.cursor.com/context/mcp) |
| `openclaw` | OpenClaw | `~/.openclaw/openclaw.json` | `openclaw mcp add` / `mcp.servers` | [docs](https://docs.openclaw.ai/cli/mcp) |
| `nanobot` | nanobot（nanobot-ai） | `nanobot.yaml` | `mcpServers` | [repo](https://github.com/nanobot-ai/nanobot) |
| `hermes` | Hermes Agent（Nous Research） | `~/.hermes/config.yaml` | `hermes mcp add` / `mcp_servers` | [docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) |

> 各家配置路径 / 命令偶有变动，以官方文档为准；`aipehub connect <id>` 输出的
> 末尾永远带一行该 agent 的文档链接。

---

## 安全须知

- **admin token 是密钥**。`aipehub connect` 默认填占位符 `<YOUR_ADMIN_TOKEN>`，
  不会自动把 `$AIPE_ADMIN_TOKEN` 写进可被回滚缓存 / 录屏看到的终端输出。要内联
  请显式 `--token`，或直接在打印出的配置里手动替换。
- AipeHub MCP server 用的是 **admin Bearer**，权限很大（能派任务、读账本）。给
  本机自己的 agent 用没问题；要给别处 / 别人，优先走 Phase 18 的 **A2A** 入站
  （per-peer bearer、能力白名单、fail-closed），而不是把 admin token 递出去。

---

## 还没做（出站那一半）

本页只解决**入站**（agent 调 AipeHub）。让 Hub **反过来驱动**这些 CLI agent
（shell-out 适配器，达到契约里的 Tier 1+ 接管粒度）是独立交付物，按
[`AGENT-ADAPTER-CONTRACT.md`](AGENT-ADAPTER-CONTRACT.md) 的优先级 P0 排期，未启动。
A2A 原生的 agent（Antigravity / Google ADK / 企业平台）则已由 Phase 18 的出站
`A2aRemoteParticipant` 覆盖，天然双向。
