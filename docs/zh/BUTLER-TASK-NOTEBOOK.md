# 管家任务笔记本 track(TN)—— 弱模型也能跨轮把事办完

> 北极星第 1 层「我的 AI 桌面」的稳定性抓手:把管家的多步使命从「靠模型脑内记」
> 换成「靠磁盘文件记」。**用户拍板(2026-07-08):这是管家智能体的能力,不是框架
> 能力** —— 全部落在管家层,内核零改动。
>
> Last updated: 2026-07-08 · M0 计划 + M1 纯核+工具+复述缝 + M2 卡壳提醒已完;
> M3 capstone 待做。

---

## 一、为什么(缺口)

管家今天是**纯反应式的有界 tool-loop**:一条 IM = 一个 Task = 一轮工具循环,默认
最多 **8 轮**工具调用(`packages/llm/src/agent.ts` 默认,butler 未覆写),超限当轮
截断。跨轮状态只有两条路:记忆召回(重建靠模型自己猜「做到哪了」)或升格成正式
工作流(重,要建流)。中间缺一层:**轻量、个人、跨轮的任务清单** ——「帮我筹备
下周聚会」这种 5 步、跨几天、要几轮对话的使命,今天当轮结束状态就散了。

对**弱模型**(用户不一定用最好的模型)这个缺口最疼:「在上下文里记住 8 步计划撑
20 轮」需要强长程注意力;「读笔记本 → 做一步 → 勾掉」只需要小而有界的单步推理。
把计划外置到文件,是把认知负担从模型搬到磁盘 —— 这正是本框架「状态都是磁盘文件」
守则在任务层的延伸。

## 二、市场真相(先查市面,2026-07 核)

- **Hermes Agent**(Nous Research,4.7 万星):**内置 `todo` toolset**(会话内任务
  列表 + 显式计划),官方姿态「3+ 次工具调用、有分支/循环就该上 todo」;对弱模型的
  答案是**硬拒绝**(上下文 <64K 启动时不让跑)—— 靠门槛解决,不靠设计解决。
- **OpenClaw**(最新版):从早期「聪明模型 + markdown」**长出了显式任务机制** ——
  Task Flow(多步编排)、Background Tasks 账本(`openclaw tasks list|audit`)、
  Inferred Commitments(短期承诺记忆)、HEARTBEAT.md 新增 `tasks:` 到期块。
- **Manus recitation**(公开的 context-engineering 经验):不停重写 todo.md 把全局
  计划复述进注意力近端,防长循环目标漂移。

三家收敛到同一结论:**显式任务账本是长任务稳定性的地板**。我们的差异化:推进判定
可以**零 LLM**(卡壳分诊是纯时间戳比较),Hermes 的 todo 是会话内的、我们的跨会话
持久 —— 「框架不跑 LLM」+ file-first 在任务层的组合拳。

## 三、三条不可破边界

1. **管家层,不进内核**(用户拍板)。纯核在 `packages/personal-butler`(host-free,
   例子可直接用),装配在 host 的 `personal-butler-*` 家族文件;`core` / `workflow` /
   `protocol` / identity schema **零改动**。这不是框架级任务队列 —— 是管家的私人
   笔记本,别的 participant 想要同款自己写自己的。

2. **笔记本 ≠ 授权**(接入≠授权 在任务层的延伸)。记下一步 ≠ 授权执行那一步:
   governed 动作照样 park 进 `/me` 审批;卡壳提醒**只提醒**(「要继续吗?」),
   **绝不自动替成员执行下一步** —— 推进只发生在成员发起(或回复)的对话轮里。
   决策权永远在参与者(宪章三句话之一)。

3. **笔记本 ≠ 第二个工作流引擎**。无 DAG、无步骤依赖、无调度器、无自动执行环。
   要多参与者/结构化/版本化 → 管家已有 `create_workflow`;要定时 → 已有
   `set_reminder` / workflow schedules。工具描述里显式指路,防止模型拿笔记本硬凑
   工作流的活。

## 四、设计(全部复用既有缝,零新机制、零新 env 旋钮)

