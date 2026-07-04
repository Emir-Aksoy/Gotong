# RES — 资源适配（快速适配自身部署环境资源）

> 收口文档。对应 CLAUDE.md 目标「快速适配自身部署环境资源」里那唯一一个 🔴：
> 在 RES 之前，Gotong 从不探测本机资源——载入一个声明 `provider: anthropic`
> 却没有密钥的 agent，它就只是静默地跑不起来，没人告诉你「本机其实有个
> Ollama 在跑，一键改过去就能用」。RES 把这条缺口补上。
>
> **贯穿全系列的一条硬约束（用户逐字指令：「做RES(资源适配)系列，但是依旧
> 需要人的批准」）：探测与提议严格只读，任何写动作都必须过人的显式逐项批准，
> 绝不静默修改任何东西。** 这条约束是 RES 的设计核心，不是事后加的护栏。

Last updated: 2026-07-02

---

## 一、四个里程碑

| 里程碑 | 干了什么 | commit |
|---|---|---|
| **RES-M1** 资源清单 | 确定性、零 LLM、**只读**探测本机资源：各 provider 密钥是否可解析（存在性布尔，绝不读值）/ 本地 OpenAI 兼容端点（Ollama…）是否活着 / 已知编码 CLI（claude/codex…）是否在 PATH / hub 已装哪些 MCP server。`GET /api/admin/resources` 只 gate + echo，存在性 only 无密钥值过线。 | `313cbce` |
| **RES-M2** 适配提议引擎 | 纯函数 `proposeAdaptations(inventory × agents → proposals)`，**零副作用**。对每个 provider 没有可用密钥的 agent，产出可选的适配方案（改用本地端点 / 切到已配好密钥的 provider / 建议式配 env）。确定性、稳定顺序、零 LLM。挂到导入路径的 checklist 上。 | `a7c59f8` |
| **RES-M3** 人批准后应用 | 唯一把提议变成写的地方：`POST /api/admin/resources/adapt`，**逐项显式 apply**。服务端重新校验 `applicable`，映射成 agent 更新 body，走既有 agent-update 写路径（validate + 审计 + reconcile 全套）。admin UI 导入 checklist 逐项「一键应用」按钮。 | `edabc3f` |
| **RES-M4** 大白话入口 + E2E 承重门 + 文档 | ① 常驻入口：`GET /api/admin/resources/adaptations` 对**当前**所有托管 agent 跑 RES-M2 引擎（不只刚导入的），admin「hub 体检」面板里内嵌「本机资源适配」小节，就在「agent X 跑不起来」红信号旁给出一键修复。② E2E 承重门端到端钉死「只读提议 → 人批准应用 → 绝不静默」。③ 本文档 + 登记。 | 本提交 |

---

## 二、`applicable` — 提议的两类

RES-M2 每条提议都带 `applicable: boolean`，把两类修复分开：

- **`applicable: true`** — RES-M3 能经 agent 更新写路径**代为执行**（重写 agent 的
  provider / baseURL）。复用 agent PUT 意味着校验、审计、reconcile 全都照常。
  - `use_local_endpoint`：把没密钥的 agent 改成 `openai-compatible` 指向探到的本地端点（无需密钥）。
  - `switch_provider` 且 `toProvider ∈ {anthropic, openai}`（native 托管字面量，密钥从 env/vault/workspace 解析，不需 baseURL）。

- **`applicable: false`** — **建议性**：修复是 hub 之外的人的动作，面板只展示为指引，没有「一键应用」按钮。
  - `set_env_key`：给 provider 设环境变量密钥（要你在 hub 之外操作 + 重启）。
  - `switch_provider` 到 openai-compatible provider（如 deepseek）——它需要一个 inventory 供不出的 baseURL，所以只能建议你手动填。
  - `wire_mcp_server`：模板知识库槽位可接已装的 MCP server（模板导入按设计不自动接线）。

**apply 路由对 `applicable !== true` 一律拒（400 `not_applicable`）**——这是「绝不静默」在服务端的执行点，客户端传什么 tier 都不信，服务端 `adaptEditBodyFromProposal` 重新判定。

---

## 三、人批准拓扑

RES 只做管理端（admin）批准路径。两种「人批准」形态：

| 批准形态 | 落点 | 「批准」是什么动作 |
|---|---|---|
| **admin 逐项 apply** | `POST /api/admin/resources/adapt` | 运维在面板里点某一条具体提议的「一键应用」——**这一次点击就是批准**（不是先攒后批，是逐项显式）。服务端每次重新校验 `applicable`。 |

成员 / 管家路径（成员用大白话让 agent 改自己的配置）故意**不**在 RES 里做——那要走既有 governed 闸 → `/me` 收件箱（Phase 16），且成员设任意 baseURL 已被 `HostMeAgentService` 的成员限制正确约束。列为显式推迟（见 §六）。

