# 只读工作流流程图 (DAG 可视化)

> Track D (DAG). 给 admin 控制台的「工作流」面板补一个**只读流程图**:
> 点一张工作流卡片上的「流程图」按钮,弹出一张手绘 SVG,把这条工作流的
> trigger → steps → parallel 分支 → output 画成一张图,带 `when:` 闸、
> `$ref` 数据依赖、跨 hub 目的地标注。
>
> Last updated: 2026-06-21

---

## 一、为什么做(缺口性质 = 呈现,不是能力)

`WorkflowDefinition` **本身就已经是一张结构化 DAG**(`trigger` / `steps` /
`parallel.branches` / `output`,加 `when` 谓词和 `$ref` 数据依赖)。能力一直在,
缺的是**呈现**:作者/运维看一条工作流时只能读 YAML 或一行行 step 列表,脑子里自己
拼图。DAG 可视化把那张图画出来——**纯呈现层,不碰执行、不碰存储、不碰 schema**。

**严守「YAML 是治理/版本控制的根」**:这是**只读**的一张图,不是编辑器。改工作流仍
走 YAML(admin import / 成员用大白话改,见 [`V5-WFEDIT-FINAL.md`](./ledger/V5-WFEDIT-FINAL.md))。
流程图只是一面镜子,照出当前已发布修订(没有就照 head 草稿)的形状。

---

## 二、动了什么(一条纵切,core/protocol/identity/runner 零改)

| 层 | 改动 | 文件 |
|---|---|---|
| workflow | **新增一个纯函数模块** `projectWorkflowGraph(def)` → `{ nodes, edges }` | `packages/workflow/src/graph.ts` |
| host | `WorkflowController.graphOf(id)` — 按 `summaryFromView` 同一修订解析 + 跨 hub 目的地戳记 | `packages/host/src/workflow-controller.ts` |
| web | `GET /api/admin/workflows/:id/graph`(鸭子 `WorkflowSurface.graphOf`,admin 闸) | `packages/web/src/workflow-routes.ts` |
| 前端 | 卡片「流程图」按钮 + modal + 手绘 SVG 渲染器 | `packages/web/admin-src/workflows.js` · `static/app.html` · `static/app-core.js`(i18n) · `static/styles.css` |

workflow 包**只多了一个加性导出**(`graph.ts`),runner/resolver/schema 一字不改——
流程图是定义的一面镜子,不是执行路径。

---

## 三、投影模型(`projectWorkflowGraph`)

节点数组**本身就是可渲染的竖直堆叠**(trigger 在顶、output 在底,中间按 step 声明序):

```
节点 kind         id 形状                      说明
─────────────────────────────────────────────────────────────
trigger          __trigger__                 启动这条工作流的 dispatch capability(一个,顶)
step             step:<id>                   一个简单 step(一次 hub.dispatch)
parallel         step:<id>                   扇出容器;分支是独立 branch 节点(容器插在分支之前)
branch           branch:<stepId>/<branchId>  parallel 里的一路分支
output           __output__                  工作流返回值(一个,底)
```

```
边 kind      含义
──────────────────────────────────────────────────────────
sequence    执行骨架(trigger → step1 → … → output;
            parallel 容器把 sequence 边扇给每个分支)
data        一个 `$ref` 数据依赖:早先 step 的节点 → 读它 payload 的节点
```

- **trigger 读是节点标志,不是边**(`readsTrigger`)——几乎每个 step 都读 `$trigger.*`,
  画成边会糊一片;画成节点小标更干净。
- `when:` 谓词 + 节点级 `dataClasses` 挂在节点上,前端渲成琥珀小标 / 副行。
- **纯投影永远不设 `crossHub`**——跨 hub 是 host 的事(它才有联邦视图),见下。

