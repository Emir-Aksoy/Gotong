# 常驻管家 fold 进生产 host + 接管 IM 通道 — 收口 (BF-M1–M6 全完)

> 把 [`PERSONAL-BUTLER-FINAL.md`](PERSONAL-BUTLER-FINAL.md) §十**显式推迟**的那一条
> ——「fold 进 host main.ts 当一等公民」——做实:让生产 `aipehub start` 注册的
> `chat` agent **本身就是**一个 per-user 常驻管家,接管 IM 通道(飞书等),而且
> **GitHub 代码库默认如此**。
>
> 触发:用户在飞书上问机器人,它回答自己**没有跨会话记忆**(「它告诉我它没有跨会话
> 记忆」)。头号交付物 = **机器人必须跨会话记住对话**;整个管家(记忆 + 治理)是
> 载体,但跨会话记忆是第一位的。
>
> Last updated: 2026-06-30 · 状态:BF-M1–M6 全完(仅本地 commit,未 push / 未部署)

---

## 一句话

`PersonalButlerAgent` 此前只活在 `examples/personal-butler` 和 §七 验收门里,生产
host 的 IM 机器人用的还是一个**无记忆的普通 `LlmAgent`**——所以飞书机器人「不记得
你」。BF 系列把常驻管家**折进 `host/src/main.ts`**:加载了工作流的 AipeHub,其
注册的 `chat` agent 现在是一个 **per-user `ButlerRouter`**——同一个注册 id,按
`task.origin.userId` 路由到**每个成员各自的记忆命名空间**,所以 IM 通道上每个绑定
用户都得到一个**只记得他自己、且跨会话记得**的管家。**默认开**(`AIPE_BUTLER` 关),
GitHub 代码库默认如此。

**core / protocol / identity / workflow-runner 全程零改**;新活集中在一个叶包的小
修(`@aipehub/personal-memory` 加 `refresh()`)+ host 三处接线(router / factory /
escalation sink)+ 一个承重 E2E。当前管家是**纯记忆**形态(无 `governed` 动作集,
BF-M7 再补),所以对一个在跑的 chat agent 行为变化近乎零:它**只是多了跨会话记忆 +
保留原有的良性工具**,永不为审批挂起。

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
| **BF-M1** | 叶 / core 接缝:`governed` 可选(纯记忆管家)+ `ManagedAgentSpec.butler` 标记 | `@aipehub/personal-butler` `governed?` 选项 + core `butler?` 字段 + web 透传 | `4a45305` |
| **BF-M2** | host `butler-router.ts` per-user 多路复用 | `createButlerRouter`(按 `origin.userId` 路由 + 懒建 + memoize + `onResume` 重建 + no-leak) | `62c0fdf` |
| **BF-M3** | `LocalAgentPool` `butlerFactory` 钩子 | 闸:`chat` 能力 + `'llm'` kind + 默认开 / per-agent 开关 + 工厂在场;命中→工厂建参与者注册在**同一 id** | `ef19e86` |
| **BF-M4** | `main.ts` 接线 + 默认开 + escalation sink | `butlerFactory` 闭包(per-user `openButlerMemory` + `openButlerRecallIndex` + `PersonalButlerAgent`)+ `AIPE_BUTLER` 默认开 + `butlerEscalationSink` 骑 async suspendNotifier | `f6ee7b0` |
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
- 每个 task 读 `task.origin.userId`(IM 桥总会盖上 = 绑定的 AipeHub 用户,**不是**原始
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

## 六、默认开(`AIPE_BUTLER`)+ 闸

- **默认开**:`AIPE_BUTLER ∈ {0,false,off,no}`(大小写不敏感)关掉;其余(含未设)开。
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
| `@aipehub/personal-memory` | 既有 + `MemorySession.refresh()` 3 个新单测(再召回 / 清 pending / 重采 `now`) | **376** |
| `@aipehub/personal-butler` | 既有(agent / governed / sensitive-memory-write) | **29** |
| host | 既有 butler 套 + `butler-router` 10 + `local-agent-pool-butler` 7 + **`butler-im-e2e` 4**(本系列承重门) | **1355**(+4 skip) |
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
  main.ts                     BF-M4 — butlerFactory 闭包 + AIPE_BUTLER 默认开 + butlerEscalationSink
packages/host/tests/
  butler-im-e2e.test.ts       BF-M5 — §五 4-claim 承重门 (新)
  butler-router.test.ts       BF-M2 (已 committed)
  local-agent-pool-butler.test.ts  BF-M3 (已 committed)
```

复用既有(零改):`personal-butler-memory.ts`(`openButlerMemory`)/ `butler-recall-index.ts`
(`openButlerRecallIndex`)/ `personal-butler-escalation.ts`(`butlerApprovalItemFor`)/
`butler-memory-service.ts`(`HostButlerMemoryService`,/me 视图读同一 rootDir)。

---

## 十、显式推迟

- **BF-M7 完整 governed 动作集**:当前管家是纯记忆(无 `governed`)。补上后,管家能替成员
  做敏感动作(删 / 花钱 / 对外发),每件走 `butlerEscalationSink` → `/me` 收件箱二次确认。
  机制已就位(sink 已接 async suspendNotifier,纯记忆形态下休眠),只差把 governed toolset
  喂进工厂 + 决定哪些动作分级成 approve。
- **BF-M8 per-user heartbeat 蒸馏 / 维护**:episodic→semantic 蒸馏(`consolidate`)+ 6h 维护
  pass(dreaming / 清输出 / SKILL.md / STATUS.md)目前在 example 里按 example 接;per-user
  在生产 host 里跑还没接(现靠 `frozenMemoryKinds:['semantic','episodic']` 让 episodic 直接
  进冻结块,不必等蒸馏)。接上后画像会被策展、记忆会被分卷 / 衰减管理。
- **可插拔沙箱终端后端**(Hermes 天花板)、**向量 / 图记忆当默认**、**管家主动发起对话**
  ——承 `PERSONAL-BUTLER-FINAL.md` §十,不在本系列范围。

---

## 关联文档

- 常驻管家收口(M1–M6):[`docs/zh/PERSONAL-BUTLER-FINAL.md`](PERSONAL-BUTLER-FINAL.md)
- 建之前设计:[`docs/zh/PERSONAL-BUTLER-DESIGN.md`](PERSONAL-BUTLER-DESIGN.md)
- 记忆多级 × 重要性:[`docs/zh/MEMORY-TIERS-FINAL.md`](MEMORY-TIERS-FINAL.md)
- 记忆五项长期增强:[`docs/zh/MEMORY-ADVANCED-FINAL.md`](MEMORY-ADVANCED-FINAL.md)
- 管家记忆四块增强(dreaming / 召回索引 / 自创·Umbrella 技能 / 6h 维护):[`docs/zh/MEMORY-DREAMING-SKILLS-FINAL.md`](MEMORY-DREAMING-SKILLS-FINAL.md)
- 持久任务:Phase 11(`SuspendTaskError` + `suspended_tasks` + resume sweep)
- 成员收件箱:Phase 16(`@aipehub/inbox` + `HostInboxService` 两步恢复)
- IM 桥:[`docs/zh/IM-BRIDGES.md`](IM-BRIDGES.md) · [`docs/zh/IM-OFFICIAL-REARCH.md`](IM-OFFICIAL-REARCH.md)
