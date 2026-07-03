# V4 Phase 19 · P1 —「我的 AI 桌面」成员工作台收口（小结）

> 状态: **P1 完**（P1-M1 ~ P1-M6）。这是 Phase 19 第一优先级的收口小结;
> 整个 Phase 19（P1~P5）跑完后另出 `V4-PHASE19-FINAL.md`。
>
> Last updated: 2026-06-01

---

## 一、为什么做（北极星缺口）

CLAUDE.md「偏 1」记着一条长期欠账:**个人 / 成员的入口被 admin 视角盖住**。
`/me` 在 Phase 14 拿到了「派发面向成员的 workflow」、Phase 16 拿到了「inbox 待办」,
但它还停在「一个派发表单 + 报告下载」,不是一个能自洽过日子的工作台。

「机构可用」总验收第 1 条:**普通成员能在 `/me` 完成 80% 日常 AI workflow,
不进 admin**。P1 把 `/me` 补齐到这个标准。

不变量(贯穿):

- **人是 Participant**:`/me` 不发明新机制,全走既有 `/api/me/*` + Task/transcript。
- **框架不跑 LLM / web 零运行时依赖**:每个新面都是 web 鸭子类型 surface,host 侧
  实现 + 注入(`serveWeb` opts → `HandlerCtx` → me-route ctx);surface 缺省即降级
  (空列表 / 503),不崩。
- **scope 防 spoof 不动**:`/api/me/dispatch` 强制 `payload[userScopeField]=userId`
  (`me-routes.ts`)这条 Phase 14 的安全边界保持原样。

---

## 二、动了什么（逐里程碑）

| M | 标题 | 关键改动 | commit |
|---|---|---|---|
| P1-M1 | RunStore 按用户索引 | **核实 run 文件已带发起人**(`RunState.triggeredByOrigin.userId`,`/me/dispatch` 落 `origin:{orgId:'local',userId}`,runner 持久化)→ **无需加字段**(§四确认点自动消解);`RunStore.listByUser(userId,{limit?,workflowId?})` + 私有 `collectSummaries`;旧 run 无 origin → 不可见(降级不崩) | `4dc266e` |
| P1-M2 | `/api/me/runs` + catalog 状态 | 复用现有 `WorkflowSurface`(加 `listRunsByUser`)结构满足窄 `MeRunSurface`(`runs: ctx.workflows`);`GET /api/me/runs`(userId 服务端强制);`/api/me/workflows` 每条 enrich `latestStatus`/`lastRunAt`(取一次 runs,索引每 workflow 最新,best-effort 降级) | `152e673` |
| P1-M3 | `/api/me/agents` 脱敏投影 | web 鸭子 `MeAgentListSurface` + `MeAgentView{id,label,capabilities,online,description?}`;**脱敏在 host**(`main.ts` inline surface 投影 `space.agents()`)→ web 永远拿不到 `AgentRecord.managed`(system prompt / model / baseURL / key);capability 是功能标签,照常出 | `c2d3590` |
| P1-M4 | `/api/me/uploads` 成员上传 | 镜像 `/api/admin/uploads` 但 auth 走 `resolveV4Auth` + 写到 `uploads/me/<userId>/…`(`UploadSurface.put` 加可选 `scope`);下载按 `id.startsWith('uploads/me/<userId>/')` 闸,否则 404;**上传 scope 与下载 prefix 都从 SESSION userId 派生**(`memberUploadScope`),非客户端值;host 侧 `scopePrefix` path-safe 校验当纵深防御 | `8e5423a` |
| P1-M5 | `/me` 前端面板 + 真上传器 | `app.js renderHome` 加「最近运行」`#me-runs-tbody`(`loadMyRuns`,状态彩色 pill)+「我的 AI 助手」`#me-agents-list`(`loadMyAgents`,capability chips + 在线点);`file` 字段渲染真上传器 — **提交时**上传到 `/api/me/uploads` → 发 `{type:'file_ref',artifactId,mime}` 块(与 admin wf-start 同契约,选了不提交不留孤儿);删「此入口暂不支持文件上传」占位;`build:assets` 重建 `static-assets.ts`(admin.js byte-identical) | `7eff102` |
| P1-M6 | 文档收口 | 本文 + CLAUDE.md capability 表 / 偏 1 更新 | (本提交) |

---

## 三、`/me` 现在长什么样

