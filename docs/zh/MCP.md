# MCP — 从 Claude Desktop / Cursor / Cline 驱动一个 Hub

> 同步自英文版 [`docs/MCP.md`](../MCP.md) @ 2026-05-17

Gotong 自带一个 [Model Context Protocol](https://modelcontextprotocol.io)
server，让任何支持 MCP 的客户端可以**派任务**进 Hub、读**谁在线**、
浏览**贡献榜**、给完成的任务**附评价** —— 全程不用碰管理 web UI。

> **反过来：给 hub 的 agent 挂 MCP 工具(client 方向)** —— admin「MCP 集成」标签页
> 自带一个**内置连接器目录**(Chroma RAG / Obsidian / Elasticsearch / 文件系统 +
> 一个去官方注册站实时搜的 fetch 配方),一键装进 hub 的 MCP 注册表,agent 表单即可
> 按名勾选;工作流架构师还会**优先推荐已装的可组装组件**。见
> [MCP-CONNECTOR-DIRECTORY](MCP-CONNECTOR-DIRECTORY.md)。

本文覆盖：

1. 你能做什么
2. 怎么接 Claude Desktop / Cursor / Cline
3. 工具参考
4. 架构（以及为啥这么设计）
5. 故障排查

---

## 1. 你能做什么

配好之后，你的 MCP 客户端会多 5 个新工具（在已装的工具旁边）。
示例 prompt：

> *"用 Gotong 派一个 draft 任务给任意有 `draft` capability 的人，
> 主题是 'why TypeScript'，然后给结果打 4.5 分。"*

> *"看一下 Gotong 本周贡献榜，谁在领先？"*

> *"列出 Gotong 参与者。有人在线吗？"*

LLM 依次调用正确的工具，Hub 实际做活，你在聊天里看到结果。
适用场景：

- 在 IDE 里驱动一个团队房间
- 跑脚本化的"AI 委派给自己的子 agent"工作流
- 让 Claude Desktop 当"管理员的眼"，不离开对话就能看跑着的 Hub

---

## 2. 安装

### 2a. 准备

- 一个跑着的 Gotong host —— `pnpm host`（从源码跑）或者
  `docker compose up` 都行，看哪个适合你。
- 它的管理员 Bearer token。首次启动时打印一次（在 host stdout 里
  搜 `First-run admin URL`）。后续 admin 可以通过
  [`POST /api/admin/admins`](DEPLOY.md#c8-onboard-more-admins) 增发。

> ⚠️ **`@gotong/mcp-server` 当前仅源码可用**。下面所有客户端配置示例
> 里的 `"command": "npx", "args": ["-y", "@gotong/mcp-server"]` 写法
> 要等选定 JS 发布渠道之后才能用（见
> [RELEASE-CHECKLIST](../.github/RELEASE-CHECKLIST.md) "Distribution
> decision"）。**在那之前**，本页每个配置块里的 `npx` 一行替换为：
>
> ```json
> "command": "node",
> "args": ["/absolute/path/to/Gotong/packages/mcp-server/bin/gotong-mcp.js"]
> ```
>
> 替换在 Claude Desktop、Cursor、Cline 以及任何通用 MCP 客户端都适用
> —— 只改 `command`/`args`，`env` 块不变。

### 2b. Claude Desktop

编辑 Claude Desktop 配置：

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gotong": {
      "command": "npx",
      "args": ["-y", "@gotong/mcp-server"],
      "env": {
        "GOTONG_HUB_URL": "http://127.0.0.1:3000",
        "GOTONG_ADMIN_TOKEN": "<paste your bearer token here>"
      }
    }
  }
}
```

重启 Claude Desktop。看输入框旁边的 🔌 标记 —— 点它会列出注册的
MCP server；应该能看到 `gotong` 下面写着 **5 tools available**。

### 2c. Cursor

Cursor 从 `~/.cursor/mcp.json`（用户级）或 `<project>/.cursor/mcp.json`
（项目级）读 MCP server 配置。JSON 形状跟 Claude Desktop 一样。
编辑后重载。

### 2d. Cline（VS Code 插件）

Cline 的 MCP marketplace UI 接受同样的配置。也可以手编
`<vscode-storage>/cline_mcp_settings.json`。

### 2e. 通用客户端

任何符合 MCP 规范的客户端都行 —— 把 `command` / `args` / `env`
三元组交给客户端用的 launcher。

---

## 3. 工具

所有工具都一对一翻译成对 Hub 管理 API 的 HTTP 调用。`GOTONG_ADMIN_TOKEN`
里的 Bearer token 给每次调用授权。

### `list_participants`

> 返回 Hub registry 里当前所有的参与者。

**输入:**

```json
{ "kind": "agent" | "human" | "any" }    // 可选，默认 "any"
```

**输出（示例）：**

```json
{
  "count": 3,
  "participants": [
    { "id": "writer-zh",   "kind": "agent", "capabilities": ["draft"],  "load": 0 },
    { "id": "reviewer-zh", "kind": "agent", "capabilities": ["review"], "load": 1 },
    { "id": "alice",       "kind": "human", "capabilities": ["approve"], "load": 0 }
  ]
}
```

### `dispatch_task`

> 用三种策略之一把任务派进 Hub。**同步** —— 最多等 `timeoutMs` 拿结果
> （默认 60s）。

**输入:**

```json
{
  "strategy": "direct" | "capability" | "broadcast",
  "recipient": "writer-zh",                  // strategy=direct 时必填
  "capabilities": ["draft"],                 // capability 或带过滤的 broadcast 时必填
  "payload": { "topic": "why TypeScript" },  // 自由
  "title": "draft about TS",                 // 可选
  "weight": 2.0,                             // 贡献权重，默认 1.0
  "countContribution": true,                 // 是否计入榜单
  "timeoutMs": 60000                         // 等结果超时
}
```

**输出：** Hub 返回的 `TaskResult` 形状 ——

```json
{
  "kind": "ok",
  "taskId": "8b1c…",
  "by": "writer-zh",
  "ts": 1715567890123,
  "output": { "text": "TypeScript is …" }
}
```

`kind` 也可能是 `failed` / `cancelled` / `no_participant`。
客户端在 `wait timeout` 时抛错，让 LLM 决定重试或降级。

### `list_tasks`

> 带状态的近期任务。评价之前用得上。

**输入:**

```json
{ "status": "done" | "pending" | "failed" | "cancelled" | "any", "limit": 50 }
```

**输出：** `TaskView` 行的数组（id、status、做活的人、weight、rating、…）。

### `get_leaderboard`

> 一段时间窗口里的贡献榜。管理员**和**普通 worker 都能通过
> Hub 的 `/api/leaderboard` 访问。

**输入:**

```json
{ "window": "today" | "7d" | "30d" | "all", "limit": 20 }
```

**输出:**

```json
{
  "window": { "from": 1714963200000, "to": 1715568000000 },
  "totalTaskCount": 42,
  "unratedTaskCount": 3,
  "rows": [
    { "participantId": "writer-zh", "totalContribution": 38.5,
      "taskCount": 19, "averageRating": 4.05, "lastActivityTs": 1715567890123,
      "byCapability": { "draft": { "count": 19, "contribution": 38.5 } } }
  ]
}
```

### `evaluate_task`

> 给已完成任务附评价。rating × weight = 贡献分。

**输入:**

```json
{ "taskId": "<id from list_tasks>", "rating": 4.5, "comment": "tight prose" }
```

省略 `rating` 只更新 comment。省略 `comment` 只更新 rating。
Hub 把 `rating` clamp 到 `[0, 5]`。

**输出：** `{ "ok": true, "taskId": "..." }`

---

## 4. 架构

```
   Claude Desktop / Cursor / Cline / …
        │
        │ stdio (JSON-RPC 2.0 / MCP spec)
        │
   gotong-mcp  （本包，由 MCP client 启动）
        │
        │ HTTP + Bearer admin token
        │
   Gotong host  （你已经跑着的 Hub）
        │
   ├── Hub state (transcript, agents.json, secrets.enc.json, …)
   ├── LocalAgentPool (host 托管的 LLM agent)
   └── ws:// (远端 SDK 连过来的 agent)
