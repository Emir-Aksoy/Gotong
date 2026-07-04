# 定时工作流 — 零 LLM 调度（LIFE-L1，乙案）

> 用户诉求：让框架在**工作和生活里持续产生实际提升**，第一块砖 =「每天早上 8 点
> 替我跑晨报流，跑完发我 IM」——而且**调度环里一行大模型都不许有**（LLM 只在
> 工作流自己的步骤里跑，唤醒/判定/派发全程确定性）。
>
> Last updated: 2026-07-04 · LIFE-L1-M1→M3

---

## 一、心智图：一条环，零模型

```
<space>/workflow-schedules.json        ← 意图（人 / admin API 写）
        │  每 60s sweep（host 内置，默认开，零旋钮）
        ▼
   due 门（纯函数）── 不 due → 什么都不做
        ▼
   成员闸（与 /me「运行」完全同一道）
   published + surface.me.enabled + role + scope key 强制置为行内成员
        ▼
   hub.dispatch（run 归属该成员）
        ▼
   工作流自己跑（这里面才可能有 LLM / 人步）
        ▼
   BE-M5 运行播报 → 成员 IM（零新代码——run 归属成员，播报免费带上）
```

三条硬性质：

1. **一个闸不开第二个**。调度走的成员向解析与管家 `run_my_workflow` / 成员在
   `/me` 点「运行」是同一段代码（`evaluateRunnable`）。调度**做不出成员自己
   做不到的事**；行里手写别人的 scope key 会被服务端强制覆写回行内成员。
2. **fire = attempt**。dispatch 交给 hub 即记「已跑」（含人步的 run 可能跑几
   小时，后台 tick 不 await）；run 失败由播报讲故事（「失败 — 原因…」），
   不擅自重跑有副作用的流。只有同步 throw（hub 根本没接）才下一 tick 重试。
3. **半解析的行绝不跑**。cadence 认不出 / 字段缺失 → 该行跳过并在日志里响亮
   报告，绝不用猜出来的值跑（interval 误读成 daily 会错一整周）。唯一的钳制：
   `interval.everyMs` 低于 60s 上抬到 60s。

## 二、两个文件：意图 vs 事实

| 文件 | 谁写 | 内容 |
|---|---|---|
| `<space>/workflow-schedules.json` | 人手编辑 / admin API | 调度行数组（意图） |
| `<space>/workflow-schedules.state.json` | 只有机器 | `{ 调度id: lastFiredMark }`（事实） |

分开是故意的：手编辑意图文件永远不和机器的 mark 写竞争。state 文件丢了/坏了
退化为「从没跑过」——daily/weekly 至多当天重跑一次、interval 提前跑一次，都
好过调度被卡死。admin API 没写过的行（比如手写了一半的草稿）**原样往返**，
在列表里以 `valid: false` 呈现，绝不被销毁。

### 调度行格式

```jsonc
[
  {
    "id": "sched-morning",            // 省略则 API 代铸
    "workflowId": "wf-morning-brief", // 已发布且开了 surface.me 的工作流
    "userId": "u-emir",               // run 归属的成员（scope key 强制 = 它）
    "cadence": { "kind": "daily", "hour": 8, "tzOffsetMinutes": 480 },
    "inputs": { "topic": "科技新闻" },  // 只有 surface.me 声明过的字段会被拷贝
    "enabled": true                    // 必须字面 true，其他一律停摆
  }
]
```

三种 cadence（成员本地时间，`tzOffsetMinutes` 省略默认 +480 马来西亚）：

| kind | 字段 | 语义 | dedup mark |
|---|---|---|---|
| `daily` | `hour` 0-23 | 每天到点后（at/after）跑一次 | 成员本地 `YYYY-MM-DD` |
| `weekly` | `weekday` 0-6（0=周日）+ `hour` | 每周该日到点跑一次 | 同上（下周同日=不同日期，零周界代码） |
| `interval` | `everyMs`（≥60000） | 每隔 N 毫秒跑（首次立即） | `String(nowMs)` |

