# 个人 Hub 管家 (Personal Butler) — 收口 (M1–M6 全完)

> 把现有 `HubStewardAgent`(单发结构化提议、无记忆、无服务端会话的「设置管理器」)
> 升级成一个**可快速投入、类似 OpenClaw / Hermes 的常驻个人管家**:它**记得你**
> (跨会话)、能**灵活替你调用**(查记忆 / 起工作流 / 派子 agent / 查 MCP)、把对话
> **管起来**(捕获 / 蒸馏 / 注入),而所有**敏感动作仍走人审批**——这一条是相对
> OpenClaw 的护城河,不是要补的缺口。
>
> 本文是收口(建之前设计见 [`docs/zh/PERSONAL-BUTLER-DESIGN.md`](PERSONAL-BUTLER-DESIGN.md))。
> Last updated: 2026-06-29 · 状态:M1–M6 全完

---

## 一句话

管家**和现有工作流不是二选一**:工作流是声明式后端(可治理 / 可版本化),管家是
对话式前门。管家能起 / 看工作流(`workflow-start` 当工具),工作流也能派活给管家。
两者并存,都是一等公民。M1–M6 把这个常驻管家从设计落到代码 + 验收门,**core /
protocol / identity / workflow-runner 全程零改**(新活集中在两个叶包 + host 薄接线 +
`/me` 隐私视图),example-first(管家 agent fold 进 host main.ts 显式推迟)。

---

## 二、北极星对齐(全程守住)

- **框架不跑 LLM**:管家是一个 `Participant`(`LlmAgent` 子类),决策在它(模型)手里;
  Hub 只路由 / 记 transcript。记忆是**文件**(`.aipehub/` 里看得见,复制目录=搬走管家的
  「大脑」),不是云端黑盒。
- **人和 agent 是同一个 Participant**:敏感动作不是「管家自己干」,而是**派一个 Task
  给代表你收件箱的 Participant**,你在 `/me` 拍板后再恢复(复用 Phase 16)。
- **状态即文件**:episodic 原始记忆 = jsonl;semantic 策展 profile = 蒸馏文本;会话 =
  transcript。全在磁盘,per-user 命名空间隔离。
- **不学的那一半**:OpenClaw / Hermes 是**无界、无门控、宿主机自治**的 tool-loop。我们做
  **有界 + 敏感动作门控**的 tool-loop——决策 D2 / D8。

---

## 三、里程碑(M1–M6,逐个 commit)

| M | 做什么 | 关键产物 | commit |
|---|---|---|---|
| **M1** | 记忆增强 agent:冻结块注入 + `remember/recall/forget` 当 LLM 工具 | `@aipehub/personal-memory` — `MemorySession` + `renderFrozenBlock`(同会话稳定护缓存)+ `MemoryToolset` | `5cc0d96` |
| **M2** | 自动捕获:turn-end summarize→episodic + heartbeat 复盘 | `capture.ts`(turn-end capture pass,诚实:无 save-before-compact)+ `MemoryReviewParticipant` heartbeat 复盘 | `c60a0f7` |
| **M3** | 强制蒸馏:episodic→semantic 策展 profile,超阈值报错逼蒸(替掉 byte-cap 砍半) | `consolidate.ts` — `consolidate()` + 策展 profile 渲染 + prune | `d9a1189` |
| **M4** | 灵活调用接线 + 治理统一 + 检索后端 | `@aipehub/personal-butler` — 有界 `PersonalButlerAgent` tool-loop + `GovernedActionToolset`(敏感→审批门控)+ 可换 `MemoryRetriever` | `c13dab2` |
| **M5** | 快速投入:turnkey demo | `examples/personal-butler`(管家 + heartbeat + 记忆接线,确定性 mock provider,可跑自断言) | `d7649cd` |
| **M6a** | 治理收口地基:park→收件箱桥 + per-user 记忆命名空间 | host `personal-butler-escalation.ts`(`butlerApprovalItemFor`)+ `personal-butler-memory.ts`(`openButlerMemory`) | `32b2556` |
| **M6b** | §七 E2E 承重门(4 claims) | host `personal-butler-e2e.test.ts` | `5e7ead1` |
| **M6c** | 被遗忘权:`/me`「管家记得你什么」隐私视图 | host `HostButlerMemoryService` + web `/api/me/butler/memory` 4 路由 + SPA 面板 | `55c7ad4` |
| **M6d** | 敏感记忆写人在环(诚实=既有 governed 闸) | `personal-butler/tests/sensitive-memory-write.test.ts` | `3b1be73` |
| **M6e** | 文档收口 + CLAUDE.md 登记 + 全量测试 | 本文 + 设计 §六/§七 标完 + CLAUDE.md | 本提交 |

---

## 四、一次管家 turn 的数据流(已落地)

