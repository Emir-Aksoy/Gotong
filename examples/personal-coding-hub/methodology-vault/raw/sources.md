# raw / 源材料(指针,不是内容)

> Karpathy「raw → 编译 wiki」模式里的 **raw 层**:只放**指针**(去哪看原文),
> 不照抄原文。下面的[[index|编译笔记]]是对这些材料的蒸馏 —— 思想归 Karpathy,
> 措辞是本 vault 的概括,**不构成逐字引用**(尊重版权)。

## 主要材料

- **"Software Is Changing (Again)" / Software 3.0** —— Karpathy 2025 在 Y
  Combinator AI Startup School 的讲座。提出 Software 1.0(手写代码)/ 2.0(神经网
  络权重)/ 3.0(用自然语言/prompt 编程),以及「LLM 是一种用英文编程的新计算机」。
  → 蒸馏进 [[software-3.0]]。

- **"vibe coding"(此词的出处)** —— Karpathy 2025 初在 X(@karpathy)提出:
  「完全顺着感觉走、接受所有 diff、不读代码」,适合周末/一次性项目。
  → 蒸馏进 [[vibe-coding]]。

- **把 agent「拴在 leash 上」的实践** —— Karpathy 多次谈到:真要维护的软件不能盲
  接大 diff,要小步、具体、可审、有测试;并描述自己从「大部分手写 + 自动补全」转向
  「大部分让 agent 写、人来审/掌舵」的 80/20 迁移。
  → 蒸馏进 [[agentic-engineering]]。

- **用 LLM 建/维护个人知识 wiki** —— Karpathy 在 X 上描述把一堆 `raw/` 源材料用
  LLM「编译」成结构化、互相 backlink 的 markdown wiki,用 Obsidian 当前端/IDE,让
  agent「研究自己的 wiki、跟着链接、综合出答案」再把答案归档回去。
  → 蒸馏进 [[llm-knowledge-base]]。

## 怎么扩这一层

- 把你读到的原文(讲座转录、博客、论文 PDF)放进 vault 的 `raw/` 下;
- 让 mentor/编码 agent 把它「编译」成一条**新的编译笔记**(摘要 + backlink),
  这正是 [[llm-knowledge-base]] 描述的循环;
- 编译笔记里**引用 raw 来源的路径**,保持可溯源。

> 想看准确原文,请直接去 Karpathy 的公开讲座与 X/@karpathy 帖子 —— 本 vault 只做
> 指针与蒸馏,不代替原文。
