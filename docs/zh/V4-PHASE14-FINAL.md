# v4 Phase 14 —— `/me` 成员工作台通用化（M1-M8）

> 把 `/me` 从「单一硬编码 allowlist」改成「工作流声明驱动的成员工作台」。
> 任何登录用户（非 admin 也行）能从 `/me` 跑**声明了 `surface.me.enabled`**
> 的工作流，归属字段被后端强制绑到调用者 userId —— 成员不能替他人发起，
> 也看不到 admin 的内部细节。
>
> 完成日期：2026-05-31 · 8 个 commit（`2ba00d5` → `df9c2a5`）

---

## 一、动了什么

Phase 2（2026-05-24）给了 `/me` 一个**单工作流**的安全面：member 只能跑
`personal-growth-flow`，allowlist 是 `me-routes.ts` 里一张硬编码的
`ALLOWED_WORKFLOWS` 表，加新工作流得改 TypeScript 再发版。

Phase 14 把这张表删了，改成**请求时从实时工作流列表派生**：

```
admin import 一个工作流（YAML 里声明 surface.me.enabled: true）
        ↓
WorkflowSurface.list()  →  WorkflowSummary[]（带 surfaceMe）
        ↓
GET /api/me/workflows   →  按 enabled + allowedRoles 过滤 + 投影成员视图
        ↓
member 在 /me 首屏看到它 → 填表 → POST /api/me/dispatch
        ↓
后端强制 payload[userScopeField] = 调用者 userId
```

「成员能跑哪些工作流」不再是代码里的常量，而是**工作流定义自己声明的属性**。
授权边界从「能改 TS 的提交者」位移到「能 import YAML 的 admin」——
`/api/admin/workflows/import` 本就 admin-gated，这是文档明示的意图。

---

## 二、为什么这么做

| 痛点（Phase 2 现状） | Phase 14 解法 |
|---|---|
| 加一个 member-facing 工作流要改 `me-routes.ts` + 发版 | 工作流 YAML 里加一个 `surface.me` 块即可，import 即生效 |
| allowlist 与工作流定义分离，容易漂移 | 单一事实来源：定义自己声明，catalog 从定义派生 |
| 表单字段硬编码在前端 | `surface.me.input_schema` 跟着定义走，前端按 `field.type` 动态渲染 |
| 只支持 `case_id` 一种归属键 | `userScopeField` 可声明（示例用了 `owner_user_id`） |

---

## 三、架构主线（决定一切的一点）

web 包**不依赖** `@aipehub/workflow` 运行时。工作流定义流到 web 层只有
**一条数据通道**：`WorkflowSurface.list()` 返回 `WorkflowSummary[]`。新字段
`surfaceMe` 走的就是 `payloadSchema` 已经在走的那根管子 —— 零新通道、零依赖反转：

- **workflow 包**（M1）：`WorkflowDefinition.surface?: WorkflowSurfaceSpec`，
  parse 时显式校验（`parseWorkflow` 默认静默丢未知键，所以必须显式加）。
- **host 包**（M2）：`WorkflowController.toSummary()` 把 `definition.surface.me`
  投影成 `WorkflowSummary.surfaceMe`。
- **web 包**（M3-M5）：`serveWeb({ workflows })` → `ctx.workflows` →
  `handleMeRoute`；web 用**鸭子类型** `MeWorkflowSurface` 接口消费，不 import
  workflow 包。

---

## 四、`surface.me` schema（`packages/workflow/src/types.ts`）

```ts
export type WorkflowRole = 'owner' | 'admin' | 'member' | 'viewer'

export interface WorkflowSurfaceSpec {
  me?: MeSurfaceSpec
}

export interface MeSurfaceSpec {
  enabled: boolean              // 总开关，仅 true 才上 /me（这就是安全边界）
  label?: string                // 缺省回退 workflow.name → id
  description?: string          // 缺省回退 workflow.description
  inputSchema?: PayloadFieldSpec[]  // 复用既有 PayloadFieldSpec；缺省回退 trigger.payloadSchema
  allowedRoles?: WorkflowRole[]     // 缺省 ['owner','admin','member']（viewer 默认排除）
  userScopeField?: string           // 强制 = userId 的 payload key；缺省 'case_id'
}
```

- `WorkflowRole` 是本地字符串字面量联合，**不** import `@aipehub/identity`
  —— workflow 包保持零身份依赖。
