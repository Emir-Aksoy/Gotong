# 常驻管家 fold 进生产 host + 接管 IM 通道 — 收口 (BF-M1–M8 全完)

> 把 [`PERSONAL-BUTLER-FINAL.md`](./PERSONAL-BUTLER-FINAL.md) §十**显式推迟**的那一条
> ——「fold 进 host main.ts 当一等公民」——做实:让生产 `gotong start` 注册的
> `chat` agent **本身就是**一个 per-user 常驻管家,接管 IM 通道(飞书等),而且
> **GitHub 代码库默认如此**。
>
> 触发:用户在飞书上问机器人,它回答自己**没有跨会话记忆**(「它告诉我它没有跨会话
> 记忆」)。头号交付物 = **机器人必须跨会话记住对话**;整个管家(记忆 + 治理)是
> 载体,但跨会话记忆是第一位的。
>
> Last updated: 2026-07-01 · 状态:BF-M1–M8 全完(BF-M7 governed §十一 + BF-M8 蒸馏/维护 §十二;
> 仅本地 commit,未 push / 未部署)

---

## 一句话

`PersonalButlerAgent` 此前只活在 `examples/personal-butler` 和 §七 验收门里,生产
host 的 IM 机器人用的还是一个**无记忆的普通 `LlmAgent`**——所以飞书机器人「不记得
你」。BF 系列把常驻管家**折进 `host/src/main.ts`**:加载了工作流的 Gotong,其
注册的 `chat` agent 现在是一个 **per-user `ButlerRouter`**——同一个注册 id,按
`task.origin.userId` 路由到**每个成员各自的记忆命名空间**,所以 IM 通道上每个绑定
用户都得到一个**只记得他自己、且跨会话记得**的管家。**默认开**(`GOTONG_BUTLER` 关),
GitHub 代码库默认如此。

**core / protocol / identity / workflow-runner 全程零改**;新活集中在一个叶包的小
修(`@gotong/personal-memory` 加 `refresh()`)+ host 几处接线(router / factory /
escalation sink)+ 承重 E2E。BF-M4 的基线管家是**纯记忆**形态(下文 §一句话 之后按
BF-M4 时点描述);**治理另一半在 BF-M7 补齐**(governed 动作集 → `/me` 收件箱审批,§十一),
**per-user 蒸馏 + 6h 维护在 BF-M8 接进生产 host**(§十二)。BF-M4 那一刻的管家只是多了跨会话
记忆 + 保留原有的良性工具,永不为审批挂起。

---

## 二、北极星对齐(全程守住)

- **框架不跑 LLM**:管家是 `Participant`(`LlmAgent` 子类),决策在模型手里;Hub 只
  路由 / 记 transcript。`ButlerRouter` 自己**不持 LLM、不持 provider、不持 key**——
  只有 `Map<userId, Participant>` 和路由。
- **状态即文件**:每个成员的记忆在 `<space>/butler/memory/user/<userId>/`(jsonl),
  复制目录=搬走那个成员的「大脑」。这与 `/me`「管家记得你什么」隐私视图读的是**同一
  棵子树**——「管家记得什么」与「成员能抹掉什么」是同一份字节。
- **人和 agent 是同一个 Participant**:敏感动作(BF-M7 接上后)派 Task 给收件箱
  Participant,成员在 `/me` 拍板再恢复(复用 Phase 16)。escalation sink 已就位(纯
  记忆形态下休眠)。
- **不学的那一半**:OpenClaw / Hermes 是无界、无门控的宿主机自治 tool-loop;我们做
  **有界 + 敏感动作门控**的 tool-loop。fold-in 不改这条——它只是把这个有界管家从
  example 搬进生产入口。

---

## 三、里程碑(BF-M1–M6,逐个 commit)