```
文件      <memoryRoot>/user/<userId>/tasks.json         笔记本本体(机器单写者=管家轮)
          <memoryRoot>/user/<userId>/tasks-nudges.json  提醒 fact 标记(单写者=巡检)
          —— intent/fact 分文件镜像 workflow-schedules 纪律,两个写者结构性不打架;
          路径经 ownerDir(与 STATUS.md/SKILL.md 同一安全解析)。
          坏文件 → 改名隔离 tasks.json.corrupt-<ts> + warn,绝不静默清数据;
          上限(开放任务数/步数/文本长)显式拒,no silent caps。
纯核      packages/personal-butler/src/task-notebook.ts:
          openTaskNotebook({file}) → { list/open/update/close/digest }
          createTaskNotebookToolset(notebook) → 4 个 benign 工具:
            open_task_note / update_task_note / close_task_note / list_task_notes
          (服务端校验一切输入;模型永不自由编辑文件)
复述缝    digest() = 每条进行中任务一行「标题 — 下一步」,≤5 行,空 = null;
          经 composeContextProbes(onboarding 探针, digest) 走 CARE-M4 既有
          contextProbe 注入 system prompt 尾部 —— 冻结块缓存前缀不动,
          没任务 = null = prompt 字节不变(opt-in 自然成立)。
推进缝    TN-M2:纯分诊函数(open && now-updatedAt>3d && 冷却期外,零 LLM)+
          镜像 ButlerProactiveSweeper 形状的小巡检,模板文案经既有投递缝发 IM。
隔离      per-user store 按目录构造,隔离 by construction(同记忆命名空间姿态)。
```

**为什么 benign 不设开关**:笔记本是「给自己记清单」级自助(同 `set_reminder`),
无凭证、无外部服务、无出网;管家本体已是 opt-in,不用笔记本的成员没有文件、没有
digest、prompt 字节不变 —— 「有门槛的动作设为可选」的用户法则管的是有门槛的动作,
这里没有门槛。

## 五、里程碑

| 里程碑 | 交付 | 状态 |
|---|---|---|
| **TN-M1** | 纯核 `task-notebook.ts`(store + digest + 4 工具)+ factory 接线(benign + composeContextProbes) | **完**(`7169d13`) |
| **TN-M2** | 卡壳零 LLM 提醒:纯分诊 + 镜像 proactive 的巡检 + IM 投递(只提醒不执行) | **完**(`fb177ba`) |
| **TN-M3** | capstone `examples/butler-task-notebook`:「失忆」provider 每轮只做一步、全靠 digest 知道进度,证 5 步使命跨 5 轮独立 task 完成 + 重启不丢 + governed 步照 park;self-assert exit 0 + 文档收尾 | 计划 |

## 六、里程碑记录

### TN-M1 —— 纯核 + 4 工具 + 复述缝(2026-07-08,`7169d13`)

- **纯核** `packages/personal-butler/src/task-notebook.ts`(host-free,零新依赖):
  `openTaskNotebook({file})` 懒加载 + 缓存 + promise 链串行化;落盘
  `{v:1, nextId, tasks}`,`nextId` 持久化故 id(`tn-<n>`)跨重启永不复用;
  tmp+rename 原子写;**坏文件改名隔离** `tasks.json.corrupt-<ts>` + warn 后全新
  起步,绝不静默清数据、绝不炸轮。上限全显式
  (`TASK_NOTEBOOK_LIMITS`:开放任务 20 / 步 20 / 标题 120 / 步文本 200 /
  备注 500 / digest 5 行),拒绝走三个新错误码
  (`task_note_not_found` / `task_note_invalid` / `task_note_limit`)。
- **4 个 benign 工具** `createTaskNotebookToolset`:`open_task_note` /
  `update_task_note`(勾步/加步/换备注/改题)/ `close_task_note`(done|dropped)/
  `list_task_notes`;与 `set_reminder` 同类(改自己的单子不碰别人),故不设
  开关;工具描述内嵌边界指路(多参与者→`create_workflow`,定时→`set_reminder`);
  一切拒绝以友好 isError 文本返回给模型,永不 throw 掉整轮。
- **复述缝** `digest()`:标题行「进行中 N 条」+ 每条
  `- [tn-x] 标题(a/b 步) 下一步: <首个未勾步>`(全勾完→提示可收尾),
  超 5 条截断加「(还有 N 条,用 list_task_notes 查看)」;
  `composeContextProbes(...probes)` 组合 onboarding 现状卡 + digest 走 CARE-M4
  既有 `contextProbe` 缝进 system prompt 尾部 —— 病探针逐个隔离(单个 throw
  不连累其余),全 null → null → **没任务的成员 prompt 与今天字节不变**。
