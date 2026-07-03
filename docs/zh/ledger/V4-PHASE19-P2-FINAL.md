# v4 Phase 19 / P2 — Workflow 治理收口（FINAL）

> 把工作流从「能跑」推到「**能治理**」：导入/发布有运行时硬闸、生命周期转移进
> 统一审计且可导出、资源级 RBAC 让 workflow 有 owner 可委托编辑权。
>
> 6 个里程碑（M5 拆 a/b/c），一个里程碑一个小 commit，纯本地 `main`。
>
> Commit 线：`926ef29`(M1) → `827c18b`(M2) → `6a1c276`(M3) → `18eef58`(M4) →
> `ffd4d39`(M5a) → `c5ffcbd`(M5b) → `077142c`(M5c) → 本文(M6)。

---

## 一、缺口（开工前已用真代码核实）

| # | 现状 | 治理缺口 |
|---|---|---|
| 1 | `parseWorkflow` 接受了语法合法但运行时会爆的 workflow（`bad_ref` / `forward_ref` / `self_trigger_cycle` / dispatch 到无人满足的 cap） | `checkWorkflowStructure`（`@aipehub/evals`，6 类违规）此前只在 `WorkflowAssistantAgent` 里**建议性**调用；import/publish 无硬闸 |
| 2 | `audit_log` 表 + `listAuditLog` 已有，但 `AUDIT_ACTIONS` 没有 `WORKFLOW_*` | 生命周期转移只写本地 `lifecycle.json`；「谁发布/下线了这个 workflow」无统一审计 |
| 3 | RBAC 仅 `owner/admin/member/viewer` 四个组织角色，所有 workflow CRUD 走 `requireAdmin` | **零资源级权限**：无法把某个 workflow 的编辑权委托给特定成员而不给整个 hub 的 admin 权 |

北极星对齐：第 3 层「框架清晰 + 稳定 + 适配」——治理边界要**显式**（硬闸/审计/
RBAC 都是显式声明的边界，不是隐式约定）。

---

## 二、各里程碑

### P2-M1 — import/publish 运行时感知硬闸（`926ef29`）

`parseWorkflow` 之后再过一道 `checkWorkflowStructure(def, inventory)`，`inventory`
是当前 hub 上每个已注册 participant 的能力清单。分级（host `isBlockingViolation`）：

- 🔴 **HARD**：纯结构 bug，任何 agent 注册都救不了 → import / draft / publish 全拒：
  `bad_ref` / `forward_ref` / `self_trigger_cycle` / `id_collision`。
- 🟡 **unknown_agent**（显式 `strategy.to` 指向未注册 id）：挡**主动 go-live**
  （import / publish），但**容忍存 draft**（可能跨 hub 实例化）。
- ⚪ **unknown_capability**：**仅建议**，从不抛。「agent 还没建就先导入 workflow」是
  合法的（bundle 路径；运行时靠 `no_participant` 自愈）。这一刀的克制是关键——既保住
  ~15 处 dispatch 到未满足 cap 的现有 fixture 不回归，又延续 Phase 13 M4「deepCheck
  建议性」的既定规范。

接线要点：`WorkflowController.assertStructurallySound`（import/publish
`blockWarnings=true`，saveDraft=false）；无 text 的 publish（promote head）连 head
def 一起深检，所以「带 unknown_agent warning 存的 draft」仍被挡在 go-live 之外（新增
`WorkflowVersioning.headDefinition(id)` 访问器）。**不**从 `adoptAtBoot` 调（boot 期
agent 注册顺序未定，boot 检会误判）。抛出的 `WorkflowLifecycleError('structure_check_failed')`
带结构化 `violations`，web `lifecycleErrorBody` 在 import/draft/lifecycle 路由原样
echo `code` + `violations`，admin UI 直接渲染。

### P2-M2 — workflow 生命周期审计行（`827c18b`）

五个动作进 `AUDIT_ACTIONS`：`workflow_import / publish / deprecate / archive /
rollback`。每次治理级转移写一行 `audit_log`，回答「谁把这个 workflow 推到了哪个
修订」。`review/draft` 这类编辑期 churn 故意不审计；boot 采纳（`adoptAtBoot`）绕过
HTTP，所以重启永不污染日志。

**关键设计**：审计写在 **web 层**，sink 从已有的 `ctx.identity` 取——`IdentityStore`
结构上满足窄接口 `WorkflowAuditSink`（只碰 `writeAuditLog`），所以零新 host 接线，web
保持零 identity 运行时依赖。写是 best-effort：审计插入失败绝不回滚已提交的转移。
`actorSource='v4-session'`；`metadata` 钉 `{workflowId, revision, state}`——rollback
记的是**新 run 现在绑定的修订**，不是 rollback target。

### P2-M3 — workflow 审计查询 + CSV/JSONL 导出（`6a1c276`）

两个 owner-gated 端点，跟现有 identity 审计路由同处（同 gate、同 store、同 exporter，
零新 auth 接线）：