| M | 做什么 | 关键产物 | commit |
|---|---|---|---|
| **BF-M1** | 叶 / core 接缝:`governed` 可选(纯记忆管家)+ `ManagedAgentSpec.butler` 标记 | `@gotong/personal-butler` `governed?` 选项 + core `butler?` 字段 + web 透传 | `4a45305` |
| **BF-M2** | host `butler-router.ts` per-user 多路复用 | `createButlerRouter`(按 `origin.userId` 路由 + 懒建 + memoize + `onResume` 重建 + no-leak) | `62c0fdf` |
| **BF-M3** | `LocalAgentPool` `butlerFactory` 钩子 | 闸:`chat` 能力 + `'llm'` kind + 默认开 / per-agent 开关 + 工厂在场;命中→工厂建参与者注册在**同一 id** | `ef19e86` |
| **BF-M4** | `main.ts` 接线 + 默认开 + escalation sink | `butlerFactory` 闭包(per-user `openButlerMemory` + `openButlerRecallIndex` + `PersonalButlerAgent`)+ `GOTONG_BUTLER` 默认开 + `butlerEscalationSink` 骑 async suspendNotifier | `f6ee7b0` |
| **BF-M4(叶修)** | **跨会话记忆 bug 的真正修复** | `MemorySession.refresh()` + `frozenRefreshPerTask` opt-in(默认关,host 工厂置 true) | `f6ee7b0` |
| **BF-M5** | host §五 承重 E2E + 全量回归 + 默认化 | `butler-im-e2e.test.ts`(4 claims,真 router+工厂形态) | `f6ee7b0` |
| **BF-M6** | docs/zh + CLAUDE.md 登记 + memory | 本文 + PERSONAL-BUTLER-FINAL §十 标完 + CLAUDE.md | 本提交 |

> BF-M4 / 叶修 / BF-M5 三件并在一个 commit(`f6ee7b0`)——按计划在 E2E 证明端到端故事
> 后一起落地。

---

## 四、跨会话记忆 bug:`MemorySession` 永久缓存(本系列的核心洞)

这是用户报告的飞书「没有跨会话记忆」的**真因**,值得单列。

`MemorySession.ensureFrozenBlock()` 把冻结块**每实例只算一次**并**永久缓存**——这是
Hermes「一个会话 = 一个稳定前缀」的设计,为的是护住 provider 的 prompt 前缀缓存
(系统提示前缀每轮都变会让缓存失效)。对一个**有界对话**这是对的:近期轮次骑在
in-context 历史上,冻结块是长期画像。

但常驻管家不是有界对话:

1. `ButlerRouter` 把每个成员的管家**memoize 整个进程生命周期**(一个用户一个实例,
   一直活着);
2. 每条 IM 消息都作为一个**独立、无历史的 task** 到达(IM 桥不串上下文)。

两者叠加:冻结块在**第一条消息**时算好(那时记忆为空)并永久冻结 → 后续消息看到的
还是那个空块 → 管家「记不住它刚捕获的东西」 = **正是用户报告的 bug**。

**修复**:`MemorySession.refresh()` 丢掉 memoize 的块,让下一次 `ensureFrozenBlock()`
从磁盘重新召回;`MemoryAugmentedAgent` 加 `frozenRefreshPerTask` opt-in(**默认关,所以
每个既有 memory-augmented agent 字节不变**),host 工厂置 `true`,于是每条消息都重新
召回上一条捕获的内容。

```
（默认 / 有界对话:一个会话 = 一个稳定前缀,护前缀缓存）
  msg1 ─ensureFrozenBlock()─▶ recall ─▶ [block 缓存]
  msg2 ─ensureFrozenBlock()─▶ [复用缓存]   ← 稳定前缀,但看不见 msg1 之后写的东西

（常驻管家:frozenRefreshPerTask=true,每条消息重新召回）
  msg1 ─refresh()→ensureFrozenBlock()─▶ recall(空) ─▶ 答 → 捕获到 episodic
  msg2 ─refresh()→ensureFrozenBlock()─▶ recall(含 msg1 捕获) ─▶ 记得了 ✅
```

**取舍诚实**:这拿前缀缓存稳定性换新鲜度。但对**无状态 per-message dispatch**本就没多少
跨消息前缀可缓存(每条消息一个独立 task),所以代价很小,换来的是「跨会话记住」这件
头号需求。`activeOnly` 自动采样的 `now` 也在 `refresh()` 时重采,让「此刻有效」跟着
墙钟而非进程启动时刻。

