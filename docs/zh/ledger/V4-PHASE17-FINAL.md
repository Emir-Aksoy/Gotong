# v4 Phase 17 / Sprint 4 —— 用量·成本账本 + 配额 fail-closed + 审计导出（M1-M8 + 验收门）

> 接 Phase 16（成员任务 inbox）。本 sprint 补的是**生产级安全与运维**里
> 用户点名的三件事：**用量 / 成本账本（ledger）、按 token / 成本 fail-closed
> 的配额、审计 + 账本的 CSV/JSONL 导出**，再加一块 owner-only 的用量·成本看板。
>
> 一句话定位：在原有「按调用数计配额」之上，补一层**逐条 LLM 调用的原始账本**
> （谁、哪个 agent / 工作流、什么模型、多少 token、多少钱），让成本可观测、可
> 导出、可按预算硬闸。
>
> 全程纯本地 commit（8 个里程碑 + 本文档），`pnpm -r test` 全绿。
> commit `586b594`→`4ecd180`。
>
> **明确推迟出本 sprint**（用户只点名 ledger/quota/audit）：Prometheus 业务指标、
> backup day-2 演练。见第十三节。

---

## 一、动了什么

Phase 17 之前，配额只有一层：`usage_counters`（v5）按 `llm_requests` 计**调用数**，
`makeLlmQuotaGate` 在每次非 mock LLM 调用前 `checkAndIncrement` 一格，超了抛
`QuotaExceededError`。能限「调用几次」，但**看不到也限不住「烧了多少 token / 多少钱」**。

本 sprint 在调用数计数器**之下**补了一层**原始账本**，并把配额闸扩成「也能按
token / 成本 fail-closed」，再加导出 + 看板：

```
        ┌─────────────────────────────────────────────────────────────┐
每次 LLM │  LlmAgent.streamWithAuthHook ── 拿到 provider usage ──┐        │
调用响应  │                                                      ▼        │
        │                                            usageSink（best-effort）
        │                                              ├── ① 账本：恒写 1 行  │
        │                                              │    usage_ledger      │
        │                                              │    （含 mock，记 $0） │
        │                                              └── ② 预算计数（归因+非 mock）
        │                                                   recordUsage 累计   │
        │                                                   llm_tokens / cost  │
        └─────────────────────────────────────────────────────────────┘
                                                                  │
        下一次调用前  preCallHook = gate(task.origin):              │
          peek llm_tokens / llm_cost_micros（amount=0）── used >= quota? ─┐
                                                                  │     │ 是
          再 debit llm_requests（调用数硬闸）                       │     ▼
                                                                  │  拒（fail-closed）
                                                                  │  写 api_quota_denied 审计
        owner 看板 / 导出：                                         ▼
          GET /api/admin/identity/usage/summary?groupBy=…   （按维度汇总）
          GET …/usage/ledger/export?format=csv|jsonl        （账本导出，≤10k 行）
          GET …/audit/export?format=csv|jsonl               （审计导出）
```

三句话：

1. **账本是观测层，配额是执行层**。账本恒写（连 mock 都写，记成 `unpriced` 的 $0
   行），不参与决策；预算计数 + 闸门才做 fail-closed。两者分离，删不掉对方。
2. **成本只用整数 micro-USD**（`1e6 micros == $1`），永不出现浮点美元。
   `tokens × pricePer1M == costMicros`，价目表在 **host**（identity 保持模型无关，
   只存算好的成本）。
3. **fail-closed 的关键是「记账要 ungated」**——M7 验收门抓出一个 fail-OPEN 的实现
   bug，见第七节。

---

## 二、为什么这么做（北极星：第 3 层「配额有显式边界」）

北极星第 3 层要框架「清晰 + 稳定 + 适配」，其中明写 **「协议 / 凭证 / 配额都有
显式边界」**。Phase 5 的 OrgApiPool + quota 把「调用数」这条边界立住了；但 AI 时代
真正烧钱的维度是 **token / 成本**，而它在本 sprint 之前是个黑盒：

