# Workflows · 工作流模板（初始参考集）

> 🧩 **Gotong 的 Hub 不内置 workflow 引擎**，它只负责派任务和记录 transcript。
> "工作流"是上一层的能力，由 [`@gotong/workflow`](../../packages/workflow/) 这个
> 可热插拔的包提供。本目录是该包配套的 YAML 模板集。

## 怎么用

1. 把 `.yaml` 文件放到 host 配置的 workflow 目录下（默认
   `.gotong/workflows/definitions/`）
2. 启动 host —— 它扫这个目录，每个 yaml 自动注册成一个 `WorkflowRunner`
3. admin 在控制台派任务到 workflow 的 `trigger.capability` —— 整个流程自动跑完，
   最后回一个 TaskResult

```bash
# 比如
cp templates/workflows/editorial-flow.yaml .gotong/workflows/definitions/
pnpm host                    # host 启动时自动加载
# admin UI 派任务：strategy={kind:capability, capabilities:['run-editorial']}
# payload={topic:'...', notes:'...'}
# → 等结果。中间 draft + review 两步自动跑。
```

## 当前目录

```
workflows/
  editorial-flow.yaml              中文编辑流水线（writer → reviewer）
  admin-task-flow.yaml             ⭐ 行政任务编排全流程
                                   (解析→拆解→[并行: 联络稿+派发]→报告→归档)
  admin-report-restyle-flow.yaml   ⭐ 报告改写专用（最常复用的场景）
                                   旧报告 + 新口径 → 同事实、新表达
  industry-enablement-flow.yaml    ⭐ 传统行业 AI 赋能梳理（v1，全自动）
                                   (诊断→机会→工具→落地→顾虑回应)
                                   ⚠️ 暂未接入 v2.3 case-conversation
  industry-consultation-flow.yaml  🆕 传统行业咨询（v2.3，含真人 review +
                                   案主插话）
                                   intake→research→draft→👤review→finalize
                                   集成 Hub Services（memory/artifact/datastore）
                                   + case-conversation 横切对话面

  # 🙋 member-facing —— 声明 surface.me，任何登录用户从 /me 直接跑
  personal-growth-flow.yaml        🙋 个人成长发展路径（7 教练，scope=case_id）
  daily-reflection-flow.yaml       🙋 每日反思（最小 1 步示例，默认 case_id scope）
  weekly-goal-checkin-flow.yaml    🙋 每周目标复盘（2 步示例，scope=owner_user_id）

  # 🏭 行业模板（Phase 19 P5）—— 声明 governance 风险元数据，mock provider E2E 跑通
  contract-review-flow.yaml        🏭 合同审阅 + 法务复核
                                   (extract→assess→👤法务签字→memo；HITL approve)
  lead-qualification-flow.yaml     🏭 销售线索资格审查 + CRM 回写
                                   (enrich→score→[合格才]outreach→crm-sync；when 条件)
  issue-triage-flow.yaml           🏭 研发 issue 分诊
                                   (classify→[并行: 严重度/查重/标签]→assign；parallel)
```

⭐ = 配套 `templates/teams/` 下同名团队使用。
🙋 = member-facing：声明 `surface.me.enabled`，出现在 `/me` 成员工作台。
后端强制 `payload[userScopeField] = 调用者 userId`（默认 `case_id`），
成员只能为自己跑；`surface.me.input_schema` 不含 scope key（不暴露给成员）。
🆕 = v2.3：在 v2.2 "Hub Services + 人在回路" 基础上引入 **案主任务管家
**（`templates/agents/case-manager.yaml`），让案主能在工作流任意时刻
插话，对话写进 case-memory，下游 step 自动读到。端到端实测见
`examples/industry-consultation-deepseek/`（真实 DeepSeek API），单元
测试见 `packages/host/tests/case-context.test.ts` + `industry-consultation-flow.test.ts`。

🏭 = 行业模板（Phase 19 P5）：声明 **`governance`** 风险元数据（数据敏感级 /
需要的 key / 预估成本 / 需哪些真人角色 / 触达哪些外部系统），admin import/publish
前在风险摘要里看得见（schema 见 `packages/workflow` 的 `governance` 块）。每个都有
mock-provider 端到端测试（`packages/workflow/tests/templates-e2e.test.ts`），不接真
LLM 也能在 CI 跑通。`contract-review-flow` 还演示 Phase 16 `human:` 步——第 3 步是真
人法务在 `/me` 收件箱签字，工作流挂起等他。

## YAML 速查

```yaml
schema: gotong.workflow/v1
workflow:
  id: my-flow                          # 必填，全空间唯一
  name: 显示用名字                     # 可选
  description: ...                     # 可选

  trigger:
    capability: my-cap                 # admin 派任务到这个 cap 触发

  steps:                               # 顺序执行
    - id: step1
      dispatch:
        strategy: { kind: capability, capabilities: [foo] }
        payload: { x: $trigger.payload.x }

    - id: step2
      dispatch:
        strategy: { kind: capability, capabilities: [bar] }
        payload: { input: $step1.output }
      onFailure: { action: retry, max: 2 }   # 可选，重试 2 次

    - id: fanout                       # 并行
      parallel: true
      branches:
        - id: a
          dispatch: { ... }
        - id: b
          dispatch: { ... }

    - id: notify-boss                  # 条件执行（v0.2）
      when: $trigger.payload.priority == "high"
      dispatch:
        strategy: { kind: capability, capabilities: [notify] }
        payload: ...

  output:                              # 最终返回给 admin 的内容
    result: $step2.output
    side: $fanout.a.output

  onFailure: halt                      # 默认 halt；可改 continue
```

