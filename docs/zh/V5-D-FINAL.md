# v5 · Stream D — 心跳 / 主动自治（小结）

> 状态: **Stream D 完**（D-M1 ~ D-M5）。这是 v5 路线里**最独立**的一条流——
> 引擎 Phase 11 已成，所以拿它先试水「自治 hub」的手感。v5 其余流（0 / A / B / C）
> 另出各自小结。
>
> Last updated: 2026-06-01

---

## 一、为什么做（北极星缺口）

到 v4 收官，AipeHub 的 agent 都是**被动**的:有人派 task 才动。但「人-智能体-机构」
工作底座里，真正解放人的那一半是**主动**的——agent 该自己盯着事，到点醒来看一眼，
有事就做 / 通知，没事别吵。这就是用户要的 **OpenClaw 风格主动唤醒型心跳**:

> 网关定时叫醒 agent，agent 读一份清单跑一个完整 turn，有事就做 / 通知，
> 没事回 `HEARTBEAT_OK`（被吞掉，不打扰）。

关键洞察:**这不需要任何新机制**。Phase 11 的 suspend/resume 引擎（`SuspendTaskError`
+ `suspended_tasks` 表 + resume sweep + `Hub.resumeTask`）天然就是一个「到点把
participant 叫醒」的定时器。把「叫醒后做什么」从「续跑批处理」换成「跑一次心跳 turn
再把自己重新挂起到下一个 interval」，就得到一个**零新表**的循环触发器。

不变量（贯穿）:

- **框架不跑 LLM**:hub 只负责**调度唤醒**，唤醒后的 turn 由 agent（LLM / 人 / 外部
  服务）自己决定做什么。心跳 broker 自己从不做实事，只是个会自我续期的闹钟。
- **agent 零心跳感知**:心跳 task 就是一个普通 task，清单塞在 `payload.prompt` 里——
  一个**默认** `LlmAgent` 的 `buildRequest` 直接把它当 user turn，不用改一行 agent 代码。
- **复用 > 新建**:整条流没加表、没加 timer、没加 scheduler。全部站在 Phase 11 +
  `examples/long-running-agent` 之上。

---

## 二、动了什么（逐里程碑）

| M | 标题 | 关键改动 | commit |
|---|---|---|---|
| D-M1 | 触发引擎（决策点 #1a:复用 `suspended_tasks` 自续期） | 新 `packages/host/src/heartbeat.ts`:`HeartbeatParticipant`（单例 broker，id `aipehub:heartbeat`，cap 空——只按 id resume，不被 capability 选中）`handleResume` 每次 fire 一次再抛 `SuspendTaskError(resumeAt=now+interval)`，**INSERT-OR-REPLACE 续同一行**（确定性 task id `heartbeat:<agentId>`→ 一行=一个 agent 的下次到点，重启无漂移）;`HeartbeatScheduler.reconcile` 幂等 seed/prune;`HeartbeatStore` 窄鸭子（真 `IdentityStore` 零改满足）;`core` 加 `HeartbeatSpec`{enabled,intervalMs,checklist?} 挂 `ManagedAgentSpec` | `a1b0d6b` |
| D-M2 | 待办清单 → payload 注入 | `buildHeartbeatPayload(state,now)`:清单拼成 ready-to-read `prompt`（默认 `LlmAgent` 直接消费），外加结构化 `heartbeat:true`/`checklist`/`firedAt` 给心跳感知子类;prompt 末尾固定「没事就回 `HEARTBEAT_OK` 别的都不做」 | `259b349` |
| D-M3 | 没事不打扰（no-op 输出抑制） | `classifyHeartbeatResult(result)→{idle\|active\|failed}`:回复**恰好** `HEARTBEAT_OK`→`idle`（吞掉）;有别的可读文本→`active`（上报摘要）;turn 报错→`failed`（给运维看）;parked/cancelled/读不出→`idle`。**transcript 仍记录每一拍**——抑制只管通知噪音，不动审计 | `1c7ec7c` |
| D-M4a | per-agent 配置:校验 / 持久化 / 实时 reconcile | web `validateHeartbeatSpec`（manifest 校验 enabled bool + intervalMs 正数）→ `managed.heartbeat`;host main.ts 改 lazy `ensureHeartbeatEngine()`（zero-heartbeat 启动不建 broker）+ `reconcileHeartbeats` 回调穿 web→server→agents-routes，5 个写路由 best-effort 触发（**改配置即时生效，无需重启 host**，且永不让 agent 写失败） | `b274494` |
| D-M4b | admin / `/me` UI | admin agent 表单加心跳 fieldset（开关 + **分钟** interval + 可选清单，分钟↔ms 转换，wire 仍 `intervalMs`）保存走 `validateHeartbeatSpec`;`/me` **只读**——catalog 仅投影脱敏 `{heartbeat:{enabled}}`（interval/清单不出 host），member agent 卡片渲染「⏰ 定时」徽章;静态资源重建 | `d9e1055` |
| D-M5 | 示例 + 文档 | `examples/heartbeat-agent`（core-only 单文件，~1s 确定性跑通:inbox-monitor 第 3 拍发现 VIP 邮件上报，其余 3 拍 `HEARTBEAT_OK` 抑制，18 条 transcript 全记录）+ 本文 + CLAUDE.md | (本提交) |

---

## 三、数据流端到端

