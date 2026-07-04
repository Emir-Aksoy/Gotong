# AI Workflow Editor — Phase 13 收尾

> Phase 13 给 Gotong 加了 **「自然语言 → workflow YAML」** 这一条编辑路径。
> 老路径（admin 手写 YAML 上传）还在，但现在 admin UI 里多了一个「AI 助手」
> 对话框：写一句话描述，LLM 出 YAML 草稿，hub 自己 parse + 深度校验，再决定
> 是不是要保存为正式 workflow。
>
> Last updated: 2026-05-28

---

## 一、本阶段动了什么

| Milestone | Commit | 关键产物 |
|---|---|---|
| M1 | `823c49a` / `0b59a21` | `@gotong/workflow-assistant` 新包 + `WorkflowAssistantAgent`（capability=`workflow:assist`）+ 内嵌 v1 schema 完整系统 prompt + `extractYamlAndExplanation` 三级降级解析 + `verdictForYaml` 自 validate + `draftStatus`（`valid` / `no_yaml` / `invalid`）+ 31 测试 |
| 审计整改 | `2026-05-27` | 把 assistant 从 `@gotong/workflow` 拆出来（保 runner 包零 LLM 依赖）；protocol↔core 依赖反转（协议层零运行时）；`audits/` 归档约定；`test:python` 一键脚本修复 |
| M3 | `d70acdb` | Host 注册 `WorkflowAssistantAgent`（`createWorkflowAssistAgent` + `resolveWorkflowAssistConfig`）+ `POST /api/admin/workflows/assist` route（duck-typed `WorkflowAssistSurface` 注入，web 零 workflow-assistant dep）+ admin UI 对话框（描述 → 生成 → status chip → 保存为 workflow）+ 23 测试 |
| M4 | `a5afe5a` | `@gotong/evals/checkers/workflow-structure` 深度检查器 — 6 类 violation（`unknown_agent` / `unknown_capability` / `bad_ref` / `forward_ref` / `self_trigger_cycle` / `id_collision`）；assistant 自动注入 `output.deepCheck`；admin UI 黄色 warnings panel + 列表；+40 测试 |
| M5 | (this commit) | `examples/workflow-assistant/` 端到端 demo（DeepSeek / Anthropic / OpenAI / mock 四模式）+ 本文档 |

总改动: 4 个功能 commit + 1 个审计整改 + 1 个 docs/example commit。新增源码 ~2500 行；测试 +94 跨 4 个包（workflow-assistant +44, host +14, web +12, evals +24）。

---

## 二、为什么做这阶段

写 workflow YAML 不是一个友好的入门动作。以 `gotong.workflow/v1` 现在的形态来看：

- 顶层 `schema` / `workflow.id` / `trigger.capability` 三件套必须严格
- `steps[].dispatch.strategy` 三种 kind（`capability` / `explicit` / `broadcast`）
- 步骤之间靠 `$stepId.output[.field]` / `$trigger.payload[.field]` 引用
- step id 唯一、且 `$ref` 只能指向「更早执行」的 step

老 admin 都会卡在「我不记得这个字段叫啥」+「我刚才那个 capability 名是什么」。
解决路径有两种：

1. **更友好的 UI**（拖拽 / 字段表单 / live preview）— 工作量大、未来扩 schema
   时还得跟着维护。
2. **AI 当编辑器**（你说人话，AI 写 YAML）— 工作量小、跟 LLM 能力直接挂钩。

我们走 (2)。但 AI 写出来的 YAML 不能盲信：

- LLM **可能不按 schema 出**（少了 `trigger.capability` / 引用了不存在的
  step）→ 这是 M1 的 `parseWorkflow + draftStatus` 解决的
- LLM **可能编 capability 名 / agent id**（它不知道你这个 hub 上有什么）→
  这是 M3 的 `contextHints` + M4 的 `deepCheck` 解决的
- LLM **可能装聋作哑**（"这个我帮不了"）→ `draftStatus='no_yaml'` 让 caller
  优雅降级

三件事一起做，才是「敢让普通用户用」的 AI 编辑器。

---

## 三、关键设计决策

### 3.1 Assistant 是一个 `LlmAgent` 子类，不是新框架原语

`WorkflowAssistantAgent extends LlmAgent`。Hub 看它就跟看任何 agent 一样：
注册、capability=`workflow:assist`、`hub.dispatch` 调用、transcript 走原路。

