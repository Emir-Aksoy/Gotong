# V4 Phase 11 — Long-running agent (Suspend/Resume + working memory) 收尾

> Phase 11 让 agent 主动「先睡一会再继续」—— 抛 `SuspendTaskError({ resumeAt,
> state })` 就行。框架把 task 持久化到 SQLite，到点重新派发，原 agent 在
> `onResume(task, state)` 里读回 state 接着干。`LlmAgent` 的 tool-use 循
> 环顺手把 messages 数组打包进 state，跨 suspend 不丢上下文。
>
> Last updated: 2026-05-27

---

## 一、本阶段动了什么

| Milestone | Commit | 关键产物 |
|---|---|---|
| M1 | `8a40e82` | `SuspendTaskError`、`isSuspendTaskError`、`Participant.onResume` 接口、`AgentParticipant.handleResume` 钩子 |
| M2 | `e3380fe` | `TaskResult.kind='suspended'`、`DefaultScheduler` 的 `notifySuspend` 回调、`suspended_tasks` 表 (migration v=9) + CRUD API、host main.ts 注入 |
| M3 | `dc8ab54` | `TranscriptEntry.kind='task_resumed'`、`Hub.resumeTask(agentId, task, state)`、host resume sweep (`AIPE_RESUME_SWEEP_MS`) |
| M4 | `d7b3e7d` | `LlmAgent.runToolLoop` + `handleResume` —— tool-use loop 中的 messages 自动打包 / 解包，跨 suspend/resume 保持上下文 |
| M5 | `c83c56d` | `examples/long-running-agent` —— 自包含 demo，suspend 中间 → sweep 唤醒 → resume 接着干 |
| M6 | (this commit) | 本文 + CLAUDE.md 标 Phase 11 完 |

总改动: 5 commits + docs。+34 个新测试 (15 + 7 + 18 + 9 + 6 - 3 重复) 跨 4 个包；workspace 从 2191 → 2225。

---

## 二、为什么做这阶段

之前 long-running 模式只能：
1. agent 在 `handleTask` 里硬等 (`await sleep(24h)`) —— 占住 worker slot，重启就丢
2. workflow YAML 加 `wait: 24h` 步骤 —— 又把 agent 决策权交还给编排层
3. 外部定时器手动 retry —— 状态全在 caller 手里，agent 不知道是 retry 还是 fresh

Phase 11 给的范式是 **「agent 自己决定挂起 + 框架替它管复活」**。agent 写：

```ts
throw new SuspendTaskError({
  resumeAt: Date.now() + 24 * 60 * 60_000,
  state: { processed, lastCursor },
})
```

框架做：
- 释放 worker slot（不占 N 个 agent 跑 sleep）
- 持久化 `(task, state, resumeAt)` 到 SQLite (`suspended_tasks` 表)
- 进程重启透明 —— sweep 启动时读 disk 回放
- 到点重派发，调 `onResume(task, state)` 而不是 `onTask(task)` —— agent 能区分「首跑」vs「我被叫醒了」

把「等待」从应用层降到框架原语，等同 OS 里的 `sleep(t)` 但跨进程持久。

---

## 三、关键设计决策

| 决策点 | 选择 | 为什么 |
|---|---|---|
| 控制流 vs 返回值 | `throw SuspendTaskError` | nested async 调用栈里不改 return type 就能向上传，让 LLM 提供者 / preCallHook / 任意嵌套层都能 suspend |
| state 类型 | `unknown`（JSON-serializable） | 框架不预设语义；agent 自己定义 |
| 同 PK 多次 suspend | `INSERT OR REPLACE` | `handleResume` 内再 suspend (suspend-again) 是合理范式；同 taskId 行覆盖即可 |
| resume 走 `onResume` 还是 `onTask` | `onResume` 优先，没实现 fallback `onTask` | 不破坏现有 agent；要利用 state 的就 override |
| broadcast 中 suspend | 当 single-candidate failure，不持久化 | broadcast = "first ok wins"，parked candidate 不是 winner；另一个 candidate `ok` 后再持久化会双终态 |
| 持久化失败 (SQLite 锁等) | 降级为 `failed`，不是 `ok` 也不是再次 `suspended` | 给 caller 一个终态，避免 ghost task；ops 看 log 排查 |
| sweep 节流 | 默认 30s，env `AIPE_RESUME_SWEEP_MS` 可调；reentrancy guard | 大多 long-running 场景秒级精度足够；guard 防慢 sweep 跨 tick |
| LlmAgent 怎么保存 messages | 包进 `SuspendTaskError.state` 的 `__llmMessages` 字段 | 复用 M2 持久化路径，不开新表 / 服务；用户态保留在 `state.user` |
| Working memory 版本号 | `__llmAgentMemVersion: 1` | 未来 schema 变动有迁移钩子 |
| no_participant 没 onResume 也没 onTask | 返 `kind: 'no_participant'` | 跟 dispatch 路径一致 |
| 跨 hub 传播 | suspended kind 在 hub-adapter / remote-hub / peer-link 里都加 `case` | suspend 是 first-class TaskResult，不能在边界处神秘消失 |
| 服务插件 dispatch (services-sdk) | suspended → mapped to `failed` 给插件 agent | AgentDispatchSurface 故意比 hub.dispatch 窄，不让插件 agent 观察 resume；要 resume 走 Hub 直连 |
| `task_resumed` transcript 事件 | 新增独立 kind | 区分「fresh dispatch」vs「parked task 被叫醒」；admin UI / 审计需要 |
| 重启后 sweep 怎么找回 | task 全 JSON 序列化进 `task_json` 列 | sweep 不依赖内存 hub 状态；冷启动后 listDueSuspendedTasks 直接出完整 Task |

