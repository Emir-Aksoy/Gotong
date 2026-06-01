# AipeHub — Agent 北极星 (CLAUDE.md)

> 本文是给 Claude / 任意 LLM agent 看的项目根级指南。每次新会话第一件
> 事就是读它，避免重建上下文跑偏。人类读者也可以读，但更友好的入口是
> `README.md` / `docs/zh/OVERVIEW.md`。
>
> Last updated: 2026-06-01

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

## 二、现在在哪一段(2026-05-31 快照)

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
| v4 Phase 10 | 完 | Agent → 子 agent dispatch toolset (DispatchToolset + ancestry/cycle gate + cross-hub passthrough + workflow allow-list + admin UI chain + architect-team example) |
| v4 Phase 11 | 完 | Long-running agent (SuspendTaskError + suspended_tasks SQLite + resume sweep + Hub.resumeTask + LlmAgent working memory + long-running-agent example) |
| v4 Phase 12 M1-M8 | 完 | IM bridges 全集 (im-adapter + telegram + matrix + lark + discord + slack + qq) + host-side router example + IM-BRIDGES.md cookbook |
| v4 Phase 12 M12 | 完 | `aipehub repl` 交互式 shell (in-memory hub, `:help`/`:agents`/`:transcript`/`:dispatch`/`:quit`, 44 新测试) |
| v4 Phase 12 M13 | 完 | `docs/zh/V4-PHASE12-FINAL.md` release notes (M1-M8+M12 总结, +460 新测试, 数据流端到端示意, 运维须知, 未做列表) |
| v4 Phase 13 M1 | 完 | `WorkflowAssistantAgent` — 自然语言 → workflow YAML 草稿 + 自 validate + `draftStatus` (`'valid'/'no_yaml'/'invalid'`) (commit 823c49a, 0b59a21) |
| 2026-05-27 Codex 审计整改 | 完 | protocol↔core 依赖反转 (协议层零运行时名副其实), `@aipehub/workflow-assistant` 拆出独立包 (runner 包不再依赖 llm), `test:python` 一键脚本修, AGENTS.md → CLAUDE.md symlink, `audits/` 归档目录约定 |
| v4 Phase 13 M3 | 完 | Admin UI workflow AI 助手 (commit d70acdb) — host 注册 `WorkflowAssistantAgent` + `POST /api/admin/workflows/assist` + admin UI 对话框 (描述 → 生成 → status chip → 保存为 workflow) |
| v4 Phase 13 M4 | 完 | `@aipehub/evals/checkers/workflow-structure` 深度检查 (commit a5afe5a) — 6 类 violation (unknown_agent/capability/bad_ref/forward_ref/self_trigger_cycle/id_collision); WorkflowAssistantAgent 自动注入 `output.deepCheck`; admin UI 黄色 warnings panel + 列表；+40 测试 |
| v4 Phase 13 M5 | 完 | `examples/workflow-assistant/` 端到端 demo + `docs/zh/AI-WORKFLOW-EDITOR.md` 800 行 release notes (commit d9a9e79) — 4 scenario × 4 provider (DeepSeek/Anthropic/OpenAI/mock); 真 DeepSeek 跑通 deepCheck 抓住 LLM 编的 `image-generation`/`discord:send` capability; 全链路 ASCII 数据流图 |
| Phase 13 follow-up: few-shot | 完 | `@aipehub/workflow-assistant` 自带 3 个 templates 当 few-shot examples (commit 7dec7fc); host 默认注入, `AIPE_ASSISTANT_NO_EXAMPLES=1` 关 |
| Phase 13 follow-up: streaming UI | 完 | admin UI assist 对话框接 Phase 8 streaming — 蓝色 preview pane 实时打字 (commit b873c99); mock provider 默认 `textChunkCount=8` 让 mock 也演示流 |
| 2026-05-28 P3 拆巨型文件 (首批) | 完 | `packages/web/src/workflow-routes.ts` 拆出 6 个 workflow 路由 (server.ts 3701→3578); `packages/web/static/admin-wf-assist.js` 拆出 AI 助手对话框 (admin.js 3641→3363, factory pattern); zero regression (329 web + 253 host) |
| 2026-05-28 P3 batch 2 + 收尾 | 完 | server.ts 续拆 (3578→2780, -798): `agents-routes.ts` (8 路由) / `services-routes.ts` (7 路由) / `uploads-routes.ts` (2 路由) + 删死 helper (validateAgentBody/publicAgent/sendServiceError/readRawBody); `aipehub init` CLI 命令 (Space.init, 个人模式默认, `--pin-team` 提示 `AIPE_MODE=team`); `examples/rag-mcp/` (chroma-mcp 配置 + 交叉引用 `docs/zh/RAG-VIA-MCP.md`); zero regression (web 339 + host 253 + cli 88) — commit c74d327 + f92ea80 |
| 2026-05-28 P3 batch 3: server.ts setup 路由 | 完 | `packages/web/src/setup-routes.ts` 拆出 `/api/setup/*` (needs-bootstrap + owner-password, loopback-only + 匿名审计); server.ts 2780→2690 — commit f190b6e |
| 2026-05-28~29 P3 admin.js ESM 拆分 | 完 | esbuild bundler (iife, charset=utf8 保中文; Phase 1 零行为变化) + 三个 ES module factory: `services.js` (Hub Services tab) / `managed-agents.js` (agent CRUD + key + import, setDom 注入共享 dom) / `workflows.js` (面板 + 导入 + 运行历史)。admin-src/main.js 3103→2344 (-759); workflow-start + 多模态/字段渲染共享层 + wfAssist + bundle import 故意留 main.js (跨 Tasks/HITL 耦合, 拆需先剥共享渲染层)。zero regression (web 341 + typecheck + bundle smoke) — commit c961500/e6cef32/570a823/001f41c |
| **v4 Phase 12 M9-M11** | 完 | PWA app-shell (manifest + sw.js + icon.svg + offline.html + app.html 接线 + app.js SW 注册, `/api/*` 永不缓存含 SSE) + 移动端响应式 (`@media` 720/420 单列 + 可横滚表格 + 16px 输入防缩放 + 触控目标 + sticky tabbar) + 5 PWA 测试; commit 7fe8a27 + c9dd395 |
| **v4 Phase 14 M1-M8** | 完 | `/me` 成员工作台通用化 — 删硬编码 `ALLOWED_WORKFLOWS`, catalog 请求时从 `surface.me.enabled` 派生 (workflow schema → host `surfaceMe` → web 鸭子类型 → `GET /api/me/workflows`); 泛化 `POST /api/me/dispatch` 强制 `payload[userScopeField]=userId`; 3 个 shipped member-facing 工作流 (PG/daily-reflection/weekly-goal-checkin); 前端 Home tab 吃 catalog + 动态字段; commit 2ba00d5→df9c2a5 |
| **v4 Phase 15 M1-M8** | 完 | 工作流生命周期 + 版本化 — `draft→review→published→deprecated→archived` 纯状态机 + 不可变修订 (整数 rev + sha256 contentHash); 两个文件优先 store (`FileRevisionStore` 写一次性 / `FileLifecycleStore` 原子重写); **消除 run 漂移核心**: runner 注入 `DefinitionResolver`, run 启动钉 `definitionRevision`, resume 按该修订解析不可变快照; host `WorkflowVersioning` 唯一注册权威 + Model-B import (导入即发布 rev1); web 鸭子 lifecycle 路由 + `/me` published 闸门; admin UI state 徽章 + 修订历史 + 回滚; **无漂移 E2E 验收门** (真栈 7 步: import→挂起绑 rev1→publish rev2→resume 仍跑 rev1→rollback→新派发跑 rev3); commit b174367→5070d98 |
| **v4 Phase 16 M1-M8** | 完 | 成员任务 inbox (human-in-the-loop 工作流步骤) — 新包 `@aipehub/inbox` (`InboxStore`/`FileInboxStore`/`HumanInboxParticipant` broker, 只依赖 core); `human:{assignee,kind,prompt}` YAML 糖 import 期脱糖成 dispatch→cap `aipehub.human/v1` (runner/resolver/deepCheck 零改, assignee 可 `$ref`); broker 写 inbox item + 抛 `SuspendTaskError(永不 resumeAt)` 复用 Phase 11; host `HostInboxService` 两步恢复 (子 broker 严格先于父 workflow, `markResolved` race 守卫, `validateDecision` 服务端权威); web 鸭子 `InboxSurface` + `/me/inbox` 路由 (GET list / POST resolve) + 手写 SPA inbox 面板 (approval/choice/edit 三态渲染); **无漂移 E2E 验收门** (human 挂起期间 publish rev2, resolve 后仍跑 rev1, sweep 取不到 human 行); +39 测试; commit `e464b32`→`be4754a` |
| **v4 Phase 17 / Sprint 4 M1-M8** | 完 | 用量·成本账本 + 配额 fail-closed + 审计导出 — identity `usage_ledger` 表 (v=11) + `LedgerStore` (逐条 LLM 调用原始账本, append-only 无 FK 同 `audit_log`, 成本整数 micro-USD); host `pricing.ts` 价目表 (前缀匹配, `<AIPE_SPACE>/pricing.json` 覆盖) + `estimateCostMicros`; llm `usageSink` 钩子 (每 provider 响应触发) → 双账: ① 账本恒写 (含 mock 记 unpriced $0) ② 预算计数 `recordUsage` 累计 (归因+非 mock); 配额闸扩 `budgetPeeks` (pre-call peek `llm_tokens`/`llm_cost_micros`, used>=quota → fail-closed + `api_quota_denied` 审计); web 鸭子 `UsageLedgerSurface` + 账本/审计 CSV·JSONL 导出路由 (owner 闸后, ≤10k 行) + admin `用量` 看板 (按维度汇总 + 4 导出链接); **E2E 验收门抓出 fail-OPEN bug** — 记账误用带闸 `checkAndIncrement` 致 `used` 卡 cap 下方、peek 永不触发, 修复为 ungated `recordUsage`; +66 测试 (identity 289/web 465/host 368); commit `586b594`→`4ecd180`; 详见 [`docs/zh/V4-PHASE17-FINAL.md`](docs/zh/V4-PHASE17-FINAL.md) |
| **草稿列表 UI** | 完 | 2026-05-31 — admin `工作流` 面板列出全状态工作流 (补 Phase 15 遗留: 草稿存了但 admin UI 看不见、无发布入口)。`WorkflowController.listAll()` 复用 `summaryFromView` 但去掉 `!registered` 过滤, 排序 live→authoring→archived→id; admin `GET /api/admin/workflows` 切 `listAll` (/me 成员 catalog 仍用 live-only `list`, 无泄漏); admin UI `lifecycleButtons` 按 state 出合法转移按钮 (draft→提交审核/发布; review→发布/退回草稿; archived→只读修订历史) + 「开始」仅 live (草稿无 runner); 发布 confirm 改 state-neutral; +3 测试 (host listAll 排序 + web 路由断言 listAll); commit `e6799c1`+`869da91` |
| **v4 Phase 18 / Sprint 5+6 A/B/C** | 完 | 联邦能力 manifest + 跨组织 policy + A2A 闭环 — **Track A**: host `peer.manifest` RPC provider (`buildLocalManifest` 排除 peer wrapper, 多路复用现有 `rpcResponder`: `startsWith('mcp.')` 分流) + in-mem cache (online/stale/unknown 三态, 不加表 — 重启诚实 unknown) + admin 联邦 tab 浏览/刷新。**Track B**: identity v12 加 4 列 per-peer 信任契约 (`kind`/`acl_json`/`outbound_caps_json`/`require_approval_outbound`, 加性 ALTER); peer-registry 把持久 ACL 真正传进 `installPeerLink` (此前类型存在但没接线 → 入站 `cross_org_acl_denied` 生效) + `refreshPolicy` 拆链重连; **出站审批闸** `ApprovalGatedParticipant` 装饰 `RemoteHubViaLink` (`wrapOutbound` hook), 命中 `requireApprovalOutbound` → 写 `approval` inbox item + `SuspendTaskError(NEVER_RESUME_AT)`, 批准才 `inner.onTask` 实发 (复用 Phase 11/16 零新挂起设施); 三不变量 (NEVER_RESUME_AT / 必须 `onResume` / parentKind 从 ancestry 算 — 纠正 plan 草稿: workflow 派发确需两步恢复)。**Track C**: agent card skills opt-in 翻 honest (`AIPE_A2A_ADVERTISE_SKILLS`, capability flags 仍全 false — 只做 blocking `message/send`); 新包 `@aipehub/a2a` (wire 类型 + `a2aSend` client, `fetchImpl` 可注入); 入站 `A2aServer.handle` (`X-Aipe-Peer-Id`+Bearer → `buildPeerTokenResolver` 常量时间比 fail-closed → 401; capability-only dispatch 绝不 explicit; ok→`agentMessage`/suspended→`-32001`); 出站 `A2aRemoteParticipant extends AgentParticipant` (`AIPE_A2A_AGENTS` JSON 注册, token 从 `tokenEnv` 读不内联); **双 hub A2A smoke 验收门** (真 loopback HTTP + global fetch, 确定性往返 `echo: hello` + 错 bearer→failed + 错 skill→failed)。+~50 测试 (a2a 15/host 419/web 483, 零回归); commit `d7a2842`→`f43d61f`; 详见 [`docs/zh/V4-PHASE18-FINAL.md`](docs/zh/V4-PHASE18-FINAL.md) |
| **v4 Phase 19 / P1** | 完 | 「我的 AI 桌面」成员工作台收口 (6 M) — `/me` 从「派发表单」补齐到自洽工作台。**P1-M1** 核实 run 已带发起人 (`RunState.triggeredByOrigin.userId`, `/me/dispatch` 落 `origin:{orgId:'local',userId}`, runner 持久化) → **无需加字段** (§四确认点自动消解), `RunStore.listByUser`; **P1-M2** `GET /api/me/runs` + catalog `latestStatus`/`lastRunAt` (复用 `WorkflowSurface` 加 `listRunsByUser`, 窄 `MeRunSurface` 结构满足 → 少一根注入线); **P1-M3** `GET /api/me/agents` 脱敏投影 (脱敏在 host, web **永不接触** `managed.system`/model/baseURL/key; capability 是功能标签照常出); **P1-M4** `/api/me/uploads` 成员上传 (`uploads/me/<userId>/`, scope + 下载 prefix 都从 session userId 派生非客户端值, host `scopePrefix` path-safe 校验当纵深); **P1-M5** 前端「最近运行」+「我的 AI 助手」面板 + `file` 字段真上传器 (submit-time 上传 → `{type:'file_ref',artifactId,mime}` 块, 同 admin wf-start 契约不留孤儿, 删占位); i18n 跟随既有 `/me` 硬编码中文约定 (全面 i18n 是单独 retrofit); web 496 绿; commit `4dc266e`→`7eff102`; 详见 [`docs/zh/V4-PHASE19-P1-FINAL.md`](docs/zh/V4-PHASE19-P1-FINAL.md) |
| **v4 Phase 19 / P2** | 完 | Workflow 治理收口 (6 M, M5 拆 a/b/c) — workflow 从「能跑」到「能治理」。**M1** import/publish runtime-aware 硬闸 (`checkWorkflowStructure` vs live inventory; 🔴 bad_ref/forward_ref/self_trigger_cycle/id_collision 全拒, 🟡 unknown_agent draft-ok-publish-blocked, ⚪ unknown_capability 仅建议保 bundle 流; 只交互写路径不 boot); **M2** 五动作进 `AUDIT_ACTIONS` (`workflow_import/publish/deprecate/archive/rollback`) 写 `audit_log` (sink 从 `ctx.identity` 取, 窄 `WorkflowAuditSink` 结构满足零接线, best-effort, metadata 钉 workflowId/rev/state); **M3** owner-gated 查询+CSV/JSONL 导出 (`/api/admin/identity/audit/workflows[/export]`, 泛化 `listAuditLog` 加 actions[]/since/until/metadataEquals 注入安全); **M4** admin 修订 modal 加治理审计子区 (复用 modal 接线零新卡按钮); **M5 资源级 RBAC** (Option B, identity v13 加性 `workflow_grants` 表): **M5a** owner-as-grant 单表 + `WorkflowGrantStore` + `has(min)` fail-closed; **M5b** 路由 enforce — RBAC 仅当接 grants+resolveActor 才 ON, 两类 operator (v3 admin / v4 owner) 绕过 = 零回归, 唯一受限是 role='admin' 的 v4 用户, import/draft seed owner, lifecycle 要 editor+/delete+grant 要 owner; **M5c** admin 访问控制面板 (grant 行 + 添加表单 + 撤销, 各按 gate 降级); +42 测试 (identity 307 / web 524 / host 425); commit `926ef29`→`077142c`; 详见 [`docs/zh/V4-PHASE19-P2-FINAL.md`](docs/zh/V4-PHASE19-P2-FINAL.md) |
| **v4 Phase 19 / P3** | 完 | 生产级安全与运维收口 (4 M) — 「能跑」→「能上线运维」。**M1** Prometheus 业务指标 (纯读不加表, 采集/渲染分离保 web 零依赖): 新 `business-metrics.ts` 异步采集器 (窄鸭子 `MetricsWorkflowSource`/`MetricsIdentitySource`, best-effort 逐族 try/catch, `/metrics` 永不 500) + `metrics.ts` 加 6 series (`aipehub_workflow_runs{status}`/`_scan_capped`/`aipehub_suspended_tasks`/`aipehub_llm_{calls,tokens,cost_micros}_total{model}`); run 扫描封顶 `RUN_SCAN_CAP=2000`+诚实标志; identity `countSuspendedTasks()` (数全部 parked 含 NEVER_RESUME_AT). **M2** restore smoke (测试即交付物) `backup-restore-smoke.test.ts`: 种子→真 bash `backup.sh`(tar -tzf 断言无 master key/有加密 secrets)→`restore.sh`(内跑 verify.sh, 断言 `0 errors`)→结构不变量→`Space.open`+Hub+serveWeb boot→`/healthz`+v3 admin token 仍验+2 agent 完整; 钉死「加密 secrets 随备份走、key 不走」「token 经往返仍有效」; ~90ms 确定性, 缺 bash/tar/jq skip; **不改 bash 脚本**. **M3** 文档诚实化 (doc-only, 决策点预拍板): GitHub advisory 唯一安全渠道**不设邮箱** (SECURITY.md 「Backup—email」→「No email channel」, security.txt 删死 `mailto:` Contact), Docker+source 唯一受支持分发, supported-versions 仅 main, `RELEASE-CHECKLIST.md` 记录决定带日期. +10 测试 (web 530 / identity 308 / host 428); commit `117294e`→`35fe949`; 详见 [`docs/zh/V4-PHASE19-P3-FINAL.md`](docs/zh/V4-PHASE19-P3-FINAL.md) |
| **v4 Phase 19 / P4** | 完 | 联邦信任契约收口 (5 M) — federation 从「可发现」→「多组织互不污染」。**M1** 🔴 出站 capability allowlist 强制 (`0c8c26f`): 新 `core/peer-acl.ts` 入站/出站共用 `extractRequiredCapabilities` 防漂移; `RemoteHubViaLink.onTask` 碰链路前校验 `outboundCaps`, 拒 `outbound_capability_denied:<cap>` (link 前最后 chokepoint, 装饰器绕不过); `null`=全放/`[]`=锁死/explicit+无过滤 broadcast 设白名单时一律拒. **M2** peer-aware ledger 归属 (`a635e69`, identity v14) ⚠️ — **决策点=轻量+仅 `peer_id`** (org_id/user_id 已从 task.origin 捕获, link_id 冗余); `usage_ledger ADD peer_id`+索引, host `resolveLedgerPeerId(task.origin.orgId→getPeerByPeerId→row.id)`, admin `用量`+「联邦对端」维度. **M3** rich manifest (`58d03a2`): `PeerManifest.capabilities` `string[]`→`PeerCapability[]{id,version?,costHint?,dataClasses?}`, `PEER_MANIFEST_VERSION='2'`, `normalizePeerCapabilities` 兼容老 `string[]`, admin `renderCap` 富渲染. **M4** per-link 契约 (重) ⚠️ — **决策点=全做**, 拆 a/b/c: **M4a** (`7af9488`, identity v15) `peers` 加 `revocation_state`/`per_link_quota_budget`/`allowed_data_classes_json` + store (undefined 保留/null 清空/撤销无 null); **M4b** (`15735fa`, protocol/core) `Task.dataClasses` + `checkOutboundDataClasses` (同 chokepoint, 是闸非 redaction) + `installPeerLink({inboundGate})` 接缝; **M4c** (`d0f0d38`, host/web) 撤销三闸 (tick 拆链/installInboundLink 拒/`buildPeerTokenResolver` 线缆层拒) + `inboundQuotaGate` (per-link `FixedWindowLimiter` 跨重连保留防刷新预算, 越界 fail-closed, 重启归零) + `allowedDataClasses` 穿两 install 点 + `AIPE_PEER_LINK_QUOTA_WINDOW_MS` + web 契约三件套 CRUD/校验 + **多组织隔离 E2E 验收门** (`peer-isolation-e2e.test.ts`: home 连 orgX 夹紧+orgY 全开, 同 pii 任务发 X 拒发 Y 通, X 入站配额越界 Y 不受限 — 自由图「夹紧一条不外溢」). admin=API 配置沿用 B-M2 先例 (专门 peer-policy 编辑器推迟). +40 测试 (core 308/identity 315/host 434/web 537, 零回归); 详见 [`docs/zh/V4-PHASE19-P4-FINAL.md`](docs/zh/V4-PHASE19-P4-FINAL.md) |
| **v4 Phase 19 / P5** | 完 | 生态接入与行业模板 (9 M) — 从「能自洽运转」→「接得上生态、装得下行业」。**adapter** (鸭子类型 + peer dep, 框架永不被导入): **M1** (`448a4fa`) `python-sdk` `adapters/langgraph.py` 包 LangGraph graph 为 `AgentParticipant` (`.invoke`/`.ainvoke` 鸭子, 同步丢线程池, +7 pytest); **M2** (`f420e1c`) `adapters/crewai.py` 同接缝 (`.kickoff` 鸭子, `from_output` 默认抽 `CrewOutput.raw`, +6). **桥两方向**: **M3** (`d080eb8`) `examples/activepieces-bridge` 入站 `createWebhookBridge` (共享密钥 fail-closed 常量比 + capability-only operator 白名单 + HITL→202, 自断言 smoke); **M4** (`823049e`) `examples/windmill-bridge` 出站 `WindmillParticipant` (submit→poll durable job, success:false→failed, token 从 env, fetchImpl 注入). **治理 schema 先于模板**: **M8a** (`a5bcdee`) ⚠️ workflow 加 `governance` 块 (dataSensitivity/requiredCredentials/expectedCostUsd/requiredHumanRoles/externalSystems/notes, 照 `surface` 模式, validateGovernanceSpec import 期校验, **声明非执行闸**) + `WorkflowSummary.governance` 投影 (+13). **三模板覆盖三控制流**: **M5** (`1b6e7f1`) `contract-review-flow` HITL 人闸 (吃 M8a governance + Phase 16 `human:` 法务签字); **M6** (`5b6fe1e`) `lead-qualification-flow` `when:` 条件 (PII+crm-api, E2E 双分支); **M7** (`c9f409e`) `issue-triage-flow` `parallel:` 并行扇出; mock-provider E2E 放 workflow 包 (stub hub, human 步 mock 返回已解析决定, 不重测 suspend/resume). **M8b** (`aeeeff9`) admin UI 卡片 governance 风险摘要面板 (敏感级徽章绿→红 + chip + i18n + CSS + 重建; 数据运行时早已透传, 补 web `governance?` 类型). +33 自动化测试 (pytest 70/host 436/web 537) + 2 example smoke, 零回归; 详见 [`docs/zh/V4-PHASE19-P5-FINAL.md`](docs/zh/V4-PHASE19-P5-FINAL.md) |
| **下一步** | — | Phase 19 P1+P2+P3+P4+P5 全完 (P1→P5 全清; P4 闭合「机构可用」总验收第 10 条, P5 是生态扩展不新增总验收条). Phase 19 收官. 之后方向: framework adapter 扩展 (AutoGen/LlamaIndex, M1/M2 形状照抄) / 真接外部 A2A/framework 的 wire 级互操作测试 / governance 进 audit+修订 diff / `优化#3` dispatch 编排模板 (#16) / `优化#4` 持久化强后端 (#17) / 巨石续拆 server.ts (#19). 未启动, 等用户点名 |

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

**Phase 10 已落地**:
1. `DispatchToolset` (LlmAgentToolset, 暴露单 tool `dispatch_task`) —
   agent 主动通过 tool-use 调度子 agent
2. `Task.ancestry: AncestryNode[]` + Hub.dispatch 深度 gate (默认 5,
   `AIPE_MAX_DISPATCH_DEPTH` env 可调) + 环路 gate (explicit target 在
   ancestry.by 链中 → 拒)
3. `LlmAgentToolset.runForTask(task, fn)` —— ALS.run scoped，并发任务安全；
   `LlmAgent.handleTask` 自动 wrap 整个 task body
4. `installPeerLink` inbound 透传 ancestry —— 跨 hub depth gate 不重置
5. `ManagedAgentSpec.dispatch: { agents, capabilities }` allow-list +
   `ComposedToolset` 把 MCP + dispatch 多路复用
6. Admin UI task detail 渲染 ancestry chain (compact 一行 trace + tooltip)
7. `examples/architect-team` 端到端 demo (architect + writer/reviewer/tester)

详见 `docs/zh/V4-PHASE10-FINAL.md`.

**Phase 11 已落地**:
1. `SuspendTaskError` 控制流异常 + `isSuspendTaskError` 守卫 (cross-realm
   safe) + `Participant.onResume?(task, state)` 接口 + `AgentParticipant`
   的 `handleResume` protected 钩子
2. `TaskResult.kind='suspended'` 加入 union；`DefaultScheduler` 构造接
   `SuspendNotifier`；`runOne` 识别 SuspendTaskError 调 notifier 后返
   `kind: 'suspended'`；broadcast 路径不持久化 (first-ok-wins)
3. Identity SQLite migration v=9 加 `suspended_tasks(task_id PK,
   agent_id, hub_id, origin_user_id, resume_at, state, task_json,
   created_at)` + INSERT OR REPLACE / due-list / by-agent / remove API
4. Host main.ts 把 `identity.persistSuspendedTask` 包装为 Hub
   `suspendNotifier`；resume sweep `setInterval(AIPE_RESUME_SWEEP_MS,
   默认 30s, clamp [1s, 600s])` + reentrancy guard + corrupt task_json
   drop
5. `Hub.resumeTask(agentId, task, state)` —— 不走 dispatch 链路 (depth
   /cycle gate 不重新评估)；写 `task_resumed` transcript event；
   suspend-again 自动 INSERT OR REPLACE 旧行
6. `LlmAgent.runToolLoop` —— tool-use loop body 提到独立方法；每轮 catch
   SuspendTaskError 自动把 `req.messages` 包进 state.`__llmMessages`；
   `handleResume` 读回 messages splice 进新 request 续 loop；用户 state
   保留在 `state.user`
7. `examples/long-running-agent` 端到端 demo (in-process suspendNotifier
   Map + sweep loop, ~1.5s 跑完一个 suspend/resume cycle)

详见 `docs/zh/V4-PHASE11-FINAL.md`.

**Phase 12 M1-M8 已落地**:
1. `@aipehub/im-adapter` — pure types + parseImCommand 共享 SDK
   (ImBridge / ImUser / ImMessage / ImCommand / ImBindingResolver) +
   identity 侧 `im_bindings` / `im_binding_codes` 表 + issue/claim/resolve API
2. `@aipehub/im-telegram` — bot API long-poll (`getUpdates`)，dual-write
   text + attachments，bot mention strip，anti-loop via from.id
3. `@aipehub/im-matrix` — Client-Server `/sync` 长轮询 + access_token + since
   缓存 + room timeline 派发 + `m.room.message` outbound
4. `@aipehub/im-lark` — verification + 加密 webhook (POST 入向, app_access_token
   自动续 2h cache, im.message.receive_v1 事件)
5. `@aipehub/im-discord` — Gateway WSS (op 10/11 heartbeat + identify), MESSAGE_CREATE
   派发, `Channel(messages)` outbound, intents 校验
6. `@aipehub/im-slack` — Events API webhook (HMAC SHA256, 5min replay window),
   event_id dedup (512 entry FIFO), `chat.postMessage` outbound, slack-file URI
7. `@aipehub/im-qq` — OneBot v11 forward WS + echo-paired action multiplex +
   risk gate (`AIPE_QQ_BRIDGE_ACK_RISK=true`) + private/group chatId 编码 +
   array/string-form message 双兼容
8. `examples/im-bridge-host/` 端到端 demo + 可复制的 router (≈250 行胶水) +
   `IdentityStore → ImBindingResolver` adapter + `FakeBridge` (in-memory ImBridge)
   + 9-step lifecycle scripted (help / bind / chat / agents / workflow / unbind)
9. `docs/zh/IM-BRIDGES.md` — 6 bridge 部署 + 调试 cookbook (transport 选型 /
   每桥 setup / docker-compose 片段 / 调试场景 / 安全清单)

不动 `host/src/main.ts` — 用户复制 example 当模板；等社区使用模式稳定后再决定
是否 fold 进 host CLI first-class config (Phase 13/14 决策点)。

**Phase 12 M12 已落地** (REPL subcommand):
1. `aipehub repl` 子命令 — in-memory hub + 默认 echo agent (capability:chat)，
   stdin/stdout 当本地"IM bridge"
2. `src/repl/parse.ts` — 纯函数 `parseReplCommand(line)` 返回 discriminated
   union (`help` / `quit` / `agents` / `transcript[lastN]` / `dispatch` /
   `free` / `noop` / `unknown`)。`:` 前缀做 meta，跟 IM `/` 分清
3. `src/repl/bootstrap.ts` — `createReplHub({defaultAgent?, injectAgents?,
   defaultCapability?})` + `ReplEchoAgent` 默认 agent
4. `src/repl/loop.ts` — `runReplLoop({io, hub, defaultCapability, …})` 主循环 +
   `handleOne` 单 turn 派发，`ReplIo` 抽象让测试 fake、production 用 readline
5. `src/commands/repl.ts` — `aipehub repl` 入口，wrap readline + SIGINT abort，
   `--no-banner` / `--prompt` / `--from` flag
6. `@aipehub/core` 加入 cli 的 runtime dependencies (core 自身零运行时 dep —
   不会拖累 `npx @aipehub/cli` 安装速度)
7. 测试 81 通过 (44 新 — 26 parse + 18 loop + 4 bootstrap)
8. Smoke: `printf ':help\nhello\n:transcript\n:quit\n' | aipehub repl` 端到端

设计上 REPL 跟 6 个 IM bridge 同源 — "string in, agent reply out, transcript
audit on the side"。复用心智模型：IM 用户用 `/help` `/bind`，CLI 用户用 `:help`
`:agents`，agent 派发逻辑完全一致。

**Phase 12 M13 已落地** (release notes):
1. `docs/zh/V4-PHASE12-FINAL.md` — M1-M8+M12 全量总结
2. 八节结构：动了什么 / 为什么做 / 关键设计决策 / 数据流端到端 (Telegram 示例) /
   测试矩阵 (+460 新测试 across 9 packages) / 运维须知 (凭证/webhook/QQ
   风险/SQLite 表/transcript/repl flags) / 未做 (M9-M11 + bridge 扩展 +
   REPL --connect) / Phase 13 入口
3. CLAUDE.md 标 Phase 12 M13 完，capability 表更新；M9-M11 推到下一 phase 可选

详见 `docs/zh/V4-PHASE12-FINAL.md`.

**Phase 13 M1 已落地** (workflow assistant):
1. `WorkflowAssistantAgent extends LlmAgent` — capability=`workflow:assist`,
   id=`workflow-assistant`。住在新包 `@aipehub/workflow-assistant`
   (拆包是 2026-05-27 codex 审计整改, 让 `@aipehub/workflow` runner 包
   重新零 LLM 依赖)
2. 系统 prompt 内嵌 v1 schema 完整契约 (trigger / steps / dispatch /
   $-ref 语法 / 输出格式约定) + 可选 few-shot examples
3. 自包含 schema 文档 + round-trip 测试 (生成的 YAML 必须能 parseWorkflow
   过) 当 drift 哨兵
4. 输出: `{yaml, explanation, raw, text, stopReason, by, usage?,
   draftStatus, validationError?}` —— extends LlmTaskOutput,
   `draftStatus: 'valid' | 'no_yaml' | 'invalid'` 三档由 assistant
   自己跑 parseWorkflow 后定 (M1.5, 审计 P2#2 整改); `invalid` 时附
   `validationError` 给 caller 直接 surface 给用户
5. YAML extraction 三级降级: ```yaml fence → 任意 ``` fence → 全文当
   explanation + yaml='' (LLM 拒绝/走偏的合理 fallback, status='no_yaml')
6. `verdictForYaml(yaml)` 纯函数 export, 让 M2 HTTP route 复用同一
   verdict 函数 (route 拿 status 直接 forward, 不再 re-parse)
7. 不做的事: agent 内部不 self-correct loop (M2 route 拿 invalid 时
   带 validationError 让 caller 决定要不要再问一轮)；不做流式 (Phase
   8 streaming 框架已有, M3 admin UI 自然接入)
8. 测试 31 个 (5 个 verdictForYaml + 4 个 extract + 5 个 render + 3 个
   build prompt + 2 个 defaults + 4 个 request + 4 个 response 含
   round-trip + 3 个 bad payload)

设计上 assistant 是 workflow runner 之上一个独立的 AI authoring 包 ——
让 workflow runner 保持声明式 + 零 LLM dep, 而 AI authoring 是消费
runner 的另一种 client 模式。

**Phase 13 M3 已落地** (admin UI 接入):
1. `packages/host/src/workflow-assist-agent.ts` — host 启动时一次性
   注册 `WorkflowAssistantAgent` (id=`workflow-assistant`,
   capability=`workflow:assist`). `resolveWorkflowAssistConfig()` 读
   `AIPE_ASSISTANT_PROVIDER` (默认 anthropic, 可 `openai` / `mock`)
   + `AIPE_ASSISTANT_MODEL` / `AIPE_ASSISTANT_MAX_TOKENS` /
   `AIPE_ASSISTANT_DISABLED`. Key 走 orgApiPool → env fallback,
   缺 key 就 skip 注册 (route 转 503, UI 提示)
2. `WorkflowAssistSurface` duck-typed 接口注入 web 层
   (`serveWeb({workflowAssist})`), 跟 WorkflowSurface 同模式 — web
   零 workflow-assistant / llm runtime dep
3. `POST /api/admin/workflows/assist` route — requireAdmin → 503 缺
   surface / 400 缺 description / 200 返 `{ok, yaml, explanation,
   raw, draftStatus, validationError?, by, stopReason}`
4. admin UI 工作流 tab 加 "AI 助手 (beta)" 按钮 + `wf-assist-modal`
   对话框: description textarea → 生成按钮 → status chip 三色 (valid
   绿 / invalid 红 / no_yaml 灰) + 折叠 YAML 预览 + 折叠校验错误 +
   保存按钮 (仅 valid 启用, 走现有 `/api/admin/workflows/import`)
5. submitWorkflowAssist 把当前 hub 的 agents + workflow ids 当
   `contextHints` 喂给 assistant, LLM 用真名而不是编 capability
6. 23 测试 (web 9 + host 14)
7. 配额: assist 行为 free-ride (没 task.origin), 跟 LocalAgentPool 同
   策 ("admins are operators, not consumers")
8. Smoke: AIPE_ASSISTANT_PROVIDER=mock 启 host, curl /api/admin/
   workflows/assist → `{ok:true, draftStatus:"valid",
   yaml:"schema: aipehub.workflow/v1...", usage:{...}}`

详见 commit d70acdb.

**Phase 13 M4 已落地** (深度结构检查):
1. `@aipehub/evals/checkers/workflow-structure` — 纯函数
   `checkWorkflowStructure(WorkflowDefinition, inventory?)` 检查
   parseWorkflow 接受了但运行时会爆的事:
   - `unknown_agent`        显式 dispatch 指向未注册 agent
   - `unknown_capability`   capability/broadcast dispatch 没 agent 满足
   - `bad_ref`              `$stepId.output` 指向不存在的 step
   - `forward_ref`          ref 指向更晚执行的 step（必然失败）
   - `self_trigger_cycle`   step 派回 workflow 自己的 trigger cap
   - `id_collision`         workflow.id 跟现有 hub 上撞名
2. `inventory` 可选 — 不传时所有需要 hub state 的检查 (agent/cap 满足、id
   collision) silently skip, 即"portable mode"；传时按真 hub 状态判
3. `WorkflowAssistantAgent.parseResponse` 自动调用 (新 helper
   `verdictForYamlWithDeepCheck` + `inventoryFromContextHints`):
   `task.payload.contextHints` 在的话, valid yaml 后跑深度检查, 结果挂
   `output.deepCheck`；`draftStatus` 不下调 — UI 自己看 `deepCheck.ok`
4. Web 层 duck-typed 镜像 `WorkflowDeepCheckResult` /
   `WorkflowDeepCheckViolation`, 零 evals dep；route 已经 verbatim echo
   surface 输出, deepCheck 字段自然流通
5. Admin UI 加 `wf-assist-deepcheck-details` panel: valid+ok 静默通过
   (collapsed), valid+fail 黄色 chip + 警告列表 (kind label + path +
   message)；save 按钮仍只看 draftStatus (admin 决定要不要救 warnings)
6. Host mock provider stub 修正: 原本 trigger=chat + step=chat 会一直
   trigger self_trigger_cycle, 换 trigger=mock-draft:run 让 mock smoke
   稳定通过
7. +40 测试 (evals 24 + workflow-assistant 13 + web 3); zero regressions
8. Smoke: mock provider + 3 场景 (无 hints / 满足 / 不满足+id collision)
   → deepCheck 正确产出, UI 按 ok/!ok 切换样式

详见 commit a5afe5a.

**Phase 13 M5 已落地** (端到端 demo + release notes):
1. `examples/workflow-assistant/` — 4 scenario × 4 provider 模式 demo
   (DeepSeek 默认 / Anthropic / OpenAI / mock); 走完 LLM → parseWorkflow
   → deepCheck → save 全链路；真 DeepSeek smoke 跑通: happy 41s
   ✓valid+ok, unknown-cap-pressure 10s ⚠ 2 violations (LLM 编的
   `image-generation` / `discord:send` 被 deepCheck 抓住)
2. `docs/zh/AI-WORKFLOW-EDITOR.md` 800 行 release notes:
   - 一节 milestone 表 (M1 / 审计整改 / M3 / M4 / M5 commit hash)
   - 「为什么做」: schema 不友好 + LLM 不能盲信
   - 7 项关键设计决策 (subclass LlmAgent / 拆包 / draftStatus 三态 /
     duck-typed surface / deepCheck 不下调 status / contextHints
     双用途 / provider key chain)
   - ASCII 全链路数据流图 (admin UI → web → host surface → assistant
     → evals → 回流 → UI render)
   - 测试矩阵 (workflow-assistant 44 + evals 24 + host 14 + web 12 =
     +94)
   - 运维须知 (env / key / 配额 / transcript / 成本)
   - 5 项 follow-up (few-shot / self-correction / streaming chip /
     dispatch toolset / RAG)

详见 commit d9a9e79.

**Phase 14 M1-M8 已落地** (`/me` 成员工作台通用化):
1. `surface.me` schema (`packages/workflow/src/types.ts`) —
   `WorkflowDefinition.surface?: WorkflowSurfaceSpec { me?: MeSurfaceSpec }`;
   `MeSurfaceSpec { enabled, label?, description?, inputSchema?:
   PayloadFieldSpec[], allowedRoles?: WorkflowRole[], userScopeField? }`;
   `WorkflowRole` 本地字面量联合 (不 import identity, workflow 包保持零身份
   依赖); `validateSurfaceSpec` snake/camel 双接受, import 时校验 (不等运行时崩)
2. host 透传 (M2) — `WorkflowController.toSummary()` 把 `definition.surface.me`
   投影成 `WorkflowSummary.surfaceMe`; 走 `payloadSchema` 已有的那根管子,
   web 零 workflow 运行时依赖, 无依赖反转
3. web 派生式 catalog (M3-M5) — `serveWeb({workflows})` → `ctx.workflows` →
   `handleMeRoute`; `GET /api/me/workflows` 按 `enabled`+`allowedRoles` 过滤,
   只投影 `{id,label,description,inputSchema}` (故意省 `capability`/
   `userScopeField` 防探测); 泛化 `POST /api/me/dispatch` 经 `resolveMeWorkflow`
   (null→403 fail-closed) → 拷贝 `inputFieldIds` → 强制 `payload[userScopeField]
   =userId`; 删 `ALLOWED_WORKFLOWS`/`/allowed-workflows`/`listAllowedWorkflowsForMe`
4. 授权边界位移 — 「能改 TS 的提交者」→「能 import YAML 的 admin」;
   `surface.me.enabled` 门**就是**安全边界, 不声明的工作流 `/me` 一律 403;
   Phase 15 `published` 生命周期是长期闸门
5. 3 个 shipped member-facing 工作流 (M6-M7) — `personal-growth-flow`
   (scope `case_id`, 走生成器非手改 bundle) / `daily-reflection-flow`
   (默认 `case_id`) / `weekly-goal-checkin-flow` (替代 scope `owner_user_id`)
6. 前端 (M8) — `app.js renderHome` 吃 `/api/me/workflows`, `renderField(f)`
   按 `f.type` 动态渲染 (textarea/number/select/file/text), `f.id` 当 name;
   `app.html` 文案改通用「你只能为自己发起」
7. 测试 — workflow `templates.test.ts` (+11 Phase 14) / web `me-routes.test.ts`
   (32) + `manifest.test.ts` builtin-bundle round-trip (84) / host
   `me-workflows-e2e.test.ts` (3, 真 WorkflowController seam, 查 `hub.tasks()`
   payload 断言 scope 强制); 全量 `pnpm -r test` 绿

详见 `docs/zh/V4-PHASE14-FINAL.md`.

**Phase 15 M1-M8 已落地** (工作流生命周期 + 版本化, 防 run 漂移):
1. `lifecycle.ts` 纯状态机 (`draft→review→published→deprecated→archived`, `transition()`
   抛 `WorkflowLifecycleError`) + 修订类型 + `RunState.definitionRevision`
2. 两个文件优先 store 镜像 `RunStore`: `FileRevisionStore` (写一次性, `<id>/<rev>.json`
   不可变) + `FileLifecycleStore` (单条记录原子重写) + `hashDefinition` (sha256 canonical-JSON)
3. **消除漂移核心**: runner 单一 `this.definition` → 注入 `DefinitionResolver`;
   `handleTask` 盖 `definitionRevision = current().revision`, `resumeRun` 按
   `byRevision(rev)` 跑确切快照; 缺省合成单修订 resolver → 现有 ~30 处构造零改动
4. host `WorkflowVersioning` —— 两 store 之上编排 + **唯一注册权威**;
   `HostDefinitionResolver` 同步读内存 entry; capability 跨修订冻结
   (`capability_immutable`); no-op publish 按 hash 去重; rollback append-only 克隆
5. `WorkflowController` 接 versioning, `importFromText` 走 Model-B (导入即发布 rev1);
   boot loader 降级 parse-only (versioning 唯一注册, 不双注册)
6. web 鸭子 lifecycle 路由 (`POST /:id/{draft,review,publish,deprecate,archive,rollback}`
   + `GET /:id/{revisions,state}`, 错误码→HTTP) + `/me` 加 `state==='published'` 闸门
7. admin UI: 卡片 state 徽章 + `rev N` + 按 state 门控按钮 + 修订历史 modal (逐行回滚)
8. **无漂移 E2E 验收门** (`workflow-lifecycle-e2e.test.ts`): 真 Hub+suspendNotifier+
   versioning+file store, 7 步 (import→挂起绑 rev1→publish rev2→resume 仍跑 rev1→
   rollback rev3==rev1→新派发跑 rev3). 全量 `pnpm -r test` 绿 (host 333 / web 439 /
   workflow 190)

详见 `docs/zh/V4-PHASE15-FINAL.md`.

**Phase 16 M1-M8 已落地** (成员任务 inbox, human-in-the-loop 工作流步骤):
1. **北极星缺口**: 工作流每一步都派给 agent, 没有「等一个人拍板」的步骤。北极星第 2
   条「人是 `Participant`, 不是 request_human_input tool」→ HITL 应是**派 Task 给一个
   代表收件箱的 Participant**, 它挂起任务, 人在 `/me` 处理后再恢复
2. **零新机制**: 全靠 Phase 11 suspend/resume + Phase 15 修订绑定拼出来; runner /
   scheduler / resolver / deepCheck **零改** (只见普通 capability dispatch)
3. 新包 `@aipehub/inbox` (只依赖 core): `InboxStore` 接口 + `FileInboxStore`
   (`<space>/inbox/<itemId>.json` 原子写, `markResolved` 是 pending→resolved 受保护
   转移 = race 守卫) + `InboxItem`/`InboxDecision` 类型 + `HumanInboxParticipant`
   broker (固定 id `aipehub:human-inbox`, cap `aipehub.human/v1`)
4. broker `handleTask`: 校验 payload (坏→抛, 步骤可见 failed) → 读 `ancestry.at(-1)`
   定 parent/parentKind → 写 item (itemId=task.id) → 抛 `SuspendTaskError({resumeAt:
   NEVER_RESUME_AT(永不), state:{inboxItemId}})`; `handleResume` 从 `state.answer` 返回决定
5. `human:{assignee,kind,prompt,title?,options?,editField?}` YAML 糖 (M6,
   `schema.ts`): import 期脱糖成 dispatch→`aipehub.human/v1`, assignee 可 `$ref`
   (dispatch 时 resolver 替换成真 userId), 坏块 import 期抛 `WorkflowSchemaError`
6. host `HostInboxService` (M5) 两步恢复 (子 broker 严格先于父 workflow):
   load+所有权+pending 校验 → `validateDecision` (服务端权威; choice 校验 value 在
   options 里) → `markResolved` race 守卫 → resume 子 (注入 `{answer:decision}`) → resume
   父 (仅 parentKind==='workflow', 交叉核对 `row.agentId===parent.by`, run 完成才删父行)
7. 三个不变量: ① 永不 resumeAt `9_999_999_999_000` → sweep 恒取不到, resolve 是唯一
   恢复者; ② 子严格先于父 (父先恢复只会空转重挂); ③ parent 用存的 `{taskId,by}`+
   parentKind 而非 ancestry 运行时位置
8. web 鸭子 `InboxSurface` (零 inbox dep) + `/me/inbox` 路由 (GET list / POST resolve,
   userId 服务端强制, typed `.code`→HTTP) + 手写 SPA inbox 面板 (approval 批准/拒绝 /
   choice 每 option 一钮 / edit textarea+提交, 未读数 badge)
9. **无漂移 E2E 验收门** (`inbox-e2e.test.ts`): 真 Hub+suspendNotifier+versioning+broker+
   service; Test1 happy (gate.output===decision + sweep 取不到), Test2 挂起期 publish rev2
   resolve 后仍跑 rev1 (definitionRevision 仍 1)
10. +39 测试 (inbox 16 + web 8 + host 8 + workflow 7), 全量 `pnpm -r test` 绿

设计上 inbox 跟 Phase 11 long-running agent 同源 ——「participant 挂起任务, 外部事件
恢复」; 差别只是「外部事件」从定时器到点换成「一个人在 `/me` 点了按钮」。

详见 `docs/zh/V4-PHASE16-FINAL.md`.

**Phase 17 / Sprint 4 M1-M8 已落地** (用量·成本账本 + 配额 fail-closed + 审计导出):
1. **分层**: 在 `usage_counters`(调用数配额) **之下** 加一层 `usage_ledger`(v=11) —
   逐条 LLM 调用的原始账本 (谁/agent/工作流/模型/token/cost_micros), append-only
   无 FK 同 `audit_log` (删 user/agent 仍留账, billing forensics); 成本只用整数
   micro-USD (`1e6==$1`, 无浮点)
2. **价目在 host** (`pricing.ts`): `DEFAULT_PRICING` 前缀匹配 + `estimateCostMicros`
   (未知模型 `unpriced` 计 0); `<AIPE_SPACE>/pricing.json` 覆盖 (malformed→boot 抛);
   identity 保持模型无关, 只收算好的 `cost_micros`
3. **usageSink 双账** (`local-agent-pool.ts`): 每 provider 响应触发 — ① 账本恒写
   (含 mock 记 unpriced $0 行, 痕迹完整) ② 预算计数 (归因+非 mock): `recordUsage`
   累计 `llm_tokens`/`llm_cost_micros`; 归因从 `task.origin`(user/org) + ancestry
   最近 `workflow:` 节点取
4. **fail-closed** (`org-api-pool.ts` gate `budgetPeeks`): pre-call peek 两预算维度
   (amount=0 只读), `used>=quota`→`denyQuota`(写 `api_quota_denied` 审计+抛); peek 在
   调用数 debit 之前 (被预算拒不吃调用格); 语义=「预算花光后下一次 fail-closed」
5. **导出 + 看板**: web 鸭子 `UsageLedgerSurface` (零 identity dep) + 账本/审计
   CSV·JSONL 导出路由 (owner 闸后, ≤10k 行, RFC4180) + admin `用量` tab (按
   user/agent/workflow/model/day 汇总 + 合计行 + 4 导出链接)
6. **E2E 验收门抓出 fail-OPEN bug**: M3/M4 记账误用带闸 `checkAndIncrement` — 越 cap
   的那次 token 不提交、`used` 卡 cap 下方、peek `used>=quota` 永不成立 → 预算永不
   触发 (M4 单测把 used 正好设到 cap 才过, 掩盖了)。修复: 记实际消耗必须 **ungated**
   — 新 `recordUsage`(单调累加, 允许越 cap, 仍滚周期), sink 改用它; 调用数仍 gated
7. **测试** +66: identity 289 (ledger 16 + recordUsage 5) / web 465 (export 10 +
   usage-routes 8) / host 368 (pricing 16 + pool-ledger 3 + budget-gate 6 + E2E 2)
8. **显式推迟** (用户只点名 ledger/quota/audit): Prometheus 业务指标 + backup day-2
   演练; per-user token 预算 UI / 成本软阈值告警

一句话: **记账要 ungated, 执行才 gated** — 把这两件事用同一个带闸原语做就会悄悄
fail-open。账本是 `audit_log` 同构的观测层, 配额闸是其上的执行层。

详见 `docs/zh/V4-PHASE17-FINAL.md`.

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
| 移动端 / PWA | ✓ Phase 12 M9-M11 完 — PWA app-shell (manifest + SW, `/api/*` 不缓存) + `@media` 响应式 admin SPA (单列 + 横滚表格 + 触控目标) |
| IM bridge(微信/Telegram/Slack) | ✓ Phase 12 完 — 6 bridge (telegram/matrix/lark/discord/slack/qq) + router + cookbook |
| 交互式 CLI shell | ✓ Phase 12 M12 完 — `aipehub repl` + `:`-prefix 元命令 |

补的话从 IM bridge 起步成本最低 — 复用 MCP server 思路, 一个 bot
进程把 IM 消息翻成 Hub dispatch, 把 transcript 推回 IM。

### 偏 3: AI 时代新范式

| 范式 | 现状 | 短期可补 |
|---|---|---|
| LLM streaming | ✓ Phase 8 完 | — |
| 多模态 content | ✓ Phase 9 完 (image / audio / file_ref + workflow upload + admin UI) | — |
| Agent → 子 agent | ✓ Phase 10 完 (DispatchToolset + ancestry/cycle gate + cross-hub + allow-list + chain UI) | — |
| Long-running agent | ✓ Phase 11 完 (SuspendTaskError + suspended_tasks SQLite + resume sweep + LlmAgent working memory) | — |
| IM bridges | ✓ Phase 12 M1-M8 完 (6 bridge + router + cookbook + im-bridge-host example) | — |
| AI 辅助 workflow 编辑 | ✓ Phase 13 M1+M3+M4+M5 完 (assistant agent + admin UI 对话框 + deepCheck 黄色 warnings + real-LLM demo + 800 行 release notes); 详见 [`docs/zh/AI-WORKFLOW-EDITOR.md`](docs/zh/AI-WORKFLOW-EDITOR.md) | — |
| RAG | ✓ 2026-05-28 — `examples/rag-mcp/` (chroma-mcp 默认推荐, agent YAML + 备选 server 表) + `docs/zh/RAG-VIA-MCP.md` setup 文档 | — |
| 工作流生命周期 + 版本化 | ✓ Phase 15 完 (draft→review→published→deprecated→archived 状态机 + 不可变修订 + run 钉修订防漂移 + rollback + admin UI 修订历史 + 无漂移 E2E 验收门); 详见 [`docs/zh/V4-PHASE15-FINAL.md`](docs/zh/V4-PHASE15-FINAL.md) | — |
| Human-in-the-loop (成员任务 inbox) | ✓ Phase 16 完 (`@aipehub/inbox` broker + `human:` YAML 糖 → cap `aipehub.human/v1` + 两步恢复 + `/me` inbox 面板 approval/choice/edit + 无漂移验收门; 复用 Phase 11 suspend/resume); 超时升级/多人审批推迟 backlog #21; 详见 [`docs/zh/V4-PHASE16-FINAL.md`](docs/zh/V4-PHASE16-FINAL.md) | — |
| 用量·成本可观测 + 配额 fail-closed + 审计导出 | ✓ Phase 17 完 (`usage_ledger` 逐条账本 + host 价目表/`estimateCostMicros` + `usageSink` 双账 + token/cost 预算 pre-call peek fail-closed via ungated `recordUsage` + `api_quota_denied` 审计 + 账本/审计 CSV·JSONL 导出 + admin `用量` 看板; E2E 抓出并修复 fail-OPEN bug); Prometheus 业务指标/backup 演练显式推迟; 详见 [`docs/zh/V4-PHASE17-FINAL.md`](docs/zh/V4-PHASE17-FINAL.md) | — |
| 联邦能力 manifest + 跨组织 policy + A2A 互操作 | ✓ Phase 18 完 (host `peer.manifest` RPC + in-mem cache online/stale/unknown + admin 联邦 tab; identity v12 per-peer 信任契约 → 入站 ACL 生效 + 出站审批闸 `ApprovalGatedParticipant` 复用 Phase 16 inbox; 新包 `@aipehub/a2a` + 入站 `A2aServer` message/send→dispatch (per-peer bearer fail-closed) + 出站 `A2aRemoteParticipant` + 双 hub 确定性验收门); 数据分类·redaction / A2A streaming / 出站 agent admin-UI 配置显式推迟; 详见 [`docs/zh/V4-PHASE18-FINAL.md`](docs/zh/V4-PHASE18-FINAL.md) | — |
| `/me` 成员工作台 (我的 AI 桌面) | ✓ Phase 19 P1 完 (catalog 带运行状态 + 最近 runs + 我的 agents 脱敏 + 成员上传 `uploads/me/<userId>/` + file 字段真上传器; 全 web 鸭子 surface 零运行时依赖, scope 防 spoof 不动); 全 `/me` i18n retrofit 推迟; 详见 [`docs/zh/V4-PHASE19-P1-FINAL.md`](docs/zh/V4-PHASE19-P1-FINAL.md) | — |
| Workflow 治理 (硬闸 + 审计 + 资源 RBAC) | ✓ Phase 19 P2 完 (import/publish `checkWorkflowStructure` 运行时硬闸 vs live inventory; 五动作 `workflow_*` 进 `audit_log` + owner-gated 查询/CSV·JSONL 导出 + admin 修订 modal 治理审计子区; identity v13 `workflow_grants` owner-as-grant 资源 RBAC, operator 绕过 = 零回归, lifecycle editor+/delete owner, admin 访问控制面板); 完整资源表/审批权分离/grant 审计推迟; 详见 [`docs/zh/V4-PHASE19-P2-FINAL.md`](docs/zh/V4-PHASE19-P2-FINAL.md) | — |
| 生产级安全与运维 (业务指标 + restore smoke + 文档诚实化) | ✓ Phase 19 P3 完 (Prometheus 业务指标 6 series via 采集/渲染分离 `business-metrics.ts` best-effort 永不 500 + run 扫描封顶诚实标志 + identity `countSuspendedTasks`; backup→restore→verify→boot 往返 smoke 测试即交付物, 钉死「加密 secrets 走、master key 不走」; SECURITY.md/security.txt/RELEASE-CHECKLIST 诚实化 — GitHub advisory 唯一渠道无邮箱, Docker+source 唯一受支持分发, 仅 main); `upload_bytes`/run 精确计数/真发布推迟; 详见 [`docs/zh/V4-PHASE19-P3-FINAL.md`](docs/zh/V4-PHASE19-P3-FINAL.md) | — |
| 联邦信任契约 (出站 allowlist 强制 + peer-aware 账本 + rich manifest + per-link data-class/quota/revocation) | ✓ Phase 19 P4 完 (🔴 出站 capability allowlist 真强制 `RemoteHubViaLink` via 共享 `core/peer-acl.ts` 防入出站漂移; `usage_ledger` 加 `peer_id` 拆多组织账 [决策=轻量仅 peer_id]; `PeerCapability[]` rich manifest 兼容老 `string[]`; identity v15 per-link 契约 `revocation_state`/`per_link_quota_budget`/`allowed_data_classes_json` → `Task.dataClasses` 出站 data-class 闸 + per-link 配额 `FixedWindowLimiter` 跨重连保留 fail-closed + 撤销三闸 [tick/install/线缆层] + **多组织隔离 E2E 验收门** 自由图「夹紧一条不外溢」 [决策=全做]); 出站 redaction hook/peer-policy 编辑器 UI/配额持久化/link_id 维度推迟; 详见 [`docs/zh/V4-PHASE19-P4-FINAL.md`](docs/zh/V4-PHASE19-P4-FINAL.md) | — |
| 生态接入与行业模板 (framework adapter + automation 桥 + 行业模板 + governance 元数据) | ✓ Phase 19 P5 完 (鸭子类型 + peer dep adapter: `python-sdk` LangGraph/CrewAI 包 graph/crew 为 `AgentParticipant`, 框架永不被导入 CI 零依赖; 桥两方向: `examples/activepieces-bridge` 入站 webhook→dispatch [共享密钥 fail-closed + capability-only 白名单] + `examples/windmill-bridge` 出站 `WindmillParticipant` submit→poll durable job; workflow `governance` 块 [dataSensitivity/credentials/cost/humanRoles/externalSystems, 声明非执行闸, import 期校验] + `WorkflowSummary.governance` 投影 + admin 卡片风险摘要 UI; 三行业模板 contract-review[HITL]/lead-qualification[when:]/issue-triage[parallel:] 各带 mock-provider E2E 覆盖 runner 三控制流); 真接外部 framework wire 级测试/更多 framework/governance 进 audit 推迟; 详见 [`docs/zh/V4-PHASE19-P5-FINAL.md`](docs/zh/V4-PHASE19-P5-FINAL.md) | — |

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
| 工作流生命周期 + 版本化(防漂移) | `docs/zh/V4-PHASE15-FINAL.md` |
| 成员任务 inbox (human-in-the-loop) | `docs/zh/V4-PHASE16-FINAL.md` |
| 用量·成本账本 + 配额 fail-closed + 审计导出 | `docs/zh/V4-PHASE17-FINAL.md` |
| 联邦能力 manifest + 跨组织 policy + A2A 闭环 | `docs/zh/V4-PHASE18-FINAL.md` |
| `/me` 成员工作台 (我的 AI 桌面) 收口 | `docs/zh/V4-PHASE19-P1-FINAL.md` |
| Workflow 治理 (硬闸 + 审计 + 资源 RBAC) | `docs/zh/V4-PHASE19-P2-FINAL.md` |
| 生产级安全与运维 (业务指标 + restore smoke + 文档诚实化) | `docs/zh/V4-PHASE19-P3-FINAL.md` |
| 联邦信任契约收口 (出站 allowlist + peer 账本 + rich manifest + per-link data-class/quota/revocation) | `docs/zh/V4-PHASE19-P4-FINAL.md` |
| 生态接入与行业模板 (framework adapter + automation 桥 + 行业模板 + governance 元数据) | `docs/zh/V4-PHASE19-P5-FINAL.md` |
| 完整审计报告 | `docs/zh/AUDIT-v4-phase5.md` |
| MCP 接入(client + server) | `docs/zh/MCP.md` |
| Services 插件 RFC 系列 | `docs/services-rfc.md` 及 `*-rfc.md` |
| 部署 / 运维 / 监控 | `docs/zh/DEPLOY.md`, `docs/OPERATIONS.md`, `docs/MONITORING.md` |
| 历史 commit 流水账 | `CHANGELOG-v3-dev.md`, `CHANGELOG.md` |
| 历史外部审计 | `audits/<date>-<auditor>/` (按时间归档, `audits/README.md` 是索引) |

---

## 六、目录结构速查

```
packages/                       29 个包, pnpm workspace
├── protocol/                   wire protocol(v1.2) + wire types, zero runtime
├── core/                       Hub, Scheduler, Storage, Participant (依赖 protocol)
├── transport-ws/               WebSocket transport + HubLink (federation)
├── sdk-node/                   Node 客户端 SDK
├── identity/                   v4 — users/credentials/sessions/vault/quota/peers/im_bindings/suspended_tasks; Phase 17: usage_ledger (v=11) + ledger-store.ts (逐条账本) + quota-store.ts recordUsage (ungated 记账); Phase 18: peers v12 加 per-peer 信任契约 4 列 (kind/acl_json/outbound_caps_json/require_approval_outbound)
├── host/                       生产 host 二进制 (main.ts)
│   └── src/
│       ├── local-agent-pool.ts        host-managed agents; Phase 17: usageSink 双账 (账本 + ungated 预算 recordUsage)
│       ├── org-api-pool.ts            per-org LLM key cache; Phase 17: makeLlmQuotaGate budgetPeeks (token/cost fail-closed)
│       ├── pricing.ts                 Phase 17 — 模型价目表 + estimateCostMicros (整数 micro-USD, pricing.json 可覆盖)
│       ├── peer-registry.ts           federation peer 拓扑; Phase 18 — 传持久 ACL 进 installPeerLink + outboundApprovalGate wrap
│       ├── peer-manifest.ts           Phase 18 A — buildLocalManifest (排除 wrapper) + peer.manifest RPC provider + in-mem federation cache
│       ├── outbound-approval.ts       Phase 18 B — ApprovalGatedParticipant (出站跨组织 task 命中 requireApprovalOutbound → inbox 审批)
│       ├── a2a-server.ts              Phase 18 C — 入站 A2A message/send → hub.dispatch (per-peer bearer fail-closed, capability-only)
│       ├── workflow-versioning.ts     Phase 15 — 生命周期+修订编排, 唯一注册权威, HostDefinitionResolver
│       ├── inbox-service.ts           Phase 16 — 成员 inbox 两步恢复 (子 broker 先于父 workflow)
│       └── ...
├── web/                        admin UI HTTP + SSE + SPA
├── llm/                        LlmAgent + LlmProvider 抽象 + DispatchToolset + ComposedToolset
├── llm-anthropic/              Anthropic provider (streaming + tool use + vision)
├── llm-openai/                 OpenAI / DeepSeek / Qwen / Ollama (compat, streaming + tool use)
├── workflow/                   YAML workflow runner — parseWorkflow / WorkflowRunner / RunStore / predicate / resolver, 零 LLM dep; Phase 15: lifecycle.ts 状态机 + revision-store.ts / lifecycle-store.ts (文件优先, run 钉修订防漂移)
├── workflow-assistant/         Phase 13: WorkflowAssistantAgent (自然语言 → YAML, draftStatus), 依赖 workflow + llm
├── inbox/                      Phase 16: 成员任务 inbox — InboxStore / FileInboxStore / HumanInboxParticipant broker (human-in-the-loop, cap aipehub.human/v1), 只依赖 core
├── a2a/                        Phase 18 C: A2A (Agent2Agent) interop — message/send wire 类型 + a2aSend client + A2aRemoteParticipant (出站), 入站 A2aServer 在 host; 依赖 core

├── mcp-server/                 MCP server (Claude Desktop / Cursor 调 hub)
├── mcp-client/                 MCP client (agent 调外部 MCP tools)
├── services-sdk/               services plugin contract
├── service-memory-file/        memory(jsonl)
├── service-artifact-file/      artifact(file)
├── service-datastore-sqlite/   datastore(sqlite)
├── im-adapter/                 IM bridge 共享 SDK (ImBridge / parseImCommand)
├── im-telegram/                Telegram bot long-poll
├── im-matrix/                  Matrix Client-Server /sync
├── im-lark/                    Lark/Feishu webhook + 加密
├── im-discord/                 Discord Gateway WSS
├── im-slack/                   Slack Events API webhook + HMAC
├── im-qq/                      QQ OneBot v11 forward WS
├── cli/                        aipehub CLI (host start / repl / demo)
└── evals/                      workflow / prompt 评测

python-sdk/                     PyPI `aipehub` (含 adapters/ — Phase 19 P5 LangGraph/CrewAI participant adapter)
templates/                      agents / teams / workflows / bundles / community
examples/                       26 个端到端 demo (含 Phase 19 P5 activepieces-bridge / windmill-bridge)
docs/  docs/zh/                 双语文档
audits/                         外部审计快照按时间归档 (audits/README.md 索引)
scripts/                        backup / restore / verify / prune
monitoring/                     prometheus + grafana
```

---

## 七、下一步建议清单(供 agent 起步时挑)

按"对北极星贡献度 / 工作量"排:

| 优先 | 任务 | 工作量 |
|---|---|---|
| ~~短期~~ | ~~2026-05-27 audit P3: 拆 `packages/web/src/server.ts` (3563 行) 的 route groups~~ | **2026-05-28 三批完成** — batch 1 `workflow-routes.ts` (3701→3578); batch 2 `agents-routes.ts`/`services-routes.ts`/`uploads-routes.ts` (3578→2780); batch 3 `setup-routes.ts` (2780→2690) |
| ~~短期~~ | ~~2026-05-27 audit P3: 拆 `packages/web/static/admin.js`~~ | **2026-05-29 完成** — esbuild bundler + 三 ES module (`services.js`/`managed-agents.js`/`workflows.js`); admin-src/main.js 3103→2344; workflow-start 共享渲染层故意留 main.js |
| ~~进行中~~ | ~~Phase 12 M9-M11 PWA + mobile responsive + 移动简化 shell~~ | **2026-05-29 完成** — PWA app-shell (manifest + sw.js + offline + icon, `/api/*` 不缓存) + 响应式 admin SPA (`@media` 720/420 单列 + 横滚表格 + 触控目标) + 5 PWA 测试; commit 7fe8a27 + c9dd395 |
| ~~中期~~ | ~~默认 RAG MCP server 推荐 + setup 文档~~ | **2026-05-28 完成** — `examples/rag-mcp/` (chroma-mcp) + `docs/zh/RAG-VIA-MCP.md` |
| 长期 | 微信小程序 / 其他原生入口 | 2-3 周 |

不要把这张表当 backlog 死磕 — 它只是"如果用户问'下面做什么'时, agent
不至于卡住"的备选。**用户指令 > 这张表**。