## 三、admin API（`/api/admin/workflow-schedules`）

```bash
TOKEN=<admin token>; B=http://127.0.0.1:3000/api/admin/workflow-schedules
# 列表（意图 + lastFiredMark 并排，invalid 行带 valid:false）
curl -sH "Authorization: Bearer $TOKEN" $B | jq
# 建/改（无 id 代铸；写盘的是归一化后的行——tz 默认值已填、interval 已钳）
curl -sX POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"workflowId":"wf-morning-brief","userId":"u-emir","cadence":{"kind":"daily","hour":8},"enabled":true}' $B | jq
# 删（同时清掉它的 state mark，重建同 id 从头算）
curl -sX DELETE -H "Authorization: Bearer $TOKEN" $B/sched-morning
# 手动试跑（验收用）
curl -sX POST -H "Authorization: Bearer $TOKEN" $B/sched-morning/fire | jq
```

**试跑语义**：无视 due 门**和** `enabled`（试一条还没启用的行正是它的用途），
但**成员闸不可豁免**——未发布 / 没开 surface.me 的工作流照样拒绝。试跑成功
**写 mark**：手动跑过的 daily 行当天不会再自动跑（interval 行重开计时窗）。

失败映射：`not_found` 404 · `invalid` / `unrunnable` 409（盘上行或其工作流
按配置拒绝——修配置再试）· `dispatch_failed` 500。upsert 对归一化失败的行
回 400 `invalid_schedule`：**host 拒绝存下它拒绝跑的东西**。

## 四、失败姿态一览

| 情况 | 行为 |
|---|---|
| 意图文件不存在 | 免费 no-op（功能不用就零成本，所以默认开、零旋钮） |
| 意图文件整体坏 | 什么都不跑 + error 日志（fail closed） |
| 单行半解析 | 跳过该行 + warn，其余行照跑 |
| due 但工作流不可跑 | 每 tick warn（保持可见），**不写 mark**——发布后当天还能补跑 |
| 工作流目录 list() 故障 | 本 tick 什么都不派（fail closed，绝不盲派） |
| dispatch 同步 throw | 不写 mark，下一 tick 重试 |
| run 异步失败 | 播报讲故事，不重跑（fire = attempt） |
| state 文件丢/坏 | 退化「从没跑过」：至多当天重跑一次，好过永久卡死 |

## 五、边界（故意不做的）

- **不是 cron**。晨报 / 周报 / 每 N 分钟哨兵三种 cadence 覆盖成员真实诉求；
  cron 库会带进解析器 + 它自己的时钟假设。要更怪的节奏，先想想是不是该改成
  事件驱动（工作流步里等外部信号）。
- **单机文件、管理面 last-write-wins**。这是单操作员控制台不是并发存储；
  sweep 只读意图文件，CRUD 永远不和 sweep 的 state 写竞争（唯一良性重叠：
  手动试跑撞上同瞬 tick，最坏一次重复 run——与 state 丢失同姿态）。
- **播报是 BE-M5 的**。每成员默认关，IM 里 `set_run_broadcast` 打开；本层
  零播报代码。

## 六、指针

- 工作流本身怎么建：[`WORKFLOW-ARCHITECT.md`](WORKFLOW-ARCHITECT.md) ·
  [`WORKFLOW-WIZARD.md`](WORKFLOW-WIZARD.md)
- 管家播报 / 观察面：[`ledger/BUTLER-EMPOWER-FINAL.md`](ledger/BUTLER-EMPOWER-FINAL.md)
- 上线后让 hub「每天干活」：[`GO-LIVE.md`](GO-LIVE.md)
- 代码：`packages/host/src/workflow-schedule-{core,sweeper,admin}.ts` ·
  `packages/web/src/workflow-schedule-routes.ts`（各文件头注有完整设计故事）