**为什么不靠蒸馏**:冻结块默认只读 `['semantic']`,而 episodic→semantic 蒸馏是 heartbeat
维护 pass 的活(BF-M8 才 per-user 接上)。在蒸馏跑之前,semantic 画像是空的。所以 host
工厂另把 `frozenMemoryKinds` 设为 `['semantic','episodic']`——捕获的轮次**立刻**进下一条
消息的冻结块,不必等维护 pass。`['semantic','episodic']` + `frozenRefreshPerTask` 两件
合起来,才是「这一条消息记得上一条」的完整答案。

---

## 五、架构:per-user 多路复用器(`ButlerRouter`)

`MemoryAugmentedAgent` **每实例绑一个**记忆 handle。但 IM 通道把**许多**绑定用户路由进
**一个**注册的 `chat` agent。若那个 agent 自己持一个记忆 handle,所有成员的对话会堆进
**同一个**库——「记得我」的反面。

`ButlerRouter` 是解法:

- 注册在 `chat` agent 的 **同一 id + capability** 上,所以 Hub 的能力路由原样够得着;
- 每个 task 读 `task.origin.userId`(IM 桥总会盖上 = 绑定的 Gotong 用户,**不是**原始
  IM handle),路由到一个 **per-user 管家**,首次接触懒建并 memoize;
- 每个管家开自己的 per-user 记忆命名空间(`openButlerMemory(userId)` → `<rootDir>/
  user/<userId>/`),记忆**按构造隔离**;
- 重启后 map 为空 → `onResume` 按 userId 重建那个管家(管家除磁盘记忆 + carried state
  外无状态,新实例无漂移接上 parked turn);
- 无 `origin.userId` 的 task(operator poke / admin test-connection / 匿名)落
  `_local` 桶,与任何真 userId 隔离——`/me` 隐私视图只读真 userId,故该桶在那里不可见。

`main.ts` 的 `butlerFactory` 注入「真工厂」(共享 provider + key + per-user 记忆 rootDir
+ recall index);测试注入 fake 参与者。router 是个小、可单测的接缝。

```
IM 桥 (飞书…) ── dispatch{strategy:explicit→'assistant', origin.userId} ──▶
   Hub ── capability 路由 ──▶ ButlerRouter (注册在 'assistant')
                                  │  按 origin.userId 路由 + memoize
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
   PersonalButlerAgent     PersonalButlerAgent     PersonalButlerAgent
   alice 的记忆             bob 的记忆               carol 的记忆
   <root>/user/alice/      <root>/user/bob/        <root>/user/carol/
```

---

## 六、默认开(`GOTONG_BUTLER`)+ 闸

- **默认开**:`GOTONG_BUTLER ∈ {0,false,off,no}`(大小写不敏感)关掉;其余(含未设)开。
  GitHub 代码库默认如此 = 用户的诉求「github 版本也是这么默认」。
- **per-agent 开关**:`managed.butler: false` 让单个 row 退出(即使全局开);`managed.butler:
  true` 让单个 row 加入(即使全局关)。
- **闸矩阵**(`LocalAgentPool.butlerEnabledFor`,BF-M3):只有**`chat` 能力 + `'llm'` kind**
  的 row 才走工厂。`personal-growth` 等专门 kind、非 chat 的后台 agent 一律保持普通
  `LlmAgent`。工厂不在场 → 永不启用(纯记忆管家退化成普通 agent,绝不崩)。

命中闸 → 工厂把 pool 建好的 base 选项(含 dispatch / mcp 等工具)拆开,`tools` 移到管家
的 `benign`(那些工具仍内联跑),构造 `PersonalButlerAgent` 注册在**同一 id**(admin /
lifecycle / 重启 / test-connection 全不变)。

---

## 七、§五 验收门结果(全过)