### 引用语法

| 引用 | 取到什么 |
|---|---|
| `$trigger.payload` | 触发任务的整个 payload |
| `$trigger.payload.foo.bar` | payload 的某个嵌套字段 |
| `$stepId.output` | 该步整个输出（保留原类型） |
| `$stepId.output.field` | 该步输出的某个字段 |
| `$stepId.branchId.output` | 并行步骤里某个分支的输出 |
| `"请审稿: $draft.output"` | **内嵌**到长字符串里时按 JSON 字符串化拼接 |

### 失败策略

| `onFailure.action` | 行为 |
|---|---|
| `halt`（默认） | 任一步失败，整个 workflow 立刻返回失败 |
| `continue` | 失败的步骤标记为 `skipped`，继续往后跑 |
| `retry` + `max: N` | 该步重试最多 N 次再判定 |

`onFailure` 可写在 step 级，也可写在 workflow 顶层。step 级优先。

### 条件执行 `when:`（v0.2）

每个 step（包括 parallel 步）都可以加一个 `when:` 表达式。
**为 `false` 时该步被跳过，downstream 用 `$step.output` 引用会得到 `undefined`**。

```yaml
- id: notify-boss
  when: $trigger.payload.priority == "high" && $analyze.output.score != 0
  dispatch: ...
```

**v0.4 起每个并行分支也可以单独加 `when:`**：

```yaml
- id: fanout
  parallel: true
  branches:
    - id: send-email
      when: $trigger.payload.notify_email == true
      dispatch: ...
    - id: send-slack
      when: $trigger.payload.notify_slack == true
      dispatch: ...
```

被跳过的分支：

- 不会派发任何任务（`subTaskIds` 里不会出现）
- `$fanout.output.<branchId>` 解析为 `undefined`
- 不算失败（不会触发 `onFailure`）

如果 `parallel` 步本身的 `when` 为 false，整个 step 跳过，里头的分支
predicate 根本不会评估。

支持的语法（故意小而精）：

| 类型 | 语法 |
|---|---|
| 引用 | `$trigger.payload.foo` / `$stepId.output.bar` |
| 字面量 | `"string"` / `123` / `true` / `false` / `null` |
| 比较 | `==`、`!=`（**严格类型**，`1 == "1"` 为 false）|
| 布尔 | `&&`、`\|\|`、`!`（短路）|
| 分组 | `( ... )` |

**故意不支持**：算术（`+`、`-`、`*`）、大小比较（`<`、`>`）、函数调用、数组/对象字面量。
`when` 是闸门不是计算 —— 如果想做计算，写一个步。

错误的 `when` 表达式在导入时（`parseWorkflow`）就会被拒，不会等到运行时才崩。
缺失的 ref（`$nope.output`）当 `undefined` 处理，不抛错 —— 这样易用，跟"没跑过"的 step 行为一致。

## 文件落盘

每跑一次 workflow，runner 会在
`<space>/workflows/runs/<runId>.json` 写一份**完整运行状态**，包括：

- 触发任务的 payload
- 每一步的开始 / 结束时间、attempts、子任务 id 列表
- 每一步的输出 / 错误
- 最终结果

崩了重启也能用 `jq` 翻看历史。和 Gotong v2.0 "file-first" 路线完全一致。

### 中断恢复（v0.3）

host 启动时会扫一遍 `runs/`，把所有 `status: "running"` 的旧 run **从上次未完成的那一步**接着跑：

- 已完成的 step（`status: "done"`）**不再重新派发**，输出从磁盘恢复供下游 `$ref` 使用。
- 跑到一半挂掉的 step（`status: "running"`）会被**整步重跑**（旧的子任务 id 丢弃）。
- 工作流定义被删除（YAML 文件不在了）的旧 run，会被关掉，标为 `failed`，附 `error: "host restarted while running and workflow '<id>' is no longer loaded"` —— 不会一直挂在 admin UI 的"运行历史"里假装还在跑。

恢复异步进行，不会阻塞 host boot。控制台会打印一行 summary：

```
[workflows] resume: 1 continued from last completed step, 0 marked failed (workflow no longer loaded)
```

## 贡献新 workflow

欢迎 PR。规范：

1. yaml 文件头部三行注释：`# Workflow:`、`# Companion team:`（如有）、`# Schema:`
2. 每个 step 加 `description:` 一句话说明，便于 admin 看 transcript 时理解
3. 触发 capability 用 `<动词>-<对象>` 形式（`run-editorial`、`orchestrate-admin-task`）

manifest 自动测试会覆盖本目录的所有 yaml —— 你只要文件能解析，CI 就过。

## License

MIT — 与项目主仓 license 一致。
