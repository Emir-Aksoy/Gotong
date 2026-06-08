# 配对编码方法论 — Codex × DeepSeek TUI

> 一套**可载入 Obsidian vault** 的种子笔记,把「两个互补编码 agent 怎么配对、
> 怎么按情况分派」蒸馏成 codex-deepseek-hub 那个**路由/导师 agent** 的方法论
> 知识库。

## 这是什么

- **不是**框架功能,**不是**内置文件。它是一份**内容**(知识),通过模板的
  `presetData` 指针被引用 —— 模板只带「接线 + 指针」,不带知识本身
  (AipeHub Stream B 决策 #4)。
- 你把这些 `.md` 文件丢进自己的 Obsidian vault(或托管成一个快照,让
  `presetData.ref` 指过去),mentor agent 就能用 `obsidian__search` /
  `obsidian__get_file_contents` 查它。
- AipeHub **永远不读你的 vault**:查询走 `mcp-obsidian` 子进程 → Obsidian 的
  Local REST API 插件。

## 跟 personal-coding-hub 的方法论库的区别

personal-coding-hub(Claude Code + Codex)那套库讲的是**通用编程方法论**
(Karpathy 工作流:规范即程序 / vibe coding / agentic engineering)。

这套库聚焦一件这个 hub 独有的事:**两个角色不对称的 coder 怎么配对** ——
DeepSeek TUI 是**推理主理**(想清楚、定方案、审代码),Codex 是**快手实现**
(把方案落成代码)。方法论的重点不在「怎么写代码」,而在「**这一步该让谁
上、要不要两个都上、谁不在岗谁顶**」。

## agent 怎么用这个 vault(给 mentor 看的)

1. 接到一个非琐碎的编码目标时,**先 `obsidian__search`** 相关方法论(关键词:
   "配对" / "主理" / "实现" / "审查" / "安排" / "在岗")。
2. 读到的笔记**按路径引用**(例如「依据 `routing-by-situation.md`」),让人能溯源。
3. 沿 `[[wikilink]]` 跟到相关笔记,综合后再决定**派谁、派几个**。
4. 把方法论落到本 hub 的机制上 —— 见 [[pairing-with-this-hub]]。

## 目录

- [[pairing-model]] —— 配对模型:推理主理(DeepSeek TUI)× 快手实现(Codex)的分工。
- [[routing-by-situation]] —— 按情况路由:**任务分析 × 用户安排**,同一目标不同安排派得不同。
- [[pairing-with-this-hub]] —— **本 hub 的落地手册**(AGENTS.md / PROGRESS.md / 共享 cwd / 动作闸)。

## 一句话总纲

> 不是固定流水线「先想后做」。看清任务(只审查 / 琐碎小修 / 需先设计),再
> 结合用户的安排(谁在岗 / 预算几个),把**推理主理**和**快手实现**这两只手
> 合理搭配 —— 该一个人包办就别硬塞两个,该谁不在岗就让在岗的顶上。
