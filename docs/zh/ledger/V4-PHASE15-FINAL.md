# v4 Phase 15 —— 工作流生命周期 + 版本化（M1-M8 + 验收门）

> 给工作流加上**草稿 → 审核 → 发布 → 弃用 → 归档**的生命周期，和**不可变修订**。
> 一条 run 在启动时被钉到一个具体修订；之后无论怎么 publish 新版本，**在跑 /
> 挂起的 run 都不会漂到新逻辑**。发布新修订只是移动「当前发布」指针。
>
> 完成日期：2026-05-31 · 9 个 commit（`b174367` → `5070d98`）

---

## 一、动了什么（先说要修的 bug）

Phase 15 之前，工作流没有任何版本概念 —— `WorkflowDefinition` 只有 `id` 当身份，
没有 version / revision / status。更要命的是 **run 绑在「可变 id」上会漂移**：

- `WorkflowRunner` 持有 `this.definition` 活引用；
- run 启动只在 `RunState.workflowId` 记 id（**不快照定义**）；
- resume 只校验 id 匹配，然后用**当前**定义跑旧 run。

→ 重新 import / 改定义后，正在跑或挂起的 run 会漂到新逻辑，步骤可能被改名 / 重排 /
删除，导致诡异失败。而且 import 即上线、无草稿 / 审核态、禁止重名 import（改工作流
要先 delete 再 import）。

Phase 15 把这些一次性解决：

```
admin 改工作流 → 存草稿 → 提交审核 → 发布（追加不可变 rev2，移动指针）
                                              ↓
        正在跑的 run 仍钉在 rev1 ── 从不可变 <rev>.json 解析 ── 不漂移
                                              ↓
        rollback → 克隆旧修订为新 head + 重新指向 ── 仍 published
```

---

## 二、为什么这么做

| 痛点（Phase 15 前） | Phase 15 解法 |
|---|---|
| run 漂移：改定义后在跑 / 挂起的 run 跑到新步骤 | run 启动钉 `definitionRevision`，resume 按该修订解析不可变快照 |
| import 即上线，无草稿 / 审核闸门 | `draft → review → published` 状态机；`/me` 只放行 `published` |
| 改工作流要先 delete 再 import（重名禁止） | `publish({text})` 追加新修订，id 不变，runner 不重注册 |
| 发错版本无法回退 | `rollback(targetRevision)` append-only 克隆旧修订为当前发布 |
| 弃用一个工作流 = 直接删 | `deprecated`（仍可跑、`/me` 隐藏）→ `archived`（下线，历史留存） |

---

## 三、架构主线（3 块 + 1 个不变量）

```
A. 两个文件优先 store（@gotong/workflow，镜像 RunStore）
   workflows/revisions/<id>/<rev>.json   ← 不可变修订快照（写一次性）
   workflows/lifecycle/<id>.json         ← 唯一可变记录（状态 + 指针 + 审计）

B. 修订感知的 runner seam（消除漂移的核心，runner.ts）
   单一 this.definition  →  注入的 DefinitionResolver
     current()        新 run 绑定当前 published
     byRevision(rev)  恢复用：取确切快照

C. 生命周期状态机（纯函数 + 类型化错误，lifecycle.ts）
   transition(record, action) → record | throw WorkflowLifecycleError

不变量：trigger.capability 跨修订冻结 → Hub 注册稳定、runner 一次注册长期存活。
```

**为什么这样杀掉漂移**：每个工作流有一个绑定到它内存 entry 的 `HostDefinitionResolver`。
用该 resolver 构造的 runner 在 run 启动时盖 `RunState.definitionRevision =
resolver.current().revision`，resume 时执行 `resolver.byRevision(那个修订号)` ——
run 开始时的**那份确切快照**。publish 只移动 `currentRevision` 指针；在跑 / 挂起的
run 仍解析它原本的修订。runner 注册在冻结的 trigger cap 上，跨 publish 不抖动。

---

## 四、生命周期状态机（`packages/workflow/src/lifecycle.ts`）

```
draft      --submitReview--> review
draft      --publish-------> published     (允许直发；import 走这条)
review     --publish-------> published
review     --backToDraft---> draft
published  --publish-------> published     (发布新编辑的修订：append rev + repoint)
published  --deprecate-----> deprecated
published  --rollback------> published     (克隆旧修订为新 head 并 repoint)
deprecated --publish-------> published     (重新发布即解除弃用)
deprecated --archive-------> archived
archived   --(terminal)
```

