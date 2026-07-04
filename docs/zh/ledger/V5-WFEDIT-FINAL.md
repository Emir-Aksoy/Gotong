# v5 WFEDIT — 成员用大白话改工作流(OpenClaw 式),跨 hub 出入口锁定

> Last updated: 2026-06-09
> 状态:**完**(M1-M5 + S1-S3 粘性标记 + D1-D4 OpenClaw 手感增强)。
> `packages/host/src/workflow-edit-guard.ts` + `me-workflow-edit-service.ts` +
> `packages/web/src/me-routes.ts` 编辑路由 + `/me` 前端面板 + E2E 验收门;
> D 系列补齐 逐行 diff / 多步对话 / 实时打字流(见 §十一)。

---

## 一、为什么做(用户原话)

> 「我希望的改进思路是在个人界面中有类似 open claw 那样用自然语言即可修改工作流
> 的能力,但是在有跨 hub 连接的工作流中则不能修改出入口相关设置只能修改自己的部
> 分。」

拆成两个诉求:

1. **OpenClaw 式自然语言改工作流**——成员在 `/me`(我的 AI 桌面)里用一句大白话
   就能改一个工作流,不用碰 YAML。底座是 Phase 13 的 `WorkflowAssistantAgent`
   (自然语言 → workflow YAML 草稿 + 自 validate),WFEDIT 把它从「admin 造新工作
   流」接到「成员改已发布工作流」。

2. **跨 hub 工作流的出入口锁定**——一个工作流如果连着**别的 hub**(Stream G/H
   的跨组织编排),它的边缘是一份**受治理的契约**:
   - **入口(ingress)** = `trigger.capability`(工作流怎么被触发)。
   - **出口(egress)** = 每一个派发到「只有 off-hub 目的地(mesh peer 或外部 A2A
     agent)才提供的能力」的步骤,连同那一跳跨 per-link 契约携带的 `dataClasses`。

   这些边缘正是北极星「工作流跨边界,但凭证/数据/计费各归各家」落地的地方——
   per-link 信任契约、出站审批闸(Phase 18 `ApprovalGatedParticipant`)、data-class
   闸(P4-M4)全都钉在它们上。成员**绝不能**在「就改改工作流」时悄悄把一个跨 hub
   跳改指向、新增、删掉或重新分类。所以自然语言编辑被**闸住**:出入口必须**逐字
   节不变**,只有「自己这边」(本地逻辑)能改。

**对比 Phase 13**:那是 **admin 造新工作流**(import 即发布 rev1);WFEDIT 是
**成员改已发布工作流**(在**同一个**工作流上出新修订,不是 fork),并叠一层出入口
锁。两者共用同一个 assistant,差别在调用方与边界约束。

---

## 二、北极星对齐

| 守则 | WFEDIT 怎么守 |
|---|---|
| 框架不跑 LLM | 编辑服务自己不调 LLM,把自然语言交给 `WorkflowAssistantAgent`(经真 hub.dispatch),决策权在 assistant |
| 人是 Participant | 成员在 `/me` 里改自己有权的工作流,RBAC 走既有 `workflow_grants`(editor 闸),不发明新 admin-only 通道 |
| 状态文件优先 | 编辑落 `WorkflowVersioning` 文件存储(不可变修订),run 钉修订防漂移(Phase 15),不新增 schema |
| 跨边界但各归各家 | 出入口是受治理契约,锁定逐字节不变;只有本地部分可改 |
| 不需要向前兼容 | 纯加性:一个纯函数原语 + 一个服务 + 鸭子路由 + 前端面板,零 core/identity schema 改 |

---

## 三、关键设计决策

**D1 — 出入口锁是纯函数,且复用同一个跨 hub 检测器。**
`enforceEditBoundary(original, edited, localCaps, peerEntries)` 住在
`packages/host/src/workflow-edit-guard.ts`,**纯**——无 Hub、无 LLM、无 versioning。
它是唯一一处决定「这次编辑动没动跨 hub 边界?」的地方,所以编辑服务(M2)和
`/me` 路由(M3)闸在**完全同一个**边界定义上。跨 hub 检测本身委托给
`crossHubStepsOf`(**就是** admin 启动前可见性用的同一个检测器,Stream G2),
所以「UI 标成跨 hub 的」和「编辑器锁住的」**绝不漂移**。