好处：

- 走现有的 LLM streaming / provider 抽象 / 配额体系，零特殊路径
- 测试用 `MockLlmProvider`，跟其他 agent 完全同套 vitest 模式
- 后续要做 batch（一次喂 3 个描述生成 3 个 yaml）或 RAG（注入 workflow
  templates）都是改 prompt + payload，跟其他 LlmAgent 改法一致

代价：**system prompt 内嵌完整 v1 schema 契约**。一旦 schema 变了，prompt
得跟着改。我们用 round-trip 测试做哨兵 —— 系统 prompt 例子里的 yaml 必须能
`parseWorkflow` 通过；schema 漂移会直接让测试爆炸，迫使更新 prompt。

### 3.2 拆 `@gotong/workflow-assistant` 包（runner 零 LLM dep）

Codex 2026-05-27 审计的第二大刀。原先 `@gotong/workflow` 引了
`@gotong/llm`，意味着用 workflow runner 的项目（非 AI authoring 路径）
也得装 llm + provider SDK 一堆依赖。

整改：拆出 `@gotong/workflow-assistant`，runner 重新零 LLM。
依赖图变成：

```
@gotong/workflow             ← runner，零 LLM
       ↑
@gotong/workflow-assistant   ← assistant，依赖 workflow + llm + evals
@gotong/evals                ← 深度检查器，type-only 依赖 workflow
```

这样：

- 只用 workflow YAML runner 的 host（如 `examples/hello-collab`）依赖图清爽
- AI authoring 是一个上层 client 模式，按需引

### 3.3 `draftStatus` 三态（M1.5 整改）

```ts
type WorkflowDraftStatus = 'valid' | 'no_yaml' | 'invalid'
```

老 M1 把 "成功" 定义得太松：只要 LLM 回了字符串就算 ok。审计指出 caller
没法区分「LLM 给了能用的 yaml」「LLM 给了 yaml 但 schema 错」「LLM 拒绝
回 yaml」三种状态，结果 UI 只能再 parse 一遍才知道是不是绿灯。

M1.5 把状态显式化：

- `valid` → `parseWorkflow(yaml)` 成功，caller 可直接 import
- `no_yaml` → 抽不到 ```yaml fence，`yaml === ''`，`raw` 是 LLM 原话
- `invalid` → 抽到了 yaml fence 但 `parseWorkflow` 抛 `WorkflowSchemaError`，
  `validationError` 字段拿原 message

`verdictForYaml(yaml)` 是纯函数，导出来给 SDK / route / 测试复用，杜绝
状态判断在多个地方各写一遍漂移。

### 3.4 Web 层 duck-typed surface 注入（zero workflow-assistant dep）

`@gotong/web` **没有** `@gotong/workflow-assistant` runtime 依赖。它定义
一个 `WorkflowAssistSurface` interface：

```ts
interface WorkflowAssistSurface {
  assist(input: {
    description: string
    contextHints?: ...
    by: ParticipantId
  }): Promise<WorkflowAssistResult>
}
```

跟 `WorkflowSurface`（workflow runner）一个模式。Host 启动时构造一个具体
surface（`createWorkflowAssistAgent` 返回），传给 `serveWeb({ workflowAssist })`。
Web 只依赖 interface 形状。

好处：

- 关掉 AI authoring 的 host（`GOTONG_ASSISTANT_DISABLED=1` 或没 API key）web
  能完整 boot，route 返 503 — 而不是装不上
- 替换 surface 实现（e.g. proxy 到远程服务 / 上游 OpenAI batch endpoint）
  不动 web 代码

### 3.5 M4 deepCheck **不下调** `draftStatus`

设计抉择：deepCheck 失败时，要不要把 `draftStatus` 从 `valid` 改成
`valid_with_warnings`？

不要。`draftStatus` 反映的是 **schema 层** 的判定（这个 yaml 能不能
parseWorkflow 通过）；deepCheck 反映的是 **inventory 层** 的判定（这个
yaml 在当前 hub 跑起来会不会爆）。两个轴正交，混到一个枚举里只会让
caller 检测逻辑更乱。

Admin UI 的 chip 由 `(draftStatus, deepCheck?.ok)` 联合决定：

| draftStatus | deepCheck.ok | chip 颜色 | 文案 |
|---|---|---|---|
| `valid` | `true` (或缺) | 绿 ✓ | 校验通过 (可保存) |
| `valid` | `false` | 黄 ⚠ | schema 通过，但有 N 项深度警告 |
| `invalid` | — | 红 ✗ | YAML 不合 v1 schema |
| `no_yaml` | — | 灰 ◌ | LLM 没生成 YAML |

Save 按钮 **只看** `draftStatus === 'valid'`。admin 自己看 warnings 决定要
不要救（reviewer-style 责任在 admin），yellow 不阻断保存路径。

### 3.6 `contextHints` 双重用途

Admin UI submitWorkflowAssist 把当前 hub 的 `participants() + workflow ids`
打包成 `contextHints` 喂给 assistant。同一个 contextHints 干两件事：

1. **塞进 system prompt** → LLM 用真名（"writer"、"telegram-bot"）而不是
   编名字
2. **`inventoryFromContextHints` → WorkflowInventory** → 深度检查器拿来
   验证 LLM 实际生成的 yaml 引用是否真的存在

复用同一个数据源避免「LLM 看到了一组 agent，checker 用另一组」的漂移。

### 3.7 Provider 选择走 host env，跟 LocalAgentPool 同套 key 解析

```
GOTONG_ASSISTANT_PROVIDER  'anthropic' (默认) | 'openai' | 'openai-compatible' | 'mock'
GOTONG_ASSISTANT_MODEL     可选 provider-specific model id
                         (openai-compatible 强烈建议设 — OpenAI 默认模型在别家端点不存在)