- 校验在 `schema.ts` 的 `validateWorkflow` 末尾加 `validateSurfaceSpec`，
  `inputSchema` 直接复用 `validatePayloadSchema`，`userScopeField` 复用既有
  payload-field id 正则（防 `__proto__`），snake_case / camelCase 双接受。
- 校验失败在 import 时报错（admin 在导入框看到原文），不等运行时崩。

### 两套 schema 是有意的

`surface.me.input_schema`（成员表单）跟 `trigger.payload_schema`（admin 触发
表单）**故意不同**：admin 表单暴露归属键（可为家人/同事跑），成员表单**省掉**
归属键（后端强制成自己的 userId）。这就是两套 schema 分开存在的原因。

---

## 五、`/me` 路由（`packages/web/src/me-routes.ts`）

| 端点 | 行为 |
|---|---|
| `GET /api/me/workflows` | 从 `ctx.workflows.list()` 派生 catalog，按 `enabled` + `allowedRoles` 过滤，**只投影** `{id, label, description, inputSchema}` |
| `POST /api/me/dispatch` | `resolveMeWorkflow` 解析（null → 403）→ 拷贝 `inputFieldIds` → 强制 `payload[userScopeField] = userId` → 派发 |

核心纯函数 `evaluateMeSurface(summary, role)`：

```
gate:   me.enabled === true  &&  role ∈ (me.allowedRoles ?? DEFAULT_ME_ROLES)
resolve: inputSchema   = me.inputSchema ?? payloadSchema ?? []
         userScopeField = me.userScopeField ?? 'case_id'
         inputFieldIds  = fieldIds(inputSchema).filter(id => id !== userScopeField)
```

`DEFAULT_ME_ROLES = ['owner', 'admin', 'member']`（viewer 只读约定，默认排除，
工作流可显式 opt-in）。

**删掉的旧物**（M4/M5，pre-launch 无向前兼容包袱）：`AllowedWorkflow` 类型、
`ALLOWED_WORKFLOWS` 常量、`GET /api/me/allowed-workflows` 路由、
`listAllowedWorkflowsForMe`。

---

## 六、安全不变量逐条保住

| # | 不变量 | 泛化后如何保住 |
|---|---|---|
| a | `resolveV4Auth`，拒 v3-admin | 不动；`role` 也来自同一服务端解析 |
| b | `payload[scopeKey] = userId`（copy 后强制） | 同序，`scopeKey` = 解析出的 `userScopeField`，copy 集合**排除**它 |
| c | 仅声明字段拷贝，余丢 | 改遍历 `inputFieldIds`；scope 字段不在 input 里 → 必被丢 + 强制 |
| d | `from / origin` = userId | 不动 |
| e | per-user 限流桶 | 不动（`me-dispatch:<userId>` / `me-reports:<userId>`） |
| f | growth-reports caseId 过滤 + 下载 ACL + 防穿越 | **完全不碰**（不在泛化范围） |
| **新** | 无 `surface.me.enabled` 的工作流 `/me` **不可跑** | catalog 变开放后，`enabled` 门**就是**安全边界；`resolveMeWorkflow` fail-closed（403） |
| **新** | catalog 不泄露内部细节 | 投影故意省掉 `capability` / `userScopeField`（暴露 = 送探测面） |

---

## 七、shipped 的 member-facing 工作流（≥2 验收）

| 文件 | scope key | 成员字段 | 说明 |
|---|---|---|---|
| `personal-growth-flow.yaml` | `case_id` | present_state / aspirations / struggles / focus_request | M6，7 教练全流程；走生成器（`build-personal-growth-templates.mjs` + `build-static-assets.mjs`），非手改 bundle |
| `daily-reflection-flow.yaml` | （省略 → 默认 `case_id`） | highlights / lowlights / tomorrow_focus | M7，最小 1 步示例 |
| `weekly-goal-checkin-flow.yaml` | `owner_user_id` | goals / blockers | M7，2 步示例，练替代 scope key |

> `personal-growth.yaml` bundle 是 `scripts/build-personal-growth-templates.mjs`
> 从 `templates/workflows/personal-growth-flow.yaml`（事实来源）自动生成的；
> `packages/web/src/static-assets.ts` 是 base64 内嵌，由
> `packages/web/scripts/build-static-assets.mjs` 重生成。改源 + 跑生成器，别手改产物。