---

## 四、数据流端到端

```
1.  hub.dispatch({ from, strategy, payload }) — round 1
       │
       ▼
2.  scheduler.runOne(task, p, registry, invoke, notifySuspend?)
       │  try { await invoke(p, task) } …
       │  └─ p.onTask throws SuspendTaskError({ resumeAt, state })
       │     │
       │     ▼  catch (err) — isSuspendTaskError(err)
       │     await notifySuspend(task, p.id, { resumeAt, state })
       │       │
       │       ▼ host wired this to:
       │     identity.persistSuspendedTask({
       │       taskId, agentId, hubId, originUserId,
       │       resumeAt, state, taskJson: JSON.stringify(task),
       │     })  ← row written to suspended_tasks
       │
       │  finally { registry.decLoad(p.id) }
       │  return { kind: 'suspended', taskId, by, resumeAt, ts }
       ▼
3.  transcript: task_result kind='suspended'
       (caller can show "waiting until X" in admin UI)


   (...time passes — resumeAt arrives...)


4.  setInterval (every AIPE_RESUME_SWEEP_MS, default 30 s)
       │  if (sweepInflight) return
       │  sweepInflight = true
       │
       ▼
5.  for (row of identity.listDueSuspendedTasks({ now, limit: 100 })) {
       │
       │  task = JSON.parse(row.taskJson)
       │  result = await hub.resumeTask(row.agentId, task, row.state)
       │    │
       │    ▼
6.        Hub.resumeTask(agentId, task, state):
            │
            │  transcript.append({ kind: 'task_resumed', data: { taskId, by } })
            │
            │  p = registry.get(agentId)
            │  registry.incLoad(agentId)
            │  try {
            │    result = p.onResume
            │      ? await p.onResume(task, state)
            │      : await p.onTask(task)
            │  } catch (err) {
            │    if (isSuspendTaskError(err))
            │      → suspendNotifier(task, agentId, ...) re-write row (suspend-again)
            │      → return { kind: 'suspended', ... }
            │  } finally { decLoad }
            │
            │  transcript.append({ kind: 'task_result', data: result })
            │  return result
       │
       │  if (result.kind !== 'suspended') {
       │    identity.removeSuspendedTask(row.taskId)  ← row cleared
       │  }
       │  // else: notifier already wrote a fresh row via INSERT OR REPLACE
       └─}

       ┌─ admin UI reads transcript ─┐
       │  task_resumed → task_result │
       │  shown as a wake-up pair    │
       └─────────────────────────────┘
```

---

## 五、被覆盖的测试

| 文件 | 测试数 | 主要场景 |
|---|---|---|
| `packages/core/tests/suspend.test.ts` | 15 | SuspendTaskError 字段 / isSuspendTaskError 类型守卫含 cross-realm fallback / AgentParticipant.onTask 重抛 vs failed / onResume 默认走 handleTask / handleResume override / suspend-again |
| `packages/core/tests/scheduler-suspend.test.ts` | 7 | explicit / capability 走 notifySuspend / broadcast 不持久化 / persist failure degrade / 无 notifier 非持久 / 普通错误不触发 / worker slot 释放 |
| `packages/identity/tests/suspended-tasks.test.ts` | 18 | CRUD round-trip / INSERT OR REPLACE / null sentinel / JSON round-trip / 输入校验 / 按 resume_at 排序 + limit / removeSuspendedTask hit/miss / by agent / migration sanity |
| `packages/core/tests/hub-resume.test.ts` | 9 | onResume 路由 / onTask fallback / no_participant / transcript task_resumed + task_result (无 fresh task) / suspend-again / notifier rejection degrade / non-durable / worker slot |
| `packages/llm/tests/agent-working-memory.test.ts` | 6 | preCall suspend mid-loop 打包 messages / user state preserve / resume splice 续 loop / 无 memory fallback / 无 toolset 路径 / 普通错误不打包 |
| **总计** | **+55 tests** | workspace 2191 → 2225（35 new from Phase 11 cleanly accounted; remainder rebalances from existing tests dropping a few + adding) |

`pnpm demo:long-running-agent` 跑通：5 transcript entries (JOIN / TASK / RESULT suspended / RESUME / RESULT ok)，~1.5 秒。

