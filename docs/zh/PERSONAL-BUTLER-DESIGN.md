# 个人 Hub 管家 (Personal Butler) — 设计文档

> 把现有 `HubStewardAgent` 升级成「**可快速投入工作、类似 OpenClaw / Hermes 的常驻个人管家**」:
> 记忆 + 会话上下文引擎 + 良性灵活调用 + 治理动作审批,落在 AipeHub 北极星上。
>
> 本文是**建之前**的设计文档(对标 OpenClaw / Hermes 源码)。一里程碑一小 commit,
> 每个里程碑带验收门。
>
> **状态:M1–M6 全完。** 收口见 [`docs/zh/ledger/PERSONAL-BUTLER-FINAL.md`](./ledger/PERSONAL-BUTLER-FINAL.md)
> (commit / 数据流 / §七 验收门结果 / 测试矩阵 / 显式推迟)。
>
> Last updated: 2026-06-29 · 状态:M1–M6 全完(收口已写)

---

## 一句话

我们已经有一个管家(`HubStewardAgent`,Stream SW),但它是**单发结构化提议、无记忆、无服务端会话**的「设置管理器」。本设计把它升级成一个**常驻个人管家**:它**记得你**(跨会话)、能**灵活替你调用**(查记忆 / 起工作流 / 派子 agent / 查 MCP)、把对话**管起来**(捕获 / 压缩 / 注入),而所有**敏感动作仍走人审批**——这一条是我们相对 OpenClaw 的护城河,不是要补的缺口。

**它和现在的工作流不是二选一**:工作流是声明式后端(可治理 / 可版本化),管家是对话式前门。管家能起 / 看工作流(`workflow-start` 当工具),工作流也能派活给管家。两者并存,都是一等公民。

## 北极星对齐

- **框架不跑 LLM**:管家是一个 `Participant`(`LlmAgent` 子类),决策在它(模型)手里;Hub 只路由 / 记 transcript。记忆是**文件**(`.aipehub/` 里看得见,复制目录=搬走管家的「大脑」),不是云端黑盒。
- **人和 agent 是同一个 Participant**:敏感动作不是「管家自己干」,而是**派一个 Task 给代表你收件箱的 Participant**,你在 `/me` 拍板后再恢复(复用 Phase 16)。
- **状态即文件**:episodic 原始记忆 = jsonl;semantic 策展 profile = 可读 markdown 风格;会话 = transcript。全在磁盘。
- **不学的那一半**:OpenClaw / Hermes 是**无界、无门控、宿主机自治**的 tool-loop(OpenClaw 469 个安全 issue + ClawHavoc 供应链攻击的根)。我们做**有界 + 敏感动作门控**的 tool-loop——见决策 D2 / D8。

---

## 一、缺口(代码依据)

现有 `HubStewardAgent`(`packages/hub-steward/src/`)实测三点:

1. **无记忆**:整包 `grep services.memory` = 零命中。管家不记得你上次说过什么。
2. **会话靠客户端**:`agent.ts:103` 的 `history` 是 **SPA 每次重传**的(`ChatPort` payload),无服务端 session、无压缩。换个端(IM ↔ /me)对话就断。
3. **故意不灵活调用**:`agent.ts:7` 注释明写「does NOT run a tool loop — mirroring `WorkflowAssistantAgent`(emit structured output),not `DispatchToolset`(drive tools)」。它只能在闭集动作里提议(`inspect / create_agent / edit_agent / delete_agent / edit_workflow / refuse`),不能「去叫研究 agent 把我的笔记总结一下放进收件箱」。

把用户的三分法(记忆 / 灵活调用 / 会话管理)对到代码上,结论:

| 缺口 | 代码现状 | 性质 |
|---|---|---|
| 记忆 | 零 `services.memory` | **真缺**,大头 |
| 会话管理 | 客户端 `history` 重传,无服务端 session / 压缩 | 真缺,但**和记忆共用机器**(捕获 / 压缩 / 注入) |
| 灵活调用 | 故意单发结构化提议(`agent.ts:7`) | **一半是 feature**:框架早有 `DispatchToolset`/`ComposedToolset`/`runToolLoop`/MCP,只差接线 + 良性 vs 治理分流 |

