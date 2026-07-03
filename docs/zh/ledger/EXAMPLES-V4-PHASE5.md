# v4 Phase 5 端到端示例 / Demo Recipes

> 本文不写新代码,而是把 v4 Phase 5 新加的 feature 跟现有 examples /
> 工作流配对,给操作员"想试 X 时跑 Y"的速查表。
>
> 原 F2 规划提到 `personal-rag / org-handbook / xorg-rfp-v2` 三个新
> example。结论:**前两个走 MCP server 配置 + 现有 workflow,不需要
> 新建 example dir**;`xorg-rfp-v2` 用既有 `examples/cross-org-rfp` +
> D1 PeerRegistry 替代,见 §3。

## 1. 个人 RAG(原 personal-rag)

**目标**:agent 检索"我个人的文档",答案要私有,跨用户隔离。

**方案**(不写新 example,改 agent 配置即可):

```jsonc
// .aipehub/agents/<user>/agents/research.json
{
  "id": "research",
  "managed": {
    "kind": "llm",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "system": "用 personal__query 搜我的笔记后回答",
    "mcpServers": [{
      "name": "personal",
      "command": "uvx",
      "args": ["chroma-mcp", "--persist-dir", "/Users/you/.aipehub-rag/personal"]
    }]
  }
}
```

**用到的 Phase 5 feature**:
- B3/B4 (RAG via MCP) — agent 不知道 chroma 存在,只看到 `personal__query` 工具
- B2.1/B2.2 (per-user quota) — `mcp_calls` 计数会落到 usage_counters,触发 user-level cap

**没有 personal-rag/ 目录,因为没需要**。所有逻辑都在 agent json 配置里;
要"端到端 demo"用现有的 industry-consultation-deepseek 改一下 agent
json 即可。

## 2. 组织手册(原 org-handbook)

**目标**:全组织共享一份知识库,任何 agent 都能查;权限走 MCP server。

**方案**:

```jsonc
// 共享 chroma 实例(单独跑)开在 chroma.internal:8000
// agent json 用 HTTP client mode 接它:
{
  "mcpServers": [{
    "name": "handbook",
    "command": "uvx",
    "args": [
      "chroma-mcp",
      "--client-type", "http",
      "--host", "chroma.internal",
      "--port", "8000",
      "--read-only"
    ]
  }]
}
```

**用到的 Phase 5 feature**:
- B3 (RAG via MCP) 的 "公共只读 corpus"模式 —— 见 `docs/zh/RAG-VIA-MCP.md` §6-bis 模式 A
- D3 (跨 hub knowledge)的解决方案 —— 不在 aipehub 加 ACL 层,走 MCP server 自身

**没有 org-handbook/ 目录,因为同上**。chroma server 是单独基础设施,不在
monorepo;agent 端只是一个 mcpServers entry。

## 3. 跨 org RFP v2

**目标**:展示 D1 PeerRegistry + D2 跨 hub HITL + E1 org quota 的组合。

**方案**:**复用 `examples/cross-org-rfp`**,跑前在两个 hub 各做下面
配置:

### Hub A(供应方)

```bash
# 1. host 启 + 设 inbound 共享 token
AIPE_PEER_INBOUND_TOKEN=shared-demo-token \
  AIPE_LLM_KEY=$ANTHROPIC_KEY \
  npm run host

# 2. owner 登录后到 "配额" tab 设个 org-level cap
# 比如 llm_requests/daily = 1000,warnPct=80
# (E1 + C2 — 跨阈值会写 audit warning)

# 3. owner 登录后不需要 add peer — 等 Hub B 来连
```

### Hub B(需方)

```bash
# 1. host 启
AIPE_LLM_KEY=$ANTHROPIC_KEY npm run host

# 2. owner 登录 → "用户" tab 没动 → "配额" tab 跳过 → "Peers" tab 加 Hub A:
#    peerId:    hub_<A's selfHubId>
#    endpoint:  ws://hub-a-host:4000
#    label:     Supplier
#    token:     shared-demo-token   (跟 A 的 AIPE_PEER_INBOUND_TOKEN 对得上)

# 3. 几秒后 peer 列表里 connected=true(D1 5s tick reconcile)

# 4. 派发任务,task.origin.orgId=hub_B 自动 propagate
#    Hub A 上的 agent 如果是 PersonalGrowthAgent + 触发 NEED_INPUT,
#    会通过 D2 crossHubResolver 反向跨 hub 找 Hub B 的 admin 问问题
#    (5min 软 timeout 后 fallback)
```

