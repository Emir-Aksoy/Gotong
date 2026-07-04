# v4 Phase 19 / P5 — 生态接入与行业模板（FINAL）

> 接续 P1（`/me` 成员工作台）/ P2（workflow 治理）/ P3（生产安全运维）/ P4（联邦信任契约）。
> P5 是 Phase 19 的最后一段：把 Gotong 从「能自洽运转」推到「**接得上别人的生态、装得下行业的活**」。
> 全程纯本地 `main`，一里程碑一小 commit，未 push。
>
> Last updated: 2026-06-01

---

## 一、缺口（开工前已用真代码核实）

1. **没有 agent-framework adapter**。Python SDK 有 `AgentParticipant`，但要把一个
   LangGraph graph / CrewAI crew 接进 Hub，得手写胶水；生态里两大主流框架零样板。
2. **没有 automation 桥**。MCP client/server 有了，但「Zapier 类平台触发 hub」「hub
   委托外部 durable engine」这两个方向没有可复制的范例。
3. **行业模板薄**。`templates/workflows/` 有编辑流 / 个人成长 / 行业咨询，但没有
   「带治理元数据、能 mock E2E 跑通、覆盖 HITL/条件/并行三种控制流」的成套行业模板。
4. **工作流没有风险标签**。workflow 跑起来才知道它碰什么数据、要什么 key、需不需要人
   签字。import/publish 是「盲签」——治理元数据这一层完全缺失。

目标（验收门）：接 ≥2 个外部 agent framework + ≥2 个外部 automation 平台；≥3 个行业
模板能用 mock provider 端到端跑通；用户从模板风险摘要能看出会用哪些 key / 调哪些外部
系统 / 产生哪些数据。

---

## 二、各里程碑

### P5-M1 — LangGraph participant adapter（`448a4fa`）

`python-sdk/src/gotong/adapters/langgraph.py`：把一个编译好的 LangGraph graph 包成
`AgentParticipant`。graph 是**鸭子类型**——任何有 `.invoke(state)` 的对象都行，有
`.ainvoke` 时优先用它，同步 graph 丢到线程池跑（不阻塞 event loop、不拖垮同连接的其他
agent）。`langgraph` 是 **peer dependency**：导入 adapter 永不把它拉进来，所以核心 SDK
安装保持轻、adapter 单测对着一行 fake graph 跑（CI 不装 langgraph）。`to_state` /
`from_state` 映射 Gotong task ↔ graph 的 state dict，默认透传 payload、返回整个 final
state。+7 pytest。

### P5-M2 — CrewAI participant adapter（`f420e1c`）

同 M1 的接缝。`adapters/crewai.py` 鸭子类型在 `.kickoff(inputs)`（有 `.kickoff_async`
时优先）。`from_output` 默认抽 `CrewOutput.raw` 进 `{"text": ...}`——因为裸 CrewOutput
对象过不了 wire/transcript 序列化；caller 可覆盖去拿 `.json_dict` / `.tasks_output`。
+6 pytest。

### P5-M3 — Activepieces 入站 webhook 桥（`d080eb8`）

`examples/activepieces-bridge/`：任何能 POST JSON 的平台（Activepieces / n8n / Make /
Zapier / cron curl）经 `createWebhookBridge` 触发 hub 工作流——IM 桥的自动化版孪生
（HTTP 进，capability dispatch 出，transcript 旁记）。两条信任规则让它敢对外暴露：
① **共享密钥 fail-closed**（`X-Gotong-Webhook-Secret` 常量时间比，空密钥构造期就抛，无匿名
模式）；② **capability-only + operator 白名单**（请求只能命中 `routes` 里声明的
capability，永远点不到具体 agent，body 只当 payload——跟 A2A server 同一条规则：调用方
选「做什么」，运营方定「谁能做」）。HITL 挂起的任务回 `202 Accepted`。demo 自断言
（loopback 桥 + fetch 扮 Activepieces：200 happy / 401 错密钥 / 404 未知 hook），`start`
即 smoke。

### P5-M4 — Windmill 出站 durable 桥（`823049e`）

`examples/windmill-bridge/`：M3 的出站孪生。`WindmillParticipant` 是个普通
`AgentParticipant`，按 capability 被选中，把活交给 Windmill——提交 flow（`jobs/run/f/<path>`，
job 此刻已 durable 在服务端）→ 轮询 `get_result_maybe` 直到完成。durable job 自身逻辑失败
（`success:false`）变 failed task；提交/轮询传输错也 fail。Hub 保持「路由器 + system of
record」，重活 / 长任务 / 不能丢进度的执行放进为它而生的引擎（重试 / 步级 checkpoint / 活过
Gotong 重启）。同 `submit→poll` 形状套 Temporal / Inngest / 队列 worker——换两个 URL。
token 由 caller 传（env/vault），`fetchImpl` 可注入。demo 跑 fake Windmill（2 次轮询才
完成，逼出 poll loop），自断言 ok + failed。

### P5-M8a — governance / 风险元数据 schema（`a5bcdee`）⚠️ schema