- 纯 `transition(record, action) → record | throw WorkflowLifecycleError(code)`；
  非法转移抛 `illegal_transition`。持久化由 host 服务层负责（保持纯函数可单测）。
- **挂 Hub vs 不挂**：`published` + `deprecated` → runner 注册 live（deprecated 仍
  可跑，保在跑任务 + admin 重跑不破，但 `/me` 隐藏）；`draft` / `review` / `archived`
  → 不注册。`isLiveState()` 一个谓词裁定，host 在跨边界时注册 / 注销 runner。

---

## 五、修订标识：单调整数 + 内容哈希（两者都要）

整数 `revision`（1, 2, 3…，用户可读、可排序、盖进 `RunState.definitionRevision`）+
`contentHash`（`sha256(canonical-JSON(definition))`）。哈希用于：

- **完整性校验**；
- **no-op publish 去重**：内容与当前修订相同则短路不 append，防幂等重导致修订号膨胀；
- **rollback 断言**：「当前 published 内容 == rev1」体现为「rev3 与 rev1 contentHash 相等」。

rollback 是 **append-only 可审计** 的：读目标修订内容 → 克隆成新修订 `head+1`
（`origin: 'rollback'`，meta 记 `rolledBackFrom`）→ `currentRevision = head+1`，
state 仍 published。历史里能看到一条「回滚」记录，而不是悄悄改了指针。

---

## 六、消除漂移的 runner seam（`packages/workflow/src/runner.ts`）

```ts
interface DefinitionResolver {
  current(): ResolvedDefinition           // { revision, definition }
  byRevision(rev: number): WorkflowDefinition
}
```

- `WorkflowRunnerOptions` 加可选 `resolver?`；**缺省时从 `opts.definition` 合成单修订
  resolver（rev 1）** → 现有 `new WorkflowRunner({definition, hub})`（~30 处）零改动仍绿。
- `handleTask` → `resolver.current()` → 盖 `state.definitionRevision`，按该 definition 执行。
- `resumeRun` → 读 `initial.definitionRevision`，`def = resolver.byRevision(rev)`，
  **按 threaded `def` 执行而非 `this.definition`**；解析不到修订抛 `WorkflowRevisionError`
  （而不是静默跑错步骤）。谓词（`when` / branch）从「构造期编一次」改成「按修订懒缓存」。
- suspend 包装器已携带整个 `RunState` → `definitionRevision` 随 suspend / resume 免费流转。

---

## 七、host versioning 服务（`packages/host/src/workflow-versioning.ts`）

`WorkflowVersioning` 是两个 store 之上的编排层 + **唯一注册权威**：

- 每工作流一个内存 `Entry { record, defs: Map<rev, def>, resolver, participantId }`；
  `HostDefinitionResolver` 同步读 `entry.record.currentRevision` + `entry.defs`。
- 方法：`adopt`（幂等 genesis published rev1）/ `saveDraft` / `submitReview` /
  `backToDraft` / `publish` / `deprecate` / `archive` / `rollback` / `listRevisions` /
  `getState` / `hydrate`。每个先调纯 `transition()`，再做修订簿记（hash / no-op 去重 /
  appendRevision / 移指针），最后 `syncRegistration`（跨 live ↔ 非 live 边界注册 / 注销）。
- **capability 冻结**：publish / saveDraft 若 `trigger.capability` 与记录里冻结的不同 →
  抛 `capability_immutable`（改 cap = 新工作流，请用新 id）。

`WorkflowController`（M5）接进来：`importFromText` 走 **Model B** —— 保留「导入即上线」
语义，但背后 `adopt` 创建不可变 rev1 + `state=published`。boot 时 loader 降级为
**parse-only**，每个 yaml 由 controller `adoptAtBoot` 采纳（versioning 是唯一注册者，
不再双重注册）。`remove()` 删 yaml + lifecycle 记录 + 修订快照（end-of-life 清理，
让 re-import 能重新从 rev1 采纳）。

---

## 八、HTTP 路由 + `/me` published 闸门

**M6**（`packages/web/src/workflow-routes.ts`，全 requireAdmin，排在 catch-all
`DELETE /:id` 之前）：

