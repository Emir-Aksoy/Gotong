# 工作流架构师 — NL→YAML + 按深度讲解 + 配图

> 一个内置的核心组件 agent：用大白话描述需求，它**写出**工作流 YAML、把它
> **讲明白**（深浅可调）、再**画出来**（绑定的流程图）。直达北极星「我的 AI
> 桌面：不写代码，AI 帮我做实际的事」。
>
> 这不是从零造的新 agent —— 它是 Phase 13 的 `WorkflowAssistantAgent`
> **演进**而来：保留 capability `workflow:assist` + id `workflow-assistant`
> 不变（host 注册 / WFEDIT / 管家 / admin 对话框全指向它，现有接线零改），
> 用户可见名升级成「工作流架构师 / Workflow Architect」。全部为加法，
> **零 schema 改动**，core/protocol/identity/runner 逐字节不变。
>
> Last updated: 2026-06-23

---

## 里程碑

| M | 做了什么 | commit |
|---|---|---|
| ARCH-M1 | 给 assistant 加「深度 + 解释模式 + 绑图」（payload `mode`/`detail`/`subjectYaml`，output `graph`） | `8a13f13` |
| ARCH-M2 | host surface 透传 `mode`/`detail`/`subjectYaml` + echo `graph` | `2cfd278` |
| ARCH-M3 | admin assist 路由扩参 + verbatim echo `graph` | `d6d1e4b` |
| ARCH-M4a | 抽共享工作流图渲染器 `static/workflow-graph.js`（admin + 成员共用） | `8c49729` |
| ARCH-M4b | admin 对话框：深度三按钮 + 内联 SVG + 下载 + 解释现有工作流 | `21b6d43` |
| ARCH-M5 | host 成员创作服务 `MeWorkflowCreateService` + 成员解释 | `bc9baa7` |
| ARCH-M6 | web `/me` 创作 + 解释路由（`detail` 入参收窄修正 `c3941b9`） | `3abc828` |
| ARCH-M7 | 成员 SPA「用大白话新建工作流」面板 + 图 + 下载 + 解释 | `9662cda` |
| ARCH-M8 | 确定性 example + 端到端验收门 | `4e23c0b` |
| ARCH-M9 | 本文档 + 交叉链 + CLAUDE.md 登记 | （本提交） |

---

## 一、为什么这是个差异点（先查市面）

用户的要求是「先查市面上有没有类似功能的 agent，再设计」。查下来：

| 产品 | NL→工作流 | 自动讲解 | 配图 | 结构校验 |
|---|---|---|---|---|
| n8n 2.0（AI 节点） | ✓ | 弱 | 画布（人手连） | 无（NL 生成会编节点） |
| Make「Maia」 | ✓ | 弱 | **强（可视化是卖点）** | 无 |
| Zapier Agents | ✓ | 弱 | 线性 | 无 |
| Flowise / Langflow / Dify / Gumloop | 部分 | ✗ | 画布（人手搭） | 无 |
| **Gotong 工作流架构师** | ✓ | **✓（深浅可调）** | ✓（YAML 的纯投影） | **✓（deepCheck 抓编造 capability）** |

**结论：没人把「NL→声明式 YAML + 可调深度讲解 + 绑定的流程图 + 结构深检」
打包成一个 agent 工件。** Gotong 的差异点正是这一组合：

1. **YAML 是版本化 / 治理的根**（Phase 15）—— 生成的不是黑盒画布，而是
   可 diff、可发布、run 钉修订防漂移的声明式文件。
2. **`deepCheck` 抓住 LLM 编造的 capability**（`unknown_capability` 等）——
   纯 NL 生成器没有这道闸。LLM 很爱编一个听起来合理但没人实现的能力。
3. **图是 YAML 的纯投影**（`projectWorkflowGraph`）—— 跟「将要跑的东西」
   严格一致，不是另画一张可能跟执行漂移的示意图。

---

## 二、三个行为

### 2.1 author —— 把一句话写成工作流 YAML