骨架节点(trigger / 简单 step / parallel 容器 / output)→ 第 0 列;branch 节点 → 第 1 列。
每个节点占自己一行 = 精确竖直堆叠。data 边画在不透明盒子**之下**(穿左侧檐沟的虚线弓形),
sequence 边带箭头,容器→分支是肘形曲线。

---

## 四、跨 hub 戳记(一个检测器,零漂移)

`graphOf` 在纯投影之后,**复用 `computeCrossHubSteps(def)`** 给每个派到 off-hub 的节点
戳上目的地(`{ peer, peerLabel, kind }`,`kind:'peer'` = mesh 对端可能要审批 /
`kind:'a2a'` = 外部 A2A 立即外发)。

这是关键正确性约束:**流程图的跨 hub 标和 admin 启动前可见性的 `crossHubSteps`、
成员编辑器的出入口锁——用的是同一个检测器,绝不会互相打架**(见
[`V5-G-FINAL.md`](./ledger/V5-G-FINAL.md) G2 + [`V5-WFEDIT-FINAL.md`](./ledger/V5-WFEDIT-FINAL.md))。
`CrossHubStep.stepId` 是 `<stepId>`(简单步)或 `<stepId>/<branchId>`(parallel 分支)——
正好是投影发出的两种 node-id 形状(`step:` / `branch:` 前缀),一次索引一遍标注。

**单 hub host 戳记不了任何东西**(没有 off-hub 视图)→ `crossHub` 全留 undefined,零额外成本。

---

## 五、路由 + 闸

`GET /api/admin/workflows/:id/graph`:

- **admin 闸**(`requireAdmin`),**不是** RBAC 闸——看一条工作流的形状是 operator 读,不是改动。
- 没接 `graphOf` 的旧 host → 404「workflow graph not enabled」(前端据此隐藏按钮)。
- 未知 id → 404。
- 返回 `{ graph: { workflowId, nodes, edges } }` 鸭子 verbatim echo,web 零 workflow 运行时依赖。

修订解析跟 `summaryFromView` 一致:`currentRevision ?? headRevision`——已发布就画已发布那版,
还是草稿就画最新编辑的形状。

---

## 六、测试

| 层 | 测试 | 覆盖 |
|---|---|---|
| workflow | `tests/graph.test.ts`(D-M1) | 纯投影:节点/边形状、parallel 容器插序、data 边过滤、trigger 标志 |
| web | `tests/workflow-graph-route.test.ts`(D-M3) | 路由转发 `graphOf`、verbatim echo、url-decode、null→404、legacy→404、401 |
| host | `tests/workflow-graph-e2e.test.ts`(D-M5) | **真栈**:真 `WorkflowController` 投影真导入的 `issue-triage-flow` YAML 经真版本化 resolver,经真 HTTP + admin auth;断言 parallel 容器/三分支/sequence 骨架/data 依赖/trigger 标志/单 hub 无跨 hub 戳;404 未知 id;401 无 session |

host e2e 是 web 单测覆盖不到的那个缝:web 单测打桩 `graphOf`,host e2e 让**真投影从一份
真 YAML 经真 resolver 跑出来**。

---

## 七、诚实边界(显式非目标)

- **不是编辑器**:只读。改工作流走 YAML import / 成员大白话编辑,不在图上拖拽。
- **无布局引擎**:手绘 SVG 按节点数组序竖直堆叠(骨架 col 0 / 分支 col 1),没引图表库、
  没做力导向/自动布局——工作流是浅 DAG,竖直堆叠足够读。
- **不画运行态**:这是**定义**的图,不是某次 run 的执行轨迹。某次 run 实际去了哪个 peer、
  哪一步挂在审批闸——那是运行详情的事(见 [`V5-G-FINAL.md`](./ledger/V5-G-FINAL.md) G2 day-3/4/5)。
- **governance / 风险**是另一套标(admin 卡片的琥珀风险摘要),流程图只画**结构 + 跨 hub 蓝标**,
  不重复 governance 的事。