```

**设计选择 + 原因：**

- **HTTP，不是 WebSocket**。Hub 已经暴露了完整的管理 API，带
  Bearer auth、限流、`ALLOWED_HOSTS` 检查。复用它意味着 MCP bridge
  白捡所有这些能力，自己**不用维护任何守护态**。

- **无状态**。每个工具调用是一次 HTTP 往返。重启 MCP server 不用
  replay。多个 MCP 客户端可以共享同一个 Hub。

- **Stdio transport**。Claude Desktop / Cursor / Cline 必须要的。
  SDK 的 `StdioServerTransport` 处理 JSON-RPC framing；我们只
  注册工具然后 connect。

- **5 个工具，不是 15 个**。Hub 有很多 endpoint —— 导 agent、发
  channel、邀 admin。MCP surface **故意做窄**：是"操作房间"，
  不是"配置房间"。模板导入、API key 轮转之类的还是走管理 UI，
  那才是它们的归宿。

---

## 5. 故障排查

| 症状 | 可能原因 |
|---|---|
| MCP 客户端说 "gotong server failed to start" | `GOTONG_HUB_URL` 错 —— `gotong-mcp` 启动时会 ping `/healthz`。检查 URL 和 host 是不是真的在跑。 |
| 工具列出来了但每次调用都 `401` | `GOTONG_ADMIN_TOKEN` 错了或过期了。从管理 UI 重新签发一个 admin token。 |
| `dispatch_task` 总是返回 `no_participant` | 没有 agent 有你要的 capability。先 `list_participants` 看一眼当前有什么，或者用 `direct` + 具体 id。 |
| 工具列表是空的 | MCP 客户端连上了但 `tools/list` 返回 `[]`。通常是 `npx` 缓存了老版本的 `@gotong/mcp-server`。客户端配置里换 `npx -y @gotong/mcp-server@latest` 试试。 |
| Claude Desktop 日志显示 `Cannot find module '@modelcontextprotocol/sdk'` | 一般 `npx -y` 能解决。持续不行就全局装：`npm i -g @gotong/mcp-server`，把 `"command"` 改成 `"gotong-mcp"`，删掉 `args` 数组。 |

要更深入调试，在终端里直接跑 server：

```bash
GOTONG_HUB_URL=http://127.0.0.1:3000 GOTONG_ADMIN_TOKEN=<token> gotong-mcp
```

然后手敲 JSON-RPC 消息（`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + 回车）。
stderr 显示实际发生了什么。