- 看不到：没有逐条账本，无法回答「上周这个工作流花了多少」「哪个成员烧得最多」。
- 限不住：配额只认调用数，一次 200k-token 的长上下文调用和一次 200-token 的
  问候，在闸门眼里是同一格。
- 导不出：审计日志只能在 admin UI 翻页，没有给财务 / 合规的批量导出。

补上这三点，「配额边界」才在成本维度真正成立。设计上刻意**复用现有机制**：
- 账本表跟 `audit_log` 同构（append-only、无 FK、forensics 优先）；
- 预算闸复用 Phase 5 的 `makeLlmQuotaGate`（扩 `budgetPeeks`，不重写）；
- 导出路由挂在**现有 owner 闸之后**（`/api/admin/identity/...`），不另造鉴权；
- web 层用鸭子类型 `UsageLedgerSurface`，**零** `@aipehub/identity` 运行时依赖。

---

## 三、架构主线（账本在配额之下 + 成本在 host + 两端记账）

### 3.1 分层

```
usage_ledger（M1，新，原始层）       1 行 / 1 次 provider 响应
   id / ts / org_id / user_id / workflow_id / task_id（均可空）
   agent_id / model（非空）/ provider
   input/output/cache_creation/cache_read_tokens / cost_micros / unpriced / meta_json
        ▲ 观测，append-only，无 FK（删 user/agent 也留账，billing forensics）
        │
usage_counters（v5，已有，执行层）  per-(user,metric,period) 计数 + quota
   llm_requests（调用数，硬闸）
   llm_tokens / llm_cost_micros（Phase 17 新增的预算维度）
org_quotas（v7，已有）             per-org 软状态机
```

### 3.2 归因（attribution）

`deriveLedgerAttribution(task)`（`local-agent-pool.ts`）：
- `task.origin` → `userId` / `orgId`（`/me` 派发盖章，工作流 runner 逐层 re-stamp；
  admin / system 触发的任务无 origin → 两者 null，账本仍写）。
- `task.ancestry` 从末往前扫最近的 `workflow:<id>` 节点 → `workflowId`。
- `task.id` → `taskId`。

于是一条「成员 → /me 派工作流 → 工作流 dispatch 给 LLM agent」的链，账本行同时带
user / org / workflow / agent / model 五个维度（M7 Part 1 显式断言）。

### 3.3 成本算在 host，不算在 identity

价目表 `DEFAULT_PRICING`（`packages/host/src/pricing.ts`）按 model-id 前缀匹配
（先精确、后最长前缀）；cache 速率由 input 派生（写 1.25×、读 0.1×）；可用
`<AIPE_SPACE>/pricing.json` 覆盖（解析失败 → boot 期抛错，不静默吞）。
`estimateCostMicros(usage, model, table)` 返回 `{ costMicros, unpriced }`——未知模型
`unpriced:true` + 成本计 0（token 照记）。identity 只收**算好的** `cost_micros`，
保持模型无关。

---

## 四、账本表 + LedgerStore（M1，`586b594`）

- `schema.ts` migration `v=11 'usage-ledger'`：建 `usage_ledger`（INTEGER PK
  AUTOINCREMENT + 上述列）+ 5 索引（ts / user / agent / workflow / model）。**无 FK**。