GOTONG_ASSISTANT_MAX_TOKENS 可选 (默认 4096)
GOTONG_ASSISTANT_BASE_URL  仅 openai-compatible — 兼容端点 (如 https://api.deepseek.com/v1)
GOTONG_ASSISTANT_API_KEY_ENV 仅 openai-compatible — 存放该厂商 key 的环境变量**名**
                         (指针不是 key 本体，tokenEnv 纪律)
GOTONG_ASSISTANT_DISABLED  '1' / 'true' → 跳过注册，route 转 503
```

API key 解析链（与 `LocalAgentPool.resolveApiKey` 同套，减 per-agent /
workspace 两层 — 这是 host 内置 agent 不是用户 agent）：

1. `OrgApiPool`（如果有 vault 配过 entry）
2. host env (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`)
3. 都没有 → 不注册，log warn，route 自动 503

`openai-compatible`（S1-M4，让 MiMo / DeepSeek 等端点也能跑 assistant，从而
让常驻管家在这类 hub 上露出 `edit_workflow`）**跳过上面两层**：每个 baseURL
是不同厂商，key 只从 `GOTONG_ASSISTANT_API_KEY_ENV` 指名的环境变量读——绝不
把 `OPENAI_API_KEY` 静默发给第三方端点。缺 baseURL 或 key → 同样不注册。

Mock provider 不需要 key，永远可用（CI 跑、本地无 key 演示都靠它）。

---

## 四、数据流端到端

