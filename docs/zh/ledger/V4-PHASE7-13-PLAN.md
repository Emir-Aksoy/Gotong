# AipeHub v4 Phase 7-13 开发规划

> 把 `CLAUDE.md` 第三节"微偏 + 缺失"的全部待补项展开成可执行 milestone。
> 每个 Phase 拆 M1/M2/M3..., 每个 M 对应一个本地 commit, 单独可测。
>
> Last updated: 2026-05-26
> Status: 规划已定, 待开工

---

## 一、总览 + 执行顺序

按"贡献度 × 紧迫度"排, 用户已确认按此顺序执行:

| Phase | 主题 | 预估 | 累计 |
|---|---|---|---|
| **7** | Phase 6 收尾 + 个人模式 first-class (北极星修正) | 1-2 周 | 1-2 周 |
| **8** | LLM streaming 全链路 (破坏性: 删 complete) | 1 周 | 2-3 周 |
| **9** | 多模态 content blocks (image / audio / file) | 1 周 | 3-4 周 |
| **10** | Agent → 子 agent 派发 (dispatch toolset) | 4-5 天 | 4-5 周 |
| **11** | Long-running agent (suspend/resume) | 4-5 天 | 5-6 周 |
| **12** | 协议外通路 (IM bridges + PWA + REPL) | 2-3 周 | 7-9 周 |
| **13** | AI 辅助 workflow 编辑器 | 1-2 周 | 8-11 周 |

**总计**: 约 2-3 个月。按"代码尽量简化"原则估, 实际可能更快。

**关键决策(用户已拍板)**:
- **Streaming 兼容**: 直接全部改 stream, `LlmProvider.complete` 删除。无上线压力, 不留双轨
- **Long-running**: 走 Suspend/Resume 范式 (`agent.suspend(resumeAt, state)`)
- **IM 平台**: Telegram + Matrix + 飞书 + Discord + Slack + QQ (按推荐优先级)

---

## 二、Phase 7 — 北极星修正

**目标**: 把"人 ↔ 自己 AI"从隐藏路径升一等公民。

### M1 — 清 Phase 6 P2 backlog (#148-#152)
半小时活, 5 项独立小修:
- #148: invitations cap 用 `AUDIT_ACTIONS.INVITE_CREATE_BLOCKED` 常量
- #149: `inboundRateLimit` 加 `AIPE_PEER_INBOUND_RATE_*` 环境变量
- #150: `reputation-ui.js` NaN 防御 (`Number.isFinite(r.score) ? r.score.toFixed(3) : '—'`)
- #151: `OrgApiPool.makeLlmQuotaGate` 拒绝时写 `API_QUOTA_DENIED` audit
- #152: reputation sort 加 `(a, b) => (Number.isFinite(b.score) ? b.score : -Infinity) - ...`

→ commit: `fix: Phase 6 P2 audit batch (#148-#152)`

### M2 — 清 Phase 6 P3 backlog (#153-#157)
1-2 天:
- #153: invitations cap tx 升 IMMEDIATE
- #154: `peerTokenResolver` 空串 / throw 路径加 warn log
- #155: 提取 `@aipehub/core` 共享 `PeerReputationSnapshot` 类型, web 导入
- #156: `IdentitySurface.countActivePendingInvitations()` 暴露给 UI
- #157: 并发 401 dedup — `Set<vaultEntryId>` 5s 窗口

→ commit: `fix: Phase 6 P3 audit batch (#153-#157)`

### M3 — `personal-hub` 模式设计 (RFC 阶段)
写 `docs/zh/PERSONAL-HUB-RFC.md`, 决定:
- bootstrap option: `--mode personal` vs auto-detect (建议 auto: 检测到 `users.count === 1 && memberships.count === 1` 时进 personal)
- 角色简化: personal mode 下 owner === member === 所有角色, UI 不显示 role chip
- invitation: personal mode 下隐藏邀请 UI 但 API 仍可用 (升级到团队模式只需邀请第一个人)
- peer: 个人 hub 默认不开 peer (但保留能力, 让"个人 ↔ 朋友的个人 hub"成可能)

→ commit: `docs: personal-hub RFC (Phase 7 M3)`

