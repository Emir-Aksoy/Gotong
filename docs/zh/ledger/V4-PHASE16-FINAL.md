# v4 Phase 16 —— 成员任务 inbox（human-in-the-loop 工作流步骤，M1-M8 + 验收门）

> 接 Phase 15（工作流生命周期 + 版本化）。本 sprint 让工作流能在某一步
> **停下来等一个人拍板**：指定成员在 `/me` 工作台的 inbox 里看到、处理，
> 工作流带着这个人的答复继续往下走。
>
> 全程纯本地 commit（8 个里程碑 + 本文档），`pnpm -r test` 全绿。
> commit `e464b32`→`be4754a`。

---

## 一、动了什么（先说北极星缺口）

Phase 15 之前，工作流的**每一步都派给 agent**（`hub.dispatch` 到某个
capability）。没有任何「等一个人点头 / 选择 / 改一段文字」的步骤。

北极星第 2 条明说：**人和 agent 是同一个 `Participant`，不要把人当
`request_human_input` tool**。所以 human-in-the-loop（HITL）不该是一个 tool，
而应是**派一个 Task 给一个代表「收件箱」的 Participant**——那个 Participant 把
任务挂起，人在 `/me` 处理后再恢复。

本 sprint 就补上这条：

```
工作流 step:  human: { assignee, kind: approval|choice|edit, prompt }
                 │  desugar（M6，import 期）
                 ▼
            dispatch → capability gotong.human/v1
                 │
                 ▼
   HumanInboxParticipant（broker）: 写一条 inbox item → 挂起（永不超时）
                 │
   成员 /me inbox 点「批准 / 选择 / 提交」 → POST /api/me/inbox/:id/resolve
                 ▼
   HostInboxService.resolve: 两步恢复（子 broker 先，父 workflow 后）
                 │
                 ▼
   human 步的 output === 人的决定 → 下游 $step.output 拿到它 → run 跑完 done
```

---

## 二、为什么这么做（复用 Phase 11 + Phase 15，零新机制）

整个功能**没有引入任何新的调度 / 持久化机制**，全靠两个已有底座拼出来：

- **Phase 11 suspend/resume**：participant 抛 `SuspendTaskError` → scheduler 转成
  `{kind:'suspended'}` 调 `suspendNotifier` 落盘到 identity `suspended_tasks` 表 →
  时间 sweep 或显式 `hub.resumeTask` 唤醒。broker 就是「一个永远挂起、只能被人
  显式 resume 的 participant」。
- **Phase 15 修订绑定**：run 钉死 `definitionRevision`，resume 按该修订跑。于是
  「人挂起期间 re-publish 新修订」**天然不漂移**——这是本 sprint 的免费红利，
  在 E2E 验收门里显式断言（见第八节 Part 2）。

runner / scheduler / resolver / deepCheck **零改动**——它们只看到一个普通的
capability dispatch。这正是 broker 模型的价值：HITL 对调度层完全透明。

---

## 三、架构主线（broker 模型 + 两步恢复 + 三个不变量）

**包边界**（与仓库「纯逻辑独立包 / host 接 concrete 类型 / web 鸭子零依赖」一致）：

| 层 | 物 | 依赖 |
|---|---|---|
| `@gotong/inbox`（新包） | `InboxStore` 接口 + `FileInboxStore` + 类型 + `HumanInboxParticipant` broker | 只依赖 `@gotong/core` |
| `@gotong/host` | `HostInboxService`（两步恢复编排）+ boot 注册 broker | concrete `Hub` + `IdentityStore` + `@gotong/inbox` |
| `@gotong/web` | 鸭子 `InboxSurface`（`me-routes.ts`）+ `/me/inbox` 路由 + 前端面板 | 零 `@gotong/inbox` 依赖 |
| `@gotong/workflow` | `human:` YAML 糖（schema 脱糖） | 零 `@gotong/inbox` 依赖（共享纯字符串常量 `gotong.human/v1`） |

**两步恢复**（`HostInboxService.resolve`，子严格先于父）：