下面是 admin 用 AI 助手生成一个新 workflow 的完整链路（M3+M4 全跑）：

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ admin UI 「AI 助手 (beta)」对话框                                    │
 │                                                                      │
 │   1. 用户填描述: "每天 8 点抓 RSS, 摘要, 推 Telegram"                │
 │   2. submitWorkflowAssist() 收集当前 hub 的 contextHints:            │
 │        agents: [crawler, summarizer, telegram-bot, …]               │
 │        existingWorkflowIds: ['daily-greeting', 'news-digest']        │
 └─────────────────────────────┬────────────────────────────────────────┘
                               │ POST /api/admin/workflows/assist
                               │  { description, contextHints }
                               ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ web/server.ts — assist route                                         │
 │                                                                      │
 │   3. requireAdmin gate                                               │
 │   4. ctx.workflowAssist?.assist({ description, contextHints, by })  │
 │      (若 surface 不在 → 503)                                         │
 └─────────────────────────────┬────────────────────────────────────────┘
                               │
                               ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ host/workflow-assist-agent.ts — WorkflowAssistSurface 实现           │
 │                                                                      │
 │   5. hub.dispatch({                                                  │
 │        from: admin.id,                                               │
 │        strategy: { kind: 'capability',                               │
 │                    capabilities: ['workflow:assist'] },              │
 │        payload: { description, contextHints }                        │
 │      })                                                              │
 └─────────────────────────────┬────────────────────────────────────────┘
                               │
                               ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ workflow-assistant/assistant.ts — WorkflowAssistantAgent             │
 │                                                                      │
 │   6. buildRequest: 拼装 system prompt + user message                 │
 │   7. provider.complete (Anthropic / OpenAI / DeepSeek / Mock)        │
 │   8. parseResponse:                                                  │
 │      a. extractYamlAndExplanation(raw) → { yaml, explanation }      │
 │      b. inventoryFromContextHints(payload.contextHints)              │
 │         → WorkflowInventory                                          │
 │      c. verdictForYamlWithDeepCheck(yaml, inventory):                │
 │            yaml === '' → no_yaml                                     │
 │            parseWorkflow 抛 → invalid + validationError              │
 │            parse 通过 → valid; 跑 checkWorkflowStructure → deepCheck │
 │      d. 组装 WorkflowAssistantOutput                                 │
 └─────────────────────────────┬────────────────────────────────────────┘
                               │
                               ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ evals/checkers/workflow-structure.ts                                 │
 │                                                                      │
 │   9. checkWorkflowStructure(parsed, inventory):                      │
 │      walk steps × dispatch strategy:                                 │
 │        - explicit.to       ∉ inventory.agents → unknown_agent       │
 │        - capability        无 agent 满足      → unknown_capability  │
 │        - = trigger.cap     (capability/broadcast) → self_trigger_cycle │
 │      walk $-refs:                                                   │
 │        - 头部 ∉ allStepIds → bad_ref                                │
 │        - 头部 ∈ allStepIds 但晚于当前 → forward_ref                 │
 │      workflow.id ∈ inventory.existingWorkflowIds → id_collision     │
 └─────────────────────────────┬────────────────────────────────────────┘
                               │ verdict 回流
                               ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ route 返回 200 + JSON                                                │
 │   { ok: true, yaml, explanation, raw, draftStatus,                  │
 │     validationError?, deepCheck?, by, stopReason, usage? }           │
 └─────────────────────────────┬────────────────────────────────────────┘
                               │
                               ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ admin UI — renderAssistResult                                        │
 │                                                                      │
 │  10. status chip: (draftStatus, deepCheck.ok) → 绿/黄/红/灰          │
 │  11. yaml 预览 (折叠 details)                                        │
 │  12. validationError pre (invalid 时)                                │
 │  13. deep-check warnings 列表 (每条 kind label + message + path)     │
 │  14. save 按钮: 只在 draftStatus='valid' 启用                        │
 │       → POST /api/admin/workflows/import (走现有 yaml 导入路径)      │
 └──────────────────────────────────────────────────────────────────────┘
```

整条链路一次请求 ~5–40 秒（DeepSeek-v4-flash 实测；Claude / GPT 类似），
token 消耗 ~700 in / 100–2500 out（看 workflow 复杂度）。

---

## 五、测试矩阵

| 包 | 新增 | 总数 | 覆盖 |
|---|---|---|---|
| `@gotong/workflow-assistant` | 44 | 44 | M1 helpers + assistant + verdictForYaml + verdictForYamlWithDeepCheck + inventoryFromContextHints + parseResponse 集成 + bad-payload 路径 |
| `@gotong/evals` | 24 | 45 | checkWorkflowStructure 全 violation 矩阵：happy path × 7 + id_collision × 2 + unknown_agent × 3 + unknown_capability × 5 + self_trigger_cycle × 3 + bad_ref/forward_ref × 6 + aggregation × 1 |
| `@gotong/host` | 14 | 253 | resolveWorkflowAssistConfig (env vars × 7) + createWorkflowAssistAgent (provider/key resolution × 7) |
| `@gotong/web` | 12 | 329 | /api/admin/workflows/assist route：503 / 401 / 400 × 2 / 200 happy / invalid + validationError forward / no_yaml forward / 500 surface throws / omits hints / deepCheck.ok=true forward / deepCheck.ok=false 多 violation forward / omits deepCheck |

Zero regressions across full sweep.

---

## 六、运维须知

### 6.1 启用 / 关闭

```bash
# 启用（默认，需 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 或 vault 里有 entry）
pnpm --filter @gotong/host start

# 显式禁用
GOTONG_ASSISTANT_DISABLED=1 pnpm --filter @gotong/host start