`packages/host/tests/butler-im-e2e.test.ts` —— 真 Hub + 生产形态 async `suspendNotifier`
→ 真 `IdentityStore` + `butlerApprovalItemFor` sink + 真 `FileInboxStore`,驱动**一个
`createButlerRouter`**(per-user 管家,`frozenRefreshPerTask:true` +
`frozenMemoryKinds:['semantic','episodic']`,完全照 main.ts 工厂),确定性 provider 读
`req.system` 的冻结块按是否含店名应答(不烧 key):

1. **跨消息记忆(头条)** ✅:alice msg1「我开了家奶茶店叫快乐柠檬」→ 捕获;alice
   msg2「我的奶茶店叫什么名字?」→ **同一个** memoize 的管家经 `refresh()` 重召回 →
   冻结块含「快乐柠檬」→ 答出店名。**没有蒸馏步**。这就是飞书机器人缺的那件事,**没有
   `frozenRefreshPerTask` 就红**。
2. **refresh 是承重的(对照)** ✅:同样构造但 `refresh` 关的对照管家,冻结块冻在 msg1
   的空块上,msg2 **答不出**店名——证明 claim 1 是修复在起作用,不是 provider 走运。
3. **no-leak** ✅:bob 的管家(另一个命名空间)永不见 alice 的店;alice 自己的管家见得到
   (证 bob 的 miss 是隔离非 provider 坏)。
4. **/me 视图同源** ✅:`HostButlerMemoryService` 读同一个 `<space>/butler/memory`
   rootDir → 见 alice 的捕获;bob 的树是分开的。

外加 claim 1 断言**纯记忆管家从不 park**(escalation sink 写了 0 条收件箱项)——证明折进
一个纯记忆管家**零审批摩擦**。

---

## 八、测试矩阵(全过,零回归)

| 包 | 测试 | 数 |
|---|---|---|
| `@gotong/personal-memory` | 既有 + `MemorySession.refresh()` 3 个新单测(再召回 / 清 pending / 重采 `now`) | **376** |
| `@gotong/personal-butler` | 既有(agent / governed / sensitive-memory-write) | **29** |
| host | 既有 butler 套 + `butler-router` 10 + `local-agent-pool-butler` 7 + **`butler-im-e2e` 4** + **`personal-butler-governed` 13**(BF-M7-M1 单测)+ **`personal-butler-governed-e2e` 5**(BF-M7-M3 承重门)+ **`butler-maintenance` 2**(BF-M8 summarizer 单测)+ **`butler-maintenance-sweep-e2e` 3**(BF-M8 承重门) | **1378**(+4 skip) |
| web | 既有(me-butler-memory-routes 等) | **1169** |

`pnpm -r build` 干净;全量 `pnpm -r test` 绿(core 395 / protocol 127 / identity 612 /
workflow 258 / cli 185 …),零回归。skip 全是 live / API-key 门(host 4 / llm-anthropic 2
/ llm-openai 2)。

---

## 九、文件清单(本系列动到的)