```
resolve(itemId, userId, decision):
  1. load item → 所有权 / pending 校验（typed error → HTTP 状态码）
  2. validateDecision(item, decision)（按 kind 校验，choice 还查 value 在不在 options 里）
  3. store.markResolved —— RACE GUARD：并发 / 重复 resolve 在这里被挡，先于任何 resume
  4. 恢复 CHILD broker 任务，注入 { answer: decision } → 其 ok 落 transcript → 删子行
  5. 恢复 PARENT 工作流 run（仅 parentKind==='workflow'）→ 其 refreshSuspendedStepRecord
     读到子 ok → human 步 output = decision → 继续（或又挂在别的 human 步）
     → run 跑完才删父行；又挂起则保留（notifier 已写新行）
```

**三个关键不变量（对抗式评审定下的）：**

1. **永不 resumeAt = `9_999_999_999_000`**（`NEVER_RESUME_AT`，与
   `workflow-lifecycle-e2e` 同常量，约公元 2286 年）。子 broker 挂起用它；工作流父
   步骤经 `record.resumeAt = result.resumeAt` 继承它。于是时间 sweep 的
   `resume_at <= now` 对这两行**恒 false**，`resolve()` 是**唯一**恢复者（第八节
   Part 3 显式断言 sweep 取不到这两行）。

2. **子严格先于父**：父恢复前，`hub.taskResult(childTaskId)` 还是 `suspended`，
   父的 `refreshSuspendedStepRecord` 会把步骤重新挂起（无害空转，但无进展）。子恢复
   后才是 ok。代码里显式注释 + E2E 断言这个顺序。

3. **parent 用数据而非位置**：broker 在 `handleTask` 时就把 ancestry 末节点
   `{taskId, by}` + `parentKind`（`'workflow' | 'agent' | 'none'`）整个存进 item。
   `resolve()` 按 `parentKind` 决定要不要恢复父，并**交叉核对 `row.agentId === parent.by`**
   ——防 taskId 撞名 / item 损坏导致恢复错的 participant。不靠 `.at(-1)` 的运行时位置猜。

---

## 四、`human:` YAML 糖（M6，`packages/workflow/src/schema.ts`）

作者写人话，不写裸 dispatch 块：

```yaml
schema: gotong.workflow/v1
workflow:
  id: leave-approval
  trigger: { capability: leave:submit }
  steps:
    - id: gate
      human:
        assignee: $trigger.payload.manager_id   # $ref，dispatch 时解析成真 userId
        kind: approval                            # approval | choice | edit
        prompt: 张三申请 5 月 30 日年假一天，是否批准？
        title: 请假审批
    - id: notify
      when: $gate.output.approved                 # 下游引用人的决定
      dispatch:
        strategy: { kind: capability, capabilities: [notify:send] }
        payload: { approved: $gate.output.approved }
```

`parseWorkflow` 在 import 期把 `human:` **脱糖**成一个普通
`dispatch → capability gotong.human/v1`，payload 就是 broker 认的
`HumanTaskPayload`。关键点：

- **`assignee` 可以是 `$ref` 字符串**（如 `$trigger.payload.manager_id`），resolver 在
  dispatch 时按现有 `$`-ref 机制替换成真 userId——工作流能动态把任务派给「该批的那个人」。
- **急切校验**：坏 human 块（缺 assignee / 非法 kind / choice 缺 options）在 import 期
  抛 `WorkflowSchemaError`，不等到第一次 dispatch 才崩。
- **runner / resolver / deepCheck 零改**：它们只见普通 capability dispatch。deepCheck 不
  报 `unknown_capability`，因为 broker 在 boot 注册了 `gotong.human/v1`，inventory 自带它。

---

## 五、broker：`HumanInboxParticipant`（M2，`packages/inbox/`）

`extends AgentParticipant`，固定 id `gotong:human-inbox`，cap `gotong.human/v1`：

- `handleTask`：`parseHumanPayload`（坏 payload 抛 `InboxError` → 步骤可见地
  `failed`，不留幽灵）→ 读 `task.ancestry.at(-1)` 定 parent/parentKind → 写一条
  `InboxItem`（`itemId = task.id`，`status='pending'`）→ 抛
  `SuspendTaskError({ resumeAt: NEVER_RESUME_AT, state: { inboxItemId } })`。
- `handleResume`：从 `state.answer` 取决定返回（基类 `onResume` 包成 task 的 ok
  output）；没有 answer 就重抛 `SuspendTaskError`（永不空转完成）。
- `parseHumanPayload` 容错：options 接受 `[{value,label?}]` 也接受 `['yes','no']`
  简写；`choice` 必须有非空 options。

