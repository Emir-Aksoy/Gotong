# 编程方法论知识库 — Karpathy 工作流

> 一套**可载入 Obsidian vault** 的种子笔记,把 Andrej Karpathy 公开讲座/帖子里的
> AI 时代编程方法论,蒸馏成 personal-coding-hub 那个**路由/导师 agent** 的方法论
> 知识库。它本身就是 Karpathy「raw → 编译 wiki」模式的一个实例(见
> [[llm-knowledge-base]])。

## 这是什么

- **不是**框架功能,**不是**内置文件。它是一份**内容**(知识),通过模板的
  `presetData` 指针被引用 —— 模板只带「接线 + 指针」,不带知识本身
  (Gotong Stream B 决策 #4)。
- 你把这些 `.md` 文件丢进自己的 Obsidian vault(或托管成一个快照,让
  `presetData.ref` 指过去),mentor agent 就能用 `obsidian__search` /
  `obsidian__get_file_contents` 查它。
- Gotong **永远不读你的 vault**:查询走 `mcp-obsidian` 子进程 → Obsidian 的
  Local REST API 插件。

## agent 怎么用这个 vault(给 mentor 看的)

1. 接到一个非琐碎的编码目标时,**先 `obsidian__search`** 相关方法论(关键词:
   "vibe coding" / "agentic" / "spec" / "小步" / "PROGRESS")。
2. 读到的笔记**按路径引用**(例如「依据 `agentic-engineering.md`」),让人能溯源。
3. 沿 `[[wikilink]]` 跟到相关笔记,综合后再决定**怎么拆、派给谁**。
4. 把方法论落到本 hub 的机制上 —— 见 [[coding-with-agents]]。

## 目录(两层:raw 源 + 编译笔记)

**编译笔记(蒸馏过的方法论):**

- [[software-3.0]] —— 用英文/markdown 编程;规范即程序。
- [[vibe-coding]] —— 凭感觉写;什么时候可以,什么时候别。
- [[agentic-engineering]] —— 把 agent 拴住:小步、可审、带测试。
- [[llm-knowledge-base]] —— LLM 当编译器,raw → 编译 wiki。
- [[coding-with-agents]] —— **本 hub 的落地手册**(AGENTS.md / PROGRESS.md)。

**raw 源(指针,不是内容):**

- [[raw/sources]] —— Karpathy 公开材料的指针清单。

## 一句话总纲

> 规范是程序(Software 3.0);原型可以凭感觉(vibe coding),要维护的东西就把
> agent 拴住小步走(agentic engineering);知识用 LLM 编译成可互链的 markdown
> wiki(LLM knowledge base)。本 hub 把这三件事落在 `AGENTS.md`(规范)+
> `PROGRESS.md`(交接)+ 这个 vault(方法论)上。
