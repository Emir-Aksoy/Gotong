# 管家任务笔记本 track(TN)—— 弱模型也能跨轮把事办完

> 北极星第 1 层「我的 AI 桌面」的稳定性抓手:把管家的多步使命从「靠模型脑内记」
> 换成「靠磁盘文件记」。**用户拍板(2026-07-08):这是管家智能体的能力,不是框架
> 能力** —— 全部落在管家层,内核零改动。
>
> Last updated: 2026-07-08 · 计划中(M0 本文档;M1 纯核+工具+复述缝 / M2 卡壳提醒 /
> M3 capstone 待做)。

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
| **TN-M1** | 纯核 `task-notebook.ts`(store + digest + 4 工具)+ factory 接线(benign + composeContextProbes) | 计划 |
| **TN-M2** | 卡壳零 LLM 提醒:纯分诊 + 镜像 proactive 的巡检 + IM 投递(只提醒不执行) | 计划 |
| **TN-M3** | capstone `examples/butler-task-notebook`:「失忆」provider 每轮只做一步、全靠 digest 知道进度,证 5 步使命跨 5 轮独立 task 完成 + 重启不丢 + governed 步照 park;self-assert exit 0 + 文档收尾 | 计划 |

## 六、里程碑记录

(逐里程碑收口时填。)

## 七、相关文档

| 想知道什么 | 读哪 |
|---|---|
| 管家本体(有界治理 tool-loop + park/resume) | [ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md](ledger/PERSONAL-BUTLER-FOLD-IN-FINAL.md) |
| 记忆引擎(冻结块/召回/dreaming/技能) | [ledger/MEMORY-TIERS-FINAL.md](ledger/MEMORY-TIERS-FINAL.md) 等 |
| 定时工作流(intent/fact 分文件 + 零 LLM sweeper 的纪律源头) | [WORKFLOW-SCHEDULES.md](WORKFLOW-SCHEDULES.md) |
| 管家可靠性(CARE:contextProbe 缝 M4 · outbox 投递 M8) | [PROGRESS-LEDGER.md](PROGRESS-LEDGER.md) |