模板得有地方声明风险画像，所以 schema **先于模板**落。workflow 新增可选 `governance`
块（完全照 Phase 14 `surface` 块的模式）：`dataSensitivity`（public|internal|
confidential|pii）/ `requiredCredentials`（key 名，永不存值）/ `expectedCostUsd` /
`requiredHumanRoles`（自由文本签字角色）/ `externalSystems` / `notes`。runner 完全无视它；
`validateGovernanceSpec` import 期校验结构（snake_case + camelCase 双收），坏元数据当场
报错而不是带病上线。**它不是执行闸**（P2 RBAC + 结构检查才管执行）——它是 web 在
import/publish 前渲染的「营养成分表」。`WorkflowSummary.governance` 经 host 透传（不透明
pass-through，同 surfaceMe 的 dumb-pipe），web 鸭子类型镜像（不需 workflow 包导出）。
+13 测试（workflow schema 11 + host 投影 2）。

### P5-M5 — 合同审阅 + 法务复核模板（`1b6e7f1`）

`templates/workflows/contract-review-flow.yaml`：P5 三模板之一，演示「AI 起草、人拍板」闭环
——抽取条款 → 评估风险 → **法务在 `/me` 收件箱签字**（Phase 16 `human:` 步）→ 综合人的
决定出审阅备忘录。同时吃 M8a governance（机密数据 / 需 anthropic key / 需法务签字角色，
import 期就看得见）+ Phase 16 `human:`（第 3 步是收件箱里的真人 participant，不是
request_human_input tool，run 挂起等他签）。E2E（`templates-e2e.test.ts`）用 mock-provider
stub hub 跑通整条 step graph，human 步的 mock 返回已解析的决定（suspend/resume 本身
Phase 16 inbox-e2e 已覆盖）。

### P5-M6 — 销售线索资格审查 + CRM 回写模板（`5b6fe1e`）

`lead-qualification-flow.yaml`：演示 AI 富化 + **条件分流** + 回写外部系统——富化线索 →
打分（带 `qualified` 布尔）→ 只有合格线索才 `when:` 起草触达邮件 → 回写 CRM。governance
声明碰 PII（线索联系方式）+ 触达外部 `crm-api`。E2E 覆盖**两条分支**：合格 → 触达运行 +
crm-sync 拿到它；不合格 → `lead-outreach` 从不派发 + 跳过步的 `$ref` 解析成 undefined。

### P5-M7 — 研发 issue 分诊模板（`c9f409e`）

`issue-triage-flow.yaml`：演示 **parallel 并行扇出**——分类 issue → 一把扇出三路独立分析
（严重度 / 查重 / 标签）→ 综合三路给指派建议。governance 是 `internal` 无外部系统（纯分析
出建议，诚实标明不回写仓库）。E2E 断言扇出真并发（classify 首、assign 尾、三路居中）且
assign 拿到三路输出。至此 M5/M6/M7 三模板**正好覆盖 runner 的三种控制流**（人闸 / 条件 /
并行），P5 验收「≥3 模板 mock E2E 跑通」达成。

### P5-M8b — 风险摘要 admin UI（`aeeeff9`）

把 M8a 的 governance 块渲染进 admin UI，让风险在 review/publish 决策点看得见——每张
workflow 卡片长出可折叠的「⚠️ 风险摘要」面板：数据敏感级徽章（按 public→pii 绿到红）+
凭证 chip + 预估成本/次 + 真人角色 chip + 外部系统 chip + 备注。数据其实运行时早已流到
前端（host 投影、list 路由 verbatim echo summaries），这一步补 web `governance?` 类型
（对齐 surfaceMe 先例）+ `admin-src/workflows.js` 渲染 + zh/en i18n + 徽章/chip CSS + 重建
bundle。

---

## 三、关键设计决策（横切）

1. **adapter 鸭子类型 + peer dependency**：LangGraph/CrewAI 永不被 adapter 导入，框架由
   用户自己装。好处：核心 SDK 安装轻、单测对 fake 跑（CI 零框架依赖）、版本解耦。这是
   Gotong 一贯姿态（a2a 的 `fetchImpl`、im 的 `FakeBridge` 同源）。

2. **桥两个方向各一**：M3 入站（外部 automation → hub）、M4 出站（hub → 外部 durable
   engine）。入站的安全重心是「敢暴露」（共享密钥 fail-closed + capability-only），出站的
   重心是「会等」（submit→poll，durable job 活过本进程）。

3. **adapter/桥都做成 example/SDK 模块而非动 host**：沿用 Phase 12 IM 桥的判断——「不动
   `host/src/main.ts`，用户复制 example 当模板；等社区使用模式稳定再决定是否 fold 进
   host CLI」。M1/M2 进 SDK（鸭子类型轻量、可单测、是真复用 glue），M3/M4 留 example。

4. **schema 先于模板（M8a 在 M5 前）**：模板要声明 governance，schema 不先落，模板的元
   数据就是 ad-hoc 的、后面还得回填返工。所以把规划里的 M8 拆成 M8a（schema，先）+ M8b
   （UI，后），顺序 `M8a → M5 → M6 → M7 → M8b`。