**D2 — 入口永远锁,出口按 live peer 视图锁(最小锁原则)。**
trigger 不需要 peer 视图,且是工作流的调用契约,所以**永远**锁。egress 按当前
peer-capability 视图判定(一步是「跨 hub」当且仅当某 peer 现在通告它的 cap 且本地
无参与者提供)。一个**纯本地**工作流 egress 为空 ⇒ **只锁 trigger**,这是最小锁
——纯本地工作流享有完整 OpenClaw 自由(步骤体、`when:`、`human:` 文案随便改)。

**D3 — 粘性跨 hub 标记:peer 离线时 egress 仍锁(S1-S3 收口)。**
egress 检测原本只查 **live** peer 视图:目的地 peer 在编辑时**离线**,工作流读起来
就是纯本地的,egress 锁看不见它——只剩 ingress(trigger)锁。S1-S3 补了一个**粘性
标记**关掉这个窗口:
- **捕获(S2)**:`WorkflowController` 在每次写/转移(import/publish/deprecate/…,
  统一漏斗 `summary()`)把工作流当前送出 hub 的**能力**记进一个文件优先的
  `FileCrossHubMarkerStore`(`<space>/workflows/cross-hub/<id>.json`)。**单调并集**
  ——只在 peer 连着时增长,从不收缩;peer 离线 ⇒ `crossHubSteps` 缺席 ⇒ 并入 ∅ ⇒
  no-op(复用 summary 已算好的 `crossHubSteps`,继承「本地满足 ⇒ 非 egress」)。
- **consult(S2)**:`MeWorkflowEditService` 读同一个 store(best-effort `loadSticky`),
  把粘性能力穿进 `enforceEditBoundary`/`workflowBoundary`。守卫追加一个**合成离线
  peer**(`__gotong_sticky_offline__`,通告粘性能力,**最后**追加 ⇒ 真在线 peer 仍
  优先归属),复用同一个 `crossHubStepsOf`(零漂移)。一个粘性能力**现在本地有人提供
  了 ⇒ 自动失效**(能力收回内部,不过度锁)。
- **诚实的失效语义**:peer 离线时,标记只知道**原本**送出去的能力,不知道改后的新
  能力。所以成员把一个 egress 步**改投**到另一个 cap,守卫看到的是粘性 egress 能力
  被**移除**(`egress_removed`),而非 live 路径下的 `egress_retargeted`——**不同 kind,
  同一把锁**,且 **fail-safe**(照样 `boundary_locked`,啥都不写)。
所有新参数/依赖都可选 ⇒ 缺席即回到 S1 前行为(纯本地无标记)。无 identity schema。

**D4 — 编辑 = 同一工作流出新修订,不是 fork。**
`/me` catalog 只列**已发布**工作流。一次编辑在**同一个 id** 上:live 工作流走
**publish-edit**(出 rev2),draft 走 `saveDraft`。靠 Phase 15 的 versioning,run
钉住自己启动时的修订,所以正在跑的 run **不漂移**。

**D5 — 五种违规,各带成员可读的中文 detail。**
`trigger_changed | egress_added | egress_removed | egress_retargeted |
egress_dataclass_changed`。每条违规带 `stepId`(步骤级时)+ 一句中文解释,直接
原样回给成员看(例:「出口步骤 "place" 的跨 hub 目标能力被改 — 出口去哪个 hub 不
可改」)。data-class 列先 canonicalize(stringify + 去重 + 排序),所以顺序/重复
永远不会被误读成改动。

**D6 — 服务管线 fail-closed,reason 映射 HTTP。**
`MeWorkflowEditService.edit()` 11 步管线,任何一步失败都返回一个判别式
`reason`(见 §四),web 路由按 `statusForEditReason` 映射 HTTP(403/404/409/422/
503/400)。`boundary_locked` 是 409(冲突)并带 `violations[]`。

---

## 四、编辑管线(端到端数据流)