---

## 四、数据流（大白话入口 → 批准应用）

```
        本机                          admin「hub 体检」面板
  ┌──────────────┐                 ┌─────────────────────────────┐
  │ Ollama :11434│                 │ 🔴 agent「mentor」跑不起来   │
  │ env 密钥/vault│                 │    [去配密钥]                │
  │ PATH 上的 CLI │                 │ ── 本机资源适配 ────────────│
  │ 已装 MCP      │                 │  让「mentor」改用本地 Ollama │
  └──────┬───────┘                 │    [一键应用]  ← 这一点=批准 │
         │ RES-M1 只读探测          └──────────────┬──────────────┘
         ▼ (零 LLM)                                │
  ResourceInventory ──► RES-M2 纯引擎 ──► proposals │ GET .../adaptations (只读)
  (存在性布尔,无密钥值)   (零副作用)      (读只读)   │
                                                    │ POST .../adapt {proposal}
                                                    ▼ (唯一的写)
                              服务端重校验 applicable → adaptEditBodyFromProposal
                                                    ▼
                              既有 agent-update 写路径 (validate+审计+reconcile)
                                                    ▼
                              mentor: anthropic → openai-compatible@127.0.0.1:11434/v1
```

**关键：探测（M1）和提议（M2/M4 GET）从不改任何东西。整条链上唯一的写是
`POST .../adapt`，且它由人在面板上对某一条具体提议的显式点击触发，服务端
再校验一遍 `applicable`。**

---

## 五、测试矩阵

| 层 | 测试 | 钉死什么 |
|---|---|---|
| host 纯引擎 | `packages/host/tests/resource-adaptation.test.ts`（17） | RES-M2 提议：native switch 可 apply / openai-compatible switch 建议性 / 稳定 id + 顺序 / 无密钥才提议 |
| web apply 路由 | `packages/web/tests/resource-adapt-route.test.ts`（7） | RES-M3：applicable switch/local 真落盘 / **advisory 拒 + agent 字节不变** / 非 native 拒 / 未知 agent 404 / 无 token 401 |
| web 常驻入口路由 | `packages/web/tests/resource-adaptations-route.test.ts`（3） | RES-M4：wired surface → 200 echo + surface 收到全部托管 agent{id,provider} / 无 surface 503 / 无 token 401 |
| **host E2E 承重门** | `packages/host/tests/resource-adaptation-e2e.test.ts`（1） | 端到端三 claim：真引擎经常驻入口提出 applicable local-endpoint 修复 / 批准后真改到本地端点 / **advisory 被拒 + agent 字节不变**（「绝不静默」端到端） |

E2E 用**注入的确定性 inventory**（一个 keyless anthropic + 一个 reachable Ollama），因为真网络探针非 hermetic（取决于 Ollama 到底有没有在跑）——我们钉的是 RES-M2 引擎 + apply 写路径，不是网络探针本身。

---

## 六、显式推迟

- **成员 / 管家用大白话改 agent 资源配置**：走既有 governed 闸 → `/me` 收件箱（Phase 16），不在 RES 叠新机制；成员设任意 baseURL 已被 `HostMeAgentService` 成员限制约束。
- **一键应用后自动重定向模型**：`use_local_endpoint` 只重接端点，保留原 model 串——运维随后在 agent 面板把 model 换成本地模型名（一次手动编辑）。提议不代改 model（本地模型名 inventory 供不出）。
- **RES-M1 探针族扩展**：GPU / 磁盘余量 / 端口占用等更多本机资源族，可加进 inventory 但当前只做 密钥 / 本地端点 / CLI / MCP 四族。
- **切到 openai-compatible provider 的一键化**：需要 inventory 携带该 provider 的 baseURL（现在 deepseek 类只做建议）。

---

## 七、为什么这样切

- **探测/提议纯只读，写只有一处**：把「看得见问题」和「改动配置」彻底分开，是「绝不静默」能成立的结构前提。一个纯函数引擎 + 一条显式 apply 路由，人在两者之间。
- **复用 agent 更新写路径**：apply 不另造写通道，而是把提议映射成 agent 更新 body 走既有 PUT——validate / 审计 / reconcile / 生命周期重启全套自动适用，不重复实现也不留后门。
- **鸭子类型 surface**：web 层零 host 运行时依赖，`resourceInventory` / `resourceAdaptation` 两个注入 surface，host 不在场 → 503，面板静默缺席（advisory 特性缺席不报错）。
- **常驻入口=把修复放在问题被标出的地方**：不另起一个「资源」标签页，而是把一键修复内嵌进「hub 体检」面板——运维在看到「agent 跑不起来」红信号的同一处就能一键适配。