### M4 — `personal-hub` bootstrap 实现
- `@aipehub/identity`: bootstrap 加 `mode: 'personal' | 'team'` (默认 'team' 兼容)
- `personal` mode 自动创单 user + 单 member + role='owner', skip wizard
- `@aipehub/host` main.ts: env `AIPE_MODE=personal` 触发
- 单测: bootstrap 两种 mode 都走通

→ commit: `feat(identity,host): personal-hub bootstrap mode (Phase 7 M4)`

### M5 — SPA 首屏分流: 个人 AI 桌面 vs admin 控制台
- web UI shell 加 mode 检测 `GET /api/me/mode`
- personal mode: 首屏渲染"我的 AI 桌面" — 左边对话框, 右边 transcript + workflow 快捷启动卡
- team mode: 保持现 admin 控制台 (tabs: workflow / agents / users / quota / peers)
- 个人模式隐藏: users tab, peers tab (默认), 邀请管理
- 个人模式保留 advanced 模式入口 ("升级到团队" → 进 team mode)

→ commit: `feat(web): personal-mode SPA shell (Phase 7 M5)`

### M6 — README + docs 更新
- README quick-start 加段「30 秒个人模式」: 一条 `docker run -e AIPE_MODE=personal ...` 或 `pnpm host:personal`
- 新 `docs/zh/PERSONAL-MODE.md`: 5 分钟从空 docker 到第一次对话
- `docs/OVERVIEW.md` 三层链接图加"个人模式" 入口节点

→ commit: `docs: personal-hub quickstart (Phase 7 M6)`

### M7 — 全量测试 + Phase 7 收尾
- pnpm -r build && pnpm -r test 全绿
- 手动 smoke: docker run personal mode → 第一次对话 → workflow → 升级到团队 → 邀请第二个用户
- 写 `docs/zh/ledger/V4-PHASE7-FINAL.md`

→ commit: `docs: V4 Phase 7 release notes (Phase 7 M7)`

---

## 三、Phase 8 — LLM streaming 全链路 (破坏性)

**目标**: 所有 LLM 调用流式输出, admin UI 看 agent 实时思考。
**破坏性**: `LlmProvider.complete` 删除, 全部走 `stream`。所有 provider / workflow / agent / 测试要改。

### M1 — `LlmProvider.stream` 接口设计 (RFC + types)
```ts
interface LlmStreamChunk {
  type: 'text' | 'tool_use' | 'tool_use_delta' | 'usage' | 'end_turn' | 'error'
  text?: string                    // 增量 text
  toolUse?: LlmToolUseBlock        // tool 调用开始 (累计)
  usage?: { promptTokens: number; completionTokens: number }
  finishReason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence'
  error?: { code: string; message: string }
}

interface LlmProvider {
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamChunk>
  // 删除: complete(req): Promise<LlmResponse>
}
```
- 单测: mock provider 走 stream 形态

→ commit: `feat(llm): stream-only LlmProvider interface (Phase 8 M1)`

### M2 — Anthropic provider stream 实现
- 用 `@anthropic-ai/sdk` 的 `messages.stream()` API
- 翻译 SSE event → `LlmStreamChunk`
- AbortSignal 透传
- 集成测 (mock SDK)

→ commit: `feat(llm-anthropic): stream provider (Phase 8 M2)`

### M3 — OpenAI / DeepSeek / Qwen / Ollama provider stream
- 用 `chat.completions.create({ stream: true })`
- 4 个 baseURL 共享同一份实现
- 集成测

→ commit: `feat(llm-openai): stream provider (Phase 8 M3)`

### M4 — Mock provider stream + 测试基础设施
- 测试用 mock provider: 接受 `chunks: LlmStreamChunk[]` 配置
- 现有 76+ test 改为 stream 形态

→ commit: `test(llm): migrate to stream mock (Phase 8 M4)`

### M5 — LlmAgent 内部消费 stream + 对外仍返回 TaskResult
- LlmAgent 累计 chunks → final text/blocks → TaskResult
- tool-use loop 仍然多轮 stream 串起来
- preCallHook 不动 (执行在 stream 之前)
- 单测: 既测最终 result 正确, 也测 stream 中间事件被 emit 出去

→ commit: `feat(llm): LlmAgent stream consumer (Phase 8 M5)`

### M6 — Workflow runner 透传 stream → transcript
- 新 transcript 事件类型: `LLM_STREAM_CHUNK` (`{ taskId, agentId, chunk }`)
- workflow runner 订阅 LlmAgent 的 chunk 事件, 写入 transcript
- 配额 gate 仍然在 stream 启动前判定 (不变)