```
GET /api/admin/identity/audit/workflows          (JSON list)
GET /api/admin/identity/audit/workflows/export   (CSV / JSONL attachment)
```

过滤：`?workflowId=`（经 SQL `json_extract(metadata,…)` scope，分页正确）、`?action=`
（窄到单个 workflow 动作；非 workflow 动作被忽略并回落到五动作全集，**永不泄漏**
login/credential 行）、`?since=&until=`（epoch-ms）。

查询能力**泛化**加到 identity 的 `listAuditLog` / `ListAuditLogQuery`：`actions[]`
（action IN）、`since/until`（ts range）、`metadataEquals {path,value}`（`json_extract`
两参数都绑定 → 注入安全；通用审计 store 保持不懂 workflow 语义）。导出复用
`export-format.ts` + 审计 CSV 列，跟兄弟 `/audit/export` 一样 cap 在 store 的 1000 行。

### P2-M4 — admin UI 审计查询面板（`18eef58`）

给每个 workflow 已有的「修订历史」modal 加一个「治理审计」子区——「这个 workflow 的
历史」=修订（**改了什么**）+ 审计（**谁改的、何时**）。复用 modal 的 open/close/Esc
接线（无新 modal、无新卡片按钮），节点轻。

子区列 `workflow_*` 审计行（action·actor·revision·time）+ action `<select>` 过滤 +
CSV/JSONL 导出链接。独立于修订 fetch 加载（分离端点+gate），优雅降级：非 owner admin
（403）或无 identity store 的 host（503）看到提示而修订仍正常。8 个 zh/en i18n key，
静态资源重建（admin.js bundle + static-assets.ts），resolveDom id 跟 app.html 1:1 核对。

### P2-M5 — 资源级 RBAC（workflow ownership MVP，identity v13）

**决策点**（用户拍板 **Option B**）：workflow 记 owner + 轻量
`workflow_grants(userId, workflowId, perm)`，**只先覆盖 workflow**，agent/vault/peer
仍 `requireAdmin`。拆三步：

**M5a — schema + store（`ffd4d39`）**：identity v13 加性 `workflow_grants(workflow_id,
user_id, perm, granted_by, granted_at)` 表。**owner-as-grant**：OWNER 就是 `perm='owner'`
那一行，所以「拥有」和「共享」共用一个模型一张表（无独立 owner 列）。perm 是阶梯
`owner > editor > viewer`，按 rank 比（无 SQL CHECK，可不迁移地长）。复合 PK 给
upsert-on-regrant；无 FK to users（删用户后 grant 悬空、可 prune——跟 `audit_log` 同
姿态）。新 `WorkflowGrantStore`（仿 `LedgerStore`：聚焦 + eager statements）+
`IdentityStore` facade 7 方法。`has(min)` 是热路径强制检查（rank ≥ 要求；缺失或未知
perm → false，**fail closed**）。

**M5b — 路由 enforce + grant CRUD（`c5ffcbd`）**：把 M5a 的 store 接进 workflow 路由。

- **RBAC 仅当** host 同时接了 `grants`（IdentityStore 带 grant 方法）**和**
  `resolveActor` 时才 ON。缺任一 → 每个 admin 都过、不 seed owner：embedded /
  pre-migration host 和现有测试无影响。
- **两类 operator 绕过** grants：v3 Space-admin Bearer（遗留 host admin）和 v4 org
  **owner**。RBAC 真正约束的唯一主体是 **role='admin' 的 v4 用户**——它过
  `requireAdmin`（`v4AdminFromRequest` 接受 owner|admin），但 `resolveActor` 报
  `isOperator=false`，所以需要 grant。
- **import/draft seed 创建者为 owner**（best-effort；seed 打嗝绝不让已成功的创建失败）。
  v3-admin import **不 seed**——operator 靠绕过管理，不靠 grant。
- **perm 阶梯**：生命周期转移要 editor+；delete + grant 管理要 owner。DELETE 还清掉
  workflow 的全部 grant（同 id 重导从干净开始）。
- 路由：lifecycle/delete 经 `denyIfNoWorkflowPerm`（403 `workflow_forbidden`）；新
  owner-gated `GET/POST /:id/grants` + `DELETE /:id/grants/:userId`。server.ts 从
  `ctx.identity` 派生 `grants`（运行时方法存在性检查 + cast——web `IdentitySurface`
  故意不建模 identity 全 API）和 `resolveActor`（从 `resolveV4Auth`）。

**M5c — admin UI 访问控制面板（`077142c`）**：修订 modal 里审计子区下方加「访问控制」
子区——grant 行（userId + perm 标签 + 撤销）、添加表单（userId + viewer/editor/owner
选择 + 授权）、刷新按钮。各自按 gate 降级：403（非 owner admin）→「仅 owner」提示；
404（无资源 RBAC 的 host）→「未启用」提示。完全由 M5b 路由背书，无新端点。

---

## 三、关键设计决策（横切）

