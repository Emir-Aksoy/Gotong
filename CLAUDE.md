# AipeHub — Agent 北极星 (CLAUDE.md)

> 本文是给 Claude / 任意 LLM agent 看的项目根级指南。每次新会话第一件
> 事就是读它，避免重建上下文跑偏。人类读者也可以读，但更友好的入口是
> `README.md` / `docs/zh/OVERVIEW.md`。
>
> Last updated: 2026-05-26

---

## 一、本项目存在的意义（北极星）

AipeHub 要做的是 **AI 时代「人-智能体-机构」三层链接的工作底座**：

```
   第 1 层  人 ↔ 自己的 AI / agent
            「我的 AI 桌面」: 一个人的 hub, 私人 workflow, 凭证只在本机
            目标: 5 分钟跑起来, 不写代码, AI 帮我做实际的事

   第 2 层  人 / agent ↔ 别的人 / agent / 机构
            「跨组织协作」: 多 user, role, 邀请, 跨 hub federation
            目标: 工作流可跨边界, 但凭证/数据/计费各归各家

   第 3 层  框架本身
            「清晰 + 稳定 + 适配」: Hub is dumb on purpose, file-first,
            participant 是统一抽象, 协议 / 凭证 / 配额都有显式边界
            目标: 工作流能实际落地, 跟得上 AI 快速发展
```

**三句话守则**:

1. **框架不跑 LLM**。Hub 只路由消息 / 派 task / 写 transcript / 发事件,
   决策权永远在参与者(agent / 人 / 外部服务)手里。这是从 v0 到现在
   不变的设计立场, 改了就不是 AipeHub。

2. **人和 agent 是同一个 `Participant`**。不要把人当 "request_human_input
   tool"。一切跨人 / 跨 agent 的协作都走同一套消息 + task + transcript。

3. **状态都是磁盘文件**。`.aipehub/` 目录里能看到 transcript / agents /
   sessions / secrets / vault。复制目录 = 搬走房间。重启透明。

---

## 二、现在在哪一段(2026-05-26 快照)

| 阶段 | 状态 | 关键资产 |
|---|---|---|
| v1.x | 完 | Hub + 三种调度策略 + 文件 transcript |
| v2.0 | 完 | File-first workspace, admin URL 引导 |
| v3.0 (Services) | 完 | Services 插件 + workflow engine + MCP server/client + 凭证加密 |
| v3.1.0 | 完 | 单文件 binary, Docker, observability, MCP tool-use loop |
| v3.4 audit | 完 | 1.5-7b 9 项安全加固(本地, 未 release) |
| v4 Phase 1-3 | 完 | identity (users/credentials/sessions/audit/invitations) |
| v4 Phase 4 | 完 | 跨 org federation (peerToken / Task.origin / ACL) |
| v4 Phase 5 | 完 | vault / 配额 / OrgApiPool / peer registry / 跨 hub HITL / SPA + setup wizard |
| v4 Phase 6 | 完 | 6 项 feature + 17 项 audit (P0+P1+P2+P3 全清) |
| v4 Phase 7 | 完 | 个人模式 first-class (org_mode auto-detect + SPA 分流 + 升级流) |
| v4 Phase 8 | 完 | LLM streaming 全链路 (LlmProvider.stream, transcript chunk, admin UI 实时打字, 删 complete) |
| v4 Phase 9 | 完 | 多模态 content blocks (image / audio / file_ref + workflow upload + admin UI 渲染 + LlmAgent messages 入口) |
| **v4 Phase 10** | **下一步** | Agent → 子 agent dispatch toolset |