**`FileInboxStore`**（M1）：item 落 `<spaceRoot>/inbox/<itemId>.json`，原子
tmp+rename 写。`InboxStore` 接口 5 个方法：`ensureDirs` / `write` / `get` /
`listPending(userId)`（按 user + `status==='pending'` 过滤）/ `markResolved`
（pending→resolved 的**受保护转移**，已 resolved 再调即抛 `already_resolved`——这是
并发 resolve 的 race 守卫）。SQLite 实现留接口，后续可插。

---

## 六、两步恢复：`HostInboxService`（M5，`packages/host/src/inbox-service.ts`）

结构化满足 web 的鸭子 `InboxSurface`（不 import web）。是 concrete `Hub` +
`IdentityStore` 唯一相遇处，两步恢复都在这。要点已在第三节列出，补充两个细节：

- **`validateDecision` 是服务端权威**：approval 要 boolean `approved`；choice 要 string
  `value` **且必须是 item 提供过的某个 option**（防成员篡改提交一个没给的选项）；edit
  要 string `value`。返回的 `InboxDecision` 就是 human 步的 output。
- **父行删除时机**：父 run resume 后 `result.kind !== 'suspended'` 才
  `removeSuspendedTask(parent.taskId)`。若 run 又挂在**另一个** human 步，notifier 已
  `INSERT OR REPLACE` 写了新行——这时删掉会丢掉新的挂起。

boot 接线（`main.ts`，仅当 identity 在）：建 `FileInboxStore(SPACE_DIR)` →
`hub.register(new HumanInboxParticipant({store}))` → 建 `HostInboxService` → 喂进
`serveWeb({inbox})`。启动日志：`JOIN gotong:human-inbox (agent) caps=[gotong.human/v1]`
+ `member task inbox enabled`。

---

## 七、HTTP 路由 + 前端面板（M3/M4/M8）

- **鸭子 `InboxSurface`**（M3，`me-routes.ts`）：`listPending(userId)` /
  `resolve({itemId,userId,decision})` + `inbox?: InboxSurface` 穿进 `HandleMeRouteCtx`
  → `server.ts` 的 `WebServerOptions` / `HandlerCtx`。web 零 `@gotong/inbox` 依赖。
- **路由**（M4）：
  - `GET /api/me/inbox` → `ctx.inbox.listPending(userId)`；无 surface 时降级空列表。
  - `POST /api/me/inbox/:itemId/resolve` → `ctx.inbox.resolve(...)`；`userId` 一律服务端
    从 session 强制；per-user 限流；typed `.code` → HTTP（`not_found`→404 /
    `forbidden`→403 / `already_resolved`→409 / `invalid_decision`/`invalid_payload`→400）。
- **前端面板**（M8，手写 member SPA `app.html`/`app.js`/`styles.css`，非 esbuild bundle）：
  `renderHome` 加 `loadMyInbox()` 拉 `/api/me/inbox`，按 `kind` 渲染——approval 出
  「批准/拒绝」、choice 每个 option 一个按钮、edit 出 textarea/input + 「提交」。点按钮
  → `POST .../resolve` → 成功后刷新列表。`待处理任务` 标题带未读数 `.me-badge`。
  静态资源经 web build 重嵌进 `static-assets.ts`（单文件 binary 友好）。

---

## 八、无漂移端到端验收门（the gate，`packages/host/tests/inbox-e2e.test.ts`）

真 Hub（InMemoryStorage）+ 生产形 `suspendNotifier` 落真 identity sqlite + 真
`WorkflowController`（含 Phase 15 versioning）+ 真 broker + 真 `HostInboxService`。两个用例：

- **Test 1（happy path + 无漂移基线）**：import 含 `human:` gate 步 + 下游引用
  `$gate.output.approved` 的工作流 → 派发 trigger → 断言：run 挂起、`listPending(assignee)`
  有一条 item、子 + 父两行都挂在 `NEVER_RESUME_AT`、gate 步 `suspended`、
  **`listDueSuspendedTasks({now})` 取不到这两行**（不变量 1，sweep 永不唤醒）→
  `resolve({decision: approved})` → 断言：run 恢复、**gate.output === decision**（核心
  契约）、下游 tail 步收到 `approved:true` 的 marker、run `done`、两行都清掉。
