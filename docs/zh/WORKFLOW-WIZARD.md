# 建流向导（Workflow Wizard）— 六段式「从一句话到能落盘的工作流」

> WIZ-M1→M5。用户原始诉求逐字：「先和用户确定任务（用户可跳过确认），再查看目前
> hub 内已有组件和我们预置的组件列表（记录各种组件的作用），选择合适的组件以正确
> 的方法连接起来。在这个过程中，它要衡量任务、资源（包括人和智能体以及其他软硬件），
> 组成合适的工作流，给用户建议后由用户调整或同意。最终还要校验无错误才算完成。」
>
> Last updated: 2026-07-03

---

## 一、它和工作流架构师的关系

[工作流架构师](WORKFLOW-ARCHITECT.md)（ARCH）是「大白话 → YAML + 讲解 + 配图」的
**生成器**；向导（WIZ）是包在它外面的**流程编排**：先零 LLM 盘点组件、把目录喂进
生成、生成后衡量缺口、机器级错误自动修、最后由用户同意才落盘。生成还是那一个
assist 面（`workflow:assist`），向导不另造第二个 NL→YAML 引擎。

```
① 确认任务(可跳过)   零 LLM。确认卡 + 可选澄清问题
② 盘点组件           零 LLM。五源聚合成组件目录（已装 + 预置两节）
③ 选型组装           喂目录给 assist（「只能用目录里的东西」）
④ 衡量缺口           零 LLM。逐步骤「谁能接 / 怎么补」（人也是组件）
⑤ 提议 → 用户调整/同意  YAML + 讲解 + 配图 + 缺口清单 + 三种补法
⑥ 校验闭环           机器级错误 → 有界修复(R1, 默认 2 轮) → 仍错则渲染成指令(R2)
```

## 二、两个关键分诊（向导的判断力所在）

**修复 vs 缺口**。⑥ 段只把「机器必须修」的错误送回模型重写：解析失败 + 四种
HARD 违规（`bad_ref` / `forward_ref` / `self_trigger_cycle` / `id_collision`，与
`saveDraft` 写闸同款）+ 幻觉能力名（目录里近似命中，`nearestNames`：编辑距离≤2 /
大小写 / 包含）。**「用了预置模板才有的能力」不是错误，是缺口**——那正是预置节
存在的意义，交给 ④ 出补法、由用户批准，绝不让模型「修」掉一个本该装模板解决的步骤。

**缺口三补法**（`workflow-gap-analysis.ts`，纯函数）：
- `install_template` — 预置模板里**单个 agent** 能覆盖全部所缺能力才提（镜像
  deepCheck 的 all-caps 语义：一个参与者覆盖一步的所有能力，不许拼凑）；
- `create_agent` — 有燃料（LLM key 或本地端点）才提；
- `assign_member` — hub 里有人（human participant）才提。
  显式 id 缺失只提前两种（装完的 id 以实际注册为准，话术已按此写诚实）。

## 三、目录五源（②，`wizard-wiring.ts`）

| 源 | 进目录哪节 |
|---|---|
| `hub.participants()` | 已装（人和 agent 同列——**人也是组件**） |
| `space.mcpServers()` | 已装 MCP |
| RES-M1 资源探测（只读） | 燃料（key / 本地端点 / CLI），喂 `create_agent` 补法 |
| 模板画廊卡片（`buildTemplateCatalog`，与安装路径同一 parseTemplate） | 预置模板（带逐 agent 能力集） |
| `BUILTIN_MCP_CONNECTORS` | 预置连接器 |

每次调用现聚合（新 spawn 的 agent 下一次 prepare 就在场）；逐源容错——单源抛错只
丢那一角，绝不整体 503。

## 四、三入口