```
成员在 /me 输入一句话「把第一步的提示写详细一点」
        │
        ▼  POST /api/me/workflows/:id/edit { instruction }   (userId 服务端强制)
   web me-routes.ts ── 鸭子 MeWorkflowEditSurface (web 零 host 运行时依赖)
        │
        ▼  MeWorkflowEditService.edit({ workflowId, instruction, userId })
   ┌─ 1. RBAC: hasWorkflowGrant(id, userId, 'editor') ───────► 否 → forbidden (403)
   ├─ 2. versioning.has(id) ────────────────────────────────► 否 → not_found (404)
   ├─ 3. getState(id): review→under_review(409) / archived→archived(409)
   ├─ 4. exportDefinitionText(id) ──────────────────────────► null → no_source (409)
   ├─ 5. assist.assist({ description=composeEditPrompt(yaml,instruction), contextHints, by })
   │        │  (经真 hub.dispatch 到 WorkflowAssistantAgent)
   │        ├─ throw ───────────────────────────────────────► assistant_unavailable (503)
   │        └─ draftStatus≠'valid' ─────────────────────────► assistant_failed (422)
   ├─ 6. parseWorkflow(assistant.yaml) ─────────────────────► throw → parse_failed (422)
   ├─ 7. edited.id !== workflowId ──────────────────────────► id_changed (422)
   ├─ 8. ★ enforceEditBoundary(original, edited, localCaps, peerEntries)
   │        └─ violations ──────────────────────────────────► boundary_locked (409) + violations[]
   ├─ 9. isLiveState(state) ? publish(id,{text,by}) : saveDraft(text,{by})
   │        └─ 结构硬闸 throw ───────────────────────────────► structure_failed (422)
   └─ 10. ok: { state, applied, yaml, explanation, boundary, deepCheck? }
        │
        ▼  edited 工作流 = 同一 id 的新修订 (live→rev2 / draft→新草稿)
   versioning 文件存储 (不可变修订)  ← run 钉修订防漂移 (Phase 15)
```