→ commit: `feat(workflow): stream chunks → transcript (Phase 8 M6)`

### M7 — Web SSE 透传 + admin UI 实时渲染
- `/api/stream` SSE 已存在, 加 `llm_stream_chunk` 事件类型
- admin UI: workflow detail 面板加"实时输出"区, typewriter 效果
- 移动端友好: chunk 间隔 ≥ 50ms 否则合并 (避免 SSE 风暴)

→ commit: `feat(web): live stream UI (Phase 8 M7)`

### M8 — 删 LlmProvider.complete + 全量验证
- 删 `complete` 方法签名 + 所有实现
- 全 pnpm -r test 跑通
- 端到端: 个人成长 workflow 跑一次, 7 个 agent stream 输出正常

→ commit: `refactor(llm): drop complete, stream-only (Phase 8 M8)`

---

## 四、Phase 9 — 多模态 content blocks

**目标**: image / audio / file 成 first-class LlmMessage.content。

### M1 — Content block 类型扩展
```ts
type LlmContentBlock =
  | LlmTextBlock              // 已有
  | LlmToolUseBlock           // 已有
  | LlmToolResultBlock        // 已有
  | LlmImageBlock             // 新: { type: 'image'; source: { kind: 'base64' | 'url' | 'artifact_ref'; ... } }
  | LlmAudioBlock             // 新: { type: 'audio'; source: ...; format: 'wav' | 'mp3' }
  | LlmFileRefBlock           // 新: { type: 'file_ref'; artifactId: string; mime: string }
```
- artifact_ref 走 `@aipehub/service-artifact-file` 已有体系

→ commit: `feat(llm): multimodal content blocks (Phase 9 M1)`

### M2 — Anthropic provider 翻译
- ImageBlock → Anthropic vision API (`type: 'image'`)
- AudioBlock: Anthropic 暂不支持音频 → 抛 `MultimodalNotSupportedError`
- FileRefBlock: 读 artifact → 转 image/text

→ commit: `feat(llm-anthropic): multimodal translate (Phase 9 M2)`

### M3 — OpenAI provider 翻译
- ImageBlock → GPT-4V `image_url` format
- AudioBlock → Whisper / GPT-4o audio API (按 model 路由)
- FileRefBlock: 同上

→ commit: `feat(llm-openai): multimodal translate (Phase 9 M3)`

### M4 — Workflow YAML 表单支持文件上传
- workflow form schema 加 `type: 'file'` 字段
- web UI 渲染文件上传 input → multipart POST → 落 artifact → 转 FileRefBlock

→ commit: `feat(workflow,web): file upload in workflow forms (Phase 9 M4)`

### M5 — Admin UI 多模态展示
- transcript 渲染 image (img 标签) / audio (audio 标签) / file ref (下载链接)
- 上传预览 + 大小限制 (默认 10MB / file, 可 env 配)

→ commit: `feat(web): multimodal transcript render (Phase 9 M5)`

### M6 — Examples + 测试 + Phase 9 收尾
- 新 example: `examples/multimodal-vision` (上传图片 → GPT-4V 描述 → 落 artifact)
- 全量 test 绿

→ commit: `docs: V4 Phase 9 release notes (Phase 9 M6)`

---

## 五、Phase 10 — Agent → 子 agent 派发

**目标**: 让 LlmAgent 通过 tool-use 调 capability/explicit dispatch, 主动 spawn 子任务。

### M1 — `LlmAgentToolset.dispatch` 设计
- 新 toolset (类似 McpToolset): `DispatchToolset.create({ hub, allowedCapabilities, allowedAgents })`
- 暴露 tool: `dispatch_task({ to: agentId | { capability }; payload; deadlineMs?; priority? })`
- tool result: `{ taskId; status: 'completed' | 'failed' | 'timeout'; data }`

→ commit: `feat(llm): DispatchToolset (Phase 10 M1)`

### M2 — 防递归 + cycle detection
- Task 加 `ancestry: string[]` (从根 task 到当前的 task id 链)
- 调度器拒收 ancestry 长度 > `MAX_DISPATCH_DEPTH` (默认 5) 的 dispatch
- agent 重复出现在 ancestry → 拒收 (避免 A → B → A 死循环)
- 测试: 故意构造 A→B→A→B → 第 3 跳被拒