净:三缺口塌缩成 **(A) 记忆 / 会话上下文引擎(真活)+ (B) 良性灵活调用接线(小)+ (C) 治理动作路径(已有)**。

---

## 二、参考实现对标(OpenClaw + Hermes 源码)

源码级调研结论(完整见会话记录)。两家的记忆**都是文件优先的策展 markdown,向量只是可选插件**——这恰好是我们的北极星,不是要追的新范式。

### OpenClaw(`github.com/openclaw/openclaw`,TS,MIT)
- **记忆**:`MEMORY.md`(持久事实)+ `memory/YYYY-MM-DD.md`(每日笔记)+ 可选 `DREAMS.md`(consolidation 日志);会话 = JSONL;向量(LanceDB)是**插件**。捕获=模型自决 + **「压缩前静默轮自动存」**。召回=会话起把 `MEMORY.md`+近期笔记**整块注入** system prompt(超预算截断注入副本=提示蒸馏)。蒸馏=agent 把每日笔记 distill 进 `MEMORY.md` + 可选「Dreaming」cron consolidation。
- **执行**:heartbeat 默认 **30 分钟**读 `HEARTBEAT.md` 跑到期任务、回 `HEARTBEAT_OK`,空闲便宜跳过 + 成本旋钮(lightContext / isolatedSession)。Gateway daemon **在进程内跑工具,主会话默认无隔离**(已知大坑)。
- 源:[`docs/concepts/memory.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory.md) · [`docs/gateway/heartbeat.md`](https://github.com/openclaw/openclaw/blob/main/docs/gateway/heartbeat.md)

### Hermes Agent(`github.com/NousResearch/hermes-agent`,Python,MIT)
- **记忆**:`MEMORY.md`(2200 字硬上限)+ `USER.md`(1375 字)策展 markdown;会话 SQLite + **FTS5**;8 个外部记忆插件 behind ABC。捕获=`memory` 工具(add/replace/remove)+ **会后自我复盘**。注入=会话起**冻结整块、中途不刷**(护前缀缓存)。蒸馏=**写超限直接报错逼 agent 当轮蒸馏**(`gateway/memory_monitor.py`)。
- **执行**:`run_agent.py`(~5.65 KLOC)`while api_call_count < max && budget: create→handle tool_calls→loop`。**可插拔沙箱后端**(local PTY / docker / ssh / modal)+ 委派子代理(并发 3 / 深度 2)+ 两套 SQLite 持久任务(cron + kanban,带 `.tick.lock` 跨进程锁 / 硬中断 / 失效认领回收)。所谓「heartbeat」其实是 cron blueprint。
- 源:[`website/docs/user-guide/features/memory.md`](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md) · [`AGENTS.md`](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)

### 「OpenClaw / Hermes 水平」= parity 标准(6 条)

1. **文件优先可读记忆**(策展 `MEMORY.md`/`USER.md`/每日笔记)+ 独立会话检索(FTS/JSONL);向量是可选层非地板。
2. **模型自决捕获 + 自动安全网**(压缩前存 / 会后复盘),记忆无需用户手动维护就累积。
3. **有界 + 强制蒸馏**(硬上限报错逼蒸 / bootstrap 预算截断注入副本),会话起**冻结块护前缀缓存**注入。
4. **真主动节奏**(定时醒读待办、空闲便宜跳过、成本旋钮)。
5. **跨重启持久定时 / 长任务**(SQLite 撑),且诚实标注 in-proc spawn 不持久。
6. **真工具执行 + 隔离故事**(工具注册表 + 可插拔后端 + 委派子代理 + 深度 / 并发上限)。

### 该借 / 不借 / 反着学

| | 内容 |
|---|---|
| **借设计**(最贵的部分) | 文件优先策展 markdown / 「存了再压」安全网 / 写超限报错逼蒸馏 / **冻结块护前缀缓存注入** / heartbeat 维护循环 |
| **不借代码** | 不同栈(Hermes Python+SQLite cron/kanban;OpenClaw TS 网关 in-process)跟我们 dumb-hub + participant + services 插件架构对不上,硬移植打架 |
| **反着学** | 它们是**无界 + 无门控 + 宿主机自治** tool-loop。灵活调用学它们的「工具注册表 / 委派子代理(深度·并发上限)」机制,**绝不**学「在宿主机无沙箱自治」——那正是它们 469 安全 issue 的根,也是我们的护城河 |

---

## 三、AipeHub 现有底座(~70% 已在)

| parity 标准 | AipeHub 已有的对应物 | 判定 |
|---|---|---|
| ① 文件优先记忆 | `@aipehub/memory-file`(jsonl,episodic/semantic kinds,per-owner,`remember/recall/list/forget`)+ transcript;`this.services.memory` 已挂每个 agent(`agent.ts:260`) | 半(缺策展 profile 层 + 冻结注入) |
| ② 模型自决捕获 + 安全网 | services.memory 句柄在,但未暴露成 LLM 工具、无自动捕获 | 缺(hook 点在:turn-end / heartbeat) |
| ③ 有界 + 强制蒸馏 + 冻结注入 | `handle.ts:196` byte-cap 砍旧的一半(非蒸馏);`personal-growth-context.ts` 有 `COMPACT_TRIGGER` 触发器模式 | 缺(有可泛化的触发器) |
| ④ 真主动节奏 | **Stream D heartbeat**(`HeartbeatParticipant`,per-agent interval,`HEARTBEAT_OK` 抑制,checklist) | ✅ 近 1:1 |
| ⑤ 跨重启持久任务 | **Phase 11** `SuspendTaskError` + `suspended_tasks` SQLite + resume sweep;诚实标注 A2A in-mem 不持久 | ✅ 已达(个人范围;kanban 级超范围) |
| ⑥ 真执行 + 隔离 + 子代理 | **ACP/CLI adapter** 驱动真 Claude Code/Codex + `DispatchToolset`(深度 5 / 环路 / allow-list 闸)+ `dangerousCommandGate` | ✅ 达 OpenClaw(其默认更差)/ 略低 Hermes(缺可插拔 Docker 后端,见推迟) |

**6 条里 4 条已达或超过。** 真活集中在 ①②③ = 记忆 / 会话引擎。

---

## 四、关键设计决策

- **D1 — 管家=现有 steward 的超集,不另起炉灶。** 治理动作路径(`classify.ts` 四级分级 + `HostStewardService` propose→apply + `StewardApprovalBroker` 收件箱审批)整片复用,只在外面包记忆 + 良性 tool-loop。
- **D2 — 一条有界 tool-loop,敏感工具审批门控(不是两套引擎)。** 良性工具(`recall` / `dispatch` / `workflow-start` / `mcp-query`)直跑;敏感工具(改 hub / 花钱 / 对外发 / 删)是**审批门控的工具**——调用即 `SuspendTaskError(NEVER_RESUME_AT)`→`/me` 收件箱→批准才执行。这**复用 ACP-HITL `dangerousToolGate` + `StewardApprovalBroker` 的现成模式**,把「两条路」统一成「一条 loop,危险工具挂起等人」。
- **D3 — 记忆=文件优先策展。** episodic = `memory-file` jsonl 原始捕获;semantic = LLM 蒸馏出的**可读策展 profile**(`MEMORY.md`/`USER.md` 风格,落进 `memory-file` 的 `semantic` kind 或并列 markdown)。向量是**可选层**,走现成 `chroma-mcp`,不进框架(北极星:框架不存知识)。
- **D4 — 会话管理与记忆共用机器。** 「会话管理」不是独立模块:会话起注入(M1)、turn-end 捕获(M2)、超阈值蒸馏(M3)就是会话上下文管理。服务端 `MemorySession`(per-(user,butler))取代客户端 `history` 重传。
- **D5 — 捕获触发点=turn-end + heartbeat(诚实)。** AipeHub 的 `LlmAgent` **没有** context 自动压缩事件(`agent.ts` 的 truncate 只是 log dump),所以学不了 OpenClaw 的「save-before-compact 静默轮」。我们的捕获=**turn 结束** + **heartbeat 复盘**——等价且更干净(不在热路径上烧 token)。
- **D6 — 注入=冻结块护前缀缓存。** profile + 近期 episodic 渲染成**稳定位置、每会话算一次**的块注入 `req.system`(`agent.ts:522`),中途不刷——抄 Hermes 的前缀缓存纪律(最不显而易见、最值得抄的一条)。
- **D7 — 快速投入 = example-first 模板 + 默认开 + 5 分钟。** 对齐北极星第 1 层「5 分钟跑起来,不写代码」。`examples/personal-butler` 一键 import(管家 + 默认 heartbeat + 记忆开 + IM 接线),不 fold 进 host main.ts(沿全项目 example-first 先例)。
- **D8 — 反北极星的不做。** 无界 loop(必须 `maxTurns` 有界)、无门控敏感动作(必须过 D2 门)、宿主机无沙箱自治(执行走已带闸的 ACP/CLI,不裸 spawn)。

---

## 五、架构

### 一次管家 turn 的数据流

```
你(IM / /me / admin)说一句话
   │
   ▼
PersonalButlerAgent.buildRequest
   │  ① 载入 MemorySession:semantic profile + 近期 episodic
   │     → 渲染成【冻结块】注入 req.system(每会话算一次,护缓存)  ← M1 / D6
   ▼
runToolLoop(有界 maxTurns)                                        ← M4 / D2
   │
   ├─ 良性工具直跑:recall / dispatch(子 agent)/ workflow-start / mcp-query
   │     └─ 结果喂回 loop
   │
   └─ 敏感工具(改 hub / 花钱 / 对外发 / 删)
         └─ classify=dangerous/cross_hub/sensitive
              → SuspendTaskError(NEVER_RESUME_AT)→ /me 收件箱      ← 复用 Phase16 / ACP-HITL
                 → 你批准 → 执行 / 拒绝 → fail-closed
   │
   ▼
turn 结束:summarize 这轮 → remember(episodic)                    ← M2 / D5
   │
   ▼ (异步,heartbeat tick)
MemoryReviewParticipant:蒸馏近段 episodic → semantic profile      ← M3 / D5
   超阈值 → 强制蒸馏(写超限报错逼再蒸,Hermes 模式)
```

### 复用 vs 新建

| 层 | 复用(已有) | 新建 |
|---|---|---|
| 记忆存储 | `@aipehub/memory-file`(jsonl + recall + byte-cap) | `MemorySession` / `renderFrozenBlock` / `consolidate()` |
| 记忆工具 | `this.services.memory` 句柄 | `MemoryToolset`(remember/recall/forget 当 LLM 工具) |
| 灵活调用 | `DispatchToolset` / `ComposedToolset` / `runToolLoop` / MCP client / workflow-start 路由 | 接线进 butler + `maxTurns` 有界 |
| 治理动作 | `hub-steward` classify + `HostStewardService` + `StewardApprovalBroker` | `GovernedActionToolset`(包成审批门控工具) |
| 主动节奏 | Stream D `HeartbeatParticipant` | `MemoryReviewParticipant`(heartbeat 蒸馏) |
| 持久 | Phase 11 suspend/resume + `suspended_tasks` | — |
| 治理 / PII | identity vault(`ownerKind='user'`)/ inbox / `/me` | per-user 记忆命名空间 + forget/导出 + 隐私视图 |

### 包结构(提案)

- **`@aipehub/personal-memory`**(新叶包,依赖 core + services-sdk + llm):`MemorySession` / `MemoryToolset` / `renderFrozenBlock` / `consolidate` / `MemoryReviewParticipant`。可被任意 `LlmAgent` 复用,不只管家。
- **`PersonalButlerAgent`**(`extends LlmAgent`):组合 `personal-memory`(上下文)+ 良性 `ComposedToolset` + `GovernedActionToolset`(包 hub-steward)。落在 host 或新 `@aipehub/personal-butler`,待 M1 实现时定。
- **`examples/personal-butler`**:turnkey 模板。

---

## 六、里程碑(M1–M6) — ✅ 全完

> 收口表(commit / 产物)见 [`PERSONAL-BUTLER-FINAL.md` §三](./ledger/PERSONAL-BUTLER-FINAL.md)。
> M1 `5cc0d96` · M2 `c60a0f7` · M3 `d9a1189` · M4 `c13dab2` · M5 `d7649cd` ·
> M6a `32b2556` · M6b `5e7ead1` · M6c `55c7ad4` · M6d `3b1be73` · M6e 本提交。

| M | 做什么 | 复用 | 新建 | 估时 |
|---|---|---|---|---|
| **M1** | 记忆增强 agent:冻结块注入 + `remember/recall/forget` 当 LLM 工具 | `services.memory`,`LlmAgent.buildRequest`/`runToolLoop`,`ComposedToolset` | `MemorySession` + `renderFrozenBlock`(稳定/护缓存)+ `MemoryToolset` | 3–4d |
| **M2** | 自动捕获:turn-end summarize→episodic + heartbeat 复盘 | Stream D,transcript,turn-end | `MemoryReviewParticipant` + capture pass(诚实:无 save-before-compact) | 3–4d |
| **M3** | 强制蒸馏:episodic→semantic 策展 profile,超阈值报错逼蒸,替掉 byte-cap 砍半 | 泛化 `personal-growth` `COMPACT_TRIGGER`,LLM provider | `consolidate()` + 策展 profile 渲染 | 3–4d |
| **M4** | 灵活调用接线 + 治理统一 + 检索后端 | `DispatchToolset`(闸已有)/`ComposedToolset`/workflow-start/MCP/`chroma-mcp`,hub-steward `classify`+`StewardApprovalBroker` | butler 有界 tool-loop + `GovernedActionToolset`(敏感→审批门控)+ 可换 `MemoryRetriever` | 4–5d |
| **M5** | 快速投入:`examples/personal-butler` 模板 + admin 开关 + `/me`「它记得你什么」隐私视图 | 模板系统,/me SPA,admin | 模板 + 防腐门 + 隐私视图(读 profile/episodic,forget/导出) | 4–5d |
| **M6** | 治理 + E2E 收口 | identity vault,steward/inbox 审批,验收门规格 | per-user 记忆命名空间 + 被遗忘权 + 敏感记忆写人在环 + 全链 E2E | 3–4d |

**总量 ≈ 20–25 工作日 ≈ 4–5 周(单人)。** 新活集中在 M1–M3(记忆 / 会话引擎);M4 大半是接线 + 治理统一;M5/M6 是 turnkey + 治理收口。

---

## 七、验收门(E2E 承重测试) — ✅ 4 claims 全过

> 结果详见 [`PERSONAL-BUTLER-FINAL.md` §五](./ledger/PERSONAL-BUTLER-FINAL.md)。

`packages/host/tests/personal-butler-e2e.test.ts`——真 Hub + 真 IdentityStore + 真 `FileInboxStore` + 真 `memory-file` + 真 `PersonalButlerAgent`(mock LLM 确定性按指令分支,不烧 key),一个测证清:

1. **跨会话记忆**:会话1「记住我叫阿明,在做奶茶店项目」→ capture episodic;heartbeat tick → consolidate → semantic profile 含「阿明 / 奶茶店项目」;会话2(新 task,同 user)「我之前那个项目叫啥?」→ 召回 → 答含「奶茶店」。
2. **良性灵活调用**:「帮我起 cafe-staff-onboarding 工作流」→ `workflow-start` 工具 → **不挂起**跑通。
3. **敏感动作门控**:「把 mailer agent 删了」→ classify=dangerous → **suspend → `/me` 收件箱** → 批准→真删 / 拒绝→**fail-closed mailer 仍在**。
4. **no-leak**:另一个 user 的管家**召回不到**阿明的记忆(per-user 命名空间隔离)。

通过 = 「记忆 + 灵活调用 + 会话 + 治理」四件一次成立,且 PII 不跨 user 泄漏。

---

## 八、快速投入(turnkey)

「类似 OpenClaw、可快速投入」= 北极星第 1 层「5 分钟跑起来,不写代码」。M5 交付:

- **`examples/personal-butler` 模板**(`aipehub.template/v1`):管家 agent(默认 DeepSeek / 可换)+ `heartbeat`(默认开,间隔可调)+ 记忆开(默认 caps)+ KB 槽位(可选,presetData 指针)+ `apiKeyPrompt`。一键 `POST /templates/import` 即跑。
- **admin 开关**:记忆 on/off、caps、kinds、heartbeat 间隔——改配置即时生效(复用 `reconcileHeartbeats`)。
- **`/me`「它记得你什么」隐私视图**:读 semantic profile + 近期 episodic,`forget` 单条、导出全部(被遗忘权,前置到 UI 让用户安心)。
- **IM 接入**:管家走现有 6 桥(官方化完),IM 里直接聊;敏感动作的审批落 `/me` 收件箱(跨端深链)。

诚实边界:模板带管家 + heartbeat + 记忆**接线**,知识**内容**不入模板(Stream B 决策 #4);确定性闸参与者 / 记忆引擎是 example 运行时接线代码,fold 进 host main.ts 显式推迟(同 family-learning-hub 先例)。

---

## 九、测试矩阵(预计)

| 包 | 测试 |
|---|---|
| `personal-memory` | `MemorySession` / `renderFrozenBlock`(同会话两轮字节相同=护缓存)/ `MemoryToolset` 往返 / `consolidate` 蒸馏 + prune / `MemoryReviewParticipant` heartbeat 蒸馏 |
| `personal-butler`(或 host) | 有界 loop 良性工具直跑 / `GovernedActionToolset` 敏感→挂起 / classify 分流 |
| host | `personal-butler-e2e.test.ts`(§七 承重门)|
| web | 模板防腐门(过真 `parseTemplate`+import 落 butler agent)/ `/me` 隐私视图路由 |

---

## 十、显式推迟 / 风险

**推迟(不进基础估)**:
- **可插拔 Docker/SSH/Modal 沙箱终端后端**(Hermes 天花板)——我们带闸的 CLI/ACP 已超 OpenClaw 裸跑默认;真要执行隔离对齐 Hermes,单列 **+1–1.5 周**。
- **kanban 级任务板编排**(Hermes)——超「个人记忆 + 执行」范围,我们已有 suspend/resume 持久底座。
- **向量 / 图记忆当默认**——默认子串+时近 + 可选 chroma-mcp 足够;真要默认语义检索再评估。
- **fold 进 host main.ts 当一等公民**——example-first 先,稳定后再收。
- **管家主动发起对话**(heartbeat 主动找你而非只维护记忆)——独立决策,本设计 heartbeat 只做记忆维护 + 到期提醒。

**风险 / 假设**:
- 估时假设单人专注、复用现有底座;M5(turnkey UX)历来易膨胀,留 buffer。
- 「冻结块护缓存」依赖 provider 的前缀缓存语义(Anthropic / DeepSeek 有);M1 把它当**正确性约束**(注入块同会话稳定),缓存命中是收益不是前提。
- `consolidate()` 的蒸馏质量依赖 LLM;mock demo 钉机制,真质量 opt-in 真 key 验。

---

## 关联文档

- 竞争对标:`docs/zh/COMPETITIVE-LANDSCAPE.md` / `docs/zh/PRODUCT-MATRIX.md`(OpenClaw / Hermes / QwenPaw)
- 现有管家:`docs/zh/ledger/V5-STEWARD-FINAL.md`(`HubStewardAgent` + 四级分级 + 收件箱审批)
- 主动节奏:Stream D heartbeat(`packages/host/src/heartbeat.ts`)
- 持久任务:Phase 11(`SuspendTaskError` + `suspended_tasks` + resume sweep)
- 记忆原语:`@aipehub/memory-file`(`packages/service-memory-file/src/`)+ worked 模式 `packages/host/src/services/personal-growth-context.ts`
- 灵活调用:Phase 10 `DispatchToolset` / `ComposedToolset`(`docs/zh/ledger/V4-PHASE10-FINAL.md`)
- 治理审批:Phase 16 inbox(`docs/zh/ledger/V4-PHASE16-FINAL.md`)+ ACP-HITL `dangerousToolGate`(`docs/zh/ledger/V5-ACP-ADAPTER.md`)
- 上手 / turnkey:`docs/zh/HANDS-ON-HUBS.md` / `docs/zh/TEMPLATE-GALLERY.md`