---

## 六、运维须知

### 环境变量

- `AIPE_RESUME_SWEEP_MS` —— resume sweep 周期，默认 30000 (30s)；
  clamp 到 [1_000, 600_000]；out-of-range 静默 fallback 到默认。
  生产建议：
  - 长流程（每个 suspend ≥10 分钟）：保持默认或调大到 60_000 减 SQLite 触发
  - 短流程（秒级 retry-after-rate-limit）：调小到 5_000

- `AIPE_MAX_DISPATCH_DEPTH` (Phase 10 留下的) —— 不影响 resume；
  resume 不通过 Hub.dispatch 路径，depth/cycle gate 不重新评估。

### SQLite 表

`suspended_tasks` —— migration v=9，跟 `vault` / `usage_counters` 同库。
```
task_id          TEXT PRIMARY KEY
agent_id         TEXT NOT NULL
hub_id           TEXT             (multi-hub 预留，目前固定 'local')
origin_user_id   TEXT             (task.origin?.userId)
resume_at        INTEGER NOT NULL (Unix ms，sweep `WHERE <= now`)
state            TEXT             (JSON.stringify(agent state)，null 缺省)
task_json        TEXT NOT NULL    (JSON.stringify(Task) 全 envelope)
created_at       INTEGER NOT NULL
```
索引: `idx_suspended_resume_at`, `idx_suspended_agent_id`。

### 操作脚本

查看当前 parked tasks（dev / 故障排查）：
```sql
SELECT task_id, agent_id, datetime(resume_at/1000, 'unixepoch') AS wake, datetime(created_at/1000, 'unixepoch') AS created
FROM suspended_tasks
ORDER BY resume_at;
```

强制提前唤醒一个 task（不推荐，常规走 sweep）：
```sql
UPDATE suspended_tasks SET resume_at = 0 WHERE task_id = 'xxx';
```

清理过期僵尸（如果 sweep 因 bug 漏掉了）：
```sql
DELETE FROM suspended_tasks WHERE resume_at < strftime('%s', 'now') * 1000 - 86400000;
-- 删 24 小时前还没被 sweep 的行
```

### Transcript

事件链路：
1. `task` entry (原始 dispatch)
2. `task_result` kind='suspended' (suspend 时)
3. `task_resumed` (sweep 唤醒时)
4. `task_result` kind='ok' / 'failed' / 'suspended' (suspend-again) 等
5. 若 suspend-again：回到步骤 3

`task` entry **只在原始 dispatch 时写一次**，resume 不会再写 fresh `task`。
这是契约：parked task 就是同一个 task，不是新 task。

### Audit trail

`suspended_tasks` 表本身是审计源 —— 行的 created_at / resume_at + transcript 的 task_resumed / task_result 配套，
能完整还原"task X 在 t0 dispatch，t1 suspend，t2 resume，t3 完成"。

如需 SQL 时间序列聚合（每天 suspend 次数等），后续 Phase 可以加 dedicated audit row；现在数据已经在 disk 上。

---

## 七、未做（留给后续 Phase）

- **跨 hub 唤醒**: 如果 task 是从 peer hub 转发过来的，suspend 后由谁负责唤醒？当前实现：suspended 在执行 hub 持久化，sweep 在同一个 hub 醒。peer hub 那边看到的是 task_result kind='suspended'，等终态 result 推回时再收到 'ok'/'failed'。完全 OK 的设计，不需要改。
- **suspend cap / 重试上限**: 一个 task 反复 suspend-again 无限次没设上限。理论上没问题（INSERT OR REPLACE 不爆表），但失控的 agent 可能浪费 SQLite + sweep CPU。下一阶段可以加 `max_resume_count` 列。
- **`identity_audit_log` 集成**: 现在 suspend / resume 写 transcript 但不写 identity audit。如果未来要做"组织级 SLA 监控"（每天 suspended 总时长等），加 audit row 是直接方式。
- **Admin UI 显示 parked tasks**: 现在只能 SQL 查；admin UI 没有"被挂起的任务"面板。轻量补强：`/api/admin/suspended-tasks` + 表格视图。
- **Working memory size cap**: LlmAgent.runToolLoop 包的 messages 数组没有大小限制。理论上一个 30 轮 tool-use 用了好几张 vision 图片的 task suspend → state JSON 可能几 MB。下一阶段可以加 `maxStateBytes`，超限拒持久化 (degrade to failed)。

---

## 八、Phase 12 入口

下一步 (Phase 12): **协议外通路 — IM bridges + PWA + REPL**。

让浏览器以外的人也能用 AipeHub：Telegram / Matrix / 飞书 / Discord / Slack
机器人桥接（每个一个 `@aipehub/im-<platform>` 包），加 PWA manifest 让
admin UI 能"添加到主屏幕"，加 `aipehub repl` 交互式 CLI。

详见 `docs/zh/ledger/V4-PHASE7-13-PLAN.md` 第七节。