→ commit: `feat(core): dispatch ancestry + cycle detection (Phase 10 M2)`

### M3 — 跨 hub dispatch 复用 D2 路径
- DispatchToolset 配置 `crossHub: { peer: 'widgets.local'; capability: '...' }`
- 走现有 D2 cross-hub HITL routing
- ancestry 跨 hub 透传

→ commit: `feat(llm,host): cross-hub dispatch toolset (Phase 10 M3)`

### M4 — Allow-list 配置 + 安全审计
- workflow YAML 加 `dispatch:` 字段声明 agent 能调谁
- vault audit: 每次 dispatch 写 `AGENT_DISPATCHED` audit row
- admin UI: 显示 task 的 ancestry chain (展开树)

→ commit: `feat(workflow,web): dispatch allow-list + audit (Phase 10 M4)`

### M5 — Example: architect-team workflow
- 1 个 architect agent (主) + writer + reviewer + tester (子)
- architect 看需求 → 自动 dispatch 给三个 sub-agent → 聚合 → 出最终 plan
- 落 example + docs

→ commit: `feat(examples): architect-team workflow (Phase 10 M5)`

### M6 — Phase 10 收尾
→ commit: `docs: V4 Phase 10 release notes`

---

## 六、Phase 11 — Long-running agent (Suspend/Resume)

**目标**: agent 可主动 `suspend(resumeAt, state)`, 调度器到点叫醒。

### M1 — Suspend/Resume API 设计
```ts
interface Participant {
  // ... 已有
  onResume?(state: unknown): Promise<TaskResult | { suspendAgain: { resumeAt: number; state: unknown } }>
}

// 在 onTask / onResume 里:
throw new SuspendTaskError({ resumeAt: Date.now() + 5*60_000, state: { step: 'waiting_for_api' } })
```
- `SuspendTaskError` 不是真错误, 是调度器的 control flow

→ commit: `feat(core): SuspendTaskError + Participant.onResume (Phase 11 M1)`

### M2 — 调度器持久化 suspended tasks
- 新表 `suspended_tasks(taskId PK, agentId, resumeAt, state JSON, createdAt)` in identity SQLite
- 调度器收到 SuspendTaskError → 写表 + 释放 worker slot
- Identity store API: `listDueSuspendedTasks(before)`, `removeSuspendedTask(taskId)`

→ commit: `feat(identity,core): suspended_tasks table + resume API (Phase 11 M2)`

### M3 — Resume 触发器
- 后台 sweep: `setInterval(() => resumeDueTasks(), 30_000)` (与 usage sweep 同一个调度器)
- 唤醒: 重新 dispatch 同 task 给同 agent, 调 `onResume(state)`
- transcript 写 `TASK_SUSPENDED` / `TASK_RESUMED` 事件

→ commit: `feat(host): suspended task sweep + resume (Phase 11 M3)`

### M4 — Working memory 自动 persist
- `LlmAgent.onTask` 默认把 messages 数组持久化到 service-memory-file (按 taskId)
- onResume 自动 reload, 续上下文
- agent 不需要手写

→ commit: `feat(llm): working memory auto-persist (Phase 11 M4)`

### M5 — Example: daily-digest agent
- agent 每天清晨 6 点跑, 拉一堆 RSS, 总结 → mail
- 用 suspend 实现"先吃 RSS → 等 LLM 配额 → 再 mail"
- 第二个 example: pause-on-budget — agent 跑到一半配额耗尽 → suspend 24 小时 → resume

→ commit: `feat(examples): long-running agent (Phase 11 M5)`

### M6 — Phase 11 收尾
→ commit: `docs: V4 Phase 11 release notes`

---

## 七、Phase 12 — 协议外通路

**目标**: 浏览器以外的人都能用上 AipeHub。

### Phase 12.A — IM Bridges (按优先级)

**平台优先级分析**:

| 平台 | 协议成熟度 | bot 易接入 | 联邦哲学契合度 | 用户群 | 优先级 |
|---|---|---|---|---|---|
| **Telegram** | 极简 HTTPS bot API | ★★★★★ | 中 | 全球, 程序员多 | **P0** |
| **Matrix** | 联邦协议 + matrix-bot-sdk | ★★★★ | **★★★★★ (同构!)** | 全球, 自托管圈 | **P0** |
| **飞书 (Lark)** | 官方 Open Platform | ★★★★ | 中 | 国内办公 | **P1** |
| **Discord** | 一等 bot API, discord.js | ★★★★★ | 中 | 全球开发者 | **P1** |
| **Slack** | 一等 bot API, @slack/bolt | ★★★★★ | 中 | 全球企业 | **P1** |
| **QQ** | OneBot v11 (go-cqhttp 等) | ★★ (有封号风险) | 低 | 国内大众 | **P2 实验** |

