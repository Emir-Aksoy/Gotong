# 社区模板（改造自第三方 prompt 库）

> ⚠️ **这是社区 / 第三方 prompt 改造集**，跟主代码同仓只为方便早期迭代。
> 将来和 [`../`](../)（初始官方参考集）一起迁到独立仓
> **`AipeHub/aipehub-templates`**，迁仓后再放云端 raw URL 直接给用户下载。

这里收集**从主流开源 prompt 库改造而来**的 AipeHub agent / team 模板。
和 [`../agents/`](../agents/)、[`../teams/`](../teams/)（项目原创）不同：

- ✅ **来源**：每个文件头部用注释标出原始仓库 URL、原作者、许可证类型
- ✅ **许可**：只收 **CC0 / MIT / Apache-2.0** 等**明确允许商用**的，绝不收 "non-commercial only"、"research use only"、未声明许可的
- ✅ **改造**：原 prompt 大多是"对话引导型"（带 *"my first request is..."*），改造时去掉这段，让 prompt 适应 AipeHub 的 **task-payload → TaskResult** 模式
- ✅ **元数据**：每个文件都补齐 `displayName` / `capabilities` / `model` / `weightDefault`，让用户**导入就能跑**
- ✅ **聚合许可**：[`LICENSE-NOTICES.md`](./LICENSE-NOTICES.md) 列出所有来源的完整许可证条款；任何下游分发都应保留这个文件

## 来源清单

| 来源仓库 | 上游作者 | 许可 | 用了多少条 |
|---|---|---|---|
| [`f/awesome-chatgpt-prompts`](https://github.com/f/awesome-chatgpt-prompts) | Fatih Kadir Akın & contributors | **CC0 1.0**（公有领域，可商用、可改、无强制署名） | 10 |
| [`PlexPt/awesome-chatgpt-prompts-zh`](https://github.com/PlexPt/awesome-chatgpt-prompts-zh) | PlexPt & contributors | **MIT**（可商用，需保留 copyright notice） | 1 |

虽然 CC0 法律上不要求署名，但我们**仍然主动注明来源**，理由有二：

1. 尊重上游作者最初的整理劳动
2. 让你在 admin UI 编辑同名 agent 时知道"原文在哪、要不要回上游同步"

## 怎么用

跟 [`../README.md`](../README.md) 一样的流程：

1. 进到 `agents/` 或 `teams/`，挑一个 `.yaml`
2. 点 GitHub 上的 **Raw** 按钮 → 全选 + 复制
3. 回到你的 AipeHub admin → **智能体 → 导入** → 粘贴 → 确认

或者下载文件后用 **上传文件** 按钮。

## 目录

```
community/
  agents/
    linux-terminal.yaml         # Linux 终端模拟（CC0）
    javascript-console.yaml     # JavaScript 控制台模拟（CC0）
    sql-terminal.yaml           # SQL 终端模拟（CC0）
    english-improver.yaml       # 英文润色 + 自动语种检测（CC0）
    storyteller.yaml            # 故事创作（CC0）
    math-tutor.yaml             # 数学辅导（CC0）
    tech-writer.yaml            # 技术文档撰写（CC0）
    career-counselor.yaml       # 职业咨询（CC0）
    statistician.yaml           # 统计与数据解读（CC0）
    prompt-engineer.yaml        # Prompt 工程师 / 元 prompt（CC0）
    interviewer-zh.yaml         # 中文技术面试官（MIT）

  teams/
    tech-content-team.yaml      # tech-writer + english-improver + prompt-engineer 协作（改造组合，仍归 CC0）
```

## 改造原则（写新文件请参考）

| 原 prompt 风格 | 改造后 |
|---|---|
| `I want you to act as X. ... My first request is "..."` | `You are X. <清晰行为指令>` ——**去掉对话引导句**，因为 AipeHub 把 `task.payload` 直接灌到 user message |
| 暗含多轮对话（"问我问题，等我回答"） | 改成"单次回合"指令；如果需要多轮，注释里说明用 `dispatch` 多次或者让上层应用维护上下文 |
| 没指定输出格式 | 加一句"Reply with ... only" 或"Return as JSON with fields ..."，方便下游解析 |
| 没指定语言 | 显式说"Reply in <英文/中文>"，避免和 task 语言串味 |
| 模型 / weight 没建议 | 根据任务复杂度选 `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-opus-4-7`；`weightDefault` 默认 1.0，长篇产出/复杂任务给 1.5–2.0 |

## 想加新来源？

PR 前先确认：

1. **许可证清晰**：源仓 LICENSE 文件能看到 CC0 / MIT / Apache-2.0 / BSD 之一。**未声明许可的不收**（默认 *all rights reserved*）。
2. **不收明确禁止商用的**：CC-BY-NC、"non-commercial use only" 一律不收。
3. **附 LICENSE-NOTICES.md 一段**：把新来源的许可证全文（或 SPDX 标识符 + URL）补进去。
4. **头部注释完整**：`# Source: <url>`、`# License: <SPDX>`、`# Adapted: <date> — <一句话改了啥>`。

完整流程见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)，社区模板会同步迁到独立仓时一起搬。
