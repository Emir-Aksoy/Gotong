# AipeHub — Agent 北极星 (CLAUDE.md)

> 本文是给 Claude / 任意 LLM agent 看的项目根级指南。每次新会话第一件
> 事就是读它，避免重建上下文跑偏。人类读者也可以读，但更友好的入口是
> `README.md` / `docs/zh/OVERVIEW.md`。
>
> Last updated: 2026-06-03

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
| **v5 Stream D** | 完 | 心跳 / 主动自治 (5 M) — agent 第一次会自己醒来看一眼。OpenClaw 风格主动唤醒, **零新表/零新 timer**, 全站 Phase 11 suspend/resume 上。**D-M1** (`a1b0d6b`) `packages/host/src/heartbeat.ts`: `HeartbeatParticipant` 单例 broker (cap 空, 只按固定 id `aipehub:heartbeat` resume) `handleResume` 每拍 fire 一次再抛 `SuspendTaskError(resumeAt=now+interval)` **INSERT-OR-REPLACE 续同一行** (确定性 task id `heartbeat:<agentId>` → 一行=一 agent 下次到点, 重启无漂移); `HeartbeatScheduler.reconcile` 幂等 seed/prune; `HeartbeatStore` 窄鸭子 (真 `IdentityStore` 零改满足); core `HeartbeatSpec`{enabled,intervalMs,checklist?} 挂 `ManagedAgentSpec`. **D-M2** (`259b349`) `buildHeartbeatPayload` 清单拼成 ready-to-read `prompt` (默认 `LlmAgent` 零改即消费) + 结构化 `heartbeat`/`checklist`/`firedAt`. **D-M3** (`1c7ec7c`) `classifyHeartbeatResult`: 恰好 `HEARTBEAT_OK`→idle 吞 / 有文本→active 上报 / 报错→failed; **transcript 仍记每拍** (抑制只管通知不动审计). **D-M4a** (`b274494`) web `validateHeartbeatSpec` + host lazy `ensureHeartbeatEngine()` (零心跳启动不建 broker) + `reconcileHeartbeats` 回调穿 web→server→agents-routes (改配置即时生效无需重启, best-effort 永不让 agent 写失败). **D-M4b** (`d9e1055`) admin 表单心跳 fieldset (分钟↔ms) + `/me` **只读**脱敏徽章 (仅 `enabled` 出 host). **D-M5** (本提交) `examples/heartbeat-agent` (core-only 单文件 ~1s 确定性: 4 拍 1 上报 3 抑制 18 transcript) + `docs/zh/V5-D-FINAL.md`. +16 引擎测试 + web 547 绿; 详见 [`docs/zh/V5-D-FINAL.md`](docs/zh/V5-D-FINAL.md) |
| **v5 Stream 0** | 完 | hub 统一 + agent 即 owner (2 M, 地基性纯词汇/纯策略, 零 schema/零迁移). **0-M1** (`575c5cf`) org→hub 心智收敛 — 事实核查「根本没有 orgs 表」: 「org」一直是 hub 自己 (vault `ownerKind='org'`+NULL / `TaskOrigin.orgId`=peer self-id / services-sdk `ORG_SELF_ID='self'`). 新 `packages/identity/src/principal.ts` 统一 `Principal{kind,id}`, `PrincipalKind='hub'\|'user'\|'agent'\|'peer'`; `principalKey`/`parsePrincipalKey` 单列 `"<kind>:<id>"` 编解码 (首冒号切分/畸形/未知 kind 抛错 fail-visible, Stream A `resource_grants` 主体列天生说这个); `principalFromVaultOwner`/`principalToVaultOwner` 两桥函数=org↔hub 收敛 (vault 一行不改; agent 主体 vault 暂不 own → toVaultOwner 抛错挡误用). **实质: agent 升格 first-class 主体** (v4 grant 仅 user). services-sdk 6-kind 运行时 `Owner` 故意不动 (那是附着域非所有权). **0-M2** (`b6ba189`) agent-as-owner 权限边界 (决策 #2) — 新 `agent-authority.ts`: 封闭高危清单 `AGENT_HUMAN_CONFIRM_ACTIONS`={`modify_owner_grant`(加 owner+改最高权限合一), `delete_audit`(agent 不能抹自己痕), `change_security`(peer 信任/master key/安全配额)}; `authorizeAgentAction(principal,action)→{allow}\|{requires_human,action,reason}` — 非 agent 主体永远 allow (人类 owner 本身即确认), agent 除清单外全 allow, 命中→requires_human 走 Phase 16 审批 inbox. **列危险的少数不列安全的多数** (封闭闸可审计, 未知动作默认 allow 不擅自 block, 测试钉死). 预算/对外发闸已是 Phase 17/18, 0-M2 只补 owner 层缺的闸. +21 测试 (identity 336 绿); 详见 [`docs/zh/V5-0-FINAL.md`](docs/zh/V5-0-FINAL.md) |
| **v5 Stream A** | 完 | 归属泛化 (`resource_grants`, 4 M) — Stream 0 立词汇/策略, A 接成运行时真东西: 一张表 + 一个 owner gate + 一个 per-user key 回退 + 一个共享面板. **A-M1** (`fe12504`) 通用 `resource_grants` 表 (identity **v16**) + `ResourceGrantStore`: 把 `workflow_grants` 从「user→workflow」泛化成「Principal→任意资源」, **owner-as-grant** (owner 就是 `perm='owner'` 行, 无单独 owner 列), `principal` 列存 0-M1 `principalKey`, `RESOURCE_KINDS=workflow/agent/credential`, `WorkflowPerm`→通用 `GrantPerm` (viewer<editor<owner, rank 比较); `workflow_grants` 折叠成 facade 零行为变化. **A-M2** (`d533219`+`d3c09f1`) agent 归属 + `/me` 自助 CRUD — `HostMeAgentService`, 归属=`(kind='agent',perm='owner',principal=user)` grant 非字段; 受限门 (host 合成 id `me.<userId>.<handle>` / 无 inline key·baseURL·services·MCP / provider 须有 key / per-member 上限 20 / 404 防枚举); 前端「打造我的助手」表单+卡片. **A-M3** (`95d2bc4`+`5357017`+`c6349e6`) 凭证归属 + per-user key (BYO) — A-M3a `OrgApiPool.resolveUserLlmKey` + `selectLlmApiKey` 优先级补档 (per-agent→org-pool→**user-pool**→workspace→env, org 主 user 回退, **仅成员拥有的 agent** via spawn 时 `ownerUserIdOf` 从 grant 算, operator 逐字节零回归); A-M3b `HostMeCredentialsService` + `/api/me/credentials` (vault `ownerKind='user'`, secret 永不返回, provider 限 anthropic/openai, delete 404 防枚举); A-M3c「我的 API 密钥」面板; **缓存自洽零接线** (vault-mutation 钩子 flush org+user 缓存). **A-M4** (`6793ca2`+`dd14db5`) 授权 UI — owner 把 agent 共享给别的 principal (user/agent/peer-hub) 授 viewer/editor/owner 走 A-M1 grant; **真 enforce 回报=共同所有** (授另一 user `owner` → 对方自己 `/me` 看到并能管, 同一条 owner grant); `HostMeAgentGrantsService` owner gate + **孤儿守卫** (任何会让资源零 owner 的 set/remove 都拒) + best-effort 审计 (`resource_grant_set`/`_revoke`); `/api/me/agents/:id/grants` (DELETE principalKey URL-encoded); 前端每张 owned-agent 卡片「管理访问」折叠面板 (列 grant+撤销 / 加 grant 行, 复用 A-M2b delegated click). **诚实边界** (A-M4 当时): 只 enforce `owner`, viewer/editor + agent/peer 主体待来。**后续已收口** (Route B P1-M1 + v5 E4): **USER 主体** viewer/editor/owner 现已在 agent (`/me` + admin 路由) + workflow 全做实; 仅剩 agent/peer **主体** grant 故意不走 resource_grants — 授权落 dispatch allow-list (agent→agent) / PeerLinkAcl (peer→hub), 见 [`docs/zh/V5-E4-FINAL.md`](docs/zh/V5-E4-FINAL.md)。 +~50 测试 (identity 348 / host 505 / web 569 绿); 详见 [`docs/zh/V5-A-FINAL.md`](docs/zh/V5-A-FINAL.md) |
| **v5 Stream B** | 完 | 模板系统 / 搬走一整套架构 (5 M) — `aipehub.bundle/v1` 的超集: 一个文件装 N agent + N 工作流 + 可寻址 KB + 一键 apiKeyPrompt + 可选加密敏感边车. 锁定决策 #4 (模板带结构+引用永不带知识内容, KB 走 MCP 引用 + `presetData` 指针) + #5 (导出三档: 结构默认明文 / 内容字面 secret 对称加密密钥另传 / 人员默认整段省略 opt-in+审计). **B-M1** (`6298ae0`) `aipehub.template/v1` manifest + `parseTemplate`: agent 校验整段委托 `parseManifest` team 路径 (一个信任边界), workflow 块不透明 re-serialize (runtime 仍唯一 schema 权威), KB 槽位 `name`+`mcpServer` 内联 XOR `useMcpServer` 引用 + `presetData` 指针, `defaults.apiKeyPrompt`. **B-M2** (`9db56c2`) 结构导出 `renderTemplate` (parseTemplate 的逆) + `POST /templates/export` 过 parseTemplate 当完整性闸; 默认结构安全 (无人员按构造 / 无知识内容只 MCP 接线 / `scrubAgentSecrets` 把非 `${...}` 值占位成 `${KEY}`). **B-M3** (`898b788`) 敏感 opt-in 导出 (`new web/src/template-crypto.ts` AES-256-GCM): `includeSecrets`/`includePersonnel` → 脱敏 secret + `resource_grants` 人员收进 `{secrets?,personnel?}` 加密成边车 `template.encrypted`, 密钥 `encryptionKey` **单独响应里返回永不进文件**, 敏感导出写 `template_export` 审计 (identity `AUDIT_ACTIONS` 加 `TEMPLATE_EXPORT`). **B-M4** (`dbadb23`) 导入 (B-M2/B-M3 的逆, 住 `agents-routes.ts` 旁 bundle import 复用同 ctx): `POST /templates/import` parseTemplate → 拿另传密钥解密边车 → upsert agent (skip-existing+lifecycle.start+`injectAgentSecrets` 替回 `${PLACEHOLDER}`) → import N 工作流逐 id 软上报 → 上报 KB 槽位**不自动接线** → reconcileHeartbeats; **人员永不还原** (principal id hub 本地, 只置 `personnelOmitted`); server.ts dispatch 把 `/templates/import` 并进 handleAgentsRoute (export 仍走 handleTemplateRoute). **B-M5** (本提交) `examples/oneclick-template/` (客服 agent + 工单工作流 + KB 槽位带 presetData 指针 + apiKeyPrompt) + 防腐验收测试 (读实拼盘过真解析器+真导入路由, 改坏即红) + `docs/zh/V5-B-FINAL.md`. +~30 测试 (web 634 / host 506 绿); 详见 [`docs/zh/V5-B-FINAL.md`](docs/zh/V5-B-FINAL.md) |
| **v5 Stream C** | 完 | 联邦授权细化 (3 M) — 给 per-link 契约补上最后两维 (接 B 的可寻址 KB 槽位 + C-M2 的节点 I/O). 锁定决策: 撤掉跨 hub per-user (C.3 不做), 授权落「具体 hub + 可调用 KB + 节点 I/O」三个 hub-local 可判维度. **C-M1a** (`b5338aa`, identity **v17**) 加性可空 `allowed_knowledge_bases_json` (NULL=全可调 legacy / `[]`=锁死 / `[names]`=白名单, 完全镜像 P4-M4 data-class 列) + `PeerStore` undefined-保留·null-清空 + 类型; 另导出 `MIGRATION_VERSIONS` 让 v16-isolation 测试免疫后续迁移. **C-M1b** (`dc6eadd`) 执行 + CRUD — 新 `host/src/peer-kb-gate.ts` 纯函数 `gateKnowledgeBaseRpc(inner, allowed)` 包共享 rpc responder (`mcp.listShared`→**过滤** discovery / `mcp.listTools`+`callTool`→off-list **拒** / 其余直透); `peer-registry.kbGatedResponder(row)` 穿 `dialOne`+`installInboundLink` 两路径 (null→不包); web peer CRUD 收+校验 `allowedKnowledgeBases`. **诚实执行点**: KB 调用过的是 `mcp.callTool` rpc 不走 dispatch, 闸必须包 per-link rpcResponder 而非 task 字段; 匹配标识=共享 MCP server 名 (=KB 槽位名). **C-M2** (`77daf00`) 节点级 I/O 授权 — `DispatchSpec.dataClasses?: string[]` (执行词汇自由 tag, 1:1 比 link `allowedDataClasses`; 区别于 workflow 级 `governance.dataSensitivity` 枚举=人看的风险摘要); runner `dispatchOne` **stamp** 到 `Task.dataClasses`→**复用 P4-M4 出站闸**按节点判 (零新闸, 只补 runner 一行). **C-M3** (本提交) Stream C 合并验收门 (`host/tests/stream-c-isolation-e2e.test.ts`: 一 home 连两 peer, orgX 两维都夹紧 [`['kb-a']`+`['public']`]、orgY 全开, 一次证 KB 轴 rpc + node-I/O 轴 dispatch 跨 peer 互不污染) + `docs/zh/V5-C-FINAL.md`. +~30 测试 (identity 352 / host 521 / web 639 / workflow 224 绿); 详见 [`docs/zh/V5-C-FINAL.md`](docs/zh/V5-C-FINAL.md) |
| **v5 Stream E** | 完 | 交付力五缺口 (按杠杆排序逐个做, **全清**): **E1** (`bc0c5ae`, 完) 单用户 no-code 糙点 — 成员 BYO key 点亮自助建 agent + 修文案. **E2** (`e5ebd51`→`57fe00d`, 完) 出站 CLI shell-out adapter — 新包 `@aipehub/cli-agent` (core-only 叶包: `cli-runner` 进程引擎 spawn/stdin/流式/abort SIGTERM→SIGKILL/timeout/ENOENT, 只收最终 argv 通用; `cli-checkpoint` 纯原语 `CliCheckpointState`/`TakeoverController`/`dangerousCommandGate`/`readReviewDecision` 兼容 `{decision}`+inbox `{answer}`/`CLI_NEVER_RESUME_AT`; `CliParticipant extends AgentParticipant` 有界 turn 循环, 默认 `maxTurns:1` 即单发, opt-in 多轮检查点) → 让 hub **驱动** Claude Code/Codex/OpenCode/Aider/Goose (`aipehub connect` 入站的镜像, 合成契约「双向」). 五缝齐: observe `onChunk` 鸭子 / intercept `TakeoverController` 轮间查 / handoff `SuspendTaskError(NEVER_RESUME_AT)` 带 turn 转录落盘 sweep 取不到 / resume `onResume` 无漂移 (carried state 原样, turn 0 不重跑, 复核改 prompt 操舵) / terminate `onTaskCancelled`→AbortController. 外加 **T2 动作闸** `dangerousCommandGate` (rm-rf/git push/sudo/curl|sh… spawn 前挂起等人批, 拒→fail-closed CLI 从未跑). `examples/coding-agent-bridge/` (`CLI_PRESETS` 一张表覆盖整类 + mock CLI + 五缝 demo + README) + **§5 验收门** `host/tests/cli-agent-e2e.test.ts` (真 Hub+suspendNotifier→identity+FileInboxStore 跑 observe→takeover→inbox handoff→resume 无漂移→terminate + 动作闸 fail-closed); host 只多 test devDep, main.ts 零改 (同 IM bridge 先 example 策略). +36 测试 (cli-agent 33 / host 641 全绿); AGENT-ADAPTER-CONTRACT §7 P0 标 done; 详见 [`docs/zh/V5-E2-CLI-ADAPTER.md`](docs/zh/V5-E2-CLI-ADAPTER.md). **E3** (`cb0ef01`+`20087b8`+本提交, 完) 知识库连接器 — 接 `examples/rag-mcp/` 先例补两个 worked example: `examples/obsidian-kb/` (个人笔记库, `uvx mcp-obsidian` via Obsidian Local REST API 插件, provider anthropic/haiku) + `examples/elasticsearch-kb/` (结构化搜索索引, `npx @elastic/mcp-server-elasticsearch`, provider openai-compatible/DeepSeek, 注 Elastic 已 deprecate standalone server 转 Agent Builder MCP endpoint); 各 agent YAML 过真 `parseManifest` 校验, config-preview demo (不起子进程, 同 rag-mcp 策略 — 真库需活集群/插件非 hermetic), demo 脚本入 root `package.json`; `docs/zh/KB-CONNECTORS.md` 连接器分类 (向量 RAG/文档库/搜索索引同构) + 读 vs 写治理 (只读默认/写显式/不可逆人闸) + **跨 hub 两层闸** (MCP server 自身 ACL + AipeHub per-link KB allowlist via C-M1 `gateKnowledgeBaseRpc`) + 模板带 KB 引用不带内容 (B-M1 决策#4); 框架仍零知识存储 (无 vectors/documents 表, host 不连集群不读 vault, 全走 MCP 子进程). **E4** (`3765f55`+`d2f91fd`+`a89e965`+本提交, 完) agent 资源 RBAC 收口 — 把 admin agent 路由 (`/api/admin/agents/*`) 对齐 workflow RBAC (P2-M5): 之前只 `requireAdmin`, 现接 `resource_grants` ladder (非冗余面 = admin 路由这块对称缺口, 不重造整套 RBAC; agent `/me` 路径 Route B P1-M1 早做实, workflow P2-M5 早做实). **E4-M1** identity agent grant facade (`setAgentGrant`/`hasAgentGrant`/`listAgentGrants` 只投 user 行, 委托 `resourceGrants.*` 钉 `resourceKind:'agent'`+`userPrincipal`) + `denyIfNoAgentPerm` (PUT 要 editor / DELETE 要 owner / export 要 viewer, operator 绕过, RBAC 未接线零行为变化) + `seedAgentOwner` (建者种 owner) + grant CRUD 路由 (owner-gated, `!agentGrants`→404) + server.ts 复用 workflow 的 `resolveResourceActor` 闭包 + 16 测试. **E4-M2** admin UI「管理访问」面板 (托管 agent 卡片 + `#ma-access-modal` 复用 `wf-grant-*` CSS; id-less grant 变更钮在 main.js `!id` guard **之前** pre-guard 接线绕开既存死代码坑 — workflow 同类钮在 guard 之后是死代码, 独立小修待做). **E4-M3** 跨表面验收门 (`agent-rbac-cross-surface-e2e.test.ts`: 真 Space+Hub+IdentityStore+serveWeb + 同 store 上 `HostMeAgentGrantsService`, 双向证 admin 路由 ⇄ `/me` 共享同一 `resource_grants` 源, +4 测试, host 645 绿) + `docs/zh/V5-E4-FINAL.md`. **诚实边界**: USER 主体收口; agent/peer **主体** grant 故意留给 dispatch allow-list / PeerLinkAcl 不叠冗余 overlay (`listAgentGrants` 只投 user 行). **E5** (`914f306`→`8976eae`, 完) 中央多 hub 控制面 — **重定义**: 不是 SaaS 吸 tenant (那撞北极星「自由图非层级树」), 而是**自由图「控制面」只观察不接管**——每个主权 peer 自愿暴露**隐私安全计数** (资产/活动/健康, 永不原始行), opt-in per-link + fail-closed, 复用 Phase 18 联邦. **E5-M1** (`914f306`) identity v23 `share_summary` 列 (加性默认 0, undefined-保留 write, +4 测). **E5-M2** (`397ffc9`) `peer.summary` RPC — 新 `host/src/peer-summary.ts`: `PeerSummary` 形状=结构性隐私 (每字段是 number/number-map, 没地方放名字/id/payload → 生产者漏不了行); `buildLocalSummary` best-effort 逐族 (镜像 `collectBusinessMetrics`, 排 peer wrapper); `denyPeerSummaryRpc` 闸 (peer-registry `kbGatedResponder`→`gatedRpcResponder` 组合两闸, `!shareSummary` 即拒); `rpcResponder` 多路复用 `mcp.*`/`peer.summary`/manifest; consumer `fetchPeerSummary`+`normalizePeerSummary` 防御. **E5-M3** (`4745940`) `createPeerSummaryFederation` in-mem 缓存 (重启诚实 unknown) + `lastError` 分「离线」vs「未共享」+ web 鸭子 `peer-summary-routes.ts` (`GET/POST /api/admin/peer-summaries[/refresh]`). **E5-M4** (`7973027`) admin「控制面」UI — `identity-routes.ts` 穿 `shareSummary` (DTO 投影/parse/surface 输入类型) + `peer-admin-ui.js` 加 `pa-pol-sharesummary` 开关 + 新 `peer-summary-ui.js` (本地 footprint 钉首行 + 各 peer 计数, 未共享显示原因非编造 0, 复用 `pf-*` 零新 CSS). **E5-M5** (`8976eae`) 双 hub 摘要聚合 **E2E 验收门** (`peer-summary-e2e.test.ts`: 真 provider hub 对两消费控制面 [一共享一不], 真 in-proc link + 真聚合 surface + 真闸; 一次证 opt-in 真计数 / **no-leak** [agent id/cap/task id/model 名不过 wire] / per-link 隔离) + `docs/zh/V5-E5-FINAL.md`. **gotcha**: `buildLocalSummary` 窗口 `now-30d`, `aggregateLedger` 拒负 `since` → 注入时钟须超窗口 (生产真 epoch 永远满足), 否则 llm 族被 best-effort 静默吞成 0. **观察≠接管**: 跨 hub 工作流启动器/托管 SaaS 控制面显式推迟. +36 测 (identity 4 / host 24 / web 8); 详见 [`docs/zh/V5-E5-FINAL.md`](docs/zh/V5-E5-FINAL.md) |
| **v5 Stream F** | 完 | 控制面历史趋势 + 告警阈值 (E5 day-2 收口, 7 M) — 给 E5 point-in-time 控制面加「时间轴回放」+「越线拍肩」, 严守 counts-only + 只观察不接管. **F-M1** (`6b257d6`, identity **v24**) `peer_summary_snapshots` append-only 表 (同 ledger/audit 无 FK) + `PeerSummarySnapshotStore` (append/list 半开窗 `captured_at ASC`/prune 原语); `summary_json` opaque blob identity 从不 parse. **F-M2** (`ee74266`) `peer-summary-metrics.ts` 指标注册表 (9 标量计数 dotted-key→extractor, `runs.byStatus`/`llm.windowDays` 故意非指标) = 趋势投影 + 告警求值器单一真相源 (能画即能告警); `projectPeerSummaryMetric` 未知 key→undefined 不抛; capture 接 `refresh` (每 peer 成功拉取 + local 总采, best-effort). **F-M3** (`bc5f817`) web `GET /api/admin/peer-summaries/history?source=&metric=` 鸭子路由 (回 points + metricKeys). **F-M4** (`a8f5bda`, identity **v25**) `peer_summary_alert_rules` 表 (`asr_<hex>` id, list `created_at,rowid` tiebreak 防同毫秒乱序, threshold REAL, metric/source opaque) + 纯求值器 `evaluatePeerSummaryAlerts` (跳 disabled, `'*'` 通配, breach 携 ACTUAL source 非通配, 「此刻」语义不存 firings). **F-M5** (`3f4f0ee`) host 扩 federation surface (listAlertRules/add/update/remove/evaluateAlerts 鸭子 `alertRules` sink) + main.ts `{snapshots:identity, alertRules:identity}` + web 告警 CRUD/evaluate 路由 (`GET /peer-summary-alerts`→{alerts,rules,metrics}; POST/PATCH/DELETE /rules[/:id]; typed code→409/404/400). **F-M6** (`4d8ad42`) admin UI 扩控制面板: 告警红徽章 + 趋势内联 SVG sparkline (无图表库) + 规则 CRUD 表; 补 `.peer-summary-panel` CSS scope (E5-M4 借的 `pf-*` scope 在 `.peer-federation-panel`); 硬编码中文同 sibling 联邦面板; build:assets 重建. **F-M7** (本提交) 双 hub E2E 验收门 (`stream-f-control-plane-e2e.test.ts`: 真 provider hub + 消费侧真 IdentityStore 接 snapshots+alertRules; 一次证 趋势两点 reflect 2→3 / 告警 live 触发 ACTUAL source + disable 停火 + CRUD 持久 / **no-leak** 快照 blob+breach payload 只携计数) + `docs/zh/V5-F-FINAL.md`. +测 (host 699 / web 806 绿, 零回归). **显式推迟**: 告警通知投递 (webhook/email/IM) / 触发历史持久化 / 跨 hub 告警聚合 / 快照降采样; 详见 [`docs/zh/V5-F-FINAL.md`](docs/zh/V5-F-FINAL.md) |
| **v5 Stream G** | 完 | 跨 hub 工作流编排 (北极星 **第 2 层「跨组织协作」**收口, 3 M) — 一个 hub 的声明式工作流编排一步到**另一个 hub** 的能力, 跨组织走出站审批闸; 工作流跨得了边界, 凭证/数据/计费各归各家. **无新 schema/无新 workflow YAML 关键字** = 把已 ship 零件接成完整故事 (跨 hub 调度本就是「能力住在 peer 上的能力调度」). **G-M1** (`1242e91`) peer wrapper 通告可编排能力 — `peer-registry.ts` dialOne+installInboundLink 各加一行 `...(row.outboundCaps ? { remoteCapabilities: row.outboundCaps } : {})`: per-link 策划的 `outboundCaps` 出站白名单**同时**是 wrapper 对外通告的能力集 (**通告=授权**, 同一意图不拆两旋钮); `null`/未设→通告空 (安全默认, legacy peer 零变化); 此前从没穿 `remoteCapabilities` → 任何工作流能力调度永远选不中 peer = 真正缺口; +2 测 (`peer-capability-advertise.test.ts` 逐字镜像 peer-registry 穿线: outboundCaps→ok 跨界 / 无→no_participant). **G-M2** (`db2650f`) 跨 hub 工作流编排 E2E 验收门 (`cross-hub-workflow-e2e.test.ts`) — 整 Stream 的理由那一个测: 工作流步 → 被审批闸挡的 peer → 跨 hub → 两步 resumeParent (此前 outbound-approval-e2e 只 parentKind=none, inbox-e2e 只 broker 不跨界; G-M2 两者合一, 靠 G-M1 才路由得过去); 全真栈 (两 Hub+inproc link, 真 ApprovalGatedParticipant via wrapOutbound, 真 suspendNotifier→IdentityStore, 真 WorkflowController+HostInboxService); 三剧情 (approve: 挂起→provider 未调→批准后恰好调一次+payload 完整+裁决回流; reject: provider 从未调+run failed+outbound_approval_denied; no-approval: 同步 ok); 三不变量 NEVER_RESUME_AT/子先于父/parentKind 从 ancestry 算. **G-M3** (本提交) `examples/cross-hub-workflow` host-free 确定性 demo (core+workflow+inbox, 内联 ~40 行 OutboundApprovalGate 镜像 + resolveApproval 两步恢复镜像, 同 cafe-ops 先例; 工作流 review[跨 hub cap]→archive[本地 cap], YAML 无 peer 名; 11 自断言全绿) + `pnpm demo:cross-hub-workflow` + `docs/zh/V5-G-FINAL.md` + 本登记. host 699→**704** 绿零回归. **day-2 (G2) 启动前可见性完** (4 M, 机制能跑→admin 点「开始」前看得见哪些步骤跨 hub/去哪个 peer/会不会卡审批): **G2-M1** (`d27bc5b`) host 检测跨 hub 步骤 — `WorkflowSummary.crossHubSteps?` + 纯函数 `crossHubStepsOf(def, localCaps, peerEntries)` (遍历每步 dispatch 能力, 本地满足跳过 [本地+peer 双满足→路由本地→不标, 防假警报], peer 通告命中标出); **复用而非重造**: core re-export `extractRequiredCapabilities` (peer-acl 入/出站 ACL 共用「策略→所需能力」提取器, explicit→null) 让检测语义=真实路由白名单语义不漂移 + `hub.registry.get(peerId).capabilities` (=G-M1 接通的 `remoteCapabilities`, 工作流调度真正查的同一源); main.ts 注入 `PeerCapabilityView` 闭包 (status() connected peer); +8 测 `cross-hub-steps.test.ts`. **G2-M2** (`13dd96c`) admin UI 卡片蓝色 `🔗 跨 hub 步骤` details (区别 governance 琥珀色 = 「离开本 hub」非「风险」) + 启动对话框 `wf-xhub-note` 启动前提示「N 步派到 peer, 对方设审批闸需收件箱批准」; web 鸭子 verbatim echo 零路由改 + i18n + bundle 重建; web 818 绿. **G2-M3** (`2c3f49c`) 走**真** controller 路径验收 (`importFromText→versioning→summaryFromView→computeCrossHubSteps`, peer view 当 stub 注入 — view 本就是注入缝, transport 级双 hub 已被 e2e 覆盖不重复) +3 测; host 712 绿. **G2-M4** (本提交) day-2 §八 文档 + 本登记. **显式推迟** (更新): per-step 粒度审批 / 跨 hub 工作流启动**后**那一跳 transcript chain (启动**前**可见性 G2 已补) / 节点级 data-class+per-link 配额叠加 (同 chokepoint 可叠) / A2A 外部 agent 当工作流步; 详见 [`docs/zh/V5-G-FINAL.md`](docs/zh/V5-G-FINAL.md) |
| **v5 Stream H** | 完 | A2A 外部 agent 当工作流步 (Stream G 的姊妹, 4 M) — Stream G 收口时 §六显式 deferred「编排一个 **A2A** 外部 agent (`A2aRemoteParticipant`) 作为工作流步骤是独立路径」, Stream H 做实. **关键事实=机制根本不用改**: `A2aRemoteParticipant` (Phase 18 C-M4 出站边) 是个**本地参与者** (`extends AgentParticipant`, 注册在某 capability 下, 被派发时转发到外部 A2A `message/send` 端点把回复变 ok 输出), 故一个 `{kind:capability}` 工作流步**本来就路由到它** — runner/scheduler/resolver/YAML **零改**. **无新 schema/无新 workflow YAML 关键字**, 同 Stream G 是「把已 ship 零件接成完整故事」. **H-M1** (`0994295`) 验收门 `a2a-workflow-step-e2e.test.ts` (整 Stream 的理由那测): 真 Hub 跑工作流 + 真 `A2aServer` over `http.createServer` loopback (背靠第二个真 Hub serving 外部 agent, **真 socket 非 mock**) + 真 `A2aRemoteParticipant`; 2 剧情 (happy: `fired.kind==='ok'` **不挂起** [外部 A2A 步无审批闸一步到底] + 回复跨真 HTTP 回流喂本地 archive 步; wrong bearer: 401→步 failed+run fail-closed+archive 0). **H-M2** (`54c9cff`) 扩 G2「启动前可见性」覆盖 A2A 外部步 — `CrossHubStep`/`PeerCapabilityView` 各加 `kind?: 'peer'|'a2a'` (缺省 `'peer'`, legacy 零变化); `A2aOutboundManager` 加只读 `liveCapabilities()` (manager 是「谁在线」权威, 封装比让 main.ts 翻 private source 干净); main.ts `peerCapabilities()` 闭包返 mesh peers(`kind:'peer'`)+A2A agents(`kind:'a2a'`); **正确性钉死**: A2A agent 是**真·本地注册参与者** (不像 mesh wrapper 是占位), 故其 id 必须在 entry 集里 (`peer`=`agent.id` 自动成立), 否则它**自己的能力**进 `localCaps`→看似本地满足→永不标跨 hub; mesh peers 排 A2A 前 (一能力双通告时归 mesh peer, 因 mesh 可能带审批闸, 保守提示「可能要批」更安全); `cross-hub-steps.test.ts` +2 测 (10). **H-M3** (`de3e308`) admin UI 诚实区分目的地 (鸭子 verbatim echo 零路由改): `CrossHubStepView.kind?` pass-through; `workflows.js crossHubPanel` 逐行按 kind 出「→ 外部 A2A agent: X」vs「→ 对等 hub: X」(新 i18n `workflowCrossHubA2a`); `main.js openWorkflowStart` 把步**按 kind 分组**, `workflowCrossHubNote` 从 `(n,peers)` 进化成 `(peerDests,a2aDests)` 分别陈述诚实行为 (mesh peer:「若对方设审批闸需收件箱批准」/ A2A:「**无审批闸会立即发出**」); i18n + bundle 重建; web 818 绿. **H-M4** (本提交) `examples/a2a-workflow-step` host-free 确定性 demo (core+workflow+a2a, 注入 `fetchImpl` 扮外部 A2A 翻译 agent 同 a2a 单测手法 — 解析出站 JSON-RPC body 断言协议形状 [method `message/send`/bearer/`metadata.skill`] = demo 即 A2A 协议冒烟; 工作流 translate[外部 A2A cap]→archive[本地 cap], YAML 无端点/token; 8 自断言: 外部步不挂起立即外发/经 wire 被调/payload 完整/带 skill/带 bearer/译文回流本地步/archive 只跑 happy/外部失败 run fail-closed) + `pnpm demo:a2a-workflow-step` + `docs/zh/V5-H-FINAL.md` + 本登记. **对比 Stream G**: 目的地 mesh 对等 hub vs 外部 A2A agent; 协议 mesh RPC over HubLink vs A2A message/send over HTTP; **审批闸 可有 vs 无 (立即外发)**; 出站参与者 peer wrapper vs `A2aRemoteParticipant`; **共同点 = 都是 capability dispatch, 工作流那步都不点名目的地, runner/YAML 零改**. host 712→**719** 绿零回归. **显式推迟**: A2A task 生命周期作为工作流步 (远端会挂起返 Task→`a2aSendRaw`+`a2aGetTask` 轮询是独立路径, 本 Stream 只 blocking) / 外部 A2A 出站的 per-step data-class+配额闸 (裸出站边不过 P4-M4 chokepoint, identity `a2a_outbound_agents` 可挂策略列) / 给外部 A2A 步**可选**加出站审批 (复用 Phase 16 inbox, 独立决策; 本 Stream 只如实呈现「无闸」); 详见 [`docs/zh/V5-H-FINAL.md`](docs/zh/V5-H-FINAL.md) |
| **下一步** | — | **Stream E 五缺口全清 (E1-E5) + Stream F (控制面历史趋势/告警) + Stream G (跨 hub 工作流编排, 北极星 第 2 层收口) 完**. 锁定决策已执行: 按杠杆逐个做, 一里程碑一小 commit, adapter/连接器/控制面/跨组织编排都遵「框架不存数据、只观察不接管、工作流跨边界但凭证各归各家」. G 把第 2 层「跨组织协作」收口: 一个 hub 的工作流编排另一个 hub 的能力, 走出站审批闸 (**通告=授权** + 两步恢复 + 三不变量; 见 `docs/zh/V5-G-FINAL.md`). **候选下一步** (非承诺, 按 /goal 推荐挑): 跨 hub 工作流 admin-UI 启动器 + 跨 hub 步骤 transcript chain (G day-2) / 控制面告警通知投递 (webhook/email/IM, F day-3) / Route B P2 托管控制面 (单独 track, 平台持有信任模型) / A2A 外部 agent 当工作流步. 按 /goal 全按推荐逐里程碑执行. **上手可用工作流案例 (进行中)**: 用户开新方向「补几个上手可用的工作流」, 第一个 `examples/personal-coding-hub` 完 (CW1 `b8c173c`) — 路由 LlmAgent (DispatchToolset) 决定派 claude-code/codex, 两 CliParticipant 共享 cwd → AGENTS.md(规范)+PROGRESS.md(交接棒, codex 读到 claude-code 刚写的条目=handoff 证明), dangerousCommandGate 安全闸, mock LLM+CLI 确定性自断言可跑; 用户决策: 路由「模型」决定派给谁/如何反馈 + 形态=aipehub 承担的案例不 fold 进 host. **CW3-CW5 (Obsidian 方法论 KB + 可载入模板; CW3 `0c7ff02` / CW4 `ec1abcb` / CW5 本提交)**: 用户要求把这第一个案例的「方法论大脑」做成**可载入**文件而非内置 TS — `examples/personal-coding-hub/template/personal-coding-hub.template.yaml` (`aipehub.template/v1`): mentor agent `coding-mentor` (DeepSeek + 内联 mcp-obsidian) + 可寻址 KB 槽位 `coding_methodology` (presetData 指针→`methodology-vault/`); 模板只带导师+KB 接线 (CLI 编码 agent 仍 example 运行时接, 因模板 agents 须过 parseManifest), 知识**内容**按 Stream B 决策 #4 住模板外 = `methodology-vault/` 7 篇蒸馏 Karpathy 工作流 (Software 3.0 规范即程序 / vibe coding 边界 / agentic engineering 拴绳小步 / LLM-as-compiler raw→编译 wiki) 的 Obsidian vault (本身即该 wiki 模式实例, distill 非逐字引用); web 防腐门 `packages/web/tests/personal-coding-hub-template.test.ts` 读实文件过真 parseTemplate+真 import 路由 (+5 web=769 绿); `pnpm demo:personal-coding-hub:template` core-only config-preview 载入演示 (读文件+解析+自断言, 不起 mcp-obsidian, 同 obsidian-kb 策略). **第二个上手案例 `examples/personal-research-hub` 完 (CR1 `2211863` / CR2 `0e6b052` / CR3 本提交)**: 用户选「个人研究/知识中枢」承接 Karpathy「LLM-as-compiler」方法论 — 一个 librarian (LlmAgent+DispatchToolset) 把 raw 源材料编译成互链 Obsidian wiki 再 ask-your-wiki. **CR1** 可跑 demo: 真文件 I/O (临时 raw/+wiki/), `CompilerAgent`/`ResearcherAgent` 确定性 stand-in 做真读写 (LLM-as-compiler / ask-your-wiki 两 Karpathy 模式), librarian mock provider 路由 ingest-vs-retrieve, 中文问句用 ASCII 关键词 (len≥3) 检索绕 CJK 分词, 自断言每 raw 一笔记+backlink index+答案归档 wiki/answers/ 引来源. **CR2** 可载入模板 `template/personal-research-hub.template.yaml`: **3 个托管 LLM agent** (librarian/compiler/researcher 都挂 mcp-obsidian, 对比 coding-hub 模板 1 个 — 那边 CLI 编码 agent 不能当托管 agent, 这里仨本就是托管 LLM agent → 整队搬走, Stream B「一文件装 N agent」) + KB 槽位 `research_wiki` + DeepSeek apiKeyPrompt; 编排 (dispatch 图) 代码级不入模板 (workflows:[] 同 coding-hub), 知识内容不入模板 (决策 #4, presetData 指针); web 防腐门 `personal-research-hub-template.test.ts` 读实文件过真 parseTemplate+真 import (+5 web=774 绿). **CR3** `pnpm demo:personal-research-hub:template` config-preview 载入演示 + README + 本登记. **第三个上手案例 `examples/battle-monk-training`「战斗修士锻炼」完 (BM1 `5b869ea` / BM2 `41cef5d` / BM3 本提交)**: 用户点名「个人成长计划类」承接「身→心→学」三柱成长指引, 内置多 agent + Obsidian KB **存用户状态** (非参考资料 — 这是对比前两案例的新东西), 冷峻 grimdark-monastic persona 面向战锤 40k 风格冷淡型男性用户 (原创同人致敬, 不含受版权保护文本/专有名词). **BM1** 可跑 demo: 督修 (LlmAgent+DispatchToolset, mock provider) 把今日操练派给三柱 (`body-drill`/`mind-forge`/`lore-scribe`), **一个参数化 `PillarAgent` 实例化 3 次** (轻量) 真读 `priorSteps` 算下一阶 + 写回 `codex/<pillar>.md`, 连续性 (「承前 N 阶」rank 递增) 是设计核心 = Codex 是修士持久档案; 真临时目录种三柱 baseline, `index.ts` 自断言每柱 ≥2 阶且引前序. **BM2** 可载入模板 `template/battle-monk-training.template.yaml`: **4 个托管 LLM agent** (preceptor 督修[route] + 三柱[body/mind/lore] 各挂内联 mcp-obsidian + 冷峻 persona), KB 槽位 `acolyte_codex` (presetData url 指针 — 状态内容住模板外, 决策 #4), DeepSeek apiKeyPrompt, `workflows:[]` (dispatch 编排代码级不入模板, 同前两案例); web 防腐门 `battle-monk-training-template.test.ts` 读实文件过真 parseTemplate+真 import 落 4 agent (+5 web=779 绿). **BM3** `pnpm demo:battle-monk-training:template` config-preview 载入演示 + README (含原创同人致敬声明 + persona/受众框定 + 安全边界「状态是个人数据/非医疗心理建议」) + 本登记. **首个组织 hub 案例 `examples/cafe-ops`「门店运营(奶茶 / 咖啡店)」完 (SM1 `58f2d82` / SM2 `b9cf325` / SM3 本提交)**: 用户开新方向「再加两个组织 hub 模板」(一个同好会/战团, 一个正式工作流/店面管理), 锁定 storefront=奶茶咖啡店先做、同好会=单 hub 内共享. **这是第一个 `template.workflows[]` 非空的模板** —— 前三个个人 hub 编排是运行时 DispatchToolset 故 `workflows:[]` 空, 组织的价值在**正式流程**, 所以 cafe-ops 真把声明式工作流装进模板, 用上两件组织能力: `surface.me` (Phase 14 成员自助) + `human:` (Phase 16 店长审批 HITL). 三条工作流覆盖用户点名的三件事: `cafe-staff-onboarding` (新员工上手学岗位 SOP/规范, 成员自助无审批) / `cafe-shift-availability` (管理排班, human: 店长确认) / `cafe-overtime-claim` (管理加班费, human: 店长审批). **SM1** (`58f2d82`) 可跑 demo (core+workflow+inbox, 无 host/identity/llm): 2 个确定性 stand-in 服务三 capability, 真 `parseWorkflow` 载入三工作流; 跑通 onboarding (无审批) + overtime HITL (dispatch→suspended→收件箱→两步恢复 approve→完成带 approval); **钱是确定性算的不是 LLM 算的** (¥22/h × 1.5 × 3h = ¥99, 助手只建议, 店长 approve 定钱); 两步恢复 (子 broker 严格先于父 workflow) 手写 ~30 行镜像 `HostInboxService.resolve` 让 HITL 机制在 example 可见. **SM2** (`b9cf325`) 可载入模板 `template/cafe-ops.template.yaml`: **2 个托管 LLM agent** (培训师 cap cafe.train-position + 运营助手 caps cafe.overtime-policy/schedule-draft, 覆盖工作流派发全部 capability; human 步派 aipehub.human/v1 = host 自带 broker 不入模板) + **3 条内嵌声明式工作流** + KB 槽位 `store_ops_manual` (presetData 指针) + DeepSeek apiKeyPrompt; web 防腐门 `cafe-ops-template.test.ts` 读实文件过真 parseTemplate + **逐条 `workflows[]` 过真 parseWorkflow** (证 opaque 重序列化往返: human: 脱糖成 aipehub.human/v1, surface.me snake→camel, governance confidential 保留) + 真 import 落 2 agent/3 workflow/1 KB; `@aipehub/workflow` 加为 web **test-only devDep** (运行时 dep 不变, 同 host 先例) (+6 web=785 绿). **SM3** (`9b2077b`) `pnpm demo:cafe-ops:template` config-preview 载入演示 (含 workflows 预览 = 新东西) + README (三工作流表 + HITL ASCII 图 + 决策 #4/#5 框定 + 安全边界「钱助手建议、人定」) + 本登记. **第二个组织 hub 案例 `examples/warband-club`「战团同好会(共享档案库)」完 (W1 `7ca1754` / W2 `6cf31a0` / W3 本提交)**: 用户点名的两组织模板之二 —— **协作面** (对比 cafe-ops 的**管理面**). 形态=战锤 40k 粉丝战团 (原创同人致敬, 通用爱好者用语 战团/兄弟/司库/传令官/集结, 无受版权保护文本/专有名词), 锁定 = **单 hub 内共享** (无联邦). 组织价值=一个**全团共读共写的共享档案库**: 任何兄弟交进去的涂装方案/战报, 别的兄弟都能查到 → 你问的答案可能来自别人早先的贡献 = 合作. **W1** (`7ca1754`) 可跑 demo (core+workflow+inbox): `ArchivistStandin` (司库, caps warband.file-contribution+consult-archive, 真读写**同一个**共享磁盘目录 + CJK bigram-overlap 检索绕中文分词) + `HeraldStandin` (传令官, cap warband.draft-muster) + 3 工作流; 跑通 [A][B] 两兄弟交进同一档案库 → [C] 第三兄弟问询**检索到别人的贡献** (sources[0].contributor 是别人 = 合作做实非假设) → [D] 集结提议 HITL (挂起→战团长批→恢复); 7 自断言. **W2** (`6cf31a0`) 可载入模板 `template/warband-club.template.yaml`: **2 个托管 LLM agent** (archivist 双 cap + herald, 都挂内联 mcp-obsidian 指向共享档案库) + **3 条内嵌声明式工作流** (warband-contribute 写/warband-consult 读=合作/warband-muster 决策 human:) + KB 槽位 `warband_archive` (presetData 指针, 共享档案库内容住模板外, 决策 #4) + DeepSeek apiKeyPrompt; web 防腐门 `warband-club-template.test.ts` 读实文件过真 parseTemplate + 逐条 workflows[] 过真 parseWorkflow (证 human: 脱糖 aipehub.human/v1 + surface.me scope 保留) + 真 import 落 2 agent/3 workflow/1 KB (+6 web=791 绿). **W3** (本提交) `pnpm demo:warband-club:template` config-preview 载入演示 (1 HITL workflow vs cafe-ops 的 2) + README (三工作流表 + 合作 ASCII 图 + 原创同人致敬声明 + 决策 #4/#5 框定 + 「共享档案库即组织」边界) + root demo 脚本 + 本登记. **两组织 hub 模板 (cafe-ops 管理面 + warband-club 协作面) 全清.** **第三个组织 hub 案例 (首个跨组织) `examples/tea-supply-link`「奶茶店 ↔ 供货商 (跨组织供货链接)」完 (TS1 `3367a00` / TS2 `c733a24` / TS3 本提交)**: 用户开新方向「同样建立一个模板, 注意模版和框架是分离关系, 选奶茶店供货商与奶茶店的链接」—— 第一个**跨组织 (cross-org)** 模板, 直接吃 Stream G 跨 hub 编排 + 出站审批闸. **★ 教学点 = 模版/框架分离 ★**: 模板只带「奶茶店一侧编排骨架」, **跨组织的链接 (哪个 peer 是供货商 / `outboundCaps` 出站放行 / `requireApprovalOutbound` 审批策略) 是运行时 peer 配置, 既不在模板也不在工作流** —— `place` 步只写 capability `supplier.confirm-order` 从不点名 peer. **对比 cafe-ops**: 那是店内 `human:` 步审批 (同 hub 内), 这是**跨组织出站审批闸** (Phase 18/Stream G, 对工作流透明, 故工作流**无 human: 步**). **TS1** (`3367a00`) 可跑 demo (core+workflow+inbox, 两 in-proc hub 奶茶店+供货商): 补货工作流 draft(本地)→place(跨组织 cap)→record(本地); 内联 OutboundApprovalGate + 两步恢复镜像 (同 cross-hub-workflow); [A] 批准 → 挂起审批闸 (供货商 0 联系) → 店长批 → 跨界 → 供货商**确定性定价** (珍珠18×20+红茶45×10+牛奶6×30=¥990) 回流 → 本地建档 PO; [B] 拒绝 → 供货商从未联系 fail-closed; 11 自断言. **钱供货商算/人定外发** (同 cafe-ops 钱确定性算). **TS2** (`c733a24`) 可载入模板 `template/tea-shop.template.yaml`: **1 个托管 LLM agent** (采购助手 caps teashop.draft-order+record-order, 挂 mcp-obsidian → supplier_catalog; **不服务 supplier.confirm-order** 因它住供货商 peer) + **1 条跨组织工作流** (无 human: 步) + KB 槽位 `supplier_catalog` (presetData 指针) + DeepSeek apiKeyPrompt; web 防腐门 `tea-shop-template.test.ts` 读实文件过真 parseTemplate + workflow 过真 parseWorkflow + 真 import, **钉两处对 cafe-ops 的反转**: 每个执行步只名 capability (steps 无 peer 名), 序列化工作流**无 `aipehub.human/v1`** (+6 web=812 绿). **TS3** (本提交) `pnpm demo:tea-supply-link:template` config-preview 载入演示 (§5「链接是运行时不在模板」教学段) + README (跨组织 B2B ASCII 图 + 模版/框架分离表 + 出站闸 vs cafe-ops human: 对比 + 决策 #4/#5 + 「链接不在模板」新增一条 + 安全边界) + root demo 脚本 (TS1 已加) + 本登记. **三组织 hub 模板 (cafe-ops 管理面 + warband-club 协作面 + tea-supply-link 跨组织面) 全清.** **第四个组织 hub 案例 (第二个跨组织, 三层链条最上一层) `examples/tea-chain-hq`「连锁奶茶店总部 → 加盟门店 (跨组织指令下发)」完 (HQ1 `9f61aa1` / HQ2 `d295ba9` / HQ3 本提交)**: 用户「再加一个跨 hub 的模版, 把奶茶店的上级 (连锁奶茶店管理) 加进去」—— tea-supply-link 的 **MIRROR、方向相反**: 那个编排**朝上** (门店→供货商), 这个编排**朝下** (总部→加盟门店), 复用同一套出站审批闸。三层链条 `总部 → 门店 → 供货商` 里, **门店在中间** (对上接收总部指令 = 本案例, 对下发供货商订单 = tea-supply-link)。**★ 同 tea-supply-link 的教学点「模版/框架分离」★**: 模板只带「总部一侧编排骨架」, **跨组织的链接 (下发给哪家/哪些门店 + `outboundCaps` 出站放行 + `requireApprovalOutbound` 审批策略) 是运行时 peer 配置, 既不在模板也不在工作流** —— `rollout` 步只写 capability `shop.apply-directive` 从不点名门店 peer。**单店 vs 多店都是运行时的事, 工作流一字不改** (单店 capability 解析到那一条门店链路; 多店连多条链路或 broadcast)。审批人=区域经理 (对比 tea-supply-link 的店长)。**HQ1** (`9f61aa1`) 可跑 demo (core+workflow+inbox, 两 in-proc hub 总部+门店): 下发工作流 draft(本地)→rollout(跨组织 cap)→record(本地); 内联 OutboundApprovalGate + 两步恢复镜像; [A] 批准 → 挂起审批闸 (门店 0 联系) → 区域经理批 → 跨界 → 门店**按本店菜单确定性应用调价** (珍珠奶茶 ¥14→¥15 = Δ+1) 回执回流 → 本地建档 DIR; [B] 拒绝 (激进翻倍涨价) → 门店从未联系 fail-closed; 11 自断言. **调价门店算/人定外发** (门店拥有自己现价, 总部提新价, 门店应用并报回; 区域经理只定准不准外发). **HQ2** (`d295ba9`) 可载入模板 `template/chain-hq.template.yaml`: **1 个托管 LLM agent** (下发协调员 caps chainhq.draft-directive+record-rollout, 挂 mcp-obsidian → chain_playbook; **不服务 shop.apply-directive** 因它住门店 peer) + **1 条跨组织工作流** (无 human: 步) + KB 槽位 `chain_playbook` (presetData 指针, 运营手册内容住模板外) + DeepSeek apiKeyPrompt; web 防腐门 `chain-hq-template.test.ts` 读实文件过真 parseTemplate + workflow 过真 parseWorkflow + 真 import, 钉两处对 cafe-ops 的反转 (同 tea-shop): 执行步只名 capability (steps 无 peer 名), 序列化工作流**无 `aipehub.human/v1`** (+6 web=818 绿). **HQ3** (本提交) `pnpm demo:tea-chain-hq:template` config-preview 载入演示 (§5「链接是运行时不在模板」+ 方向朝下 + 单/多店) + README (三层链条 ASCII 图 + 模版/框架分离表 + 与 tea-supply-link 对比表 + 出站闸 vs cafe-ops human: 对比 + 「门店是主权组织非下属对象」边界) + root demo 脚本 (HQ1 已加) + 本登记. **四组织 hub 模板 (cafe-ops 管理面 + warband-club 协作面 + tea-supply-link 跨组织 shop→supplier + tea-chain-hq 跨组织 HQ→shop) 全清.** **情境感知强化 pass (EH1-EH5) 完**: 用户「强化目前所有的案例, 尤其是个人成长指引那一个, 要能结合使用者的情况, agent 能力分派要合适」—— 核心问题=mock 路由 provider 跑**固定脚本盲目扇出** (不看情况/不看历史), 修法=**分派结合使用者当前情况且仍确定性可断言**. **关键架构使能点**: 自定义 `LlmProvider` 每次 `stream()` 拿到完整 `LlmRequest` (system+messages) → 能从 prompt 读出情况 + 数已发生 `tool_use` 轮次 → 调**纯规划函数**按情况派一个目标 = 无状态确定性情境路由 (替掉跑死脚本的 mock). **EH1-EH2** (`f5babcf`+`0901ca6`) **旗舰 = 个人成长指引 `battle-monk-training`**: 新纯函数 `planSession(situation, ranks)` (按修士档案各柱已练阶 + 今日意图派身/心/学三柱**子集** + 强度, 非每次三柱全上) + situation-aware 督修 provider 读情况路由 + 多剧情 demo (各剧情新 hub/workspace, 对**派出集合**做集合相等断言抓漏派+多派) + 模板 preceptor prompt 教情境路由 + README 剧情表. **EH3** (`7a1ee28`) `personal-coding-hub`: `planRoute(goal)` (只读审查→claude-code / 琐碎→codex / 常规→两者) + situation-aware router provider. **EH4** (`502e78c`) `personal-research-hub`: `planResearch(goal, wikiSnapshot)` (**只编译 wiki 里还缺的源**, 纯答问跳过编译直接检索) + 馆员 provider 读 wiki 状态分派; 顺手修潜在 bug — 裸 `/compile/i` 会匹配 topic 词 "compiler" 误判 ingest, 锚定到动作短语 (`/\bcompile\b[\s\S]*\b(raw|sources?|wiki)\b/i` 等). **EH5** 评估 + 轻量补强 4 个工作流组织案例: **EH5a** (`0915fdd`) `cafe-ops` 唯一真缺口 — 加班建议金额从**固定 1.5 倍**改为**结合日别**倍率 (工作日 1.5/休息日 2/法定节假日 3, 对齐真实劳动法; 同 3h 因发生在哪天给 ¥99/¥132/¥198), 顺带修「周末顶班按 1.5」潜在不准为休息日 2 倍; day_kind select 进 trigger + assess 透传 (demo workflow + 模板两份) + `[B2]` 探针断言三日别. **EH5b** (本提交) 评估确认其余 3 案例 (`warband-club`/`tea-supply-link`/`tea-chain-hq`) **本就情境化** — 声明式工作流 dispatch 图**故意**是固定结构 (可治理/可版本化的根), 情境感知不在「派给谁」而在 ① **worker 从输入算结果** (司库 bigram 检索当前共享档案库命中别人贡献 / 供货商按目录+实时库存逐行定价 / 门店对自有菜单算 delta) ② **`when:`/`human:`/出站审批闸**结合情况拦人 → 无盲目扇出可修. `docs/zh/HANDS-ON-HUBS.md §6「情境感知:能力分派要结合使用者的情况」` 文档两家族模式 (个人 hub=把「看情况派谁」抽成纯函数 `planXxx()` 可单测; 组织 hub=dispatch 图保持结构性 + 把情境放进 worker 确定性算账 + 闸) + 七案例对齐表 (结合什么情况 → 怎么分派/适配). 全程零真 LLM 即可断言「同阵容不同情况派不同子集」. **「强化目前所有的案例」bounded deliverable 完, 待用户定下一方向.** |

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
| 出站驱动外部 agent (hub→CLI) | ✓ v5 Stream E E2 完 (`@aipehub/cli-agent`: `CliParticipant` 驱动 Claude Code/Codex/Aider… 五缝 observe/intercept/handoff/resume/terminate + `dangerousCommandGate` T2 动作闸 + `CLI_PRESETS` 模板 + §5 验收门; `aipehub connect` 入站的镜像, 合成契约「双向」); 详见 [`docs/zh/V5-E2-CLI-ADAPTER.md`](docs/zh/V5-E2-CLI-ADAPTER.md) | — |
| Long-running agent | ✓ Phase 11 完 (SuspendTaskError + suspended_tasks SQLite + resume sweep + LlmAgent working memory) | — |
| IM bridges | ✓ Phase 12 M1-M8 完 (6 bridge + router + cookbook + im-bridge-host example) | — |
| AI 辅助 workflow 编辑 | ✓ Phase 13 M1+M3+M4+M5 完 (assistant agent + admin UI 对话框 + deepCheck 黄色 warnings + real-LLM demo + 800 行 release notes); 详见 [`docs/zh/AI-WORKFLOW-EDITOR.md`](docs/zh/AI-WORKFLOW-EDITOR.md) | — |
| RAG | ✓ 2026-05-28 — `examples/rag-mcp/` (chroma-mcp 默认推荐, agent YAML + 备选 server 表) + `docs/zh/RAG-VIA-MCP.md` setup 文档 | — |
| 知识库连接器 (笔记库 / 搜索索引) | ✓ v5 Stream E E3 完 — 同 RAG「框架不存知识」模式扩到两种新形态: `examples/obsidian-kb/` (Obsidian vault via `uvx mcp-obsidian`) + `examples/elasticsearch-kb/` (ES 索引 via `@elastic/mcp-server-elasticsearch`); `docs/zh/KB-CONNECTORS.md` 分类 + 读写治理 + 跨 hub 两层闸 (MCP server ACL + per-link KB allowlist) + 模板带引用不带内容 | — |
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
- **主流 agent 接入标准**: 以后每个主流 agent 适配器都必须过《`docs/zh/AGENT-ADAPTER-CONTRACT.md`》的「双向 + 可快速接管」验收门 —— ① 双向连通 (入站 MCP/A2A + 出站 shell-out/A2A/鸭子 adapter); ② 五控制缝 (可观测/可拦截/可移交/可续跑/可终止); ③ 接管粒度至少 Tier 1, 能改文件·花钱·对外发的到 Tier 2, 黑盒 agent 的副作用面在 hub 边界钉 Tier 2。新写 adapter 先对表。
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
| 上手案例 — 5 个开箱即用 hub (3 个人 + 2 组织) 对照表 + 确定性 demo + 真 DeepSeek/Obsidian go-live runbook + 验证锚点分层 | `docs/zh/HANDS-ON-HUBS.md` |
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
| 控制面历史趋势 + 告警阈值 (peer.summary 快照/趋势 sparkline + 告警规则纯求值, counts-only, E5 day-2) | `docs/zh/V5-F-FINAL.md` |
| 跨 hub 工作流编排 (北极星 第 2 层; 一个 hub 工作流编排另一个 hub 能力, 走出站审批闸; 通告=授权 + 两步恢复 + 三不变量; 无新 schema) | `docs/zh/V5-G-FINAL.md` |
| A2A 外部 agent 当工作流步 (Stream G 姊妹; `A2aRemoteParticipant` 是本地参与者 → `{kind:capability}` 步零改路由到它; 无审批闸立即外发; 启动前可见性按 kind 区分 mesh peer vs 外部 A2A) | `docs/zh/V5-H-FINAL.md` |
| 企业 SSO — OIDC 单点登录 (账号联结 + 协议核 + client + provider 存储 + 登录/admin 路由 + UI) | `docs/zh/V6-ROUTE-B-P1-M4-OIDC.md` |
| 企业 SSO — SAML 2.0 SP (成熟 DSig 库 + 自写 SP 胶水 + XSW 防护 + cert 公钥无 vault + JIT-link-by-asserted-email + 登录/admin 路由 + UI) | `docs/zh/V6-ROUTE-B-P1-M5-SAML.md` |
| 联邦 peer onboarding (mint-peer-token CLI + admin onboarding 面板 + per-link 信任契约编辑器; 后端复用 Phase 18/P4/C-M1) | `docs/zh/V6-ROUTE-B-P1-M7-PEER-ONBOARDING.md` |
| 出站 A2A agent 持久化配置 (identity v22 a2a_outbound_agents 无 vault + host A2aOutboundManager 开机/运行时物化 + web 鸭子 CRUD + 「联邦」tab 面板; 替代 AIPE_A2A_AGENTS env blob; token 留环境变量名永不入库) | `docs/zh/V6-ROUTE-B-P1-M11-A2A-OUTBOUND.md` |
| A2A 任务生命周期 (suspend→Task(working) + tasks/get 轮询; opaque 句柄 + per-peer 归属隔离 fail-closed; tasks/get 被动读 hub.taskResult 零新 core hook; 真 HTTP 生命周期验收门) | `docs/zh/V6-ROUTE-B-P1-M8-A2A-LIFECYCLE.md` |
| 真实 LLM 冒烟门进 CI (provider 工具调用往返 + 整栈工作流 live 测; 独立 `live.yml` 夜间/手动门, key 从 secrets, skip-clean 缺 key 跳过永不假红; 廉价模型默认 + DeepSeek 兼容路径; 故意非硬释放闸) | `docs/zh/V6-ROUTE-B-P1-M13-LIVE-GATE.md` |
| 完整审计报告 | `docs/zh/AUDIT-v4-phase5.md` |
| 主流 agent 适配器契约 (双向 + 可快速接管验收门) | `docs/zh/AGENT-ADAPTER-CONTRACT.md` |
| 快捷接入主流 agent (入站: `aipehub connect <agent>`) | `docs/zh/QUICK-CONNECT.md` |
| 出站 CLI shell-out adapter (hub 驱动 Claude Code/Codex/Aider… + 五缝 + 动作闸 + §5 验收门) | `docs/zh/V5-E2-CLI-ADAPTER.md` |
| 知识库连接器 (Obsidian 笔记库 / Elasticsearch 搜索索引 / 向量 RAG, 全走 MCP; 读写治理 + 跨 hub 两层闸 + 模板带引用不带内容) | `docs/zh/KB-CONNECTORS.md` |
| RAG — 向量检索 via MCP (框架不存知识, `mcpServers` 完整 schema, 配额两层, 跨 hub server-侧 ACL) | `docs/zh/RAG-VIA-MCP.md` |
| MCP 接入(client + server) | `docs/zh/MCP.md` |
| Services 插件 RFC 系列 | `docs/services-rfc.md` 及 `*-rfc.md` |
| 部署 / 运维 / 监控 | `docs/zh/DEPLOY.md`, `docs/OPERATIONS.md`, `docs/MONITORING.md` |
| 历史 commit 流水账 | `CHANGELOG-v3-dev.md`, `CHANGELOG.md` |
| 历史外部审计 | `audits/<date>-<auditor>/` (按时间归档, `audits/README.md` 是索引) |

---

## 六、目录结构速查

```
packages/                       31 个包, pnpm workspace
├── protocol/                   wire protocol(v1.2) + wire types, zero runtime
├── core/                       Hub, Scheduler, Storage, Participant (依赖 protocol)
├── transport-ws/               WebSocket transport + HubLink (federation)
├── sdk-node/                   Node 客户端 SDK
├── identity/                   v4 — users/credentials/sessions/vault/quota/peers/im_bindings/suspended_tasks; Phase 17: usage_ledger (v=11) + ledger-store.ts (逐条账本) + quota-store.ts recordUsage (ungated 记账); Phase 18: peers v12 加 per-peer 信任契约 4 列 (kind/acl_json/outbound_caps_json/require_approval_outbound); Route B P1-M3: totp (v19, vault-backed); Route B P1-M4 OIDC SSO: oidc.ts (协议纯核 — PKCE/state/nonce/RS256 id_token) + oidc-provider-store.ts (oidc_providers v20, client_secret 进 vault) + credentials kind='oidc' 账号联结 + authenticateOidc; Route B P1-M5 SAML SSO: saml-provider-store.ts (saml_providers v21, **无 vault** — idp_cert 是 X.509 公钥) + credentials kind='saml' 账号联结 + authenticateSaml (XML 协议核在独立包 @aipehub/saml, identity 只做纯映射零 XML); Route B P1-M11 出站 A2A: a2a-agent-store.ts (a2a_outbound_agents v22, **无 vault** — token_env 是环境变量名非 bearer, 镜像 saml-provider-store 无 secret 列形状)
├── host/                       生产 host 二进制 (main.ts)
│   └── src/
│       ├── local-agent-pool.ts        host-managed agents; Phase 17: usageSink 双账 (账本 + ungated 预算 recordUsage)
│       ├── org-api-pool.ts            per-org LLM key cache; Phase 17: makeLlmQuotaGate budgetPeeks (token/cost fail-closed)
│       ├── pricing.ts                 Phase 17 — 模型价目表 + estimateCostMicros (整数 micro-USD, pricing.json 可覆盖)
│       ├── peer-registry.ts           federation peer 拓扑; Phase 18 — 传持久 ACL 进 installPeerLink + outboundApprovalGate wrap
│       ├── peer-manifest.ts           Phase 18 A — buildLocalManifest (排除 wrapper) + peer.manifest RPC provider + in-mem federation cache
│       ├── outbound-approval.ts       Phase 18 B — ApprovalGatedParticipant (出站跨组织 task 命中 requireApprovalOutbound → inbox 审批)
│       ├── a2a-server.ts              Phase 18 C — 入站 A2A message/send → hub.dispatch (per-peer bearer fail-closed, capability-only); Route B P1-M8b: suspend → workingTask(opaque id) + tasks/get (per-peer 内存任务表, 归属隔离 fail-closed, 读 hub.taskResult)
│       ├── workflow-versioning.ts     Phase 15 — 生命周期+修订编排, 唯一注册权威, HostDefinitionResolver
│       ├── inbox-service.ts           Phase 16 — 成员 inbox 两步恢复 (子 broker 先于父 workflow)
│       ├── oidc-client.ts             Route B P1-M4c — OIDC client 胶水 (discovery + JWKS + code→token, fetchImpl 可注入)
│       ├── oidc-login-service.ts      Route B P1-M4e — 浏览器 SSO 往返编排 (single-use state + JIT-link-by-verified-email 不自动开户 + 铸同一 ses_ session)
│       ├── saml-login-service.ts      Route B P1-M5d — 浏览器 SAML 往返编排 (single-use RelayState 验签前消费 + InResponseTo 钉死 + JIT-link-by-asserted-email + 铸同一 ses_ session; ACS URL 从 AIPE_PUBLIC_URL)
│       ├── a2a-outbound.ts            Route B P1-M11b — A2aOutboundManager: 从 a2a_outbound_agents 开机物化 + 运行时 refresh/remove 出站 A2aRemoteParticipant (bearer 从 process.env[tokenEnv] 读, 持久化但未激活诚实态, statusOf 只读 liveness 探针; 替代 AIPE_A2A_AGENTS env blob)
│       └── ...
├── web/                        admin UI HTTP + SSE + SPA; Route B P1-M4 OIDC: src/oidc-routes.ts (公开登录 start/callback/providers, pre-CSRF 区) + src/oidc-admin-routes.ts (admin provider CRUD, secret write-only) + static/oidc-ui.js (admin「SSO」tab 面板) + static/app.js renderSsoButtons (登录屏); Route B P1-M5 SAML: src/saml-routes.ts (公开 start/acs/providers/metadata, ACS 跨站 POST 住 pre-CSRF 区) + src/saml-admin-routes.ts (admin provider CRUD, cert 是公钥照常返回) + static/saml-ui.js (admin「SAML」tab 面板); Route B P1-M7 peer onboarding: static/peer-admin-ui.js (「联邦」tab `#peer-admin-panel` — peer CRUD/生命周期 + 行内 per-link 信任契约编辑器, peerToken write-only; 后端复用既有 identity-routes peer CRUD + parsePeerPolicyFields); Route B P1-M11 出站 A2A: src/a2a-admin-routes.ts (admin CRUD `/api/admin/a2a-agents`, tokenEnv 非密钥照常返回 + view 带运行时 active/inactiveReason) + static/a2a-ui.js (「联邦」tab `#a2a-outbound-panel` — 出站 agent CRUD + 诚实 liveness 徽章, 令牌不在 UI 填只填环境变量名)
├── llm/                        LlmAgent + LlmProvider 抽象 + DispatchToolset + ComposedToolset
├── llm-anthropic/              Anthropic provider (streaming + tool use + vision)
├── llm-openai/                 OpenAI / DeepSeek / Qwen / Ollama (compat, streaming + tool use)
├── workflow/                   YAML workflow runner — parseWorkflow / WorkflowRunner / RunStore / predicate / resolver, 零 LLM dep; Phase 15: lifecycle.ts 状态机 + revision-store.ts / lifecycle-store.ts (文件优先, run 钉修订防漂移)
├── workflow-assistant/         Phase 13: WorkflowAssistantAgent (自然语言 → YAML, draftStatus), 依赖 workflow + llm
├── inbox/                      Phase 16: 成员任务 inbox — InboxStore / FileInboxStore / HumanInboxParticipant broker (human-in-the-loop, cap aipehub.human/v1), 只依赖 core
├── a2a/                        Phase 18 C: A2A (Agent2Agent) interop — message/send wire 类型 + a2aSend client + A2aRemoteParticipant (出站), 入站 A2aServer 在 host; 依赖 core; Route B P1-M8: task lifecycle (A2ATask/tasks/get wire 类型 + workingTask/completedTask/failedTask 构造器 + a2aSendRaw/a2aGetTask client, suspend→Task→轮询)
├── cli-agent/                  v5 Stream E E2: 出站 CLI shell-out adapter (hub 驱动 Claude Code/Codex/Aider…) — cli-runner 进程引擎 (spawn/stdin/流式 onChunk/abort SIGTERM→SIGKILL/timeout) + cli-checkpoint 纯原语 (CliCheckpointState/TakeoverController/dangerousCommandGate/CLI_NEVER_RESUME_AT) + CliParticipant (有界 turn 循环, 五缝 observe/intercept/handoff/resume/terminate, 默认 maxTurns:1 单发), 只依赖 core; 验收门在 host (cli-agent-e2e.test.ts), 模板在 examples/coding-agent-bridge
├── saml/                       Route B P1-M5: SAML 2.0 SP 协议核 — AuthnRequest 构造 (HTTP-Redirect deflate) + SAMLResponse 验签/断言解析 + XSW 防御 (pin key/getSignedReferences/禁 DOCTYPE) + SP metadata; 危险 XML-DSig/C14N 交成熟库 (xml-crypto + @xmldom/xmldom), 自写 SP 协议胶水; XML 依赖隔离本包不外溢

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
├── cli/                        aipehub CLI (host start / repl / demo / connect / mint-peer-token [Route B P1-M7a: 256-bit base64url 对称 bearer, 纯无状态])
└── evals/                      workflow / prompt 评测

python-sdk/                     PyPI `aipehub` (含 adapters/ — Phase 19 P5 LangGraph/CrewAI participant adapter)
templates/                      agents / teams / workflows / bundles / community
examples/                       40 个端到端 demo (含 Phase 19 P5 activepieces-bridge / windmill-bridge; v5 Stream E coding-agent-bridge / obsidian-kb / elasticsearch-kb; Stream G cross-hub-workflow; Stream H a2a-workflow-step [外部 A2A agent 当工作流步]; 上手案例 personal-coding-hub + personal-research-hub + battle-monk-training; 组织 hub cafe-ops [管理面] + warband-club [协作面] + tea-supply-link [跨组织面 shop→supplier] + tea-chain-hq [跨组织面 HQ→shop])
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