`mode: 'author'`（默认）。payload 带 `description` + 可选 `contextHints`
（当前 hub 的 agents / MCP servers / 已存工作流 id）。agent 产出
`{yaml, explanation, draftStatus, deepCheck?, graph?}`。

- `contextHints` 双重用途：① 喂进 prompt 让 LLM 用真名而不是编 capability；
  ② 当 `inventory` 喂给 `deepCheck` 做运行时校验（见 §三）。
  - `contextHints.mcpServers`（hub 已装的 MCP server 名）让架构师**优先围绕
    可直接组装的组件**建工作流 —— 见 [MCP-CONNECTOR-DIRECTORY](MCP-CONNECTOR-DIRECTORY.md)
    （内置连接器目录 + 一键装 + 喂这条 dead seam）。注意 MCP 名只进 prompt 提示，
    **不进 deepCheck**（server 名非 capability，无运行时 inventory 可校验）。
- `draftStatus` 三态：`'valid'`（parseWorkflow 过）/ `'invalid'`（解析失败，
  附 `validationError`）/ `'no_yaml'`（LLM 没给 YAML，全文当 explanation）。

### 2.2 explain-at-depth —— 把一个已存在的工作流讲明白（深浅可调）

`mode: 'explain'` + `subjectYaml`（要讲解的现有 YAML）。深度三档（`detail`）：

| `detail` | 叙述深度（仅约束 explanation 文字，YAML 与图不变） |
|---|---|
| `oneliner` | 恰好一句话 —— 这个工作流干什么 |
| `brief`（默认） | 2–4 句，覆盖 trigger + 主要步骤 |
| `detailed` | 逐节点走一遍：每步派给哪个 capability/agent、`$`-ref 数据怎么流、有没有人工审批 / 跨 hub 闸 |

**关键正确性约束**：explain 模式**永不重新生成** —— agent 把
`out.yaml` 设成 `payload.subjectYaml`（原样，不信 LLM 可能回显的 YAML），
`graph` 与 `draftStatus` 都从 `subjectYaml` 确定性派生。LLM 只负责产出
那段散文。深度也复用同一个 `explanation` 字段 → WFEDIT 的「这次改了什么」
也跟着能深浅。

### 2.3 diagram —— 把它画出来（工作流图片介绍）

`draftStatus === 'valid'` 时，agent 附 `graph = projectWorkflowGraph(parsed)`
（`@gotong/workflow` 的纯函数，无 LLM，两模式都附）。图是数据
（`WorkflowGraphView = {workflowId, nodes, edges}`）—— 前端用共享渲染器
`static/workflow-graph.js` 把它内联成 SVG（本身即可下载的矢量图）。
**host 零渲染负担**，守「不降性能」。

> 决策：图 = 数据 + 前端渲染。不在服务端栅格化 PNG（需 headless 渲染器，
> 重）。内联 SVG + 「下载 SVG」足够；PNG 客户端 canvas 导出留二期。

---

## 三、复用地图（约 70% 积木已存在）

这是「统一 + 补 3 个缺口」，不是从零造。

| 复用 | 路径 |
|---|---|
| NL→YAML agent（`WorkflowAssistantAgent`，cap `workflow:assist`，带 `draftStatus`+`deepCheck`） | `packages/workflow-assistant/src/assistant.ts` |
| valid 后附 graph + deepCheck 的同一落点（`verdictForYamlWithDeepCheck`） | `assistant.ts:567` |
| 结构深检 `checkWorkflowStructure`（6 类违规，含 `unknown_capability`） | `packages/evals/src/checkers/workflow-structure.ts` |
| **纯**图投影 `projectWorkflowGraph`（可跑在任意 parsed YAML） | `packages/workflow/src/graph.ts:105` |
| 共享 SVG 渲染器（M4a 抽出，admin + 成员共用） | `packages/web/static/workflow-graph.js` |
| host 助手 surface + 每调用 chunk sink + env 配置 | `packages/host/src/workflow-assist-agent.ts` |
| admin 助手对话框（状态 chip + deepCheck 警告 + 流式预览） | `packages/web/static/admin-wf-assist.js` |
| 成员服务模式 + 出入口检测 + 草稿持久化（WFEDIT） | `packages/host/src/me-workflow-edit-service.ts` / `workflow-edit-guard.ts` |

