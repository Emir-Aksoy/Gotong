# RAG —— 通过 MCP 接入向量检索

> Status: 设计落地（v4 Phase 5 / B3 + B4）
>
> Last updated: 2026-05-25
>
> Previous reading: `docs/zh/MCP.md`（Hub **作为** MCP server）+
> `docs/zh/AGENT.md`（agent 数据模型 + `mcpServers` 字段）+
> `docs/zh/ledger/V4-ARCH.md`（v4 整体架构）。

## 一、设计立场:不内置 RAG

AipeHub **不**自己造 ingest / embedding / 向量存储 这套轮子。RAG 生态
里成熟方案太多 —— Chroma / Qdrant / Pinecone / pgvector / Milvus
—— 每家都有自己的运维姿势、模型选型、计费模型。AipeHub 把这一层完全
甩给社区,通过 [Model Context Protocol](https://modelcontextprotocol.io)
把它们接进来。

具体说:

- **AipeHub host 不存向量,不调 embedding API**。`identity.sqlite` 里
  没有 vectors 表;`OrgApiPool` 不需要 embeddings provider key。
- **每个 agent 自己在 `mcpServers` 里声明**它要用的 RAG MCP server
  —— 比如本地起的 chroma-mcp,或者 Pinecone 官方 MCP wrapper。
- **agent 通过 MCP 工具调用**(`namespace__operation` 形式)做 ingest /
  query / forget,跟它使用 Brave Search MCP 没有结构上的区别 ——
  scripts/personal-growth-prompts.mjs 里 5 个 coach 已经在用同样的
  路径接 `@modelcontextprotocol/server-brave-search`。
- **配额计量走 `mcp_calls` 指标**(`packages/identity/src/types.ts:481`),
  不区分"这次调用是 RAG 还是搜索"。想分粒度计量,RAG MCP server
  自己上报(见第五节)。

这条路线的核心**代价 + 收益**:

- 代价: AipeHub 不知道你检索了什么内容、用了什么 embedding 模型;
  admin UI 没"知识库管理"页面 —— 那是 RAG 服务自己的事。
- 收益: 锁定零、迁移零;RAG 生态进化跟 AipeHub 解耦;
  `identity.sqlite` 保持小、可备份、可加密;
  bun-compile 单文件二进制不受影响(向量库的 native binding 全部留在
  外部子进程里)。

## 二、配置:`mcpServers` 字段

agent record(`agents.json` 里 / template yaml 里)加一段:

```jsonc
{
  "id": "rfp-researcher",
  "capabilities": ["research-rfp"],
  "displayName": "RFP 研究员",
  "system": "你是一个 RFP 研究员,使用 knowledge__query 检索过往合同要点...",
  "mcpServers": [
    {
      "name": "knowledge",
      "command": "uvx",
      "args": ["chroma-mcp", "--persist-dir", ".aipehub/knowledge/rfp"],
      "env": {
        "CHROMA_TENANT": "${CHROMA_TENANT}",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  ]
}
```

字段 schema(来源:`packages/core/src/space.ts:1050-1092`):

| 字段 | 含义 |
|---|---|
| `name` | tool namespace 前缀。agent 看到的工具名是 `knowledge__add` / `knowledge__query`。必须 `/^[a-zA-Z][a-zA-Z0-9_-]*$/`。 |
| `command` | 启动命令(可执行)。`uvx` / `npx -y` / 绝对路径都可以。 |
| `args` | 命令行参数。**不走 shell**,所以 `*` glob、管道之类的不展开。 |
| `env` | 给子进程的环境变量。值里支持 `${VAR}` 占位符,从 host `process.env` 读;读不到就警告 + 替换为空串。 |
| `cwd` | 子进程工作目录,可选。 |

每个 agent 实例独占一份 MCP server 子进程 —— `LocalAgentPool.spawn`
时拉起,agent 进入 `stop` 状态时关掉(`packages/host/src/local-agent-pool.ts:335-770`)。
多 agent 共用一个 chroma store 就让它们都指同一个 `--persist-dir`;
并发写由 chroma 自己处理。

## 三、推荐的 RAG MCP server

注意:我们**不**捆绑任何具体 server,以下只是"已知能跑通"的清单
—— 你的环境、合规要求、性能预算可能让某个更合适。

| Server | 适合 | 启动命令(示意) |
|---|---|---|
| [chroma-mcp](https://github.com/chroma-core/chroma-mcp) | 单机 / 小团队;本地持久化;最低运维。 | `uvx chroma-mcp` |
| [mcp-server-qdrant](https://github.com/qdrant/mcp-server-qdrant) | 中等规模;独立 Qdrant 服务;HTTP-only。 | `uvx mcp-server-qdrant` |
| [pinecone-mcp](https://github.com/pinecone-io/pinecone-mcp) | 大规模;托管;按调用付费。 | `npx -y pinecone-mcp` |
| [mcp-server-pg](https://github.com/modelcontextprotocol/servers/tree/main/src/postgres) | 已有 PG 基础设施;pgvector 混合关系 + 向量。 | `uvx mcp-server-postgres` |

挑选时主要看三件事:**数据落在哪、谁付钱、需不需要 GPU**。

- 本地原型 → chroma-mcp
- 团队生产 → qdrant 自建
- 不想运维 → pinecone

URL / 命令以官方 README 为准 —— MCP 生态变动快,本表不保证时刻新鲜。

## 四、凭证管理

短版本: **走 host 进程的 `process.env`,通过 `${VAR}` 注入到
`mcpServers[].env`**。

```jsonc
"mcpServers": [{
  "name": "knowledge",
  "command": "uvx",
  "args": ["chroma-mcp"],
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}",  // ← host 启动前 export
    "CHROMA_HOST_TOKEN": "${CHROMA_HOST_TOKEN}"
  }
}]
```

启动 host:

```bash
export OPENAI_API_KEY=sk-...
export CHROMA_HOST_TOKEN=...
pnpm host start
```

变量替换发生在 `LocalAgentPool` 拼 toolset 时(`local-agent-pool.ts:781-795`),
读不到的变量会被替换成空串并打 warning。

**为什么不直接读 identity vault?**

- vault 现在是给 LLM provider key 用的(B1 / OrgApiPool),按 user /
  org owner 隔离。一个 MCP server 子进程是 agent 级别的,要绑到
  vault 得设计"哪个 agent 能取哪个 owner 的 key"这套 ACL —— 复杂度
  高、收益模糊。
- env var 路线的好处是**显式**:操作员一眼能看到 host 需要哪些 secret,
  写进 systemd unit / docker-compose / k8s secret 里都很自然。

D1(Peer Registry vault 集成)完成后,会同时给 MCP server 加一条
`vault://<provider>` 引用语法,把这个口子打开。在那之前 env var 是唯一姿势。

## 五、配额计量

走通用 **`mcp_calls`** 指标(`packages/identity/src/types.ts:481`),
**不**区分 RAG / search / 别的。理由:

- AipeHub 看到的只是 MCP 工具调用,无法判断 server 内部是哪种操作。
- 不同 RAG server 的"1 次 query"成本天差地别 —— 调本地 chroma 几乎
  免费,调 Pinecone 是 $0.0004 —— 一个 metric 装不下精确成本模型。

实践姿势:**两层 quota**。

1. **AipeHub 侧**:给 `mcp_calls` 设 daily / monthly 上限,挡掉
   "agent 死循环里一晚上跑出 10 万次调用"这种事故。Quota 调用方式
   跟 B2.2 落地的 `llm_requests` 一样:LocalAgentPool 给每个非 mock
   agent 装 `preCallHook = (task) => gate(task.origin)`,gate 内部
   就走 `identity.checkAndIncrement({metric:'mcp_calls', ...})`。
   (B3 没引入新代码 —— `mcp_calls` 已经在指标白名单里,等被消费侧
   wire 进去时直接用。)
2. **MCP server 侧**: 让 server 自己根据 API key 做配额(Pinecone /
   OpenAI 都内建这套)。AipeHub 把 OOM 留给 server 报错,然后 agent
   `failed` 出去,task 落 `quota_exceeded`-ish 状态。

`knowledge_ingest_bytes` / `knowledge_query` 是 types.ts 注释里
**预留的**自定义 metric 名 —— 暂时没有 auto-debit 调用方。如果 RAG
MCP server 未来支持把 ingest 字节数 / query 次数回调给 AipeHub
(目前没标准协议,但 MCP spec 加 telemetry channel 后会自然落回这里),
可以用这两个名字。

## 六、workflow 集成(B4)

短版本: **不需要扩 workflow yaml schema**。

workflow step 的 dispatch 是按 capability 路由的
(`packages/workflow/src/runner.ts` 里 `dispatchOne` →
`hub.dispatch({strategy:{kind:'capability',...}})`),谁有 capability
谁接。把"会用 RAG"打成 capability 就行:

```yaml
# workflows/rfp-write.yaml
steps:
  - id: research
    dispatch:
      strategy: { kind: capability, capabilities: [research-rfp] }
      payload:
        topic: $trigger.payload.topic
        instructions: |
          先用 knowledge__query 检索 3 篇相关历史 RFP,
          然后总结要点。
  - id: draft
    dispatch:
      strategy: { kind: capability, capabilities: [draft] }
      payload:
        research: $research.output
        topic: $trigger.payload.topic
```

agent `rfp-researcher`(capability=`research-rfp`)的 `mcpServers` 里
挂了 chroma-mcp → workflow runner 派 task → LlmAgent tool-use loop →
chroma 检索 → 回结果。中间所有跨 step 的 `task.origin` 传递、
`mcp_calls` 配额检查都已经在 B2.2.2 / B2.3 落地的链路上跑通了,没有
RAG-specific 代码。

跨 agent 共享检索结果? 就是 step output 串到下一步:`$research.output`
里带回索引结果摘要,后续 step 不再重复 query。

## 六-bis、跨 hub 知识共享(D3 决议)

原 v4 Phase 5 计划里的 **D3** 是 "shared_with + 跨 hub query" ——
让 A 用户的 knowledge collection 能授权给 B hub 的 agent 检索。

**结论:不在 aipehub 层实现,走共享 MCP server。**

原因和 B3 决议一致:knowledge 本质是个存储/检索后端,标准 MCP 协议
(chroma-mcp / qdrant-mcp / pinecone-mcp / weaviate-mcp 等)已经
原生支持远程客户端 + 服务端访问控制。在 aipehub 上再加一层
"shared_with"模型,只会和 MCP server 自身的 ACL 重叠/冲突。

### 推荐部署模式

**模式 A —— 公共只读 corpus**

```jsonc
// 共享 chroma 实例(远程 HTTP 模式)开在 chroma.shared-org.local:8000
// hub_A 和 hub_B 的 agent 都用同一份 mcpServers 配置:
{
  "mcpServers": [{
    "name": "public-corpus",
    "command": "uvx",
    "args": [
      "chroma-mcp",
      "--client-type", "http",
      "--host", "chroma.shared-org.local",
      "--port", "8000",
      "--read-only"
    ]
  }]
}
```

server 侧加 IP allowlist / token 验证;每个 hub 用同一份只读 token。
谁能查就在 MCP server 侧管,跟 aipehub 解耦。

**模式 B —— 跨 org 写共享**

走 Postgres-backed chroma / 商业 Pinecone / Weaviate Cloud
—— 写权限和分区由后端自己管(per-collection API key / row-level
security)。aipehub 只负责给 agent 注入对应的 API key 凭据
(vault),不掺合"哪个 hub 能写哪个 collection"。

**模式 C —— federated MCP 网关**

如果真的想做 hub-to-hub 转发(罕见场景),写一个轻量 MCP-proxy server
跑在 hub_A 上,它 forward 到自己内部的 chroma + 检查请求源是不是
hub_B 的 agent 凭据。这是个独立项目,**不在 aipehub 主仓**。

### 跟 D2 (跨 hub HITL) 的区别

**HITL 走 aipehub**(D2 已实现):因为 HITL 涉及 task 跨 hub 路由 +
admin 决策 + 审计,这些都是 aipehub 已有的核心抽象(hub.dispatch /
task.origin / audit_log)。让 aipehub 在外面绕一圈反而复杂。

**knowledge 不走 aipehub**(D3 跳过):因为 knowledge 检索是个纯数据
平面操作,跟 task scheduling / approval / audit 无关。MCP 协议天然
处理客户端-服务端拓扑,aipehub 再封一层只是冗余。

## 七、限制 + 故障排查

| 症状 | 原因 / 解法 |
|---|---|
| `spawn ENOENT: uvx` | host 的 PATH 里没有 `uvx`。装 [uv](https://docs.astral.sh/uv/) 或在 `command` 写绝对路径(如 `/opt/homebrew/bin/uvx`)。 |
| agent 起来但工具列表是空的 | MCP server 启动时报错。看 host 日志 `comp:"mcp-toolset"` / `comp:"local-agent-pool"` 段的 `mcp-server stderr` 事件 —— RAG server 通常因为 API key 没注入 / persist dir 没权限 退出。 |
| `tool 'knowledge__query' not found` | agent system prompt 里说了用这个工具,但 `mcpServers[].name != 'knowledge'`。改 name 或改 prompt。 |
| Pinecone-mcp 第一次启动很慢 | 它要拉 client + ping API。给 host 至少 30s 容忍;失败的 server 会被自动跳过(agent 启动不阻塞),但工具列表里就少这条。 |
| 想给一个 agent 多个 RAG source | 在 `mcpServers[]` 里加多条,每条不同 `name` —— `name='knowledge'` 主库,`name='public-corpus'` 公共备援。agent prompt 里告诉 LLM 怎么选。 |
| 跨进程并发写同一份 chroma persist-dir 报错 | chroma 默认 sqlite backend 不支持多 writer。要么所有 RAG agent 指同一个**远程** chroma server,要么改用 qdrant / pinecone。 |
| 担心 RAG 调用走漏数据 | env var 注入的 API key 不进 audit log;但 `mcp_calls` 计数会上 audit。需要细粒度内容审计的,在 MCP server 侧自己加 hook —— AipeHub 看不到 RAG 内容是设计取舍,不是 bug。 |

要更深入诊断,从 host 启动时的日志找 `comp:"mcp-toolset"` /
`comp:"local-agent-pool"` 段,会有 server connect / disconnect /
stderr 全程。

---

**另见**:

- `docs/zh/MCP.md` —— **Hub 作为** MCP server(被 Claude / Cursor 调进来),
  跟本文方向相反。
- `docs/zh/AGENT.md` —— agent 数据模型完整定义,`mcpServers` 字段属于其中一部分。
- `docs/zh/ledger/V4-ARCH.md` —— v4 整体架构;RAG 在 "B-tier (resources)" 这层,
  跟 LLM API pool / 配额 系统平行。