```
packages/personal-memory/src/
  session.ts          BF-M4 叶修 — MemorySession.refresh() + 可变 now + nowAutoSampled
  agent.ts            BF-M4 叶修 — frozenRefreshPerTask opt-in (默认关) + handleTask/handleResume 钩 refresh
packages/personal-memory/tests/session.test.ts   +3 refresh 单测
packages/host/src/
  butler-router.ts            BF-M2 — createButlerRouter per-user 多路复用 (已 committed)
  local-agent-pool.ts         BF-M3 — butlerFactory 钩子 + 闸 (已 committed)
  main.ts                     BF-M4 — butlerFactory 闭包 + GOTONG_BUTLER 默认开 + butlerEscalationSink
                              BF-M7 — governed toolset 喂进工厂 (GOTONG_BUTLER_GOVERNED + 前向引用)
                              BF-M8 — ButlerMaintenanceSweeper 构造/start/stop (GOTONG_BUTLER_MAINTENANCE)
  local-agent-pool.ts         BF-M3 — butlerFactory 钩子 + 闸 (已 committed)
                              BF-M8 — buildButlerProvider() (复用 resolveApiKey+providerFactory, 后台扫描的 provider 缝)
  personal-butler-governed.ts BF-M7-M1 — buildButlerGovernedToolset (steward 动作集 → GovernedActionToolset, 全 approve) (新)
  personal-butler-maintenance.ts BF-M8 — butlerSummarizer(provider→MemorySummarizer 缝) + buildButlerMaintenanceReviewer(tieredReviewer 蒸馏 ⊂ statusProjectingReviewer) + ButlerMaintenanceSweeper(per-user 后台扫描, 不在 boot 触发) (新)
packages/host/tests/
  butler-im-e2e.test.ts       BF-M5 — §五 4-claim 承重门 (新)
  butler-router.test.ts       BF-M2 (已 committed)
  local-agent-pool-butler.test.ts  BF-M3 (已 committed)
  personal-butler-governed.test.ts     BF-M7-M1 — builder 13 单测 (新)
  personal-butler-governed-e2e.test.ts BF-M7-M3 — 生产形态承重门 5 (新)
  butler-maintenance.test.ts           BF-M8 — butlerSummarizer 请求形状 2 单测 (新)
  butler-maintenance-sweep-e2e.test.ts BF-M8 — 生产扫描承重门 3 (新)
```

复用既有(零改):`personal-butler-memory.ts`(`openButlerMemory`)/ `butler-recall-index.ts`
(`openButlerRecallIndex`)/ `personal-butler-escalation.ts`(`butlerApprovalItemFor`)/
`butler-memory-service.ts`(`HostButlerMemoryService`,/me 视图读同一 rootDir)。

---

## 十、显式推迟

- ✅ **BF-M7 完整 governed 动作集**:**已补齐**,见下面 §十一。
- ✅ **BF-M8 per-user 蒸馏 + 6h 维护接进生产 host**:**已补齐**,见下面 §十二。
- **dreaming / umbrella / 清输出 / SKILL.md 自创技能** 进生产扫描:**仍推迟**。BF-M8 是**精简**
  的蒸馏 + STATUS.md pass(见 §十二「诚实边界」),这几项需要额外信号(query-diversity)或子系统
  (procedure drafter),且管家默认记忆配置里没有 `working` 便签,`cleanOutputs` / `skillFile`
  在这儿是纯 no-op——每个节点必须挣得它的位置。
- **可插拔沙箱终端后端**(Hermes 天花板)、**向量 / 图记忆当默认**、**管家主动发起对话**
  ——承 `PERSONAL-BUTLER-FINAL.md` §十,不在本系列范围。

---

## 十一、BF-M7 完整 governed 动作集(已补齐)

BF-M4 把一个**纯记忆**管家 fold 进 IM 通道(记得你 / 良性工具内联 / 从不挂起)。BF-M7 给它
补上治理的另一半:一个 `GovernedActionToolset`,让成员**用大白话跟管家说**,就能建 / 改 / 删
**自己的**受管助手、改自己的工作流。每一件都是**审批门控**——管家有界 tool-loop 把任务挂起
(`SuspendTaskError`),`butlerApprovalItemFor` 把这个 park 变成一个 `/me` 收件箱项,**在成员
到 `/me` 批准之前什么都不会跑**(北极星:「敏感动作 → 成员的收件箱」)。

**★ 复用 steward,而且比它更严 ★**:执行走**同一个** `performStewardAction` + 成员服务
(`HostMeAgentService` / `MeWorkflowEditService`),跟 `/me` hub-steward 用的是同一套。所以管家
**在构造上不可能越过成员本人手动能做的范围**:同一套 `resource_grants` RBAC 阶梯 + 成员上限
门控每一次 create / edit / delete,`edit_workflow` 继承 WFEDIT 跨 hub 出入口锁(成员经管家也
永远重指向不了跨 hub 出口)。但管家**故意比 steward 更严**:`/me` steward SPA 有 plan→apply
**预览**(成员先看 `ClassifiedProposal` 再点 apply),所以它的 `safe` create/edit 是在那次审查
**之后**才「内联」跑。常驻 IM 管家**没有这个预览**——一个 `safe` 裁决会从一条聊天消息零人工
确认就跑。所以这里**每一个**暴露的动作都默认 `approve`:`/me` 收件箱**就是**执行前的审查步。