**补的 3 个真实缺口：**

- **(a) 可调深度讲解** —— `explanation` 原来只给固定深度，无深度维度，
  也无法对一个**已存在**的工作流按需深浅讲解。→ ARCH-M1 加 `detail` +
  explain 模式。
- **(b) 图绑进 agent 输出** —— 图原本是 admin 上一个独立按钮（只对已保存
  工作流），不随 agent 输出走。→ ARCH-M1 把 `graph` 加进 output。
- **(c) 成员侧 NL 创作** —— WFEDIT 只能**改**已有工作流，成员在 `/me` 无法
  用大白话从零**造**一个。→ ARCH-M5/M6/M7 补 `MeWorkflowCreateService` +
  路由 + SPA 面板。

---

## 四、数据流端到端

```
用户（admin 对话框 / 成员 /me 面板）
  │  大白话 + 深度（一句话 / 简要 / 详细）[ + subjectYaml 若解释现有 ]
  ▼
web 路由
  admin:  POST /api/admin/workflows/assist        （requireAdmin）
  成员:   POST /api/me/workflows/create           （userId 服务端强制）
          POST /api/me/workflows/:id/explain
  │  mode / detail / subjectYaml / contextHints 进 dispatch payload
  ▼
host surface（WorkflowAssistSurface / MeWorkflowCreateService）
  │  hub.dispatch → capability: workflow:assist
  ▼
WorkflowAssistantAgent（唯一一处 LLM 调用）
  │  ① author: prompt 带 description + contextHints + detailInstruction(detail)
  │  ② explain: prompt 带 subjectYaml + 「不要重写，只回散文」 + detailInstruction
  ▼
LLM → 抽 YAML（三级降级 fence）
  │
  ├─ author:  out.yaml = LLM 的 YAML
  └─ explain: out.yaml = subjectYaml（原样，不信 LLM 回显）
  │
  ▼  verdictForYamlWithDeepCheck(yaml, inventory←contextHints)
  ├─ draftStatus: valid / invalid / no_yaml
  ├─ deepCheck:   checkWorkflowStructure → unknown_capability / unknown_agent / bad_ref …（valid 时）
  └─ graph:       projectWorkflowGraph(parsed)（valid 时，纯投影）
  ▼
[成员 create 额外闸] MeWorkflowCreateService:
  draft_cap? → cross_hub?（出口非空→拒）→ id_exists? → saveDraft → 种 owner grant
  ▼
web verbatim echo { yaml, explanation, draftStatus, deepCheck?, graph? }
  ▼
前端：状态 chip + deepCheck 黄色警告 + workflow-graph.js 内联 SVG + 「下载 SVG」 + 深浅叙述
```

---

## 五、成员创作的治理边界

成员在 `/me` 用大白话**新建**工作流（`MeWorkflowCreateService.create`），
按顺序过这几道闸：

1. **可选 per-member 草稿上限** —— 仅当 `perMemberDraftCap` 与
   `countOwnedDrafts` **都**注入时生效（默认不限，标可选；镜像 `/me` agents
   的 20 上限思路）。超了 → `reason: 'draft_cap'`。
2. **★ 拒绝跨 hub 出口 ★** —— 复用 WFEDIT 的 `workflowBoundary` →
   `crossHubStepsOf`（与 admin 启动前可见性、编辑器出入口锁**同源**不漂移）。
   任何派到只有 off-hub 目的地（mesh peer / 外部 A2A）才提供的能力的步骤 →
   `reason: 'cross_hub'`，消息列出那些 off-hub 能力。**成员只能造本地工作流**
   —— 跨 hub 需管理员配置对端信任（per-link 契约 / 出站审批闸）。