- **Test 2（Phase-15 无漂移）**：human 步挂起期间 `publish` 新修订 rev2 → 再 resolve →
  断言**恢复后跑的是原修订 rev1 的下游**（marker 含 rev1 不含 rev2）、done run 的
  `definitionRevision` 仍是 1。证明人挂起的 run 跟时间挂起一样被修订钉死。

---

## 九、测试矩阵（+39 across 4 包，零回归）

| 包 | 文件 | 数 | 测什么 |
|---|---|---|---|
| `@gotong/inbox` | `file-inbox-store.test.ts` | 8 | 原子写 / `listPending` 过滤 / `get` 缺失返 null / `markResolved` race 守卫 |
| `@gotong/inbox` | `human-inbox-participant.test.ts` | 8 | 合法 payload 写 item + 抛 `SuspendTaskError(永不)` / 缺 assignee 抛 / `onResume({answer})` / parent/parentKind |
| `@gotong/web` | `me-inbox-routes.test.ts` | 8 | 401 无 session / 不能列别人 / 404 / 409 已处理 / happy resolve 传参 |
| `@gotong/host` | `inbox-service.test.ts` | 6 | 子先父后 / 二次 resolve 被 markResolved 挡（不二次 resumeTask）/ 父完成才删行 |
| `@gotong/host` | `inbox-e2e.test.ts` | 2 | **验收门**：happy + output 契约 + sweep 取不到 + 无漂移 |
| `@gotong/workflow` | `human-step.test.ts` | 7 | `human:` → dispatch 到 `gotong.human/v1` / 坏块 import 期抛 |

全量 `pnpm -r test` 绿（host 341 等）。

---

## 十、运维须知

- **永不超时 = 永挂**：v1 的 human 任务没有 SLA / 催办 / 升级。一个永远不被 resolve 的
  item 会**永久占一行 `suspended_tasks` + 一个 inbox 文件**。超时升级是 backlog（见下）。
- **凭证 / 数据落盘**：inbox item 是明文 JSON 落 `<space>/inbox/`，含 prompt / 决定。
  跟 transcript 同密级，按目录权限管控。
- **broker 无条件注册**（只要 identity 在）：成本是一个 idle participant。不想要 HITL 的
  host 不写 `human:` 步即可，broker 闲着不耗资源。
- **archived 工作流的在途 human 步**：archive 会注销 runner，此时 resolve 的父恢复会
  no_participant——v1 不特殊处理（子仍 resolve、决定仍记录，只是父 run 不再推进）。

---

## 十一、未做 / 推迟（保持精简，对齐 backlog #21）

- **超时升级 / SLA**：定时催办、升级给上级。永不 resumeAt 现在 = 永挂。
- **多人审批**：approver≠author 的签核、N-of-M。v1 单人单次 resolve。
- **agent 直接发起的 HITL 的父恢复**：v1 只恢复「工作流父」；裸 agent 父链恢复推迟，
  代码已用 `parentKind` 留口子（agent/none 时只恢复子）。
- **inbox SQLite store**：只交 file 实现 + 接口，sqlite 后续可插。
- **跨 hub HITL inbox**：federation 维度，复用 `Task.origin`，留后续。

---

## 十二、commit 清单（M1-M8 + 本文档）

| M | commit | 摘要 |
|---|---|---|
| M1 | `e464b32` | file-first `InboxStore` + 类型 |
| M2 | `71b8e15` | `HumanInboxParticipant` broker |
| M3 | `a8e60bb` | web `InboxSurface` 鸭子 + ctx 穿线 |
| M4 | `dee4df7` | `/me/inbox` 路由（list + resolve） |
| M5 | `a3967f1` | `HostInboxService` 两步恢复 + boot 接线 |
| M6 | `37ffb3f` | `human:` step 糖 → dispatch 到 `gotong.human/v1` |
| M7 | `57c9e68` | 无漂移验收门 |
| M8 | `be4754a` | `/me` inbox 前端面板 |

设计上 inbox 跟 Phase 11 的 long-running agent 同源——「一个 participant 把任务挂起，
外部事件再恢复」。差别只是「外部事件」从「定时器到点」换成「一个人在 `/me` 点了按钮」。
人和 agent，同一套 suspend/resume。这就是北极星第 2 条落到代码里的样子。