5. **governance 是「营养成分表」不是「锁」**：纯声明，runner 无视，不门控执行（执行边界
   是 P2 的 RBAC + 结构硬闸）。它只解决「决策点看不见风险」这一个问题。把它跟执行闸混
   在一起会诱发「声明了 = 被强制」的错觉。

6. **三模板覆盖三控制流**：M5 = HITL 人闸、M6 = `when:` 条件、M7 = `parallel:` 并行。不是
   凑数——刻意让三个行业场景把 runner 的三种编排原语各演示一遍，模板集即文档。

7. **mock-provider E2E 放 workflow 包**：用 `WorkflowRunner` + stub hub（每 capability 一
   个 canned 结果），不接真 LLM、CI 绿。human 步的 mock 直接返回已解析的决定——不重测
   Phase 16 的 suspend/resume 机制，只验**模板本身**的 step graph 跑通。轻且聚焦。

---

## 四、测试矩阵（+33 自动化 + 2 自断言 example smoke，零回归）

| 包 | 新增 | 跑完 |
|---|---|---|
| python-sdk | +13（langgraph 7 + crewai 6） | 70 |
| workflow | +18（governance schema 11 + 3 模板 parse smoke + 4 mock E2E） | — |
| host | +2（governance 投影） | 436 |
| web | 0 新（M8b 由 typecheck + 537 套件 + 构建验证） | 537 |
| examples | activepieces / windmill 各 1 自断言 `start` smoke | — |

全量 `pnpm -r test` + `test:python` 绿。

---

## 五、运维须知

- **adapter 装框架**：用 adapter 接真 graph/crew 时自己装 `langgraph` / `crewai`（`pip
  install langgraph` 等）；adapter 本身不带这依赖。
- **webhook 桥放 TLS 后**：共享密钥只跟承载它的传输一样私密；反代或 host 自带 HTTPS。
  密钥进 env，别写进代码。
- **Windmill token 进 vault**：别写进 workflow YAML；对引擎走 TLS。
- **governance 是声明非强制**：风险摘要给人看、辅助 import/publish 决策；真正的执行边界
  是 P2 的 workflow RBAC + 运行时结构硬闸。别把「声明了 PII」当成「数据被技术性管控」。
- **模板配套 agents**：三个行业模板的 dispatch 目标（`contract-extract` 等）需要 host 注册
  对应 capability 的 agent（任意 LlmAgent）；模板只声明编排，不带 agent 实现。

---

## 六、显式推迟（保持精简）

- **真接外部 A2A/framework 的 wire 级互操作测试**：当前 adapter 单测对 fake 跑；接真
  LangGraph/CrewAI/Windmill 实例的端到端验证留给用真凭证的人。
- **更多 framework**（AutoGen / LlamaIndex / Semantic Kernel…）：M1/M2 已立形状，照抄即可。
- **pre-import-paste 实时风险预览**：M8b 在卡片渲染（import 落草稿后即带摘要，publish 前
  可见）；粘贴 YAML 当场预览（落库前）推迟。
- **governance 进 audit / 跨修订 diff**：风险摘要现在只读渲染，不进 `audit_log`、不在修订
  历史里 diff 元数据变化。
- **automation 桥的 admin-UI 配置持久化**：M3/M4 是 example（代码配 routes/agents），不是
  host first-class config。

---

## 七、验收对照

| P5 验收条 | 闭合于 |
|---|---|
| 接 ≥2 个外部 agent framework | M1 LangGraph + M2 CrewAI ✓ |
| 接 ≥2 个外部 automation 平台 | M3 Activepieces(入站) + M4 Windmill(出站) ✓ |
| ≥3 个行业模板 mock provider 端到端跑通 | M5 合同审阅 + M6 线索 + M7 issue 分诊（各带 E2E）✓ |
| 模板风险摘要能看出用哪些 key / 调哪些外部系统 / 产生哪些数据 | M8a governance schema + M8b 风险摘要 UI ✓ |

「机构可用」总验收 11 条此前在 P4 已全闭合（P5 是生态扩展，不新增总验收条）。

---

## 八、commit 链

```
448a4fa feat(python-sdk): LangGraph participant adapter (P5-M1)
f420e1c feat(python-sdk): CrewAI participant adapter (P5-M2)
d080eb8 feat(examples): Activepieces inbound webhook bridge (P5-M3)
823049e feat(examples): Windmill durable-workflow outbound bridge (P5-M4)
a5bcdee feat(workflow,host): governance/risk metadata schema + projection (P5-M8a)
1b6e7f1 feat(templates): contract-review industry template + E2E (P5-M5)
5b6fe1e feat(templates): lead-qualification industry template + E2E (P5-M6)
c9f409e feat(templates): issue-triage industry template + E2E (P5-M7)
aeeeff9 feat(web): governance risk-summary panel on workflow cards (P5-M8b)
<this>  docs(phase19): P5 ecosystem + industry templates closeout + CLAUDE.md (P5-M9)
```

全在本地 `main`，未 push。