| 端点 | 行为 |
|---|---|
| `POST /workflows/draft` | `saveDraft(text)` |
| `POST /:id/{review,draft,deprecate,archive}` | 对应 transition |
| `POST /:id/publish` | 无 body → 发布 head；`{text}` → parse + 追加修订 |
| `POST /:id/rollback` | `{targetRevision}`（缺 → 400） |
| `GET /:id/revisions` | 修订元数据列表（升序） |
| `GET /:id/state` | 完整 `WorkflowLifecycleView` |

web 层全鸭子类型（`WorkflowSurface` + 镜像 `WorkflowLifecycleView` 等），零
`@gotong/workflow` 依赖；错误按鸭子 `.code` 字符串映射 HTTP 状态
（`illegal_transition` / `capability_immutable` / `stale_head` → 409，
`unknown_workflow` → 404，坏 rollback 目标 → 400）。

**M7**（`packages/web/src/me-routes.ts`）：`evaluateMeSurface` 加
`state === 'published'` 门 —— `draft` / `review` / `deprecated` / `archived` 的
member 工作流不进 `/me` catalog 且 dispatch 403。`surface.me.enabled`（Phase 14）是
**开关**，`published`（Phase 15）是**长期生命周期闸门**，两者叠加。

---

## 九、admin UI（M8，`packages/web/admin-src/workflows.js`）

- 每张卡片显示 **state 徽章**（published / deprecated …）+ `rev N`。
- 按 state 门控按钮（list() 只返回 live 工作流，故只覆盖这两态的合法转移）：
  `published` → 弃用；`deprecated` → 重新发布 + 归档；两者 → 修订历史。
- **修订历史 modal**（`wf-rev-modal`）：`GET /:id/revisions`，最新在上，每行显示
  rev #、origin（import / publish / rollback，带 `← rev N` 回滚来源）、短 contentHash、
  时间。当前修订打标，其余行有「回滚到此」→ `POST /:id/rollback`，成功后刷新卡片 + 列表。

UI 由 esbuild 打包进 `admin.js`，静态资源 base64 内嵌进 `static-assets.ts`，
i18n 在 `app-core.js`（中英双语）。无新 vitest —— 它调的 HTTP 路由由
`workflow-lifecycle-route.test.ts` 覆盖。

---

## 十、无漂移端到端验收门（the gate，`packages/host/tests/workflow-lifecycle-e2e.test.ts`）

整个 phase 存在的意义就是跑通这 7 步。全程真实：真 `Hub`（生产形态
`suspendNotifier`）+ 真 `WorkflowController` → `WorkflowVersioning` → 文件 store +
versioning 注册的真 `WorkflowRunner`。

1. `import rev1` → `published`、盘上 `revisions/<id>/1.json` 存在、runner 注册。
2/3. 派发 trigger → run 启动**绑定 rev1** → 挂起（一个 `worker` agent 首个任务抛
   `SuspendTaskError`，scheduler 转 suspended，工作流 park）；盘上 run
   `definitionRevision: 1` + 一个 suspended 步。
4. **挂起期间** publish rev2 → `currentRevision: 2`，**同一注册参与者**（冻结 cap →
   无 Hub 抖动）。
5. 恢复（`hub.resumeTask`，正是 host resume sweep 的行为）→ 执行 **rev1 的 tail，
   绝不是 rev2** ← **核心无漂移断言**。
6. `rollback(target=1)` → rev3 是 rev1 的逐字节克隆（contentHash 相等、
   `origin: 'rollback'`、`rolledBackFrom: 1`）。
7. rollback 后**新**派发 → 绑定 rev3、执行 rev1 内容。

证明：发布新修订不可能把在跑 / 挂起的 run 漂到新步骤逻辑。

---

## 十一、测试矩阵

