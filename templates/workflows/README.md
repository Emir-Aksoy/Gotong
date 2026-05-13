# Workflows · 工作流模板（初始参考集）

> 🧩 **AipeHub 的 Hub 不内置 workflow 引擎**，它只负责派任务和记录 transcript。
> "工作流"是上一层的能力，由 [`@aipehub/workflow`](../../packages/workflow/) 这个
> 可热插拔的包提供。本目录是该包配套的 YAML 模板集。

## 怎么用

1. 把 `.yaml` 文件放到 host 配置的 workflow 目录下（默认
   `.aipehub/workflows/definitions/`）
2. 启动 host —— 它扫这个目录，每个 yaml 自动注册成一个 `WorkflowRunner`
3. admin 在控制台派任务到 workflow 的 `trigger.capability` —— 整个流程自动跑完，
   最后回一个 TaskResult

```bash
# 比如
cp templates/workflows/editorial-flow.yaml .aipehub/workflows/definitions/
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
  industry-enablement-flow.yaml    ⭐ 传统行业 AI 赋能梳理
                                   (诊断→机会→工具→落地→顾虑回应)
```

⭐ = 配套 `templates/teams/` 下同名团队使用。

## YAML 速查

```yaml
schema: aipehub.workflow/v1
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

崩了重启也能用 `jq` 翻看历史。和 AipeHub v2.0 "file-first" 路线完全一致。

## 贡献新 workflow

欢迎 PR。规范：

1. yaml 文件头部三行注释：`# Workflow:`、`# Companion team:`（如有）、`# Schema:`
2. 每个 step 加 `description:` 一句话说明，便于 admin 看 transcript 时理解
3. 触发 capability 用 `<动词>-<对象>` 形式（`run-editorial`、`orchestrate-admin-task`）

manifest 自动测试会覆盖本目录的所有 yaml —— 你只要文件能解析，CI 就过。

## License

MIT — 与项目主仓 license 一致。