```
member /me 或 IM 说一句话
        │
        ▼
PersonalButlerAgent.onTask(task)           ← LlmAgent 子类,有界 tool-loop (maxToolRounds)
        │  buildRequest: system + renderFrozenBlock(per-user 记忆快照)  ← M1 护缓存
        ▼
provider.stream(req)  →  model 决定调哪些工具
        │
        ├── 良性工具 (recall / workflow-start / dispatch / mcp / note) ── 内联跑,继续 loop
        │
        └── 治理工具 (delete / spend / send / pin_memory…)
                │  classify(name,args)  ← 服务端权威 (host 注入,默认保守 approve)
                │
                ├── allow   → 内联跑
                ├── refuse  → fail-closed 内联 (isError 结果,模型换路)
                └── approve → throw SuspendTaskError(NEVER_RESUME_AT, ButlerGateState{pending})
                                    │
                                    ▼
                        host async suspendNotifier (单一漏斗)
                          ① 持久化 suspended_tasks (identity, Phase 11)
                          ② butlerApprovalItemFor(task,…) → approval InboxItem (FileInboxStore)  ← M6a
                                    │
                                    ▼
                        人在 /me 收件箱批 / 拒  →  HostInboxService.resolve  ← 两步恢复
                                    │  注入 {...row.state, answer:decision}
                                    ▼
                        agent.onResume → readButlerDecision
                          approved → 跑被推迟的那次工具调用 (恰一次)
                          denied / 无裁决 → fail-closed (副作用从未发生)
                                    │
                                    ▼
                        continue loop → 最终 ok 文本回 member
        │
        ▼
turn-end capture → episodic 记忆 (M2);heartbeat tick → consolidate 蒸馏 semantic profile (M2/M3)
```

**关键正确性约束**(全程钉死):

1. **闸在副作用之前**:`classify` 在 `callTool` 之外,`approve` 在工具跑之前就 park →
   被门控的动作(含敏感记忆写)在批准前**绝不发生**。
2. **NEVER_RESUME_AT**:治理 park 永不自动恢复,**只有人**在收件箱拍板才唤醒;sweep
   恒取不到。
3. **fail-closed**:缺失 / 畸形裁决一律当拒绝,绝不隐式批准。
4. **per-user 命名空间隔离**:`openButlerMemory({rootDir, userId})` → `<rootDir>/user/<userId>/`,
   no-leak 边界是命名空间本身(非访问检查),userId 由路由从 session 强制。

---

## 五、§七 验收门结果(全过)

`packages/host/tests/personal-butler-e2e.test.ts` —— 真 Hub + 真 IdentityStore + 真
`FileInboxStore` + per-user `openButlerMemory` + 真 `PersonalButlerAgent`(mock LLM 确定性
按指令分支,不烧 key),一个测证清四件:

1. **跨会话记忆** ✅:会话1「记住我叫阿明,在做奶茶店项目」→ capture episodic;heartbeat
   tick → consolidate → semantic profile 含「奶茶店项目」;会话2(新 task,同 user)
   「我之前那个项目叫啥?」→ 召回 → 答含「奶茶店」。
2. **良性灵活调用** ✅:「帮我起 cafe-staff-onboarding 工作流」→ `workflow-start` 工具 →
   **不挂起**跑通。
3. **敏感动作门控** ✅:「把 mailer agent 删了」→ classify=approve → **suspend → `/me` 收件箱**
   (park 在 NEVER、sweep 取不到、收件箱有 1 条 pending)→ 批准→真删 / 拒绝→
   **fail-closed mailer 仍在**。
4. **no-leak** ✅:另一个 user 的管家**召回不到**阿明的记忆(per-user 命名空间隔离)。

通过 = 「记忆 + 灵活调用 + 会话 + 治理」四件一次成立,且 PII 不跨 user 泄漏。

---

## 六、M6c 被遗忘权(`/me` 隐私视图)

管家保有长期记忆,故用户必须能**看见、忘掉、导出**。前置到 UI 让用户安心。

- host `HostButlerMemoryService`(`butler-memory-service.ts`):`read`(semantic 画像 +
  近期 episodic)/ `export`(全部,数据可携)/ `forget`(单条)/ `forgetAll`(被遗忘权)。
  全部经同一 `openButlerMemory` 工厂打开 per-user handle —— **「管家记得什么」与「这个视图
  显示 / 抹掉什么」是同一棵树、同一份字节**。只读 rootDir,不依赖已注册的管家 agent,故
  折进 host 前即可接线(在有东西写进同一 per-user handle 前视图为空)。
- web `/api/me/butler/memory`(GET 快照 / GET export / DELETE 全部 / DELETE :id):
  **userId 服务端从 session 强制**(永不取客户端值),无 surface → GET 空 / mutate 503,
  状态码错误映射 HTTP。`forget` miss 是良性 `false` 非枚举 oracle、非抛错。
- SPA `/me`「管家记得你什么」面板:长期画像 + 最近记下的两列,每条「忘掉这条」,顶部
  刷新 / 导出全部(客户端 Blob 下载)/ 忘掉全部;zh/en i18n parity。