| 包 | 测试 | 覆盖 |
|---|---|---|
| `@gotong/workflow` | `lifecycle.test.ts` | 全合法转移 / 代表性非法转移抛对的 code / archived 终态拒一切 |
| `@gotong/workflow` | `revision-store.test.ts` + `lifecycle-store.test.ts` | 写一次性拒覆盖、修订号递增、list 排序、hash 稳定、原子重写 round-trip |
| `@gotong/workflow` | `runner.test.ts`（revision binding describe） | 新 run 盖修订号 / **无漂移单测**（挂起 rev1 → current 换 rev2 → 恢复仍跑 rev1）/ 解析不到修订抛错 |
| `@gotong/host` | `workflow-versioning.test.ts`（17 测试） | adopt→rev1 / publish-edit append rev2 + repoint / no-op publish 不 append / rollback hash 相等 / capability_immutable / deprecate 保注册、archive 注销 / hydrate 重启 |
| `@gotong/host` | `workflow-controller.test.ts`（lifecycle describe） | import→published rev1 / saveDraft 不注册不在 list / publish 提升 / rollback repoint |
| `@gotong/host` | `workflow-lifecycle-e2e.test.ts`（**验收门**） | 真栈 7 步无漂移 |
| `@gotong/web` | `workflow-lifecycle-route.test.ts`（18 测试） | 每路由调对 surface 方法 + by 戳记 + 错误码→HTTP 映射 |
| `@gotong/web` | `me-routes.test.ts`（published-gate describe） | draft/review/dep/arc 不在 catalog 且 dispatch 403；published 200 |

全量 `pnpm -r test` 绿（host 333 / web 439 / workflow 190 / 全 27 包通过，仅 2 个
llm 实时 API 测试 skip）。

---

## 十二、运维须知

- **改一个已发布的工作流**：admin UI 卡片「修订历史」看版本；要发新版走
  `POST /:id/publish {text}`（追加 rev，id 不变，runner 不重注册）。发错了用
  「回滚到此」。
- **草稿 / 审核**：`POST /workflows/draft` 存草稿（不上线、不进列表），
  `POST /:id/review` 提审，`POST /:id/publish` 发布。注意：list() 只返回 live
  工作流，草稿目前从卡片列表看不到（需带外列举，见「未做」）。
- **弃用 vs 归档**：`deprecate` 仍可跑（admin 重跑 + 在跑收尾），但 `/me` 隐藏；
  `archive` 彻底下线（修订历史保留，可重新导入）。
- **改 trigger.capability**：会被拒（`capability_immutable`）。改 cap = 新工作流，
  请用新 id 导入。
- **盘上布局**：`<space>/workflows/revisions/<id>/<rev>.json`（不可变）+
  `<space>/workflows/lifecycle/<id>.json`（可变记录）。复制目录 = 搬走全部历史。

---

## 十三、未做 / 推迟（保持精简）

- **SQLite store 实现**：只交 file 实现 + 窄接口（`RevisionStore` / `LifecycleStore`），
  sqlite 留「后续」无侵入替换。
- **草稿 / 审核的列表 UI**：`list()` 只返回 live 工作流，draft / review 目前从卡片
  看不到（API + 测试已就绪，缺一个「全部工作流含非 live」的列举端点 + UI）。
- **孤儿修订 GC / 修订裁剪**：本 sprint 永远 append-only；被 run 引用的修订不可删。
- **多人审核**：`review` 是单状态转移；approver≠author + 签核记录属 backlog
  （企业治理 Sprint）。
- **run 级「派发时钉到非当前修订」**：新 run 恒绑 `current()`；指定旧修订起跑推迟。
- **带外编辑 yaml 与 currentRevision 对账**：采纳幂等覆盖常态；带外改 yaml 自动加
  修订的路径推迟。
- admin 修订 **diff 对比视图**（M8 只做列表 + 回滚）。

---

## 十四、commit 清单

| Commit | Milestone |
|---|---|
| `b174367` | M1 lifecycle 纯状态机 + 修订类型（`lifecycle.ts`、`RunState.definitionRevision`） |
| `4659faf` | M2 `FileRevisionStore` + `FileLifecycleStore`（写一次性 / 原子重写 / `hashDefinition`） |
| `3552800` | M3 修订感知 runner —— 注入 `DefinitionResolver`，run 绑修订（无漂移核心） |
| `fb3389b` | M4 host `workflow-versioning.ts` 服务（生命周期 + 修订编排 + 唯一注册权威） |
| `9555181` | M5 controller 接入 versioning + boot 采纳 + Model-B import |
| `f2f8d2e` | M6 web 鸭子 surface + lifecycle HTTP 路由 |
| `60f3f46` | M7 `/me` catalog + dispatch 要求 `state === 'published'` |
| `c57d846` | M8 无漂移端到端验收门（E2E） |
| `5070d98` | M8 admin UI 生命周期控制 + 修订历史 |