- **host 接线**只动 `personal-butler-factory.ts`:笔记本文件
  `<memoryRoot>/user/<userId>/tasks.json` 经 `ownerDir`(与 STATUS.md 同一安全
  解析);工具挂 benign 组;`contextProbe` 从单探针换 composeContextProbes。
  内核(core/workflow/protocol/identity)零改动,零新 env 旋钮。
- **验收**:personal-butler 21 新单测(round-trip / 重启 id 单调 / 坏文件隔离
  两式 / 上限拒绝 + close 释放槽位 / digest 帽与提示语 / 工具面 happy path 与
  isError 纪律 / 探针组合三式)包 52 全绿;host 接线测试 1 例(真
  `buildButlerFactory` × scripted provider:4 工具进 `req.tools`、文件落成员
  命名空间、**次轮 system 带【任务笔记本】+ 下一步**、他成员不串台)host 1912
  全绿;四门 PASS(旋钮仍 106,行数预算零动)。

### TN-M2 —— 卡壳任务零 LLM 提醒巡检(2026-07-08,`fb177ba`)

- **纯核三件**(`task-notebook.ts` 追加,零新依赖):`readTaskNotesSnapshot`
  只读快照(缺/坏文件 → `[]` 且**绝不改名绝不写** —— 隔离权归管家轮这个唯一
  写者,巡检读到坏文件只跳过);`triageStalledTaskNotes` 纯分诊
  (open && 停满 `stallMs` && 每任务冷却期外,最卡的排前;`pruneIds` 把已收
  尾/消失任务的标记剪掉,fact 文件永不膨胀);`formatTaskNudgeMessage` 模板
  文案(**只问不做**,面向成员不提工具名)。`TASK_NUDGE_DEFAULTS` = 停摆 3d /
  冷却 3d / 单条信最多列 3 件(超出显式「还有 N 件也停着」,no silent caps)。
- **host 巡检** `personal-butler-task-nudge.ts`:`ButlerTaskNudgeSweeper` 镜像
  proactive 形状(枚举 `user/*` + 重入护 + 逐成员 best-effort),6h 常量节律
  (停摆阈值以天计,更密无意义);**只写自己的 fact 文件** `tasks-nudges.json`
  (intent/fact 分文件,与管家轮双写者结构性不打架);投递走懒
  `pushToMember`(CARE-M8 outbox 在后),**送达才记标记**、桥断下个 tick 重试;
  只标记实际列出的任务,溢出的下轮排队。
- **接线**:`armButlerSweeps` 加可选 `taskNudge` 门(不传 = 既有调用点字节
  不变);main.ts 骑管家总开关(`butlerDefaultOn`),压 2 行注释净零行
  (预算 2990/2990 顶格不动)。**无逐成员 opt-in 文件**:笔记本里只有成员
  自己开的事,门槛在开任务时已迈过;冷却限频,让管家收掉任务即永久静音。
- **边界**:提醒**绝不代执行**步骤 —— 推进只发生在成员发起(或回复)的对话
  轮里,governed 步照 park(笔记本≠授权在提醒沿的落点)。
- **验收**:personal-butler 7 新单测(分诊边界含 ≥ 恰好线 / 冷却压制与释放 /
  剪枝 / 文案纪律含不提工具名 / 快照对坏文件零副作用)包 59 全绿 + host 7 新
  单测(提醒→标记→冷却环 / 投递失败不标记且重试 / 坏笔记本跳过不隔离 /
  收尾后剪枝 / 3 件帽只标已列 / 多成员互不干扰)host 1919 全绿;四门 PASS
  (旋钮仍 106)。

## 七、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 管家本体(有界治理 tool-loop + park/resume) | [ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md](ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md) |
| 记忆引擎(冻结块/召回/dreaming/技能) | [ledger/MEMORY-TIERS-FINAL.md](ledger/MEMORY-TIERS-FINAL.md) 等 |
| 定时工作流(intent/fact 分文件 + 零 LLM sweeper 的纪律源头) | [WORKFLOW-SCHEDULES.md](WORKFLOW-SCHEDULES.md) |
| 管家可靠性(CARE:contextProbe 缝 M4 · outbox 投递 M8) | [PROGRESS-LEDGER.md](PROGRESS-LEDGER.md) |