- `ledger-store.ts`（新）：`LedgerStore` —— eager-prepared INSERT；`append` 校验
  非负整数；`query` 动态 WHERE（org/user/agent/workflow/model/since/until +
  limit/offset，半开区间 `[since, until)`，newest-first）；`aggregate` 按
  `GROUP_BY_SQL` 白名单（user/agent/workflow/model/**day**，day 走
  `strftime('%Y-%m-%d', ts/1000, 'unixepoch')`）汇总，cost DESC，NULL 维度 → `(none)`。
  `meta` 序列化 8KB 上限。
- `store.ts` 委托 `appendLedger` / `queryLedger` / `aggregateLedger`；index 导出类型。
- 测试：`ledger.test.ts` 16 个（round-trip / 默认值 / 校验 / 过滤 / 半开区间 /
  newest-first / 分页 / 三种 groupBy）。

---

## 五、价目表 + estimateCostMicros（M2，`6935cb7`）

- `pricing.ts`（新）：`ModelPrice`（inputPer1M / outputPer1M / cacheWrite? /
  cacheRead?）+ `DEFAULT_PRICING`（claude-opus-4 15/75、claude-sonnet-4 3/15、
  gpt-4o 2.5/10、deepseek / qwen 等）+ `resolveModelPrice`（精确→最长前缀）+
  `estimateCostMicros`（`Math.max(0, round(...))`）+ `loadPricingTable`（合并覆盖、
  malformed 抛）。
- 测试：`pricing.test.ts` 16 个（claude-opus-4 1000×15+200×75=30000；cache 派生；
  前缀匹配；未知→unpriced；loadPricingTable 合并 / 抛错）。

---

## 六、usageSink 钩子 + 双账（M3，`f47b25c`）

- `@aipehub/llm`：`LlmAgentOptions.usageSink?(task, usage, meta)` +
  `LlmUsageSinkMeta { model, provider, stopReason }`。在 `streamWithAuthHook` 拿到
  usage 后触发（**每个 tool-use 轮都触发**）。错误纪律同 `onStreamChunk`：catch +
  log，**绝不**让记账故障打断 LLM 调用。
- `local-agent-pool.ts`：sink 闭包做两件事——
  ① **账本**（所有 provider，含 mock）：`appendLedger` 带归因 + 成本。mock 落
     `unpriced` $0 行，保留完整痕迹。
  ② **预算计数**（归因 + 非 mock）：累计 `llm_tokens` + `llm_cost_micros`。mock 跳过，
     与调用数闸跳 mock 同策（demo 不该烧掉用户跨 agent 共享的真预算）。
- 测试：`local-agent-pool-ledger.test.ts` 3 个（归因 + 成本；mock unpriced；无 origin
  → null user/org）。

---

## 七、token / 成本配额 fail-closed（M4 `e8f67cf` + M7 修复）

### 7.1 设计（Option A：post 记账、pre peek）

token / 成本在响应前是未知的，所以**实际消耗只能 post-call 记**，配额则**pre-call
peek**：`makeLlmQuotaGate` 扩 `budgetPeeks`，闸门先对每个预算维度 `checkAndIncrement
amount=0`（只读不 debit），`used >= quota` 就 `denyQuota`（写 `api_quota_denied`
审计 + 抛 `QuotaExceededError`）；peek 在调用数 debit **之前**，所以被预算拒的调用
不吃调用数那一格。语义即「**预算花光后，下一次调用 fail-closed**」。

### 7.2 M7 验收门抓出的 fail-OPEN bug（本 sprint 最重要的修复）

M3/M4 的 sink 用**带闸的** `checkAndIncrement` 记 token/成本。但
`checkAndIncrement` 在 `used + amount > quota` 时**写 period roll 却不增 used**
（设计如此：超额的那次 debit 不提交）。后果：记账时只要某次调用会越过 cap，
**这次的 token 就没记进去**，`used` 卡在 cap 下方一点，于是 pre-call peek 的
`used >= quota` **永远不成立** → 预算**永不触发** → fail-OPEN。M4 单测当时把 used
**正好**设到 cap 才过，掩盖了这点。

**修复（M7，`4ecd180`）**：记实际消耗必须 **ungated**。
- `identity`：新 `recordUsage`（单调累加；**允许越过 cap**；仍滚动过期周期）于
  `QuotaStore` + `IdentityStore`。
- `host`：sink 改用 `recordUsage` 记预算维度——一次越 cap 的调用就把 `used` 顶过
  quota，下一次 peek 才能拒。调用数那条仍用 `checkAndIncrement`（它本身就是执行闸，
  拒的就是越界那一次，语义正确）。
- 测试：identity +5（recordUsage：**记过 cap**、**记过后 peek fail-closed**、周期滚动、
  负值拒）。

---

## 八、账本 + 审计导出（M5，`dd1b727`）

- `export-format.ts`（新）：`csvCell`（RFC 4180，含 `",\n\r` 才引号、内引号翻倍）/
  `toCsv` / `toJsonl` / `parseExportFormat`（默认 csv）/ `sendExport`
  （`content-disposition: attachment` + `cache-control: no-store`）。
- `usage-routes.ts`（新）：鸭子 `UsageLedgerSurface`（`queryLedger?` / `aggregateLedger?`
  都可选——pre-migration host 退化成空结果而非 500）+ 三个 handler：
  list（JSON newest-first 分页）/ export（CSV/JSONL，cap 10k）/ summary（校验
  groupBy → 400）。`LEDGER_COLUMNS` 含 `iso_ts` / `cost_usd` 派生列。
- `identity-routes.ts`：在**现有 owner 闸之后**挂 `/usage/ledger`、`/usage/ledger/export`、
  `/usage/summary`、`/audit/export`——billing / 审计都是 owner 级，复用同一鉴权边界。
- 测试：`export-format.test.ts` 10 + `usage-routes.test.ts` 8（真 IdentityStore seed +
  member 403 + 过滤 + 聚合 + bad groupBy 400 + CSV/JSONL 形状 + 审计导出）。

---

## 九、admin 用量·成本看板（M6，`eff891b`）

- `app.html`：owner-only `用量` tab + `#usage-panel`。
- `usage-ui.js`（新，自包含 IIFE，仿 `reputation-ui.js`）：groupBy 下拉
  （用户/智能体/工作流/模型/按天）+ 刷新 + 汇总表（tfoot 合计行）+ 4 个导出下载锚
  （账本 CSV/JSONL、审计 CSV/JSONL）。`fmtUsd(micros)= '$'+(n/1e6).toFixed(4)`。
  靠 `data-active-tab==='usage'` 的 MutationObserver 激活。
- `app.js`：`loadAdminBundles` 链里 inject `/usage-ui.js`；`styles.css` 加 `.usage-*`；
  web build 重嵌 base64 静态资源。
- 浏览器验证：看板渲染出 3 行汇总 + 合计行 + 4 个可用导出链接、成本算数正确。

---

## 十、无漂移端到端验收门（M7，the gate，`usage-ledger-e2e.test.ts`）

真栈：真 Hub + 真 IdentityStore(tmp sqlite, 含 v=11) + 真 LocalAgentPool（真 sink）
+ 真 WorkflowController + 真 `estimateCostMicros` + 真 `@aipehub/web` 导出列。两道闸：

- **Gate 1（归因 + 聚合 + 导出回环）**：派一个含顶层步骤 dispatch 到 mock LLM agent
  的工作流（带 `origin`）→ 断言**恰好 1 条**账本行，user/org/workflow/agent/model 全归因、
  `costMicros == in×15 + out×75`；`aggregateLedger` 按 user/workflow/model 各自汇总
  正确；该行经真 `toCsv`/`LEDGER_COLUMNS` + `toJsonl` 导出后**解析回环**（CSV 按表头
  索引取 `cost_micros`/`user_id`/`workflow_id`，JSONL 深等）。
- **Gate 2（fail-closed）**：plain `LlmAgent` + MockProvider + 同款 gate + 真
  `recordUsage` sink（pool 对 mock 跳预算 debit，故走非 mock 路径手接）。设
  `llm_tokens` 配额 = 1 → 首次调用 ok 并记 > 1 token → **下一次调用被 pre-call
  peek 拒**（`failed` + `quota_exceeded`）+ 写 `api_quota_denied` 审计（`success:false`、
  `metadata.metric==='llm_tokens'`）。

> 为什么 Gate 2 用 plain agent 而非 pool 驱动：pool 只给**非 mock** agent 装预算闸 +
> 只给非 mock 记预算（demo 安全）。真 provider 要 key + 网络，测试里不可行；故按
> pool 完全一致的 gate 配置 + sink 逻辑（含 M7 的 ungated 修复）手接驱动，忠实于
> 「记账 → 下次拒」这条真实回环。

---

## 十一、测试矩阵（+ 跨包，零回归）

| 包 | 新增 | 覆盖 |
|---|---|---|
| identity | ledger 16 + recordUsage 5 = **+21** | 账本 store；ungated 记账契约（记过 cap / peek fail-closed / 周期滚动 / 负值拒） |
| host | pricing 16 + pool-ledger 3 + budget-gate 6 + **E2E 2** = **+27** | 价目；sink 归因 + 成本；闸 peek；端到端验收门 |
| web | export-format 10 + usage-routes 8 = **+18** | CSV/JSONL 形状 + RFC4180；路由鉴权 + 聚合 + 导出 |
| llm | usageSink 接线（并入既有 agent 测试） | sink 触发 + 错误纪律 |

全量绿（本 sprint 末）：**identity 289 / web 465 / host 368**。

---

## 十二、运维须知

- **价目覆盖**：`<AIPE_SPACE>/pricing.json`（缺省用内置 `DEFAULT_PRICING`；malformed →
  boot 抛错，不静默）。新模型未在表里 → 账本 `unpriced:true`、成本计 0、token 照记。
- **设预算**：`identity.setQuota({ userId, metric: 'llm_tokens'|'llm_cost_micros',
  period: 'daily', quota })`。不设 = 无限（peek 对 `quota=null` 恒放行）。
  `llm_cost_micros` 的 quota 也是整数 micro-USD（$1/天 = `1_000_000`）。
- **fail-closed 语义**：是「预算花光后的**下一次**调用被拒」，不是「正在进行的这次被
  腰斩」（token 要响应后才知道）。一次大调用可能小幅越预算，下一次即闭。
- **审计**：被拒调用写 `api_quota_denied`（`success:false`，metadata 含 metric/period/
  used/quota/exceededBy/orgId）——给运维「拒了 N 次」的序列来定该不该提额。
- **导出**：owner-only，单次 ≤ 10000 行（`EXPORT_LIMIT`），`no-store`，附件下载。
- **账本不随删除消失**：无 FK，删 user/agent 后历史账仍在（billing/合规取证）。

---

## 十三、未做 / 推迟（保持精简）

- **Prometheus 业务指标 + backup day-2 演练**：本 sprint 用户只点名 ledger/quota/audit，
  这两项显式推迟（不在 M1-M8 范围）。
- **per-model / per-agent 预算 UI**：当前预算维度（token/cost）只在 `setQuota` 层可设，
  admin UI 还没有「给某用户设 token 日预算」的表单（C2 决策点）。
- **SQLite 之外的账本后端**：只交 `LedgerStore` 具体实现；接口已就绪，换后端后续可插。
- **成本的实时告警 / 软阈值**：现在只有硬闸 + 看板，没有「到 80% 发提醒」。
- **跨 hub 账本归集（federation 维度）**：账本是本 hub 的；跨 org 汇总留后续。

---

## 十四、commit 清单（M1-M8 + 本文档）

| M | commit | 内容 |
|---|---|---|
| M1 | `586b594` | identity `usage_ledger` 表（v=11）+ LedgerStore |
| M2 | `6935cb7` | host `pricing.ts` 价目表 + `estimateCostMicros` |
| M3 | `f47b25c` | llm `usageSink` 钩子 + host sink → 账本 |
| M4 | `e8f67cf` | token/cost 配额 fail-closed（gate `budgetPeeks`） |
| M5 | `dd1b727` | 账本 + 审计导出路由（CSV/JSONL） |
| M6 | `eff891b` | admin UI 用量·成本看板 + 导出按钮 |
| M7 | `4ecd180` | **E2E 验收门 + fail-OPEN 修复**（ungated `recordUsage`） |
| M8 | （本文档） | `docs/zh/ledger/V4-PHASE17-FINAL.md` + CLAUDE.md 更新 |

设计上账本是配额之下的**观测层**，跟 `audit_log` 同构（append-only / 无 FK /
forensics 优先）；配额闸是其上的**执行层**。本 sprint 最关键的一课：**记账要
ungated，执行才 gated**——把这两件事用同一个带闸原语做，就会悄悄 fail-open。
