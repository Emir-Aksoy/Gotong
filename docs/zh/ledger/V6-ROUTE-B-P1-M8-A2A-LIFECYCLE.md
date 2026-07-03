# Route B P1-M8 — A2A 任务生命周期（suspend → Task → tasks/get）

> 一句话：把 A2A 从「阻塞 `message/send`，一旦 suspend 就直接回 `-32001`」扩成
> **`message/send`(→Task) + `tasks/get` 轮询** —— 跨组织的长任务 / HITL 审批不再
> 在第一个往返里断掉，调用方拿一个**不透明任务句柄**轮询到终态。

Last updated: 2026-06-03

---

## 背景（为什么做）

Phase 18 把 A2A 闭环跑通，但**只做了阻塞 `message/send`**：受端 hub 一旦 `dispatch`
挂起（长算 / 等人审批），就只能回 JSON-RPC `-32001 SUSPENDED` —— 调用方除了「失败」
什么都拿不到，跨 hub 的长任务 / HITL 等于断路。Phase 18 的「显式推迟」里写明
`tasks/get` lifecycle 留待后续。M8 就是补这一刀。

A2A 0.2.5 的标准模型正是为此：受端可以回一个 **`Task`**（状态 `working`）而不是
`Message`，调用方再用 **`tasks/get`** 按句柄轮询，直到 `completed` / `failed`。

**北极星对齐**：人和 agent 是同一个 `Participant`，HITL 审批步骤本质是「派 Task 给
一个代表收件箱的 Participant，它挂起，人在 `/me` 处理后恢复」（Phase 16）。M8 让这套
挂起/恢复**跨 hub 也能观测** —— 受端 hub 挂起的那个 task，发起端 hub 能隔着 A2A 线
看到它从 `working` 走到 `completed`。

---

## 关键设计决策

1. **恢复结果走「被动读 transcript」，不加 resume-completion notifier。**
   现状（Explore 核实）：participant 抛 `SuspendTaskError` → scheduler 回
   `{kind:'suspended'}` + suspendNotifier 落 `suspended_tasks` 行；resume sweep
   只看 `result.kind !== 'suspended'` 决定删行，**丢弃**恢复后的真结果；没有
   resume-completion 推送。恢复结果的权威读法是 **`hub.taskResult(taskId)`** —— 它
   扫 transcript 返回该 task 的最新 result。`tasks/get` 就用它：零新 core hook，
   transcript 仍是唯一真相源。（被否的另一路：加一个 resumeNotifier 主动推 —— 更
   重，且把「观测」耦进「恢复」。）

2. **A2A Task `id` 是服务端铸的不透明句柄，永远不是内部 hub task id。**
   回内部 id 会泄漏 hub 命名规则，更糟的是让一个 peer 能拿着它去轮询**别的组织**的
   任务。M8b 用 `randomUUID()` 铸句柄，存一张内存表 `opaqueId → {hubTaskId, peerId,
   createdAt}`。

3. **`tasks/get` 强制归属隔离，fail-closed 反枚举。**
   校验 `record.peerId === 认证 peerId`。未知 id **和**「存在但属于别的 peer」的 id
   **都**回 `TASK_NOT_FOUND(-32001)` —— 绝不泄漏「这个 id 在别的组织名下存在」。

4. **任务表只在内存，重启即丢 —— 诚实优先。**
   句柄背后的 hub task 本身可能也没活过重启（in-mem hub / 未持久的挂起）。持久化一个
   指向可能不存在的 hub task 的句柄是「上一句陈旧的谎」。重启后 `tasks/get` 回
   `TASK_NOT_FOUND`，调用方重发即可。带 TTL（1h）+ 硬上限（1万，超了按插入序逐出）。

5. **`-32001` 收敛成纯 `TaskNotFound`，删掉 `SUSPENDED`。**
   M8a 时 host 还在 emit `SUSPENDED`（同值 `-32001`），故先标 `@deprecated` 并存；
   M8b host 改回 `Task` 后，`A2A_ERROR.SUSPENDED` 整个删掉 —— `-32001` 现在只表
   `TaskNotFound`（= A2A 0.2.5 语义），不再一码两义。

---

## 里程碑

| 里程碑 | commit | 内容 |
|---|---|---|
| **M8a** | `72f60bd` | `@aipehub/a2a` **wire 类型 + tasks/get client**。`A2ATask`/`A2ATaskStatus`/`A2ATaskState`（`working`/`completed`/`failed` + `submitted`/`input-required`/`canceled` 前向兼容）+ `A2A_TERMINAL_TASK_STATES` + `isTerminalTaskState`/`isA2ATask` 判别器；`A2A_METHOD_TASKS_GET` + `tasks/get` 请求类型；`A2AResponse.result` 拓宽 `A2AMessage \| A2ATask`；构造器 `workingTask`/`completedTask`/`failedTask`/`buildTasksGetRequest`；`A2A_ERROR.TASK_NOT_FOUND=-32001`。client 抽共享 `postA2a`；新 `a2aSendRaw`（回原始 `Message\|Task`）+ `a2aGetTask`（单次 `tasks/get`）；`a2aSend` 遇 Task 抛 `A2aClientError` 带 `.taskId`。+12 测试。 |
| **M8b** | `147b2b7` | host **A2aServer suspend→Task(working) + tasks/get + per-peer 任务存储**。`hub` widen 到 `Pick<Hub,'dispatch'\|'taskResult'>`；内存表 `opaqueId→{hubTaskId,peerId,createdAt}` + TTL/cap prune；suspend → 铸 opaque id + 回 `workingTask`；`handle()` 按 method 分流，`tasks/get` 校验归属 → `taskResult` 映射（parked/未记→`working`，ok→`completed`+text，failed/cancelled/no_participant→`failed`）；删 `A2A_ERROR.SUSPENDED`。+6 测试（含跨 peer 归属隔离）+ 改 2 旧测。 |
| **M8c** | （本提交） | **真 Hub + loopback HTTP 生命周期验收门** + 收口文档。`a2a-lifecycle-e2e.test.ts`：真 `Hub`（in-mem suspendNotifier 捕获挂起）+ 真 `A2aServer` + `http.createServer`（临时端口），用真 a2a client 跑全程；resume 手动触发（不靠 30s sweep，零 timing flake）。 |