---

## 6. 反向 —— Agent 作为 MCP **客户端**（RAG / 外部工具）

本文讲的是 "Claude Desktop 调进 Hub"。**反方向** —— Hub 里的 agent
拉起外部 MCP server 调用它的工具（典型场景:RAG 向量检索、Brave Search、
GitHub MCP）—— 是另一条独立路径,见 [`RAG-VIA-MCP.md`](./RAG-VIA-MCP.md)。

简言之:agent record 里加 `mcpServers: [{name, command, args, env}]`,
`LocalAgentPool.spawn` 会拉起子进程并把它的工具暴露给 agent 的
tool-use loop。`scripts/personal-growth-prompts.mjs` 里的 5 个 coach
agent 已经用这条路接 Brave Search 做实时搜索。

这是 **per-agent 内联** 写法。把 MCP server 注册到 **hub 级**、让任意 agent
按名 opt-in、还能跨 hub 共享给 peer —— 见下面第 7 节。

## 7. Hub 级 MCP 集成 + 跨 hub 联邦（#2）

第 6 节是单个 agent record 内联 `mcpServers`。**更进一步**:把 MCP server
注册到 **hub 级注册表**,任意 agent 按名 opt-in,还能 **跨 hub 共享** 给 peer。

### 7a. 装进 hub 注册表

admin UI「MCP」标签页,或:

```
POST /api/admin/mcp-servers
{ "spec": { "name": "filesystem", "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"] },
  "description": "本地文件检索" }
```

凭证用 `${ENV}` 引用,别填明文(见第 2a 节)。装好后存进 hub 注册表,对运行中
的 agent 即时生效(无需重启;靠 R5 的 `addServer` / `removeServer`)。

### 7b. agent 按名 opt-in

agent「编辑」表单里勾选要用的 server,或 record 里写
`useMcpServers: ["filesystem"]`。spawn 时按名解析,把工具并进 agent 的
tool-use loop。删 server → 勾了它的运行中 agent 即时失去其工具。

### 7c. 跨 hub 共享（代理转发）

把 hub A 的某个 server 共享给 peer hub B,让 **B 的 agent 调用物理上跑在 A 上
的工具** —— 凭证 / 子进程 **始终留在 A**(凭证各归各家)。

**在 A(提供方)**:MCP 标签页勾选该 server 的「共享给 peer」开关(或
`POST /api/admin/mcp-servers` 带 `"shared": true`)。

**在 B(消费方)**:agent 编辑表单的「来自 peer 的共享 server」分区会列出所有
已连接 peer 共享的 server,勾选即可。它写成 `useMcpServers` 里的
`<peer>:<server>` ref,如 `hub_a1b2c3d4:filesystem`(也可手填)。

数据流:

```
B.agent tool-use loop
  → RemoteMcpToolset.listTools / callTool
    → 联邦链路 rpc: mcp.listTools / mcp.callTool
      → A.McpProxyHost  (每次调用校验 shared===true)
        → A 本地 McpToolset = 真子进程 + 真凭证
        ← 工具结果原样回传
```

**边界**:

- A 只暴露 `shared===true` 的 server;**每次调用都重新校验 ACL**,运行时把
  开关改回 `false` 立即生效(已 spawn 的远程引用下一次调用即被拒)。
- spec / 命令 / 凭证 **永不过线**,B 只看到 server 名 + 描述。
- peer 离线 → `listTools` 返回 `[]`、`callTool` 返回 isError,任务不崩溃;B 的
  表单里该 ref 显示「(当前不可达)」但保持勾选,编辑时不会被静默丢掉。
- 发现端点 `GET /api/admin/mcp-shared` 列出各 peer 共享了什么(就是浏览 UI 的
  后端;peer 全关时返回 503,UI 自然不显示联邦分区)。