**Phase 6 已落地**:
1. Peer reputation 只读 dashboard
2. LLM 401 自动 revoke vault
3. per-org OrgApiPool 分流
4. inbound peer per-peer token + resolver echo
5. invitations 总数硬上限
6. PeerRegistry inbound rate limit
7. 17 项 audit (#141-#157) — P0+P1+P2+P3 全清

**Phase 7 已落地**:
1. 项目根 CLAUDE.md + Phase 7-13 路线规划 (51 milestones)
2. 个人模式 first-class — `org_mode` auto-detect (单用户 → personal)
3. SPA 首屏分流 — role chip 隐藏 / 副标题"我的 AI 桌面" /
   设置区"升级到团队"按钮 (用户决策: tab 都保留可见)
4. 自动 + 显式升级 personal → team
5. env `AIPE_MODE` 强制覆盖
6. README + `docs/zh/PERSONAL-MODE.md` 文档

详见 `docs/zh/V4-PHASE7-FINAL.md`.

**Phase 9 已落地**:
1. `LlmContentBlock` union 扩 image / audio / file_ref + `LlmImageSource` 三种 kind
   (base64 / url / artifact_ref) + `LlmArtifactResolver` + 1 MB inline cap + 错误类
2. `AnthropicProvider` / `OpenAIProvider` 多模态翻译 — Anthropic vision, OpenAI image_url
   + input_audio (model gating), file_ref → 按 mime 分流
3. Workflow `type: 'file'` 字段 + `accept` / `maxSizeMb` schema
4. `POST /api/admin/uploads` 上传 (raw octet-stream, 50 MB ceiling) + host 侧
   `shared/uploads` artifact namespace + artifactId 规范 `uploads/<date>/<rand>.<ext>`
5. `GET /api/admin/uploads?id=...` 下载 + admin UI 多模态渲染 (transcript inline
   `<img>` / `<audio>` / 📎 download anchor)
6. `LlmTaskPayload.messages?: LlmMessage[]` — LlmAgent 多模态 first-class 入口
7. `examples/multimodal-vision` end-to-end demo

详见 `docs/zh/V4-PHASE9-FINAL.md`.

---

## 三、目前的微偏 + 缺失(短期修)

### 偏 1: 「个人模式」入口被「组织模式」盖住

`V4-ARCH.md` 第一条决策 "单 host = 单 org" 是对的, 但目前所有
UX 入口都从 admin 视角进。**个人用户应该有 first-class 入口**:

- 缺一个 `personal-hub` bootstrap 模板(一键创"单 user / 单 member 的 org")
- README quick-start 加「个人模式」段落, 与团队模式并列
- admin UI 首屏检测到「单 user / 无邀请 / 无 peer」时, 渲染"个人 AI 桌面"而不是 admin 控制台

### 偏 2: 灵活性在「协议外」偏弱

| 通路 | 状态 |
|---|---|
| 浏览器 admin UI | 完整 |
| Node SDK | 完整 |
| Python SDK | 完整 |
| MCP server / client | 完整 |
| 移动端 / PWA | 缺 |
| IM bridge(微信/Telegram/Slack) | 缺 |
| 交互式 CLI shell | 只有 `demo:cli-human` |

补的话从 IM bridge 起步成本最低 — 复用 MCP server 思路, 一个 bot
进程把 IM 消息翻成 Hub dispatch, 把 transcript 推回 IM。

### 偏 3: AI 时代新范式

| 范式 | 现状 | 短期可补 |
|---|---|---|
| LLM streaming | ✓ Phase 8 完 | — |
| 多模态 content | ✓ Phase 9 完 (image / audio / file_ref + workflow upload + admin UI) | — |
| Agent → 子 agent | LlmAgent 只能调 tool, 不能 dispatch | **Phase 10** — 加 `LlmAgentToolset.dispatch` toolset, 让 agent 通过 tool-use 调 capability |
| Long-running agent | 靠 deadline + retry | 加 `agent.suspend(resumeAt)` + 持久化 working memory |
| RAG | 走外部 MCP server(B3/B4) | 维持现状; 但给个 default RAG MCP server 推荐 + setup 文档 |

---

## 四、工作守则(开发指令)

### 4.1 与用户约定(会话级反复强调, 不要违反)

- **GitHub 上传暂停**: 项目完全放本地, 除非用户明说"现在可以 push"。
  - 不 `git push`, 不开 PR, 不调 GitHub API 写操作, 不跑 remote workflow
  - 所有 commit 都堆本地 `main`, 等用户解禁
- **不要动备份**: `~/Backups/AipeHub/` 是历史快照, 只读
- **不需要向前兼容**: 还没上线, 大胆改 schema / API。删旧代码比加 deprecation shim 优先
- **代码尽量简化, 节点尽量轻量**: 每个 PR 一个小目标, 别一次塞 5 个 feature
- **一个任务一个任务**: 规划完一项 → 开发 → 测试 → commit → 下一项
- **Auto Mode bias**: 不要每步都问; 不清楚的地方留 inline 注释说明默认选择, 用户会 redirect

### 4.2 代码风格

- TypeScript ES modules(`type: "module"`), `.js` 后缀 import path
- pnpm workspace, 包间引用走 workspace protocol
- 测试用 vitest, 每个新 feature 配回归测试
- 错误用 `IdentityError` / 类似类型化错误码, 不抛裸 Error
- 日志用 `@aipehub/host` 的结构化 logger(JSON / pretty 自适应)
- 注释写「为什么」, 不写「是什么」。代码自身能读出"是什么"
- 不要无故添 emoji 到文件 / commit message。除非用户明说

### 4.3 commit message 风格

参考最近 commit:
```
feat(transport-ws,host): inbound peer rate limit (Phase 6 #12)
fix(security,host,identity): Audit Phase 6 P0+P1 batch (#141-147)
docs(audit): v4 Phase 5 full audit — 15 modules, no P1/P2 hotfixes (F1)
```

- 前缀 `feat / fix / docs / refactor / chore / test`
- 括号里列动到的包名
- 短描述 + 阶段号 / issue 号
- body 写"为什么"
- 末尾固定 `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`

### 4.4 何时停下来问

- **schema 不可逆变动**(drop column, drop table): 哪怕"不需要向前兼容",
  也确认一下是否要保留迁移脚本
- **删除现有 public API surface**: 即使没人在用, 也描述影响面再删
- **架构 fork 选择**(比如 "streaming 走 SSE 还是 long-poll"): 把选项列出
  来, 推荐其一, 等用户拍板
- **生产凭证 / .env**: 永远不读不写不 commit

---

## 五、关键文档地图(agent 用)

| 想知道什么 | 读哪 |
|---|---|
| 5 分钟总览 | `docs/zh/OVERVIEW.md` |
| 框架设计哲学 + 模块边界 | `docs/zh/ARCHITECTURE.md` |
| 协议规约(v1.2) | `docs/PROTOCOL.md` |
| v4 整体架构 + Phase 路线 | `docs/zh/V4-ARCH.md` |
| 跨 org federation 模型 | `docs/zh/V4-PHASE4.md` |
| Phase 5 收尾(配额 / vault / peer) | `docs/zh/V4-PHASE5-FINAL.md` |
| 完整审计报告 | `docs/zh/AUDIT-v4-phase5.md` |
| MCP 接入(client + server) | `docs/zh/MCP.md` |
| Services 插件 RFC 系列 | `docs/services-rfc.md` 及 `*-rfc.md` |
| 部署 / 运维 / 监控 | `docs/zh/DEPLOY.md`, `docs/OPERATIONS.md`, `docs/MONITORING.md` |
| 历史 commit 流水账 | `CHANGELOG-v3-dev.md`, `CHANGELOG.md` |

---

## 六、目录结构速查

```
packages/                       19 个包, pnpm workspace
├── core/                       Hub, Scheduler, Storage, Participant
├── protocol/                   wire protocol(v1.2), zero runtime
├── transport-ws/               WebSocket transport + HubLink (federation)
├── sdk-node/                   Node 客户端 SDK
├── identity/                   v4 — users/credentials/sessions/vault/quota/peers
├── host/                       生产 host 二进制 (main.ts)
│   └── src/
│       ├── local-agent-pool.ts        host-managed agents
│       ├── org-api-pool.ts            per-org LLM key cache
│       ├── peer-registry.ts           federation peer 拓扑
│       └── ...
├── web/                        admin UI HTTP + SSE + SPA
├── llm/                        LlmAgent + LlmProvider 抽象
├── llm-anthropic/              Anthropic provider
├── llm-openai/                 OpenAI / DeepSeek / Qwen / Ollama (compat)
├── workflow/                   YAML workflow runner
├── mcp-server/                 MCP server (Claude Desktop / Cursor 调 hub)
├── mcp-client/                 MCP client (agent 调外部 MCP tools)
├── services-sdk/               services plugin contract
├── service-memory-file/        memory(jsonl)
├── service-artifact-file/      artifact(file)
├── service-datastore-sqlite/   datastore(sqlite)
├── cli/                        aipehub CLI(主要给 demo)
└── evals/                      workflow / prompt 评测

python-sdk/                     PyPI `aipehub`
templates/                      agents / teams / workflows / bundles / community
examples/                       17 个端到端 demo
docs/  docs/zh/                 双语文档
scripts/                        backup / restore / verify / prune
monitoring/                     prometheus + grafana
```

---

## 七、下一步建议清单(供 agent 起步时挑)

按"对北极星贡献度 / 工作量"排:

| 优先 | 任务 | 工作量 |
|---|---|---|
| 现在 | 清 Phase 6 P2 backlog #148-#152 | 半小时 |
| 短期 | 写一个 `personal-hub` bootstrap 模板 + README 加段 | 半天 |
| 短期 | LLM streaming 接口设计 + 一个 provider 落地 + SSE 透传 | 1-2 天 |
| 短期 | Phase 6 P3 backlog #153-#157 | 1-2 天 |
| 中期 | Agent-to-agent dispatch toolset(让 LlmAgent 能调 capability) | 2-3 天 |
| 中期 | 多模态 content blocks 扩展(`LlmMessage.content` 加 image / file_ref) | 2-3 天 |
| 中期 | 一个 IM bridge demo(Telegram bot 最简易, 复用 MCP 思路) | 3-5 天 |
| 长期 | Long-running agent 范式(suspend/resume + persistent working memory) | 1-2 周 |
| 长期 | Mobile PWA / 微信小程序入口 | 2-3 周 |
| 长期 | AI-辅助 workflow 编辑器(自然语言 → YAML) | 2-3 周 |

不要把这张表当 backlog 死磕 — 它只是"如果用户问'下面做什么'时, agent
不至于卡住"的备选。**用户指令 > 这张表**。