3. **id 撞名** —— `versioning.has(id)` → `reason: 'id_exists'`（不覆盖已存）。
4. **落草稿 + 种 owner** —— `saveDraft`（永不自动上线）+ `setWorkflowGrant`
   `perm: 'owner'`（镜像 Phase 19 P2「draft seed owner」）。

**成员发布自己的工作流仍走 Phase 15 / 19 P2 的发布闸** —— 架构师只把
门槛从「会写 YAML」降到「会说人话」，不绕过生命周期治理。运行期闸不变
（Phase 17 预算 fail-closed + Phase 10 深度 / 环路兜底）。

成员**解释**（`explain`）只对 `/me` catalog 里能见的工作流（已过滤
`published` + `allowedRoles`）→ 不泄漏不可见工作流。

---

## 六、关键设计决策

| # | 决策 | 为什么 |
|---|---|---|
| 1 | **演进现有 agent，不另起炉灶** | 保留 cap `workflow:assist` + id `workflow-assistant` → host 注册 / WFEDIT / 管家 / admin 对话框现有接线零改 |
| 2 | **全部为加法，零 schema 改动** | 动 agent payload/output 的 TS 类型 + 系统 prompt + web/前端；不动 identity SQLite / runner / protocol / host 路由。守「不降性能」 |
| 3 | **深度只管叙述，YAML 与图不变** | `detailInstruction` 只约束 explanation 散文；同一个工作流三档深度的 YAML 和 DAG 完全一致 |
| 4 | **explain 永不重生成** | `out.yaml = subjectYaml`（原样），不信 LLM 回显 → 讲解一个工作流绝不会悄悄改了它 |
| 5 | **图 = 数据，前端渲染** | `graph` 是纯投影；host 零渲染负担；SVG 本身即可下载矢量图 |
| 6 | **成员落草稿 + 本地限定 + owner-seed** | 永不自动上线；跨 hub 出口拒（成员造本地）；发布仍走生命周期闸 |
| 7 | **诚实分层验证** | mock 不随 `detail` 变文字长度 → 端到端深度文字变化是 opt-in 真 LLM smoke；hermetic 测只钉「prompt 含深度指令 + graph 正确 + explain 不重生成 + cross-hub 拒」 |

---

## 七、测试矩阵 / 验收门

| 层 | 测试 | 钉死什么 |
|---|---|---|
| 单测（assistant） | `packages/workflow-assistant/tests/` | 三档 `detail` 各注入对应深度指令；explain 原样回 `subjectYaml` 且附正确 graph；合法 YAML 必附 graph、`no_yaml`/`invalid` 不附；既有 round-trip 仍绿 |
| 路由（web） | `packages/web/tests/me-routes.test.ts`（72） | create/explain 端到端 + userId 不可伪造 + cross-hub 拒；`detail` 收窄成深度枚举 |
| 确定性 example | `examples/workflow-architect/`（`pnpm demo:workflow-architect`，23 断言，退出 0） | author 三档（prompt 维度）+ graph 附上；explain 原样回 + 附图；成员 create 拒跨 hub。mock marker 取 explain 用户消息独有的 `'Explain the workflow below'`（不与系统 prompt 的 `'prose explanation ONLY'` 碰撞，否则 decoy 漏进 author） |
| **端到端验收门**（host） | `packages/host/tests/workflow-architect-e2e.test.ts`（4） | 真 Hub + 真 `WorkflowAssistantAgent`（mock LLM）+ 真 `WorkflowController` + 真 `IdentityStore` + 真 `MeWorkflowCreateService`：① graph 等于 `projectWorkflowGraph(parsed)`（4 节点 4 边 1 数据边）；② deepCheck 抓住编造的 `image-generation`（`draftStatus=valid` 但 `deepCheck.ok=false`，含 `unknown_capability`）；③ 成员 create 落 draft + 种 owner grant；④ 跨 hub 出口被拒（`reason=cross_hub`，消息含 `supplier.confirm-order`，工作流不落盘、grant 不种） |