**四个 operator-only 敏感写**(凭证 / peer / 安全)**根本不暴露**——成员 steward 把它们分级成
`forbidden` 且从不拿到它们的执行器,所以管家干脆没有这些工具(结构性防御,不只是分级 forbidden)。

### 里程碑

| # | 动了什么 | commit |
|---|---|---|
| **BF-M7-M1** | `packages/host/src/personal-butler-governed.ts` — `buildButlerGovernedToolset(deps)` 把 hub-steward 动作词汇 + `validateStewardAction` + `performStewardAction` chokepoint 包成一个 `GovernedActionToolset`;四个成员级工具(create/edit/delete_agent + edit_workflow)全默认 `approve`;`describe` 复用 `summarizeStewardAction` 的 zh 摘要当收件箱标题。**Option B**:`workflowEditor?` 可选——有 identity 无 `workflowAssist` 的 hub 没有它,`edit_workflow` 就不暴露(诚实通告),agent 动作照常。+13 单测 | (本系列) |
| **BF-M7-M2** | `main.ts` `createForUser(userId)` 里构 `buildButlerGovernedToolset({ userId, agents, workflowEditor? })` 喂进 `PersonalButlerAgent({ governed })`;前向引用 `let`(在成员服务 `meAgentAdmin` / `meWorkflowEdit` 构好后赋值,call-time 读,同 `peerRegistryRef` 先例);`GOTONG_BUTLER_GOVERNED ∈ {0,false,off,no}` 才关(默认开)。**逃生开关**:关掉 governed 就退回纯记忆管家 | (本系列) |
| **BF-M7-M3** | `packages/host/tests/personal-butler-governed-e2e.test.ts` — 生产形态承重门:真 Hub + 生产形态 async `suspendNotifier`→真 IdentityStore + `butlerApprovalItemFor` sink → 真 `FileInboxStore` + 真 `HostMeAgentService`(真 Space `upsertAgent` + 真 `resource_grants`,只 fake spawn)。5 剧情:agents-only 通告面 / **create 也 park**→批准建真 agent(Space + owner grant + spawn)/ delete park 在 NEVER 盲于 sweep 带 `/me` 项 / 批准真删(Space 空 + grant 清 + lifecycle.removed)/ 拒绝 fail-closed(agent 仍在 grant 仍在) | (本系列) |
| **BF-M7-M4** | 本节 + §八/§九 更新 + CLAUDE.md 登记 + 记忆文件更新 | (本系列) |

### 诚实边界

- **纯记忆 vs governed 是配置态**:`GOTONG_BUTLER_GOVERNED=0` 或成员服务缺失(无 identity)→ 管家
  退回 BF-M4 纯记忆形态,行为逐字节不变。governed 只在 identity + `meAgentAdmin` 都在场时接上
  (escalation sink 也在 `if (identity)` 里,两者天然共存)。
- **爆炸半径**:一个新 host 文件(`personal-butler-governed.ts`)+ main.ts 三处接线 + 两个测试
  文件。`core/protocol/identity/runner` 全程零改;`@gotong/personal-butler` 叶包零改(builder
  住 host,因为它要 host 的 `performStewardAction` + 成员服务)。
- **云端**:BF-M7 **仅本地**——生产腾讯云实例仍跑纯记忆管家(`gotong.env` 无 `GOTONG_BUTLER_GOVERNED`
  即默认开,但云端那台**尚未** rsync 本批;governed 上云需用户确认后单独走部署 + 飞书冒烟)。

---

## 十二、BF-M8 per-user 蒸馏 + 6h 维护接进生产 host(已补齐)