### 看到什么

- Hub A 的 audit_log:`peer_connect`(inbound),后续每次任务带 origin
- Hub B 的 audit_log:`peer_connect`(outbound),后续 cross-hub
  dispatch 触发的 task 看得到 federated origin
- Hub A 累计的 llm_requests 接近 800/1000(80%)时:audit 写
  `org_quota_warn`;到 1000 时 `org_quota_over`
- Hub B 上 admin "我的"tab 收到 hub A agent 的 NEED_INPUT 反向 task

## 4. 单 host 全功能演示

如果只想一个 host 把所有 Phase 5 feature 看一遍,推荐这个组合:

| Phase 5 feature | 怎么触发 |
|---|---|
| A1 vault | 第一次启动看 `.aipehub/master.key` 自动生成 + mode 0600 |
| A2.3 setup wizard | `npm run host` → `localhost:3000` → 弹设置 owner 密码表单 |
| B2.1 用户配额 | "用户" tab 选个 member 设 `llm_requests/daily=10`,member 派发 11 次第 11 次 deny |
| B2.3 自动 sweep | 设上面 quota 后等 1h,看 host log 出现 `usage counters rolled` |
| C1 SPA | 同一 URL `localhost:3000/`,owner / member 看到不同 tab 集 |
| C2 配额 UI | 在 "配额" tab 设 org-level + 进度条变绿/黄/红 |
| D1 Peer Registry | 在 "Peers" tab 加一个不存在的 peer(假 token),看 backoff 5s/15s/30s/60s ladder |
| E1 软上限告警 | 上面 C2 同事;跨 80% / 100% 时看 audit_log 输出 `org_quota_warn` / `over` |
| D2 跨 hub HITL | 需要双 host;按 §3 setup |
| E2 reputation | 看 `.aipehub/feedback/reputation/*.json`(D2 跑过几次就有数据) |

## 5. 路径补全:每个 example 用到哪些 Phase 5 feature

| examples/ | A1 | B2 | C1 | C2 | D1 | D2 | E1 | E2 |
|---|---|---|---|---|---|---|---|---|
| hello-collab | ✅ | — | ✅ | — | — | — | — | — |
| industry-consultation-deepseek | ✅ | ✅ | ✅ | — | — | — | — | — |
| cross-org-rfp(旧名 v1) | ✅ | ✅ | ✅ | — | ✅* | ✅* | ✅* | ✅* |
| federated-team | ✅ | — | — | — | ✅ | — | — | ✅ |
| mcp-tools-llm-agent | ✅ | ✅ | ✅ | — | — | — | — | — |

*打 ✅* 的项表示 example 仍按 Phase 4 的 hand-wired 双 hub 跑,**没
强制升级**到 D1 PeerRegistry — 既有的设置脚本仍工作,只是没用 Phase 5
的 admin UI 配 peer。想升级走 §3 步骤即可。

## 6. 为什么没新建 personal-rag/ org-handbook/ 目录

总体设计哲学:**aipehub 的核心是 hub + agent + workflow,RAG / knowledge
是 MCP 生态的事**。如果给每种 MCP 用法都建一个 example 目录,monorepo
会被 chroma-mcp / qdrant-mcp / pinecone-mcp / brave-search-mcp /
github-mcp / sqlite-mcp ... 灌满,但每个目录的核心其实只是改一行
agent json 配置。

**取而代之**:`docs/zh/RAG-VIA-MCP.md` 把 RAG 一类用法集中讲清楚,这里
按"想看什么 → 复用哪个现成 example + 改这几行配置"的速查表展示。

如果以后某个 MCP 用法需要 cross-package 联动(像 cross-org-rfp 需要
host + identity + transport-ws + workflow 全部接好),才考虑建 example
目录。当前 Phase 5 不需要。