基线：full host 套件 **1135 passed | 1 skipped**（skip = opt-in 真 LLM 测）；
web me-routes 72；典型零回归。

---

## 八、运维须知

### 8.1 启用 / 关闭 / provider

架构师跟 Phase 13 助手是**同一个 agent**，沿用同一套 env：

```bash
# 启用（默认；需 ANTHROPIC_API_KEY / OPENAI_API_KEY，或 vault 里有对应 entry）
# 缺 key → 跳过注册 → assist/create/explain 路由返 503（UI 提示去配 key）

GOTONG_ASSISTANT_PROVIDER=anthropic   # 默认 | openai | mock
GOTONG_ASSISTANT_MODEL=...            # 可选，provider-specific model id
GOTONG_ASSISTANT_MAX_TOKENS=4096      # 可选，默认 4096（一份工作流草稿够用）
GOTONG_ASSISTANT_DISABLED=1           # 显式整体关闭
GOTONG_ASSISTANT_NO_EXAMPLES=1        # 关掉 few-shot examples
```

DeepSeek 等：用 OpenAI provider + baseURL，见 `examples/workflow-assistant` 写法。

### 8.2 凭证 / 配额 / 成本

- **key 解析链**：OrgApiPool（vault 里任一 active entry）→ env fallback。
- **配额**：架构师调用是 admin / 成员的**编排动作**，跟 LocalAgentPool 同策
  （"admins/members are operators"）—— 不走 `task.origin` 消费者计费。成员
  create/explain 走认证后的 rate-limit（Phase 1 P1-M2，fail-closed）。
- **成本**：每次 author/explain 是一次 LLM 调用（默认 ≤4096 tokens）。图
  与 deepCheck 是纯算，**零额外 LLM 成本**。深度三档只改 prompt 一行指令，
  不改调用次数。

---

## 九、未做 / 后续可补

1. **服务端栅格化 PNG / 分享图** —— 需 headless 渲染器，重，违「不降性能」。
   内联 SVG + 下载足够；PNG 客户端 canvas 导出留二期。
2. **交互式图**（点节点看详情、跨 hub 徽章）—— 先静态 SVG。
3. **agent 自我纠错循环 / 多轮自治改写** —— agent 仍单发，失败让调用方再问
   一轮（北极星不自治）。
4. **成员创作做成 `surface.me` 自动布展 / 自动 publish** —— 落 draft + 现有
   发布闸；成员发布个人工作流仍走 Phase 15 / 19 P2。
5. **图导出进模板 / 分享到 IM** —— 先 admin / 成员看图 + 下载。
6. **端到端深度文字变化的真 LLM smoke** —— mock 不随 `detail` 变长度，深度
   的真实文字差异是 opt-in 真 LLM 验证（镜像 AI-WORKFLOW-EDITOR 的 DeepSeek
   demo），不入 CI。

---

## 十、入口指南

- **底座 = Phase 13 AI 辅助 workflow 编辑** —— 架构师就是它的演进：见
  [`docs/zh/AI-WORKFLOW-EDITOR.md`](AI-WORKFLOW-EDITOR.md)。
- **成员用大白话改工作流（WFEDIT）** —— 架构师的姊妹（那个**改**，这个还能
  **造** + **讲** + **画**）：见 [`docs/zh/ledger/V5-WFEDIT-FINAL.md`](./ledger/V5-WFEDIT-FINAL.md)。
- **只读 DAG 可视化** —— 图投影 `projectWorkflowGraph` 的另一个消费者（admin
  工作流「流程图」按钮）：见 [`docs/zh/WORKFLOW-DAG-VIZ.md`](WORKFLOW-DAG-VIZ.md)。
- **工作流生命周期 + 版本化** —— 架构师生成的 YAML 落进的治理根：见
  [`docs/zh/ledger/V4-PHASE15-FINAL.md`](./ledger/V4-PHASE15-FINAL.md)。