BF-M4 让常驻管家**捕获**每个回合进 `episodic`,并靠 `frozenMemoryKinds:['semantic','episodic']`
把这些原始捕获直接塞进下一会话的冻结块——这是个**权宜之计**:`semantic` 策展画像一直**是空的**,
因为生产里从来没有东西跑蒸馏。MR 系列早就把整套蒸馏引擎(`tieredReviewer`)和 6h 维护惯用法
(`statusProjectingReviewer`)造好了,但只有 `examples/personal-butler` demo 和 MR4 §九 承重门
点过它们。BF-M8 把这套维护 fold 进 `gotong start`——**per-user、后台扫描、6h 一拍**。

### 一拍做什么(每个成员)

对磁盘上每一个 `<butlerMemoryRoot>/user/<userId>/` 命名空间,点火**一个**维护 reviewer:

```
statusProjectingReviewer({                       // ④写状态 → STATUS.md (/me 看得见)
  statusFile,
  inner: tieredReviewer({ summarize }),           // 蒸馏 episodic → 分卷 digest → 画像
})
```

管家记忆是**分卷的**(`PersonalButlerAgent` 默认 `tierConfig: DEFAULT_TIERS`),所以蒸馏**必须**是
`tieredReviewer` 而非扁平 `consolidate`——把 episodic 路由进各卷 digest,某卷攒够 digest 就晋升成
一份持久画像。相较 MR4 example 的 composed pass **故意精简**:管家默认记忆配置省了 `working` 便签、
也还不自创 procedure,`cleanOutputsReviewer` / `skillFileReviewer` 在这儿是纯 no-op——每个节点必须
挣得它的位置(「代码尽量简化,节点尽量轻量」)。dreaming / umbrella 自创技能**仍推迟**(见 §十)。

### ★ 关键缝:蒸馏用的模型 = 管家自己的模型 ★

蒸馏的 `summarize` 调用跑在一个 provider 上,这个 provider 从**同一个**管家对话所经的托管 `chat`
行构建(`LocalAgentPool.buildButlerProvider()`,复用 spawn 用的**同一条** `resolveApiKey` +
`providerFactory` 链)。于是维护模型永远不会和对话模型分歧,用量也计到同一处。扫描在**每一拍**
(不是 boot)解析 provider——所以 boot 之后才配的 key 也会被拾起;provider 为 null(没 key / 没
管家行)就让整拍干净 no-op(一个还没配 key 的新 hub 每拍落这)。这条缝是本里程碑真正**新加**的东西:
后台扫描跑在**任何 task 之外**,骑不了管家工厂在 spawn 时捕获的 provider,得有自己的。

### 里程碑

| # | 动了什么 | commit |
|---|---|---|
| **BF-M8-M1** | `LocalAgentPool.buildButlerProvider()` — 找 `butlerEnabledFor` 的行,复用 `resolveApiKey` + `providerFactory`;mock 免 key,真 provider 必须解出 key;任一步抛(vault 锁 / 配置坏)→ 返 null 让扫描诚实跳过而非崩在 interval 上 | (本系列) |
| **BF-M8-M2** | `packages/host/src/personal-butler-maintenance.ts`(新)— `butlerSummarizer`(provider→`MemorySummarizer` 唯一缝,保 `@gotong/personal-memory` 零 `@gotong/llm` 依赖)+ `buildButlerMaintenanceReviewer`(`tieredReviewer` ⊂ `statusProjectingReviewer`)+ `ButlerMaintenanceSweeper`(枚举 `<root>/user/*` per-user 维护;re-entrancy 守卫;每成员 best-effort try/catch;**不在 boot 触发**——6h job 每次重启都点火只会白烧 token,首拍落在 `start()` 一个 interval 之后;`.unref()` 让待处理的拍永不吊住进程) | (本系列) |
| **BF-M8-M3** | `main.ts` — `import { ButlerMaintenanceSweeper, BUTLER_MAINTENANCE_INTERVAL_MS }`;env `GOTONG_BUTLER_MAINTENANCE ∈ {0,false,off,no}` 才关(承 `GOTONG_BUTLER` 默认开)+ `GOTONG_BUTLER_MAINTENANCE_MS`(clamp `[60s, 24h]`);在 `localAgents.start()` 之后构 sweeper + `start()`,shutdown 里 `stop()`;更新 `frozenMemoryKinds` 注释(蒸馏现在会跑,但两个 kind 都留着让最新捕获无需等 6h 扫描就浮上冻结块) | (本系列) |
| **BF-M8-M4** | `butler-maintenance.test.ts`(BF-M8 summarizer 请求形状 2 单测)+ `butler-maintenance-sweep-e2e.test.ts`(生产扫描承重门 3:真 `LocalAgentPool` provider 缝驱动真 `ButlerMaintenanceSweeper` — ① seam: `buildButlerProvider()` 从管家行解出 mock provider ② 蒸馏: episodic 折到 keepRecent(8) + 分卷 digest 落 `meta.tier` ③ STATUS.md + `/me` lastStatus 浮现 ④ no-leak: 另一成员空 / 无 STATUS.md;外加 no-provider→null→干净 no-op + 无成员→根本不建 provider)+ 本节 + §八/§九/§十 更新 + CLAUDE.md 登记 + 记忆文件 | (本系列) |