`composeEditPrompt(currentYaml, instruction)` 把当前 YAML 和成员的指令一起塞进
assistant 的 description;assistant 返回改好的整份 YAML(```yaml fence)。

`editableView(workflowId, userId)` 是只读姊妹:RBAC + 取当前 YAML + 算边界,返回
`{ editable, yaml, boundary, crossHub }` 给前端渲染「锁定提示」(archived/review →
`editable:false`,UI 禁用编辑框)。

---

## 五、里程碑

| M | commit | 内容 |
|---|---|---|
| WFEDIT-M1 | `fd36d07` | 纯出入口锁原语 `workflow-edit-guard.ts`:`workflowBoundary` + `enforceEditBoundary` + 5 种违规 + `PeerCapEntry`/`WorkflowBoundary`/`EgressStep`/`BoundaryViolation` 类型;复用 `crossHubStepsOf` 检测器防漂移;data-class canonicalize;+12 单测 |
| WFEDIT-M2 | `5fcdbb7` | host `MeWorkflowEditService`:11 步管线(RBAC→versioning→state→exportText→assist→parse→id→★边界锁→publish/saveDraft)+ `edit()`/`editableView()` + 11 个判别 `reason` + 鸭子依赖 `WorkflowGrantView`/`WorkflowEditTarget`/`WorkflowAssistView`/`LocalParticipantView` |
| WFEDIT-M3 | `70dbdc9` | web `/me` 编辑路由:`POST /api/me/workflows/:id/edit` + `GET /api/me/workflows/:id/editable`;鸭子 `MeWorkflowEditSurface`(web 零 host 依赖);`statusForEditReason` reason→HTTP 映射;userId 服务端强制;+13 路由测试 |
| WFEDIT-M4 | `053e3d8` | 成员 SPA「用大白话改这个工作流」面板(app.html + app.js + styles.css + 重建 static-assets):打开编辑器 → 🔒 跨 hub 出入口锁定框(列 trigger + 每个 egress 步骤 cap+dataClasses)vs ✅ 纯本地框 → 折叠 YAML → 指令 textarea → 提交;boundary_locked 时列违规;选中工作流变更时重置编辑器 |
| WFEDIT-M5 | (本提交) | E2E 验收门 `me-workflow-edit-e2e.test.ts`(真栈 5 测)+ 本文档 + CLAUDE.md 登记 |

---

## 六、E2E 验收门(M5,真栈)

M2 单测用轻量 fake 驱动服务;M3 路由测试转发到**假** surface。M5 闭合两者都覆盖不
到的那道缝——**真**管线端到端:

- 真 `WorkflowController` + `WorkflowVersioning`(文件存储,防漂移核心)
- 真 `WorkflowAssistantAgent` 经真 `Hub` 派发(**确定性** mock LLM,断言稳定,
  不烧真 key——mock 按指令里嵌的 marker 分支返回对应 YAML)
- 真 `IdentityStore` RBAC grants
- 真 `enforceEditBoundary` 锁

5 个测试,对真栈证 3 个核心断言(正是用户要的):

1. **纯本地编辑 → 同一工作流出新不可变修订(无漂移)** — 成员改一句话,工作流从
   rev1 → rev2(`listRevisions` 长度 2),不是 fork;`boundary.egress` 为空(纯本地
   只钉 trigger),改动落盘。完整 OpenClaw 自由。

2. **★ 重指向跨 hub 出口 → `boundary_locked` 且什么都没持久化(锁是真的)** —
   成员试图把下单那步改发到加急渠道,被拒 `egress_retargeted`,**且** controller
   仍**只有** rev1、磁盘 YAML 逐字节不变。锁**真的挡住了写**,不是只返回个错误。
   (安全断言)

3. **改跨 hub 工作流的本地步 → 出口逐字节不变 + 出新修订(rev2)** — 「改自己这边」
   能用:本地 draft 步改了,egress 那跳(cap + dataClasses)原样保留。

外加两测:`editableView` 对跨 hub 工作流返回真 YAML + 受治理边界(`crossHub:true`);
无 editor grant 的成员被拒 `forbidden` 且 assistant 从不运行(工作流停在 rev1)。

```
host vitest: tests/me-workflow-edit-e2e.test.ts  ✓ 5 passed
host 全量:   878 passed | 1 skipped (零回归, +5)
```

---

## 七、运维须知

- **谁能改**:在某工作流上有 `editor`(或 `owner`)grant 的成员。owner 通过 admin
  访问控制面板(P2-M5)或 `/me` 授权 UI(A-M4)授予。无 grant → 403,assistant 从
  不运行(省 token)。
- **assistant 配置**:复用 Phase 13 的 `GOTONG_ASSISTANT_PROVIDER`(anthropic/openai/
  deepseek/mock)+ `GOTONG_ASSISTANT_MODEL` 等;缺 key → 编辑返 `assistant_unavailable`
  (503),UI 提示。
- **token 归属**:编辑触发的 assist 派发走 admin/operator 计费策略(同 Phase 13
  assist,「admins are operators, not consumers」),不计成员配额。
- **跨 hub 工作流**:成员看得到 🔒 锁定框列出 trigger + 每个 egress 步骤;改这些边
  缘一律 `boundary_locked`。要改出入口,得 owner 走 admin import(Phase 13)+ 重新
  协商 per-link 契约——这是治理动作,不是成员自助。
- **peer 离线**:目的地 peer 宕机时,**粘性跨 hub 标记**(S1-S3,见 D3)让 egress 仍然
  锁住——`FileCrossHubMarkerStore` 在 peer 在线时捕获了「这个工作流送出去哪些能力」,
  离线编辑时 consult 这个文件重新激活 egress 锁。fail-safe:改投一个 egress 步显示
  `egress_removed`(标记只知原 cap),照样 `boundary_locked` 啥都不写。

---

## 八、显式推迟

- ~~**粘性跨 hub 标记**~~:**已做(S1-S3)**——持久化「这个工作流送出去哪些能力」,
  peer 离线时 egress 仍锁。见决策 D3 + §十。
- ~~**diff 可视化**~~:**已做(WFEDIT-D1+D2)**——host 纯 LCS 行 diff 进 edit 响应,
  `/me` 面板渲染绿加红删 + 折叠未变行。见 §十一。
- ~~**多步对话式编辑**~~:**已做(WFEDIT-D3)**——客户端持 turn 日志,服务端裁剪后
  喂回 assistant,「再礼貌一点」这类指代能解析。见 §十一。
- ~~**streaming 编辑预览**~~:**已做(WFEDIT-D4)**——per-call chunk 路由 + 同一
  POST 上的 NDJSON 流,成员实时看 AI 打字且只看得到自己这次的字节。见 §十一。
- **editor 以外的细粒度**:现在 editor 即可改任意本地部分;没有「只能改某些字段」
  的更细 RBAC。
- **离线重指向的精确识别**:peer 离线时改投 egress 报 `egress_removed` 而非
  `egress_retargeted`(标记只知原 cap),同一把锁不漏,只是 kind 保守。

---

## 九、文件清单

新增:
- `packages/host/src/workflow-edit-guard.ts`(M1 纯原语;S1 加 sticky-aware 重载)
- `packages/host/src/me-workflow-edit-service.ts`(M2 服务;S2 加 `crossHubMarkers` consult)
- `packages/host/src/cross-hub-marker.ts`(**S1** — `CrossHubMarkerStore` +
  `FileCrossHubMarkerStore`,文件优先单调并集标记)
- `packages/host/tests/workflow-edit-guard.test.ts`(M1 +12;S1 +8 sticky 锁)
- `packages/host/tests/me-workflow-edit-service.test.ts`(M2 单测;S2 +5 consult)
- `packages/host/tests/cross-hub-marker.test.ts`(**S1** +7 标记 store)
- `packages/web/tests/me-workflow-edit-routes.test.ts`(M3 +13)
- `packages/host/tests/me-workflow-edit-e2e.test.ts`(M5 +5 真栈;**S3** +3 离线 peer)
- `docs/zh/ledger/V5-WFEDIT-FINAL.md`(本文档)

编辑(加性):
- `packages/web/src/me-routes.ts`(M3 编辑/可编辑路由 + reason→HTTP)
- `packages/host/src/main.ts`(M2/M3 接线 MeWorkflowEditService + surface 注入;
  **S2** 构造一个 `FileCrossHubMarkerStore(SPACE_DIR)` 共享给 controller + edit service)
- `packages/host/src/workflow-controller.ts`(**S2** `crossHubMarkers?` option +
  `summary()` 捕获漏斗)
- `packages/host/tests/workflow-controller.test.ts`(**S2** +4 捕获侧)
- `packages/web/src/server.ts`(M3 surface 类型 + ctx 穿线)
- `packages/web/static/{app.html,app.js,styles.css}` + `src/static-assets.ts`(M4 重建)
- `CLAUDE.md`(本登记)

---

## 十、S1-S3 — 粘性跨 hub 标记(离线 peer 也锁 egress)

**问题**:`enforceEditBoundary` 的 egress 检测查 **live** peer 视图——目的地 peer 在
编辑时**离线**,跨 hub 工作流读起来就是纯本地的,egress 锁看不见它(只剩 trigger 锁)。
一个成员能趁 peer 宕机的窗口悄悄改/删一个跨 hub 步。

**一句话**:把「这个工作流送出去哪些能力」做成一个**文件优先、单调、能力粒度**的粘性
标记,写路径捕获、编辑路径 consult,所以 peer 离线时 egress 仍锁。

| M | 干了什么 | commit |
|---|---|---|
| **S1** | 纯 sticky-aware 边界 + 标记 store —— `cross-hub-marker.ts`(`FileCrossHubMarkerStore`,`<space>/workflows/cross-hub/<id>.json`,单调并集,best-effort 读)+ `workflow-edit-guard.ts` 加 `withStickyOfflinePeer`(合成离线 peer **最后**追加 ⇒ 真在线 peer 仍优先归属)穿进 `workflowBoundary`/`enforceEditBoundary`(全可选 ⇒ 缺席即旧行为)。+15 测 | `76bf749` |
| **S2** | 控制器捕获 + 编辑服务 consult + main.ts 接线 —— `WorkflowController.summary()`(写/转移**唯一漏斗**;读路径走 `summaryFromView` 不捕获)把 `out.crossHubSteps` 的能力并进标记(best-effort,marker 写失败绝不让工作流写失败);`MeWorkflowEditService.loadSticky()` 读同一 store 穿进两处边界;`main.ts` 一个 store 共享给两边。+10 测 | `e91f8a0` |
| **S3** | 离线 peer E2E 验收门 —— `me-workflow-edit-e2e.test.ts` 真栈(真 `WorkflowController`+`WorkflowVersioning`+**真 `FileCrossHubMarkerStore` 落盘**+真 assistant mock LLM):peer **在线**导入 ⇒ 捕获到真文件;peer **离线**(无 peer 视图)成员改投 egress ⇒ `boundary_locked`/`egress_removed` 且**零持久化**;无标记对照组**滑过去**(证明标记是锁的来源);纯本地工作流**从不**累积标记(不过度锁)。+3 测 | 本提交 |

**关键不变量**:① 标记**能力粒度**(跨 hub 性是能力的属性,守卫每次从 live 定义重算每步
data-class,标记只存能力串);② **单调**——只在 peer 连着时增长从不收缩,成员离线 publish
并入 ∅ = no-op;③ **自动失效**——一个能力现在本地有人提供了 ⇒ `crossHubStepsOf`「本地满足
⇒ 非 egress」让它退出锁(零特判,标记不必清理);④ **fail-safe** 失效语义——离线改投显示
`egress_removed`(标记只知原 cap)而非 `egress_retargeted`,不同 kind 同一把锁。

---

## 十一、D1-D4 — OpenClaw 手感增强(diff / 对话 / 实时打字)

M1-M5 交付的是**正确性**(锁是真的、修订是真的);D 系列交付的是 OpenClaw 那种
**手感**——§八原推迟清单里「逐行 diff 可视化 / 多步对话式编辑 / streaming 编辑预览」
三项,按依赖顺序逐个做实。锁与管线**零改动**:四个里程碑全是编辑结果之上的呈现/
会话/传输增强,`enforceEditBoundary` 与 11 步管线原样。

| M | 干了什么 | commit |
|---|---|---|
| **WFEDIT-D1** | 编辑结果携带**行级 diff**——新 host 纯函数 `workflow-edit-diff.ts` `computeLineDiff(before, after)`(LCS 行 diff,same/add/del,替换处 del 先于 add,无幻影换行变化;防御性 cell cap 对超大输入诚实降级成「整体替换」而非无界 DP 表)。`MeWorkflowEditOk.diff` = 改前 YAML → 落盘 YAML。diff 算在 host 不在浏览器:编辑服务是唯一同时握有同一次管线两侧文本的地方,纯函数吃真 vitest,手写 SPA 保持哑渲染器 | `fcba428` |
| **WFEDIT-D2** | `/me` 面板**渲染** diff——保存成功后插「查看这次改动」details(默认展开),绿 add / 红 del,长 same 连串折叠成「… N 行未变 …」(改动两侧各留 2 行上下文);渲染在 `refreshEditorBody` **之后**追加(那次刷新整体替换 body innerHTML);无 add/del(LLM 原样返回)则完全不渲染,不给成员看空 diff | `2f434f1` |
| **WFEDIT-D3** | **多步对话式编辑**——同一编辑器里连续下指令时,之前每轮的要求和结果(成功或被拒)喂回 AI,「再礼貌一点」「还是改回去」这类指代能解析。状态住**客户端**(hub 请求间什么都不存,编辑器本就无状态):app.js 持 turn 日志随每次 POST 重发;host 是唯一权威——`sanitizeEditHistory` 丢畸形 turn、裁剪超长字段(500 字符)、只留最后 6 轮,`composeEditPrompt` 在 YAML 与本次要求之间插「之前的修改对话」节并明说:上面的 YAML 已含成功改动、失败的改法别原样重试 | `5792ac7` |
| **WFEDIT-D4** | **成员安全的实时打字流**——admin assist 的流式吃全局 `/api/stream` SSE(admin 闸后,广播**所有**任务的 chunk),成员不能复用。D4 走 **per-call chunk sink**:assist surface 把调用方 sink 登记在闭包 Map,一次性 `randomUUID()` 键随派发 payload(`__streamSinkKey`)走,agent 构造级 `onStreamChunk` 按键路由**只转 text 增量**(拼接=逐字节复原最终回复,llm 契约),finally 清理。传输 = **同一 POST 上的 NDJSON**(body `stream:true` → `application/x-ndjson`:打字期间逐行 `{"kind":"chunk"}`,最后一行 `{"kind":"result"}`);流式下失败骑 result 行(`ok:false` + 与非流式同字段),老客户端不带 stream 字段行为逐字节不变。成员安全**按构造成立**:chunk 只沿成员自己的请求/响应对向上流。前端蓝色「✨ AI 正在打字…」面板(`.me-wf-stream`,admin assist 预览的孪生) | `bfb9051` |

**测试**:D1 +18(diff 纯函数 14 + 服务/路由穿线)/ D3 +13(sanitize/compose 9 +
服务/路由 4)/ D4 +9(assist-agent 3 含**并发隔离证明**——兄弟调用的 chunk 漏进来
会让拼接文本翻倍,精确相等=隔离;edit-service 2;web 流式路由 4 真 HTTP harness)。
全量 host 930+1 / web 897 绿。

**新增文件**:`packages/host/src/workflow-edit-diff.ts` +
`packages/host/tests/workflow-edit-diff.test.ts`(D1);其余 D 系列改动全落在
M1-M5/S1-S3 已有文件(`workflow-assist-agent.ts` / `me-workflow-edit-service.ts` /
`me-routes.ts` / `app.js` / `styles.css` 及对应测试)。

**仍推迟**(D 系列之后):editor 以外的细粒度字段级 RBAC / 离线重指向的精确
`egress_retargeted` 识别(现保守报 `egress_removed`,同锁不漏)/ 流式 diff
(diff 仍在 result 行整体到达;打字流是 LLM 原文,diff 要等落盘后才算)。