# 切换 provider
GOTONG_ASSISTANT_PROVIDER=openai pnpm --filter @gotong/host start

# DeepSeek（用 OpenAI provider + baseURL；见 examples/workflow-assistant 写法）
# 直接对 assistant agent 用 DeepSeek 还未一线支持 — 走 examples 路径即可
```

### 6.2 凭证

- **优先 OrgApiPool**（admin UI → settings → API keys 配 vault entry）
- 退路：host env `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- 都没有 → host 启动 log 出 warn，route 自动 503，admin UI 提示「未启用」
- Mock provider 永远可用（CI / 演示）

### 6.3 配额

- Assist 调用 **不走 quota 扣减**（跟 LocalAgentPool 的 host-managed agent 同策）
- 理由："admins are operators, not consumers" — workflow 编辑是 ops 行为
- 若要按用户扣（e.g. 给某个团队的 admin 配独立配额），把 surface 改成
  通过 /api/me/* 路径走 user task.origin

### 6.4 Transcript

- 每次 assist 调用写一条 `task` + 一条 `task_result` entry
- 用 `transcript.size()` / `.tail()` 看历史；admin UI tasks tab 可查
- 这是有意的：AI 编辑器 = 行为，需要审计

### 6.5 成本

实测（DeepSeek-v4-flash）：
- 700 tokens in + 2400 tokens out ≈ ¥0.001 / 次
- 一个普通 admin 一天编 10 个 workflow ≈ ¥0.01

Anthropic Haiku / OpenAI gpt-4o-mini 是这个 10–50 倍。Claude Sonnet 4 是
500–1000 倍。

---

## 七、未做 / 后续可补

| 项 | 说明 |
|---|---|
| **Few-shot examples** | `WorkflowAssistantOptions.examples` 现在传空。可以读 `templates/workflows/*.yaml` 头部的 `assistant_hint` comment 自动注入，让 LLM 看到 6 个已知好例子，生成准确率上一台阶 |
| **Self-correction loop** | 当前 `invalid` / `deepCheck.fail` 让 caller 决定要不要再问。可以加 `autoRetry: number` option，在 agent 内部把 validationError + violations append 进对话再问一轮。但需要谨慎 — LLM 自纠错经常不收敛 |
| **Streaming chip** | Phase 8 streaming 框架已经在，admin UI 接进来就能「实时看 LLM 打字」。当前是 await 完整 response 再 render。30s+ 的 workflow 生成会感觉很慢 |
| **WorkflowAssistantAgent 集成 `dispatch` 工具** | 如果让 assistant 能 dispatch sub-task（"我先查一下当前有什么 agent" → dispatch 一个 capability=`hub:introspect`），生成质量会再上一层。Phase 10 的 `DispatchToolset` 已经在，接进来就行 |
| **RAG over existing workflows** | 把 hub 里所有 workflow YAML 喂进一个本地 embeddings + 在 assist 时 retrieve 最相似的几个当 few-shot — 让 LLM 学这个 hub 的「方言」 |

---

## 八、入口指南

> **已演进 →「工作流架构师」**：本阶段的 `WorkflowAssistantAgent` 后来加上了
> 「按深度讲解」+「绑定流程图」+「成员 `/me` 大白话新建工作流」三件能力
> （capability `workflow:assist` 与 id `workflow-assistant` 不变）。完整设计、
> 治理边界与验收门见 [`docs/zh/WORKFLOW-ARCHITECT.md`](WORKFLOW-ARCHITECT.md)。

- 想用：admin UI workflow tab → 「AI 助手 (beta)」按钮
- 想 demo：[`examples/workflow-assistant`](../../examples/workflow-assistant)
- 想理解 assistant 代码：[`packages/workflow-assistant/src/assistant.ts`](../../packages/workflow-assistant/src/assistant.ts)
- 想理解 deepCheck 代码：[`packages/evals/src/checkers/workflow-structure.ts`](../../packages/evals/src/checkers/workflow-structure.ts)
- 想理解 host 接线：[`packages/host/src/workflow-assist-agent.ts`](../../packages/host/src/workflow-assist-agent.ts)
- 想理解 web route：`packages/web/src/server.ts` 搜 `workflows/assist`
- 想理解 admin UI：`packages/web/static/admin.js` 搜 `wfAssist`