---

## 七、M6d 敏感记忆写人在环(诚实=既有 governed 闸)

**没有新机制**。一次敏感记忆写就是把一个写记忆的工具注册进管家已有的
`GovernedActionToolset`(delete / spend / send 同一个),classify 成 `approve`。该闸
**tool-name-agnostic**,故记忆写会和 `delete_agent` 一样 park(`SuspendTaskError` →
`/me` 收件箱),只有人批准才执行,拒绝则 fail-closed。

`sensitive-memory-write.test.ts` 钉死「这是记忆写而非泛动作」:被门控的副作用就是
`memory.remember`,故断言记忆存储本身 —— 批准后才进 `mem.list()`、拒绝 / 无裁决永不进。
再以一条 **BENIGN** 记忆写(普通 note / 自动捕获路径)内联跑通且从不挂起作对照,证明闸是
对**特定写入**的策略选择,不是对每次记忆写的税。

---

## 八、测试矩阵(全过)

| 包 | 测试 | 数 |
|---|---|---|
| `@aipehub/personal-memory` | session / frozen-block(同会话字节相同护缓存)/ toolset 往返 / capture / consolidate 蒸馏 + prune / review heartbeat / retriever / agent + agent-capture | **75** |
| `@aipehub/personal-butler` | agent(良性内联 / 治理 park / resume 批准·拒绝·无裁决 / mixed-round 原子 / bounded)9 + governed-toolset 12 + **sensitive-memory-write 5**(M6d) | **26** |
| host | personal-butler-memory 3 + butler-memory-service 6(M6c)+ personal-butler-escalation 7(M6a)+ **personal-butler-e2e 4**(§七承重门 M6b) | **20** |
| web | me-butler-memory-routes(session userId 强制 + 状态码映射 + 无 surface 降级,M6c) | **7** |

全量 `pnpm -r test` 绿,零回归。

---

## 九、包 / 文件清单

```
packages/personal-memory/        M1–M3 记忆引擎 (依赖 core + services-sdk)
  src/ session.ts frozen-block.ts toolset.ts capture.ts consolidate.ts review.ts retriever.ts agent.ts
packages/personal-butler/        M4 有界治理 tool-loop (依赖 core + llm + personal-memory)
  src/ agent.ts governed-toolset.ts checkpoint.ts errors.ts
packages/host/src/
  personal-butler-memory.ts       M6a — openButlerMemory (per-user 命名空间,Owner{kind:'user'})
  personal-butler-escalation.ts   M6a — butlerApprovalItemFor (park → approval InboxItem 的唯一处)
  butler-memory-service.ts        M6c — HostButlerMemoryService (/me 隐私视图,read/export/forget/forgetAll)
packages/host/tests/
  personal-butler-e2e.test.ts     M6b — §七 4-claim 承重门
examples/personal-butler/         M5 — turnkey demo (index/memory/provider)
packages/web/src/me-routes.ts     M6c — ButlerMemorySurface + /api/me/butler/memory 4 路由
packages/web/static/app.{html,js} + app-core.js   M6c — SPA「管家记得你什么」面板 + i18n
```

---

## 十、显式推迟(承设计 §十)

- **fold 进 host main.ts 当一等公民**:管家 agent + heartbeat + governed toolset + 确定性闸
  参与者目前是 example 运行时接线代码;`/me` 隐私视图服务**已接线**(读 `<space>/butler/memory`,
  折进来的管家用同一子树)。fold-in 显式推迟(同 family-learning-hub 先例,example-first)。
- **可插拔 Docker/SSH/Modal 沙箱终端后端**(Hermes 天花板)——我们带闸的 CLI/ACP 已超
  OpenClaw 裸跑默认;真要执行隔离对齐 Hermes 单列 +1–1.5 周。
- **kanban 级任务板编排**(Hermes)——超「个人记忆 + 执行」范围。
- **向量 / 图记忆当默认**——默认子串 + 时近 + 可选 chroma-mcp 足够。
- **管家主动发起对话**(heartbeat 主动找你而非只维护记忆)——本设计 heartbeat 只做记忆
  维护 + 到期提醒。

---

## 关联文档

- 建之前设计:[`docs/zh/PERSONAL-BUTLER-DESIGN.md`](PERSONAL-BUTLER-DESIGN.md)(对标 OpenClaw / Hermes 源码 + 决策 D1–D8)
- 现有管家:[`docs/zh/V5-STEWARD-FINAL.md`](V5-STEWARD-FINAL.md)(`HubStewardAgent` + 四级分级 + 收件箱审批)
- 主动节奏:Stream D heartbeat(`packages/host/src/heartbeat.ts`)
- 持久任务:Phase 11(`SuspendTaskError` + `suspended_tasks` + resume sweep)
- 成员收件箱:Phase 16(`@aipehub/inbox` + `HostInboxService` 两步恢复)