| 入口 | 路由 / 工具 | 落盘 |
|---|---|---|
| admin | `POST /api/admin/workflows/wizard/{prepare,compose}` | 拿 YAML 走既有 admin 草稿/导入路由（RBAC/审计已在） |
| 成员 `/me` | `POST /api/me/workflows/wizard/{prepare,compose,approve}` | `approve` 零 LLM 压 `createFromYaml`（与 `/create` 完全同闸：草稿上限 → LOCAL-ONLY → id 撞车 → 结构硬闸 → owner 种子；deny→HTTP 同映射 409/429/422） |
| 管家（IM） | benign `plan_workflow`（只出方案不落盘）→ governed `create_workflow` 带可选 `yaml` | 批准后按向导核对过的 YAML 原样落盘（零 LLM）；yaml 通道没接线则诚实拒绝，绝不静默重写成员没看过的东西 |

共同纪律：`by`/`userId` 永远取服务端会话身份；compose 与 create/edit 同限流；
`ok:false`（反问 / 耗尽）是向导的**正常对话态**，HTTP 回 200 不回错；assist 面缺席
→ 路由 503 `not_wired` / 管家工具不出现。无状态：多轮 history 由客户端携带
（WFEDIT 前例），R1 修复往返只活在一次 compose 调用内部。

## 五、「草稿可以带缺口」这条线

HARD 四违规挡**一切**写路径；`unknown_agent` 只挡 go-live（草稿放行）；
`unknown_capability` 全程 advisory。所以：向导修完的 YAML 必过 `saveDraft`；带缺口
的提议**可以**先落成草稿，装完模板 / 邀请到人再发布。E2E 承重门第 4 条钉死这个行为。

## 六、测试与评测基线

| 门 | 文件 | 钉什么 |
|---|---|---|
| 单元（编排核） | `packages/host/tests/workflow-wizard.test.ts`（15） | 六段状态机、修复/缺口分诊、history 折叠、耗尽/反问 |
| 单元（缺口） | `workflow-gap-analysis.test.ts`（13） | all-caps 镜像、三补法 gating、渲染文本 |
| 单元（装配） | `wizard-wiring.test.ts`（4） | 五源投影、逐源容错 |
| 路由 | `packages/web/tests/wizard-routes.test.ts`（18） | 认证闸、身份强制、清洗、同映射、限流、降级 |
| 管家 | `butler-workflow-wizard.test.ts`（9）+ `butler-workflow-create.test.ts` yaml 节（5） | 方案渲染、三态转译、verbatim 交接、no-leak |
| **E2E 承重门** | `workflow-wizard-e2e.test.ts`（6） | 真 Hub + 真架构师（确定性 mock LLM）+ 真五源装配 + 真落盘闸，六段全走：零 LLM 盘点 / 一把过落草稿 / R1 修 forward_ref / 预置缺口→installTemplateRefs 且缺口草稿可落 / 顽固耗尽零落盘 / 反问 needs_user |
| **live 评测基线** | `live-wizard-eval.test.ts`（有 key 才跑） | 固定 4 条中文任务过真模型，打分卡 green/repaired/needs_user/exhausted/error，底线 = 零 error 且 ok≥半数 |

跑 live 评测：`OPENAI_API_KEY=… OPENAI_BASE_URL=… AIPE_LIVE_OPENAI_MODEL=… npx vitest run packages/host/tests/live-wizard-eval.test.ts`
（或 `ANTHROPIC_API_KEY`）。**基线记录（2026-07-03，MiMo mimo-v2.5-pro）**：
green=2（hitl、gap——缺口任务正确指到 legal-pack 模板）、needs_user=2（seq、fan
模型选择反问）、exhausted=0、error=0。改 `EVAL_TASKS` 会使基线不可比——只加不改。

## 七、旋钮

无新增 `AIPE_*`。向导的开关就是 assist 面本身（workflowAssist 在则向导在），修复
轮数上限是构造参数 `maxRepairRounds`（默认 2），不设环境旋钮——防旋钮再膨胀
（GUARD 纪律）。