---

## 数据流（一次跨 hub 长任务）

```
发起端 (caller hub / 任意 A2A 客户端)            受端 hub B (A2aServer + 真 Hub)
─────────────────────────────────             ────────────────────────────────────
a2aSendRaw(url, token, text,                   POST /a2a  {message/send}
  {peerId, metadata:{skill}})  ───────────▶    auth: X-Aipe-Peer-Id + Bearer
                                                  → resolvePeerToken 常量时间比 (401 fail-closed)
                                               dispatch(capability=skill)  ──▶ Participant
                                                  participant 抛 SuspendTaskError
                                                  scheduler → {kind:'suspended', taskId:hubTaskId}
                                               registerParkedTask(hubTaskId, peerId)
                                                  → opaqueId = randomUUID()
                                                  → tasks.set(opaqueId, {hubTaskId, peerId})
       ◀─────────────  result: workingTask(opaqueId)   (HTTP 200, JSON-RPC result.kind='task')

[ 受端 hub 上外部事件恢复该 task: hub.resumeTask(by, task, state)
  → onResume → 返回 ok → transcript 落 task_result(ok) ]

a2aGetTask(url, token, opaqueId,               POST /a2a  {tasks/get, params:{id:opaqueId}}
  {peerId})  ─────────────────────────────▶    record = tasks.get(opaqueId)
                                               record.peerId === 认证 peerId ?   (否 → TASK_NOT_FOUND)
                                               hub.taskResult(record.hubTaskId)   ← 被动读 transcript
                                                  ok → completedTask(opaqueId, text)
       ◀─────────────  result: completedTask(opaqueId, 'resolved: ...')
```

---

## 安全不变量（各有测试钉死）

1. **不透明句柄**：`message/send` 回的 Task `id` 是 `randomUUID()`，断言 `!= hubTaskId`。
2. **归属隔离**：`tasks/get` 必须 `record.peerId === 认证 peerId`；别的 peer 拿同一
   句柄 → `TASK_NOT_FOUND`，原 owner 仍可读（单测 + E2E 各一）。
3. **反枚举 fail-closed**：未知 id 与「别人的 id」回**同一** `TASK_NOT_FOUND`，不区分。
4. **auth 先于一切**：`tasks/get` 和 `message/send` 共用 `handle()` 顶部的 bearer 闸
   —— 任务表不可未认证轮询。
5. **`-32001` 单义**：删 `SUSPENDED` 后，host 只在 `tasks/get` 查无 / 越权时 emit
   `-32001`；`message/send` 挂起回 `Task` 不再 emit error。
6. **被动读、不改恢复路径**：`tasks/get` 只 `hub.taskResult` 读 transcript，零写、不
   碰 resume sweep / suspendNotifier —— 观测与恢复解耦。

## 测试矩阵

| 包 | 数 | 关键 |
|---|---|---|
| `@aipehub/a2a` | 27 | tasks.test.ts +12（构造器 / 判别器 / `a2aGetTask` / `a2aSendRaw`）；client/participant 零回归 |
| host `a2a-server.test.ts` | 25 | suspend→opaque Task / parked→working / resumed→completed+text / resumed→failed+text / unknown→not-found / missing-id→invalid-params / **跨 peer 归属隔离** |
| host `a2a-lifecycle-e2e.test.ts` | 2 | **真 HTTP 生命周期验收门**：suspend→working→（手动 resume）→completed+往返文本；跨 peer 隔离 over the wire |
| host `a2a-double-hub.test.ts` | 3 | Phase 18 闭环零回归 |

## 运维须知

- 入站 A2A 仍由 `AIPE_A2A_INBOUND_ENABLED`（默认关）+ identity 在位才挂载。
- 任务句柄表是**进程内存**：host 重启后所有未完句柄失效，调用方按 `TASK_NOT_FOUND`
  重发。无需运维干预，无新表 / 新迁移。
- TTL 1h、上限 1万句柄是常量（`a2a-server.ts` 顶部）；正常负载远够，无需调。

## 显式推迟

- **A2A streaming（`message/stream` / SSE）+ push notifications**：agent card 的
  streaming/push capability flag 仍诚实地全 `false`；只做阻塞 `message/send` +
  `tasks/get` 轮询。
- **`tasks/cancel` / `tasks/resubscribe`**：本版只 `tasks/get`。
- **句柄持久化**：要跨重启续看长任务再加（`peers` 旁开表或复用 `suspended_tasks`）；
  当前「重启即 honest TASK_NOT_FOUND」对体验版足够。
- **入站把 A2A Task 直接接到 Phase 16 inbox 审批**：现在受端挂起靠自身机制（HITL /
  长算）；把发起端的 A2A 调用直接落成一条 inbox 审批项是另一条线。

## 下一步

P1-M8（A2A 任务生命周期）三刀全完（#192–#194）。Route B P1 的 M9（真 socket 隔离
E2E）/ M10（data-class redaction）/ M11（出站 A2A agent admin 持久化）按既定顺序续推；
M12（release）受 GitHub 暂停阻塞，M13/M14 需真 LLM key / 付费证书。