> **微信小程序**不在 IM bridge 里 — 它是 mini app, 更适合 Phase 12.B 的 PWA 类目, 推后。
> **WhatsApp Business** 需企业审核, 暂不做。

### M1 — `@aipehub/im-adapter` 基础包
- 抽象接口:
  ```ts
  interface ImBridge {
    start(): Promise<void>
    onMessage: (from: ImUser, text: string, attachments?: ImAttachment[]) => void
    sendMessage(to: ImUser, text: string, attachments?: ImAttachment[]): Promise<void>
    stop(): Promise<void>
  }
  interface ImUser { platform: string; platformUserId: string; displayName?: string }
  ```
- IM user → AipeHub user binding 表: `im_bindings(platform, platformUserId, userId, createdAt)`
- 绑定流程: IM 里发 `/bind <code>` → admin UI 出 code → IM bot 回复成功

→ commit: `feat: @aipehub/im-adapter base package (Phase 12 M1)`

### M2 — `@aipehub/im-telegram`
- Telegram bot webhook (or long-polling) → onMessage
- 命令: `/help`, `/bind`, `/workflow <name>`, `/agents`, free-text → dispatch 给 default agent
- 单文件 ~300 行

→ commit: `feat: @aipehub/im-telegram (Phase 12 M2)`

### M3 — `@aipehub/im-matrix`
- matrix-bot-sdk
- 房间 join + 消息收发
- 重点: Matrix 本身联邦, 一个 AipeHub hub 接一个 Matrix homeserver, "AipeHub federation × Matrix federation" 二重联邦
- docs 重点说这个哲学契合

→ commit: `feat: @aipehub/im-matrix (Phase 12 M3)`

### M4 — `@aipehub/im-lark` (飞书)
- 飞书 Open Platform Bot 接入
- 群机器人 + 单聊
- 国内场景: 企业内一个 AipeHub hub + 飞书群里 @机器人 触发 workflow

→ commit: `feat: @aipehub/im-lark (Phase 12 M4)`

### M5 — `@aipehub/im-discord`
- discord.js gateway 模式
- slash commands + free-text mention

→ commit: `feat: @aipehub/im-discord (Phase 12 M5)`

### M6 — `@aipehub/im-slack`
- @slack/bolt + Events API
- slash commands + mention

→ commit: `feat: @aipehub/im-slack (Phase 12 M6)`

### M7 — `@aipehub/im-qq` (实验性)
- OneBot v11 协议 + go-cqhttp 或 NapCat
- 标 "实验性 — 第三方协议, 有封号风险"
- 仅当 host env `AIPE_QQ_BRIDGE_ACK_RISK=true` 时启动

→ commit: `feat: @aipehub/im-qq (Phase 12 M7, experimental)`

### M8 — IM bridges 共用文档 + 一键 docker-compose
- `docs/zh/IM-BRIDGES.md` 总览, 每个平台 5 分钟接入指南
- `docker-compose.im.yml` 加 IM bridge sidecar 模式 example

→ commit: `docs: IM bridges quickstart (Phase 12 M8)`

### Phase 12.B — PWA + Mobile

### M9 — 响应式审计
- 现 admin UI / 个人桌面 UI 在 320-768px 屏幕的可用性扫描
- 修每个 broken tab / button / table

→ commit: `feat(web): mobile responsive audit (Phase 12 M9)`

### M10 — PWA manifest + Service Worker
- `manifest.json` + 图标 + theme color
- Service Worker: cache shell + transcript offline 浏览
- "添加到主屏幕"

→ commit: `feat(web): PWA support (Phase 12 M10)`

### M11 — 移动端 simplified shell
- 移动端首屏只显示"对话框 + workflow 卡片", 高级功能藏进侧滑
- 触控友好 (大按钮, 防误触)

→ commit: `feat(web): mobile shell (Phase 12 M11)`

### Phase 12.C — 交互式 CLI REPL

