# v5 WFEDIT — 成员用大白话改工作流(OpenClaw 式),跨 hub 出入口锁定

> Last updated: 2026-06-09
> 状态:**完**(M1-M5)。`packages/host/src/workflow-edit-guard.ts` +
> `me-workflow-edit-service.ts` + `packages/web/src/me-routes.ts` 编辑路由 +
> `/me` 前端面板 + E2E 验收门。

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

**D3 — 诚实的 MVP 边界:peer 离线时只剩入口锁。**
egress 检测查的是 **live** peer 视图。如果目的地 peer 在编辑时**离线**,工作流读
起来就是纯本地的,egress 锁看不见它——只有 ingress(trigger)锁仍然生效(它不
需要 peer 视图)。持久化一个「这个工作流有跨 hub 步骤」的粘性标记、好在 peer 宕机
时也锁住 egress,是**明确的 follow-up**,不在本轮。模块头注释写明。

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
- **assistant 配置**:复用 Phase 13 的 `AIPE_ASSISTANT_PROVIDER`(anthropic/openai/
  deepseek/mock)+ `AIPE_ASSISTANT_MODEL` 等;缺 key → 编辑返 `assistant_unavailable`
  (503),UI 提示。
- **token 归属**:编辑触发的 assist 派发走 admin/operator 计费策略(同 Phase 13
  assist,「admins are operators, not consumers」),不计成员配额。
- **跨 hub 工作流**:成员看得到 🔒 锁定框列出 trigger + 每个 egress 步骤;改这些边
  缘一律 `boundary_locked`。要改出入口,得 owner 走 admin import(Phase 13)+ 重新
  协商 per-link 契约——这是治理动作,不是成员自助。
- **peer 离线**:目的地 peer 宕机时,跨 hub 工作流暂时只剩入口锁(见 D3)。要在 peer
  离线时也锁 egress,等粘性跨 hub 标记 follow-up。

---

## 八、显式推迟

- **粘性跨 hub 标记**:持久化「这个工作流有跨 hub 步骤」,好在 peer 离线时也锁
  egress(现按 live peer 视图,peer 宕 → 只剩入口锁)。
- **streaming 编辑预览**:Phase 8 streaming 已接 admin assist 对话框;`/me` 编辑器
  现在是请求-响应(提交后整体出结果),没接实时打字预览。
- **多步对话式编辑**:现在一次编辑 = 一句指令一个结果;没有「再调一轮」的对话态
  (assistant invalid 时返 `assistant_failed`,成员重述即可)。
- **diff 可视化**:UI 现展示改后的整份 YAML(折叠);没有逐行 before/after diff。
- **editor 以外的细粒度**:现在 editor 即可改任意本地部分;没有「只能改某些字段」
  的更细 RBAC。

---

## 九、文件清单

新增:
- `packages/host/src/workflow-edit-guard.ts`(M1 纯原语)
- `packages/host/src/me-workflow-edit-service.ts`(M2 服务)
- `packages/host/tests/workflow-edit-guard.test.ts`(M1 +12)
- `packages/host/tests/me-workflow-edit-service.test.ts`(M2 单测)
- `packages/web/tests/me-workflow-edit-routes.test.ts`(M3 +13)
- `packages/host/tests/me-workflow-edit-e2e.test.ts`(M5 +5 真栈)
- `docs/zh/V5-WFEDIT-FINAL.md`(本文档)

编辑(加性):
- `packages/web/src/me-routes.ts`(M3 编辑/可编辑路由 + reason→HTTP)
- `packages/host/src/main.ts`(M2/M3 接线 MeWorkflowEditService + surface 注入)
- `packages/web/src/server.ts`(M3 surface 类型 + ctx 穿线)
- `packages/web/static/{app.html,app.js,styles.css}` + `src/static-assets.ts`(M4 重建)
- `CLAUDE.md`(本登记)