### 诚实边界

- **精简 vs 完整维护**:BF-M8 只做**蒸馏 + STATUS.md**。dreaming / umbrella / cleanOutputs /
  skillFile 在生产扫描里**仍推迟**——见 §十。这不是遗漏,是「每个节点必须挣得位置」:管家默认记忆
  配置里没有 `working` 便签,那两个 reviewer 会是纯 no-op;dreaming / umbrella 需要额外信号 /
  子系统。
- **6h 不在 boot 触发**:首拍落在 `start()` 一个 interval 之后。一个 6h job 每次重启都点火只会
  白烧 token 换不来任何东西。
- **best-effort + no-leak**:每个成员的命名空间隔离打开 + 维护,一个成员那拍抛了就记日志、扫描继续
  (一棵坏树绝不能卡住 interval)。真相是 jsonl,跳一拍是安全的。
- **爆炸半径**:一个新 host 文件(`personal-butler-maintenance.ts`)+ 一个 pool 方法
  (`buildButlerProvider`)+ main.ts 四处接线 + 两个测试文件。`core/protocol/identity/runner`
  全程零改;`@gotong/personal-memory` / `@gotong/personal-butler` 叶包零改(蒸馏引擎 + STATUS
  投影 MR 系列早造好,BF-M8 只接线)。
- **云端**:BF-M8 **仅本地**——同 BF-M7,生产腾讯云实例**尚未** rsync 本批;上云需用户确认后单独
  走部署(`GOTONG_BUTLER_MAINTENANCE` 默认开,但注意它会周期性调 MiMo 蒸馏,首次上云建议先观察一拍
  的用量 + STATUS.md 产物)。

---

## 关联文档

- 常驻管家收口(M1–M6):[`docs/zh/ledger/PERSONAL-BUTLER-FINAL.md`](./PERSONAL-BUTLER-FINAL.md)
- 建之前设计:[`docs/zh/PERSONAL-BUTLER-DESIGN.md`](../PERSONAL-BUTLER-DESIGN.md)
- 记忆多级 × 重要性:[`docs/zh/ledger/MEMORY-TIERS-FINAL.md`](./MEMORY-TIERS-FINAL.md)
- 记忆五项长期增强:[`docs/zh/ledger/MEMORY-ADVANCED-FINAL.md`](./MEMORY-ADVANCED-FINAL.md)
- 管家记忆四块增强(dreaming / 召回索引 / 自创·Umbrella 技能 / 6h 维护):[`docs/zh/ledger/MEMORY-DREAMING-SKILLS-FINAL.md`](./MEMORY-DREAMING-SKILLS-FINAL.md)
- 持久任务:Phase 11(`SuspendTaskError` + `suspended_tasks` + resume sweep)
- 成员收件箱:Phase 16(`@gotong/inbox` + `HostInboxService` 两步恢复)
- IM 桥:[`docs/zh/IM-BRIDGES.md`](../IM-BRIDGES.md) · [`docs/zh/IM-OFFICIAL-REARCH.md`](../IM-OFFICIAL-REARCH.md)
