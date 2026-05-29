# AipeHub — Agent 北极星 (CLAUDE.md)

> 本文是给 Claude / 任意 LLM agent 看的项目根级指南。每次新会话第一件
> 事就是读它，避免重建上下文跑偏。人类读者也可以读，但更友好的入口是
> `README.md` / `docs/zh/OVERVIEW.md`。
>
> Last updated: 2026-05-28

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

## 二、现在在哪一段(2026-05-28 快照)

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
| **下一步** | — | 没有强制路线 — 备选: admin.js 深拆 workflow-start 共享渲染层 / 微信小程序 / 其他原生入口 |

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
| 历史外部审计 | `audits/<date>-<auditor>/` (按时间归档, `audits/README.md` 是索引) |

---

## 六、目录结构速查

```
packages/                       27 个包, pnpm workspace
├── protocol/                   wire protocol(v1.2) + wire types, zero runtime
├── core/                       Hub, Scheduler, Storage, Participant (依赖 protocol)
├── transport-ws/               WebSocket transport + HubLink (federation)
├── sdk-node/                   Node 客户端 SDK
├── identity/                   v4 — users/credentials/sessions/vault/quota/peers/im_bindings/suspended_tasks
├── host/                       生产 host 二进制 (main.ts)
│   └── src/
│       ├── local-agent-pool.ts        host-managed agents
│       ├── org-api-pool.ts            per-org LLM key cache
│       ├── peer-registry.ts           federation peer 拓扑
│       └── ...
├── web/                        admin UI HTTP + SSE + SPA
├── llm/                        LlmAgent + LlmProvider 抽象 + DispatchToolset + ComposedToolset
├── llm-anthropic/              Anthropic provider (streaming + tool use + vision)
├── llm-openai/                 OpenAI / DeepSeek / Qwen / Ollama (compat, streaming + tool use)
├── workflow/                   YAML workflow runner — parseWorkflow / WorkflowRunner / RunStore / predicate / resolver, 零 LLM dep
├── workflow-assistant/         Phase 13: WorkflowAssistantAgent (自然语言 → YAML, draftStatus), 依赖 workflow + llm
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

python-sdk/                     PyPI `aipehub`
templates/                      agents / teams / workflows / bundles / community
examples/                       22 个端到端 demo (含 Phase 13 M5 workflow-assistant)
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