### M12 — `@aipehub/cli` REPL 模式
- 现 cli 只有脚本子命令, 加 `aipehub repl` 进入对话模式
- 类似 ChatGPT CLI: 输入 → stream 输出
- 命令: `:agents`, `:workflow <name>`, `:exit`

→ commit: `feat(cli): REPL mode (Phase 12 M12)`

### M13 — Phase 12 收尾 + 全量验证
→ commit: `docs: V4 Phase 12 release notes`

---

## 八、Phase 13 — AI 辅助 workflow 编辑器

**目标**: 用户用自然语言描述需求 → LLM 生成 workflow YAML。

### M1 — Workflow YAML JSON Schema
- 从现 6 个 templates 反推 JSON Schema
- 校验器: 一个 YAML 进, 报错或 pass

→ commit: `feat(workflow): YAML JSON schema validator (Phase 13 M1)`

### M2 — 自然语言 → YAML 提示词
- few-shot prompt: 几个真实模板 + 用户描述 → YAML
- 兜底: 校验失败 → LLM 自我修正一次

→ commit: `feat(workflow): NL → YAML prompt (Phase 13 M2)`

### M3 — Admin UI 编辑器
- workflow tab 加"AI 助手"按钮
- 弹对话框: 输入需求 → 生成 → 预览 (代码高亮) → 编辑 → 保存
- 走 OrgApiPool, 计入配额

→ commit: `feat(web): workflow AI editor (Phase 13 M3)`

### M4 — 评估器
- 复用 `@aipehub/evals` 包做生成结果的结构性验证
- 不光 schema 合法, 还要 "agent 引用都存在", "dispatch 链不死循环" 等

→ commit: `feat(workflow,evals): generated workflow checker (Phase 13 M4)`

### M5 — Examples + docs + Phase 13 收尾
- example: "我想要一个 5 步的代码 review workflow" → 生成 → 跑通
- `docs/zh/AI-WORKFLOW-EDITOR.md`

→ commit: `docs: V4 Phase 13 release notes`

---

## 九、贯穿整个规划的工作守则

照搬 `CLAUDE.md` §4.1, 提醒自己:

- ~~**GitHub 上传暂停**: 所有 commit 堆本地, 不 push~~ (已失效: push 2026-06-16 解冻、repo 2026-06-28 公开; 现纪律=只推 main/fast-forward/绝不强推)
- **不动备份**: `~/Backups/AipeHub/` 只读
- **不向前兼容**: Phase 8 删 `complete`, Phase 9 widen content blocks, 都是破坏性的, 不留 shim
- **一个 task 一个 task**: 每个 M 一个 commit, 不要打包提交
- **Auto Mode**: 不清楚的默认选项写 inline 注释 + 继续推进
- **每个 Phase 收尾必做**: `pnpm -r build && pnpm -r test` 全绿 + 写一段 `V4-PHASE<N>-FINAL.md`

---

## 十、什么时候停下来重新评估

下面 4 个信号触发"暂停规划, 找用户重审":
1. 某个 Phase 实际耗时超估的 2 倍 → 看是不是低估了复杂度
2. 用户开新优先级("我想先做 X") → 切, 别死磕规划
3. 上线节奏需要 (开始有真实用户) → P1/P2 audit 强化 + 文档完善 优先于新 feature
4. AI 生态出现新协议 / 新范式 (e.g. 一个新的 Agent Protocol 标准) → 评估是否要拥抱

---

## 十一、附: 备选项 (暂不进 Phase 7-13, 留作未来)

| 项目 | 不进规划的原因 |
|---|---|
| RAG default MCP server 推荐 | B3/B4 已决议外挂; 等社区 MCP server 数量起来再加推荐列表 |
| 微信小程序 | 走腾讯审核成本太高, 推迟到 IM bridges 全部稳定后 |
| WhatsApp Business 接入 | 需企业审核 + 月费; 等社区有需求 |
| mTLS / PKI peer auth | v4 Phase 4 决议: 等真规模再上; peerToken 够用到 100 hubs 级 |
| K8s operator / Helm chart | 现 docker-compose 够用; SaaS 化前不做 |
| 内置 vector DB | 一样走外部 MCP server 哲学; 不内置 |
| 自托管 LLM 模型推理 (除 Ollama compat) | 不是核心边界; Ollama compat 已经支持本地 llama / qwen |
