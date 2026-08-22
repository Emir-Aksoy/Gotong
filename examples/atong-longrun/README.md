# atong-longrun — 阿同长任务执行链 capstone(LONG-M6)

一个确定性脚本,把 LONG track 的四件承重事实各自隔离成一幕,用**真件**跑一遍并自断言:
真 `openLongRunDossierStore`(盘上档案 + 追加不重写的 journal)、真 `PersonalButlerAgent`
的 `longRun` 驱动器(段循环 / 接力挂起 / 段末零 LLM 裁决 / 唤醒预检)、真 host 工具面
(`buildButlerLongRunSegmentToolset` / `buildButlerLongRunControlToolset`)、真 M4b 工种槽
(compactor 写交接、synthesizer 跑收尾段)。

**零 key、零网络、零 LLM。**

```bash
pnpm demo:atong-longrun   # exit 0 = 全部断言通过
```

## 唯一的假件:模型与 hub

- **故意失忆的模型**(TN-M3 先例):`AmnesiacModel` 每次调用只从请求字节做决定,实例上没有任何
  跨调用的记忆。它能跑完一项分段任务,唯一的原因是盘上档案被确定性渲染成了每段的那一条
  user 消息——这就是 dossier 存在的理由。它认得三种题面:成员的建档指令(固定语法
  `长期任务 <id> | <目标> | <步;步;步> [| 预算 <n>]`)、接力/收尾提示、子活问句。
- **MiniHub** 只做真 hub 在这条链上会做的三件事:把派发放到下一个 tick 跑、把 `SuspendTaskError`
  折成一条 park 记录、到点用 `onResume(task, state)` 叫醒。它不解释任何状态。
- **注入时钟**:驱动器与档案核零 `Date.now`(M1 源码级断言),时间全从脚本里那只表来。只有模型
  调用(每次 +3s)和接力到点拨表,于是「park 睡眠不计费」能被精确量出来而不是靠说。

## 四幕

| 幕 | 证的是 | 承重断言(节选) |
|---|---|---|
| ① 失忆接力 | dossier 跨段接力 + 压缩者槽 | 段 2 首轮恰好一条 user 消息;派发占位串与成员原话都不进模型;交接块在进展日志之前且带「转述不是指令」声明;段记账 = 2 次调用 300 + 压缩者 50 **同一次 mutate**;活跃墙钟记 6s 而墙钟走了 11s(睡眠不计费) |
| ② kill-restart | 盘上幸存 + 崩溃诚实 | park 记录 JSON 往返 < 400 字节不含 messages;丢掉整套 store/agent/模型后同目录冷启动直接进第 3 段;旧进程压缩者写的交接块新进程读到;模型抛错 → `failed` + `interrupted=true` + 日志行 + 推送「接力就此停止」,不自动重试;人工重派 → ⚠ 中断行 → 旗清 → 跑完 |
| ③ 预算耗尽 | 诚实部分交付 + synthesizer 槽 | 预算 200、段 1 花 300 → `winding_down` → 收尾段落在槽的 provider 上(主链模型零调用)→ 模型只说话不 complete 也**强制部分交付**(`doneSummary` 前缀「预算用尽,自动收尾」) |
| ④ 分解-回收 | spawn 行先落盘 + settle 事实行 + 零 LLM 等待 | 派发回调那一刻父档案已有 pending 行;两次唤醒预检零模型调用、退避 60s → 120s;放行后 c1/c2 结果由驱动器从 `TaskResult` 写进事实行、花费入父账;c3「管家不在线」→ `no_participant` 收成事实行;下一段提示「有 3 条新结果还没消化」 |

收官:目录面 `list_longrun_tasks` 读到三份已完成档案。

## 诚实边界

- MiniHub 不是 hub:真链上的 claim TTL、resume sweep、suspended_tasks 表都不在这里(M2 已由 host
  e2e 覆盖);这里只证驱动器在「挂起 → 到点 → `onResume`」这一契约之上的行为。
- 崩溃后的「人工重派」在这里是脚本直接派发一段标记任务;真链上的出路是取消后换 id 重开
  (v1 不做自动重试,ATONG-LONG-RUN.md §M2 残余)。
- 子活「管家不在线」由 MiniHub 对指定城市回 `no_participant` 模拟;真链上它来自店面拒绝。