1. **硬闸只在交互写路径，不在 boot**：boot 期注册顺序未定，boot 深检会误判 →
   `assertStructurallySound` 只在 import/publish/draft 调，`adoptAtBoot` 不调。
2. **unknown_capability 永远建议**：保住「先导 workflow 后建 agent」的 bundle 工作流，
   运行时 `no_participant` 自愈。硬闸只杀「注册再多 agent 都救不了」的纯结构 bug。
3. **审计写在 web、sink 是 `ctx.identity`**：窄接口 `WorkflowAuditSink` 让
   IdentityStore 结构满足，零新接线，web 维持零 identity 运行时依赖。同一招贯穿 M2/M5b
   （`WorkflowAuditSink` / `WorkflowGrantSink` 都是 web 侧定义、host 结构实现、cast 注入）。
4. **审计查询泛化进 identity，不教审计 store 懂 workflow**：`actions[]` / `since` /
   `until` / `metadataEquals` 是通用过滤器，workflowId scope 落在 SQL 层（分页正确），
   通用审计 store 保持中立。
5. **owner-as-grant**：不加 owner 列，OWNER = `perm='owner'` 行。拥有与共享一个模型，
   `removeAllWorkflowGrants` 一把清空。
6. **operator 绕过 = 零回归的支点**：个人模式（单 owner）和所有现存 v3-admin 部署本来
   就是 operator → RBAC 对它们是 no-op；只有团队模式里被委托的 v4 admin 才被约束。
7. **每层独立降级**：修订 / 审计 / 访问控制三个子区各自按自己的 gate 失败（404/403/503），
   一个挂了其余照常——治理 UI 不是全有或全无。

---

## 四、测试矩阵（+42，零回归）

| 包 | 新增 | 覆盖 |
|---|---|---|
| host | +4（M1） | bad_ref/forward_ref 拒；unknown_capability 建议；unknown_agent draft-ok-publish-blocked |
| identity | +8（M5a）+ 部分（M3 store） | grant round-trip/upsert/perm 阶梯/list 排序/remove/removeAll/校验/隔离；`actions[]`·since·until·`metadataEquals` |
| web | +6（M2）+9（M3）+3（M4）+15（M5b） | 审计行写出/省略/容错/无 sink 降级；workflow-only 列表 + scope + action 收窄 + owner gate + CSV/JSONL；M5b operator 绕过 / 非 owner 403 / editor·viewer 阶梯 / import seed owner / grant CRUD / delete 清 grant / RBAC-off 404 |

终态绿：**identity 307 / web 524 / host 425**。

---

## 五、运维须知

- **identity v13** 是加性迁移（新表 + 索引），符合「不需要向前兼容」且不破坏现有行；
  老库升级即建表，无数据回填。
- **资源 RBAC 默认随真 host 自动 ON**：真 `IdentityStore` 带 grant 方法 →
  `ctx.identity.hasWorkflowGrant` 是函数 → server.ts 派生出 `grants` → RBAC 生效。
  个人模式下 owner 是 operator，体感无变化。
- **谁能管访问控制**：org owner 或 v3 Space-admin（operator）对任意 workflow；v4 admin
  仅对自己 owner 的 workflow。委托编辑权 = 给某 v4 admin 发 `editor` grant。
- **审计是 `audit_log` 的过滤视图**，导出 cap 1000 行；要全量走 backup。
- **硬闸错误码** `structure_check_failed` 带 `violations[]`，前端按 `kind` 渲染
  （unknown_agent / unknown_capability / bad_ref / forward_ref / self_trigger_cycle /
  id_collision）。

---

## 六、显式推迟（保持精简）

- **完整资源级权限表**（Option A：`(userId, resourceType, resourceId, perm)` 覆盖
  agent-prompt / vault-key / MCP-server / peer）——本期只做 workflow。
- **审批/编辑权分离的工作流**（approver 角色、多人会签）——backlog #21 HITL 升级。
- 审计 UI 的**时间范围过滤**（API 已支持 `since/until`，UI 暂只给 action 过滤）。
- workflow **grant 的审计**（授权/撤销本身进 audit_log）——下一轮可加 `workflow_grant_set/revoke`。
- 跨 hub 的资源 RBAC（federation 出站 task 的 per-workflow 授权）——P4 信任契约。

---

## 七、验收对照

| 验收门 | 结果 |
|---|---|
| workflow 含 bad_ref/forward_ref/self_trigger_cycle/id_collision 时 import/publish 硬失败 | ✅ M1（host 4 测） |
| 发布/回滚/下线/归档/导入进统一 `audit_log`，可查询导出 CSV/JSONL | ✅ M2+M3（web 15 测） |
| workflow 有 owner，可委托特定 workflow 编辑权（非 owner/无 grant 被拒，owner 放行） | ✅ M5（identity 8 + web 15 测） |
| 个人模式 + 现存部署零行为变化 | ✅ operator 绕过（524 web 全绿，无改现有测试） |

下一段：**P3 — 生产级安全与运维收口**（Prometheus 业务指标 / restore smoke vitest /
安全·发布 checklist doc）。