成员登录后 `#home-panel` 首屏(全部 `/api/me/*`,服务端按 userId 隔离):

```
当前用户         whoami（displayName / email / role / userId）
触发新一次工作流   GET /api/me/workflows（带 latestStatus / lastRunAt）→ 动态字段表单
                  └ file 字段 = 真上传器 → POST /api/me/uploads → file_ref
最近运行          GET /api/me/runs（彩色状态 pill：进行中/已完成/失败/已取消/挂起）
待处理任务        GET /api/me/inbox（approval / choice / edit；Phase 16）
我的报告          GET /api/me/growth-reports（仅本人 caseId）
我的 AI 助手      GET /api/me/agents（脱敏：能力 + 在线，无 prompt/key/config）
```

不进 `admin`,看不到 admin-only 的 prompt / vault / peer token;`/api/me/dispatch`
强制 scope=userId,无法 spoof 他人。

---

## 四、关键设计决策

1. **run 已带发起人 → 不加文件格式字段**(P1-M1)。§四「确认点」里 run JSON 加
   `origin`/`fromUser` 的变更,经代码核实**已存在**(`triggeredByOrigin`),决策自然消解。
   按用户隔离只需读这个字段,零格式变更、零迁移。

2. **复用 surface 减节点**(P1-M2)。run 列表没另起注入,直接给现有 `WorkflowSurface`
   加一个 `listRunsByUser`,结构上即满足窄 `MeRunSurface`(`WorkflowRunSummary` 是
   `MeRunView` 的超集)。少一根注入线。

3. **脱敏放 host,不放 web**(P1-M3)。敏感字段(`managed.system` / `model` / `baseURL` /
   key)在 host 侧投影时就被剥掉,web 层**从不接触**它们 → 没有「web 不小心 echo 出去」
   的可能。能力是功能标签照常出。

4. **上传隔离 = 服务端派生路径前缀**(P1-M4)。`uploads/me/<userId>/…` 的 scope 与下载
   prefix 都从 session userId 算,绝不收客户端值;host `scopePrefix` 再做一次 path-safe
   校验(纵深),配合 artifact handle 自己的 `sanitisePath`。

5. **文件 submit-time 上传,发 file_ref 块**(P1-M5)。照搬 admin wf-start 契约:选文件
   时不传、点「发起」时才传 → 选了不提交不产生孤儿 artifact;payload 值是
   `{type:'file_ref',artifactId,mime}`,workflow agent 端按既有多模态解析。

6. **i18n:跟随既有 `/me` 约定(硬编码中文,无 `data-i18n`)**。整个成员面
   (whoami/dispatch/inbox/reports,含 P16-M8 的 inbox 面板)都是中文硬编码、没接
   `data-i18n`。新两个面若只给自己加 i18n,EN 开关会出现「只有这两块翻成英文、其余仍中文」
   的割裂。保持一致 + 轻量优先。**全 `/me` i18n 是一次单独的 retrofit**(若需要)。

---

## 五、测试 / 验证

- 后端路由:`me-routes.test.ts`(`/api/me/runs` +5、`/api/me/agents` +3、
  `/api/me/uploads` 往返 + 隔离 +5)、host `uploads.test.ts`(scoped artifactId +
  path-unsafe reject +2)、`run-store.test.ts`(`listByUser` 隔离 / 旧 run 降级 +4)。
- 前端(P1-M5 静态 JS):web 全量 **496 绿** + `build` tsc clean;`build:assets`
  重建后解码 `static-assets.ts` 确认新面板 / 上传器 / 旧占位删除均已嵌入。
- **验证前清 PWA service worker(scope `/`)**:preview SW 会发陈旧静态资源
  (member SPA 同 admin.js,见 memory「Preview SW serves stale static assets」)。

---

## 六、不做 / 后续

- **全 `/me` i18n retrofit**:把成员面整体接 `data-i18n` + `app-core.js` 词条(连带
  P14/P16 既有面板),单独一节再做。
- **run 详情下钻**:`/me` 最近运行目前只列状态/时间;点进去看 step 明细是后续(admin
  已有 `wf-runs-modal`,成员侧可复用渲染层)。
- **上传 GC / 配额**:成员上传落 `uploads/me/<userId>/`,date 目录便于 sweep;接 Phase 17
  配额维度是后续。

下一步按 Phase 19 顺序进 **P2(workflow 治理收口)**。