---

## 八、前端（M8）

`packages/web/static/app.js`（手写、git-tracked 的 Home tab，**不是** esbuild 的
admin.js）：

- `renderHome` → `loadMyWorkflows()` 拉 `/api/me/workflows`，存 `__myWorkflows`
- `renderWorkflowFields()` 读 `wf.inputSchema`，新 `renderField(f)` 按 `f.type`
  分流（textarea / number / select / file / text），用 `f.id` 当 name +
  `data-type` 属性
- `submitDispatch` 收集 `[name]`，`data-type === 'number'` 用 `Number` 强转
- `app.html` 文案改成通用「你只能为自己发起：归属字段由系统自动绑定到你的 userId」

---

## 九、测试矩阵

| 包 | 测试 | 覆盖 |
|---|---|---|
| `@aipehub/workflow` | `schema.test.ts` | surface.me 合法解析 / enabled 必填 / 坏 role 拒 / inputSchema 复用校验 / scope 字段正则 / 双命名 / 无 surface 不回归 |
| `@aipehub/workflow` | `templates.test.ts`（+ Phase 14 describe，11 测试） | 3 个 shipped 模板：enabled + 精确成员字段 + 有效 scope key + scope key 永不在成员字段里 |
| `@aipehub/host` | `workflow-controller.test.ts` | `toSummary` → `surfaceMe` 透传 |
| `@aipehub/host` | `me-workflows-e2e.test.ts`（3 测试，**真 WorkflowController seam**） | 真 Hub+Space+Identity+serveWeb，member 登录，catalog 派生 / dispatch 强制 scope（查 `hub.tasks()` payload 断言 `case_id === memberId` 且伪造值不出现）/ 非 member-facing → 403 |
| `@aipehub/web` | `me-routes.test.ts`（32 测试） | catalog 只含 enabled / role 过滤 / 字段来自 inputSchema / dispatch 安全契约 / fail-closed 无 surface |
| `@aipehub/web` | `manifest.test.ts`（84 测试） | 首个 builtin-bundle round-trip：`parseBundle` → `parseYaml` → 断言 `surface.me` 存活（snake_case keys） |

全量 `pnpm -r test` 绿（workflow 7 文件 / host 32 文件 / web 25 文件，其余包全过）。

---

## 十、运维须知

- **开放一个工作流给成员**：在 YAML 加 `surface.me.enabled: true`（可选
  `label` / `description` / `input_schema` / `allowed_roles` / `user_scope_field`），
  从 admin UI 或 `/api/admin/workflows/import` 导入即生效。无需改代码、无需重启。
- **`enabled` 就是闸门**：不声明 `surface.me` 或 `enabled: false` 的工作流，
  member 从 `/me` 调用一律 403。Phase 15 的 `published` 生命周期是长期闸门。
- **归属字段后端拍板**：member 哪怕 curl 直接构造
  `{payload: {case_id: 'someone-else'}}`，也会被丢弃 + 强制覆盖成自己的 userId。

---

## 十一、未做 / 推迟（→后续 Sprint）

- 成员任务 inbox（human approval/edit/choice step）→ Sprint 3（Phase 15），
  直接复用 codex 已落地的 workflow suspend/resume。
- 「我的 agents」member-safe 投影、通用 uploads 归属 ACL —— 独立较大，未纳入。
- catalog 的「本人最近一次运行」—— `RunSummary` 无 user 字段，便宜地拿不到，
  避免误导，省略该字段。
- `surface.me` 之上的 `published` 生命周期闸门 → Phase 15。

---

## 十二、commit 清单

| Commit | Milestone |
|---|---|
| `2ba00d5` | M1 workflow `surface.me` schema（type + parse + 校验） |
| `69689ad` | M2 host `WorkflowSummary.surfaceMe` 透传 |
| `fe15274` | M3 web 鸭子类型 + `ctx.workflows` 穿线（零行为变化） |
| `cc55c87` | M4 `GET /api/me/workflows` 派生式 catalog |
| `4c60e32` | M5 泛化 `POST /api/me/dispatch`，删硬编码 allowlist |
| `29dda54` | M6 personal-growth 声明 `surface.me` |
| `a7d8412` | M7 两个示例 member-facing 工作流 |
| `df9c2a5` | M8 前端 Home tab 吃 catalog + 动态字段 |