```
boot / 改配置
  │  HeartbeatScheduler.reconcile()
  ▼  为每个 enabled agent 写一条自续期 suspended_tasks 行（resume_at = now + interval）
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
resume sweep tick（host 既有 setInterval，默认 30s——心跳不加自己的 timer）
  │  发现 resume_at <= now
  ▼  Hub.resumeTask(aipehub:heartbeat, task, state)
       │
       ▼  HeartbeatParticipant.handleResume:
          ├─ fire → hub.dispatch(目标 agent, buildHeartbeatPayload 清单)
          │     │  capability 策略（绝不 explicit）
          │     ▼  目标 agent 跑一个完整 turn:
          │        └─ 回 HEARTBEAT_OK（没事）| 一段摘要（做了事）
          ├─ classifyHeartbeatResult → idle 吞 / active 上报 / failed 给运维
          └─ throw SuspendTaskError(resumeAt = now + interval)  ← 续同一行
       ▼
   （一个 interval 后 sweep 再次唤醒——永远循环）
```

每一拍都写 transcript（`task` + `task_result`，外加 resume 的 `task_resumed`），
所以「安静的心跳」在通知上无声、在审计上有痕。

---

## 四、关键设计决策

1. **零新表（决策点 #1 选 a）**。新建 `scheduled_triggers` cron 表更「像真 cron」
   （agent 崩了 hub 也补叫），但代价是一张表 + 一套新 sweep。复用 `suspended_tasks`
   自续期把「循环触发」降成「resume 时再挂一次」——引擎现成、最省。代价是语义上
   「下次到点」绑在那一行上;够用，且 `reconcile` 在 boot 把缺的行补齐。

2. **broker 是单例，capability 空**。它从不被 capability dispatch 选中（cap=`[]`），
   只被 sweep 按固定 id `aipehub:heartbeat` resume。一个 broker 管所有 agent 的心跳，
   靠 `state.targetAgentId` 区分该 fire 谁——不给每个心跳 agent 造一个 broker。

3. **确定性 task id = 自动幂等**。row id `heartbeat:<agentId>` 让「重复 seed 一个已
   挂起的 agent」变成 no-op（`getSuspendedTask` 命中就跳过，绝不重置活钟）。这也是
   重启无漂移的根:一个 agent 永远至多一行。

4. **input（D-M2）和 output（D-M3）分开**。清单经 `payload.prompt` 进 turn（让默认
   `LlmAgent` 零改即用）;抑制经 `classifyHeartbeatResult` 出 turn（只挑通知，不碰
   transcript）。两头解耦,各自可测。

5. **lazy 引擎 + best-effort reconcile（D-M4a）**。host 启动若零心跳 agent，连 broker
   都不建（`ensureHeartbeatEngine` 首次需要时才注册）。改配置时 `reconcileHeartbeats`
   是 best-effort——**永不让一次 agent 写因为 reconcile 抖动而失败**（catch 吞掉记日志）。

6. **`/me` 只读、脱敏（D-M4b）**。agent 还不是成员所有（要等 Stream A 的归属泛化），
   所以 `/me` 只给一个「这个助手会定时自己醒」的徽章——`enabled` 是唯一出 host 的字段，
   interval / 清单留在 host 侧。这是**指示器，不是控制器**。

---

## 五、测试 / 验证

- **引擎单测** `packages/host/tests/heartbeat.test.ts`（16）:`parseHeartbeatState` /
  `buildHeartbeatPayload` / `reconcile`（seed/prune/幂等）/ `heartbeatResultText` /
  `classifyHeartbeatResult`（4 档）+ **端到端自续期**（一条 broker 行被 resume 后
  resume_at 推到下一个 interval，同 task id）。
- **配置链路** web 547 全绿（含 D-M4 新增 manifest round-trip + agents-route reconcile
  spy）;host build clean。
- **示例验收门** `pnpm demo:heartbeat-agent` ~1s 确定性:4 拍 → 1 上报 + 3 抑制 +
  18 条 transcript（每拍都审计）。core-only 单文件，无 API key、无 SQLite、无 host 二进制。

---

## 六、不做 / 后续

- **D.5 心跳可观测**（`last-heartbeat-age` / `proactive-action` 计数进 `/metrics`）——
  路线里标「可选」，留给真有运维需求时按 P3-M1 `business-metrics.ts` 的采集/渲染分离模式补。
- **真 cron 语义**（agent 崩了 hub 补叫的强保证）——决策点 #1 显式选了轻量 a 方案;
  若以后要 at-least-once 的强触发，再上 `scheduled_triggers` 表。
- **`/me` 自助配心跳**——等 Stream A agent 归属落地后，成员才谈得上「配自己 agent 的
  心跳」;现在 `/me` 只读徽章。
- **心跳内并发 / 重入保护的极端边界**——当前靠 sweep 的既有 reentrancy guard +
  broker 的「fire 失败也续期」吞错;海量心跳 agent 下的节流是后话。

---

## 七、一句话

**心跳 = Phase 11 suspend/resume 自己续期 + 一份清单进 prompt + 一个 `HEARTBEAT_OK`
出 turn。** 没加表、没加 timer，hub 还是只调度不跑 LLM——agent 第一次学会了自己醒来看一眼。

详见示例 `examples/heartbeat-agent/`、引擎 `packages/host/src/heartbeat.ts`。
